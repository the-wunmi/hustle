import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEAR_AUTH_TESTNET, type NearAuth, NearAuthClient, NearAuthSimulator } from '@hustle/auth';
import {
  accessKeyPermission,
  type ChainGateway,
  type ChainSetup,
  checkRpcUrl,
  DEFAULT_TESTNET_FALLBACK_RPCS,
  DEFAULT_TESTNET_RPC_URL,
  type KeyPermission,
  localNodeConfig,
  localRpcUrl,
  NearChain,
  PacedRpcProvider,
  PgTxLog,
  readFunder,
  readTestnetTarget,
  SimChain,
  verifyChain,
  waitForNode,
} from '@hustle/chain';
import type { ModesView, Tier } from '@hustle/core';
import { type Db, players, settings } from '@hustle/db';
import {
  type Brain,
  DEFAULT_BRAINS,
  DEFAULT_ECONOMY,
  type EconomyConfig,
  TOOLS,
  type ToolSpec,
  VENDORS,
} from '@hustle/economy';
import {
  fetchPublicModels,
  type ModelInfo,
  type NearAiCloud,
  NearAiCloudClient,
  NearAiCloudSimulator,
  type ServicePrice,
} from '@hustle/nearai';
import { createSandbox, type Sandbox } from '@hustle/sandbox';
import { eq } from 'drizzle-orm';
import { ACHIEVEMENTS } from './achievements.ts';
import { scriptedResponse } from './brain/scripted.ts';
import { launchDurable, shutdownDurable } from './durable.ts';

