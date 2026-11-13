import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const money = (name: string) => bigint(name, { mode: 'bigint' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** Small single-value state: the server secret, the world clock, the brain mapping. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Players and sessions ────────────────────────────────────────────────────────────────────────

export const players = pgTable(
  'players',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email'),
    loginMethod: text('login_method').$type<'email' | 'passkey' | 'wallet' | 'house'>().notNull(),
    /** Stable id from the login provider (NEAR Auth `sub`, or `wallet:<account>` for a NEAR wallet). */
    authSubject: text('auth_subject').notNull(),
    /** The NEAR account created for the player behind the scenes. */
    accountId: text('account_id').notNull(),
    /** The player's own testnet account, when they signed in with a NEAR wallet (their identity). */
    walletAccountId: text('wallet_account_id'),
    /**
     * Whether `accountId` exists on chain with its starter credits. A new player's account is made
     * on their first on-chain action (adopt, buy, post a task, back an agent, claim credits), so sign-ups who never
     * play cost no NEAR. Players from before this column were made at sign-in, hence the default.
     */
    accountReady: boolean('account_ready').notNull().default(true),
    isHouse: boolean('is_house').notNull().default(false),
    /** Last game day the free sandbox allowance was claimed. */
    allowanceDay: integer('allowance_day'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('players_account_uq').on(t.accountId),
    uniqueIndex('players_subject_uq').on(t.authSubject),
  ],
);

/**
 * One-time challenges for NEAR wallet sign-in (NEP-413): the wallet signs the nonce, bound to the
 * browser that asked for it by a cookie whose hash is stored here. Used once, within minutes.
 */
export const walletChallenges = pgTable('wallet_challenges', {
  /** Base64 of the 32-byte nonce. */
  nonce: text('nonce').primaryKey(),
  bindingHash: text('binding_hash').notNull(),
  message: text('message').notNull(),
  recipient: text('recipient').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * Global per-day counters for actions that cost the game NEAR (new player accounts, agent mints), so
 * a flood of free sign-ins can't drain the operator. Keyed by UTC day and kind.
 */
export const dailyCaps = pgTable(
  'daily_caps',
  {
    day: text('day').notNull(),
    kind: text('kind').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.kind] })],
);

export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  playerId: uuid('player_id')
    .notNull()
    .references(() => players.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

// ── Agents ──────────────────────────────────────────────────────────────────────────────────────

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The agent's NEAR account, which is also its NFT token id. Null until the mint lands. */
    accountId: text('account_id'),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => players.id),
    /** Its owner's price for one task, for anyone who hires it directly (null: not offered). */
    hireRate: money('hire_rate'),
    /** The player who minted it: earns a royalty on every resale through Hustle. */
    creatorId: uuid('creator_id').references(() => players.id),
    name: text('name').notNull(),
    look: jsonb('look').notNull(),
    traits: jsonb('traits').$type<string[]>().notNull(),
    specialty: text('specialty').notNull(),
    skills: jsonb('skills').notNull(),
    strategy: jsonb('strategy').notNull(),
    /** Mirror of the wallet contract's rulebook, written only after the chain accepted it. */
    rulebook: jsonb('rulebook').notNull(),
    frozen: boolean('frozen').notNull().default(false),
    /**
     * Cache of the agent's credit balance on chain, refreshed after every money movement. The chain
     * is the source of truth; this exists so the world loop can rank agents without a call each.
     */
    balance: money('balance').notNull().default(sql`0`),
    repXp: integer('rep_xp').notNull().default(0),
    ratingSum: integer('rating_sum').notNull().default(0),
    ratingCount: integer('rating_count').notNull().default(0),
    disputes: integer('disputes').notNull().default(0),
    scamsBlocked: integer('scams_blocked').notNull().default(0),
    practiceDone: integer('practice_done').notNull().default(0),
    dormantSinceDay: integer('dormant_since_day'),
    /** The job the agent is working on, if any. */
    busyJobId: uuid('busy_job_id'),
    /** Per-agent NEAR AI Cloud API key id, and the key sealed with the server secret (AES-GCM). */
    inferenceKeyId: text('inference_key_id'),
    inferenceKeySealed: text('inference_key_sealed'),
    achievements: jsonb('achievements').$type<Record<string, string>>().notNull().default({}),
    lastPaidTick: integer('last_paid_tick'),
    /** Jobs in a row paid at 4★ or more; a refund or a scam loss resets it. */
    streak: integer('streak').notNull().default(0),
    bestStreak: integer('best_streak').notNull().default(0),
    /** No new call to the owner before this tick, nor a contract offer before the second. */
    nextCallTick: integer('next_call_tick').notNull().default(0),
    nextContractTick: integer('next_contract_tick').notNull().default(0),
    /** Bought, and its new owner hasn't confirmed its rulebook yet: the wallet stays frozen. */
    awaitingConfirm: boolean('awaiting_confirm').notNull().default(false),
    /**
     * Off every public list (browse, leaderboard, market, helpers), set by an operator for a test
     * agent. Its history, ledger and NFT stay as they are, and its page still opens from links.
     */
    hidden: boolean('hidden').notNull().default(false),
    /**
     * The owner's instructions, read by the agent on every call. Private to the owner; the public
     * sees only its fingerprint and when it changed. It goes with the agent when it is sold.
     */
    playbook: text('playbook').notNull().default(''),
    playbookUpdatedAt: timestamp('playbook_updated_at', { withTimezone: true }),
    /** How many memories it keeps (agent_memories rows), so costs and pages need no count query. */
    memoryCount: integer('memory_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('agents_account_uq').on(t.accountId), index('agents_owner_ix').on(t.ownerId)],
);

/**
 * What an agent remembers from a finished job: the facts, and the lesson it wrote (paid for from
 * its wallet). Recalled into later jobs by client and category; goes with the agent when sold.
 */
export const agentMemories = pgTable(
  'agent_memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    jobId: uuid('job_id').notNull(),
    category: text('category').notNull(),
    client: text('client').notNull(),
    /** paid | refunded */
    outcome: text('outcome').notNull(),
    rating: integer('rating'),
    price: money('price').notNull(),
    /** The agent's own lesson; null until it reflects, or when the reflection failed or was skipped. */
    lesson: text('lesson'),
    /** When the reflection was claimed (null: still queued). Claimed once, so never re-billed. */
    reflectedAt: timestamp('reflected_at', { withTimezone: true }),
    tick: integer('tick').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('agent_memories_job_uq').on(t.agentId, t.jobId),
    index('agent_memories_agent_ix').on(t.agentId, t.tick),
    index('agent_memories_queue_ix').on(t.tick).where(sql`${t.reflectedAt} is null`),
  ],
);

