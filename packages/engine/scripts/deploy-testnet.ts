import { fileURLToPath } from 'node:url';
import {
  checkAffordable,
  estimateCost,
  formatNear,
  freeBalance,
  JsonRpcProvider,
  NearChain,
  readTestnetTarget,
  type TestnetTarget,
  verifyChain,
} from '@hustle/chain';
import { HOUSE_PLAYERS, RIVALS } from '@hustle/economy';
import { chainSetup, DEFAULT_DAY_TICKS, DEFAULT_TICK_MS } from '../src/context.ts';

/**
 * `pnpm deploy:testnet`: deploys and sets up the six contracts under NEAR_TESTNET_ACCOUNT_ID through
 * `NearChain.ensureSetup` (the same steps the local node gets on first boot), after printing what it
 * will cost and checking the account can pay. Safe to rerun: finished steps are skipped.
 *
 *   --plan            print the steps and the estimate, send nothing
 *   --dry-run-local   rehearse against a sandbox node on this machine (NEAR_RPC_URL=http://127.0.0.1:…)
 */

const USAGE = 'Usage: pnpm deploy:testnet [--plan] [--dry-run-local]';
const FLAGS = new Set(['--plan', '--dry-run-local']);
/** House accounts the game creates on first boot (clients, sponsors). */
const HOUSE_ACCOUNTS = 2;
const WASM_DIR = fileURLToPath(new URL('../../../contracts/out/', import.meta.url));

const args = process.argv.slice(2).filter((a) => a !== '--');
const unknown = args.filter((a) => !FLAGS.has(a));
if (unknown.length > 0) {
  console.error(`Unknown option ${unknown.join(' ')}. ${USAGE}`);
  process.exit(2);
}
const planOnly = args.includes('--plan');
const dryRunLocal = args.includes('--dry-run-local');

let target: TestnetTarget | null = null;
try {
  target = readTestnetTarget(process.env, { dryRunLocal });
  await deploy(target);
} catch (err) {
  console.error(`\nStopped: ${redact(err instanceof Error ? err.message : String(err), target)}`);
  process.exit(1);
}

async function deploy(target: TestnetTarget): Promise<void> {
  const root = target.accountId;
  const { chainId } = await verifyChain(target);
  console.log(
    `${dryRunLocal ? 'DRY RUN on a local sandbox node' : 'NEAR testnet'}: ${target.rpcUrl} (chain ${chainId})`,
  );
  console.log(`Root account: ${root}\n`);

  const provider = new JsonRpcProvider({ url: target.rpcUrl });
  const rootAccount = await provider.viewAccount({ accountId: root }).catch(() => {
    throw new Error(`${root} does not exist on this chain; create it first (see README)`);
  });
  const dayMs =
    Number(process.env.DAY_TICKS ?? DEFAULT_DAY_TICKS) *
    Number(process.env.TICK_MS ?? DEFAULT_TICK_MS);
  const setup = chainSetup(dayMs);
  const chain = new NearChain({
    rpcUrl: target.rpcUrl,
    root,
    funderId: root,
    funderKey: target.key.reveal(),
    // A dry run uses testnet's funding, so it measures what testnet will cost.
    network: 'testnet',
    wasmDir: WASM_DIR,
  });

  const planned = await chain.planSetup(setup);
  const gasPrice = BigInt((await provider.viewGasPrice()).gas_price);
  const cost = estimateCost(planned, gasPrice);
  const free = freeBalance(rootAccount);
  if (planned.length === 0) {
    console.log('Everything is already deployed and set up; nothing to send.');
  } else {
    console.log(`${planned.length} steps to run:`);
    for (const step of planned) {
      console.log(`  - ${step.label}${step.spend > 0n ? ` (${formatNear(step.spend)} NEAR)` : ''}`);
    }
    console.log(
      `\nEstimate: ${formatNear(cost.spend)} NEAR into accounts and deposits, at most ${formatNear(cost.gasFee)} NEAR of gas.`,
    );
    console.log(
      `Needs ${formatNear(cost.required)} NEAR free (with margin); ${root} has ${formatNear(free)} NEAR free.`,
    );
    checkAffordable(root, free, cost);
  }
  if (planOnly) return;

  const sent = await chain.ensureSetup(setup);
  const after = freeBalance(await provider.viewAccount({ accountId: root }));
  await summary(chain, provider, target, sent, free - after);
}

