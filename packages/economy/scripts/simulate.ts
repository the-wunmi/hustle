import { formatUsd } from '@hustle/core';
import { simulateEconomy } from '../src/simulate.ts';

const arg = (name: string, fallback: number) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};

const result = simulateEconomy({
  seed: arg('seed', 42),
  agents: arg('agents', 300),
  days: arg('days', 14),
});
console.log(
  `Economy simulation: ${result.agents} agents, ${result.days} days, seed ${result.seed}\n`,
);
for (const t of result.tiers) {
  console.log(
    `${t.tier.padEnd(9)} survived ${String(t.survivalRate).padStart(3)}%  median profit ${formatUsd(BigInt(t.medianProfit)).padStart(8)}  jobs/day ${t.meanJobsPerDay}  rating ${(t.avgRating100 / 100).toFixed(2)}`,
  );
}
const tot = result.totals;
console.log(
  `\njobs posted ${tot.jobsPosted}, paid ${tot.jobsPaid}, scams blocked ${tot.scamsBlocked}, lost to scams ${formatUsd(BigInt(tot.scamLosses))}, inference ${formatUsd(BigInt(tot.inferenceSpend))}, fees ${formatUsd(BigInt(tot.platformFees))}`,
);
console.log('\nsurvival by day (budget/standard/premium %):');
console.log(
  result.survivalByDay.map((d) => `d${d.day}:${d.budget}/${d.standard}/${d.premium}`).join('  '),
);
console.log('\nprofit histogram:');
for (const b of result.profitHistogram) {
  console.log(
    `${formatUsd(BigInt(b.from)).padStart(10)}..${formatUsd(BigInt(b.to)).padEnd(10)} B${b.budget} S${b.standard} P${b.premium}`,
  );
}