// ── Jobs and bids ───────────────────────────────────────────────────────────────────────────────

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The job's id on the job board contract; null for practice jobs, which never touch escrow. */
    chainJobId: text('chain_job_id'),
    source: text('source').notNull(),
    category: text('category').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    budget: money('budget').notNull(),
    minLevel: integer('min_level').notNull().default(1),
    clientPlayerId: uuid('client_player_id').references(() => players.id),
    clientName: text('client_name').notNull(),
    clientStyle: text('client_style').notNull(),
    sponsorPoolId: text('sponsor_pool_id'),
    /** Hidden truth for scam jobs. Agents never read these columns. */
    scam: boolean('scam').notNull().default(false),
    scamVendor: text('scam_vendor'),
    scamAmount: money('scam_amount'),
    answerKeywords: jsonb('answer_keywords').$type<string[]>(),
    /** Practice jobs are offered to one agent only. */
    reservedForAgentId: uuid('reserved_for_agent_id'),
    autoAward: boolean('auto_award').notNull().default(true),
    status: text('status').notNull(),
    stage: text('stage'),
    /** The world tick at or after which the next stage may run. */
    nextAt: integer('next_at').notNull().default(0),
    openedTick: integer('opened_tick').notNull(),
    closesTick: integer('closes_tick'),
    reviewUntilTick: integer('review_until_tick'),
    awardedAgentId: uuid('awarded_agent_id'),
    price: money('price'),
    plan: jsonb('plan'),
    deliverable: text('deliverable'),
    workHash: text('work_hash'),
    embeddedInstructions: text('embedded_instructions'),
    /** What the client says done looks like; agents read it with the brief. */
    criteria: text('criteria'),
    quality: doublePrecision('quality'),
    rating: integer('rating'),
    helperAgentId: uuid('helper_agent_id'),
    helperPrice: money('helper_price'),
    helperTask: text('helper_task'),
    marketRef: text('market_ref'),
    /** The specialist whose data the job needs, if any; and how the agent's work went without or with it. */
    specialist: text('specialist'),
    /** Level-1 agents only, no outside offers: a new agent's way in. */
    rookie: boolean('rookie').notNull().default(false),
    /** Contract tier 1–3 for a contract (picky client, bond held by the treasury). */
    contractTier: integer('contract_tier'),
    bond: money('bond'),
    /** What the winning outside offer asked, when someone from outside Hustle won the job. */
    outsidePrice: money('outside_price'),
    /** The client disputed and the arbiter ruled (paid or refunded). */
    disputed: boolean('disputed').notNull().default(false),
    /** The working agent's one question to the client, the client's answer, and when it asked. */
    question: text('question'),
    answer: text('answer'),
    askedTick: integer('asked_tick'),
    /** Whether the working agent may hire another agent for part of it (the client's choice). */
    subcontracting: boolean('subcontracting').notNull().default(true),
    /** A subcontract: the job it is part of, and the hiring agent's loop step that asked for it. */
    parentJobId: uuid('parent_job_id'),
    parentStep: integer('parent_step'),
    /**
     * The arbiter's ruling on a dispute, stored before the chain is told, so a restart resolves it the
     * same way: who ruled (`model` read the brief and the work; `rule` is the quality-score rule),
     * whether it refunds, and why.
     */
    ruling: jsonb('ruling').$type<{
      by: 'model' | 'rule';
      refund: boolean;
      reason: string;
      model?: string;
      verified?: boolean;
      callHash?: string;
    }>(),
    createdDay: integer('created_day').notNull(),
    createdAt: createdAt(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('jobs_parent_step_uq').on(t.parentJobId, t.parentStep),
    index('jobs_status_ix').on(t.status),
    index('jobs_agent_ix').on(t.awardedAgentId),
    uniqueIndex('jobs_chain_uq').on(t.chainJobId),
  ],
);

