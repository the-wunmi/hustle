import { createSandbox } from '@hustle/sandbox';
import { describe, expect, it } from 'vitest';
import { instanceOf } from '../src/agents/challenges.ts';
import type { Engine } from '../src/context.ts';

/** Just what grading needs: the sandbox, run in this process as in development. */
const sandbox = createSandbox({});
const engine = { sandbox } as unknown as Engine;

/** Runs an independent solution on an instance's files and returns what it printed. */
async function solve(files: { name: string; content: string }[], code: string): Promise<string> {
  const out = await sandbox!.run({
    code,
    files: Object.fromEntries(files.map((f) => [f.name, f.content])),
  });
  expect(out.error).toBeNull();
  return out.stdout;
}

const RECONCILE = `
import pandas as pd
bank = pd.read_csv('bank.csv'); books = pd.read_csv('books.csv')
dup = books[books.duplicated('ref', keep='first')]
for ref in dup.ref: print(f'{ref} is duplicated in the books')
b = books.drop_duplicates('ref')
m = bank.merge(b, on='ref', how='left', suffixes=('_bank', '_books'))
for _, r in m[m.amount_books.isna()].iterrows(): print(f'{r.ref} missing from the books ({r.amount_bank:.2f})')
both = m.dropna(subset=['amount_books'])
for _, r in both[(both.amount_bank - both.amount_books).abs() > 0.001].iterrows():
    print(f'{r.ref} differs by {r.amount_books - r.amount_bank:.2f}')
print(f'net difference {bank.amount.sum() - books.amount.sum():.2f}')
`;

const HOLDERS = `
import pandas as pd
h = pd.read_csv('holders.csv').sort_values('balance', ascending=False)
supply = h.balance.sum()
print(f'top 10 hold {h.head(10).balance.sum() / supply * 100:.1f}%')
for _, r in h[h.balance / supply > 0.1].iterrows(): print(f'{r.account} holds {r.balance / supply * 100:.1f}%')
`;

describe('challenges are fresh problems graded by code', () => {
  it('the same seed makes the same problem; another seed a different one', () => {
    const a = instanceOf('reconciliation', 'seed-1');
    expect(instanceOf('reconciliation', 'seed-1')?.files).toEqual(a?.files);
    expect(instanceOf('reconciliation', 'seed-2')?.files).not.toEqual(a?.files);
  });

  it('reconciliation: a correct analysis passes every check; last time’s answer does not', async () => {
    for (const seed of ['r1', 'r2', 'r3']) {
      const inst = instanceOf('reconciliation', seed)!;
      const text = await solve(inst.files, RECONCILE);
      expect(await inst.grade(engine, { text, files: {} }), seed).toEqual({ passed: 4, checks: 4 });
    }
    const old = await solve(instanceOf('reconciliation', 'r1')!.files, RECONCILE);
    const fresh = instanceOf('reconciliation', 'r9')!;
    expect((await fresh.grade(engine, { text: old, files: {} })).passed).toBeLessThan(2);
  }, 120_000);

  it('token due diligence: the right shares pass; guesses fail', async () => {
    for (const seed of ['h1', 'h2', 'h3']) {
      const inst = instanceOf('token-holders', seed)!;
      const text = await solve(inst.files, HOLDERS);
      const graded = await inst.grade(engine, { text, files: {} });
      expect(graded.passed, `${seed}: ${text}`).toBe(graded.checks);
    }
    const inst = instanceOf('token-holders', 'h1')!;
    const guess = await inst.grade(engine, { text: 'top 10 hold 50%', files: {} });
    expect(guess.passed).toBeLessThan(guess.checks);
  }, 120_000);

  it('debugging: a real fix passes the visible and the hidden tests; the bug or a hard-coded fix does not', async () => {
    const inst = instanceOf('debugging', 'd1')!;
    const buggy = inst.files.find((f) => f.name === 'pricing.py')!.content;
    const from = Number(/units > (\d+)/.exec(buggy)![1]);
    const factor = /total \* ([\d.]+)/.exec(buggy)![1];
    const pct = Number(/total - (\d+)/.exec(buggy)![1]);
    const fixed = buggy
      .replace(`units > ${from}`, `units >= ${from}`)
      .replace(`total = total - ${pct}`, `total = total * (1 - ${pct} / 100)`);
    expect(fixed).toContain(factor);
    expect(await inst.grade(engine, { text: '', files: { 'pricing_fixed.py': fixed } })).toEqual({
      passed: 2,
      checks: 2,
    });
    expect(
      (await inst.grade(engine, { text: '', files: { 'pricing_fixed.py': buggy } })).passed,
    ).toBe(0);
    // A fix written as plain text in the delivery counts too.
    const prose = `Corrected price():\n${fixed}\nThat fixes both bugs.`;
    expect((await inst.grade(engine, { text: prose, files: {} })).passed).toBe(2);
    // Only the threshold fixed: the coupon checks still fail in both suites.
    const half = buggy.replace(`units > ${from}`, `units >= ${from}`);
    expect(
      (await inst.grade(engine, { text: '', files: { 'pricing_fixed.py': half } })).passed,
    ).toBe(0);
  }, 60_000);
});
