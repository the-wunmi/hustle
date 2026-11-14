import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ChainTxView, Rulebook, SpendReason } from '@hustle/core';
import {
  Account,
  type Action,
  actions,
  baseEncode,
  KeyPair,
  KeyPairSigner,
  type KeyPairString,
  type PublicKey,
  SignedTransaction,
} from 'near-api-js';
import { PacedRpcProvider, type RpcStats } from './rpc.ts';
import { SignerQueue } from './signer-queue.ts';
import {
  type BadgeType,
  ChainError,
  type ChainGateway,
  type ChainIds,
  type ChainJob,
  type ChainSetup,
  type Listing,
  type PendingTx,
  type Reputation,
  type SettledTx,
  type SpendOutcome,
  type SpendRequest,
  type TxFilter,
  type TxLog,
  type TxResult,
  type WalletState,
} from './types.ts';
import {
  approvalDeposit,
  buyResult,
  fromStoredRequest,
  fromStoredRulebook,
  type StoredRequest,
  type StoredRulebook,
  toStoredRequest,
  toStoredRulebook,
} from './wire.ts';

const TGAS = 1_000_000_000_000n;
/** A call that stays inside one contract. */
const GAS_LOCAL = 30n * TGAS;
/** A call that starts a transfer or another contract's method and waits for its callback. */
const GAS_CROSS = 150n * TGAS;
/** The protocol's per-transaction ceiling: minting deploys a wallet and runs two callbacks. */
const GAS_MAX = 300n * TGAS;

const ONE_YOCTO = 1n;
const NEAR = 10n ** 24n;
/** NEP-145 registration on the credits token (same figure as the registry's); excess is refunded. */
const CREDITS_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;

/** Gas a transaction that only creates, funds or keys an account may burn (it uses well under 1). */
const GAS_ACCOUNT = 5n * TGAS;
/** NEAR's storage price, 1e19 yocto per byte (10 KB per 0.1 NEAR), fixed by the protocol. */
const STORAGE_PRICE_PER_BYTE = 10n ** 19n;
/** An account's code hash while it holds no contract. */
const EMPTY_CODE_HASH = '11111111111111111111111111111111';

/** Where the gateway runs: a local sandbox node, or NEAR testnet (mainnet is refused, see testnet.ts). */
export type NearNetwork = 'sandbox' | 'testnet';

interface Funding {
  /** What the funder gives a root it creates (sandbox; on testnet the root is the funder). */
  root: bigint;
  /** The least a contract account gets, whatever its code size. */
  contractMin: bigint;
  /** NEAR a contract account gets on top of its code's storage, for the state play adds. */
  contractState: bigint;
  /** The operator pays every agent's mint deposit (about 2 NEAR each, less with global wallet code) and most of the gas. */
  operator: bigint;
  /** Players and house accounts: their own gas and account storage when created. */
  account: bigint;
  /** A player account holding less than this (or one call's gas, if more) is refilled by the root before it signs. */
  accountLow: bigint;
  /** A refill raises a player to this much above that floor. */
  accountRefill: bigint;
  /** The game's own signers (clients, sponsors, house players) are kept at least this… */
  houseLow: bigint;
  /** …by topping them up to this, with no daily cap. */
  houseTarget: bigint;
  /**
   * The operator (it signs upkeep, mints and other game calls) is topped up to `operatorTarget`
   * from the root whenever it holds less than this. Above the mint reserve, so mints keep working.
   */
  operatorLow: bigint;
  operatorTarget: bigint;
  /** Accounts that only receive (the treasury, vendors): storage for the account and its key. */
  payee: bigint;
  /** A parent such as `vendors.<root>` is refilled when it holds less than a child's funding plus this. */
  parentHeadroom: bigint;
  /** What a refill adds on top of the child's funding. */
  parentRefill: bigint;
}

/**
 * NEAR each account starts with. On a sandbox NEAR costs nothing, so the amounts are generous. On
 * testnet the root pays from a faucet-funded account: contracts get their code's storage plus
 * 0.5 NEAR (finished jobs are deleted, so job-board state stays small); the operator gets enough
 * for the ten rival agents the game mints on first boot (about 2 NEAR each without global wallet
 * code) plus gas; players and
 * house accounts get 0.05 NEAR (storage, and room for the prepaid gas of one call) and are refilled as
 * they spend it; accounts that only receive get 0.05 NEAR, their storage with room to spare.
 */
const FUNDING: Record<NearNetwork, Funding> = {
  sandbox: {
    root: 100_000n * NEAR,
    contractMin: 50n * NEAR,
    contractState: 0n,
    operator: 5_000n * NEAR,
    account: 10n * NEAR,
    accountLow: 0n,
    accountRefill: 0n,
    // The game's own signers spend gas all day: a local world left running for days used to drain
    // `clients` and stall every job post. The root has plenty here, so they're kept topped up.
    houseLow: 2n * NEAR,
    houseTarget: 10n * NEAR,
    operatorLow: 100n * NEAR,
    operatorTarget: 1_000n * NEAR,
    payee: 10n * NEAR,
    parentHeadroom: NEAR,
    parentRefill: 10n * NEAR,
  },
  testnet: {
    root: 0n,
    contractMin: 0n,
    contractState: NEAR / 2n,
    operator: 25n * NEAR,
    // Measured: an account with one key stores 182 bytes (0.00182 NEAR); a player's whole testnet
    // session of listing, buying and confirming burned 0.0005–0.0022 NEAR of gas (2026-11-12). But a
    // transaction is only accepted if the signer can cover its prepaid gas: 300 Tgas is about
    // 0.031 NEAR, refunded unused (measured on the sandbox, 2026-11-13). So 0.05 NEAR, refilled with
    // 0.03 whenever it drops under 0.04.
    account: NEAR / 20n,
    accountLow: NEAR / 25n,
    accountRefill: (3n * NEAR) / 100n,
    // A job post from `clients` needs ~0.15 NEAR of headroom until its prepaid gas comes back.
    houseLow: (3n * NEAR) / 10n,
    houseTarget: (6n * NEAR) / 10n,
    // Two days of a live world spent the operator's first 25 NEAR and stalled every upkeep call
    // (2026-11-14); the mint reserve is 2 NEAR (NEAR_RESERVE_OPERATOR).
    operatorLow: 3n * NEAR,
    operatorTarget: 8n * NEAR,
    payee: NEAR / 20n,
    parentHeadroom: NEAR / 20n,
    parentRefill: NEAR / 10n,
  },
};

/**
 * Transactions kept for `txs()` and `findByKey()`. A sandbox has no indexer, so this gateway
 * remembers what it sent; the bound keeps a long-running process from growing without limit.
 */
const MAX_INDEXED_TXS = 10_000;

const DEFAULT_WASM_DIR = fileURLToPath(new URL('../../../contracts/out/', import.meta.url));

/**
 * Panic messages from near-contract-standards (which predate our snake_case codes), mapped to the
 * codes the simulator uses so callers see one vocabulary.
 */
