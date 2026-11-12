import type { Rulebook } from '@hustle/core';
import type { SpendRequest } from './types.ts';

/** The contracts' JSON for a rulebook: snake_case fields, amounts as U128 strings. */
export interface StoredRulebook {
  daily_cap: string;
  max_per_job: string;
  max_per_call: string;
  allowed_vendors: string[];
  any_vendor: boolean;
  may_hire: boolean;
  helper_budget: string;
}

/** The agent wallet's JSON for a spend request. */
export interface StoredRequest {
  key: string;
  kind: SpendRequest['kind'];
  receiver_id: string;
  amount: string;
  job_id: string | null;
  memo: string;
  receipt: string | null;
}

export const toStoredRulebook = (r: Rulebook): StoredRulebook => ({
  daily_cap: r.dailyCap.toString(),
  max_per_job: r.maxPerJob.toString(),
  max_per_call: r.maxPerCall.toString(),
  allowed_vendors: r.allowedVendors,
  any_vendor: r.anyVendor,
  may_hire: r.mayHire,
  helper_budget: r.helperBudget.toString(),
});

export const fromStoredRulebook = (r: StoredRulebook): Rulebook => ({
  dailyCap: BigInt(r.daily_cap),
  maxPerJob: BigInt(r.max_per_job),
  maxPerCall: BigInt(r.max_per_call),
  allowedVendors: r.allowed_vendors,
  anyVendor: r.any_vendor,
  mayHire: r.may_hire,
  helperBudget: BigInt(r.helper_budget),
});

export const toStoredRequest = (r: SpendRequest): StoredRequest => ({
  key: r.key,
  kind: r.kind,
  receiver_id: r.receiverId,
  amount: r.amount.toString(),
  job_id: r.jobId,
  memo: r.memo,
  receipt: r.receipt,
});

export const fromStoredRequest = (r: StoredRequest): SpendRequest => ({
  key: r.key,
  kind: r.kind,
  receiverId: r.receiver_id,
  amount: BigInt(r.amount),
  jobId: r.job_id,
  memo: r.memo,
  receipt: r.receipt,
});

/** The registry's charge for one NEP-178 approval: the account id plus 12 bytes, at 1e19 yocto each. */
export function approvalDeposit(accountId: string): bigint {
  return BigInt(Buffer.byteLength(accountId) + 12) * 10n ** 19n;
}

/** What a logged buy came to: `sold` to this buyer means bought; anything else was refunded. */
export function buyResult(
  events: { event: string; data: unknown }[],
  buyer: string,
  tokenId: string,
): 'bought' | 'refunded' {
  const sold = events.some((e) => {
    const d = e.data as { buyer_id?: string; token_id?: string } | null;
    return e.event === 'sold' && d?.buyer_id === buyer && d.token_id === tokenId;
  });
  return sold ? 'bought' : 'refunded';
}