export const bids = pgTable(
  'bids',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    price: money('price').notNull(),
    pitch: text('pitch').notNull(),
    status: text('status').$type<'open' | 'won' | 'lost' | 'withdrawn'>().notNull(),
    createdTick: integer('created_tick').notNull(),
    /** How the client scored the bid when the auction closed, 0–100 (before its small noise). */
    score: integer('score'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('bids_job_agent_uq').on(t.jobId, t.agentId),
    index('bids_agent_ix').on(t.agentId),
  ],
);

// ── Agent sales on the marketplace ───────────────────────────────────────────────────────────────

export const agentSales = pgTable(
  'agent_sales',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => players.id),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => players.id),
    price: money('price').notNull(),
    fee: money('fee').notNull(),
    /** The creator's royalty paid from the seller's proceeds (0 when the seller is the creator). */
    royalty: money('royalty').notNull().default(sql`0`),
    day: integer('day').notNull(),
    /** The buy's request id, so a retried purchase is recorded once. */
    requestId: text('request_id').notNull(),
    txHash: text('tx_hash'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('agent_sales_request_uq').on(t.requestId)],
);

// ── Calls: decisions an agent brings its owner ─────────────────────────────

export const calls = pgTable(
  'calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id),
    kind: text('kind').$type<'pitch' | 'vendor' | 'contract'>().notNull(),
    jobId: uuid('job_id'),
    status: text('status').$type<'open' | 'answered' | 'expired'>().notNull(),
    /** What the card shows and what answering needs: options, stakes, tells, default. */
    card: jsonb('card').notNull(),
    choice: text('choice'),
    /** What happened, once known: filled when the call resolves and again when its result lands. */
    outcome: jsonb('outcome'),
    openedTick: integer('opened_tick').notNull(),
    expiresTick: integer('expires_tick').notNull(),
    resolvedTick: integer('resolved_tick'),
    createdAt: createdAt(),
  },
  (t) => [
    index('calls_player_ix').on(t.playerId, t.openedTick),
    index('calls_job_ix').on(t.jobId),
    // One open call per agent.
    uniqueIndex('calls_one_open_uq').on(t.agentId).where(sql`${t.status} = 'open'`),
  ],
);

