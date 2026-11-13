import type { ManagedCohortView } from '@hustle/core';
import { describe, expect, it } from 'vitest';
import { type ManagerPolicy, simulateEconomy } from '../src/simulate.ts';

/**
 * The balance targets, checked by running the headless economy: if a tuning
 * change breaks one, this fails before any player notices.
 */
describe('headless economy simulation', () => {
  const runs = [7, 42, 99].map((seed) => simulateEconomy({ seed, agents: 240, days: 14 }));
  const tier = (r: (typeof runs)[number], t: string) => r.tiers.find((x) => x.tier === t)!;

  it('is deterministic for a seed', () => {
    expect(simulateEconomy({ seed: 3, agents: 60, days: 3 })).toEqual(
      simulateEconomy({ seed: 3, agents: 60, days: 3 }),
    );
  });

  it('a Standard brain is slightly profitable for the median agent', () => {
    // One seed's median swings by about a dollar, so the per-seed bar only catches a collapse.
    for (const r of runs)
      expect(BigInt(tier(r, 'standard').medianProfit)).toBeGreaterThan(-300_000n);
    const total = runs.reduce((s, r) => s + BigInt(tier(r, 'standard').medianProfit), 0n);
    expect(total).toBeGreaterThan(0n);
  });

  it('a Premium brain earns the best ratings but most Premium agents do not survive', () => {
    for (const r of runs) {
      expect(tier(r, 'premium').avgRating100).toBeGreaterThan(tier(r, 'standard').avgRating100);
      expect(tier(r, 'premium').survivalRate).toBeLessThan(tier(r, 'standard').survivalRate);
    }
  });

  it('a Budget brain earns the lowest ratings', () => {
    for (const r of runs)
      expect(tier(r, 'budget').avgRating100).toBeLessThan(tier(r, 'standard').avgRating100);
  });

  it('some agents go broke: the market is scarce', () => {
    for (const r of runs) expect(r.tiers.some((t) => t.survivalRate < 100)).toBe(true);
  });

  it('the rulebook blocks scams across the economy', () => {
    for (const r of runs) expect(r.totals.scamsBlocked).toBeGreaterThan(0);
  });
});

/**
 * Decisions must matter: the same worlds, with every fourth agent's calls
 * answered by a sharp, passive or reckless owner.
 */
describe('owners who answer their agent’s calls', () => {
  const seeds = [7, 42, 99];
  const cohort = (policy: ManagerPolicy) =>
    seeds.map((seed) => {
      const managed = simulateEconomy({
        seed,
        agents: 240,
        days: 14,
        managed: { every: 4, policy },
      }).managed;
      if (!managed) throw new Error('no managed cohort');
      return managed;
    });
  const sharp = cohort('sharp');
  const passive = cohort('passive');
  const reckless = cohort('reckless');
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const won = (c: ManagedCohortView[]) => sum(c.map((m) => m.contractsWon));
  const taken = (c: ManagedCohortView[]) => sum(c.map((m) => m.contractsTaken));

  it('sharp owners earn at least $2 more than passive ones, in every world', () => {
    seeds.forEach((_, i) => {
      expect(BigInt(sharp[i]!.medianProfit)).toBeGreaterThan(
        BigInt(passive[i]!.medianProfit) + 2_000_000n,
      );
    });
  });

  it('sharp agents outlive passive ones', () => {
    const survival = (c: ManagedCohortView[]) => sum(c.map((m) => m.survivalRate));
    expect(survival(sharp)).toBeGreaterThan(survival(passive) + 30);
  });

  it('sharp owners out-earn reckless ones in every world: saying yes to everything costs', () => {
    seeds.forEach((_, i) => {
      expect(BigInt(sharp[i]!.medianProfit)).toBeGreaterThan(BigInt(reckless[i]!.medianProfit));
    });
  });

  it('reckless owners lose at least half as much again to scams as sharp ones', () => {
    seeds.forEach((_, i) => {
      expect(BigInt(reckless[i]!.scamLosses) * 2n).toBeGreaterThan(
        BigInt(sharp[i]!.scamLosses) * 3n,
      );
    });
  });

  it('most contracts a sharp owner takes succeed; a reckless owner fails more of them', () => {
    expect(won(sharp) / taken(sharp)).toBeGreaterThan(0.8);
    expect(won(reckless) / taken(reckless)).toBeLessThan(won(sharp) / taken(sharp));
  });

  it('a passive owner never takes a contract: declining is the default', () => {
    expect(taken(passive)).toBe(0);
  });
});
