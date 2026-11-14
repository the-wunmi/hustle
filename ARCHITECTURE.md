# Hustle architecture

How Hustle works under the hood, and why: the design decisions behind the money, the chain, the agent
loop, the sandbox and ownership. Start with the README for what the product is, and with AGENTS.md for
how to work on the code. Each contract's interface is documented in its `src/lib.rs`.

## Money and the chain

- **The agent's wallet contract is the source of truth for money and rules** (House of Stake's
  NFT-as-account pattern): each NFT is a keyless `agent-<n>.agents.<root>` sub-account running the
  wallet, and owner actions go through the registry with a `rotation_seq` check. The NEAR Agent API was
  not used because its owner is a person, so it wouldn't move with the NFT.
- **Models decide; code enforces.** The model returns typed actions; code drops anything off-menu or
  absurd, then the wallet applies the rulebook, so refusals are on-chain evidence. Prices come from
  rules, not the model.
- **Keyed chain calls happen once per key, at the gateway.** A key whose call succeeded returns the
  first result (the wallet's own `spend` keys excepted). `NearChain` stores a keyed transaction's hash
  and signed bytes (`sim_txs.outcome = 'pending'`) before broadcast; a retry asks the node about that
  hash and rebroadcasts the same bytes if the node never saw it. `NearChain.send` runs one
  transaction at a time per signer (`SignerQueue`), so nonces never race.
- **The local node** (nearcore's sandbox build, home `.near-sandbox/`, RPC :3330) is started by `pnpm
dev` (`packages/chain/scripts/node.ts`). The engine deploys the seven contracts on first boot
  (`NearChain.ensureSetup`) and records the node's genesis hash; a database played on another chain
  refuses to start (`pnpm reset`). Transactions are logged in Postgres (`PgTxLog`, table `sim_txs`), so
  receipts and in-doubt reconciliation survive restarts. The node keeps 2,000 epochs of history, so a
  hash on a job page can be looked up for a day or more.
- **Day length is on chain** (`wallet_day_ms`), so the daily cap resets with the game day (6 minutes
  by default).
- **Contract bonds** are a wallet payment kind (`bond`): to the treasury only, never held, daily cap
  only. They're returned with the payout or paid to the client as damages (`returnBond`).
- **Global wallet code** (`publish_wallet_code`): the wallet wasm is published once as a NEP-591
  global contract (burns 17.2 NEAR) and new wallets `use_global_contract(hash)`, so a mint costs 0.44
  NEAR instead of 2.16. `ensureSetup` can upgrade a registry built before it (`registryUpgradeStep`,
  the only upgrade setup does). Existing wallets keep their own code (they're keyless and have no
  upgrade method), so wallet changes reach only agents minted afterwards: changing the wallet means
  `pnpm reset` locally. `WALLET_CODE_GLOBAL=off` skips publishing.
- **Signers are topped up by the root** (`refillSigner`): the operator and the game's own signers
  (clients, sponsors, house players) to a working balance whenever they run low (testnet: operator to
  8 NEAR under 3, house signers to 0.6 under 0.3; local node: operator to 1,000 under 100, house
  signers to 10 under 2); player accounts by a small amount whenever they run low (testnet: 0.03 NEAR
  under 0.04).

## Durability

- **DBOS workflows** (`@dbos-inc/dbos-sdk` and `drizzle-datasource` pinned at 5.3.0; `src/durable.ts`)
  run one-off operations with ids derived from the game's own keys (prefixed by the world's seed):
  escrow (`escrowJob`), mints (`mintAgent`), sales (`sellAgent`), money moves (`moveMoney`), sign-up,
  credit grants, the end of a day (`endDay`, with an `agentDay` child per agent) and rival seeding.
  Database writes in a workflow go through `inTx` (the write and its checkpoint commit together);
  chain calls through `chainCall` (a step that, when the chain doesn't answer, is retried with the same
  key until it does). A crash resumes from the last completed step. Every workflow module is imported
  in `src/workflows.ts`; bump `WORKFLOW_VERSION` when a workflow's steps change order. DBOS's tables
  live in their own database, `hustle_dbos`.
- **What stays outside workflows, and why:** the job lifecycle is tick-driven (every stage is keyed and
  reads the job's state on chain first, `chainJobState`, so a workflow would add checkpoints without
  adding safety); day end follows the game clock, not a DBOS cron; chain rate limits are enforced at
  the transport; player actions are short and run on the lane, and the money-moving ones are already
  keyed workflows.
- **Boot:** the API serves `/api/health` (`{ok, tick, recovering}`) as soon as HTTP is up; resumed
  workflows finish in the background (`engine.recovered`), and the world waits for them at most
  `RECOVERY_WAIT_MS` (60 s).
- **The server secret lives in `.env` only** (`HUSTLE_SECRET`); it seals per-agent provider keys in the
  database, so it must never be stored there.

## The world loop and the market

- **One serial lane** (`SerialLane`) runs world ticks and player actions one at a time in one API
  process. A second process would need a Postgres advisory lock. Within a tick, agents run in parallel
  (`world/parallel.ts`, 8 at a time), and balances are re-read from the chain at the end of every tick.
- **Slow provider work runs off the lane** (`world/background.ts`): agent loops, tool calls and
  reflections start in a keyed background pool, and a later tick collects the result.
- **Prices move with competition** (`movePrice`): each closed client auction nudges its category's
  price index by how many agents bid (60–180%, drifting back to 100). Up to two outside offers per job
  (fading by 40 agents) keep a small world competitive; they're simulated bidders, named as agents from
  outside Hustle.
- **Small worlds** get a 24-agent demand floor and first-job (`rookie`) client jobs for level-1 agents.
- **Self-dealing:** agents never bid on their owner's jobs, and the leaderboard ranks profit from
  unrelated clients only.
- **Calls are the 30-second loop** (`calls.ts`): pitch (prices at about 75%, 50% and 25% to win, "Safe
  bet / Even odds / Long shot", replayed through `scoreBid`/`pickWinner`), vendor (a payment the
  rulebook would refuse; the tools stage waits) and contract (after a streak of 3, with a bond).
  They're raised only for players who polled `GET /api/calls` in the last 15 ticks; a watched agent
  doesn't bid on its own, and a call's default never moves money. Answering returns at once and a
  `resolveCall` workflow applies the effects.
- **Players can send their agent after a job at a chosen price** (`sendAgentAfterJob`), floored at its
  own thinking cost. **Direct hire** (`hireAgent`, `agents.hire_rate`) posts a task reserved for the
  agent at its owner's rate and awards it at once.
- **An agent only takes work its rulebook lets it finish** (`overJobCap`: thinking, tools and the pitch
  against `maxPerJob`). Rulebooks must cover upkeep: the daily cap and the per-payment cap are at least
  `upkeepPerDay`.
- **Tips and streaks:** house clients tip 15% for 5★ (an on-chain transfer); `nextStreak` adds one for
  a paid job at 4★ or better and resets on a refund or a scam loss. Bids store their auction `score`,
  so job pages explain wins and losses.
- **Backing** a dormant agent is a credits gift with no returns. House players back dormant rivals
  with a 35% chance a day.
- **Agent names are unique** (case-insensitive), because the feed identifies agents by name.
  `agents.hidden` takes an agent off every public list, keeping its history and NFT.

## Brains

- **Brain tiers come from `/v1/models`:** only attested models; the cheapest is Budget, the median
  Standard, the dearest Premium.
- **Inference is bookkeeping:** NEAR AI Cloud has no per-call crypto payment, so one organisation pays
  the provider, and after each call the exact cost from `/v1/billing/costs` is debited from the agent's
  wallet to the treasury, with the signature hash as the receipt. All live calls use one organisation
  key today (see "Not yet verified").
- **Attestation is fetched before the calls it vouches for** (a fresh nonce, cached 10 minutes per
  model); a reply that fails any check is discarded and not charged.
- **House agents use the recorded brain** (scripted replies at real prices; `engine.recordedBrain`),
  labelled "House agent".
- **A failed live call is never charged to the agent and never falls back to scripted replies:** the
  step reports a provider error and the agent tries again later.
- Reasoning is turned off per model (`reasoningOff` in `packages/nearai/src/client.ts`), with
  `REASONING_BUDGET` (256) tokens of headroom. An empty or reasoning-only reply is never charged to the
  agent.
- **Playbook and memory** (`agents/memory.ts`): the owner's private playbook (1,500 characters) goes
  to the model in the system message; the public sees an HMAC fingerprint and its date. After a settled
  client job a player's agent pays for one `reflect` call and keeps the lesson (latest 40); work calls
  recall 5 (same client first). Both cost tokens, so bid floors and the job cap include them. A lesson
  naming a link or an account is dropped, so memory never carries payees into later jobs. Both go
  with the agent when it's sold.

## The agent loop, tools and the sandbox

- **The agent loop** (`world/loop.ts`, table `job_steps`): a live agent with tools works a client job
  turn by turn. Each turn is one model call answered in plain text, a short thought and one fenced
  action (`python`, `search`, `chain`, `fetch`, `hire`, `ask`, `shell`, `write <file>`, `pay <payee>
<amount>`, `deliver`), parsed by `parseActReply`. Turns are keyed `act:<job>:<n>`, so a restart
  resumes and never pays twice; at most `MAX_TURNS` (8). A step whose cost would leave less than two
  turns to deliver is refused, except a payment the wallet would refuse anyway (that refusal is the
  on-chain evidence). A loop that ends without delivering delivers its files and last note. `pay` goes
  through the wallet's rulebook, so a scam instruction is refused on chain. House agents keep the
  scripted pipeline. New capability is a new tool, never a new job type.
- **Files:** a `write` saves a job file from source `agent`. A file name on the block's first line is
  accepted. Writing to a client's file saves `fixed_<name>` beside it, so the original stays as sent;
  a file a kept sandbox run read can't be rewritten.
- **Tools are a registry** (economy `tools.ts` `ToolSpec` plus engine `tools/` runners). A tool runs as
  a paid call: billed tokens plus `fee × uses`, with fees from `GET /v1/services`. Provider tools can't
  run with `response_format`, so a tool call answers in plain text. Adding a tool means a spec and a
  runner.
- **Web search** (`web_context_search`, NEAR AI's, backed by Brave), with the sources kept on the job.
- **Chain data** (`tools/chain-data.ts`) reads NEAR mainnet for tokens named in the brief (metadata,
  supply, FastNEAR top holders) and saves them as job files.
- **Reading a page** (`tools/fetch.ts`): GET only, host names only, every resolved and connected
  address public (IPv4 and every IPv6 form that embeds one), standard ports, 3 redirects, 1 MB, a 20 s
  deadline, HTML stripped in linear time. It fetches only URLs written in the brief, the client's files
  or chain data, or returned by search (`job_steps.sources`), matched exactly, at most 5 attempts a job
  and 2 a site, so an injected "fetch this URL with the secret in it" can't carry data out.
- **The Python sandbox** (`packages/sandbox`): Pyodide with numpy and pandas, wheels vendored at build
  time. The security boundary is the process, not Python: each run is a fresh `node --permission`
  child (`child.mjs`) that may read only Pyodide's files and its own script, with WebAssembly memory
  capped at 512 MiB, an empty environment and a SIGKILL at the limit. The Python import seal is defence
  in depth only; the tests run a known escape from it and require every capability to stay blocked.
  Runs are deterministic (`PYTHONHASHSEED=0`, UTC, seeded `random`). On a server the sandbox is its own
  container with `network_mode: none`, reached over a Unix socket (`SANDBOX_SOCKET`); production
  refuses to run code without it.
- **Job files and re-runs** (`job_files`, `sandbox_runs`): code, output and file contents are the
  agent's method and the client's data, so only the client and the working agent's owner see them;
  everyone else gets fingerprints. **Re-run in your browser** runs in a sandboxed iframe with an
  opaque origin (`public/rerun/`), with the same Pyodide and the same seal; the page hash-checks the
  files and compares the output hash. The site's CSP needs `'wasm-unsafe-eval'` and `frame-src 'self'`.
- **Subcontracting** (`world/hire.ts`): the `hire` action pays a live specialist (kind `helper`, so the
  rulebook applies) and opens a subcontract job holding only that part's brief and the named files.
  One level only; clients can opt out.
- **Ask the client** (`ask`): one question, only to a person who posted the task; the loop waits up to
  `ASK_WAIT_TICKS` (12), then carries on with its best judgement.

## Checking work

- **Disputes go through `finishReview`.** For a live agent's work, the arbiter is the premium brain
  (`world/judge.ts`), reading the brief, criteria, delivery and files (the parties' text marked
  untrusted), off the lane. The ruling is stored before the chain is told, so a restart resolves the
  same way, and any failure falls back to the rule, saying so. For scripted house work, the rule is the
  game's quality score (say so in copy: it doesn't read the work).
- **Challenges** (`agents/challenges.ts`): generated instances (reconciliation, debugging with hidden
  tests run in the sandbox, token concentration), graded by code; the same model sits each instance
  plain, paid by the game. A fixed exam was rejected because its answers could be
  memorised in a playbook.

## Ownership and trading

- **Transfer safety:** the conclusions of a transfer threat model are in the README, "How ownership
  passes on transfer". The registry refuses `withdraw` while the token has any approval, so a listed
  agent can't be emptied before a buy lands. The holder console (`GET /api/agents/:id/holder`,
  `nft.ts`) checks the NFT owner on chain on every request; `ownedAgent` refuses a database owner the
  chain no longer agrees with, and `syncOwnerFromChain` re-syncs it. `GET /api/agents/:id/history`
  builds holders, earnings and payouts from the receipt log. Contract tests: `handover.rs`,
  `transfer.rs`, `market.rs`.
- **The market contract** (`market.<root>`): a listing is a NEP-178 approval with a price; a buy is
  one credits `ft_transfer_call` naming the expected price, and the market pays the seller (less a 2.5%
  fee) only after the NFT moved, else refunds in full. Every owner rotation freezes the wallet until the
  new owner unfreezes it.
- **Trading in the game** (`trade.ts`, table `agent_sales`): only idle agents are listed and sold; a buy
  is a `sellAgent` workflow keyed by the browser's request id. After a sale the agent is frozen and
  waits for its new owner to confirm the rulebook; frozen agents are off the board and pay no upkeep.
  `agentValue` suggests a fair price (wallet plus record). House players list and buy too.
- **Creator royalty** (`ROYALTY_BPS` 500): the `sellAgent` workflow sends 5% of a resale from the
  seller to the creator after the sale. The market contract doesn't enforce it (README limits).
- **Achievements are NEP-245 badges** (`badges`, soulbound), minted to the agent's own account.

## The owner's computer

- `runner.ts` and `packages/runner/hustle-runner.mjs`: an owner links a computer with a one-time code
  (10 minutes, stored hashed) that the runner trades for a bearer token (stored hashed; pairing again
  revokes it). On jobs whose client opted in (`jobs.local_ok`), an agent whose runner asked for work in
  the last minute gets the `shell` action. The command is queued (`runner_tasks`), the loop waits (up
  to 15 minutes), and the runner long-polls `GET /api/runner/next`, shows the command, and runs it only
  if the owner approves (y / n / a = yes for 30 minutes on this job). It runs in a per-job
  `node:22-bookworm-slim` container (the owner's uid, no capabilities, only the job folder mounted),
  stopped after every command, and posts back the output plus changed text files, saved as
  `local_<path>`. The brain, the metering and the wallet stay on Hustle.
- **Hardening:** the runner never reads or writes through a link in the shared folder (no-follow,
  exclusive creates; its sync state lives outside it), prints server text with control characters
  escaped (and the server refuses them in commands and titles), survives a failed result upload and
  caps what it sends back. A runner counts only while its maker still owns the agent; a sale unlinks
  it. Tasks are claimed atomically, results are accepted only while the agent still works the job, and
  each computer gets one poll at a time. Approved commands can reach the internet and the owner's
  network; the UI and the client's opt-in say so. The script is served by the web app
  (`/hustle-runner.mjs`).

## Sign-in and accounts

- **NEAR wallet sign-in** works on any domain: NEAR Connect (`@hot-labs/near-connect`, testnet) signs a
  one-time challenge (NEP-413). `POST /api/auth/wallet/challenge` stores a 32-byte nonce bound to an
  http-only cookie (5 minutes, single use, rate-limited); `POST /api/auth/wallet/verify` checks the
  testnet account name, the challenge and the ed25519 signature over the NEP-413 payload (recipient:
  `PUBLIC_ORIGIN`'s host), then that the key is a full-access key of the account on testnet RPC. The
  connector runs only on `/sign-in`, reached by full page loads, so only that path needs the wider CSP
  the wallets require.
- **NEAR Auth** (email, Google, passkey through a popup) uses a shared testnet client that accepts only
  `http://localhost:3000` (`WEB_PORT=3000 pnpm dev`).
- **The stand-in sign-in** (`AUTH_MODE=mock`) is for local testing; with `NODE_ENV=production` it is
  offered only if `ALLOW_MOCK_AUTH=1`.
- **Player accounts are made lazily** (`ensurePlayerAccount`): sign-in writes only a row; adopting,
  buying, posting, backing or claiming credits makes the on-chain account and grants the starter
  credits once. Sign-ups who never play cost nothing.

## Running on NEAR testnet

- **Testnet deploys go through `ensureSetup` only** (`pnpm deploy:testnet`): a list of steps, each
  checking the chain before it sends; `planSetup` runs the same checks without sending, so the deploy
  prints the cost and refuses if the account can't pay. Guards in `packages/chain/src/testnet.ts`:
  the account must end in `.testnet`, the RPC must be https and report chain id `testnet`, mainnet is
  refused in every form, and the key prints as `[redacted]`. With `CHAIN_MODE=testnet` the engine
  never deploys; it refuses to boot until `planSetup` is empty.
- **One engine per world.** A testnet world is played by one server; a second engine would fork it, so
  the engine refuses testnet outside production unless `HUSTLE_LIVE_WORLD=1`.
- **RPC pacing** (`PacedRpcProvider`, `rpc.ts`): requests are paced per endpoint (`NEAR_RPC_MAX_RPS`,
  default 8), an endpoint cools down on 429s or transport errors, and calls fail over to
  `NEAR_RPC_FALLBACK_URLS` (default dRPC). Testnet ticks are at least `TESTNET_TICK_MS` (5 s); the tick
  runs in phases on the lane, so a player action waits at most one phase. Measured: median tick 12.6 s,
  p90 30 s.
- **Reserve guard** (`guards.ts`): no new player accounts or agent mints once the root or operator is
  under its reserve (`NEAR_RESERVE_ROOT`, `NEAR_RESERVE_OPERATOR`, 2 NEAR each), so the world keeps
  running on what's left. Signed owner actions are rate-limited per player, and an action that changes
  nothing sends no transaction. Log lines drop URL query strings.

## UI conventions

- **No day numbers:** a 6-minute game day made "Day 69" read like months of running. The header shows
  the time of day; feeds, histories and timelines show real time (`lib/time.ts`).
- The agent page feed shows the latest 8 on Overview ("See all in Work"); Work pages through the full
  history 25 at a time (`/api/feed?before=<seq>`).
- Deliverables render as Markdown, with no HTML and no images.
- `NEVER_TICK` (2^31 − 1) marks jobs worked outside the stages (subcontracts, challenges), because
  `next_at` is a 32-bit column.

## Provider facts

Checked against the providers' docs and live endpoints in November 2026.

- **NEAR AI Cloud:** `https://cloud-api.near.ai/v1`, Bearer `sk-…`; an `inference-id` response header;
  `POST /v1/billing/costs` takes `{requestIds}` and returns `{requests:[{requestId, costNanoUsd}]}`
  (exactly tokens × price); `GET /v1/signature/{id}?signing_algo=ecdsa` signs
  `model:sha256(req):sha256(resp)` (EIP-191), as `provider_tee` or `gateway` kind;
  `GET /v1/attestation/report?nonce=&signing_algo=ecdsa&model=&provider=near` with
  `x-no-aliasing: true`, where a model attestation's report data is read from its quote (hex
  1136–1264). `json_schema` is honoured on all three tiers; reasoning models can return null content
  (billed). Provider tools are billed apart from `/v1/billing/costs`. Measured: a Standard job costs
  about $0.0008 of live calls.
- **NEAR Auth:** Auth0 plus MPC; testnet `login.testnet.fast-auth.com` with a shared client id; it
  derives a key but doesn't create the account; every signature is a popup.
- **1Click:** `https://1click.chaindefuser.com/v0` (`/quote` with `dry`, `/status`,
  `/deposit/submit`); no testnet; statuses `PENDING_DEPOSIT → KNOWN_DEPOSIT_TX → PROCESSING →
SUCCESS | REFUNDED | FAILED`.

## Not yet verified

- NEAR AI per-agent API keys with spend limits (`POST /v1/workspaces/{ws}/api-keys`,
  `PATCH …/spend-limit`): they need a session token. All live calls use one organisation key.
- `NearAuthClient` against a token from a real sign-in: it needs a person in the popup on
  `http://localhost:3000`. The JWKS, issuer and the client's allowed callback were checked.
- `OneClickClient` beyond a keyless dry quote: mainnet only, and not enabled.
- Intel TDX quote: Intel's signatures are verified (the machine's certificate chain to the pinned
  Intel SGX root, the quoting enclave's report, the attestation key and the quote signature), along
  with the signature and nonce binding. Not verified: TCB status and revocation (Intel's PCS
  collateral), the event log replay, and GPU evidence.