// ── Money ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Files a job works on: what the client attached, what the agent's tools fetched, and what the agent
 * wrote.
 * Text only (CSV, JSON, Markdown), size-capped; the sandbox reads them from `/work`.
 */
export const jobFiles = pgTable(
  'job_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    name: text('name').notNull(),
    content: text('content').notNull(),
    sha256: text('sha256').notNull(),
    /** client | tool:<id> | agent */
    source: text('source').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('job_files_name_uq').on(t.jobId, t.name)],
);

/**
 * Each sandbox run an agent made for a job: its code, the hashes of the files it read and what it
 * printed. Anyone who may see the deliverable can re-run it in a browser and compare.
 */
export const sandboxRuns = pgTable(
  'sandbox_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    round: integer('round').notNull(),
    code: text('code').notNull(),
    /** name → sha256 of each input file. */
    inputs: jsonb('inputs').$type<Record<string, string>>().notNull(),
    stdout: text('stdout').notNull(),
    stderr: text('stderr').notNull(),
    error: text('error'),
    runMs: integer('run_ms').notNull(),
    stdoutHash: text('stdout_hash').notNull(),
    cost: money('cost').notNull(),
    tick: integer('tick').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sandbox_runs_round_uq').on(t.jobId, t.agentId, t.round)],
);

/**
 * The agent loop's record of a job: each turn's thought, the action it chose and what came back,
 * with what the turn cost. The client and the agent's owner see it all; others see the shape.
 */
export const jobSteps = pgTable(
  'job_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    n: integer('n').notNull(),
    /** python | search | chain | fetch | hire | ask | write | pay | deliver | none */
    action: text('action').notNull(),
    /** The action's header (a file name, a payee and amount), shown with it. */
    args: text('args').notNull().default(''),
    thought: text('thought').notNull().default(''),
    input: text('input').notNull().default(''),
    observation: text('observation').notNull().default(''),
    /**
     * URLs the search engine itself returned for a search step (never the model's notes): the only
     * step output a later fetch may take a URL from.
     */
    sources: jsonb('sources').$type<string[]>(),
    ok: boolean('ok').notNull().default(true),
    cost: money('cost').notNull().default(sql`0`),
    tick: integer('tick').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('job_steps_n_uq').on(t.jobId, t.agentId, t.n)],
);

/**
 * Challenges an agent took: per challenge, fresh attempts and how many it solved, beside the same
 * model plain on the same instances. Each attempt's job keeps the evidence.
 */
