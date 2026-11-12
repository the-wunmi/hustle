import { fileURLToPath } from 'node:url';
import {
  localNodeConfig,
  localRpcUrl,
  rpcStatus,
  runLocalNode,
  waitForNode,
} from '../src/local-node.ts';

// `pnpm dev` runs this: the local NEAR node the game plays on, with state kept in .near-sandbox/.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cfg = localNodeConfig(process.env, repoRoot);
const url = localRpcUrl(cfg);

const mode =
  process.env.CHAIN_MODE || (process.env.NEAR_TESTNET_ACCOUNT_ID ? 'testnet' : 'sandbox');
if (mode !== 'sandbox') {
  // On testnet (or the simulator) the game needs no local node: don't start one.
  console.log(`CHAIN_MODE=${mode}: no local NEAR node needed`);
  setInterval(() => undefined, 1 << 30);
} else if (await rpcStatus(url)) {
  console.log(`NEAR node already running at ${url}`);
  // Stay alive so the dev task doesn't end; the existing node keeps serving.
  setInterval(() => undefined, 1 << 30);
} else {
  const node = await runLocalNode(cfg);
  await waitForNode(url, 60_000);
  console.log(`NEAR node (local sandbox) at ${url}, state in ${cfg.home}`);
  const stop = () => {
    node.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  node.on('exit', (code) => {
    console.error(`NEAR node exited with ${code}; see ${cfg.home}/node.log`);
    process.exit(code ?? 1);
  });
}
