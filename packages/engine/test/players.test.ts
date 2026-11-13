import { agents, players } from '@hustle/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anyAgent, mintAgent, ownedAgent, topUp, updateRulebook } from '../src/agents/manage.ts';
import {
  claimAllowance,
  ensurePlayerAccount,
  nameFromEmail,
  passkeyLogin,
  playerForSession,
  startEmailLogin,
  verifyEmailLogin,
} from '../src/players.ts';
import { meView } from '../src/views.ts';
import { type World, world } from './harness.ts';

let w: World;
beforeAll(async () => {
  w = await world('players');
}, 60_000);
afterAll(async () => w.close());

const look = { body: 'bolt', color: 'tomato' } as const;

describe('sign-in and ownership', () => {
  it('signing in costs nothing on chain; the first on-chain action makes the account, once', async () => {
    const a = await w.signIn('same@example.com', 'Ada');
    const b = await w.signIn('same@example.com', 'Ada again');
    expect(b.id).toBe(a.id);
    expect(a.accountId).toMatch(/^p-[0-9a-f]{12}\.hustle\.sim$/);
    expect(a.accountReady).toBe(false);
    // No account yet, but the wallet shows the starter credits it will open with.
    expect(await w.engine.chain.ftBalance(a.accountId)).toBe(0n);
    expect((await meView(w.engine, a)).player.wallet).toBe(
      w.engine.cfg.starterWalletCredits.toString(),
    );
    // Claiming the daily credits is an on-chain action: the account and starter credits come first.
    await claimAllowance(w.engine, a);
    const ready = (await w.engine.db.select().from(players).where(eq(players.id, a.id)))[0];
    expect(ready?.accountReady).toBe(true);
    expect(await w.engine.chain.ftBalance(a.accountId)).toBe(
      w.engine.cfg.starterWalletCredits + w.engine.cfg.dailyAllowance,
    );
    // Racing or repeated calls make nothing twice.
    await Promise.all([ensurePlayerAccount(w.engine, a), ensurePlayerAccount(w.engine, a)]);
    expect(await w.engine.chain.ftBalance(a.accountId)).toBe(
      w.engine.cfg.starterWalletCredits + w.engine.cfg.dailyAllowance,
    );
  });

  it('an email with dots or plus signs signs in without a name typed', async () => {
    const { challengeId, simulatedInbox } = await startEmailLogin(w.engine, {
      email: 'ada.lovelace+test@example.com',
    });
    const { player } = await verifyEmailLogin(w.engine, { challengeId, code: simulatedInbox.code });
    expect(player.name).toBe('ada lovelace test');
    expect(nameFromEmail('a.@example.com')).toBe('Player');
  });

  it('display names are unique, so a newcomer never looks like a rival’s manager', async () => {
    const first = await w.signUp('twin-a@example.com', 'Twin');
    const second = await w.signUp('twin-b@example.com', 'twin');
    expect(first.name).toBe('Twin');
    expect(second.name).toBe('twin 2');
  });

  it('a wrong code is refused and a code burns after five wrong tries', async () => {
    const { challengeId, simulatedInbox } = await startEmailLogin(w.engine, {
      email: 'guess@example.com',
    });
    const wrong = simulatedInbox.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await expect(verifyEmailLogin(w.engine, { challengeId, code: wrong })).rejects.toMatchObject({
        code: 'invalid',
      });
    }
    await expect(
      verifyEmailLogin(w.engine, { challengeId, code: simulatedInbox.code }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('one email cannot request unlimited codes', async () => {
    for (let i = 0; i < 5; i++) await startEmailLogin(w.engine, { email: 'flood@example.com' });
    await expect(startEmailLogin(w.engine, { email: 'flood@example.com' })).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('a passkey sign-in gives a session that resolves to the player', async () => {
    const { player, sessionToken } = await passkeyLogin(w.engine, { name: 'Kemi' });
    expect((await playerForSession(w.engine, sessionToken))?.id).toBe(player.id);
    expect(await playerForSession(w.engine, 'not-a-token')).toBeNull();
  });

  it('someone else’s agent reads as not found for owner actions', async () => {
    const alice = await w.signUp('alice@example.com', 'Alice');
    const mallory = await w.signUp('mallory@example.com', 'Mallory');
    const agent = await mintAgent(w.engine, alice, {
      name: 'Nova',
      look,
      traits: ['bold', 'frugal'],
      specialty: 'research',
      tier: 'budget',
    });
    await expect(ownedAgent(w.engine, mallory, agent.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await anyAgent(w.engine, agent.id)).id).toBe(agent.id);
    // Even calling the service directly with the agent, the chain refuses a non-owner's rulebook.
    await expect(
      updateRulebook(w.engine, mallory, agent, {
        dailyCap: '5000000',
        maxPerJob: '5000000',
        maxPerCall: '5000000',
        allowedVendors: [],
        anyVendor: true,
        mayHire: true,
        helperBudget: '1',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a player may run at most three agents and must name them sensibly', async () => {
    const p = await w.signUp('busy@example.com', 'Busy');
    for (const name of ['One', 'Two', 'Three']) {
      await mintAgent(w.engine, p, {
        name,
        look,
        traits: ['bold', 'frugal'],
        specialty: 'summary',
        tier: 'budget',
      });
    }
    await expect(
      mintAgent(w.engine, p, {
        name: 'Four',
        look,
        traits: ['bold', 'frugal'],
        specialty: 'summary',
        tier: 'budget',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const q = await w.signUp('names@example.com', 'Names');
    await expect(
      mintAgent(w.engine, q, {
        name: '<script>',
        look,
        traits: ['bold', 'frugal'],
        specialty: 'summary',
        tier: 'budget',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      mintAgent(w.engine, q, {
        name: 'Twin',
        look,
        traits: ['bold', 'bold'],
        specialty: 'summary',
        tier: 'budget',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('an agent name is used once, whatever its case', async () => {
    const p = await w.signUp('copycat@example.com', 'Copycat');
    await expect(
      mintAgent(w.engine, p, {
        name: 'PIXEL',
        look,
        traits: ['bold', 'frugal'],
        specialty: 'summary',
        tier: 'budget',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('the daily allowance can be claimed once per game day', async () => {
    const p = await w.signUp('allowance@example.com', 'Felix');
    await claimAllowance(w.engine, p);
    const [fresh] = await w.engine.db
      .select()
      .from((await import('@hustle/db')).players)
      .where(eq((await import('@hustle/db')).players.id, p.id));
    await expect(claimAllowance(w.engine, fresh!)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a top-up larger than the wallet is refused and moves nothing', async () => {
    const p = await w.signUp('poor@example.com', 'Poor');
    const agent = await mintAgent(w.engine, p, {
      name: 'Kipling',
      look,
      traits: ['bold', 'frugal'],
      specialty: 'summary',
      tier: 'budget',
    });
    const before = await w.engine.chain.ftBalance(agent.accountId!);
    await expect(topUp(w.engine, p, agent, { amount: '9000000' })).rejects.toMatchObject({
      code: 'insufficient_funds',
    });
    const [row] = await w.engine.db.select().from(agents).where(eq(agents.id, agent.id));
    expect(await w.engine.chain.ftBalance(agent.accountId!)).toBe(before);
    expect(row?.balance).toBe(before);
  });
});