export const agentCredentials = pgTable(
  'agent_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    challengeId: text('challenge_id').notNull(),
    attempts: integer('attempts').notNull(),
    solved: integer('solved').notNull(),
    plainAttempts: integer('plain_attempts').notNull(),
    plainSolved: integer('plain_solved').notNull(),
    lastJobId: uuid('last_job_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('agent_challenges_uq').on(t.agentId, t.challengeId)],
);

/** Every NEAR AI Cloud call an agent made, with its metered cost and verification result. */
export const inferenceCalls = pgTable(
  'inference_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    jobId: uuid('job_id'),
    purpose: text('purpose').notNull(),
    model: text('model').notNull(),
    tier: text('tier').notNull(),
    status: text('status').$type<'started' | 'done' | 'in_doubt'>().notNull(),
    /** Game tick of the call, for timelines in game time. */
    tick: integer('tick'),
    inferenceId: text('inference_id'),
    chatId: text('chat_id'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    /** Of the completion tokens, those the model spent reasoning (billed as output). */
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    /** `live`: NEAR AI Cloud answered; `recorded`: the recorded brain (house agents, budget spent). */
    source: text('source').$type<'live' | 'recorded'>().notNull().default('recorded'),
    costNano: money('cost_nano'),
    cost: money('cost'),
    requestHash: text('request_hash'),
    responseHash: text('response_hash'),
    verification: jsonb('verification'),
    /** The parsed, schema-checked output, so a retried step reuses it instead of paying twice. */
    output: jsonb('output'),
    spendKey: text('spend_key'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('inference_key_uq').on(t.key),
    index('inference_job_ix').on(t.jobId),
    // Day ends and the proof page read an agent's calls.
    index('inference_agent_ix').on(t.agentId, t.tick),
  ],
);

/**
 * The org's live NEAR AI spend per UTC day, against `NEARAI_DAILY_BUDGET_USD`. A call reserves its
 * worst-case cost before it is made and settles to the exact billed cost after, so concurrent calls
 * can't together pass the budget. A new UTC day is a new row, which is the midnight reset.
 */
export const nearaiBudget = pgTable('nearai_budget', {
  day: text('day').primaryKey(),
  spentNano: money('spent_nano').notNull().default(sql`0`),
  reservedNano: money('reserved_nano').notNull().default(sql`0`),
  calls: integer('calls').notNull().default(0),
  /** A call was turned away for lack of budget today: player agents are on the recorded brain. */
  exhausted: boolean('exhausted').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Every spend request sent to an agent wallet, and what the wallet said. */
export const spends = pgTable(
  'spends',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The idempotency key sent to the wallet contract. */
    key: text('key').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    jobId: uuid('job_id'),
    kind: text('kind').notNull(),
    receiver: text('receiver').notNull(),
    amount: money('amount').notNull(),
    status: text('status').notNull(),
    reason: text('reason'),
    /** The wallet's approval request id, when the spend was held for the owner. */
    requestId: integer('request_id'),
    memo: text('memo').notNull(),
    receipt: text('receipt'),
    txHash: text('tx_hash'),
    /** Game day and tick the request was made, for day reports and timelines. */
    day: integer('day').notNull().default(0),
    tick: integer('tick'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('spends_key_uq').on(t.key), index('spends_agent_ix').on(t.agentId)],
);

/**
 * Append-only record of money that moved, per agent and player, for reports and leaderboards.
 * Entries are never edited; a correction is a reversing entry. `ref` makes each entry happen once.
 */
export const ledger = pgTable(
  'ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ref: text('ref').notNull(),
    day: integer('day').notNull(),
    agentId: uuid('agent_id'),
    playerId: uuid('player_id'),
    jobId: uuid('job_id'),
    kind: text('kind').notNull(),
    /** Signed: positive is money in. */
    amount: money('amount').notNull(),
    /** True when the job's client is the agent's own owner (excluded from the ranked profit). */
    related: boolean('related').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ledger_ref_uq').on(t.ref),
    index('ledger_agent_day_ix').on(t.agentId, t.day),
  ],
);

export const backings = pgTable('backings', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id),
  backerId: uuid('backer_id')
    .notNull()
    .references(() => players.id),
  amount: money('amount').notNull(),
  day: integer('day').notNull(),
  createdAt: createdAt(),
});

export const sponsorPools = pgTable('sponsor_pools', {
  id: text('id').primaryKey(),
  remaining: money('remaining').notNull(),
});

// ── Feed and reports ────────────────────────────────────────────────────────────────────────────

export const feed = pgTable(
  'feed',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    id: uuid('id').notNull().defaultRandom(),
    day: integer('day').notNull(),
    tick: integer('tick').notNull(),
    kind: text('kind').notNull(),
    tone: text('tone').notNull(),
    text: text('text').notNull(),
    agentId: uuid('agent_id'),
    jobId: uuid('job_id'),
    /** For owner-scoped events: the only player who sees it. */
    playerId: uuid('player_id'),
    amount: money('amount'),
    scope: text('scope').$type<'public' | 'owner'>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('feed_agent_ix').on(t.agentId, t.seq), index('feed_job_ix').on(t.jobId)],
);

