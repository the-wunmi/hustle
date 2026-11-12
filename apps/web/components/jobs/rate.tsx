'use client';

import type { JobView } from '@hustle/core/browser';
import { useId, useState } from 'react';
import { useSWRConfig } from 'swr';
import { post } from '@/lib/api';
import { useSound, useToast } from '../providers';
import { Button, InlineError } from '../ui';
import { useLiveTick } from './job-bits';

const MEANING = ['', 'Unusable: dispute it', 'Poor', 'Okay', 'Good', 'Excellent'];

/** What the arbiter does, stated as this build actually does it. */
export const ARBITER_COPY =
  "1★ opens a dispute. The arbiter pays for work that meets the quality bar and refunds you if it doesn't (in this build it uses the game's quality score, not a model reading the work).";

/** "m:ss" until the client's review window closes and the work is accepted at 4★. */
export function useAutoAccept(reviewEndsAtTick: number | null): string | null {
  const { tick, tickMs } = useLiveTick();
  if (reviewEndsAtTick === null || tick === null) return null;
  const seconds = Math.max(0, Math.ceil(((reviewEndsAtTick - tick) * tickMs) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Rate a delivery 1–5. One star opens a dispute that the arbiter settles. */
export function RatePanel({ job, onRated }: { job: JobView; onRated: () => void }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const { play } = useSound();
  const { mutate } = useSWRConfig();
  const name = useId();
  const agentName = job.awardedTo?.name ?? 'the agent';
  const shown = hover || rating;
  const autoIn = useAutoAccept(job.reviewEndsAtTick);

  const submit = async () => {
    if (rating === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/api/jobs/${job.id}/rate`, { rating });
      if (rating === 1) {
        toast('Dispute opened. The arbiter checks the work against the quality bar.', 'shield');
      } else {
        play('coin');
        toast(`Rated ${rating}★. ${agentName} gets paid.`, 'good');
      }
      await mutate('/api/me');
      onRated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="rate" className="sticker scroll-mt-36 p-5" aria-labelledby={`${name}-h`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${name}-h`} className="font-display text-xl font-extrabold">
          Rate {agentName}'s work
        </h2>
        {autoIn && (
          <p className="text-sm font-semibold text-ink-2 tnum">Auto-accepts at 4★ in {autoIn}</p>
        )}
      </div>
      <p className="mt-1 text-ink-2">
        Your rating releases the payment held for this job and goes on {agentName}'s public record.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="mt-4">
          <legend className="sr-only">
            Rating from 1 to 5 stars. Use the arrow keys to choose.
          </legend>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <label
                key={n}
                onMouseEnter={() => setHover(n)}
                onMouseLeave={() => setHover(0)}
                className={`cursor-pointer rounded-lg px-1 text-4xl leading-none transition-transform hover:scale-110 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand ${n <= shown ? 'text-coin' : 'text-line'}`}
              >
                <input
                  type="radio"
                  name={name}
                  value={n}
                  checked={rating === n}
                  onChange={() => setRating(n)}
                  className="choice-input"
                />
                <span aria-hidden="true">★</span>
                <span className="sr-only">
                  {n} star{n === 1 ? '' : 's'}: {MEANING[n]}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-2 min-h-6 font-semibold" aria-live="polite">
          {shown ? MEANING[shown] : 'Pick a rating'}
        </p>
        <p
          className={`mt-2 rounded-xl p-3 text-sm text-ink ${rating === 1 ? 'border-2 border-bad/50 bg-bad-soft' : 'bg-surface-2'}`}
        >
          {ARBITER_COPY}
        </p>
        <div className="mt-4">
          <InlineError error={error} />
          <Button
            type="submit"
            variant={rating === 1 ? 'danger' : 'primary'}
            size="lg"
            className="mt-2"
            disabled={rating === 0}
            busy={busy}
          >
            {rating === 0
              ? 'Rate the work'
              : rating === 1
                ? 'Dispute with 1★'
                : `Rate ${rating}★ and pay`}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** A prompt at the top of a delivered job, so the client doesn't miss the review window. */
export function RateNowBanner({ job }: { job: JobView }) {
  const autoIn = useAutoAccept(job.reviewEndsAtTick);
  return (
    <a
      href="#rate"
      className="btn-press mt-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border-2 border-line-strong bg-coin px-4 py-3 font-semibold text-[#1a1d3a]"
    >
      <span>{job.awardedTo?.name ?? 'The agent'} delivered. Rate it now</span>
      {autoIn && <span className="tnum">Auto-accepts at 4★ in {autoIn}</span>}
    </a>
  );
}
