'use client';

import type { VerificationView } from '@hustle/core/browser';
import { useState } from 'react';
import { Badge, Button, ErrorNote, Panel, Skeleton } from '@/components/ui';
import { useApi } from '@/lib/api';

interface LiveAttestation {
  fetchedAt: string;
  endpoint: string;
  verification: VerificationView;
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

/**
 * A real call to NEAR AI Cloud's public attestation endpoint with a fresh nonce. It checks the report
 * answers our nonce and names a signing key; the TDX quote inside is not verified, and we say so.
 */
export function LiveCheck() {
  const { data, error, isValidating, mutate } = useApi<LiveAttestation>('/api/attestation/live', {
    revalidateOnFocus: false,
  });
  const [ran, setRan] = useState(0);
  const v = data?.verification;
  return (
    <Panel
      title="Live check"
      action={
        <Button
          size="sm"
          busy={isValidating && ran > 0}
          onClick={() => {
            setRan((n) => n + 1);
            void mutate();
          }}
        >
          Run again
        </Button>
      }
    >
      <p className="max-w-prose text-sm text-ink-2">
        This is a real request from Hustle's server to NEAR AI Cloud's public attestation endpoint,
        with a fresh random nonce. It shows what the report itself claims and how far we checked it.
        The server reuses an answer for up to a minute.
      </p>
      <div className="mt-3" aria-live="polite">
        {error && !data ? (
          <ErrorNote error={error} retry={() => void mutate()} />
        ) : !v ? (
          <Skeleton className="h-40" />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={v.passed ? 'good' : 'bad'}>
                {v.passed ? 'Every check that ran passed' : 'A check failed'}
              </Badge>
              <span className="text-muted">
                Fetched at {clock(data.fetchedAt)} from{' '}
                <code className="break-all text-xs">{data.endpoint}</code>
              </span>
            </div>
            {error && <ErrorNote error={error} />}
            <ul className="space-y-1.5 text-sm">
              {v.checks.map((c) => (
                <li key={c.name} className="flex gap-2">
                  <span
                    aria-hidden="true"
                    className={`font-bold ${c.ok ? 'text-good' : 'text-bad'}`}
                  >
                    {c.ok ? '✓' : '✗'}
                  </span>
                  <span>
                    <span className="sr-only">{c.ok ? 'Passed: ' : 'Failed: '}</span>
                    {c.name}
                    <code className="block text-xs break-all text-muted">{c.detail}</code>
                  </span>
                </li>
              ))}
            </ul>
            <div className="rounded-xl border border-warn/40 bg-warn-soft p-3 text-sm">
              <p className="font-semibold text-warn">Not checked</p>
              <p className="mt-0.5 text-ink-2">
                The checks above confirm the report answers our nonce and names a key. The Intel TDX
                quote inside it is not verified here, so its contents are the gateway's own claims.
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">
                {v.notChecked.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
            {v.signer && (
              <p className="text-xs text-muted">
                Signing key named by the report: <code className="break-all">{v.signer}</code>
              </p>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
