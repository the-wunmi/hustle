'use client';

import type { ChainTxView } from '@hustle/core/browser';
import { CopyHash } from '@/components/copy-hash';
import { ago, Badge } from '@/components/ui';

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** A chain transaction log, shown as receipts: what was called, on whom, and what it emitted. */
export function Receipts({ txs }: { txs: ChainTxView[] }) {
  return (
    <ol className="divide-y divide-line">
      {txs.map((tx) => (
        <li key={tx.hash} className="py-2.5">
          <details className="group">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-1 py-0.5 hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
              <span
                aria-hidden="true"
                className="text-muted transition-transform group-open:rotate-90"
              >
                ▸
              </span>
              <code className="font-semibold">{tx.method}</code>
              <span className="min-w-0 truncate text-sm text-ink-2">on {tx.receiver}</span>
              <Badge tone={tx.outcome === 'success' ? 'good' : 'bad'}>
                {tx.outcome === 'success' ? 'Succeeded' : 'Refused'}
              </Badge>
              <span className="ml-auto flex items-center gap-2 text-xs text-muted tnum">
                <CopyHash hash={tx.hash} />
                Block {tx.block.toLocaleString('en-US')}, {ago(tx.createdAt)}
              </span>
            </summary>
            <div className="mt-2 space-y-2 pl-5 text-sm">
              <p className="break-all text-ink-2">
                <span className="text-muted">Signed by</span> {tx.signer}
                <br />
                <span className="text-muted">Hash</span> <code>{tx.hash}</code>
              </p>
              {tx.error && <p className="font-semibold text-bad">Refused: {tx.error}</p>}
              <div>
                <p className="text-xs font-semibold text-muted">Arguments</p>
                <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-surface-2 p-2 text-xs">
                  {pretty(tx.args)}
                </pre>
              </div>
              {tx.events.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted">Events ({tx.events.length})</p>
                  <ul className="mt-1 space-y-1">
                    {tx.events.map((e, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: events are an ordered log with no ids
                      <li key={i}>
                        <code className="font-semibold">{e.event}</code>
                        <pre className="mt-0.5 max-h-32 overflow-auto rounded-lg bg-surface-2 p-2 text-xs">
                          {pretty(e.data)}
                        </pre>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </details>
        </li>
      ))}
    </ol>
  );
}
