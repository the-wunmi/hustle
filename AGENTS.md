# AGENTS.md

## Project overview

Hustle is a browser game on NEAR in which each player raises an AI agent that has to earn its own
living: it bids on jobs, pays for every model call from its own wallet, gets rated and paid, and
sleeps when broke. Each agent is an NFT that is its own NEAR account, so it can be sold with its
wallet and record.

- TypeScript monorepo (pnpm workspaces + Turbo): a Hono API with the game's world loop, a Next.js web
  app, and Postgres via Drizzle. Durable operations run as DBOS workflows.
- Seven Rust contracts on NEAR (near-sdk 5.30): credits, the agent NFT registry, each agent's wallet,
  the job board, reputation, badges and the market.
- Agents think with NEAR AI Cloud models; their code runs in a Pyodide sandbox.

Read [README.md](README.md) for the product and [ARCHITECTURE.md](ARCHITECTURE.md) for how and why it
works the way it does.

## Setup

Needs Node 24+, pnpm 11 or newer (`corepack enable` installs the pinned version) and Docker running.

```sh
pnpm run setup   # install, create .env from .env.example (generates HUSTLE_SECRET), start Postgres, migrate
pnpm dev         # local NEAR node :3330, API :4300, web :3300
```

The defaults run everything locally. `.env.example` documents every variable. For local testing set
`AUTH_MODE=mock` (stand-in sign-in); set `NEARAI_API_KEY` for live models (otherwise agents use
scripted replies).

## Commands

```sh
pnpm test             # all TypeScript tests (real Postgres, offline stand-ins for chain, AI and auth)
pnpm typecheck
pnpm lint             # Biome (format + lint); `pnpm format` to fix formatting
pnpm contracts:test   # Rust contract tests (needs Rust, wasm32-unknown-unknown, cargo-near)
pnpm test:chain       # conformance suite against the compiled contracts on a sandbox node
bash scripts/build-contracts.sh   # rebuild contracts/out/*.wasm
pnpm reset            # fresh world (stop pnpm dev first)
pnpm simulate         # economy simulation; pnpm simulate:owners for owner policies
pnpm deploy:testnet --plan   # what a testnet deploy would send and cost
pnpm verify           # read-only check of the live world against testnet and NEAR AI Cloud
```

Run a single package's tests with `pnpm --filter @hustle/<package> test` (for example `engine`,
`chain`, `sandbox`).

## Testing

- Before committing: `pnpm typecheck`, `pnpm lint` and `pnpm test` must pass. Run
  `pnpm contracts:test` and `pnpm test:chain` when you touch `contracts/` or `packages/chain`.
- Tests use real Postgres test databases and pin `CHAIN_MODE=sim`, `AUTH_MODE=mock` and
  `NEARAI_MODE=mock`; they never call live services. `pnpm test:chain` needs `NEAR_SANDBOX_TESTS=1`
  (the script sets it).
- Add a test with every behaviour change. The engine's crash tests kill real processes: keep new
  workflows covered there when they move money.

## Code style

- TypeScript, strict, with `noUncheckedIndexedAccess`; ES modules; Biome formatting (2 spaces, line
  width 100, single quotes, semicolons).
- Money is integer micro-USD (`bigint`, helpers in `packages/core`), never floating point.
- Validate input at the edges with Zod schemas from `packages/core`.
- Comments explain why, not what, and must stay true when the code changes.
- User-facing copy: plain and specific, and say "contracts", not "smart contracts". Label anything
  simulated, once, where it's used.

## Project structure

```
apps/api            Hono API (:4300): routes, sessions, SSE feed
apps/web            Next.js game (:3300)
packages/engine     services, the world loop, the agent loop, tools, DBOS workflows
packages/economy    pure game rules, job templates, the simulation (numbers in src/config.ts)
packages/chain      ChainGateway: NearChain (local node or testnet), SimChain (tests), conformance suite
packages/core       money, ids, schemas, API view types
packages/db         Drizzle schema and migrations
packages/nearai     NEAR AI Cloud client and attestation checks
packages/auth       NEAR wallet sign-in, NEAR Auth, the stand-in
packages/sandbox    Pyodide sandbox
packages/runner     hustle-runner.mjs (an owner's computer)
packages/payments   1Click client, built for mainnet and not enabled
contracts/          Rust contracts and their integration tests
examples/           sample files for the README walkthrough
```

## Conventions and gotchas

- **The chain is the source of truth for money and rules.** Every payment goes through the agent's
  wallet contract; the database is the game's view of it.
- **Chain calls are keyed and happen once per key.** Give every new chain effect a deterministic key,
  and read the job's state on chain before acting.
- **Durable operations are DBOS workflows** (`packages/engine/src/durable.ts`). Import new ones in
  `src/workflows.ts`, and bump `WORKFLOW_VERSION` when a workflow's steps change order.
- **One serial lane** runs ticks and player actions; slow provider work belongs in the background pool
  (`world/background.ts`), not on the lane.
- **Migrations:** add a new numbered migration (`pnpm db:generate`); never edit one that has shipped.
- **Wallet contract changes** reach only agents minted afterwards (wallets are keyless); locally, run
  `pnpm reset`.
- **New agent capability is a new tool** (economy `tools.ts` spec plus an engine runner), never a new
  job type.
- **One engine per testnet world:** the engine refuses `CHAIN_MODE=testnet` outside production unless
  `HUSTLE_LIVE_WORLD=1`. Use the local node for development.
- **Docker:** the Compose project is `hustle`; set `COMPOSE_PROJECT_NAME` in `.env` for a second copy.
  Stop dev servers by PID, not by pattern-matching process names.

## Security

- Secrets live in `.env` only (`HUSTLE_SECRET`, testnet keys, the NEAR AI key); never print, log or
  commit them.
- No real money and no mainnet: amounts are game credits, and mainnet is refused in the deploy and the
  engine.
- Agents' code runs only in the sandbox (a locked-down process; on a server its own container with no
  network). Never run model-written code in the API process or the browser page.
- Treat job briefs, client files and fetched pages as untrusted input to the model: tools that reach
  out (fetch, payments) are limited by code and by the wallet, not by the prompt.

## Commits and pull requests

- Commit only when asked. No attribution trailers in commit messages.
- Keep `README.md`, `ARCHITECTURE.md` and this file current when behaviour changes.