/** Runs one mutation at a time: world ticks and player actions never interleave. */
export class SerialLane {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export interface WorldClock {
  tick: number;
  seed: string;
  /** The last day whose end-of-day run finished; a failed run is retried on the next tick. */
  closedDay?: number;
}

/** Everything the engine needs, built once at startup and passed first to every service. */
export interface Engine {
  db: Db;
  chain: ChainGateway;
  nearai: NearAiCloud;
  /** Scripted replies at real prices: house agents, and player agents once the live budget is spent. */
  recordedBrain: NearAiCloud;
  auth: NearAuth;
  /** Present when AUTH_MODE=mock: issues the id tokens the simulated login steps hand out. */
  authSim: NearAuthSimulator | null;
  /**
   * What a public key may do on a NEAR testnet account, read from testnet RPC whatever chain the
   * game itself runs on: wallet sign-in proves a testnet account, so it always asks testnet.
   */
  walletKeys: (accountId: string, publicKey: string) => Promise<KeyPermission>;
  /** True while workflows left by a previous process are still finishing. */
  recovering: boolean;
  /** Settles once they have (never rejects). */
  recovered: Promise<void>;
  /** Most new on-chain player accounts and agent mints per UTC day (Infinity: no cap). */
  /** Which of the game's NEAR accounts is below its reserve, if any (null: all fine). */
  reserveCheck: () => Promise<string | null>;
  cfg: EconomyConfig;
  brains: Record<Tier, Brain>;
  /** Tools agents can use, with fees read from the provider's price list at startup where it has one. */
  tools: readonly ToolSpec[];
  /** House players' ids: their agents run on the recorded brain, so they never use provider tools. */
  houseOwners: Set<string>;
  /** Where agents' code runs: the isolated sandbox service, or in-process in development; null: none. */
  sandbox: Sandbox | null;
  /** Read-only NEAR mainnet endpoints for the chain data tool (public data, never signed with). */
  mainnetRpcUrl: string;
  fastNearApiUrl: string;
  modes: ModesView;
  tickMs: number;
  /** Real milliseconds a tick has been taking (a moving average; `tickMs` until measured). */
  tickPaceMs: number;
  dayTicks: number;
  /** Ticks between re-reading every agent's balance from the chain (rationed on testnet). */
  balanceRefreshTicks: number;
  clock: WorldClock;
  secret: string;
  lane: SerialLane;
  /** Feed events and other pushes for the SSE stream. */
  bus: EventEmitter;
  /**
   * When each player last looked (game tick of their last calls poll). Calls are only raised for
   * players who are watching, so an absent owner's agent plays on its own.
   */
  presence: Map<string, number>;
  /**
   * Since when (tick) the call system has found nothing worth asking a watching owner about, per
   * agent: after a while the agent bids on its own again. Cleared when a call is raised.
   */
  noCallSince: Map<string, number>;
  log: (message: string, data?: Record<string, unknown>) => void;
  /** Whether keyless public reads (NEAR AI model list, 1Click dry quotes) are made; off in tests. */
  liveReads: boolean;
}

export interface EngineOptions {
  db: Db;
  env?: NodeJS.ProcessEnv;
  /** Tests pass a fixed secret so ids are stable. */
  secret?: string;
  /** Tests stand in for testnet's access-key lookup. */
  walletKeys?: Engine['walletKeys'];
  reserveCheck?: Engine['reserveCheck'];
  /** Tests pass their own sandbox (or null for none). */
  sandbox?: Sandbox | null;
}

/** Default real milliseconds per world tick. */
export const DEFAULT_TICK_MS = 2_000;
/** Default ticks per game day: six real minutes, long enough to play, short enough to see a day end. */
export const DEFAULT_DAY_TICKS = 180;
/** Least real milliseconds per tick on testnet (public RPC limits, ~1 s blocks). */
export const DEFAULT_TESTNET_TICK_MS = 5_000;

const CLOCK_KEY = 'world';
const BRAINS_KEY = 'brains';

export async function loadClock(db: Db): Promise<WorldClock> {
  const [row] = await db.select().from(settings).where(eq(settings.key, CLOCK_KEY));
  if (row) return row.value as WorldClock;
  const clock: WorldClock = { tick: 0, seed: randomBytes(8).toString('hex'), closedDay: 0 };
  await db.insert(settings).values({ key: CLOCK_KEY, value: clock }).onConflictDoNothing();
  return loadClock(db);
}

export async function saveClock(engine: Engine): Promise<void> {
  await engine.db
    .update(settings)
    .set({ value: engine.clock, updatedAt: new Date() })
    .where(eq(settings.key, CLOCK_KEY));
}

/**
 * Brain tiers from NEAR AI Cloud's model list rather than hard-coded ids: only TEE-attested models,
 * ranked by price; the cheapest is Budget, the dearest Premium, the median Standard.
 */
export function brainsFromModels(models: readonly ModelInfo[]): Record<Tier, Brain> {
  const attested = models
    .filter(
      (m) =>
        m.attestationSupported &&
        m.chat &&
        m.jsonOutput &&
        m.ready &&
        m.outputPerM > 0n &&
        // Variants with safety training removed are not offered as agent brains.
        !m.id.includes('abliterated'),
    )
    .sort((a, b) => (a.inputPerM + a.outputPerM < b.inputPerM + b.outputPerM ? -1 : 1));
  const pick = (m: ModelInfo | undefined, tier: Tier): Brain =>
    m
      ? { tier, model: m.id, inputPerM: m.inputPerM, outputPerM: m.outputPerM, attested: true }
      : DEFAULT_BRAINS[tier];
  return {
    budget: pick(attested[0], 'budget'),
    standard: pick(attested[Math.floor(attested.length / 2)], 'standard'),
    premium: pick(attested.at(-1), 'premium'),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required in live mode (see .env.example)`);
  return value;
}

export async function createEngine(opts: EngineOptions): Promise<Engine> {
  const env = opts.env ?? process.env;
  const db = opts.db;
  // The secret seals provider keys stored in the database, so it must not live there too.
  const secret = opts.secret ?? env.HUSTLE_SECRET;
  if (!secret)
    throw new Error('HUSTLE_SECRET is not set: run `pnpm setup` (it writes one into .env)');
  const clock = await loadClock(db);
  let tickMs = Number(env.TICK_MS ?? DEFAULT_TICK_MS);
  let dayTicks = Number(env.DAY_TICKS ?? DEFAULT_DAY_TICKS);
  const dayMs = dayTicks * tickMs;
  // Testnet whenever a testnet account is configured; otherwise the local node. `sim` (the Postgres
  // simulator of the same contracts) is for fast tests and for machines without the node.
  const chainModeEarly = env.CHAIN_MODE || (env.NEAR_TESTNET_ACCOUNT_ID ? 'testnet' : 'sandbox');
  // The deployed server plays the testnet world. A second engine on it (pnpm dev on a laptop, a local
  // smoke run) would fork that world and put its test players on the public lists.
  if (
    chainModeEarly === 'testnet' &&
    env.NODE_ENV !== 'production' &&
    env.HUSTLE_LIVE_WORLD !== '1'
  ) {
    throw new Error(
      'CHAIN_MODE=testnet is the live world, played by the deployed server only. Run locally with CHAIN_MODE=sandbox (or sim); set HUSTLE_LIVE_WORLD=1 only on the one server that plays testnet.',
    );
  }
  // On testnet every chain call is a public-RPC round trip and a block is about a second, so the
  // world ticks less often; the game day keeps its length (the wallets' on-chain day is set to it).
  if (chainModeEarly === 'testnet') {
    tickMs = Math.max(tickMs, Number(env.TESTNET_TICK_MS ?? DEFAULT_TESTNET_TICK_MS));
    dayTicks = Math.max(1, Math.round(dayMs / tickMs));
  }

  const chainMode = chainModeEarly;
  let chain: ChainGateway;
  if (chainMode === 'sim') {
    // Block time follows the game clock, so a wallet's daily cap resets at the end of a game day.
    chain = new SimChain(
      db,
      () => clock.tick * tickMs,
      'hustle.sim',
      () => clock.tick,
    );
  } else if (chainMode === 'sandbox') {
    chain = await localChain(db, env, () => clock.tick);
  } else if (chainMode === 'testnet') {
    chain = await testnetChain(db, env, () => clock.tick, chainSetup(dayMs, env));
  } else {
    throw new Error(
      `CHAIN_MODE=${chainMode} is not supported; use testnet, sandbox or sim (tests)`,
    );
  }

  // Live NEAR AI Cloud whenever there is a key (NEARAI_MODE=mock turns it off); NEARAI_MODE=live
  // without a key refuses to boot rather than quietly falling back.
  const inferenceMode: 'live' | 'mock' =
    env.NEARAI_MODE === 'live' || (env.NEARAI_MODE !== 'mock' && env.NEARAI_API_KEY)
      ? 'live'
      : 'mock';
  if (inferenceMode === 'live' && !env.NEARAI_API_KEY)
    throw new Error(
      'NEARAI_MODE=live needs NEARAI_API_KEY in .env (a NEAR AI Cloud key); or set NEARAI_MODE=mock',
    );
  // The recorded brain: scripted replies at the real per-token prices. House agents always use it,
  // and player agents fall back to it when today's live budget is spent.
  const recordedBrain: NearAiCloud = new NearAiCloudSimulator(secret, scriptedResponse);
  const nearai: NearAiCloud =
    inferenceMode === 'live'
      ? new NearAiCloudClient({
          baseUrl: env.NEARAI_BASE_URL ?? 'https://cloud-api.near.ai/v1',
          apiKey: required(env, 'NEARAI_API_KEY'),
          ...(env.NEARAI_SESSION_TOKEN ? { sessionToken: env.NEARAI_SESSION_TOKEN } : {}),
          ...(env.NEARAI_WORKSPACE_ID ? { workspaceId: env.NEARAI_WORKSPACE_ID } : {}),
        })
      : recordedBrain;

  // Live NEAR Auth by default (testnet's shared client); AUTH_MODE=mock is the labelled stand-in for
  // tests and for a machine that can't serve the web on the client's one allowed origin.
  const authMode: 'live' | 'mock' = env.AUTH_MODE === 'mock' ? 'mock' : 'live';
  const authSim = authMode === 'mock' ? new NearAuthSimulator(secret) : null;
  const auth: NearAuth =
    authSim ??
    new NearAuthClient(
      env.NEAR_AUTH_DOMAIN || NEAR_AUTH_TESTNET.domain,
      env.NEAR_AUTH_CLIENT_ID || NEAR_AUTH_TESTNET.clientId,
    );

  const [cached] = await db.select().from(settings).where(eq(settings.key, BRAINS_KEY));
  let brains: Record<Tier, Brain>;
  let brainPrices: ModesView['brainPrices'] = { source: 'snapshot', readAt: '2026-11-11' };
  try {
    // NEAR AI Cloud serves its model list without a key, so even mock mode prices brains from the live
    // list; the simulator's snapshot is only the fallback (and what tests use, offline).
    const models =
      inferenceMode === 'mock' && env.NODE_ENV !== 'test'
        ? await fetchPublicModels(env.NEARAI_BASE_URL ?? 'https://cloud-api.near.ai/v1')
        : await nearai.listModels();
    brains = brainsFromModels(models);
    if (inferenceMode === 'live' || env.NODE_ENV !== 'test') {
      brainPrices = { source: 'live', readAt: new Date().toISOString() };
    }
  } catch {
    brains = cached ? reviveBrains(cached.value) : DEFAULT_BRAINS;
  }
  const storable = JSON.parse(
    JSON.stringify(brains, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
  await db
    .insert(settings)
    .values({ key: BRAINS_KEY, value: storable })
    .onConflictDoUpdate({ target: settings.key, set: { value: storable } });

  // Tool fees from NEAR AI Cloud's price list (nano-USD per unit); the spec's fee if it can't be read.
  const prices =
    inferenceMode === 'live' ? await nearai.services().catch((): ServicePrice[] => []) : [];
  const tools = TOOLS.map((t) => {
    const live = prices.find((p) => p.service === t.service);
    return live ? { ...t, fee: (live.costNanoPerUnit + 999n) / 1000n } : t;
  });
  const houseOwners = new Set(
    (await db.select({ id: players.id }).from(players).where(eq(players.isHouse, true))).map(
      (p) => p.id,
    ),
  );

  const engine: Engine = {
    db,
    chain,
    nearai,
    recordedBrain,
    auth,
    authSim,
    walletKeys: opts.walletKeys ?? testnetKeyLookup(env),
    recovering: false,
    recovered: Promise.resolve(),
    reserveCheck:
      opts.reserveCheck ??
      (() =>
        (chain as { reserveShortfall?: () => Promise<string | null> }).reserveShortfall?.() ??
        Promise.resolve(null)),
    cfg: DEFAULT_ECONOMY,
    brains,
    tools,
    houseOwners,
    sandbox: opts.sandbox !== undefined ? opts.sandbox : createSandbox(env),
    mainnetRpcUrl: env.NEAR_MAINNET_RPC_URL || 'https://rpc.mainnet.fastnear.com',
    fastNearApiUrl: env.FASTNEAR_API_URL || 'https://api.fastnear.com',
    modes: {
      chain: chainMode,
      inference: inferenceMode,
      auth: authMode,
      money: 'credits',
      brainPrices,
    },
    tickMs,
    tickPaceMs: tickMs,
    dayTicks,
    balanceRefreshTicks: Number(
      env.BALANCE_REFRESH_TICKS ?? (chainModeEarly === 'testnet' ? 6 : 1),
    ),
    clock,
    secret,
    lane: new SerialLane(),
    liveReads: env.NODE_ENV !== 'test',
    bus: new EventEmitter().setMaxListeners(1000),
    presence: new Map(),
    noCallSince: new Map(),
    log: (message, data) => {
      if (env.NODE_ENV === 'test') return;
      console.log(redactUrls(JSON.stringify({ at: new Date().toISOString(), message, ...data })));
    },
  };
  await chain.ensureSetup(chainSetup(dayMs, env));
  // DBOS last: launching resumes whatever workflows the last process left unfinished (they run
  // against this engine) and waits for them, so the world never ticks with recovered work behind it.
  await launchDurable(engine, env);
  return engine;
}

/** Stops DBOS; the database pool belongs to the caller. */
export async function closeEngine(): Promise<void> {
  await shutdownDurable();
}

/** What the chain must hold for this game; `pnpm deploy:testnet` deploys the same. */
export function chainSetup(dayMs: number, env: NodeJS.ProcessEnv = process.env): ChainSetup {
  return {
    // WALLET_CODE_GLOBAL=off skips the one-off burn (10x the wallet code's storage, about 17 NEAR)
    // and keeps each mint at about 2 NEAR.
    globalWalletCode: env.WALLET_CODE_GLOBAL !== 'off',
    feeBps: DEFAULT_ECONOMY.feeBps,
    marketFeeBps: 250,
    dayMs,
    vendorHandles: VENDORS.map((v) => v.handle),
    // Achievements are NEP-245 badges held by the agent's own account.
    badges: ACHIEVEMENTS.map((a) => ({ tokenId: a.id, title: a.name, description: a.description })),
  };
}

function reviveBrains(value: unknown): Record<Tier, Brain> {
  const raw = value as Record<Tier, Brain & { inputPerM: string; outputPerM: string }>;
  const out = {} as Record<Tier, Brain>;
  for (const tier of ['budget', 'standard', 'premium'] as const) {
    out[tier] = {
      ...raw[tier],
      inputPerM: BigInt(raw[tier].inputPerM),
      outputPerM: BigInt(raw[tier].outputPerM),
    };
  }
  return out;
}

// ── Clock helpers ───────────────────────────────────────────────────────────────────────────────

/**
 * The tools this agent will really use: every tool needs a live brain, which the game's house agents
 * never have. Bid floors, the per-job cap and quality price only these.
 */
export const toolsFor = (engine: Engine, agent: { ownerId: string }): readonly ToolSpec[] =>
  engine.nearai.mode === 'live' && !engine.houseOwners.has(agent.ownerId) ? engine.tools : [];

export const dayOf = (engine: Engine, tick = engine.clock.tick): number =>
  Math.floor(tick / engine.dayTicks) + 1;
export const hourOf = (engine: Engine): number =>
  Math.floor(((engine.clock.tick % engine.dayTicks) * 24) / engine.dayTicks);

export const vendorAccount = (engine: Engine, handle: string): string =>
  `${handle}.${engine.chain.ids.vendors}`;

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CHAIN_KEY = 'chain';
/** How long the API waits for the local node at startup (it may still be booting under `pnpm dev`). */
const NODE_WAIT_MS = 90_000;

/**
 * The local NEAR node, its contracts deployed by `ensureSetup`. The database remembers which chain
 * it belongs to: a node whose state was wiped can't be matched to the game's records, so startup
 * stops with an instruction instead of mixing two worlds.
 */
async function localChain(
  db: Db,
  env: NodeJS.ProcessEnv,
  tick: () => number,
): Promise<ChainGateway> {
  const nodeCfg = localNodeConfig(env, REPO_ROOT);
  const rpcUrl = env.NEAR_RPC_URL || localRpcUrl(nodeCfg);
  const { genesisHash } = await waitForNode(rpcUrl, NODE_WAIT_MS);
  await bindChain(
    db,
    { genesisHash, rpcUrl },
    'The local NEAR node is not the one this database was played on (its state was reset). Run `pnpm reset` to start a fresh world.',
  );
  return new NearChain({
    rpcUrl,
    root: 'hustle.test.near',
    ...readFunder(nodeCfg),
    wasmDir: join(REPO_ROOT, 'contracts', 'out'),
    txLog: new PgTxLog(db, tick),
  });
}

/**
 * The database remembers which chain (and, on testnet, which root account) it was played on, and
 * refuses another one: its accounts, agents and jobs would not exist there.
 */
async function bindChain(
  db: Db,
  chain: { genesisHash: string; rpcUrl: string; root?: string },
  mismatch: string,
): Promise<void> {
  const [row] = await db.select().from(settings).where(eq(settings.key, CHAIN_KEY));
  const known = row?.value as { genesisHash?: string; root?: string } | undefined;
  if (known?.genesisHash && known.genesisHash !== chain.genesisHash) throw new Error(mismatch);
  if (known?.root && chain.root && known.root !== chain.root) throw new Error(mismatch);
  if (!known?.genesisHash) {
    await db.insert(settings).values({ key: CHAIN_KEY, value: chain }).onConflictDoNothing();
  }
}

/**
 * NEAR testnet, under the account `pnpm deploy:testnet` deployed to (`NEAR_TESTNET_ACCOUNT_ID`). The
 * same guards as the deploy refuse mainnet. Boot never deploys on testnet: setup costs real testnet
 * NEAR, so it runs only through the deploy command, which estimates the cost and checks the balance.
 */
async function testnetChain(
  db: Db,
  env: NodeJS.ProcessEnv,
  tick: () => number,
  setup: ChainSetup,
): Promise<ChainGateway> {
  const target = readTestnetTarget(env, { dryRunLocal: false });
  const { genesisHash } = await verifyChain(target);
  await bindChain(
    db,
    { genesisHash, rpcUrl: target.rpcUrl, root: target.accountId },
    `This database was played on another chain or root account than ${target.accountId} on testnet. Run \`pnpm reset\` to start a fresh world.`,
  );
  // Public testnet RPCs rate-limit; requests are paced, and others take over while one refuses.
  const fallbacks = (env.NEAR_RPC_FALLBACK_URLS ?? DEFAULT_TESTNET_FALLBACK_RPCS.join(','))
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u && u !== target.rpcUrl);
  for (const url of fallbacks) checkRpcUrl(url, { dryRunLocal: false });
  const chain = new NearChain({
    rpcUrl: target.rpcUrl,
    fallbackRpcUrls: fallbacks,
    maxRequestsPerSecond: Number(env.NEAR_RPC_MAX_RPS ?? 8),
    root: target.accountId,
    funderId: target.accountId,
    funderKey: target.key.reveal(),
    network: 'testnet',
    wasmDir: join(REPO_ROOT, 'contracts', 'out'),
    txLog: new PgTxLog(db, tick),
    // NEAR kept back for running the world: below it, no new accounts or agents.
    reserve: {
      root: nearAmount(env.NEAR_RESERVE_ROOT ?? '2'),
      operator: nearAmount(env.NEAR_RESERVE_OPERATOR ?? '2'),
    },
  });
  const missing = await chain.planSetup(setup);
  if (missing.length > 0) {
    throw new Error(
      `The contracts under ${target.accountId} are not fully set up (${missing.length} steps left, first: ${missing[0]?.label}). Run \`pnpm deploy:testnet\` first.`,
    );
  }
  return chain;
}

