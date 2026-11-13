'use client';

import type { AgentCondition, JobSource, JobStatus, Tier } from '@hustle/core/browser';
import Link from 'next/link';
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useRef } from 'react';
import { errorText } from '@/lib/api';
import { fmt } from '@/lib/money';

// ── Buttons ─────────────────────────────────────────────────────────────────────────────────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'coin' | 'shield';

const VARIANT: Record<Variant, string> = {
  primary: 'btn-press bg-brand text-brand-ink border-2 border-line-strong',
  coin: 'btn-press bg-coin text-[#1a1d3a] border-2 border-line-strong',
  secondary: 'bg-surface text-ink border-2 border-line hover:border-line-strong',
  ghost: 'text-ink-2 hover:bg-surface-2 border-2 border-transparent',
  danger: 'bg-bad-soft text-bad border-2 border-bad/40 hover:border-bad',
  shield: 'btn-press bg-shield text-white border-2 border-line-strong dark:text-[#120d33]',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  busy?: boolean;
}) {
  const sizes = {
    sm: 'h-8 px-3 text-sm rounded-xl',
    md: 'h-10 px-4 text-[15px] rounded-xl',
    lg: 'h-12 px-6 text-base rounded-2xl',
  };
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-2 font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${sizes[size]} ${VARIANT[variant]} ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  variant = 'secondary',
  className = '',
  fullLoad = false,
  children,
}: {
  href: string;
  variant?: Variant;
  className?: string;
  /**
   * A plain link, so the browser loads the page afresh (with that page's own security headers)
   * instead of Next swapping it in client-side.
   */
  fullLoad?: boolean;
  children: ReactNode;
}) {
  const classes = `inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-[15px] font-semibold whitespace-nowrap ${VARIANT[variant]} ${className}`;
  if (fullLoad)
    return (
      <a href={href} className={classes}>
        {children}
      </a>
    );
  return (
    <Link href={href} className={classes}>
      {children}
    </Link>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`spin size-4 ${className}`} aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Surfaces ────────────────────────────────────────────────────────────────────────────────────

export function Panel({
  title,
  action,
  children,
  className = '',
  as: Tag = 'section',
  id,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'aside';
  id?: string;
}) {
  const headingId = useId();
  return (
    <Tag
      id={id}
      className={`panel scroll-mt-32 p-4 sm:p-5 ${className}`}
      aria-labelledby={title ? headingId : undefined}
    >
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && (
            <h2 id={headingId} className="text-lg font-bold">
              {title}
            </h2>
          )}
          {action}
        </div>
      )}
      {children}
    </Tag>
  );
}

export function PageHeader({
  title,
  lead,
  action,
}: {
  title: ReactNode;
  lead?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-extrabold sm:text-4xl">{title}</h1>
        {lead && <p className="mt-2 text-ink-2">{lead}</p>}
      </div>
      {action}
    </div>
  );
}

