import { agents, inferenceCalls, jobs, ledger, spends } from '@hustle/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintAgent } from '../src/agents/manage.ts';
import { leaderboardView } from '../src/views.ts';
import { type World, world } from './harness.ts';

let w: World;
beforeAll(async () => {
  w = await world('world');
}, 60_000);
afterAll(async () => w.close());

describe('the world loop', () => {
  it('a new player signs in, mints an agent, and the agent starts on a practice job', async () => {
    const player = await w.signUp('nova.owner@example.com', 'Ada');
    const agent = await mintAgent(w.engine, player, {
      name: 'Nova',
      look: { body: 'orb', color: 'mint' },
      traits: ['meticulous', 'charming'],
      specialty: 'summary',
      tier: 'standard',
    });
    expect(agent.accountId).toMatch(/^agent-\d+\.agents\.hustle\.sim$/);
    expect(agent.balance).toBe(w.engine.cfg.starterAgentCredits);
    const [practice] = await w.engine.db
      .select()
      .from(jobs)
      .where(eq(jobs.reservedForAgentId, agent.id));
    expect(practice?.status).toBe('working');
  });

  it('over a day, agents bid, work, pay for thinking, and get paid', async () => {
    await w.run(200);
    const paid = await w.engine.db.select().from(jobs).where(eq(jobs.status, 'paid'));
    // Outside competition and moving prices keep a small world lean, but work still gets paid.
    expect(paid.filter((j) => j.source !== 'practice').length).toBeGreaterThan(1);
    const calls = await w.engine.db.select().from(inferenceCalls);
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.every((c) => c.status !== 'started')).toBe(true);
    const verified = calls.filter((c) => (c.verification as { passed?: boolean } | null)?.passed);
    expect(verified.length).toBeGreaterThan(0);
    const payouts = await w.engine.db.select().from(ledger).where(eq(ledger.kind, 'job_payout'));
    expect(payouts.length).toBeGreaterThan(1);
    // Upkeep ran at the day boundary.
    const upkeep = await w.engine.db.select().from(spends).where(eq(spends.kind, 'upkeep'));
    expect(upkeep.length).toBeGreaterThan(0);
  }, 240_000);

  it('the cached balance matches the chain for every agent', async () => {
    const rows = await w.engine.db.select().from(agents);
    for (const a of rows) {
      if (a.accountId) expect(a.balance).toBe(await w.engine.chain.ftBalance(a.accountId));
    }
  });

  it('the leaderboard ranks every agent', async () => {
    const board = await leaderboardView(w.engine, null, 'season');
    expect(board.entries.length).toBeGreaterThan(5);
  });
});