const STANDARD_PANICS: [RegExp, string][] = [
  [/^The account doesn't have enough balance$/, 'insufficient_balance'],
  [/^The account \S+ is not registered$/, 'not_registered'],
  [/^The amount should be a positive number$/, 'invalid_amount'],
  [/^Sender and receiver should be different$/, 'self_transfer'],
  // A caller who is neither the holder nor approved by it.
  [/^Approval extension is disabled$/, 'not_owner'],
  [/^Sender not approved$/, 'not_owner'],
  [/^The actual approval_id .* is different from the given approval_id/, 'approval_mismatch'],
  [/^Token not found$/, 'not_found'],
  [/^Current and next owner must differ$/, 'self_transfer'],
  [/^Requires attached deposit of exactly 1 yoctoNEAR$/, 'one_yocto_required'],
  [/^Predecessor must be token owner\.$/, 'not_owner'],
];

/**
 * The market keeps up to 500 listings of about 300 bytes each, paid from its own balance, and
 * attaches 1 yoctoNEAR to every transfer it makes: fund it for the full set of listings.
 */
const MARKET_STATE_BYTES = 500n * 300n;

export interface NearChainOptions {
  rpcUrl: string;
  /** Endpoints that take over while `rpcUrl` is rate-limiting or down (public testnet RPCs). */
  fallbackRpcUrls?: string[];
  /** Most requests per second to any one endpoint (unset: no pacing, as on the local node). */
  maxRequestsPerSecond?: number;
  /** Root of the account layout, e.g. `hustle.test.near`. */
  root: string;
  /** Parent of the root, holding the NEAR that funds every account (sandbox: `test.near`). */
  funderId: string;
  /** The funder's full-access key; every account this gateway creates gets the same key. */
  funderKey: KeyPairString;
  /** Directory with the seven built contracts (`scripts/build-contracts.sh`). */
  wasmDir?: string;
  /** Sets how much NEAR each new account gets (default sandbox). */
  network?: NearNetwork;
  /** Least NEAR the root and the operator keep; below it `reserveShortfall` names the account. */
  reserve?: { root: bigint; operator: bigint };
  /**
   * Durable log of sent transactions (the game passes a Postgres one). Without it the gateway keeps
   * an in-memory index, which is enough for tests but forgets everything on restart.
   */
  txLog?: TxLog;
  /**
   * Tests only: make a keyed call die just before its broadcast, or lose its answer just after, the
   * way a crashed process would, so in-doubt resolution can be exercised against a real node.
   */
  faults?: {
    beforeBroadcast?: (method: string) => boolean;
    afterBroadcast?: (method: string) => boolean;
  };
}

// ── RPC shapes this gateway reads (narrowed at the boundary) ────────────────────────────────────

type ExecutionStatus =
  | { SuccessValue: string }
  | { SuccessReceiptId: string }
  | { Failure: unknown }
  | string;

interface OutcomeView {
  id: string;
  block_hash: string;
  outcome: { logs: string[]; status: ExecutionStatus; executor_id: string };
}

interface TxOutcomeView {
  status: ExecutionStatus;
  transaction: { hash: string; signer_id: string; receiver_id: string };
  transaction_outcome: OutcomeView;
  receipts_outcome: OutcomeView[];
}

interface ContractEvent {
  event: string;
  data: unknown;
}

interface SentTx {
  txHash: string;
  value: unknown;
  events: ContractEvent[];
  /** Codes of receipts that failed without failing the transaction (handled by a callback). */
  receiptFailures: string[];
}

interface IndexedTx extends ChainTxView {
  key: string | null;
  result: unknown;
}

// ── Contract view shapes ────────────────────────────────────────────────────────────────────────

interface ListingJson {
  token_id: string;
  seller_id: string;
  price: string;
  approval_id: number;
}

interface OutcomeJson {
  status: 'settled' | 'blocked' | 'pending' | 'in_flight' | 'failed' | 'denied';
  request_id: number;
  reason?: string;
}

interface WalletJson {
  owner_id: string;
  rulebook: StoredRulebook;
  frozen: boolean;
  day_ms: number;
  spent_today: string;
  job_spend: { job_id: string; spent: string }[];
  pending: { request_id: number; request: StoredRequest; reason: SpendReason }[];
  rotation_seq: number;
}

interface JobJson {
  job_id: number;
  client_id: string;
  budget: string;
  price: string | null;
  agent_id: string | null;
  status: ChainJob['status'];
  work_hash: string | null;
  delivery_window_ms: number;
  awarded_at_ms: number | null;
}

interface BadgeJson {
  token_id: string;
  metadata: { title: string; description: string };
}

interface ReputationJson {
  jobs_completed: number;
  rating_sum: number;
  rated_jobs: number;
  disputes_lost: number;
  scams_blocked: number;
}

interface RegistryConfigJson {
  wallet_code_hash: string | null;
  mint_deposit: string | null;
  /** Absent on a registry built before global wallet code (2026-11-13). */
  wallet_code_global?: boolean;
}

/** Global contract code costs 10x normal storage, burnt (NEP-591). */
const GLOBAL_CODE_MULTIPLIER = 10n;

/**
 * One step of `ensureSetup`. Each checks the chain before it sends, so a setup interrupted half way
 * finishes on the next call and a finished one sends nothing.
 */
interface SetupStep {
  label: string;
  /** The most NEAR the step moves out of the root (funding and deposits), gas excluded. */
  spend(): Promise<bigint>;
  /** The most gas the step's transactions may prepay; unused gas is refunded. */
  gas: bigint;
  isDone(): Promise<boolean>;
  run(): Promise<SentTx>;
}

/** A setup step that still has to run, with what it may cost. */
export interface PlannedStep {
  label: string;
  spend: bigint;
  gas: bigint;
}

/** A setup step that ran, with the hash of its (last) transaction. */
export interface SetupTx {
  label: string;
  txHash: string;
}

/**
 * The compiled contracts on a NEAR node (local sandbox or testnet), through near-api-js. Each
 * contract call is one transaction that waits until every receipt it spawned has executed
 * (`EXECUTED_OPTIMISTIC`), so a caller sees settled balances just as with the simulator. Accounts
 * are created as sub-accounts of the root and funded by it (amounts per network in `FUNDING`).
 */
export class NearChain implements ChainGateway {
  readonly mode: NearNetwork;
  readonly ids: ChainIds;
  private readonly provider: PacedRpcProvider;
  private readonly signer: KeyPairSigner;
  private readonly publicKey: PublicKey;
  private readonly funderId: string;
  private readonly wasmDir: string;
  private readonly funding: Funding;
  private readonly accounts = new Map<string, Account>();
  private readonly index: IndexedTx[] = [];
  private mintDeposit: bigint | null = null;
  private entryDeposit: bigint | null = null;

  constructor(private readonly opts: NearChainOptions) {
    const root = opts.root;
    this.ids = {
      root,
      credits: `credits.${root}`,
      registry: `agents.${root}`,
      jobs: `jobs.${root}`,
      rep: `rep.${root}`,
      operator: `orchestrator.${root}`,
      treasury: `treasury.${root}`,
      vendors: `vendors.${root}`,
      badges: `badges.${root}`,
      market: `market.${root}`,
    };
    this.provider = new PacedRpcProvider({
      urls: [opts.rpcUrl, ...(opts.fallbackRpcUrls ?? [])],
      maxPerSecond: opts.maxRequestsPerSecond,
      // On testnet a transaction's reference block is reused for 30 s; a local node can be moved
      // far ahead in time, so there every transaction reads a fresh one.
      finalBlockMaxAgeMs: opts.network === 'testnet' ? 30_000 : 0,
    });
    this.signer = KeyPairSigner.fromSecretKey(opts.funderKey);
    this.publicKey = KeyPair.fromString(opts.funderKey).getPublicKey();
    this.funderId = opts.funderId;
    this.wasmDir = opts.wasmDir ?? DEFAULT_WASM_DIR;
    this.mode = opts.network ?? 'sandbox';
    this.funding = FUNDING[this.mode];
  }

  // ── Transaction runner ────────────────────────────────────────────────────────────────────────

  private account(accountId: string): Account {
    // One Account per id keeps near-api-js's nonce cache, so back-to-back calls don't collide.
    let account = this.accounts.get(accountId);
    if (!account) {
      account = new Account(accountId, this.provider, this.signer);
      this.accounts.set(accountId, account);
    }
    return account;
  }

  private readonly signers = new SignerQueue();

  /** Every transaction goes through here: one in flight per signer (`SignerQueue`). */
  private send(
    signerId: string,
    receiverId: string,
    txActions: Action[],
    record: { method: string; args: unknown; key: string | null; dedupe?: boolean },
  ): Promise<SentTx> {
    return this.signers.run(signerId, () => this.sendNow(signerId, receiverId, txActions, record));
  }

  /**
   * Signs and sends one transaction (the work behind `send`). A keyed call is once per key: a key whose call already
   * succeeded returns that call's result and sends nothing, and the signed transaction is noted
   * (hash and bytes) before it is broadcast, so a process that dies before the answer leaves the
   * call in doubt rather than lost. The next call with that key asks the node about that hash and,
   * if the node never saw it, broadcasts the same signed bytes again (the nonce makes them land at
   * most once). A wallet spend opts out (`dedupe: false`): the wallet keeps its own keys.
   */
  private async sendNow(
    signerId: string,
    receiverId: string,
    txActions: Action[],
    record: { method: string; args: unknown; key: string | null; dedupe?: boolean },
  ): Promise<SentTx> {
    const keyed = record.key !== null && record.dedupe !== false;
    if (keyed && record.key) {
      const prior = await this.priorCall(record.key, record);
      if (prior) return prior;
    }
    await this.refillSigner(signerId);
    for (let attempt = 0; ; attempt++) {
      const signed = await this.account(signerId).createSignedTransaction({
        receiverId,
        actions: txActions,
      });
      const hash = signedHash(signed);
      if (keyed && record.key) {
        await this.notePending({
          key: record.key,
          hash,
          signer: signerId,
          receiver: receiverId,
          method: record.method,
          args: record.args,
          signed: Buffer.from(signed.encode()).toString('base64'),
        });
      }
      if (keyed && this.opts.faults?.beforeBroadcast?.(record.method))
        throw new Error('simulated crash before broadcast');
      let out: TxOutcomeView;
      try {
        out = (await this.provider.sendTransactionUntil(
          signed,
          'EXECUTED_OPTIMISTIC',
        )) as unknown as TxOutcomeView;
        if (keyed && this.opts.faults?.afterBroadcast?.(record.method))
          throw new Error('simulated lost answer');
      } catch (err) {
        // A nonce the node refuses, or a reference block too old, means this transaction can never
        // land: sign it again (with a fresh reference block, if the old one was the problem).
        if ((isNonceError(err) || isExpiredError(err)) && attempt < 5) {
          if (isExpiredError(err)) this.provider.forgetFinalBlock();
          else this.accounts.delete(signerId);
          if (keyed) await this.dropPending(hash);
          continue;
        }
        // Anything else is no answer: the transaction may have landed, so its pending note stays.
        throw err;
      }
      return this.settle(out, signerId, receiverId, record);
    }
  }

  /** The finished call for a key, from the log or, for a call left in doubt, from the node. */
  private async priorCall(
    key: string,
    record: { method: string; args: unknown; key: string | null },
  ): Promise<SentTx | null> {
    const done = await this.settledByKey(key);
    if (done) {
      return {
        txHash: done.hash,
        value: done.result ?? undefined,
        events: done.events as ContractEvent[],
        receiptFailures: [],
      };
    }
    const pending = await this.pendingByKey(key);
    if (!pending) return null;
    const known = await this.txStatus(pending.hash, pending.signer);
    if (known) return this.settle(known, pending.signer, pending.receiver, record);
    // The node never saw it: broadcast the same signed transaction, which lands at most once.
    try {
      const signed = SignedTransaction.decode(Buffer.from(pending.signed, 'base64'));
      const out = (await this.provider.sendTransactionUntil(
        signed,
        'EXECUTED_OPTIMISTIC',
      )) as unknown as TxOutcomeView;
      return this.settle(out, pending.signer, pending.receiver, record);
    } catch (err) {
      // Its nonce was used by another transaction or it expired: it can never land.
      if (isNonceError(err) || isExpiredError(err)) {
        await this.dropPending(pending.hash);
        return null;
      }
      throw err;
    }
  }

  /** Records a transaction's outcome; a failed one becomes a ChainError with the contract's code. */
  private async settle(
    out: TxOutcomeView,
    signerId: string,
    receiverId: string,
    record: { method: string; args: unknown; key: string | null },
  ): Promise<SentTx> {
    const txHash = out.transaction.hash;
    const events = parseEvents(out);
    const failure = isFailure(out.status) ? out.status.Failure : null;
    const block = await this.blockOf(out.transaction_outcome.block_hash);
    const error = failure === null ? null : failureCode(failure);
    const value = successValue(out.status);
    await this.remember({
      hash: txHash,
      signer: signerId,
      receiver: receiverId,
      method: record.method,
      args: record.args,
      outcome: error === null ? 'success' : 'failure',
      events,
      error,
      block: block.header.height,
      createdAt: new Date(
        Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n),
      ).toISOString(),
      key: record.key,
      result: value,
    });
    if (error !== null) throw new ChainError(error, txHash);
    return {
      txHash,
      value,
      events,
      receiptFailures: out.receipts_outcome
        .map((r) => r.outcome.status)
        .filter(isFailure)
        .map((s) => failureCode(s.Failure)),
    };
  }

  /**
   * What the node knows about a transaction: its executed outcome, or null if it never saw it.
   * Asked with `wait_until: NONE` first, which answers at once for a hash the node never saw.
   */
  private async txStatus(hash: string, signer: string): Promise<TxOutcomeView | null> {
    const ask = async (waitUntil: string) =>
      (await this.provider.sendJsonRpc('tx', {
        tx_hash: hash,
        sender_account_id: signer,
        wait_until: waitUntil,
      })) as unknown as TxOutcomeView | undefined;
    try {
      await ask('NONE');
    } catch (err) {
      if (
        /UNKNOWN_TRANSACTION|unknown transaction|doesn't exist|does not exist/i.test(errorText(err))
      )
        return null;
      throw err;
    }
    // Known but maybe not executed yet: wait for its outcome.
    for (let i = 0; i < 10; i++) {
      try {
        const done = await ask('EXECUTED_OPTIMISTIC');
        if (done?.transaction_outcome) return done;
      } catch (err) {
        if (!/TIMEOUT/i.test(errorText(err))) throw err;
      }
    }
    throw new Error(`tx ${hash} did not execute in time`);
  }

  private call(
    signerId: string,
    contractId: string,
    method: string,
    args: Record<string, unknown>,
    opts: { deposit?: bigint; gas?: bigint; key?: string | null; dedupe?: boolean } = {},
  ): Promise<SentTx> {
    const action = actions.functionCall(method, args, opts.gas ?? GAS_LOCAL, opts.deposit ?? 0n);
    return this.send(signerId, contractId, [action], {
      method,
      args,
      key: opts.key ?? null,
      dedupe: opts.dedupe,
    });
  }

  private async view<T>(
    contractId: string,
    method: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    return (await this.provider.callFunction({ contractId, method, args })) as T;
  }

  private async remember(tx: IndexedTx): Promise<void> {
    if (tx.key) for (const [k, v] of this.pending) if (v.hash === tx.hash) this.pending.delete(k);
    this.index.push(tx);
    if (this.index.length > MAX_INDEXED_TXS) this.index.shift();
    await this.opts.txLog?.record({
      ...tx,
      chainBlock: tx.block,
      timestampMs: Date.parse(tx.createdAt),
    });
  }

  /** Pending notes when there is no durable log (tests): enough within one process. */
  private readonly pending = new Map<string, PendingTx>();

  private async settledByKey(key: string): Promise<SettledTx | null> {
    if (this.opts.txLog) return this.opts.txLog.settledByKey(key);
    for (let i = this.index.length - 1; i >= 0; i--) {
      const tx = this.index[i];
      if (tx && tx.key === key && tx.outcome === 'success')
        return { ...toView(tx), result: tx.result };
    }
    return null;
  }

  private async notePending(tx: PendingTx): Promise<void> {
    if (this.opts.txLog) await this.opts.txLog.notePending(tx);
    else this.pending.set(tx.key, tx);
  }

  private async pendingByKey(key: string): Promise<PendingTx | null> {
    if (this.opts.txLog) return this.opts.txLog.pendingByKey(key);
    return this.pending.get(key) ?? null;
  }

  private async dropPending(hash: string): Promise<void> {
    if (this.opts.txLog) await this.opts.txLog.dropPending(hash);
    for (const [k, v] of this.pending) if (v.hash === hash) this.pending.delete(k);
  }

  private async exists(accountId: string): Promise<boolean> {
    try {
      await this.provider.viewAccount({ accountId });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The block a transaction landed in. The endpoint that answers may be a moment behind the one
   * that ran the transaction and not know the block yet, so an unknown block is asked for again.
   */
  private async blockOf(hash: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.provider.viewBlock({ blockId: hash });
      } catch (err) {
        if (attempt >= 5 || !/UnknownBlock|never been observed/i.test(String(err))) throw err;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }

  private async blockTimeMs(): Promise<number> {
    const block = await this.provider.viewBlock({ finality: 'optimistic' });
    return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
  }

  // ── Setup and accounts ────────────────────────────────────────────────────────────────────────

  private parentOf(accountId: string): string {
    return accountId.slice(accountId.indexOf('.') + 1);
  }

  /** Creates `accountId` (and any missing parent under the root) with our key and some NEAR. */
  private async createWithParents(accountId: string, funding: bigint): Promise<SentTx> {
    const parent = this.parentOf(accountId);
    const insideRoot = parent === this.ids.root || parent.endsWith(`.${this.ids.root}`);
    if (insideRoot && !(await this.exists(parent))) {
      await this.createWithParents(parent, this.funding.account);
    }
    if (parent !== this.ids.root && parent !== this.funderId) await this.topUp(parent, funding);
    return this.send(
      parent,
      accountId,
      [
        actions.createAccount(),
        actions.transfer(funding),
        actions.addFullAccessKey(this.publicKey),
      ],
      { method: 'create_account', args: { account_id: accountId }, key: `account:${accountId}` },
    );
  }

  /**
   * Every account under the root that signs is topped up by the root when it runs low: players
   * sparingly (testnet: they start with very little, so NEAR goes only to accounts that play), the
   * game's own signers and the operator to a working balance.
   */
  private async refillSigner(signerId: string): Promise<void> {
    if (this.funding.accountLow === 0n && this.funding.houseLow === 0n) return;
    if (signerId === this.ids.root || signerId === this.funderId) return;
    if (!signerId.endsWith(`.${this.ids.root}`)) return;
    const { amount } = await this.provider.viewAccount({ accountId: signerId });
    // Whatever the floor, a signer must cover one full-gas call at today's gas price.
    const oneCall = (await this.gasPrice()) * GAS_MAX + NEAR / 100n;
    if (!isPlayerAccount(signerId)) {
      // The game's own signers and the operator: kept topped up, no daily cap.
      const operator = signerId === this.ids.operator;
      const floor = maxBig(
        operator ? this.funding.operatorLow : this.funding.houseLow,
        2n * oneCall,
      );
      if (amount >= floor) return;
      const target = operator ? this.funding.operatorTarget : this.funding.houseTarget;
      const top = maxBig(target, floor + oneCall) - amount;
      const root = await this.provider.viewAccount({ accountId: this.ids.root });
      if (root.amount < top + NEAR) {
        if (!this.warnedRootLow) {
          this.warnedRootLow = true;
          console.warn(
            JSON.stringify({ message: 'root too low to refill a house signer', signer: signerId }),
          );
        }
        return;
      }
      await this.send(this.ids.root, signerId, [actions.transfer(top)], {
        method: 'transfer',
        args: { amount: top.toString() },
        key: null,
      });
      return;
    }
    if (this.funding.accountLow === 0n) return;
    const floor = maxBig(this.funding.accountLow, oneCall);
    if (amount >= floor) return;
    // Players: topped up by `accountRefill` whenever they run low, while the root can afford it.
    const top = minBig(floor + this.funding.accountRefill - amount, this.funding.accountRefill);
    const root = await this.provider.viewAccount({ accountId: this.ids.root });
    if (root.amount < top + NEAR) {
      if (!this.warnedRootLow) {
        this.warnedRootLow = true;
        console.warn(
          JSON.stringify({ message: 'root too low to refill a player account', signer: signerId }),
        );
      }
      return;
    }
    await this.send(this.ids.root, signerId, [actions.transfer(top)], {
      method: 'transfer',
      args: { amount: top.toString() },
      key: null,
    });
  }

  private warnedRootLow = false;
  private gasPriceCache: { at: number; price: bigint } | null = null;

  /** Yocto per gas now, read at most once a minute. */
  private async gasPrice(): Promise<bigint> {
    if (this.gasPriceCache && Date.now() - this.gasPriceCache.at < 60_000)
      return this.gasPriceCache.price;
    const price = BigInt((await this.provider.viewGasPrice()).gas_price);
    this.gasPriceCache = { at: Date.now(), price };
    return price;
  }

  private reserveCache: { at: number; short: string | null } | null = null;

  /**
   * Which of the root and operator holds less than its reserve (`opts.reserve`), or null. Read at
   * most every 30 s, so a burst of sign-ups costs two RPC reads, not one per request.
   */
  async reserveShortfall(): Promise<string | null> {
    const reserve = this.opts.reserve;
    if (!reserve) return null;
    if (this.reserveCache && Date.now() - this.reserveCache.at < 30_000)
      return this.reserveCache.short;
    let short: string | null = null;
    for (const [accountId, least] of [
      [this.ids.root, reserve.root],
      [this.ids.operator, reserve.operator],
    ] as const) {
      const { amount } = await this.provider.viewAccount({ accountId });
      if (amount < least) {
        short = accountId;
        break;
      }
    }
    this.reserveCache = { at: Date.now(), short };
    return short;
  }

  /** A parent such as `vendors.<root>` pays for each child it creates; the root refills it. */
  private async topUp(accountId: string, needed: bigint): Promise<void> {
    const { amount } = await this.provider.viewAccount({ accountId });
    if (amount >= needed + this.funding.parentHeadroom) return;
    const refill = needed + this.funding.parentRefill;
    await this.send(this.ids.root, accountId, [actions.transfer(refill)], {
      method: 'transfer',
      args: { amount: refill.toString() },
      key: null,
    });
  }

  /** NEP-145 registration on credits, paid by the root (an agent wallet is registered by its mint). */
  private async register(accountId: string): Promise<void> {
    if (!(await this.registered(accountId))) await this.sendRegister(accountId);
  }

  private async registered(accountId: string): Promise<boolean> {
    const balance = await this.view<unknown>(this.ids.credits, 'storage_balance_of', {
      account_id: accountId,
    });
    return Boolean(balance);
  }

  private sendRegister(accountId: string): Promise<SentTx> {
    return this.call(
      this.ids.root,
      this.ids.credits,
      'storage_deposit',
      { account_id: accountId, registration_only: true },
      { deposit: CREDITS_STORAGE_DEPOSIT },
    );
  }

  private wasm(name: string): Promise<Buffer> {
    return readFile(`${this.wasmDir}/${name}.wasm`);
  }

  private async wasmBytes(name: string): Promise<number> {
    return (await stat(`${this.wasmDir}/${name}.wasm`)).size;
  }

  /** Whether the account holds a contract; false if it doesn't exist. */
  private async hasCode(accountId: string): Promise<boolean> {
    try {
      return (await this.provider.viewAccount({ accountId })).code_hash !== EMPTY_CODE_HASH;
    } catch {
      return false;
    }
  }

  /** What a contract account is given: storage for `codeBytes` plus room for its state to grow. */
  private contractFunding(codeBytes: number, stateBytes = 0n): bigint {
    const needed =
      (BigInt(codeBytes) + stateBytes) * STORAGE_PRICE_PER_BYTE + this.funding.contractState;
    // Math.max doesn't take bigints.
    if (needed < this.funding.contractMin) return this.funding.contractMin;
    return needed;
  }

  /** Creates, funds, deploys and initialises a contract account in one atomic batch. */
  private contractStep(
    accountId: string,
    wasm: string,
    init: Record<string, unknown>,
    /** State the contract will hold beyond its own code (the registry stores the wallet code). */
    extraWasm?: string,
    /** Bounded state the contract pays for from its own balance (the market's listings). */
    stateBytes = 0n,
  ): SetupStep {
    const codeBytes = async () =>
      (await this.wasmBytes(wasm)) + (extraWasm ? await this.wasmBytes(extraWasm) : 0);
    return {
      label: `deploy ${wasm} to ${accountId}`,
      spend: async () => this.contractFunding(await codeBytes(), stateBytes),
      gas: GAS_MAX,
      isDone: async () => {
        if (!(await this.exists(accountId))) return false;
        // The deploy batch is atomic, so an account this gateway created always holds its contract.
        if (!(await this.hasCode(accountId))) {
          throw new Error(`${accountId} exists but holds no contract; use another root account`);
        }
        return true;
      },
      run: async () => {
        const code = await this.wasm(wasm);
        const funding = this.contractFunding(await codeBytes(), stateBytes);
        return this.send(
          this.ids.root,
          accountId,
          [
            actions.createAccount(),
            actions.transfer(funding),
            actions.addFullAccessKey(this.publicKey),
            actions.deployContract(code),
            actions.functionCall('new', init, GAS_LOCAL, 0n),
          ],
          { method: 'deploy', args: { wasm, init }, key: `deploy:${accountId}` },
        );
      },
    };
  }

  /** An account this gateway creates and funds (parents under the root first). */
  private accountStep(accountId: string, funding: bigint): SetupStep {
    const parent = this.parentOf(accountId);
    // A parent below the root is refilled by the root before it funds a child (`topUp`).
    const viaParent = parent !== this.ids.root && parent !== this.funderId;
    return {
      label: `create ${accountId}`,
      spend: async () => (viaParent ? funding + this.funding.parentRefill : funding),
      gas: GAS_ACCOUNT * (viaParent ? 2n : 1n),
      isDone: () => this.exists(accountId),
      run: () => this.createWithParents(accountId, funding),
    };
  }

  private registerStep(accountId: string): SetupStep {
    return {
      label: `register ${accountId} with ${this.ids.credits}`,
      spend: async () => CREDITS_STORAGE_DEPOSIT,
      gas: GAS_LOCAL,
      isDone: async () => (await this.hasCode(this.ids.credits)) && this.registered(accountId),
      run: () => this.sendRegister(accountId),
    };
  }

  /** Defines a badge type, or updates its text; done when the contract already has it as is. */
  private badgeStep(badge: BadgeType): SetupStep {
    return {
      label: `register badge ${badge.tokenId}`,
      // The badges contract pays for its own state.
      spend: async () => 0n,
      gas: GAS_LOCAL,
      isDone: async () => {
        if (!(await this.hasCode(this.ids.badges))) return false;
        const [known] = await this.view<(BadgeJson | null)[]>(this.ids.badges, 'mt_token', {
          token_ids: [badge.tokenId],
        });
        return (
          known?.metadata.title === badge.title && known.metadata.description === badge.description
        );
      },
      run: () =>
        this.call(this.ids.root, this.ids.badges, 'register_badge', {
          token_id: badge.tokenId,
          title: badge.title,
          description: badge.description,
        }),
    };
  }

  private walletCodeStep(): SetupStep {
    return {
      label: `store the agent wallet code on ${this.ids.registry}`,
      // The registry's funding already covers the stored code (`contractStep`'s extra state).
      spend: async () => 0n,
      gas: GAS_MAX,
      isDone: async () =>
        (await this.hasCode(this.ids.registry)) &&
        (await this.registryConfig()).wallet_code_hash !== null,
      run: async () => {
        const code = await this.wasm('agent-wallet');
        // The raw wasm is the call input, not JSON; the index keeps only its length.
        return this.send(
          this.ids.root,
          this.ids.registry,
          [actions.functionCall('set_wallet_code', new Uint8Array(code), GAS_MAX, 0n)],
          { method: 'set_wallet_code', args: { code_len: code.length }, key: null },
        );
      },
    };
  }

  /**
   * The one contract upgrade setup does: a registry built before global wallet code gets the new
   * build. Its stored state is unchanged (the new flag lives under its own storage key), so no
   * migration is needed; any other stale contract is still only reported (`contractCode`).
   */
  private registryUpgradeStep(): SetupStep {
    const topUp = async () => {
      const account = await this.provider.viewAccount({ accountId: this.ids.registry });
      const oldCode = await this.deployedCodeBytes(this.ids.registry);
      const need =
        (BigInt(account.storage_usage) -
          BigInt(oldCode) +
          BigInt(await this.wasmBytes('registry'))) *
          STORAGE_PRICE_PER_BYTE +
        this.funding.contractMin / 10n;
      const have = BigInt(account.amount);
      return need > have ? need - have : 0n;
    };
    return {
      label: `upgrade ${this.ids.registry} to the build with global wallet code (state unchanged)`,
      spend: async () => ((await this.exists(this.ids.registry)) ? topUp() : 0n),
      gas: GAS_MAX + GAS_ACCOUNT,
      isDone: async () =>
        !(await this.hasCode(this.ids.registry)) ||
        (await this.registryConfig()).wallet_code_global !== undefined,
      run: async () => {
        const extra = await topUp();
        if (extra > 0n)
          await this.send(this.ids.root, this.ids.registry, [actions.transfer(extra)], {
            method: 'transfer',
            args: { amount: extra.toString() },
            key: null,
          });
        return this.send(
          this.ids.registry,
          this.ids.registry,
          [actions.deployContract(await this.wasm('registry'))],
          { method: 'upgrade', args: { wasm: 'registry' }, key: null },
        );
      },
    };
  }

  /**
   * Publishes the wallet code as a global contract through the registry, so each new agent uses it
   * by hash and pays only for its own state (about 0.3 NEAR instead of 2). Costs 10x the code's
   * storage once, burnt. Agents minted before keep their own copy of the same code.
   */
  private publishWalletCodeStep(): SetupStep {
    const cost = async () =>
      BigInt(await this.wasmBytes('agent-wallet')) *
      GLOBAL_CODE_MULTIPLIER *
      STORAGE_PRICE_PER_BYTE;
    return {
      label: `publish the agent wallet code as a global contract (burns 10x its storage)`,
      spend: cost,
      gas: GAS_MAX,
      isDone: async () =>
        (await this.hasCode(this.ids.registry)) &&
        (await this.registryConfig()).wallet_code_global === true,
      run: async () => {
        const code = await this.wasm('agent-wallet');
        const sent = await this.send(
          this.ids.root,
          this.ids.registry,
          [
            actions.functionCall(
              'publish_wallet_code',
              new Uint8Array(code),
              GAS_MAX,
              await cost(),
            ),
          ],
          { method: 'publish_wallet_code', args: { code_len: code.length }, key: null },
        );
        this.mintDeposit = null;
        return sent;
      },
    };
  }

  private async deployedCodeBytes(accountId: string): Promise<number> {
    const code = await this.provider.viewContractCode({ contractId: accountId });
    return Buffer.from(code.code_base64, 'base64').length;
  }

  private async registryConfig(): Promise<RegistryConfigJson> {
    return this.view<RegistryConfigJson>(this.ids.registry, 'get_config', {});
  }

  /**
   * Every setup step (accounts, contract deploys, wallet code, badges, registrations), mirroring the
   * contract test harness, in the order they must run. `dayMs` becomes the registry's `wallet_day_ms` (the
   * contracts require at least 60_000).
   */
  private setupSteps(cfg: ChainSetup): SetupStep[] {
    const ids = this.ids;
    const steps: SetupStep[] = [];
    if (ids.root !== this.funderId) {
      steps.push({
        label: `create ${ids.root}`,
        spend: async () => this.funding.root,
        gas: GAS_ACCOUNT,
        isDone: () => this.exists(ids.root),
        run: () =>
          this.send(
            this.funderId,
            ids.root,
            [
              actions.createAccount(),
              actions.transfer(this.funding.root),
              actions.addFullAccessKey(this.publicKey),
            ],
            {
              method: 'create_account',
              args: { account_id: ids.root },
              key: `account:${ids.root}`,
            },
          ),
      });
    }
    steps.push(
      this.accountStep(ids.operator, this.funding.operator),
      this.accountStep(ids.treasury, this.funding.payee),
      this.accountStep(ids.vendors, this.funding.payee),
      this.contractStep(ids.credits, 'credits', { owner_id: ids.root }),
      this.contractStep(
        ids.registry,
        'registry',
        {
          owner_id: ids.root,
          // The game's signup service mints, as in the simulator; it is the operator account here.
          minter_id: ids.operator,
          operator_id: ids.operator,
          credits_id: ids.credits,
          jobs_id: ids.jobs,
          treasury_id: ids.treasury,
          wallet_day_ms: cfg.dayMs,
        },
        'agent-wallet',
      ),
      this.contractStep(ids.jobs, 'job-board', {
        owner_id: ids.root,
        operator_id: ids.operator,
        credits_id: ids.credits,
        registry_id: ids.registry,
        rep_id: ids.rep,
        treasury_id: ids.treasury,
        fee_bps: cfg.feeBps,
      }),
      this.contractStep(ids.rep, 'reputation', {
        owner_id: ids.root,
        jobs_id: ids.jobs,
        operator_id: ids.operator,
        registry_id: ids.registry,
      }),
      this.contractStep(ids.badges, 'badges', {
        owner_id: ids.root,
        minter_id: ids.operator,
        registry_id: ids.registry,
      }),
      this.contractStep(
        ids.market,
        'market',
        {
          owner_id: ids.root,
          registry_id: ids.registry,
          credits_id: ids.credits,
          treasury_id: ids.treasury,
          fee_bps: cfg.marketFeeBps,
        },
        undefined,
        MARKET_STATE_BYTES,
      ),
      ...(cfg.badges ?? []).map((badge) => this.badgeStep(badge)),
      this.registryUpgradeStep(),
      this.walletCodeStep(),
      ...(cfg.globalWalletCode === false ? [] : [this.publishWalletCodeStep()]),
      this.registerStep(ids.jobs),
      this.registerStep(ids.treasury),
      this.registerStep(ids.market),
    );
    for (const handle of cfg.vendorHandles) {
      const vendor = `${handle}.${ids.vendors}`;
      steps.push(this.accountStep(vendor, this.funding.payee), this.registerStep(vendor));
    }
    return steps;
  }

  /**
   * Deploys and initialises the contracts under the root. Every step checks what exists first,
   * so a setup interrupted half way finishes on the next call; returns the steps that sent something.
   */
  async ensureSetup(cfg: ChainSetup): Promise<SetupTx[]> {
    const sent: SetupTx[] = [];
    for (const step of this.setupSteps(cfg)) {
      if (await step.isDone()) continue;
      sent.push({ label: step.label, txHash: (await step.run()).txHash });
    }
    return sent;
  }

  /**
   * What `ensureSetup` would send, read from the chain without sending anything, so a deploy can say
   * what it will cost before it spends. Refuses a layout whose signing accounts exist under a key
   * other than ours, since setup or the game would fail half way.
   */
  async planSetup(cfg: ChainSetup): Promise<PlannedStep[]> {
    for (const signer of [this.funderId, this.ids.root, this.ids.operator, this.ids.vendors]) {
      if ((await this.exists(signer)) && !(await this.holdsKey(signer))) {
        throw new Error(`${signer} exists but the configured key cannot sign for it`);
      }
    }
    const planned: PlannedStep[] = [];
    for (const step of this.setupSteps(cfg)) {
      if (await step.isDone()) continue;
      planned.push({ label: step.label, spend: await step.spend(), gas: step.gas });
    }
    return planned;
  }

  private async holdsKey(accountId: string): Promise<boolean> {
    try {
      const key = await this.provider.viewAccessKey({
        accountId,
        publicKey: this.publicKey.toString(),
      });
      return key.permission === 'FullAccess';
    } catch {
      return false;
    }
  }

  /**
   * Whether each contract account holds the code in `wasmDir`. Setup never redeploys over a live
   * contract (its state would need a migration; only the registry upgrade is the exception), so a
   * deploy reports a stale one instead.
   */
  async contractCode(): Promise<{ accountId: string; wasm: string; current: boolean }[]> {
    const ids = this.ids;
    const contracts: [string, string][] = [
      [ids.credits, 'credits'],
      [ids.registry, 'registry'],
      [ids.jobs, 'job-board'],
      [ids.rep, 'reputation'],
      [ids.badges, 'badges'],
      [ids.market, 'market'],
    ];
    return Promise.all(
      contracts.map(async ([accountId, wasm]) => {
        const local = baseEncode(
          createHash('sha256')
            .update(await this.wasm(wasm))
            .digest(),
        );
        const { code_hash } = await this.provider.viewAccount({ accountId });
        return { accountId, wasm, current: code_hash === local };
      }),
    );
  }

  /** The root (or a parent under it) creates and funds the account, then registers it with credits. */
  async createAccount(accountId: string): Promise<TxResult> {
    if (!accountId.endsWith(`.${this.ids.root}`)) throw new ChainError('invalid_account', null);
    const created = await this.createWithParents(accountId, this.funding.account);
    await this.register(accountId);
    return { txHash: created.txHash, value: undefined };
  }

  async mintCredits(accountId: string, amount: bigint, key: string): Promise<TxResult> {
    const tx = await this.call(
      this.ids.root,
      this.ids.credits,
      'mint',
      { account_id: accountId, amount: amount.toString() },
      { key },
    );
    return { txHash: tx.txHash, value: undefined };
  }

  async ftBalance(accountId: string): Promise<bigint> {
    return BigInt(
      await this.view<string>(this.ids.credits, 'ft_balance_of', { account_id: accountId }),
    );
  }

  async ftTransfer(
    signer: string,
    receiverId: string,
    amount: bigint,
    memo: string,
    key: string,
  ): Promise<TxResult> {
    const tx = await this.call(
      signer,
      this.ids.credits,
      'ft_transfer',
      { receiver_id: receiverId, amount: amount.toString(), memo },
      { deposit: ONE_YOCTO, key },
    );
    return { txHash: tx.txHash, value: undefined };
  }

  // ── Registry ──────────────────────────────────────────────────────────────────────────────────

  async mintAgent(
    ownerId: string,
    name: string,
    metadata: Record<string, unknown>,
    rulebook: Rulebook,
    key: string,
  ): Promise<TxResult<string>> {
    const prior = await this.findByKey(key);
    const priorToken = prior ? mintedToken(prior.events) : null;
    if (prior && priorToken) return { txHash: prior.hash, value: priorToken };
    if (this.mintDeposit === null) {
      const deposit = (await this.registryConfig()).mint_deposit;
      if (deposit === null) throw new ChainError('no_wallet_code', null);
      this.mintDeposit = BigInt(deposit);
    }
    const tx = await this.call(
      this.ids.operator,
      this.ids.registry,
      'mint_agent',
      {
        owner_id: ownerId,
        name,
        // NEP-177 has no field for game data; `extra` is its slot for app JSON.
        metadata: Object.keys(metadata).length ? { extra: JSON.stringify(metadata) } : null,
        rulebook: toStoredRulebook(rulebook),
      },
      { deposit: this.mintDeposit, gas: GAS_MAX, key },
    );
    const tokenId = typeof tx.value === 'string' ? tx.value : null;
    if (!tokenId) throw new ChainError('mint_failed', tx.txHash);
    return { txHash: tx.txHash, value: tokenId };
  }

  async nftTransfer(signer: string, tokenId: string, receiverId: string): Promise<TxResult> {
    const tx = await this.call(
      signer,
      this.ids.registry,
      'nft_transfer',
      { receiver_id: receiverId, token_id: tokenId },
      { deposit: ONE_YOCTO, gas: GAS_CROSS },
    );
    return { txHash: tx.txHash, value: undefined };
  }

  async nftOwner(tokenId: string): Promise<string | null> {
    const token = await this.view<{ owner_id: string } | null>(this.ids.registry, 'nft_token', {
      token_id: tokenId,
    });
    return token?.owner_id ?? null;
  }

  /** Owner actions go through the registry with exactly 1 yoctoNEAR, as the contract requires. */
  private ownerAction(
    signer: string,
    tokenId: string,
    method: string,
    args: Record<string, unknown>,
    key: string | null = null,
  ): Promise<SentTx> {
    return this.call(
      signer,
      this.ids.registry,
      method,
      { token_id: tokenId, ...args },
      { deposit: ONE_YOCTO, gas: GAS_CROSS, key },
    );
  }

  async setRulebook(signer: string, tokenId: string, rulebook: Rulebook): Promise<TxResult> {
    const tx = await this.ownerAction(signer, tokenId, 'set_rulebook', {
      rulebook: toStoredRulebook(rulebook),
    });
    return { txHash: tx.txHash, value: undefined };
  }

  async approveSpend(
    signer: string,
    tokenId: string,
    requestId: number,
  ): Promise<TxResult<SpendOutcome>> {
    const tx = await this.ownerAction(signer, tokenId, 'approve_spend', { request_id: requestId });
    return { txHash: tx.txHash, value: toOutcome(tx.value as OutcomeJson, tx.txHash) };
  }

  async denySpend(signer: string, tokenId: string, requestId: number): Promise<TxResult> {
    const tx = await this.ownerAction(signer, tokenId, 'deny_spend', { request_id: requestId });
    return { txHash: tx.txHash, value: undefined };
  }

  async withdraw(signer: string, tokenId: string, amount: bigint, key: string): Promise<TxResult> {
    const tx = await this.ownerAction(
      signer,
      tokenId,
      'withdraw',
      { amount: amount.toString() },
      key,
    );
    // The wallet resolves a failed transfer in its callback and returns false instead of panicking,
    // so the transaction succeeds; report the transfer's own error like the simulator does.
    if (tx.value === false) {
      throw new ChainError(tx.receiptFailures[0] ?? 'withdraw_failed', tx.txHash);
    }
    return { txHash: tx.txHash, value: undefined };
  }

  async setFrozen(signer: string, tokenId: string, frozen: boolean): Promise<TxResult> {
    const tx = await this.ownerAction(signer, tokenId, 'set_frozen', { frozen });
    return { txHash: tx.txHash, value: undefined };
  }

  // ── Agent wallet ──────────────────────────────────────────────────────────────────────────────

  async spend(walletId: string, request: SpendRequest): Promise<SpendOutcome> {
    const tx = await this.call(
      this.ids.operator,
      walletId,
      'spend',
      { request: toStoredRequest(request) },
      // The wallet keeps its own request keys: a repeated key returns its current outcome.
      { gas: GAS_CROSS, key: request.key, dedupe: false },
    );
    return toOutcome(tx.value as OutcomeJson, tx.txHash);
  }

  async getWallet(walletId: string): Promise<WalletState> {
    let w: WalletJson;
    try {
      w = await this.view<WalletJson>(walletId, 'get_wallet', {});
    } catch (err) {
      // Only an account without the wallet is "not found"; a rate limit or an RPC outage is not an
      // answer about the wallet and goes up as it is.
      if (
        /does not exist|doesn't exist|AccountDoesNotExist|CodeDoesNotExist|MethodNotFound|UNKNOWN_ACCOUNT|NO_CONTRACT_CODE/i.test(
          errorText(err),
        )
      )
        throw new ChainError('wallet_not_found', null);
      throw err;
    }
    return {
      ownerId: w.owner_id,
      rulebook: fromStoredRulebook(w.rulebook),
      frozen: w.frozen,
      dayMs: w.day_ms,
      // The contract stores the day of its last spend; report today, as `spent_today` already does.
      day: Math.floor((await this.blockTimeMs()) / w.day_ms),
      spentToday: BigInt(w.spent_today),
      jobSpent: Object.fromEntries(w.job_spend.map((j) => [j.job_id, BigInt(j.spent)])),
      pending: w.pending.map((p) => ({
        id: p.request_id,
        request: fromStoredRequest(p.request),
        reason: p.reason,
      })),
      rotationSeq: w.rotation_seq,
    };
  }

  // ── Job board ─────────────────────────────────────────────────────────────────────────────────

  async postJob(
    signer: string,
    budget: bigint,
    msg: {
      jobKey: string;
      specHash: string;
      autoAward: boolean;
      reviewWindowMs: number;
      deliveryWindowMs?: number;
    },
  ): Promise<TxResult<string | null>> {
    const post = {
      job_key: msg.jobKey,
      spec_hash: msg.specHash,
      auto_award: msg.autoAward,
      review_window_ms: msg.reviewWindowMs,
      // Omitted (undefined drops out of the JSON) means the board's default of one day.
      delivery_window_ms: msg.deliveryWindowMs,
    };
    const tx = await this.call(
      signer,
      this.ids.credits,
      'ft_transfer_call',
      { receiver_id: this.ids.jobs, amount: budget.toString(), msg: JSON.stringify({ post }) },
      { deposit: ONE_YOCTO, gas: GAS_CROSS, key: `post:${msg.jobKey}` },
    );
    // `ft_transfer_call` resolves to the amount the board kept: zero means it refunded the post.
    if (BigInt(String(tx.value ?? '0')) === 0n) return { txHash: tx.txHash, value: null };
    const posted = tx.events.find((e) => e.event === 'job_posted')?.data as
      | { job_id: number }
      | undefined;
    if (!posted) throw new ChainError('job_not_posted', tx.txHash);
    return { txHash: tx.txHash, value: String(posted.job_id) };
  }

  private jobCall(
    signer: string,
    method: string,
    jobId: string,
    args: Record<string, unknown>,
    key: string,
  ): Promise<SentTx> {
    return this.call(
      signer,
      this.ids.jobs,
      method,
      { job_id: chainJobId(jobId), ...args },
      { gas: GAS_CROSS, key },
    );
  }

  async award(signer: string, jobId: string, agentId: string, price: bigint): Promise<TxResult> {
    const args = { agent_id: agentId, price: price.toString() };
    const tx = await this.jobCall(signer, 'award', jobId, args, `award:${jobId}`);
    return { txHash: tx.txHash, value: undefined };
  }

  async deliver(jobId: string, agentId: string, workHash: string): Promise<TxResult> {
    const args = { agent_id: agentId, work_hash: workHash };
    const tx = await this.jobCall(this.ids.operator, 'deliver', jobId, args, `deliver:${jobId}`);
    return { txHash: tx.txHash, value: undefined };
  }

  async accept(signer: string, jobId: string, rating: number): Promise<TxResult> {
    const tx = await this.jobCall(signer, 'accept', jobId, { rating }, `accept:${jobId}`);
    return { txHash: tx.txHash, value: undefined };
  }

  async releaseExpired(signer: string, jobId: string): Promise<TxResult> {
    const tx = await this.jobCall(signer, 'release_expired', jobId, {}, `release:${jobId}`);
    return { txHash: tx.txHash, value: undefined };
  }

  async dispute(signer: string, jobId: string): Promise<TxResult> {
    const tx = await this.jobCall(signer, 'dispute', jobId, {}, `dispute:${jobId}`);
    return { txHash: tx.txHash, value: undefined };
  }

  async resolve(jobId: string, refund: boolean): Promise<TxResult> {
    const key = `resolve:${jobId}`;
    const tx = await this.jobCall(this.ids.operator, 'resolve', jobId, { refund }, key);
    return { txHash: tx.txHash, value: undefined };
  }

  async reclaimUndelivered(signer: string, jobId: string): Promise<TxResult> {
    const tx = await this.jobCall(signer, 'reclaim_undelivered', jobId, {}, `reclaim:${jobId}`);
    return { txHash: tx.txHash, value: undefined };
  }

  async reclaimFailedPayout(signer: string, jobId: string): Promise<TxResult> {
    const key = `reclaim-payout:${jobId}`;
    const tx = await this.jobCall(signer, 'reclaim_failed_payout', jobId, {}, key);
    return { txHash: tx.txHash, value: undefined };
  }

  async cancel(signer: string, jobId: string): Promise<TxResult> {
    const tx = await this.jobCall(signer, 'cancel', jobId, {}, `cancel:${jobId}`);
    return { txHash: tx.txHash, value: undefined };
  }

  async getJob(jobId: string): Promise<ChainJob | null> {
    const j = await this.view<JobJson | null>(this.ids.jobs, 'get_job', {
      job_id: chainJobId(jobId),
    });
    if (!j) return null;
    return {
      jobId: String(j.job_id),
      clientId: j.client_id,
      budget: BigInt(j.budget),
      price: j.price === null ? null : BigInt(j.price),
      agentId: j.agent_id,
      status: j.status,
      workHash: j.work_hash,
      deliveryWindowMs: j.delivery_window_ms,
      awardedAtMs: j.awarded_at_ms,
    };
  }

  // ── Reputation ────────────────────────────────────────────────────────────────────────────────

  async recordScamBlocked(
    agentId: string,
    jobId: string,
    key = `scam:${agentId}:${jobId}`,
  ): Promise<TxResult> {
    const tx = await this.call(
      this.ids.operator,
      this.ids.rep,
      'record_scam_blocked',
      { agent_id: agentId, job_id: jobId },
      // A report that creates the agent's entry must pay its storage. Attaching it every time is
      // simpler than checking first (which could race the job board creating the entry); the
      // contract refunds whatever it doesn't need.
      { deposit: await this.repEntryDeposit(), key },
    );
    return { txHash: tx.txHash, value: undefined };
  }

  async getReputation(agentId: string): Promise<Reputation> {
    const rep = await this.view<ReputationJson | null>(this.ids.rep, 'get_reputation', {
      agent_id: agentId,
    });
    return {
      jobs: rep?.jobs_completed ?? 0,
      ratingSum: rep?.rating_sum ?? 0,
      ratedJobs: rep?.rated_jobs ?? 0,
      disputes: rep?.disputes_lost ?? 0,
      scamsBlocked: rep?.scams_blocked ?? 0,
    };
  }

  private async repEntryDeposit(): Promise<bigint> {
    if (this.entryDeposit === null) {
      const cfg = await this.view<{ new_entry_deposit: string }>(this.ids.rep, 'get_config', {});
      this.entryDeposit = BigInt(cfg.new_entry_deposit);
    }
    return this.entryDeposit;
  }

  // ── Badges (NEP-245, soulbound) ───────────────────────────────────────────────────────────────

  async mintBadge(
    agentId: string,
    tokenId: string,
    memo: string | null,
  ): Promise<TxResult<boolean>> {
    const tx = await this.call(
      this.ids.operator,
      this.ids.badges,
      'mint_badge',
      { agent_id: agentId, token_id: tokenId, memo },
      { key: `badge:${agentId}:${tokenId}` },
    );
    return { txHash: tx.txHash, value: tx.value === true };
  }

  async badgesOf(agentId: string): Promise<BadgeType[]> {
    // One page of 100 covers it: an agent holds at most 64 badges, one of each type.
    const tokens = await this.view<BadgeJson[]>(this.ids.badges, 'mt_tokens_for_owner', {
      account_id: agentId,
      limit: 100,
    });
    return tokens.map((t) => ({
      tokenId: t.token_id,
      title: t.metadata.title,
      description: t.metadata.description,
    }));
  }

  // ── Market ────────────────────────────────────────────────────────────────────────────────────

  async listAgent(signer: string, tokenId: string, price: bigint): Promise<TxResult<Listing>> {
    const args = {
      token_id: tokenId,
      account_id: this.ids.market,
      msg: JSON.stringify({ price: price.toString() }),
    };
    let tx: SentTx;
    try {
      // The registry keeps the deposit for the approval's storage and refunds the rest.
      tx = await this.call(signer, this.ids.registry, 'nft_approve', args, {
        deposit: approvalDeposit(this.ids.market),
        gas: GAS_CROSS,
      });
    } catch (err) {
      // The market refused the listing after the registry stored the approval (the two are
      // separate receipts); revoke it so no approval outlives its listing, as in the simulator.
      if (err instanceof ChainError && err.code !== 'not_owner' && err.code !== 'not_found') {
        await this.revokeMarket(signer, tokenId).catch(() => undefined);
      }
      throw err;
    }
    return { txHash: tx.txHash, value: toListing(tx.value as ListingJson) };
  }

  private revokeMarket(signer: string, tokenId: string): Promise<SentTx> {
    return this.call(
      signer,
      this.ids.registry,
      'nft_revoke',
      { token_id: tokenId, account_id: this.ids.market },
      { deposit: ONE_YOCTO },
    );
  }

  async cancelListing(signer: string, tokenId: string): Promise<TxResult> {
    const tx = await this.call(
      signer,
      this.ids.market,
      'cancel_listing',
      { token_id: tokenId },
      { deposit: ONE_YOCTO },
    );
    // A seller whose token moved some other way has no approval left to revoke.
    if ((await this.nftOwner(tokenId)) === signer) await this.revokeMarket(signer, tokenId);
    return { txHash: tx.txHash, value: undefined };
  }

  async buyAgent(
    signer: string,
    tokenId: string,
    expectedPrice: bigint,
    key: string,
  ): Promise<TxResult<'bought' | 'refunded'>> {
    // A retried buy whose first call landed returns that result: sending again would only be
    // refunded by the market, and would report a buy that succeeded as refunded.
    const prior = await this.findByKey(key);
    if (prior) return { txHash: prior.hash, value: buyResult(prior.events, signer, tokenId) };
    const msg = JSON.stringify({ token_id: tokenId, expected_price: expectedPrice.toString() });
    const tx = await this.call(
      signer,
      this.ids.credits,
      'ft_transfer_call',
      { receiver_id: this.ids.market, amount: expectedPrice.toString(), msg },
      // The market refunds up front unless it has gas for the transfer and its own callback.
      { deposit: ONE_YOCTO, gas: GAS_MAX, key },
    );
    // `ft_transfer_call` resolves to the amount the market kept: zero means it refunded the buy.
    const kept = BigInt(String(tx.value ?? '0'));
    return { txHash: tx.txHash, value: kept === 0n ? 'refunded' : 'bought' };
  }

  async getListing(tokenId: string): Promise<Listing | null> {
    const l = await this.view<ListingJson | null>(this.ids.market, 'get_listing', {
      token_id: tokenId,
    });
    return l ? toListing(l) : null;
  }

  async listings(): Promise<Listing[]> {
    const out: Listing[] = [];
    // At most 500 listings, 100 a page.
    for (let from = 0; ; from += 100) {
      const page = await this.view<ListingJson[]>(this.ids.market, 'get_listings', {
        from_index: from,
        limit: 100,
      });
      out.push(...page.map(toListing));
      if (page.length < 100) return out;
    }
  }

  // ── Explorer ──────────────────────────────────────────────────────────────────────────────────

  /** Served from the tx log, or this process's in-memory index without one: there is no indexer to ask. */
  async txs(filter: TxFilter): Promise<ChainTxView[]> {
    if (this.opts.txLog) return this.opts.txLog.txs(filter);
    const out: ChainTxView[] = [];
    for (let i = this.index.length - 1; i >= 0 && out.length < filter.limit; i--) {
      const tx = this.index[i];
      if (!tx) continue;
      if (
        filter.account &&
        tx.signer !== filter.account &&
        tx.receiver !== filter.account &&
        // Also transactions whose events name the account (a refund or payout sent to it).
        !JSON.stringify(tx.events).includes(`"${filter.account}"`)
      )
        continue;
      if (filter.jobId && !touchesJob(tx, filter.jobId)) continue;
      out.push(toView(tx));
    }
    return out;
  }

  /** Requests, rate-limit refusals and failovers since this gateway started. */
  rpcStats(): RpcStats {
    const s = this.provider.stats;
    return { ...s, byUrl: { ...s.byUrl }, byMethod: { ...s.byMethod } };
  }

  /**
   * Served from the tx log when there is one. Without it the in-memory index only knows calls sent
   * since this process started, so a restarted engine could not reconcile an in-doubt call.
   */
  async findByKey(key: string): Promise<ChainTxView | null> {
    if (this.opts.txLog) return this.opts.txLog.findByKey(key);
    for (let i = this.index.length - 1; i >= 0; i--) {
      const tx = this.index[i];
      if (tx && tx.key === key && tx.outcome === 'success') return toView(tx);
    }
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/** A transaction's hash: base58 of the sha256 of its borsh encoding, as NEAR computes it. */
function signedHash(signed: SignedTransaction): string {
  return baseEncode(createHash('sha256').update(signed.transaction.encode()).digest());
}

const errorText = (err: unknown): string =>
  `${(err as { constructor?: { name?: string } })?.constructor?.name ?? ''} ${(err as { type?: string })?.type ?? ''} ${String(err)}`;

function isNonceError(err: unknown): boolean {
  return /InvalidNonce|nonce/i.test(errorText(err));
}

function isExpiredError(err: unknown): boolean {
  return /Expired/i.test(errorText(err));
}

function isFailure(status: ExecutionStatus): status is { Failure: unknown } {
  return typeof status === 'object' && 'Failure' in status;
}

function successValue(status: ExecutionStatus): unknown {
  if (typeof status !== 'object' || !('SuccessValue' in status) || !status.SuccessValue) {
    return undefined;
  }
  const text = Buffer.from(status.SuccessValue, 'base64').toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The snake_case code from a failure: the contract's panic message, or the protocol error's name. */
export function failureCode(failure: unknown): string {
  const text = JSON.stringify(failure);
  const panic = /Smart contract panicked: ((?:[^"\\]|\\.)*)/.exec(text)?.[1];
  if (panic !== undefined) {
    const message = JSON.parse(`"${panic}"`) as string;
    if (/^[a-z][a-z0-9_]*$/.test(message)) return message;
    return STANDARD_PANICS.find(([re]) => re.test(message))?.[1] ?? 'contract_panic';
  }
  if (text.includes('AccountAlreadyExists')) return 'account_exists';
  // Protocol errors are a nested enum; the innermost variant name says what went wrong.
  const names = [...text.matchAll(/"([A-Z][A-Za-z]+)"\s*:/g)].map((m) => m[1] ?? '');
  const name = names.at(-1) ?? 'Failure';
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** NEP-297 events from every receipt's logs; array payloads (NEP-141/171) become one event each. */
function parseEvents(out: TxOutcomeView): ContractEvent[] {
  const events: ContractEvent[] = [];
  for (const o of [out.transaction_outcome, ...out.receipts_outcome]) {
    for (const log of o.outcome.logs) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      try {
        const e = JSON.parse(log.slice('EVENT_JSON:'.length)) as ContractEvent;
        for (const data of Array.isArray(e.data) ? e.data : [e.data]) {
          events.push({ event: e.event, data });
        }
      } catch {
        // A log that only looks like an event is not one; skip it rather than fail the call.
      }
    }
  }
  return events;
}

function mintedToken(events: ContractEvent[]): string | null {
  const mint = events.find((e) => e.event === 'nft_mint')?.data as
    | { token_ids?: string[] }
    | undefined;
  return mint?.token_ids?.[0] ?? null;
}

/** The job board's ids are u64; anything that is not up to 15 digits (a safe JS integer) cannot name a job. */
function chainJobId(jobId: string): number {
  if (!/^\d{1,15}$/.test(jobId)) throw new ChainError('not_found', null);
  return Number(jobId);
}

function toOutcome(o: OutcomeJson, txHash: string): SpendOutcome {
  if (o.status === 'denied') {
    // A repeated key whose approval was denied (or cleared by a transfer). The game's outcome type
    // has no `denied`; the call is final, so it surfaces as a contract error with the reason.
    throw new ChainError(o.reason ?? 'denied_by_owner', txHash);
  }
  if (o.status === 'in_flight') {
    // A repeated key whose first transfer has not resolved yet: not final, so in doubt, not failed.
    throw new Error(`Spend ${o.request_id} is still in flight`);
  }
  return {
    status: o.status,
    // The game reads a request id as "this went to the owner for approval", so only pending
    // outcomes carry one, although the wallet numbers every request.
    requestId: o.status === 'pending' ? o.request_id : null,
    reason: (o.reason ?? null) as SpendReason | null,
    txHash,
  };
}

function toListing(l: ListingJson): Listing {
  return {
    tokenId: l.token_id,
    sellerId: l.seller_id,
    price: BigInt(l.price),
    approvalId: l.approval_id,
  };
}

function touchesJob(tx: IndexedTx, jobId: string): boolean {
  const args = tx.args as { job_id?: unknown } | null;
  if (args && String(args.job_id) === jobId) return true;
  return tx.events.some((e) => String((e.data as { job_id?: unknown } | null)?.job_id) === jobId);
}

function toView(tx: IndexedTx): ChainTxView {
  const { key: _key, result: _result, ...view } = tx;
  return view;
}

/** Player accounts the game makes (`p-<hex>.<root>`); every other signer under the root is ours. */
export function isPlayerAccount(accountId: string): boolean {
  return /^p-[0-9a-f]+\./.test(accountId);
}

const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
