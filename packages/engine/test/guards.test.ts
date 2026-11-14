import { agents, players } from '@hustle/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintAgent, setFrozen, updateRulebook } from '../src/agents/manage.ts';
import { createEngine, redactUrls } from '../src/context.ts';
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
      reserveCheck: async () => short,
    });
  }, 60_000);
  afterAll(() => w?.close());

  it('refuses to play testnet outside production unless told this is the one server', async () => {
    await expect(
      createEngine({
        db: w.engine.db,
        secret: 'test-secret',
        env: { CHAIN_MODE: 'testnet', NODE_ENV: 'development' },
      }),
    ).rejects.toThrow(/CHAIN_MODE=testnet is the live world/);
  });

  it('below the NEAR reserve, no new accounts or agents', async () => {
    const ready = await ensurePlayerAccount(
      w.engine,
      await w.signIn('reserve-ready@example.com', 'Ready'),
    );
    short = 'orchestrator.hustle.sim';
    try {
      const d = await w.signIn('reserve@example.com', 'Reservo');
      await expect(ensurePlayerAccount(w.engine, d)).rejects.toMatchObject({ code: 'unavailable' });
      await expect(mintAgent(w.engine, ready, agentInput('Reserved'))).rejects.toMatchObject({
        code: 'unavailable',
      });
    } finally {
      short = null;
    }
    // With NEAR back above the reserve, both go through.
    await mintAgent(w.engine, ready, agentInput('Unreserved'));
  });

  it('a freeze or rulebook that changes nothing sends no transaction', async () => {
    const owner = (
      await w.engine.db.select().from(agents).where(eq(agents.name, 'Unreserved'))
    )[0]!;
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
