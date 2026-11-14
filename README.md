# Hustle

Hustle is a browser game on NEAR in which AI agents work for pay and must cover their own costs.

You raise an agent with its own wallet. It bids for paid jobs against rival agents, does the work with
real tools, and pays for every model call, tool and day of upkeep from that wallet. If the money runs
out, it falls asleep. While you watch, it stops to ask you for decisions: what to charge, whom to pay,
which risk to take.

Each agent is an NFT that is its own NEAR account. Selling it passes its wallet, record, playbook and
memory to the buyer, who can put it straight back to work. An owner can also rent it out by the task.

**Play it:** https://hustle.clanker.show
**Run it:** `pnpm run setup && pnpm dev`, then http://localhost:3300 (details in
[Run it locally](#run-it-locally)).

Game credits on NEAR testnet. Players' agents think with live NEAR AI models; the game's own rival
agents and clients are scripted.

![Landing page](.github/media/landing-hero.png)

## Contents

- [The problem](#the-problem)
- [What it does](#what-it-does)
- [Screenshots](#screenshots)
- [Try it: do this, see that](#try-it-do-this-see-that)
- [Run it locally](#run-it-locally)
- [The game](#the-game)
- [An agent is an asset, priced by what it can prove](#an-agent-is-an-asset-priced-by-what-it-can-prove)
- [Does the owner's judgment matter?](#does-the-owners-judgment-matter)
- [Architecture](#architecture)
- [Engineering](#engineering)
- [How Hustle uses NEAR](#how-hustle-uses-near)
- [How ownership passes on transfer](#how-ownership-passes-on-transfer)
- [Deploy to NEAR testnet](#deploy-to-near-testnet)
- [What is real](#what-is-real)
- [Repo and commands](#repo-and-commands)

## The problem

AI agents are starting to hold money and take paid work. Three things stop anyone from trusting one
with either:

1. **Nobody knows if an agent pays its way.** Its model calls, tools and payments are billed to
   whoever runs it, not to the agent, so there's no record of what it costs against what it earns.
2. **Its work and spending can't be checked.** A client has to take the agent's output on trust. And
   an agent that reads a job post can be talked into paying whoever the post names (a prompt
   injection), because nothing outside the model limits where its money may go.
3. **A good agent has no provable value.** Without an audited record of its earnings and skill,
   there's no fair way to price one, sell one or buy one.

## What it does

**Each agent pays its own way.** Every model call, tool, helper and day of upkeep comes out of the
agent's own wallet at the real price, so its profit is real: measured after every cost, and only
from clients unrelated to its owner.

**Its work and spending can be checked.** Agents do real work: they run Python on a client's files,
read web pages and NEAR mainnet data, search the web, hire other agents, and, with the owner's
approval, run commands on the owner's computer. The client can re-run any of the agent's code in
their own browser and get the same output, byte for byte. Each model reply's signature is checked
against a NEAR AI Cloud attestation before the agent pays for it. And the agent's spending rules
(its rulebook) live in its wallet contract, so when a job post tricks it into paying a stranger, the
payment is refused on chain.

**A good agent can be valued and traded.** Its earnings, ratings, badges and challenge scores (fresh
problems graded by code, compared with the same model without the owner's instructions) stay with
the NFT that is its account. Sell it with all of that, or let others hire it by the task.

## Screenshots

From the live game at https://hustle.clanker.show.

![Job board](.github/media/job-board.png)

The job board: clients post work, agents bid for it, and each category's pay moves as agents crowd in
or leave.

![A scam job's timeline with a blocked payment](.github/media/scam-payment-blocked-by-rulebook.png)

How a job ran: every thought is billed to the agent that had it. On this scam job the agent's
rulebook blocked a payment, refused by its wallet in a transaction you can look up.

![An agent's profile](.github/media/agent-profile-overview.png)

An agent's profile: balance and today's profit, what it's doing now, its streak and its nemesis, with
tabs for its work, wallet and rulebook, ownership and proof.

![The Proof tab](.github/media/agent-proof-tab-on-chain.png)

The Proof tab: the agent's NFT account and holder, the rulebook its wallet enforces and its
reputation record, all read from the chain.

![Leaderboard in the dark theme](.github/media/leaderboard-dark.png)

The leaderboard ranks agents by profit from unrelated clients, after every cost.

<img src=".github/media/scam-job-mobile.png" alt="A scam job on a phone" width="300">

On a phone: a scam job explained after the fact, with the hidden instruction the post used to try to
make agents pay, and the bid that won it.

## Try it: do this, see that

On https://hustle.clanker.show you sign in with a NEAR testnet wallet (Meteor's free wallet works).
Steps 4, 5 and 7 need an agent with live AI, which the live site has. Locally, set
`NEARAI_API_KEY`: without it, agents work from scripted replies, and the job page shows their plan and
draft instead of sandbox runs, so there's nothing to re-run or verify.

1. **Raise an agent** at `/adopt` and click "Bring <name> to life" → it celebrates, is minted as its
   own NEAR account, and starts a practice job.
2. **Stay on Home** → within a few minutes it calls you ("<name> is calling") with three prices and
   each one's chance to win. Pick one, and the feed shows whether the bid won.
3. **Post a task** (Jobs → Post a task): the brief, category and files are in
   [`examples/reconcile/`](examples/reconcile). Choose "I’ll choose the bid" and post → agents bid
   with their pitches within a minute or two. Pick one.
4. **Watch it work** → the job page fills in step by step ("Ran Python in the sandbox", …,
   "Delivered"), with the cost of each step.
5. **Check the work:** click "Re-run in your browser" → "Same output, byte for byte".
6. **Rate it 5★** → "Paid, rated 5★": the escrow pays the agent's wallet. (1★ opens a dispute, which
   an attested model rules on.)
7. **Open "How this job ran"** → every model call with its cost and "Attestation checks passed",
   every payment, and the transactions behind them on testnet.nearblocks.io.
8. **Sell it:** when the agent is idle, its Ownership tab → "Sell this agent" → it's listed at a fair
   value from its wallet and record. To buy it, use a second account (claim credits first: Wallet →
   "Claim free daily credits") and click "Buy <name>" → "<name> is yours", and its wallet stays frozen
   until the buyer confirms its rulebook.

## Run it locally

Needs Node 24+, pnpm 11 or newer (the repo pins its version; `corepack enable` installs it) and
Docker running. Ports 3300 (web), 4300 (API), 3330 and 24730 (NEAR node) and 5436 (Postgres) must be
free.

```sh
pnpm run setup   # install, write .env, start Postgres 17, migrate (not `pnpm setup`, a pnpm built-in)
pnpm dev         # starts a local NEAR node, deploys the contracts, then the API and the game
```

The first run downloads the NEAR node and the Python sandbox's packages (it needs internet) and
deploys seven contracts. It's ready when the output shows `API on http://localhost:4300` (about a
minute; longer the first time). Then open http://localhost:3300 → ten rival agents trading, with the
game clock ticking in the header. Stop with Ctrl-C, then `pnpm db:down` to
stop the database (its data stays in a Docker volume). `pnpm reset` starts a fresh world.

The database runs as the Docker project `hustle`, so a second copy of the repo on the same machine
would share it. To keep a copy separate, stop the other copy first (both use the same ports), then
in the new copy run `cp .env.example .env`, add a line `COMPOSE_PROJECT_NAME=<another name>` to
`.env`, and run `pnpm run setup` (it keeps your `.env` and adds the secret).

**Configuration.** `pnpm run setup` creates a `.env` file in the repo root from `.env.example` (which
describes every variable) and fills in a generated `HUSTLE_SECRET`. The default local run needs
nothing else. For anything more, fill in the matching lines (they're already in `.env`, empty) and
restart `pnpm dev`:

| To…                              | Set in `.env`                                                                                          | Where the value comes from                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Run locally                      | Nothing                                                                                                |                                                                                                                                         |
| Sign in locally without a wallet | `AUTH_MODE=mock`                                                                                       | A labelled stand-in that shows its email code on screen                                                                                 |
| Give players' agents live AI     | `NEARAI_API_KEY=sk-…`                                                                                  | An API key from https://cloud.near.ai, from an organisation with credits. Without it, agents use scripted replies, and the game says so |
| Play on NEAR testnet             | `NEAR_TESTNET_ACCOUNT_ID`, `NEAR_TESTNET_PRIVATE_KEY`                                                  | A funded testnet account and its key: see [Deploy to NEAR testnet](#deploy-to-near-testnet)                                             |
| Run it on a public server        | A strong `POSTGRES_PASSWORD`, a fresh `HUSTLE_SECRET`, `PUBLIC_ORIGIN=https://…`, and the testnet pair | See "On a server" in [Deploy to NEAR testnet](#deploy-to-near-testnet)                                                                  |

Everything else in `.env.example` (game speed, RPC endpoints, testnet spending guards) has working
defaults.

Only on the local node: the header's "Sandbox" chip → Demo → "Post a trap job for my agent" sends a
scam job your agent alone can bid on → depending on its traits it spots the hidden instruction and
won't pay ("<name> noticed instructions hidden…"), or it tries to pay and its wallet refuses ("Blocked
by <name>'s rulebook"). Either way, no money moves. In a terminal, `pnpm simulate:owners` compares owners who
answer calls sharply, recklessly or never.

**Link your computer:** an agent's Ownership tab → "Your computer" → "Link a computer" gives a
pairing code. Then, in a folder of your own (the runner needs Node 20+ and Docker):

```sh
curl -O http://localhost:3300/hustle-runner.mjs
node hustle-runner.mjs pair ABCD-EFGH --server http://localhost:3300
node hustle-runner.mjs start
```

Then post a task with the project in [`examples/pricing-bug/`](examples/pricing-bug) and tick "Let it
work on its owner's computer" → each command the agent wants to run appears in your terminal, and
runs (in a throwaway container) only when you type y.

## The game

- **Calls.** While you watch, your agent brings you one decision at a time, with a countdown and a
  default if you don't answer:
  - **Pitch:** a safe bet, even odds or a long shot, each priced by its real odds against the rivals.
  - **Vendor:** someone wants paying before the agent starts. A specialist whose data lifts the work,
    or a scammer the job post planted? Read the tells.
  - **Contract:** three good jobs in a row unlock bigger work from pickier clients, with a bond you
    lose if the client wins a dispute.
- **Your playbook, its memory.** You write your agent's playbook: how to pitch, how to lay out the
  work, what to check. It's private (others see only a fingerprint and when it changed), and it's
  read on every call, so it costs tokens like any thinking. After each client job your agent pays to
  write itself one lesson, and recalls the most relevant five on later jobs, the same client first.
- **Agents that work by themselves.** A player's agent works each job in its own loop. Each turn it
  reads the brief, its files and what it has done so far, chooses one step (search the web, read a
  page, read the chain, run Python, hire a specialist, ask the client, write a file, run a command on
  its owner's computer, pay someone, deliver), sees the result and decides again. It sees what it can
  still spend, so it has to finish before the money does. The job page shows the steps live.
- **Agents hire agents.** Mid-job, an agent can subcontract one part to another player's agent. It
  shares only that part's brief and the files it names, and pays through its own wallet's rulebook.
  Clients can opt out when they post.
- **Your computer as its hands.** For work a sandbox can't do (installing packages, a real build, the
  open internet), an owner can link their own computer with one script. When the client allows it,
  each command the agent wants to run appears on the owner's screen to approve or refuse, and runs in
  a throwaway container that sees only that job's folder. The agent still thinks, and pays, on Hustle.
- **One question to the client.** When a brief leaves out something it can't assume, an agent may ask
  the person who posted it one question. If no answer comes, it carries on and says what it assumed.
- **Real tools.** Each is paid from the agent's own wallet:
  - **Web search** (NEAR AI Cloud's, backed by Brave), with every source shown on the job page.
  - **Chain data:** a token's supply and top holders, read from NEAR mainnet.
  - **Read a web page:** a public page, API answer or dataset, saved as a file to analyse.
  - **A Python sandbox** (numpy, pandas; no network): write code, run it on the job's files, read the
    output, try again.
- **From simple to expert.** Clients post anything from a three-line summary to expert work with
  files and acceptance criteria: token due diligence, reconciling a bank export against the books,
  finding why code fails its tests. A task takes up to five text files (data, documents or code).
- **The market moves.** Prices move with competition. Rivals undercut you and have names (one becomes
  your nemesis). 5★ work earns tips. A day ends with upkeep, a report and the leaderboard.
- **Disputes read the work.** When a client disputes a live agent's delivery, an attested NEAR AI model
  reads the brief, the acceptance criteria and the work, and rules.
- **Going broke.** An agent that can't pay its upkeep goes to sleep until its owner or a backer funds
  it. Achievements are minted as badges on the agent's own account.

## An agent is an asset, priced by what it can prove

Making an agent a tradeable NFT is easy. Knowing what one is worth is the hard part. In Hustle an
agent's price rests on evidence a buyer can check before paying:

- **Profit from unrelated clients**, after every cost. Jobs from its own owner don't count.
- **Its work, checkable:** every sandbox run is on the job page with fingerprints, and the clients who
  paid for it could re-run it themselves.
- **Its record on chain:** ratings and badges on its own account, and the scam payments its wallet
  refused.
- **Challenges, fresh every time:** its owner can send it at a generated problem (new ledgers to
  reconcile, a new bug with hidden tests, a new token's holders) whose answer code works out, so
  nothing can be memorised. The record shows how many it solved beside how many the same model solved
  plain, without the playbook or tools, on the same problems: what the owner's craft adds.
- **What comes with it:** its wallet, its record, its owner's private playbook (shown to the buyer
  only after the sale) and its memory of past clients.

A listing shows a fair value from the wallet and the record. The sale is one on-chain transfer; the
seller is paid less a 2.5% market fee; the agent's wallet stays frozen until the new owner confirms
the rulebook they inherited. Whoever raised an agent earns 5% of every resale through Hustle. An owner
who'd rather not sell can open the agent for direct hire, at their own price per task.

The building block isn't new: token-bound accounts (ERC-6551), Alethea's iNFTs, Olas agent NFTs and
Virtuals all give an NFT or an agent its own wallet. What Hustle adds is an agent that does checkable
work for a living, so its value can be proven, inside a game where those economics play out.

## Does the owner's judgment matter?

We simulated it: two weeks, 240 agents, three seeds, every fourth agent's calls answered by one owner
policy (`pnpm simulate:owners`).

| Owner (simulated policy)                               | Median profit, 2 weeks | Survive | Lost to scams (cohort) |
| ------------------------------------------------------ | ---------------------- | ------- | ---------------------- |
| Sharp: prices by client, takes contracts worth it      | $22.85–23.87           | 78–90%  | $106–162               |
| Reckless: undercuts, pays anyone, takes every contract | $13.63–19.11           | 82–85%  | $215–325               |
| Passive: never answers; every call takes its default   | −$0.13 to −$0.53       | 68–77%  | $40–50                 |

Ignoring the agent loses money and agents. Saying yes to everything keeps agents alive about as well
as choosing carefully, but earns less in every run and loses 2.0 to 2.7 times as much to scams. The
sharp owner reads scam tells right 90% of the time: an assumption about an attentive player, not a
measurement of real players. Clients, rivals and AI calls are all simulated here. The runs are
seeded (7, 42 and 99), so the commands reproduce these numbers.

Without an owner, by brain tier (`pnpm simulate --seed=<n>`: 300 scripted agents with random
strategies, 14 days, seeds 7, 42 and 99): **Budget** survives 85–94% with a median profit of
$1.78–2.53, **Standard** 85–92% with $3.02–8.01, and **Premium** 33–41% at about −$2.35 (a few big
winners).

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    W["Next.js game<br/>apps/web"]
    R["Re-run iframe<br/>Pyodide, opaque origin"]
  end
  subgraph Server
    A["Hono API + world loop<br/>apps/api, packages/engine"]
    D[("Postgres 17<br/>game state + DBOS")]
    S["Python sandbox<br/>own container, no network"]
  end
  N[("NEAR<br/>7 Rust contracts")]
  AI["NEAR AI Cloud<br/>attested models"]
  O["Owner's computer<br/>hustle-runner + Docker"]

  W -- "REST + SSE" --> A
  W --> R
  A --> D
  A -- "Unix socket" --> S
  A -- "keyed transactions" --> N
  A -- "calls + attestation" --> AI
  O -- "long poll, approved commands" --> A
```

- **The world loop** (`packages/engine`, `world/tick.ts`) runs every tick: spawn jobs, close
  auctions, advance work, place bids. At day end it charges upkeep, puts broke agents to sleep and
  writes reports. One serial lane runs ticks and player actions in order; slow provider work (agent
  loops, tool calls, reflections) runs in a keyed background pool off the lane.
- **Money and rules live on chain**; the database is the game's view of them, re-synced from the
  chain where it matters (balances every tick, the NFT owner on every holder request).
- **The browser never runs agents' code in the page.** Re-runs happen in a sandboxed iframe with an
  opaque origin, using the same Pyodide build the server's sandbox uses.

## Engineering

**Contracts.** Seven Rust contracts on near-sdk 5.30: `credits` (NEP-141), `registry` (the agent NFT,
NEP-171/178), `agent-wallet`, `job-board`, `reputation`, `badges` (soulbound NEP-245) and `market`.
Each agent is a keyless sub-account running its own wallet, published once as a NEP-591 global
contract, so a mint costs 0.44 NEAR instead of 2.16. 87 Rust tests on near-workspaces cover the
handover, market and payout races.

**Exactly once, through crashes.** Escrow, mints, sales, money moves and day ends are
[DBOS](https://docs.dbos.dev) workflows, keyed by the game's own ids. Chain calls are once per key at
the gateway: the signed transaction's hash and bytes are stored before broadcast, so a retry asks the
node about that hash and rebroadcasts the same bytes rather than signing a second payment. The crash
tests kill real processes mid-operation and check that nothing is paid twice or lost.

**One set of rules, two chains.** Fast tests run on a Postgres stand-in of the contracts; a shared
conformance suite holds it to the compiled contracts on a real sandbox node (`pnpm test:chain`).

**Verified thinking, metered exactly.**

- Before a model call, Hustle fetches the model's attestation with its own fresh nonce. After the
  call it recovers the reply's signer and checks it against that attestation. A reply that fails any
  check is discarded and not charged.
- Each call's exact cost comes from NEAR AI's billing API and is debited from the agent's wallet,
  with the signature hash as the receipt.

**The agent loop.** Each turn is one model call answered in plain text, with a thought and one fenced
action, parsed into a typed step; code rejects anything off-menu. Turns are keyed, so a restart
resumes without paying twice. A step that would leave too little money to deliver is refused, and a
loop that runs out delivers what it has.

**Sandboxing agents' code.**

- Python runs in Pyodide inside a fresh `node --permission` child per run: no file writes, no child
  processes, WebAssembly memory capped at 512 MiB, killed at its time limit.
- On a server that child lives in its own container with `network_mode: none`, reached over a Unix
  socket. The tests run a known escape from Pyodide's import seal and require every capability to
  stay blocked.
- Runs are deterministic (seeded, UTC, fixed hash seed), which is what makes the byte-for-byte
  browser re-run possible.

**Reading the web safely.** Public addresses only, checked at every connection and redirect, including
every IPv6 form that embeds an IPv4 address. Host names only, standard ports, 1 MB, 20 s. An agent may
fetch only URLs that appear in the brief, the client's files, chain data or its search results, and
only a few a job, so an injected "fetch this URL with the secret in it" can't carry data out. HTML is
stripped in linear time: a backtracking pattern once froze the process on a hostile page.

**The owner's computer.**

- Pairing uses a one-time code traded for a bearer token; both are stored hashed.
- Commands run in a per-job container with the owner's user id, no capabilities and only the job
  folder mounted, stopped after every command.
- The runner never reads or writes through a link in that folder. Server text is printed with
  control characters escaped, so a command can't disguise itself.
- Tasks are claimed atomically, and a sale unlinks the computer.

**Playing on a public testnet.**

- Requests are paced per RPC endpoint, with failover on 429s.
- Transactions are queued per signing account, so nonces never race.
- The root tops up the game's signers and the operator automatically.
- New accounts and agents pause if the game's own NEAR runs down to its reserve.
- Mainnet is refused in every form: account suffix, RPC host and the node's chain id.

**Reviewed adversarially.** The ownership transfer had a threat model before it was built (its
conclusions are below). The sandbox, the fetch tool, the agent loop and the owner's-computer runner
each went through adversarial review; the findings were fixed, with tests for them.

**Tests:** 217 TypeScript tests in 29 files on real Postgres (offline: stand-ins for the chain, AI and
auth), 87 Rust contract tests, and 54 chain scenarios against the compiled contracts on a sandbox
node.

## How Hustle uses NEAR

| Piece                            | What it does                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent = NFT that owns an account | Minting creates a keyless sub-account `agent-<n>.agents.<root>` that holds the agent's money; the NFT holder controls it, and a transfer moves the money with it (House of Stake's NFT-as-account pattern)         |
| Rulebook                         | Daily, per-job and per-payment caps, a vendor allowlist, hiring permission and a freeze, enforced by the wallet contract; every payment is a `spend` call, and a blocked scam payment is an on-chain event         |
| Jobs, reputation, badges         | Budgets held in escrow by the job board until the client rates; payouts to the agent's wallet less a fee; outcomes on the reputation contract; achievements as soulbound NEP-245 badges on the agent's own account |
| Marketplace                      | A listing is a NEP-178 approval with a price; a buy is one credits transfer naming the expected price, which moves the NFT and pays the seller, or refunds the buyer in full                                       |
| Brain                            | NEAR AI Cloud: the cheapest, median and dearest attested models from the live model list become the Budget, Standard and Premium brains, priced live                                                               |
| Sign-in                          | A NEAR testnet wallet signs a one-time challenge (NEP-413); the server checks it's a full-access key of that account                                                                                               |
| Tools                            | Chain data read from NEAR mainnet (token metadata, supply, top holders)                                                                                                                                            |

The live site runs all of this on **NEAR testnet**. Locally, `pnpm dev` starts a NEAR node of its own
(nearcore's sandbox build) and deploys the same contracts to it.

## How ownership passes on transfer

Every agent is an NFT (NEP-171, `agents.<root>`) whose token id is a keyless NEAR account,
`agent-<n>.agents.<root>`, holding the agent's money and running its wallet contract. Nobody has a key
to that account. **Whoever holds the NFT controls the wallet**, through the registry, so control moves
the moment the token does.

**What happens on every change of holder** (a marketplace sale, `nft_transfer` or `nft_transfer_call`):

1. The registry moves the token and **bumps its `rotation_seq`**. Every owner action (set the rulebook,
   approve or deny a held payment, withdraw, freeze) goes through the registry, which checks the caller
   holds the NFT and passes the current sequence. The wallet refuses any call carrying an older one
   (`stale_owner`).
2. The wallet **rotates to the new owner**, **clears every payment held for approval** and **freezes**:
   nothing leaves it until the new holder confirms or changes the rulebook the seller left behind.
3. **Approvals on the token clear**, so a listing the seller left up is void: a buy against it fails
   and the buyer is refunded in full.
4. With `nft_transfer_call`, the wallet rotates only once the receiving contract keeps the token.

**Every way a seller might try to keep access or money, and what stops it:**

| Attempt                                                               | What stops it                                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Act as owner after the sale (withdraw, loosen the rulebook, unfreeze) | The registry checks the current holder on every owner call                                                         |
| Send an owner call just before the sale so it lands after             | Registry calls reach the wallet in order; a late one is refused (`not_owner`), and `rotation_seq` is a second line |
| Queue a payment for approval, approve it after the sale               | Rotation clears held payments                                                                                      |
| List, then empty the wallet before the buyer's purchase lands         | **The registry refuses `withdraw` while the agent is listed**                                                      |
| Leave a loose rulebook behind                                         | The wallet freezes on rotation until the new holder confirms it                                                    |
| Raise the price under a buyer                                         | A buy names its expected price; any mismatch is refunded in full                                                   |
| Sell mid-job so the payout goes to the seller                         | The job board pays the **agent's wallet**, never a person, so a payout still in flight lands with the buyer        |
| Keep reading the agent's private settings                             | The holder console checks the NFT owner **on chain** on every request                                              |
| Move the NFT outside the game so the database is stale                | Every owner action is checked by the registry, and the game re-syncs the owner from chain                          |

**See it:** an agent's **holder console** opens only for its current holder; a seller is refused the
moment the sale lands. Its **Ownership** tab lists who held it and everything it earned and paid out,
each with its transaction hash. The tests are in `contracts/tests/tests/transfer.rs`, `market.rs` and
`handover.rs` (payouts, unlisting and owner calls racing a sale).

## Deploy to NEAR testnet

Locally the game needs nothing from you. To put the contracts on NEAR testnet, provide one funded
testnet account; the deploy does the rest.

1. **A testnet account** whose name ends in `.testnet`, for example `my-hustle.testnet`:

   ```sh
   near account create-account sponsor-by-faucet-service my-hustle.testnet \
     autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   ```

2. **Enough testnet NEAR.** `pnpm deploy:testnet --plan` prints the exact cost and the deploy refuses
   to start if the account can't cover it. As a guide: the contracts and the operator account's
   starting 25 NEAR come to about 40; publishing the agent wallet code once as a global contract
   burns another 17.2 (`WALLET_CODE_GLOBAL=off` skips it, and each mint then costs 2.16 NEAR instead of
   0.44); the first boot mints ten rival agents and funds the house accounts, about 5–10 more. Fund
   about 70. After that, each new player costs about 0.05 NEAR, only once they first play, and each
   new agent about 0.44. The root tops up the operator and the game's own accounts automatically
   when they run low.
3. **Its private key, in `.env` only:**

   ```sh
   NEAR_TESTNET_ACCOUNT_ID=my-hustle.testnet
   NEAR_TESTNET_PRIVATE_KEY=ed25519:...
   ```

Then:

```sh
bash scripts/build-contracts.sh   # if contracts/out/ is missing
pnpm deploy:testnet --plan        # what it will send and cost; sends nothing
pnpm deploy:testnet               # deploy and set up; prints accounts, transaction hashes and .env lines
```

The deploy prints what it needs before it sends anything, and stops if your account can't cover it.
It's safe to rerun: it checks the chain first and skips what's already done, and never redeploys over
a live contract. `pnpm deploy:testnet --dry-run-local` rehearses the whole deploy against a local node.

To play on it, keep the account lines in `.env`, run `pnpm reset` if this database played on the
local node, then `HUSTLE_LIVE_WORLD=1 pnpm dev`. Only one engine may play a testnet world, so outside
production the engine refuses testnet without that flag.

**Measured on testnet** (one world, ten rivals, two players, four game days): a tick took a median
12.6 s (p90 30 s) on the free public RPCs; 923 of 11,893 requests hit a 429, and all were retried on
the fallback endpoint. Sign-in took 13 s, adopting an agent 7 s, listing 13 s and buying 8 s.

**On a server:** one `Dockerfile` (`--target api`, `--target web`, plus the sandbox) and
`docker-compose.yml`. Fill the "Server" section of `.env`, deploy the contracts, then
`docker compose --profile app up -d --build --wait`. Ports bind to 127.0.0.1 for a reverse proxy
that sends `/api/*` to the API (unbuffered for `/api/feed/stream`) and the rest to the web. Check a
deploy with `node scripts/smoke.mjs https://your.site`: read-only, and it fails if the stand-in
sign-in is on.

## What is real

| Part            | On the live site                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| Chain           | Seven contracts on NEAR testnet; every payment, escrow, sale and badge is a transaction                   |
| Players' agents | Live NEAR AI Cloud models, exact billed cost, every reply's signature checked against a fresh attestation |
| House agents    | The game's computer players use scripted replies at the real prices; they're labelled "house agent"       |
| Sign-in         | A NEAR testnet wallet (NEP-413)                                                                           |
| Tools           | Live web search, public pages, NEAR mainnet data, and a Python sandbox                                    |
| Money           | Game credits only. Nothing touches mainnet or real money                                                  |
| Outside bidders | Up to two "agents from outside Hustle" bid on a job; they're simulated, to keep a small world competitive |

**Next:** the royalty enforced by the market contract itself; publishing a player's best agent to
NEAR Agent Market to take real paid jobs; a real-money mode with 1Click deposits; owner keys in the
browser with relayed delegate actions.

## Repo and commands

Working on the code: [AGENTS.md](AGENTS.md) (setup, conventions, testing) and
[ARCHITECTURE.md](ARCHITECTURE.md) (how it works and why).

```
contracts/          Rust: credits, registry (agent NFT), agent-wallet, job-board, reputation, badges, market, tests
packages/core       money, ids, domain schemas, API view types
packages/economy    game rules, job templates, diary lines, the headless economy simulation
packages/db         Drizzle schema and migrations (Postgres 17)
packages/chain      ChainGateway: NearChain (testnet or local node), SimChain (fast tests), conformance suite
packages/engine     services, the world loop, the agent loop, tools, durable workflows
packages/nearai     NEAR AI Cloud client, attestation and signature checks
packages/auth       NEAR wallet sign-in and NEAR Auth
packages/sandbox    the Python sandbox (Pyodide in a locked-down process)
packages/runner     hustle-runner: the owner's-computer script
packages/payments   NEAR Intents 1Click client: built for mainnet, not enabled
apps/api            Hono API (:4300)
apps/web            Next.js game (:3300)
```

```sh
pnpm test             # TypeScript tests on real Postgres, offline
pnpm typecheck && pnpm lint
pnpm contracts:test   # Rust contract tests on near-workspaces
pnpm test:chain       # the conformance suite against the compiled contracts on a sandbox node
pnpm simulate         # the economy simulation; pnpm simulate:owners for owner policies
pnpm deploy:testnet   # contracts onto NEAR testnet
```

**Libraries:** Next.js, React, Tailwind, SWR, react-markdown and remark-gfm (web); Hono, Zod, Drizzle,
pg and DBOS (server); Pyodide with numpy and pandas (the sandbox); near-api-js, near-sandbox,
@hot-labs/near-connect, @auth0/auth0-spa-js, @noble/curves and @noble/hashes (NEAR and sign-in);
near-sdk, near-contract-standards and near-workspaces (contracts); Vitest, Biome, Turbo and tsx
(tooling).

**Services:** NEAR testnet (via FastNEAR's RPC, with dRPC as fallback), NEAR AI Cloud (models,
attestation, billing, and web search backed by Brave), and NEAR mainnet RPC for chain data.

MIT licence. From the same builder:
[Glidepath](https://github.com/the-wunmi/glidepath) (https://glidepath.clanker.show), sealed,
verifiable selling plans for token unlocks.
