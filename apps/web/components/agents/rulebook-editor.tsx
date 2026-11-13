'use client';

import type { AgentView, RulebookView, VendorView } from '@hustle/core/browser';
import { useEffect, useId, useState } from 'react';
import { useSWRConfig } from 'swr';
import { post, useApi, useWorld } from '@/lib/api';
import { fmt, parseDollars, toDollarInput } from '@/lib/money';
import { useToast } from '../providers';
import { Badge, Button, Field, InlineError, inputClass, Panel, Switch } from '../ui';

interface Draft {
  dailyCap: string;
  maxPerJob: string;
  maxPerCall: string;
  helperBudget: string;
  allowedVendors: string[];
  anyVendor: boolean;
  mayHire: boolean;
}

const CAPS = [
  {
    key: 'dailyCap',
    label: 'Daily spending cap',
    hint: 'The most it can spend in one game day, on everything.',
  },
  {
    key: 'maxPerJob',
    label: 'Most per job',
    hint: 'Total it may spend on tools and helpers for a single job.',
  },
  {
    key: 'maxPerCall',
    label: 'Most per payment',
    hint: 'Any single payment above this is refused. Scams usually ask for one big payment.',
  },
  {
    key: 'helperBudget',
    label: 'Helper budget',
    hint: 'The most it may pay another agent per job without asking you.',
  },
] as const;

const toDraft = (r: RulebookView): Draft => ({
  dailyCap: toDollarInput(r.dailyCap),
  maxPerJob: toDollarInput(r.maxPerJob),
  maxPerCall: toDollarInput(r.maxPerCall),
  helperBudget: toDollarInput(r.helperBudget),
  allowedVendors: r.allowedVendors,
  anyVendor: r.anyVendor,
  mayHire: r.mayHire,
});

/**
 * Owner controls for the spending rules the agent's wallet account enforces. In `confirm` mode (a
 * newly bought agent), saving sends the rulebook with the new owner's confirmation, which is what
 * unfreezes the inherited wallet.
 */
