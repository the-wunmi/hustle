import { usd } from '@hustle/core';
import { jobs } from '@hustle/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chainJobState, houseAccount, openJob } from '../src/world/jobs.ts';
import { expireJob } from '../src/world/market.ts';
import { type World, world } from './harness.ts';

describe('expiring a job the chain shows as awarded', () => {
  let w: World;
  beforeAll(async () => {
    w = await world('expire');
  }, 60_000);
  afterAll(() => w?.close());

  it('reclaims the escrow once the delivery window has passed, instead of retrying a cancel forever', async () => {
    const job = await openJob(
      w.engine,
      { accountId: houseAccount(w.engine, 'clients'), playerId: null, autoAward: true },
      {
        source: 'client',
        category: 'summary',
        title: 'Expire test',
        body: 'Summarise this memo in three lines.',
        budget: usd('0.80'),
        minLevel: 1,
        clientName: 'Expire Co',
        clientStyle: 'balanced',
        scam: false,
        scamVendor: null,
        scamAmount: null,
        sponsorPoolId: null,
        answerKeywords: null,
      },
    );
    const [agentRow] = await w.engine.db.query.agents.findMany({ limit: 1 });
    // The award lands on chain, but the game's database never records it (a stalled write).
    await w.engine.chain.award(
      houseAccount(w.engine, 'clients'),
      job!.chainJobId!,
      agentRow!.accountId!,
      usd('0.50'),
    );
    expect(await chainJobState(w.engine, job!.chainJobId!)).toMatchObject({
      kind: 'live',
      status: 'awarded',
    });
    const [row] = await w.engine.db.select().from(jobs).where(eq(jobs.id, job!.id));
    expect(row!.status).toBe('open');

    // Inside the delivery window nothing can be reclaimed yet: the game retries later.
    await expireJob(w.engine, row!);
    expect(await chainJobState(w.engine, job!.chainJobId!)).toMatchObject({ status: 'awarded' });

    // Past it, the client reclaims the escrow and the job settles.
    w.engine.clock.tick += Math.ceil(86_400_000 / w.engine.tickMs) + 10;
    await expireJob(w.engine, row!);
    expect(await chainJobState(w.engine, job!.chainJobId!)).toMatchObject({
      kind: 'settled',
      settlement: 'reclaimed',
    });
  });
});