export const dayReports = pgTable(
  'day_reports',
  {
    day: integer('day').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    data: jsonb('data').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.day, t.agentId] })],
);

/** Login challenges for the NEAR Auth simulator (email codes). */
export const authChallenges = pgTable('auth_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: createdAt(),
});

// ── The chain simulator's state (CHAIN_MODE=sim) ───────────────────────────────────────────────

/** Mirrors the contracts' storage so the simulator behaves like the chain; see packages/chain. */
export const simAccounts = pgTable('sim_accounts', {
  accountId: text('account_id').primaryKey(),
  kind: text('kind').notNull(),
  createdAt: createdAt(),
});

export const simFt = pgTable('sim_ft', {
  accountId: text('account_id').primaryKey(),
  balance: money('balance').notNull(),
});

export const simNft = pgTable('sim_nft', {
  tokenId: text('token_id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  metadata: jsonb('metadata').notNull(),
  rotationSeq: integer('rotation_seq').notNull().default(0),
  /** NEP-178 approvals: approved account id -> approval id. Cleared by every transfer. */
  approvals: jsonb('approvals').$type<Record<string, number>>().notNull().default({}),
  /** The id the next approval of this token gets; never reused, as the registry's counter. */
  nextApprovalId: integer('next_approval_id').notNull().default(1),
  mintedAt: createdAt(),
});

/** The market contract's listings, one per token. */
export const simListings = pgTable('sim_listings', {
  tokenId: text('token_id').primaryKey(),
  sellerId: text('seller_id').notNull(),
  price: money('price').notNull(),
  approvalId: integer('approval_id').notNull(),
});

export const simWallets = pgTable('sim_wallets', {
  accountId: text('account_id').primaryKey(),
  state: jsonb('state').notNull(),
});

export const simJobs = pgTable(
  'sim_jobs',
  {
    jobId: integer('job_id').primaryKey(),
    jobKey: text('job_key').notNull(),
    state: jsonb('state').notNull(),
  },
  (t) => [uniqueIndex('sim_jobs_key_uq').on(t.jobKey)],
);

export const simReputation = pgTable('sim_reputation', {
  agentId: text('agent_id').primaryKey(),
  state: jsonb('state').notNull(),
});

/** The simulator's transaction log: what an explorer would show. */
export const simTxs = pgTable(
  'sim_txs',
  {
    block: bigserial('block', { mode: 'number' }).primaryKey(),
    hash: text('hash').notNull(),
    signer: text('signer').notNull(),
    receiver: text('receiver').notNull(),
    method: text('method').notNull(),
    args: jsonb('args').notNull(),
    /** `pending`: a keyed transaction signed and noted before broadcast, not yet known to have landed. */
    outcome: text('outcome').$type<'success' | 'failure' | 'pending'>().notNull(),
    result: jsonb('result'),
    events: jsonb('events').notNull(),
    error: text('error'),
    /** Idempotency key of the call that produced it, for reconciliation. */
    key: text('key'),
    /** A pending transaction's signed bytes (base64), so the same transaction can be sent again. */
    signed: text('signed'),
    /** Block time: the game clock for the simulator, the real block time on a NEAR node. */
    timestampMs: bigint('timestamp_ms', { mode: 'number' }).notNull(),
    /** The block height on a real NEAR node (null for the simulator, whose `block` is its own count). */
    chainBlock: bigint('chain_block', { mode: 'number' }),
    /** The game tick when the transaction was sent, so receipts can be shown in game time. */
    tick: integer('tick'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sim_txs_hash_uq').on(t.hash),
    index('sim_txs_key_ix').on(t.key),
    index('sim_txs_args_job_ix').using('gin', sql`${t.args} jsonb_path_ops`),
  ],
);