export function RulebookEditor({
  agent,
  confirm = false,
}: {
  agent: AgentView;
  confirm?: boolean;
}) {
  const { data: vendors } = useApi<VendorView[]>('/api/vendors');
  const { data: world } = useWorld();
  const upkeep = world ? BigInt(world.economy.upkeepPerDay) : null;
  const saved = toDraft(agent.rulebook);
  const [draft, setDraft] = useState<Draft>(saved);
  const [busy, setBusy] = useState<'save' | 'freeze' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const baseId = useId();
  const savedKey = JSON.stringify(agent.rulebook);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the saved rulebook changes
  useEffect(() => {
    setDraft(toDraft(agent.rulebook));
  }, [savedKey]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const parsed = Object.fromEntries(CAPS.map((c) => [c.key, parseDollars(draft[c.key])])) as Record<
    (typeof CAPS)[number]['key'],
    string | null
  >;
  const fieldError = (key: (typeof CAPS)[number]['key']) => {
    if (parsed[key] === null) return 'Enter dollars, like 0.25';
    // Upkeep is one payment a day: a cap under it puts the agent to sleep at day end.
    if (
      (key === 'maxPerCall' || key === 'dailyCap') &&
      upkeep !== null &&
      BigInt(parsed[key] ?? '0') < upkeep
    )
      return `Can’t be under the ${fmt(upkeep)} daily upkeep, or ${agent.name} falls asleep`;
    if (
      key === 'maxPerCall' &&
      parsed.maxPerCall &&
      parsed.dailyCap &&
      BigInt(parsed.maxPerCall) > BigInt(parsed.dailyCap)
    )
      return 'Can’t be above the daily cap';
    return null;
  };
  const invalid = CAPS.some((c) => fieldError(c.key));

  const known = vendors ?? [];
  const custom = draft.allowedVendors.filter((v) => !known.some((k) => k.accountId === v));
  const toggleVendor = (id: string) =>
    setDraft((d) => ({
      ...d,
      allowedVendors: d.allowedVendors.includes(id)
        ? d.allowedVendors.filter((v) => v !== id)
        : [...d.allowedVendors, id],
    }));

  const save = async () => {
    if (invalid) return;
    setBusy('save');
    setError(null);
    try {
      const rulebook = {
        dailyCap: parsed.dailyCap,
        maxPerJob: parsed.maxPerJob,
        maxPerCall: parsed.maxPerCall,
        helperBudget: parsed.helperBudget,
        allowedVendors: draft.allowedVendors,
        anyVendor: draft.anyVendor,
        mayHire: draft.mayHire,
      };
      if (confirm) {
        await post(`/api/agents/${agent.id}/confirm`, { rulebook });
        toast(`${agent.name}'s new rulebook is in force and its wallet is unfrozen.`, 'shield');
      } else {
        await post(`/api/agents/${agent.id}/rulebook`, rulebook);
        toast(`${agent.name}'s wallet now enforces the new rulebook.`, 'shield');
      }
      await mutate(
        (k) =>
          typeof k === 'string' && (k === '/api/me' || k.startsWith(`/api/agents/${agent.id}`)),
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const freeze = async () => {
    setBusy('freeze');
    setError(null);
    try {
      await post(`/api/agents/${agent.id}/freeze`, { frozen: !agent.frozen });
      toast(
        agent.frozen
          ? `${agent.name}'s wallet can spend again.`
          : `${agent.name}'s wallet is frozen. Nothing can leave it.`,
        'shield',
      );
      await mutate(`/api/agents/${agent.id}`);
      await mutate('/api/me');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <span aria-hidden="true">🛡</span> Rulebook
        </span>
      }
      action={agent.frozen ? <Badge tone="shield">Frozen</Badge> : undefined}
    >
      <p className="mb-4 rounded-xl bg-shield-soft px-3 py-2.5 text-sm text-ink">
        These limits live in {agent.name}'s own wallet account, and the wallet contract checks every
        payment against them. Hustle's server can only ask; it can't spend past them. Anything over
        a limit is blocked, or comes to you for approval.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        {CAPS.map((c) => {
          const id = `${baseId}-${c.key}`;
          return (
            <Field key={c.key} label={c.label} hint={c.hint} error={fieldError(c.key)} htmlFor={id}>
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
                  $
                </span>
                <input
                  id={id}
                  inputMode="decimal"
                  autoComplete="off"
                  value={draft[c.key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
                  className={`${inputClass} pl-7 tnum`}
                />
              </div>
            </Field>
          );
        })}
      </div>

      <fieldset className="mt-6">
        <legend className="font-semibold">Specialists it may pay</legend>
        <p className="mb-2 text-sm text-ink-2">
          Data sellers some jobs ask for. A payment to anyone not on this list is blocked, or comes
          to you to approve. Web search isn't a vendor: it's paid as thinking, within the caps
          above.
        </p>
        {!vendors && <p className="text-sm text-muted">Loading vendors…</p>}
        <ul className="grid gap-2 sm:grid-cols-2">
          {known.map((v) => (
            <li key={v.accountId}>
              <label className="flex cursor-pointer gap-3 rounded-xl border-2 border-line p-3 has-[:checked]:border-line-strong has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-brand">
                <input
                  type="checkbox"
                  checked={draft.allowedVendors.includes(v.accountId)}
                  onChange={() => toggleVendor(v.accountId)}
                  className="mt-1 size-4 accent-[var(--brand)]"
                />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-baseline gap-x-2 font-semibold">
                    {v.name}
                    <span className="text-sm font-normal text-muted tnum">
                      {fmt(v.price)} a call
                    </span>
                  </span>
                  <span className="block text-sm text-ink-2">{v.description}</span>
                </span>
              </label>
            </li>
          ))}
          {custom.map((v) => (
            <li key={v}>
              <label className="flex cursor-pointer gap-3 rounded-xl border-2 border-line p-3">
                <input
                  type="checkbox"
                  checked
                  onChange={() => toggleVendor(v)}
                  className="mt-1 size-4 accent-[var(--brand)]"
                />
                <span className="min-w-0 break-all text-sm">{v}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <div className="mt-4 divide-y divide-line">
        <Switch
          label="Any vendor (loose)"
          description="Skip the vendor list and pay whoever a job points at."
          checked={draft.anyVendor}
          onChange={(v) => setDraft((d) => ({ ...d, anyVendor: v }))}
        />
        {draft.anyVendor && (
          <p
            role="alert"
            className="my-2 rounded-xl border-2 border-bad bg-bad-soft px-3 py-2.5 text-sm font-semibold text-bad"
          >
            Risky. Scam jobs tell agents to pay "verification" or "unlock" vendors. With this on,
            only the dollar caps stand between {agent.name} and a scammer.
          </p>
        )}
        <Switch
          label="May hire helpers"
          description="Let it pay other agents to proofread or check its work."
          checked={draft.mayHire}
          onChange={(v) => setDraft((d) => ({ ...d, mayHire: v }))}
        />
      </div>

      <InlineError error={error} />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        {/* A bought agent unfreezes by confirming its rulebook, not with this switch. */}
        {confirm ? (
          <span />
        ) : (
          <Button
            variant={agent.frozen ? 'shield' : 'danger'}
            busy={busy === 'freeze'}
            disabled={!!busy}
            onClick={freeze}
          >
            {agent.frozen ? 'Unfreeze wallet' : 'Freeze wallet'}
          </Button>
        )}
        <div className="flex gap-2">
          <Button
            variant="ghost"
            disabled={!dirty || !!busy}
            onClick={() => setDraft(toDraft(agent.rulebook))}
          >
            Discard
          </Button>
          <Button
            variant="shield"
            disabled={!dirty || invalid || (!!busy && busy !== 'save')}
            busy={busy === 'save'}
            onClick={save}
          >
            {confirm ? 'Confirm with these changes' : 'Save rulebook'}
          </Button>
        </div>
      </div>
      {!confirm && (
        <p className="mt-2 text-xs text-muted">
          Freezing stops every payment out of the wallet, including thinking costs, until you
          unfreeze.
        </p>
      )}
    </Panel>
  );
}
