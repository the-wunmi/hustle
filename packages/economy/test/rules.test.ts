import { CATEGORIES, createRng, defaultRulebook, defaultStrategy, usd } from '@hustle/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BRAINS, DEFAULT_ECONOMY, eventForDay, VENDORS } from '../src/config.ts';
import { gradePractice, movePrice, PRICE_CEIL, scamJob, spawnClientJobs } from '../src/market.ts';
import {
  type AgentSnapshot,
  callCostMicro,
  callCostNano,
  decideBid,
  emptySkills,
  type JobSnapshot,
  levelForXp,
  pickWinner,
  scamSusceptibility,
  screenJobText,
  toolsFor,
} from '../src/rules.ts';

const agent = (over: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  id: 'a',
  ownerId: 'owner-a',
  traits: ['meticulous', 'charming'],
  specialty: 'summary',
  skills: emptySkills('summary', DEFAULT_ECONOMY),
  strategy: defaultStrategy('summary'),
  rulebook: defaultRulebook([]),
  balance: usd('2'),
  repXp: 0,
  avgRating100: null,
  dormant: false,
  busy: false,
  ...over,
});
const job = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({
  id: 'j',
  category: 'summary',
  source: 'client',
  budget: usd('0.40'),
  minLevel: 1,
  clientOwnerId: null,
  body: 'Summarise this.',
  scam: false,
  clientStyle: 'balanced',
  ...over,
});
const ctx = (seed = 1) => ({
  cfg: DEFAULT_ECONOMY,
  brain: DEFAULT_BRAINS.standard,
  vendors: VENDORS,
  rng: createRng(seed),
});