async function summary(
  chain: NearChain,
  provider: JsonRpcProvider,
  target: TestnetTarget,
  sent: { label: string; txHash: string }[],
  spent: bigint,
): Promise<void> {
  const ids = chain.ids;
  console.log(`\nSent ${sent.length} transactions, spent ${formatNear(spent)} NEAR.`);
  for (const tx of sent) {
    const link = target.dryRunLocal ? '' : `  https://testnet.nearblocks.io/txns/${tx.txHash}`;
    console.log(`  ${tx.txHash}  ${tx.label}${link}`);
  }

  console.log('\nAccounts:');
  const rows: [string, string][] = [
    ['root (owner of every contract)', ids.root],
    ['credits token', ids.credits],
    ['agent registry (NFTs)', ids.registry],
    ['job board', ids.jobs],
    ['reputation', ids.rep],
    ['badges', ids.badges],
    ['operator (game server)', ids.operator],
    ['treasury', ids.treasury],
    ['vendors', ids.vendors],
  ];
  for (const [what, accountId] of rows) {
    const account = await provider.viewAccount({ accountId });
    console.log(`  ${what.padEnd(31)} ${accountId.padEnd(40)} ${formatNear(account.amount)} NEAR`);
  }
  for (const code of await chain.contractCode()) {
    if (!code.current) {
      console.log(
        `  Note: ${code.accountId} holds an older build of ${code.wasm}; setup never redeploys over a live contract.`,
      );
    }
  }

  // The game's first boot mints the rival agents from the operator's balance.
  const config = await provider.callFunction({
    contractId: ids.registry,
    method: 'get_config',
    args: {},
  });
  const mintDeposit = BigInt((config as { mint_deposit: string }).mint_deposit);
  const operator = freeBalance(await provider.viewAccount({ accountId: ids.operator }));
  const rivalsCost = mintDeposit * BigInt(RIVALS.length);
  console.log(
    `\nEach agent minted costs ${formatNear(mintDeposit)} NEAR from ${ids.operator}. The game's first boot mints ${RIVALS.length} rivals (${formatNear(rivalsCost)} NEAR) and creates ${HOUSE_ACCOUNTS + HOUSE_PLAYERS.length} house accounts paid by ${ids.root}.`,
  );
  if (operator < rivalsCost) {
    console.log(
      `Warning: ${ids.operator} has ${formatNear(operator)} NEAR free; send it at least ${formatNear(rivalsCost - operator)} NEAR more before starting the game.`,
    );
  }

  if (target.dryRunLocal) {
    console.log('\nDry run finished. Nothing was sent to testnet.');
    return;
  }
  console.log(`
To run the game on this deployment, set in .env (the account and key are already there):

  CHAIN_MODE=testnet
  NEAR_RPC_URL=${target.rpcUrl}
  NEAR_TESTNET_ACCOUNT_ID=${ids.root}

For live agent thinking also set NEARAI_MODE=live and NEARAI_API_KEY. A database played on the local
node refuses to start on testnet: run \`pnpm reset\` first. Then \`pnpm dev\`.`);
}

/** Error text from libraries is printed, so the key is scrubbed from it in case one quoted it. */
function redact(message: string, target: TestnetTarget | null): string {
  const raw = process.env.NEAR_TESTNET_PRIVATE_KEY?.trim();
  const secrets = [target?.key.reveal(), raw, raw?.split(':')[1]].filter(
    (s): s is string => typeof s === 'string' && s.length >= 16,
  );
  return secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), message);
}
