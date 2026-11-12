import { DomainError } from '@hustle/core';
import type { ChainIds } from './types.ts';

/** One function call inside a player's delegate action (NEP-366). */
export interface DelegateCall {
  receiverId: string;
  methodName: string;
  /** Attached deposit in yoctoNEAR. */
  deposit: bigint;
  gas: bigint;
}

/** Most gas a sponsored call may use: generous for our methods, small enough to cap our bill. */
export const MAX_SPONSORED_GAS = 100_000_000_000_000n;
/** Owner actions carry exactly 1 yoctoNEAR as proof of a full signature; we never sponsor more. */
const MAX_SPONSORED_DEPOSIT = 1n;

/**
 * What our relayer pays gas for. The docs say to gate on `receiverId` and to inspect each function
 * call's method, gas and deposit; anything else is refused, so the relayer can't be used as a
 * general gas faucet.
 */
export function sponsoredMethods(ids: ChainIds): Record<string, readonly string[]> {
  return {
    [ids.credits]: ['ft_transfer', 'ft_transfer_call'],
    [ids.registry]: [
      'nft_transfer',
      'set_rulebook',
      'approve_spend',
      'deny_spend',
      'withdraw',
      'set_frozen',
      // Listing (`nft_approve`) carries a storage deposit, so the player pays for it themselves.
      'nft_revoke',
      'nft_revoke_all',
    ],
    [ids.jobs]: ['award', 'accept', 'dispute', 'cancel', 'reclaim_undelivered'],
    [ids.market]: ['cancel_listing'],
  };
}

export function checkSponsored(ids: ChainIds, call: DelegateCall): void {
  const allowed = sponsoredMethods(ids)[call.receiverId];
  if (!allowed) throw new DomainError('forbidden', 'The relayer only sponsors calls to Hustle');
  if (!allowed.includes(call.methodName)) {
    throw new DomainError('forbidden', `The relayer does not sponsor ${call.methodName}`);
  }
  if (call.deposit > MAX_SPONSORED_DEPOSIT) {
    throw new DomainError('forbidden', 'The relayer does not sponsor deposits');
  }
  if (call.gas > MAX_SPONSORED_GAS) throw new DomainError('forbidden', 'Too much gas requested');
}
