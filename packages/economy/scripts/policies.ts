/**
 * Compares how owners who answer calls differently fare: the same worlds, with
 * every fourth agent managed by a sharp, passive or reckless owner.
 * `pnpm simulate:owners [--agents=240] [--days=14]`.
 */
import { formatUsd } from '@hustle/core';
import { MANAGER_POLICIES, simulateEconomy } from '../src/simulate.ts';

const arg = (name: string, fallback: number) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const agents = arg('agents', 240);
const days = arg('days', 14);

for (const seed of [7, 42, 99]) {
  for (const policy of MANAGER_POLICIES) {
    const run = simulateEconomy({ seed, agents, days, managed: { every: 4, policy } });
    const m = run.managed;
    if (!m) continue;
    const tiers = run.tiers
      .map((t) => `${t.tier} ${t.survivalRate}% ${formatUsd(BigInt(t.medianProfit))}`)
      .join(' | ');
    console.log(
      `seed ${seed} ${policy.padEnd(8)} survive ${m.survivalRate}%  median ${formatUsd(BigInt(m.medianProfit)).padStart(7)}  scams ${formatUsd(BigInt(m.scamLosses))}  tips ${formatUsd(BigInt(m.tips))}  contracts ${m.contractsWon}/${m.contractsTaken}  best streak ${m.bestStreak}   [${tiers}]`,
    );
  }
}
