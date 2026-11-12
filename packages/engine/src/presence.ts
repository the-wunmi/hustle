import type { Engine } from './context.ts';

/** A player counts as watching for this many ticks (about 30 seconds by default) after their last look. */
export const PRESENT_TICKS = 15;

/** Records that a player is looking (their calls poll), at the current game tick. */
export function markPresent(engine: Engine, playerId: string): void {
  engine.presence.set(playerId, engine.clock.tick);
}

/**
 * Whether a player is watching. A watching owner's agent leaves its bidding to the owner's calls;
 * an absent owner's agent plays on its own.
 */
export function isPresent(engine: Engine, playerId: string): boolean {
  const seen = engine.presence.get(playerId);
  return seen !== undefined && engine.clock.tick - seen <= PRESENT_TICKS;
}