// ── States ──────────────────────────────────────────────────────────────────────────────────────

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function Loading({ label = 'Loading', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
        <Skeleton key={i} className="h-14" />
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-line px-5 py-8 text-center">
      <p className="font-display text-lg font-bold">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-bad/40 bg-bad-soft px-4 py-3 text-sm text-bad"
    >
      <span>{errorText(error)}</span>
      {retry && (
        <Button size="sm" variant="secondary" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm font-medium text-bad">
      {errorText(error)}
    </p>
  );
}

// ── Badges ──────────────────────────────────────────────────────────────────────────────────────

type Tone = 'neutral' | 'good' | 'bad' | 'shield' | 'coin' | 'brand' | 'warn';
const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-2 border-line',
  good: 'bg-good-soft text-good border-good/30',
  bad: 'bg-bad-soft text-bad border-bad/30',
  shield: 'bg-shield-soft text-shield border-shield/30',
  coin: 'bg-coin/25 text-coin-ink border-coin/60 dark:text-coin',
  brand: 'bg-brand-soft text-brand border-brand/30',
  warn: 'bg-warn-soft text-warn border-warn/30',
};

export function Badge({
  tone = 'neutral',
  children,
  className = '',
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

const CONDITION: Record<AgentCondition, { tone: Tone; label: string }> = {
  thriving: { tone: 'good', label: 'Thriving' },
  struggling: { tone: 'warn', label: 'Struggling' },
  dormant: { tone: 'neutral', label: 'Dormant' },
};

export function ConditionBadge({ condition }: { condition: AgentCondition }) {
  const c = CONDITION[condition];
  return (
    <Badge tone={c.tone}>
      {condition === 'dormant' ? '💤' : condition === 'struggling' ? '⚠' : '●'} {c.label}
    </Badge>
  );
}

const TIER_SHORT: Record<Tier, string> = {
  budget: 'Budget',
  standard: 'Standard',
  premium: 'Premium',
};
export const TIER_VAR: Record<Tier, string> = {
  budget: 'var(--series-1)',
  standard: 'var(--series-2)',
  premium: 'var(--series-3)',
};

export function TierBadge({ tier }: { tier: Tier }) {
  return <Badge>{TIER_SHORT[tier]} brain</Badge>;
}

const SOURCE_TONE: Record<JobSource, Tone> = {
  client: 'neutral',
  player: 'brand',
  sponsor: 'coin',
  practice: 'good',
  challenge: 'shield',
  subcontract: 'brand',
};
export function SourceBadge({ source, label }: { source: JobSource; label: string }) {
  return <Badge tone={SOURCE_TONE[source]}>{label}</Badge>;
}

const STATUS: Record<JobStatus, { tone: Tone; label: string }> = {
  posting: { tone: 'neutral', label: 'Posting: budget going into escrow' },
  open: { tone: 'brand', label: 'Open for bids' },
  awarded: { tone: 'neutral', label: 'Awarded' },
  working: { tone: 'warn', label: 'Being worked on' },
  delivered: { tone: 'shield', label: 'Delivered, awaiting rating' },
  paid: { tone: 'good', label: 'Paid' },
  disputed: { tone: 'bad', label: 'Disputed' },
  refunded: { tone: 'bad', label: 'Refunded' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  expired: { tone: 'neutral', label: 'Expired' },
  graded: { tone: 'shield', label: 'Challenge graded' },
};
export function StatusBadge({ status }: { status: JobStatus }) {
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function Money({
  micro,
  sign = false,
  className = '',
}: {
  micro: string | bigint | null | undefined;
  sign?: boolean;
  className?: string;
}) {
  return <span className={`tnum ${className}`}>{fmt(micro, { sign })}</span>;
}

/** Signed money coloured by direction: green in, red out. */
export function Delta({ micro, className = '' }: { micro: string; className?: string }) {
  const v = BigInt(micro);
  const tone = v > 0n ? 'text-good' : v < 0n ? 'text-bad' : 'text-ink-2';
  return (
    <span className={`tnum font-semibold ${tone} ${className}`}>{fmt(v, { sign: true })}</span>
  );
}

export function Stars({ value, size = 'sm' }: { value: number | null; size?: 'sm' | 'lg' }) {
  if (value === null) return <span className="text-muted">No rating yet</span>;
  const rounded = Math.round(value);
  return (
    <span
      className={`tnum inline-flex items-center gap-0.5 ${size === 'lg' ? 'text-xl' : 'text-sm'}`}
      title={`${value.toFixed(1)} out of 5`}
    >
      <span aria-hidden="true" className="text-coin">
        {'★'.repeat(rounded)}
        <span className="text-line">{'★'.repeat(5 - rounded)}</span>
      </span>
      <span className="sr-only">{value.toFixed(1)} out of 5 stars</span>
    </span>
  );
}

// ── Forms ───────────────────────────────────────────────────────────────────────────────────────

export const inputClass =
  'h-11 w-full rounded-xl border-2 border-line bg-surface px-3 text-ink placeholder:text-muted focus:border-brand focus:outline-none';

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-semibold">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs font-medium text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div>
        <label htmlFor={id} className="font-semibold">
          {label}
        </label>
        {description && <p className="text-sm text-ink-2">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-7 w-12 shrink-0 rounded-full border-2 border-line-strong transition-colors disabled:opacity-50 ${checked ? 'bg-brand' : 'bg-surface-2'}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 size-5 rounded-full border-2 border-line-strong bg-white transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`}
        />
      </button>
    </div>
  );
}

/** A row of mutually exclusive choices, as radio buttons. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md';
}) {
  const name = useId();
  return (
    <fieldset className="inline-flex flex-wrap gap-1 rounded-2xl border-2 border-line bg-surface-2 p-1">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <label
          key={o.value}
          className={`cursor-pointer rounded-xl font-semibold transition-colors has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-brand ${size === 'sm' ? 'px-2.5 py-1 text-sm' : 'px-3.5 py-1.5'} ${value === o.value ? 'bg-surface text-ink shadow-[2px_2px_0_var(--shadow)] ring-2 ring-line-strong' : 'text-ink-2 hover:text-ink'}`}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="choice-input"
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

// ── Dialog ──────────────────────────────────────────────────────────────────────────────────────

/** A modal on the native <dialog>: focus trapping and Escape-to-close come from the browser. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement as HTMLElement | null;
      d.showModal();
    }
    if (!open && d.open) d.close();
    // Hand focus back to whatever opened the dialog, however it was closed.
    if (!open && opener.current) {
      opener.current.focus();
      opener.current = null;
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={headingId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      className={`sticker m-auto w-[calc(100%-2rem)] p-0 text-ink ${wide ? 'max-w-2xl' : 'max-w-md'}`}
    >
      {open && (
        <div className="p-5 sm:p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 id={headingId} className="text-xl font-extrabold">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-m-1 rounded-lg p-1 text-ink-2 hover:bg-surface-2"
            >
              <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

// ── Misc ────────────────────────────────────────────────────────────────────────────────────────

export function Meter({
  value,
  label,
  tone = 'brand',
}: {
  value: number;
  label: string;
  tone?: 'brand' | 'coin' | 'good';
}) {
  const color = { brand: 'bg-brand', coin: 'bg-coin', good: 'bg-good' }[tone];
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(v)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-3 overflow-hidden rounded-full border-2 border-line-strong bg-surface-2"
    >
      <div
        className={`h-full ${color} transition-[width] duration-500`}
        style={{ width: `${v}%` }}
      />
    </div>
  );
}

export function Stat({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-xs text-muted">{label}</div>
      <div className="font-display text-lg font-bold tnum">{children}</div>
    </div>
  );
}

export const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};

export { fmt };
