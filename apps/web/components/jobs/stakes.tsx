'use client';

import type { JobView } from '@hustle/core/browser';
import { useWorld } from '@/lib/api';
import { fmt, upkeepDays } from '@/lib/money';
import { Badge, Panel } from '../ui';

type Tone = 'good' | 'bad' | 'neutral' | 'shield' | 'coin' | 'brand' | 'warn';

const SETTLEMENT_STYLE: Record<
  NonNullable<JobView['settlement']>['kind'],
  { tone: Tone; box: string; icon: string }
> = {
  paid: { tone: 'good', box: 'border-good/40 bg-good-soft', icon: '✓' },
  paid_after_dispute: { tone: 'shield', box: 'border-shield bg-shield-soft', icon: '⚖' },
  refunded: { tone: 'bad', box: 'border-bad/40 bg-bad-soft', icon: '↩' },
  outside: { tone: 'neutral', box: 'border-line bg-surface-2', icon: '↗' },
  expired: { tone: 'neutral', box: 'border-line bg-surface-2', icon: '⏱' },
  cancelled: { tone: 'neutral', box: 'border-line bg-surface-2', icon: '✕' },
};

const _SETTLEMENT_LABEL: Record<NonNullable<JobView['settlement']>['kind'], string> = {
  paid: 'Paid',
  paid_after_dispute: 'Paid after a dispute',
  refunded: 'Refunded',
  outside: 'Went outside Hustle',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/** How the job ended, in the API's own words. A dispute the arbiter paid is spelled out. */
export function SettlementCard({ job }: { job: JobView }) {
  const s = job.settlement;
  if (!s) return null;
  const style = SETTLEMENT_STYLE[s.kind];
  return (
    <section
      aria-label="How this job settled"
      className={`rounded-2xl border-2 p-4 sm:p-5 ${style.box}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden="true" className="font-display text-xl font-extrabold">
          {style.icon}
        </span>
        <h2 className="font-display text-xl font-extrabold">{s.title}</h2>
      </div>
      {/* The API's detail already explains the arbiter's rule and the bar, so nothing is added. */}
      <p className="mt-1 text-ink-2">{s.detail}</p>
      {job.outsideWinner && (
        <p className="mt-2 text-sm font-semibold">
          Won by an agent from outside Hustle at {fmt(job.outsideWinner.price)}.
        </p>
      )}
    </section>
  );
}

const BOND_STATUS: Record<
  NonNullable<JobView['contract']>['bondStatus'],
  { label: string; tone: Tone; text: string }
> = {
  held: {
    label: 'Held',
    tone: 'warn',
    text: 'Held by the game’s treasury until the client rates. It comes back with the payout if the work clears the client’s bar.',
  },
  returned: {
    label: 'Returned',
    tone: 'good',
    text: 'The work cleared the client’s bar, so the bond came back with the payout.',
  },
  forfeited: {
    label: 'Forfeited',
    tone: 'bad',
    text: 'The work fell short of the client’s bar, so the bond went to the client as damages.',
  },
  none: {
    label: 'No bond',
    tone: 'neutral',
    text: 'No bond was put up for this contract.',
  },
};

/**
 * What is riding on this job beyond the price: a contract's bond, the specialist data it needs,
 * and a 5★ tip. Nothing renders for an ordinary job.
 */
export function StakesPanel({ job }: { job: JobView }) {
  const { data: world } = useWorld();
  const upkeep = world?.economy.upkeepPerDay;
  const { contract, specialist, tip } = job;
  if (!contract && !specialist && !tip) return null;
  const local = world?.modes.chain === 'sandbox';
  return (
    <Panel title={contract ? `Contract, tier ${contract.tier}` : 'What’s riding on it'}>
      <div className="space-y-4">
        {contract && (
          <div>
            <p className="text-sm text-ink-2">
              A contract comes from a picky client: below 4★ it disputes, and the arbiter refunds
              work under the bar. Losing one also ends the agent’s streak.
            </p>
            <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm text-muted">Bond</span>
              <span className="font-display text-2xl font-extrabold tnum">
                {fmt(contract.bond)}
              </span>
              {upkeepDays(contract.bond, upkeep) && (
                <span className="text-sm text-muted">{upkeepDays(contract.bond, upkeep)}</span>
              )}
              <Badge tone={BOND_STATUS[contract.bondStatus].tone}>
                {BOND_STATUS[contract.bondStatus].label}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-ink-2">{BOND_STATUS[contract.bondStatus].text}</p>
            <p className="mt-1 text-xs text-muted">
              {local
                ? 'The bond is held by the game’s treasury account on the local NEAR node and returned with the payout.'
                : 'The bond is held by the game’s treasury and returned with the payout.'}
            </p>
          </div>
        )}
        {specialist && (
          <div className={contract ? 'border-t border-line pt-4' : ''}>
            <p className="flex flex-wrap items-center gap-2 font-semibold">
              Needs specialist data: {specialist.name}
              <span className="text-sm font-normal text-muted tnum">
                {fmt(specialist.price)}
                {upkeepDays(specialist.price, upkeep)
                  ? `, ${upkeepDays(specialist.price, upkeep)}`
                  : ''}
              </span>
              {specialist.used === 'bought' && <Badge tone="good">Bought</Badge>}
              {specialist.used === 'missing' && <Badge tone="bad">Went without</Badge>}
            </p>
            <p className="mt-1 text-sm text-ink-2">
              {specialist.used === 'bought'
                ? 'The agent paid for the data, so the work gets the quality the client expects.'
                : specialist.used === 'missing'
                  ? 'The agent did the work without it. Quality drops, and with it the rating: a dispute becomes more likely.'
                  : 'Without this data the work loses quality, enough to risk a dispute.'}
            </p>
          </div>
        )}
        {tip && (
          <p className="rounded-xl bg-coin/20 px-3 py-2 font-semibold">
            🪙 Client tipped {fmt(tip)} for 5★ work
            {upkeepDays(tip, upkeep) ? (
              <span className="font-normal text-ink-2"> ({upkeepDays(tip, upkeep)})</span>
            ) : null}
            .
          </p>
        )}
      </div>
    </Panel>
  );
}
