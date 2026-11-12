'use client';

import { useState } from 'react';

/** A transaction hash, shortened, with a button that copies the whole thing. */
export function CopyHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  const short = hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
  return (
    <span className="inline-flex items-center gap-1">
      <code className="text-xs" title={hash}>
        {short}
      </code>
      <button
        type="button"
        onClick={async (e) => {
          // Inside a <summary> a click would also toggle the row; copying shouldn't.
          e.preventDefault();
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(hash);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // Clipboard blocked: the full hash is still in the title and the detail view.
          }
        }}
        className="rounded-md px-1.5 py-0.5 text-xs font-semibold text-brand hover:bg-brand-soft"
        aria-label={`Copy transaction hash ${hash}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
