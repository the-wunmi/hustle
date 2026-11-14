import { DomainError } from '@hustle/core';
import type { Engine } from './context.ts';

let reserveLogged = false;

/**
 * Refuses actions that spend the game's NEAR (a new account, a mint) once the root or operator is
 * down to its reserve, so the world can keep running on what's left. Logged once per process.
 */
export async function assertNearReserve(engine: Engine): Promise<void> {
  const short = await engine.reserveCheck();
  if (!short) return;
  if (!reserveLogged) {
    reserveLogged = true;
    engine.log('NEAR reserve reached: refusing new accounts and agents', { short });
  }
  throw new DomainError(
    'unavailable',
    'The game is low on NEAR for new accounts and agents right now; try again later.',
  );
}
