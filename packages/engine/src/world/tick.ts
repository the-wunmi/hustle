import type { RpcStats } from '@hustle/chain';
import { reflectOnJobs } from '../agents/memory.ts';
import { refreshAllBalances } from '../agents/state.ts';
import { expireCalls, raiseCalls } from '../calls.ts';
import { dayOf, type Engine, saveClock } from '../context.ts';
import { refreshToolsOpen } from '../tools/index.ts';
import { houseTrading } from '../trade.ts';
import { endDay } from './day.ts';
import { activeAgents, closeAuctions, placeBids, spawnJobs, tickRng } from './market.ts';
import { advanceWork } from './work.ts';

/** Ticks between rivals' turns on the marketplace: half a game day. */
const TRADING_EVERY_TICKS = (engine: Engine) => Math.max(1, Math.floor(engine.dayTicks / 2));

/**
 * One world tick as phases, in order: advance the clock and close finished days, spawn jobs, close
 * auctions, move every job in progress one stage on, let idle agents bid and raise calls to watching
 * owners, then rival trading and the balance refresh. Each phase is one turn in the serial lane, so
 * a player's action waits at most for the phase in progress, not the whole tick (on testnet a tick
 * can take seconds). Every phase reads fresh state from the database and the chain, so a player
 * action landing between two phases is seen by the next, and the next tick picks a job up where the
 * last left it. One-off operations inside it (escrow, day close) are DBOS workflows.
 */
export function tickPhases(engine: Engine): (() => Promise<void>)[] {
  let active: Awaited<ReturnType<typeof activeAgents>> = [];
  return [
    async () => {
      engine.clock.tick += 1;
      await saveClock(engine);
      await refreshToolsOpen(engine);
      // Close every finished day, oldest first. Each day's close is a workflow keyed by the day, so
      // one cut short by a crash resumes where it stopped, and asking again for a closed day is a no-op.
      const lastFinished = dayOf(engine) - 1;
      // Clocks saved before closedDay existed treat every past day as closed.
      engine.clock.closedDay ??= lastFinished;
      while (engine.clock.closedDay < lastFinished) {
        await endDay(engine, engine.clock.closedDay + 1);
        engine.clock.closedDay += 1;
        await saveClock(engine);
      }
    },
    async () => {
      active = await activeAgents(engine);
      await spawnJobs(engine, active);
    },
    () => closeAuctions(engine, active.length),
    () => advanceWork(engine),
    // Players' agents write a lesson from each job that settled.
    () =>
      reflectOnJobs(engine).catch((err) => engine.log('reflection failed', { error: String(err) })),
    async () => {
      // Unanswered calls take their default before agents bid, so a lapsed pitch lets the agent bid.
      await expireCalls(engine);
      active = await activeAgents(engine);
      await placeBids(engine, active);
      await raiseCalls(engine, active);
    },
    async () => {
      // Rivals trade on the marketplace twice a game day, so it has life.
      if (engine.clock.tick % TRADING_EVERY_TICKS(engine) === 0) {
        await houseTrading(engine, tickRng(engine, 'trading')).catch((err) =>
          engine.log('house trading failed', { error: String(err) }),
        );
      }
      // Payments run side by side within a tick, so the balance cache is re-read from the chain
      // once everything has settled (every few ticks where reads are rationed, as on testnet).
      if (engine.clock.tick % engine.balanceRefreshTicks === 0) await refreshAllBalances(engine);
      engine.bus.emit('tick', engine.clock.tick);
    },
  ];
}

/** One whole tick, phases back to back (tests and the sandbox controls). */
export async function tick(engine: Engine): Promise<void> {
  for (const phase of tickPhases(engine)) await phase();
}

/**
 * Runs ticks on a timer until stopped. Each phase takes its own turn in the lane; a failed phase
 * ends that tick early (the next tick starts from the database). A slow tick delays the next; ticks
 * never overlap. Where the gateway counts its RPC traffic, each tick logs it.
 */
export function startWorld(engine: Engine): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const stats = () => (engine.chain as { rpcStats?: () => RpcStats }).rpcStats?.();
  const loop = async () => {
    while (!stopped) {
      const started = Date.now();
      const before = stats();
      running = (async () => {
        for (const phase of tickPhases(engine)) await engine.lane.run(phase);
      })().catch((err) => engine.log('tick failed', { error: String(err) }));
      await running;
      const after = stats();
      if (before && after)
        engine.log('tick', {
          tick: engine.clock.tick,
          ms: Date.now() - started,
          rpc: after.requests - before.requests,
          rateLimited: after.rateLimited - before.rateLimited,
          failovers: after.failovers - before.failovers,
          ...(engine.clock.tick % 12 === 0 ? { totals: after.byMethod } : {}),
        });
      const wait = Math.max(50, engine.tickMs - (Date.now() - started));
      await new Promise((r) => setTimeout(r, wait));
      // How long a tick really takes, start to start (on testnet often well over tickMs), so the
      // game can say how long a day lasts in real time.
      engine.tickPaceMs = Math.round(engine.tickPaceMs * 0.9 + (Date.now() - started) * 0.1);
    }
  };
  void loop();
  return async () => {
    stopped = true;
    await running;
  };
}
