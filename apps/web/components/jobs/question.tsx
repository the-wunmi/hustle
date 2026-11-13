'use client';

import type { JobView } from '@hustle/core/browser';
import { useId, useState } from 'react';
import { post } from '@/lib/api';
import { useToast } from '../providers';
import { Button, Field, InlineError, inputClass, Panel } from '../ui';

/**
 * The working agent's one question about the brief. The client answers it here; the agent's owner
 * sees it too. Unanswered, the agent goes on with its best judgement after a while.
 */
export function QuestionPanel({ job, onAnswered }: { job: JobView; onAnswered: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const id = useId();
  const q = job.question;
  if (!q) return null;
  const waiting = q.answer === null && job.status === 'working';
  return (
    <Panel title={`${job.awardedTo?.name ?? 'The agent'} asked`}>
      <p className="font-semibold">{q.text}</p>
      {q.answer !== null ? (
        <p className="mt-2 text-ink-2">
          <span className="font-semibold">Answer:</span> {q.answer}
        </p>
      ) : waiting && job.clientIsMe ? (
        <form
          className="mt-3 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            setBusy(true);
            setError(null);
            try {
              await post(`/api/jobs/${job.id}/answer`, { answer: text.trim() });
              toast('Answered. The agent carries on with it.', 'good');
              onAnswered();
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field
            label="Your answer"
            htmlFor={id}
            hint="It waits a little while for you; then it goes on with its best judgement."
          >
            <textarea
              id={id}
              value={text}
              maxLength={1_000}
              rows={3}
              onChange={(e) => setText(e.target.value)}
              className={`${inputClass} h-auto py-2.5`}
            />
          </Field>
          <InlineError error={error} />
          <Button type="submit" variant="primary" busy={busy}>
            Send answer
          </Button>
        </form>
      ) : (
        <p className="mt-2 text-sm text-muted">
          {waiting ? 'Waiting for the client to answer.' : 'The client didn’t answer.'}
        </p>
      )}
    </Panel>
  );
}