/** Access-key lookups against NEAR testnet (the configured testnet RPC, else the public one). */
function testnetKeyLookup(env: NodeJS.ProcessEnv): Engine['walletKeys'] {
  const mode = env.CHAIN_MODE || (env.NEAR_TESTNET_ACCOUNT_ID ? 'testnet' : 'sandbox');
  const primary =
    mode === 'testnet' && env.NEAR_RPC_URL ? env.NEAR_RPC_URL : DEFAULT_TESTNET_RPC_URL;
  const fallbacks = env.NEAR_RPC_FALLBACK_URLS
    ? env.NEAR_RPC_FALLBACK_URLS.split(',')
        .map((u) => u.trim())
        .filter(Boolean)
    : DEFAULT_TESTNET_FALLBACK_RPCS;
  let provider: PacedRpcProvider | undefined;
  return (accountId, publicKey) => {
    provider ??= new PacedRpcProvider({ urls: [primary, ...fallbacks], maxPerSecond: 4 });
    return accessKeyPermission(provider, accountId, publicKey);
  };
}

/** "2" or "0.1" NEAR in yoctoNEAR. */
function nearAmount(value: string): bigint {
  const [whole = '0', frac = ''] = value.trim().split('.');
  return BigInt(whole) * 10n ** 24n + BigInt((frac + '0'.repeat(24)).slice(0, 24));
}

/** Drops query strings from URLs in a log line: a keyed RPC URL carries its key in the query. */
export function redactUrls(line: string): string {
  return line.replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']*/g, '$1?[redacted]');
}
