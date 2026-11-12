'use client';

import type { JobView } from '@hustle/core/browser';
import { useId, useState } from 'react';
import { useSWRConfig } from 'swr';
import { api, post, useMe } from '@/lib/api';
import { fmt, parseDollars, toDollarInput } from '@/lib/money';
import { Portrait } from '../portrait';
import { useSound, useToast } from '../providers';
import { Button, Dialog, ErrorNote, InlineError, inputClass, Loading } from '../ui';
import { closesIn, useLiveTick } from './job-bits';

type Sendable = JobView['sendable'][number];

/** Micro-USD in one cent: the default price snaps to whole cents. */
const CENT = 10_000n;

/** Keeps a bigint inside [lo, hi]; Math.min and Math.max don't take bigints. */
function clamp(v: bigint, lo: bigint, hi: bigint): bigint {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** Rounds up to a whole cent, so the lowest price on offer never sits below the floor. */
const ceilCent = (v: bigint): bigint => ((v + CENT - 1n) / CENT) * CENT;

/** About 85% of the most the job pays, in whole cents, never below what thinking costs. */
function defaultPrice(s: Sendable): bigint {
  const max = BigInt(s.max);
  return clamp(((max * 85n) / 100n / CENT) * CENT, ceilCent(BigInt(s.floor)), max);
}

/**
 * The player's most direct move: send one of their agents after this job at a price they choose.
 * The API floors the price at the agent's own thinking cost and caps it at the budget.
 */
function SendForm({
  job,
  agent,
  onSent,
}: {
  job: JobView;
  agent: Sendable;
  onSent: (job: JobView, agentId: string) => void;
}) {
  const { data: me } = useMe();
  const toast = useToast();
  const { play } = useSound();
  const floor = ceilCent(BigInt(agent.floor));
  const max = BigInt(agent.max);
  const [price, setPrice] = useState<bigint>(() => defaultPrice(agent));
  const [text, setText] = useState(() => toDollarInput(defaultPrice(agent).toString()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const sliderId = useId();
  const inputId = useId();
  const look = me?.agents.find((a) => a.id === agent.agentId)?.look;
  const { tick, tickMs } = useLiveTick();
  // Client-picked jobs stay open until the client chooses, so only auto-picked ones close on time.
  const timed = job.autoAward && job.closesAtTick !== null;
  const closed = timed && tick !== null && job.closesAtTick !== null && tick >= job.closesAtTick;
  const countdown = timed ? closesIn(job.closesAtTick, tick, tickMs) : null;
  const rivals = job.bids
    .filter((b) => b.status === 'open' && !b.agent.isMine)
    .sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : 1));
  const lowest = rivals[0];
  const disabled = agent.reason !== null;
  const outOfRange = price < floor || price > max;

  const setFromMicro = (v: bigint) => {
    const snapped = clamp(((v + CENT / 2n) / CENT) * CENT, floor, max);
    setPrice(snapped);
    setText(toDollarInput(snapped.toString()));
    setError(null);
  };

  const send = async () => {
    if (outOfRange) {
      setError(new Error(`Pick a price between ${fmt(floor)} and ${fmt(max)}.`));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await post<JobView>(`/api/jobs/${job.id}/bid`, {
        agentId: agent.agentId,
        price: price.toString(),
      });
      play('win');
      toast(`${agent.name} bid ${fmt(price)} on “${job.title}”.`, 'good');
      onSent(updated, agent.agentId);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={`rounded-2xl p-4 ${disabled ? 'border-2 border-dashed border-line' : 'sticker'}`}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="flex items-start gap-3">
        {look && <Portrait look={look} mood={disabled ? 'idle' : 'busy'} size={52} still />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <h3 className="font-display text-lg font-bold">Send {agent.name} after this job</h3>
            {countdown && !closed && (
              <span className="text-sm font-semibold text-warn tnum" aria-live="off">
                Bidding {countdown}
              </span>
            )}
          </div>
          {disabled ? (
            <p className="text-sm text-ink-2">{agent.reason}</p>
          ) : (
            <p className="text-sm text-ink-2">
              Pick {agent.name}'s price. Below {fmt(floor)} {agent.name} loses money on thinking
              alone; the most this job pays is {fmt(max)}.
            </p>
          )}
        </div>
      </div>
      {!disabled && closed && (
        <p role="status" className="mt-3 rounded-xl bg-surface-2 p-3 text-sm font-semibold">
          Bidding has closed on this job, so {agent.name} can't be sent after it any more.
        </p>
      )}
      {!disabled && !closed && (
        <>
          <p className="mt-3 text-sm text-ink-2">
            {lowest
              ? `Rivals so far: ${rivals.length} ${rivals.length === 1 ? 'bid' : 'bids'}, the lowest ${fmt(lowest.price)} from ${lowest.agent.name}. Cheaper usually wins, but rating and skill count too.`
              : 'No rival bids yet.'}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label htmlFor={sliderId} className="sr-only">
              Price for {agent.name}
            </label>
            <input
              id={sliderId}
              type="range"
              min={Number(floor)}
              max={Number(max)}
              step={Number(CENT)}
              value={Number(clamp(price, floor, max))}
              onChange={(e) => setFromMicro(BigInt(e.target.value))}
              className="min-w-40 flex-1 accent-[var(--coin)]"
              aria-valuetext={fmt(price)}
            />
            <div className="relative w-32">
              <label htmlFor={inputId} className="sr-only">
                Price in dollars
              </label>
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
                $
              </span>
              <input
                id={inputId}
                inputMode="decimal"
                autoComplete="off"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  const micro = parseDollars(e.target.value);
                  if (micro !== null) setPrice(BigInt(micro));
                  setError(null);
                }}
                className={`${inputClass} pl-7 tnum`}
                aria-invalid={outOfRange || undefined}
              />
            </div>
          </div>
          <div className="mt-1 flex justify-between text-xs text-muted tnum">
            <span>{fmt(floor)} breaks even on thinking</span>
            <span>{fmt(max)} most it pays</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="submit" variant="coin" busy={busy} disabled={outOfRange}>
              Send {agent.name} at {fmt(price)}
            </Button>
            <InlineError error={error} />
          </div>
        </>
      )}
    </form>
  );
}

/** Every agent of the player's that could chase this job; nothing when there are none. */
export function SendAgent({
  job,
  onSent,
}: {
  job: JobView;
  onSent: (job: JobView, agentId: string) => void;
}) {
  if (job.status !== 'open' || job.sendable.length === 0) return null;
  return (
    <div className="space-y-3">
      {job.sendable.map((a) => (
        <SendForm key={a.agentId} job={job} agent={a} onSent={onSent} />
      ))}
    </div>
  );
}

/** The job board's compact version: loads the job when opened, then shows the same form. */
export function SendAgentButton({ jobId, title }: { jobId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { mutate } = useSWRConfig();

  const load = async () => {
    setError(null);
    try {
      setJob(await api<JobView>(`/api/jobs/${jobId}`));
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="coin"
        onClick={() => {
          setOpen(true);
          setJob(null);
          void load();
        }}
      >
        Send my agent
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Bid on “${title}”`} wide>
        {error ? (
          <ErrorNote error={error} retry={() => void load()} />
        ) : !job ? (
          <Loading rows={2} label="Loading the job" />
        ) : job.status !== 'open' ? (
          <p className="text-ink-2">Bidding on this job has closed.</p>
        ) : job.sendable.length === 0 ? (
          <p className="text-ink-2">You have no agent that can chase this job.</p>
        ) : (
          <SendAgent
            job={job}
            onSent={(updated) => {
              void mutate((k) => typeof k === 'string' && k.startsWith('/api/jobs'));
              setJob(updated);
              setOpen(false);
            }}
          />
        )}
      </Dialog>
    </>
  );
}
