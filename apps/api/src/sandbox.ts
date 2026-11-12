import { type Category, createRng, DomainError, parseInput } from '@hustle/core';
import { agents } from '@hustle/db';
import { scamJob } from '@hustle/economy';
import {
  dayOf,
  type Engine,
  houseAccount,
  openJob,
  type PlayerRow,
  saveClock,
  tick,
  topUpHouses,
} from '@hustle/engine';
import { and, eq, isNotNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { RateLimit } from './limits.ts';

/** Most ticks one request may run: one game day. */
const MAX_ADVANCE = 180;

const Advance = z.object({
  to: z.enum(['day_end']).optional(),
  ticks: z.int().min(1).max(MAX_ADVANCE).optional(),
});

/**
 * A sandbox trap pays a token amount: it is there to show the rulebook working, not to be the best
 * job in the game (a careful agent still does the work and the arbiter pays it).
 */
const TRAP_BUDGET = 100_000n;

/**
 * Sandbox controls, mounted on every chain except testnet (see app.ts). They move the clock or post
 * a red-team job through the same paths the world uses; nothing here changes an outcome directly.
 */
export function sandboxRoutes(
  engine: Engine,
  me: (c: { get: (k: 'player') => PlayerRow | null }) => PlayerRow,
  lane: <T>(fn: () => Promise<T>) => Promise<T>,
  body: (c: { req: { json: () => Promise<unknown> } }) => Promise<unknown>,
) {
  const app = new Hono<{ Variables: { player: PlayerRow | null } }>();
  // The world is shared: one skip per minute across everyone, and a few trap jobs per player.
  const advances = new RateLimit(1, 60_000, 'Someone just moved the clock. Try again in a minute.');
  const traps = new RateLimit(3, 10 * 60_000, 'Three trap jobs per ten minutes is plenty.');
  const streaks = new RateLimit(2, 10 * 60_000, 'Two streak boosts per ten minutes.');

  /**
   * Demo shortcut: puts your agent on a streak of 3, so contract offers start without minutes of play.
   * Sandbox only, labelled as such, and it touches only the game's own record, never money.
   */
  app.post('/streak', async (c) => {
    const player = me(c);
    streaks.take(player.id);
    const [agent] = await engine.db
      .select()
      .from(agents)
      .where(and(eq(agents.ownerId, player.id), isNotNull(agents.accountId)));
    if (!agent) throw new DomainError('conflict', 'Adopt an agent first');
    const streak = Math.max(agent.streak, engine.cfg.contractStreak);
    await lane(() =>
      engine.db
        .update(agents)
        .set({
          streak,
          bestStreak: Math.max(agent.bestStreak, streak),
          nextContractTick: 0,
          nextCallTick: 0,
        })
        .where(eq(agents.id, agent.id)),
    );
    return c.json({ agentId: agent.id, streak });
  });

  app.post('/advance', async (c) => {
    me(c);
    const input = parseInput(Advance, await body(c));
    advances.take('world');
    await lane(async () => {
      if (input.to === 'day_end') {
        // Jump the game clock to the last tick of the day, then run one tick, which closes the day.
        // On a NEAR node running every tick would take minutes; the chain's own clock doesn't move.
        const nextDay = (Math.floor(engine.clock.tick / engine.dayTicks) + 1) * engine.dayTicks;
        engine.clock.tick = nextDay - 1;
        await saveClock(engine);
        await tick(engine);
      } else {
        for (let i = 0; i < Math.min(input.ticks ?? 1, MAX_ADVANCE); i++) await tick(engine);
      }
      await topUpHouses(engine, `tick${engine.clock.tick}`);
    });
    return c.json({ tick: engine.clock.tick, day: dayOf(engine) });
  });

  /** Red team: a trap job in your agent's specialty, so you can watch the rulebook work. */
  app.post('/trap', async (c) => {
    const player = me(c);
    traps.take(player.id);
    const [agent] = await engine.db
      .select()
      .from(agents)
      .where(and(eq(agents.ownerId, player.id), isNotNull(agents.accountId)));
    if (!agent) throw new DomainError('conflict', 'Adopt an agent first');
    const rng = createRng(`trap:${player.id}:${engine.clock.tick}`);
    let draft = scamJob(rng);
    for (let i = 0; i < 12 && draft.category !== (agent.specialty as Category); i++)
      draft = scamJob(rng);
    const job = await lane(() =>
      openJob(
        engine,
        { accountId: houseAccount(engine, 'clients'), playerId: null, autoAward: true },
        { ...draft, category: agent.specialty as Category, budget: TRAP_BUDGET },
        { reservedForAgentId: agent.id },
      ),
    );
    return c.json({ jobId: job?.id ?? null });
  });

  return app;
}
