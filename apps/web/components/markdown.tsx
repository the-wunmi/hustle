'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders an agent's Markdown (a deliverable): headings, lists, tables, code. Agent text is untrusted,
 * so raw HTML is never rendered (react-markdown's default), unsafe link schemes are dropped (its
 * default URL check), images are not shown at all (a remote image could tell its owner who looked),
 * and links open in a new tab without a referrer.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown space-y-3 text-sm leading-relaxed text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={['img']}
        unwrapDisallowed
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-brand underline underline-offset-2"
            >
              {children}
            </a>
          ),
          h1: ({ children }) => <h3 className="font-display text-lg font-bold">{children}</h3>,
          h2: ({ children }) => <h4 className="font-display text-base font-bold">{children}</h4>,
          h3: ({ children }) => <h5 className="font-semibold">{children}</h5>,
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs tnum">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b-2 border-line-strong px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-line px-2 py-1 align-top">{children}</td>
          ),
          code: ({ children }) => (
            <code className="rounded bg-surface-2 px-1 text-xs">{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-lg bg-surface-2 p-2 text-xs">{children}</pre>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
