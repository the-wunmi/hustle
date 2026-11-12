import { CATEGORY_LABEL, type Category } from '@hustle/core';
import { settings } from '@hustle/db';
import { movePrice } from '@hustle/economy';
import { eq } from 'drizzle-orm';
import type { Engine } from '../context.ts';
import { post } from '../record.ts';

const PRICES_KEY = 'prices';
/** Moves of this size (in index points from normal) are worth a line in the feed. */
const NEWS_STEPS = [20, 40, 60];
/** Within this many points of normal, a category counts as paying normally again. */
const NORMAL_BAND = 20;

export type Prices = Partial<Record<Category, number>>;

export async function loadPrices(engine: Engine): Promise<Prices> {
  const [row] = await engine.db.select().from(settings).where(eq(settings.key, PRICES_KEY));
  return (row?.value as Prices | undefined) ?? {};
}

const band = (p: number): number => {
  const gap = Math.abs(p - 100);
  return NEWS_STEPS.filter((s) => gap >= s).length * Math.sign(p - 100);
};

/**
 * Applies the auctions that closed this tick to the price index (bidders per client job), saves it,
 * and announces a category whose pay crossed a band, so players see the market move and can react.
 */
export async function applyAuctionResults(
  engine: Engine,
  closed: { category: Category; bidders: number }[],
): Promise<void> {
  if (closed.length === 0) return;
  const before = await loadPrices(engine);
  const after: Prices = { ...before };
  for (const c of closed) after[c.category] = movePrice(after[c.category] ?? 100, c.bidders);
  await engine.db
    .insert(settings)
    .values({ key: PRICES_KEY, value: after })
    .onConflictDoUpdate({ target: settings.key, set: { value: after, updatedAt: new Date() } });
  for (const [category, price] of Object.entries(after) as [Category, number][]) {
    const was = before[category] ?? 100;
    if (band(price) === band(was)) continue;
    const pct = Math.round(Math.abs(price - 100));
    const label = CATEGORY_LABEL[category];
    await post(engine, {
      kind: 'event',
      tone: price > 100 ? 'money' : 'neutral',
      text:
        Math.abs(price - 100) < NORMAL_BAND
          ? `${label} pays about normal again.`
          : price > 100
            ? `${label} pays ${pct}% more than usual: few agents are taking that work.`
            : `${label} pays ${pct}% less than usual: too many agents are chasing it.`,
    });
  }
}
