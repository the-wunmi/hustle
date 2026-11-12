'use client';

import {
  type AgentSummaryView,
  CATEGORY_LABEL,
  type HolderView,
  TIER_LABEL,
} from '@hustle/core/browser';
import type { ReactNode } from 'react';
import { Badge, ButtonLink, Empty, ErrorNote, Loading, Panel } from '@/components/ui';
import { ApiError, errorText, useApi } from '@/lib/api';
import { fmt } from '@/lib/money';

const PRICE_STYLE: Record<HolderView['strategy']['priceStyle'], string> = {
  undercut: 'Undercut rivals',
  fair: 'Fair price',
  premium: 'Charge a premium',
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-line/60 py-1.5 last:border-0">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-right font-semibold">{children}</dd>
    </div>
  );
}

/** The refusal shown to anyone who isn't the NFT's holder, with the API's reason. */
function NotHolder({ id, error }: { id: string; error: unknown }) {
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="sticker p-6">
        <h1 className="font-display text-2xl font-extrabold">
          This console is for the holder only
        </h1>
        <p className="mt-2 text-ink-2">You don't hold this agent's NFT. {errorText(error)}</p>
        <p className="mt-2 text-sm text-muted">
          The page checks the registry on chain each time it loads, so being signed in isn't enough:
          only the account that holds the NFT gets in.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <ButtonLink href={`/agents/${id}`}>Its public page</ButtonLink>
          <ButtonLink href={`/agents/${id}?tab=ownership`} variant="ghost">
            NFT history
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}

/** The holder-only console: the chain's NFT owner is checked on every load, not just the session. */
export function HolderConsole({ id }: { id: string }) {
  const { data, error, isLoading, mutate } = useApi<HolderView>(`/api/agents/${id}/holder`, {
    shouldRetryOnError: false,
  });

  if (isLoading) return <Loading label="Checking the holder on chain" rows={4} />;
  if (error instanceof ApiError && (error.status === 403 || error.status === 401)) {
    return <NotHolder id={id} error={error} />;
  }
  if (error instanceof ApiError && error.status === 404) {
    return <Empty title="Agent not found">There's no agent with that id.</Empty>;
  }
  if (error) return <ErrorNote error={error} retry={() => void mutate()} />;
  if (!data) return null;

  const a: AgentSummaryView = data.agent;
  const w = data.wallet;
  const r = data.rulebook;
  const st = data.strategy;

  return (
    <div className="space-y-6">
      <p className="text-sm text-ink-2">
        Only the account that holds {a.name}'s NFT sees this. The registry is checked on chain every
        time it loads, not just your session.
      </p>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Who holds it">
          <dl>
            <Row label="Holder on chain">
              <span className="break-all">{data.chainOwner}</span>
            </Row>
            <Row label="Agent account">
              <span className="break-all">{a.accountId}</span>
            </Row>
          </dl>
        </Panel>

        <Panel title="Wallet">
          <dl>
            <Row label="Balance">
              <span className="tnum">{fmt(w.balance)}</span>
            </Row>
            <Row label="State">
              {w.frozen ? <Badge tone="warn">Frozen</Badge> : <Badge tone="good">Active</Badge>}
            </Row>
            <Row label="Spent today">
              <span className="tnum">{fmt(w.spentToday)}</span>
            </Row>
            <Row label="Rotation number">
              <span className="tnum">{w.rotationSeq}</span>
            </Row>
          </dl>
          <p className="mt-2 text-xs text-muted">
            The rotation number goes up each time the NFT changes hands. The wallet only takes
            orders signed for the current number, so a past holder can't steer it.
          </p>
          <h3 className="mt-4 mb-1 text-sm font-semibold">Payments held for your approval</h3>
          {w.pending.length === 0 ? (
            <p className="text-sm text-ink-2">None.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {w.pending.map((p) => (
                <li key={p.requestId} className="flex flex-wrap justify-between gap-2">
                  <span>
                    {fmt(p.amount)} to <span className="break-all">{p.receiver}</span>
                  </span>
                  <span className="text-muted">{p.reason.replaceAll('_', ' ')}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Rulebook (enforced by the wallet)">
          <dl>
            <Row label="Daily spending cap">
              <span className="tnum">{fmt(r.dailyCap)}</span>
            </Row>
            <Row label="Most per job">
              <span className="tnum">{fmt(r.maxPerJob)}</span>
            </Row>
            <Row label="Most per payment">
              <span className="tnum">{fmt(r.maxPerCall)}</span>
            </Row>
            <Row label="Hiring">{r.mayHire ? `Up to ${fmt(r.helperBudget)} a job` : 'Off'}</Row>
            <Row label="May pay">
              {r.anyVendor
                ? 'Any vendor (loose)'
                : r.allowedVendors.map((v) => v.split('.')[0]).join(', ') || 'No vendors'}
            </Row>
          </dl>
        </Panel>

        <Panel title="Private strategy">
          <dl>
            <Row label="Focus">
              {st.focus.length
                ? st.focus.map((c) => CATEGORY_LABEL[c]).join(', ')
                : 'Anything it can do'}
            </Row>
            <Row label="Pricing">{PRICE_STYLE[st.priceStyle]}</Row>
            <Row label="Sponsor jobs">{st.sponsorJobs ? 'Yes' : 'No'}</Row>
            <Row label="Screens posts for payment requests">{st.screenJobs ? 'Yes' : 'No'}</Row>
          </dl>
        </Panel>

        <Panel title="Brain">
          <dl>
            <Row label="Tier">{TIER_LABEL[data.brain.tier]}</Row>
            <Row label="Model">
              <span className="break-all">{data.brain.model}</span>
            </Row>
            <Row label="Its own NEAR AI key">
              {data.brain.keyId ? (
                <span className="break-all">
                  {data.brain.keyId === 'org-key' ? "No: the game's shared key" : data.brain.keyId}
                </span>
              ) : (
                'None yet'
              )}
            </Row>
            <Row label="Key sealed on the server">
              {data.brain.keySealed ? <Badge tone="good">Yes</Badge> : <Badge>No</Badge>}
            </Row>
          </dl>
        </Panel>

        <Panel title="Notes">
          {data.notes.length === 0 ? (
            <p className="text-sm text-ink-2">No notes.</p>
          ) : (
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-2">
              {data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
