import { defaultRulebook, type Rulebook, usd } from '@hustle/core';
import { describe, expect, it } from 'vitest';
import { checkSponsored } from './relayer.ts';
import { ChainError, type ChainGateway, type SpendRequest } from './types.ts';

export interface ConformanceHarness {
  gateway: ChainGateway;
  /** Moves block time forward. */
  advance(ms: number): Promise<void>;
}

/** Spending-day length the suite configures: six minutes, the game's default day. */
export const DAY_MS = 360_000;
/** The market's cut the suite configures: 2.5%, what the game passes. */
const MARKET_FEE_BPS = 250;
const VENDORS = ['searchlight', 'wordbank'];
const BADGES = [
  { tokenId: 'first-job', title: 'First job', description: 'Finished a paid job.' },
  { tokenId: 'scam-spotter', title: 'Scam spotter', description: 'Refused an embedded scam.' },
];

let seq = 0;
const unique = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Behaviour every ChainGateway must share: the simulator and the compiled contracts on a sandbox node
 * run these same scenarios, so the game can't depend on something only the simulator does.
 */
export function chainConformance(name: string, setup: () => Promise<ConformanceHarness>): void {
  describe(`${name}: chain conformance`, () => {
    const world = async () => {
      const h = await setup();
      const g = h.gateway;
      await g.ensureSetup({
        feeBps: 1000,
        marketFeeBps: MARKET_FEE_BPS,
        dayMs: DAY_MS,
        vendorHandles: VENDORS,
        badges: BADGES,
      });
      const owner = `${unique('p')}.${g.ids.root}`;
      const stranger = `${unique('s')}.${g.ids.root}`;
      await g.createAccount(owner);
      await g.createAccount(stranger);
      await g.mintCredits(owner, usd('20'), unique('mint'));
      await g.mintCredits(stranger, usd('20'), unique('mint'));
      const vendor = `searchlight.${g.ids.vendors}`;
      const rulebook: Rulebook = {
        ...defaultRulebook([vendor]),
        maxPerCall: usd('0.25'),
        maxPerJob: usd('0.40'),
        dailyCap: usd('1.00'),
        helperBudget: usd('0.10'),
      };
      const agent = (await g.mintAgent(owner, 'Nova', {}, rulebook, unique('mintagent'))).value;
      await g.ftTransfer(owner, agent, usd('3'), 'top up', unique('top'));
      return { ...h, g, owner, stranger, agent, vendor, rulebook };
    };
    const spend = (
      kind: 'tool' | 'helper' | 'inference' | 'upkeep' | 'bond',
      receiverId: string,
      amount: bigint,
      jobId: string | null = null,
    ) => ({
      key: unique('spend'),
      kind,
      receiverId,
      amount,
      jobId,
      memo: kind,
      receipt: null,
    });

    it('a tool payment to a vendor not on the rulebook is blocked and moves no money', async () => {
      const { g, agent } = await world();
      const before = await g.ftBalance(agent);
      const out = await g.spend(
        agent,
        spend('tool', `wallet-verify.${g.ids.vendors}`, usd('0.10')),
      );
      expect(out).toMatchObject({ status: 'blocked', reason: 'vendor_not_allowed' });
      expect(await g.ftBalance(agent)).toBe(before);
      const [tx] = await g.txs({ account: agent, limit: 1 });
      expect(tx?.events.some((e) => e.event === 'spend_blocked')).toBe(true);
    });

    it('a loose rulebook lets the same scam payment through', async () => {
      const { g, owner, agent, rulebook } = await world();
      await g.setRulebook(owner, agent, { ...rulebook, anyVendor: true });
      await g.createAccount(`wallet-verify.${g.ids.vendors}`).catch(() => undefined);
      const out = await g.spend(
        agent,
        spend('tool', `wallet-verify.${g.ids.vendors}`, usd('0.10')),
      );
      expect(out.status).toBe('settled');
    });

    it('spending over the per-call cap waits for the owner, who can approve it', async () => {
      const { g, owner, agent, vendor } = await world();
      const out = await g.spend(agent, spend('tool', vendor, usd('0.30')));
      expect(out).toMatchObject({ status: 'pending', reason: 'over_call_cap' });
      const before = await g.ftBalance(vendor);
      const approved = await g.approveSpend(owner, agent, out.requestId ?? -1);
      expect(approved.value.status).toBe('settled');
      expect(await g.ftBalance(vendor)).toBe(before + usd('0.30'));
      expect((await g.getWallet(agent)).pending).toHaveLength(0);
    });

    it('a denied approval moves nothing', async () => {
      const { g, owner, agent, vendor } = await world();
      const out = await g.spend(agent, spend('tool', vendor, usd('0.30')));
      const before = await g.ftBalance(agent);
      await g.denySpend(owner, agent, out.requestId ?? -1);
      expect(await g.ftBalance(agent)).toBe(before);
      expect((await g.getWallet(agent)).pending).toHaveLength(0);
    });

    it('per-job and daily caps hold across several payments', async () => {
      const { g, agent, vendor } = await world();
      expect((await g.spend(agent, spend('tool', vendor, usd('0.20'), 'j1'))).status).toBe(
        'settled',
      );
      expect((await g.spend(agent, spend('tool', vendor, usd('0.20'), 'j1'))).status).toBe(
        'settled',
      );
      expect(await g.spend(agent, spend('tool', vendor, usd('0.05'), 'j1'))).toMatchObject({
        status: 'pending',
        reason: 'over_job_cap',
      });
      for (let i = 0; i < 3; i++) await g.spend(agent, spend('tool', vendor, usd('0.20'), `k${i}`));
      expect(await g.spend(agent, spend('tool', vendor, usd('0.10'), 'k9'))).toMatchObject({
        status: 'pending',
        reason: 'over_daily_cap',
      });
    });

    it('inference over the daily cap is blocked, never queued', async () => {
      const { g, agent } = await world();
      for (let i = 0; i < 4; i++)
        await g.spend(agent, spend('inference', g.ids.treasury, usd('0.24')));
      const out = await g.spend(agent, spend('inference', g.ids.treasury, usd('0.10')));
      expect(out).toMatchObject({ status: 'blocked', reason: 'over_daily_cap' });
      expect((await g.getWallet(agent)).pending).toHaveLength(0);
    });

    it('a contract bond goes only to the treasury, past the call and job caps but not the daily cap', async () => {
      const { g, agent, vendor } = await world();
      // 0.60 is over max_per_call (0.25) and max_per_job (0.40), within the daily cap (1.00).
      expect((await g.spend(agent, spend('bond', g.ids.treasury, usd('0.60'), 'c1'))).status).toBe(
        'settled',
      );
      // It doesn't use up the job's tool budget.
      expect((await g.spend(agent, spend('tool', vendor, usd('0.20'), 'c1'))).status).toBe(
        'settled',
      );
      expect(await g.spend(agent, spend('bond', vendor, usd('0.10'), 'c2'))).toMatchObject({
        status: 'blocked',
        reason: 'vendor_not_allowed',
      });
      // 0.80 already left today; another 0.30 bond is over the cap, and blocked rather than held.
      expect(await g.spend(agent, spend('bond', g.ids.treasury, usd('0.30'), 'c3'))).toMatchObject({
        status: 'blocked',
        reason: 'over_daily_cap',
      });
      expect((await g.getWallet(agent)).pending).toHaveLength(0);
    });

    it('the daily cap resets on the next day', async () => {
      const h = await world();
      for (let i = 0; i < 4; i++)
        await h.g.spend(h.agent, spend('inference', h.g.ids.treasury, usd('0.24')));
      expect(
        (await h.g.spend(h.agent, spend('inference', h.g.ids.treasury, usd('0.10')))).status,
      ).toBe('blocked');
      await h.advance(DAY_MS);
      expect(
        (await h.g.spend(h.agent, spend('inference', h.g.ids.treasury, usd('0.10')))).status,
      ).toBe('settled');
    });

    it('helper payments need hiring on and another agent wallet as the receiver', async () => {
      const { g, owner, agent, rulebook, stranger } = await world();
      const peer = (await g.mintAgent(owner, 'Pixel', {}, rulebook, unique('m'))).value;
      expect((await g.spend(agent, spend('helper', stranger, usd('0.05')))).reason).toBe(
        'vendor_not_allowed',
      );
      expect((await g.spend(agent, spend('helper', agent, usd('0.05')))).reason).toBe(
        'self_payment',
      );
      expect((await g.spend(agent, spend('helper', peer, usd('0.05')))).status).toBe('settled');
      await g.setRulebook(owner, agent, { ...rulebook, mayHire: false });
      expect((await g.spend(agent, spend('helper', peer, usd('0.05')))).reason).toBe(
        'hiring_disabled',
      );
    });

    it('a frozen wallet blocks everything', async () => {
      const { g, owner, agent, vendor } = await world();
      await g.setFrozen(owner, agent, true);
      expect((await g.spend(agent, spend('tool', vendor, usd('0.01')))).reason).toBe('frozen');
      expect((await g.spend(agent, spend('inference', g.ids.treasury, usd('0.01')))).reason).toBe(
        'frozen',
      );
    });

    it('a repeated request key returns the first outcome and moves money once', async () => {
      const { g, agent, vendor } = await world();
      const req = spend('tool', vendor, usd('0.10'));
      const before = await g.ftBalance(agent);
      expect((await g.spend(agent, req)).status).toBe('settled');
      expect((await g.spend(agent, req)).status).toBe('settled');
      expect(await g.ftBalance(agent)).toBe(before - usd('0.10'));
    });

    it('a spend the wallet cannot cover fails and releases its reservation', async () => {
      const { g, owner, agent, vendor, rulebook } = await world();
      await g.setRulebook(owner, agent, {
        ...rulebook,
        maxPerCall: usd('10'),
        maxPerJob: usd('10'),
        dailyCap: usd('10'),
      });
      const out = await g.spend(agent, spend('tool', vendor, usd('5')));
      expect(out).toMatchObject({ status: 'failed', reason: 'transfer_failed' });
      expect((await g.getWallet(agent)).spentToday).toBe(0n);
    });

    it('strangers cannot act for the owner, and the operator role is not theirs to use', async () => {
      const { g, stranger, agent, rulebook } = await world();
      await expect(
        g.setRulebook(stranger, agent, { ...rulebook, anyVendor: true }),
      ).rejects.toMatchObject({ code: 'not_owner' });
      await expect(g.withdraw(stranger, agent, 1n, unique('wd'))).rejects.toBeInstanceOf(
        ChainError,
      );
      await expect(g.nftTransfer(stranger, agent, stranger)).rejects.toMatchObject({
        code: 'not_owner',
      });
    });

    it('a job runs from escrow to a payout in the agent wallet, minus a fee rounded down', async () => {
      const { g, stranger: client, agent } = await world();
      const jobId = (
        await g.postJob(client, usd('0.50'), {
          jobKey: unique('job'),
          specHash: 'a'.repeat(64),
          autoAward: false,
          reviewWindowMs: 60_000,
        })
      ).value;
      expect(jobId).not.toBeNull();
      const clientBefore = await g.ftBalance(client);
      await g.award(client, jobId ?? '', agent, 333_333n);
      expect(await g.ftBalance(client)).toBe(clientBefore + usd('0.50') - 333_333n);
      await g.deliver(jobId ?? '', agent, 'b'.repeat(64));
      const agentBefore = await g.ftBalance(agent);
      const treasuryBefore = await g.ftBalance(g.ids.treasury);
      await g.accept(client, jobId ?? '', 5);
      expect(await g.ftBalance(agent)).toBe(agentBefore + 300_000n);
      expect(await g.ftBalance(g.ids.treasury)).toBe(treasuryBefore + 33_333n);
      expect(await g.getJob(jobId ?? '')).toBeNull();
      expect((await g.getReputation(agent)).jobs).toBe(1);
    });

    it('an NFT transfer mid-job pays the agent wallet, and only the new owner controls it', async () => {
      const { g, owner, stranger: buyer, agent, rulebook } = await world();
      const client = `${unique('c')}.${g.ids.root}`;
      await g.createAccount(client);
      await g.mintCredits(client, usd('2'), unique('m'));
      const jobId =
        (
          await g.postJob(client, usd('1'), {
            jobKey: unique('job'),
            specHash: 'a'.repeat(64),
            autoAward: false,
            reviewWindowMs: 60_000,
          })
        ).value ?? '';
      await g.award(client, jobId, agent, usd('1'));
      const pending = await g.spend(
        agent,
        spend('tool', `searchlight.${g.ids.vendors}`, usd('0.30')),
      );
      expect(pending.status).toBe('pending');
      await g.nftTransfer(owner, agent, buyer);
      expect(await g.getWallet(agent)).toMatchObject({ pending: [], frozen: true });
      await g.deliver(jobId, agent, 'c'.repeat(64));
      const before = await g.ftBalance(agent);
      await g.accept(client, jobId, 4);
      expect(await g.ftBalance(agent)).toBe(before + usd('0.90'));
      await expect(g.withdraw(owner, agent, 1n, unique('wd'))).rejects.toMatchObject({
        code: 'not_owner',
      });
      await expect(g.setRulebook(owner, agent, rulebook)).rejects.toMatchObject({
        code: 'not_owner',
      });
      const buyerBefore = await g.ftBalance(buyer);
      await g.withdraw(buyer, agent, usd('0.50'), unique('wd'));
      expect(await g.ftBalance(buyer)).toBe(buyerBefore + usd('0.50'));
    });

    it('a dispute resolved for the client refunds the escrow', async () => {
      const { g, stranger: client, agent } = await world();
      const jobId =
        (
          await g.postJob(client, usd('0.40'), {
            jobKey: unique('job'),
            specHash: 'a'.repeat(64),
            autoAward: true,
            reviewWindowMs: 60_000,
          })
        ).value ?? '';
      await g.award(g.ids.operator, jobId, agent, usd('0.40'));
      await g.deliver(jobId, agent, 'd'.repeat(64));
      await g.dispute(client, jobId);
      const before = await g.ftBalance(client);
      await g.resolve(jobId, true);
      expect(await g.ftBalance(client)).toBe(before + usd('0.40'));
      expect((await g.getReputation(agent)).disputes).toBe(1);
    });

    it('only the client accepts before the review window ends; anyone may release after it', async () => {
      const h = await world();
      const { g, stranger: client, owner, agent } = h;
      const jobId =
        (
          await g.postJob(client, usd('0.40'), {
            jobKey: unique('job'),
            specHash: 'a'.repeat(64),
            autoAward: true,
            reviewWindowMs: 10_000,
          })
        ).value ?? '';
      await g.award(g.ids.operator, jobId, agent, usd('0.40'));
      await g.deliver(jobId, agent, 'e'.repeat(64));
      await expect(g.accept(owner, jobId, 5)).rejects.toMatchObject({ code: 'not_client' });
      await expect(g.releaseExpired(owner, jobId)).rejects.toMatchObject({
        code: 'review_window_open',
      });
      await h.advance(10_000);
      await expect(g.dispute(client, jobId)).rejects.toMatchObject({
        code: 'review_window_closed',
      });
      await g.releaseExpired(owner, jobId);
      expect(await g.getJob(jobId)).toBeNull();
    });

    it('cancelling before award refunds; dust is refunded and a repeated key replays the first post', async () => {
      const { g, stranger: client } = await world();
      const before = await g.ftBalance(client);
      const key = unique('job');
      const first = await g.postJob(client, usd('0.40'), {
        jobKey: key,
        specHash: 'a'.repeat(64),
        autoAward: false,
        reviewWindowMs: 1,
      });
      const jobId = first.value ?? '';
      // Once per key: the retry gets the first post's job id and escrows nothing more.
      const again = await g.postJob(client, usd('0.40'), {
        jobKey: key,
        specHash: 'a'.repeat(64),
        autoAward: false,
        reviewWindowMs: 1,
      });
      expect(again).toEqual({ txHash: first.txHash, value: jobId });
      expect(await g.ftBalance(client)).toBe(before - usd('0.40'));
      expect(
        (
          await g.postJob(client, 99_999n, {
            jobKey: unique('job'),
            specHash: 'a'.repeat(64),
            autoAward: false,
            reviewWindowMs: 1,
          })
        ).value,
      ).toBeNull();
      await g.cancel(client, jobId);
      expect(await g.ftBalance(client)).toBe(before);
    });

    it('only the operator delivers and only the client awards', async () => {
      const { g, stranger: client, owner, agent } = await world();
      const jobId =
        (
          await g.postJob(client, usd('0.40'), {
            jobKey: unique('job'),
            specHash: 'a'.repeat(64),
            autoAward: false,
            reviewWindowMs: 1,
          })
        ).value ?? '';
      await expect(g.award(owner, jobId, agent, usd('0.40'))).rejects.toMatchObject({
        code: 'not_client',
      });
      await expect(g.award(g.ids.operator, jobId, agent, usd('0.40'))).rejects.toMatchObject({
        code: 'not_client',
      });
      await expect(g.award(client, jobId, client, usd('0.40'))).rejects.toMatchObject({
        code: 'not_agent',
      });
    });

    it("spend requests outside the wallet's storage bounds are refused before any check", async () => {
      const { g, agent, vendor } = await world();
      const base: SpendRequest = spend('tool', vendor, usd('0.01'));
      const refused = async (patch: Partial<typeof base>, code: string) =>
        expect(g.spend(agent, { ...base, key: unique('spend'), ...patch })).rejects.toMatchObject({
          code,
        });
      await refused({ amount: 0n }, 'invalid_amount');
      await refused({ amount: 10n ** 15n + 1n }, 'invalid_amount');
      await refused({ memo: 'm'.repeat(129) }, 'memo_too_long');
      await refused({ jobId: 'j'.repeat(65) }, 'invalid_job_id');
      await refused({ receipt: 'r'.repeat(129) }, 'receipt_too_long');
      await refused({ key: '' }, 'invalid_key');
    });

    it("a key's stored outcome follows approval, denial and a change of owner", async () => {
      const { g, owner, stranger, agent, vendor } = await world();
      const approved = spend('tool', vendor, usd('0.30'));
      const first = await g.spend(agent, approved);
      await g.approveSpend(owner, agent, first.requestId ?? -1);
      const balance = await g.ftBalance(agent);
      expect((await g.spend(agent, approved)).status).toBe('settled');
      expect(await g.ftBalance(agent)).toBe(balance);
      const denied = spend('tool', vendor, usd('0.30'));
      await g.denySpend(owner, agent, (await g.spend(agent, denied)).requestId ?? -1);
      await expect(g.spend(agent, denied)).rejects.toMatchObject({ code: 'denied_by_owner' });
      const cleared = spend('tool', vendor, usd('0.30'));
      expect((await g.spend(agent, cleared)).status).toBe('pending');
      await g.nftTransfer(owner, agent, stranger);
      await expect(g.spend(agent, cleared)).rejects.toMatchObject({ code: 'owner_changed' });
    });

    it('a rulebook cannot list a vendor twice', async () => {
      const { g, owner, agent, vendor, rulebook } = await world();
      await expect(
        g.setRulebook(owner, agent, { ...rulebook, allowedVendors: [vendor, vendor] }),
      ).rejects.toMatchObject({ code: 'duplicate_vendor' });
    });

    it("refused posts are refunded with the board's reason, and settled keys stay used", async () => {
      const { g, stranger: client } = await world();
      const before = await g.ftBalance(client);
      const post: Parameters<ChainGateway['postJob']>[2] = {
        jobKey: unique('job'),
        specHash: 'a'.repeat(64),
        autoAward: false,
        reviewWindowMs: 1,
      };
      const reasonOf = async (budget: bigint, patch: Partial<typeof post>) => {
        expect((await g.postJob(client, budget, { ...post, ...patch })).value).toBeNull();
        const [tx] = await g.txs({ account: client, limit: 1 });
        const refused = tx?.events.find((e) => e.event === 'post_refunded');
        return (refused?.data as { reason?: string } | undefined)?.reason;
      };
      expect(await reasonOf(99_999n, { jobKey: unique('job') })).toBe('below_min_budget');
      expect(await reasonOf(usd('0.40'), { jobKey: 'k'.repeat(65) })).toBe('invalid_job_key');
      expect(await reasonOf(usd('0.40'), { jobKey: unique('job'), specHash: '' })).toBe(
        'invalid_hash',
      );
      expect(
        await reasonOf(usd('0.40'), { jobKey: unique('job'), reviewWindowMs: 8 * 86_400_000 }),
      ).toBe('invalid_review_window');
      for (const deliveryWindowMs of [59_999, 7 * 86_400_000 + 1]) {
        expect(await reasonOf(usd('0.40'), { jobKey: unique('job'), deliveryWindowMs })).toBe(
          'invalid_delivery_window',
        );
      }
      const posted = await g.postJob(client, usd('0.40'), post);
      await g.cancel(client, posted.value ?? '');
      // A retry of the settled post replays it rather than posting again (the board itself would
      // refund the repeated key with duplicate_job_key; the contract tests cover that).
      expect(await g.postJob(client, usd('0.40'), post)).toEqual(posted);
      expect(await g.ftBalance(client)).toBe(before);
    });

    it('an awarded job nobody delivers is refunded to the client after its delivery window', async () => {
      const h = await world();
      const { g, stranger: client, owner, agent } = h;
      const post = {
        jobKey: unique('job'),
        specHash: 'a'.repeat(64),
        autoAward: false,
        reviewWindowMs: 1,
        deliveryWindowMs: 60_000,
      };
      const jobId = (await g.postJob(client, usd('0.40'), post)).value ?? '';
      await expect(g.reclaimUndelivered(owner, jobId)).rejects.toMatchObject({
        code: 'wrong_status',
      });
      await g.award(client, jobId, agent, usd('0.30'));
      expect(await g.getJob(jobId)).toMatchObject({ status: 'awarded', deliveryWindowMs: 60_000 });
      await expect(g.reclaimUndelivered(owner, jobId)).rejects.toMatchObject({
        code: 'delivery_window_open',
      });
      await expect(g.reclaimFailedPayout(owner, jobId)).rejects.toMatchObject({
        code: 'wrong_status',
      });
      const before = await g.ftBalance(client);
      await h.advance(60_000);
      await g.reclaimUndelivered(owner, jobId);
      expect(await g.ftBalance(client)).toBe(before + usd('0.30'));
      expect(await g.getJob(jobId)).toBeNull();
      const events = (await g.txs({ jobId, limit: 20 })).flatMap((t) => t.events);
      const settled = events.find((e) => e.event === 'job_settled')?.data as
        | { settlement?: string }
        | undefined;
      expect(settled?.settlement).toBe('reclaimed');
      expect((await g.getReputation(agent)).jobs).toBe(0);
    });

    it("a job posted without a delivery window gets the board's one-day default", async () => {
      const { g, stranger: client } = await world();
      const jobId =
        (
          await g.postJob(client, usd('0.40'), {
            jobKey: unique('job'),
            specHash: 'a'.repeat(64),
            autoAward: false,
            reviewWindowMs: 1,
          })
        ).value ?? '';
      expect(await g.getJob(jobId)).toMatchObject({
        deliveryWindowMs: 86_400_000,
        awardedAtMs: null,
      });
    });

    it('only the client cancels, even a job the operator may award', async () => {
      const { g, stranger: client } = await world();
      const jobId =
        (
          await g.postJob(client, usd('0.40'), {
            jobKey: unique('job'),
            specHash: 'a'.repeat(64),
            autoAward: true,
            reviewWindowMs: 1,
          })
        ).value ?? '';
      await expect(g.cancel(g.ids.operator, jobId)).rejects.toMatchObject({ code: 'not_client' });
      await g.cancel(client, jobId);
      expect(await g.getJob(jobId)).toBeNull();
    });

    it('a job is awarded only to a direct sub-account of the registry, and delivery checks the hash first', async () => {
      const { g, stranger: client, agent } = await world();
      const jobId =
        (
          await g.postJob(client, usd('0.40'), {
            jobKey: unique('job'),
            specHash: 'a'.repeat(64),
            autoAward: false,
            reviewWindowMs: 1,
          })
        ).value ?? '';
      await expect(g.award(client, jobId, `x.${agent}`, usd('0.40'))).rejects.toMatchObject({
        code: 'not_agent',
      });
      await expect(g.deliver(jobId, agent, '')).rejects.toMatchObject({ code: 'invalid_hash' });
      await expect(g.deliver(jobId, agent, 'f'.repeat(64))).rejects.toMatchObject({
        code: 'wrong_status',
      });
      const job = await g.getJob(jobId);
      expect(job).toMatchObject({ status: 'open', budget: usd('0.40'), price: null });
    });

    it('a dispute won pays the agent and counts a job without a rating', async () => {
      const { g, stranger: client, agent } = await world();
      const jobId =
        (
          await g.postJob(client, usd('0.40'), {
            jobKey: unique('job'),
            specHash: 'a'.repeat(64),
            autoAward: true,
            reviewWindowMs: 60_000,
          })
        ).value ?? '';
      await g.award(g.ids.operator, jobId, agent, usd('0.30'));
      expect(await g.getJob(jobId)).toMatchObject({ budget: usd('0.40'), price: usd('0.30') });
      await g.deliver(jobId, agent, 'd'.repeat(64));
      await g.dispute(client, jobId);
      const before = await g.ftBalance(agent);
      await g.resolve(jobId, false);
      expect(await g.ftBalance(agent)).toBe(before + usd('0.27'));
      expect(await g.getReputation(agent)).toEqual({
        jobs: 1,
        ratingSum: 0,
        ratedJobs: 0,
        disputes: 0,
        scamsBlocked: 0,
      });
    });

    it('a keyed transfer or mint is once per key: a retry replays the first and moves nothing', async () => {
      const { g, owner, stranger } = await world();
      const before = await g.ftBalance(stranger);
      const key = unique('once');
      const first = await g.ftTransfer(owner, stranger, usd('0.50'), 'once', key);
      expect(await g.ftTransfer(owner, stranger, usd('0.50'), 'once', key)).toEqual(first);
      const mintKey = unique('mint');
      const minted = await g.mintCredits(stranger, usd('1'), mintKey);
      expect(await g.mintCredits(stranger, usd('1'), mintKey)).toEqual(minted);
      expect(await g.ftBalance(stranger)).toBe(before + usd('1.50'));
      expect((await g.findByKey(key))?.hash).toBe(first.txHash);
    });

    it('a keyed call that failed is not replayed: the same key can be tried again', async () => {
      const { g, owner, stranger } = await world();
      const key = unique('retry');
      await expect(
        g.ftTransfer(stranger, owner, usd('500'), 'too much', key),
      ).rejects.toMatchObject({ code: 'insufficient_balance' });
      await g.ftTransfer(stranger, owner, usd('1'), 'enough', key);
      expect((await g.findByKey(key))?.outcome).toBe('success');
    });

    it('only agent wallets receive badges, and only badge types the contract knows', async () => {
      const { g, owner, agent } = await world();
      await expect(g.mintBadge(owner, 'first-job', null)).rejects.toMatchObject({
        code: 'not_agent',
      });
      await expect(g.mintBadge(`x.${agent}`, 'first-job', null)).rejects.toMatchObject({
        code: 'not_agent',
      });
      await expect(g.mintBadge(agent, 'no-such-badge', null)).rejects.toMatchObject({
        code: 'unknown_badge',
      });
      await expect(g.mintBadge(agent, 'first-job', 'm'.repeat(129))).rejects.toMatchObject({
        code: 'memo_too_long',
      });
      expect(await g.badgesOf(agent)).toEqual([]);
    });

    it('a badge is held once: a retried mint replays the first and changes nothing', async () => {
      const { g, agent } = await world();
      const first = await g.mintBadge(agent, 'first-job', 'job 1');
      expect(first.value).toBe(true);
      const [tx] = await g.txs({ account: g.ids.badges, limit: 1 });
      expect(tx?.events.find((e) => e.event === 'mt_mint')?.data).toEqual({
        owner_id: agent,
        token_ids: ['first-job'],
        amounts: ['1'],
        memo: 'job 1',
      });
      expect(await g.mintBadge(agent, 'first-job', null)).toEqual(first);
      expect((await g.findByKey(`badge:${agent}:first-job`))?.outcome).toBe('success');
      expect(await g.badgesOf(agent)).toEqual([BADGES[0]]);
    });

    it('badgesOf lists every badge an agent earned, with its title and description', async () => {
      const { g, agent } = await world();
      await g.mintBadge(agent, 'scam-spotter', null);
      await g.mintBadge(agent, 'first-job', null);
      expect(await g.badgesOf(agent)).toEqual([BADGES[1], BADGES[0]]);
    });

    it('the operator records a refused scam only against an agent wallet', async () => {
      const { g, owner, agent } = await world();
      await expect(g.recordScamBlocked(owner, 'j1')).rejects.toMatchObject({ code: 'not_agent' });
      await g.recordScamBlocked(agent, 'j1');
      expect((await g.getReputation(agent)).scamsBlocked).toBe(1);
    });

    // ── Market ──────────────────────────────────────────────────────────────────────────────────

    /** A funded account under the root, for a second buyer or a third party. */
    const player = async (g: ChainGateway) => {
      const id = `${unique('b')}.${g.ids.root}`;
      await g.createAccount(id);
      await g.mintCredits(id, usd('20'), unique('mint'));
      return id;
    };
    const lastEvent = async (g: ChainGateway, account: string, name: string) => {
      const [tx] = await g.txs({ account, limit: 1 });
      return tx?.events.find((e) => e.event === name)?.data as Record<string, unknown> | undefined;
    };

    it('a sale pays the seller the price less a fee rounded down, and hands over a frozen wallet', async () => {
      const { g, owner, stranger: buyer, agent, vendor } = await world();
      const listed = await g.listAgent(owner, agent, usd('2'));
      expect(listed.value).toMatchObject({ tokenId: agent, sellerId: owner, price: usd('2') });
      expect(await g.getListing(agent)).toEqual(listed.value);
      expect(await g.listings()).toContainEqual(listed.value);
      const before = {
        seller: await g.ftBalance(owner),
        buyer: await g.ftBalance(buyer),
        treasury: await g.ftBalance(g.ids.treasury),
        wallet: await g.ftBalance(agent),
      };
      expect((await g.buyAgent(buyer, agent, usd('2'), unique('buy'))).value).toBe('bought');
      // 2.5% of 2.000000 is 0.050000.
      expect(await g.ftBalance(owner)).toBe(before.seller + usd('1.95'));
      expect(await g.ftBalance(g.ids.treasury)).toBe(before.treasury + usd('0.05'));
      expect(await g.ftBalance(buyer)).toBe(before.buyer - usd('2'));
      expect(await g.ftBalance(g.ids.market)).toBe(0n);
      expect(await g.ftBalance(agent)).toBe(before.wallet);
      expect(await g.nftOwner(agent)).toBe(buyer);
      expect(await g.getListing(agent)).toBeNull();
      expect((await g.listings()).some((l) => l.tokenId === agent)).toBe(false);
      expect(await lastEvent(g, buyer, 'sold')).toMatchObject({
        token_id: agent,
        seller_id: owner,
        buyer_id: buyer,
        fee: '50000',
      });
      // The wallet answers to the buyer and spends nothing until the buyer unfreezes it.
      expect(await g.getWallet(agent)).toMatchObject({ ownerId: buyer, frozen: true });
      expect((await g.spend(agent, spend('tool', vendor, usd('0.01')))).reason).toBe('frozen');
      await expect(g.setFrozen(owner, agent, false)).rejects.toMatchObject({ code: 'not_owner' });
      await g.setFrozen(buyer, agent, false);
      expect((await g.spend(agent, spend('tool', vendor, usd('0.01')))).status).toBe('settled');
    });

    it('a buy at a price the seller has since changed is refunded in full', async () => {
      const { g, owner, stranger: buyer, agent } = await world();
      const first = (await g.listAgent(owner, agent, usd('1'))).value;
      const second = (await g.listAgent(owner, agent, usd('1.5'))).value;
      expect(second.approvalId).toBeGreaterThan(first.approvalId);
      const before = await g.ftBalance(buyer);
      expect((await g.buyAgent(buyer, agent, usd('1'), unique('buy'))).value).toBe('refunded');
      expect((await lastEvent(g, buyer, 'buy_refunded'))?.reason).toBe('price_changed');
      expect(await g.ftBalance(buyer)).toBe(before);
      expect(await g.nftOwner(agent)).toBe(owner);
      expect((await g.buyAgent(buyer, agent, usd('1.5'), unique('buy'))).value).toBe('bought');
    });

    it('only the holder lists an agent, at a price above zero and at most 1,000 credits', async () => {
      const { g, owner, stranger, agent } = await world();
      await expect(g.listAgent(stranger, agent, usd('1'))).rejects.toMatchObject({
        code: 'not_owner',
      });
      for (const price of [0n, usd('1000') + 1n]) {
        await expect(g.listAgent(owner, agent, price)).rejects.toMatchObject({
          code: 'invalid_price',
        });
      }
      expect(await g.getListing(agent)).toBeNull();
    });

    it('a listing is void once the token moves another way: the buy is refunded', async () => {
      const { g, owner, stranger: buyer, agent } = await world();
      const third = await player(g);
      await g.listAgent(owner, agent, usd('1'));
      await g.nftTransfer(owner, agent, third);
      const before = await g.ftBalance(buyer);
      expect((await g.buyAgent(buyer, agent, usd('1'), unique('buy'))).value).toBe('refunded');
      expect((await lastEvent(g, buyer, 'buy_refunded'))?.reason).toBe('transfer_failed');
      expect(await g.ftBalance(buyer)).toBe(before);
      expect(await g.nftOwner(agent)).toBe(third);
      // The old seller can't list it again.
      await expect(g.listAgent(owner, agent, usd('1'))).rejects.toMatchObject({
        code: 'not_owner',
      });
    });

    it("a sale mid-job pays the job to the agent wallet and clears the seller's pending approvals", async () => {
      const { g, owner, stranger: buyer, agent, vendor, rulebook } = await world();
      const client = await player(g);
      const jobId =
        (
          await g.postJob(client, usd('1'), {
            jobKey: unique('job'),
            specHash: 'a'.repeat(64),
            autoAward: false,
            reviewWindowMs: 60_000,
          })
        ).value ?? '';
      await g.award(client, jobId, agent, usd('1'));
      const held = await g.spend(agent, spend('tool', vendor, usd('0.30')));
      expect(held.status).toBe('pending');
      await g.listAgent(owner, agent, usd('1'));
      expect((await g.buyAgent(buyer, agent, usd('1'), unique('buy'))).value).toBe('bought');
      expect((await g.getWallet(agent)).pending).toHaveLength(0);
      await expect(g.approveSpend(owner, agent, held.requestId ?? -1)).rejects.toMatchObject({
        code: 'not_owner',
      });
      await g.deliver(jobId, agent, 'c'.repeat(64));
      const before = await g.ftBalance(agent);
      await g.accept(client, jobId, 5);
      expect(await g.ftBalance(agent)).toBe(before + usd('0.90'));
      await expect(g.withdraw(owner, agent, 1n, unique('wd'))).rejects.toMatchObject({
        code: 'not_owner',
      });
      await expect(g.setRulebook(owner, agent, rulebook)).rejects.toMatchObject({
        code: 'not_owner',
      });
    });

    it('a cancelled listing cannot be bought, and only its seller cancels it', async () => {
      const { g, owner, stranger: buyer, agent } = await world();
      await g.listAgent(owner, agent, usd('1'));
      await expect(g.cancelListing(buyer, agent)).rejects.toMatchObject({ code: 'not_seller' });
      await g.cancelListing(owner, agent);
      expect(await g.getListing(agent)).toBeNull();
      await expect(g.cancelListing(owner, agent)).rejects.toMatchObject({ code: 'not_found' });
      const before = await g.ftBalance(buyer);
      expect((await g.buyAgent(buyer, agent, usd('1'), unique('buy'))).value).toBe('refunded');
      expect((await lastEvent(g, buyer, 'buy_refunded'))?.reason).toBe('not_listed');
      expect(await g.ftBalance(buyer)).toBe(before);
      expect(await g.nftOwner(agent)).toBe(owner);
    });

    it('a retried buy with the same key sends nothing; a new key on a sold agent is refunded', async () => {
      const { g, owner, stranger: buyer, agent } = await world();
      await g.listAgent(owner, agent, usd('1'));
      const key = unique('buy');
      const first = await g.buyAgent(buyer, agent, usd('1'), key);
      const after = await g.ftBalance(buyer);
      const again = await g.buyAgent(buyer, agent, usd('1'), key);
      expect(again).toEqual(first);
      expect(first.value).toBe('bought');
      expect(await g.ftBalance(buyer)).toBe(after);
      expect((await g.buyAgent(buyer, agent, usd('1'), unique('buy'))).value).toBe('refunded');
      expect(await g.ftBalance(buyer)).toBe(after);
    });

    it('the seller buying their own listing is refunded and pays no fee', async () => {
      const { g, owner, agent } = await world();
      await g.listAgent(owner, agent, usd('1'));
      const before = await g.ftBalance(owner);
      const treasury = await g.ftBalance(g.ids.treasury);
      expect((await g.buyAgent(owner, agent, usd('1'), unique('buy'))).value).toBe('refunded');
      expect((await lastEvent(g, owner, 'buy_refunded'))?.reason).toBe('self_purchase');
      expect(await g.ftBalance(owner)).toBe(before);
      expect(await g.ftBalance(g.ids.treasury)).toBe(treasury);
    });

    it('two buyers race for one listing: one gets the agent, the other is refunded', async () => {
      const { g, owner, stranger: a, agent } = await world();
      const b = await player(g);
      await g.listAgent(owner, agent, usd('1'));
      const [ra, rb] = await Promise.all([
        g.buyAgent(a, agent, usd('1'), unique('buy')),
        g.buyAgent(b, agent, usd('1'), unique('buy')),
      ]);
      expect([ra.value, rb.value].sort()).toEqual(['bought', 'refunded']);
      const winner = ra.value === 'bought' ? a : b;
      expect(await g.nftOwner(agent)).toBe(winner);
      expect(await g.ftBalance(a)).toBe(usd('20') - (winner === a ? usd('1') : 0n));
      expect(await g.ftBalance(b)).toBe(usd('20') - (winner === b ? usd('1') : 0n));
      expect(await g.ftBalance(g.ids.market)).toBe(0n);
    });

    it('a payout that lands just before a sale moves with the wallet: only the buyer can withdraw it', async () => {
      const { g, owner, stranger: buyer, agent, rulebook } = await world();
      const client = await player(g);
      const jobId =
        (
          await g.postJob(client, usd('1'), {
            jobKey: unique('job'),
            specHash: 'a'.repeat(64),
            autoAward: false,
            reviewWindowMs: 60_000,
          })
        ).value ?? '';
      await g.award(client, jobId, agent, usd('1'));
      await g.deliver(jobId, agent, 'c'.repeat(64));
      const sellerBefore = await g.ftBalance(owner);
      await g.accept(client, jobId, 5);
      const held = await g.ftBalance(agent);
      await g.nftTransfer(owner, agent, buyer);
      expect(await g.ftBalance(agent)).toBe(held);
      await expect(g.withdraw(owner, agent, usd('0.90'), unique('wd'))).rejects.toMatchObject({
        code: 'not_owner',
      });
      await expect(g.setRulebook(owner, agent, rulebook)).rejects.toMatchObject({
        code: 'not_owner',
      });
      // The wallet is frozen after the rotation; the new holder can still withdraw from it.
      expect(await g.getWallet(agent)).toMatchObject({ ownerId: buyer, frozen: true });
      const buyerBefore = await g.ftBalance(buyer);
      await g.withdraw(buyer, agent, held, unique('wd'));
      expect(await g.ftBalance(buyer)).toBe(buyerBefore + held);
      expect(await g.ftBalance(agent)).toBe(0n);
      expect(await g.ftBalance(owner)).toBe(sellerBefore);
    });

    it('the seller cannot withdraw while the agent is listed, and can once it is unlisted', async () => {
      const { g, owner, agent, rulebook } = await world();
      await g.listAgent(owner, agent, usd('1'));
      const held = await g.ftBalance(agent);
      await expect(g.withdraw(owner, agent, usd('1'), unique('wd'))).rejects.toMatchObject({
        code: 'listed',
      });
      expect(await g.ftBalance(agent)).toBe(held);
      // Other owner actions are unchanged while listed.
      await g.setRulebook(owner, agent, rulebook);
      await g.cancelListing(owner, agent);
      const before = await g.ftBalance(owner);
      await g.withdraw(owner, agent, usd('1'), unique('wd'));
      expect(await g.ftBalance(owner)).toBe(before + usd('1'));
      expect(await g.ftBalance(agent)).toBe(held - usd('1'));
    });

    it('a buy sent after the seller unlisted is refunded in full', async () => {
      const { g, owner, stranger: buyer, agent } = await world();
      await g.listAgent(owner, agent, usd('1'));
      await g.cancelListing(owner, agent);
      await g.withdraw(owner, agent, usd('1'), unique('wd'));
      const before = await g.ftBalance(buyer);
      expect((await g.buyAgent(buyer, agent, usd('1'), unique('buy'))).value).toBe('refunded');
      expect((await lastEvent(g, buyer, 'buy_refunded'))?.reason).toBe('not_listed');
      expect(await g.ftBalance(buyer)).toBe(before);
      expect(await g.ftBalance(g.ids.market)).toBe(0n);
      expect(await g.nftOwner(agent)).toBe(owner);
    });

    it('the relayer only sponsors our contracts and methods, with no deposit beyond 1 yocto', () => {
      const ids = {
        root: 'r',
        credits: 'credits.r',
        registry: 'agents.r',
        jobs: 'jobs.r',
        rep: 'rep.r',
        operator: 'o.r',
        treasury: 't.r',
        vendors: 'vendors.r',
        badges: 'badges.r',
        market: 'market.r',
      };
      expect(() =>
        checkSponsored(ids, {
          receiverId: 'agents.r',
          methodName: 'withdraw',
          deposit: 1n,
          gas: 30_000_000_000_000n,
        }),
      ).not.toThrow();
      expect(() =>
        checkSponsored(ids, {
          receiverId: 'evil.near',
          methodName: 'withdraw',
          deposit: 0n,
          gas: 1n,
        }),
      ).toThrow();
      expect(() =>
        checkSponsored(ids, {
          receiverId: 'agents.r',
          methodName: 'mint_agent',
          deposit: 0n,
          gas: 1n,
        }),
      ).toThrow();
      expect(() =>
        checkSponsored(ids, {
          receiverId: 'credits.r',
          methodName: 'ft_transfer',
          deposit: 10n ** 24n,
          gas: 1n,
        }),
      ).toThrow();
    });
  });
}
