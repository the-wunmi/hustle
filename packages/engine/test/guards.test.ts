import { agents, players } from '@hustle/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintAgent, setFrozen, updateRulebook } from '../src/agents/manage.ts';
import { redactUrls } from '../src/context.ts';
import { ensurePlayerAccount } from '../src/players.ts';
import { type World, world } from './harness.ts';

const look = { body: 'orb', color: 'mint' } as const;
const agentInput = (name: string) => ({
  name,
  look,
  traits: ['charming', 'frugal'] as ('charming' | 'frugal')[],
  specialty: 'summary' as const,
  tier: 'standard' as const,
});

describe('guards on what costs the game NEAR', () => {
  let w: World;
  let short: string | null = null;
  beforeAll(async () => {
    w = await world('guards', {
      dailyCaps: { accounts: 2, mints: 2 },
      reserveCheck: async () => short,
    });
  }, 60_000);
  afterAll(() => w?.close());

  it('new accounts and agent mints stop at the day’s cap, with a plain message', async () => {
    const a = await w.signIn('cap-a@example.com', 'Capa');
    const b = await w.signIn('cap-b@example.com', 'Capb');
    const c = await w.signIn('cap-c@example.com', 'Capc');
    const readyA = await ensurePlayerAccount(w.engine, a);
    await ensurePlayerAccount(w.engine, b);
    await expect(ensurePlayerAccount(w.engine, c)).rejects.toMatchObject({
      code: 'rate_limited',
      message: 'The game is full for today; try again tomorrow.',
    });
    // A ready account takes no slot.
    await ensurePlayerAccount(w.engine, readyA);
    await mintAgent(w.engine, readyA, agentInput('Capone'));
    await mintAgent(w.engine, readyA, agentInput('Captwo'));
    await expect(mintAgent(w.engine, readyA, agentInput('Capthree'))).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('below the NEAR reserve, no new accounts or agents', async () => {
    short = 'orchestrator.hustle.sim';
    try {
      const d = await w.signIn('reserve@example.com', 'Reservo');
      await expect(ensurePlayerAccount(w.engine, d)).rejects.toMatchObject({ code: 'unavailable' });
    } finally {
      short = null;
    }
  });

  it('a freeze or rulebook that changes nothing sends no transaction', async () => {
    const owner = (await w.engine.db.select().from(agents).where(eq(agents.name, 'Capone')))[0]!;
    const [player] = await w.engine.db.select().from(players).where(eq(players.id, owner.ownerId));
    let sent = 0;
    const chain = w.engine.chain as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of ['setFrozen', 'setRulebook']) {
      const real = chain[m]!.bind(w.engine.chain);
      chain[m] = (...a: unknown[]) => {
        sent++;
        return real(...a);
      };
    }
    const frozen = await setFrozen(w.engine, player!, owner, { frozen: true });
    expect(sent).toBe(1);
    await setFrozen(w.engine, player!, frozen, { frozen: true });
    expect(sent).toBe(1);
    const rulebook = {
      dailyCap: '1200000',
      maxPerJob: '400000',
      maxPerCall: '250000',
      allowedVendors: [],
      anyVendor: false,
      mayHire: true,
      helperBudget: '100000',
    };
    const changed = await updateRulebook(w.engine, player!, frozen, rulebook as never);
    const after = sent;
    await updateRulebook(w.engine, player!, changed, rulebook as never);
    expect(sent).toBe(after);
  });

  it('log lines never carry a URL’s query string', () => {
    expect(redactUrls('{"error":"fetch https://rpc.example/v1?apiKey=SECRET failed"}')).toBe(
      '{"error":"fetch https://rpc.example/v1?[redacted] failed"}',
    );
  });
});