describe('economy rules', () => {
  it('costs follow NEAR AI Cloud prices exactly, rounded up', () => {
    // 1M input tokens at $0.04 is 40 000 micro-USD = 40 000 000 nano-USD.
    expect(callCostNano(DEFAULT_BRAINS.standard, 1_000_000, 0)).toBe(40_000_000n);
    expect(
      callCostMicro(DEFAULT_BRAINS.budget, { purpose: 'bid', inTokens: 1, outTokens: 0 }),
    ).toBe(1n);
  });

  it('an agent never bids on its own owner’s job', () => {
    expect(decideBid(agent(), job({ clientOwnerId: 'owner-a' }), ctx())).toEqual({
      bid: false,
      reason: 'self_dealing',
    });
  });

  it('dormant, busy and under-levelled agents do not bid', () => {
    expect(decideBid(agent({ dormant: true }), job(), ctx())).toMatchObject({ reason: 'dormant' });
    expect(decideBid(agent({ busy: true }), job(), ctx())).toMatchObject({ reason: 'busy' });
    expect(decideBid(agent(), job({ minLevel: 3 }), ctx())).toMatchObject({ reason: 'level' });
  });

  it('bold agents reach one level above their own', () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      decideBid(agent({ traits: ['bold', 'charming'] }), job({ minLevel: 2 }), ctx(i)),
    );
    expect(results.some((r) => r.bid)).toBe(true);
  });

  it('a bid never exceeds the budget and never undercuts cost for a careful agent', () => {
    for (let i = 0; i < 30; i++) {
      const d = decideBid(
        agent({ strategy: { ...defaultStrategy('summary'), priceStyle: 'undercut' } }),
        job(),
        ctx(i),
      );
      if (d.bid) {
        expect(d.price).toBeLessThanOrEqual(usd('0.40'));
        expect(d.price).toBeGreaterThan(0n);
      }
    }
  });

  it('screening catches the scam templates and passes honest posts', () => {
    for (let i = 0; i < 20; i++)
      expect(screenJobText(scamJob(createRng(i)).body).flagged).toBe(true);
    const honest = spawnClientJobs(createRng(5), {
      cfg: { ...DEFAULT_ECONOMY, scamShare: 0, jobsPerAgentTick: 1 },
      activeAgents: 40,
      event: null,
      sponsorRemaining: {},
      dayTicks: 180,
    });
    expect(honest.length).toBeGreaterThan(10);
    for (const d of honest) expect(screenJobText(d.body).flagged).toBe(false);
  });

  it('a screening agent declines a scam without paying to think about it', () => {
    const d = decideBid(
      agent({ strategy: { ...defaultStrategy('summary'), screenJobs: true } }),
      job({ body: scamJob(createRng(3)).body, category: 'summary' }),
      ctx(),
    );
    expect(d).toEqual({ bid: false, reason: 'screened' });
  });

  it('skeptical premium agents fall for scams far less than fast-and-loose budget ones', () => {
    expect(
      scamSusceptibility(agent({ traits: ['skeptical', 'meticulous'] }), 'premium'),
    ).toBeLessThan(0.1);
    expect(
      scamSusceptibility(agent({ traits: ['fast_and_loose', 'bold'] }), 'budget'),
    ).toBeGreaterThan(0.9);
  });

  it('price-first clients pick the cheaper of two equal agents', () => {
    const bids = [
      { agentId: 'cheap', price: usd('0.20'), avgRating100: 400, charming: false },
      { agentId: 'dear', price: usd('0.40'), avgRating100: 400, charming: false },
    ];
    const wins = Array.from(
      { length: 20 },
      (_, i) => pickWinner(bids, usd('0.40'), 'price', createRng(i))?.agentId,
    );
    expect(wins.filter((x) => x === 'cheap').length).toBeGreaterThan(15);
  });

  it('levels follow the XP thresholds', () => {
    expect(levelForXp(0, DEFAULT_ECONOMY)).toBe(1);
    expect(levelForXp(60, DEFAULT_ECONOMY)).toBe(2);
    expect(levelForXp(10_000, DEFAULT_ECONOMY)).toBe(5);
  });

  it('practice answers are graded against the key', () => {
    expect(
      gradePractice('The bakery will close in August for renovation and reopen.', [
        'bakery',
        'close',
        'august',
        'renovat',
        'reopen',
      ]),
    ).toBe(5);
    expect(gradePractice('nothing useful', ['bakery', 'close'])).toBe(1);
  });

  it('prices rise when few agents bid, fall when many do, and drift back to normal', () => {
    expect(movePrice(100, 0)).toBeGreaterThan(100);
    expect(movePrice(100, 6)).toBeLessThan(100);
    let p = 100;
    for (let i = 0; i < 200; i++) p = movePrice(p, 1);
    expect(p).toBeLessThanOrEqual(PRICE_CEIL);
    let q = 170;
    for (let i = 0; i < 300; i++) q = movePrice(q, 2);
    expect(q).toBeLessThan(170);
  });

  it('day one is quiet; events rotate after it', () => {
    expect(eventForDay(1)).toBeNull();
    expect(eventForDay(2)?.id).toBe('translation-rush');
  });
});

describe('tools an agent buys by itself', () => {
  it('never include a specialist or a scam, whatever the category', () => {
    for (const category of CATEGORIES) {
      const tools = toolsFor(
        agent({ specialty: category }),
        job({ category, budget: usd('2') }),
        VENDORS,
      );
      for (const t of tools) {
        const v = VENDORS.find((x) => x.handle === t.handle);
        expect(v?.specialist ?? false).toBe(false);
        expect(v?.scam).toBe(false);
      }
    }
  });
});

describe('first-job (rookie) clients', () => {
  const marketCtx = (activeAgents: number) => ({
    cfg: DEFAULT_ECONOMY,
    activeAgents,
    event: null,
    sponsorRemaining: {},
    dayTicks: 180,
  });
  const rookies = (activeAgents: number) => {
    const rng = createRng(11);
    let n = 0;
    for (let t = 0; t < 400; t++)
      n += spawnClientJobs(rng, marketCtx(activeAgents)).filter((d) => d.rookie).length;
    return n;
  };

  it('appear in a small world and fade out in a big one', () => {
    expect(rookies(12)).toBeGreaterThan(0);
    expect(rookies(60)).toBe(0);
  });

  it('take only level-1 agents', () => {
    const veteran = agent({ repXp: 500 });
    const decision = decideBid(veteran, job({ rookie: true }), ctx(3));
    expect(decision).toMatchObject({ bid: false, reason: 'level' });
  });
});
