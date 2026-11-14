'use client';

import type { JobSummaryView, WorldView } from '@hustle/core/browser';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { errorText, post, useApi, useMe, useWorld } from '@/lib/api';
import { useCallAlerts, useCalls } from './home/desk';
import { type ThemePref, useSound, useTheme, useToast } from './providers';
import { Button } from './ui';

const NAV = [
  { href: '/', label: 'Home', also: [] },
  { href: '/jobs', label: 'Jobs', also: ['/post'] },
  { href: '/agents', label: 'Agents', also: ['/marketplace'] },
  { href: '/leaderboard', label: 'Leaderboard', also: ['/economy'] },
  { href: '/wallet', label: 'Wallet', also: [] },
];

const under = (path: string, href: string) => path === href || path.startsWith(`${href}/`);
const isActive = (path: string, n: (typeof NAV)[number]) =>
  n.href === '/' ? path === '/' : under(path, n.href) || n.also.some((a) => under(path, a));

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b-2 border-line-strong bg-paper">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2" aria-label="Hustle home">
            <Logo />
          </Link>
          <GameClock />
          <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
            <SandboxChip />
            <CallsBell />
            <RatingsBell />
            <ApprovalsBell />
            <Toggles />
            <AccountMenu />
          </div>
        </div>
        <nav aria-label="Main" className="relative mx-auto max-w-7xl">
          <ul className="flex gap-1 overflow-x-auto px-2 pb-2 sm:px-4">
            {NAV.map((n) => {
              const active = isActive(path, n);
              return (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    aria-current={active ? 'page' : undefined}
                    className={`block rounded-xl px-3 py-1.5 text-sm font-semibold whitespace-nowrap ${active ? 'bg-ink text-paper' : 'text-ink-2 hover:bg-surface hover:text-ink'}`}
                  >
                    {n.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      <main id="main" className="mx-auto max-w-7xl px-4 pt-6 pb-16 sm:px-6">
        {children}
      </main>
      <footer className="border-t-2 border-line">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-5 text-sm text-ink-2 sm:px-6">
          <Link href="/how-it-works" className="font-semibold hover:text-ink">
            How it works
          </Link>
          <span>Built on NEAR, with NEAR AI Cloud.</span>
        </div>
      </footer>
    </>
  );
}

function Logo() {
  return (
    <span className="flex items-center gap-1.5">
      <svg viewBox="0 0 32 32" className="size-8" aria-hidden="true">
        <circle cx="16" cy="16" r="13" fill="var(--coin)" stroke="#1a1d3a" strokeWidth="2.5" />
        <circle cx="12" cy="14" r="2.2" fill="#1a1d3a" />
        <circle cx="20" cy="14" r="2.2" fill="#1a1d3a" />
        <path
          d="M11.5 19 q4.5 4 9 0"
          stroke="#1a1d3a"
          strokeWidth="2.2"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
      <span className="hidden font-display text-2xl font-extrabold tracking-tight min-[420px]:inline">
        Hustle
      </span>
    </span>
  );
}

/** Day, hour and a ring for how far through the day the world is. */
export function GameClock({ world: given }: { world?: WorldView }) {
  const { data } = useWorld();
  const world = given ?? data;
  if (!world) return <span className="skeleton h-8 w-28 sm:w-36" />;
  const progress = (world.tick % world.dayTicks) / world.dayTicks;
  const r = 9;
  const circ = 2 * Math.PI * r;
  return (
    <div
      className="flex items-center gap-1.5 rounded-full border-2 border-line bg-surface px-2 py-1 sm:gap-2 sm:px-2.5"
      title={`Game time: ${Math.round(progress * 100)}% through today. A game day lasts a few minutes; upkeep is charged when it ends.`}
    >
      <svg viewBox="0 0 24 24" className="hidden size-5 -rotate-90 sm:block" aria-hidden="true">
        <circle cx="12" cy="12" r={r} fill="none" stroke="var(--line)" strokeWidth="4" />
        <circle
          cx="12"
          cy="12"
          r={r}
          fill="none"
          stroke="var(--coin)"
          strokeWidth="4"
          strokeDasharray={`${circ * progress} ${circ}`}
        />
      </svg>
      <span className="text-sm font-semibold whitespace-nowrap tnum">
        <span className="sr-only">Game time: </span>
        {String(world.hour).padStart(2, '0')}:00
      </span>
      {world.event && (
        <span className="hidden rounded-full bg-coin/30 px-2 text-xs font-semibold lg:inline">
          {world.event.name}
        </span>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  pressed,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="grid size-9 place-items-center rounded-xl text-ink-2 hover:bg-surface hover:text-ink"
    >
      {children}
    </button>
  );
}

function SoundToggle() {
  const { muted, toggle, play } = useSound();
  return (
    <IconButton
      label={muted ? 'Turn sound on' : 'Mute sound'}
      pressed={!muted}
      onClick={() => {
        toggle();
        if (muted) setTimeout(() => play('coin'), 50);
      }}
    >
      <svg
        viewBox="0 0 24 24"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 9h4l5-4v14l-5-4H4z" />
        {muted ? (
          <path d="M17 9l5 6M22 9l-5 6" />
        ) : (
          <path d="M17 8.5a5 5 0 0 1 0 7M19.5 6a8.5 8.5 0 0 1 0 12" />
        )}
      </svg>
    </IconButton>
  );
}

const NEXT_THEME: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<ThemePref, string> = {
  system: 'Theme: system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

function ThemeToggle() {
  const { pref, setPref } = useTheme();
  return (
    <IconButton
      label={`${THEME_LABEL[pref]}. Switch theme`}
      onClick={() => setPref(NEXT_THEME[pref])}
    >
      <svg
        viewBox="0 0 24 24"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        {pref === 'light' && (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5" />
          </>
        )}
        {pref === 'dark' && <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />}
        {pref === 'system' && (
          <>
            <rect x="3" y="4" width="18" height="12" rx="2" />
            <path d="M8 20h8M12 16v4" />
          </>
        )}
      </svg>
    </IconButton>
  );
}

/** Lights up while one of your agents is waiting on a call, and rings when a new one opens. */
function CallsBell() {
  useCallAlerts();
  const { data } = useCalls();
  const open = (data ?? []).filter((c) => c.status === 'open');
  if (open.length === 0) return null;
  return (
    <Link
      href="/#desk"
      aria-label={`${open[0]?.agent.name ?? 'Your agent'} is calling: ${open[0]?.title ?? ''}`}
      title="Your agent is calling"
      className="call-pulse flex h-9 items-center gap-1.5 rounded-full border-2 border-line-strong bg-coin px-2.5 text-xs font-bold text-[#1a1d3a]"
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
        <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.6a1 1 0 0 1-.25 1z" />
      </svg>
      <span className="hidden sm:inline">Call</span>
      {open.length > 1 && <span className="tnum">{open.length}</span>}
    </Link>
  );
}

/** Your tasks that were delivered and wait for your rating; hidden when there are none. */
function RatingsBell() {
  const { data: me } = useMe();
  const { data: mine } = useApi<JobSummaryView[]>(me ? '/api/jobs?status=mine' : null);
  const waiting = (mine ?? []).filter((j) => j.status === 'delivered');
  if (waiting.length === 0) return null;
  const n = waiting.length;
  const only = n === 1 ? waiting[0] : undefined;
  return (
    <Link
      href={only ? `/jobs/${only.id}#rate` : '/jobs?status=mine'}
      aria-label={`${n} delivered ${n === 1 ? 'task waits' : 'tasks wait'} for your rating`}
      title="Waiting for your rating"
      className="relative grid size-9 place-items-center rounded-xl text-coin-ink hover:bg-surface dark:text-coin"
    >
      <svg
        viewBox="0 0 24 24"
        className="size-5"
        fill="var(--coin)"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />
      </svg>
      <span className="absolute -top-0.5 -right-0.5 grid min-w-5 place-items-center rounded-full border-2 border-paper bg-bad px-1 text-[11px] font-bold text-white tnum">
        {n}
      </span>
    </Link>
  );
}

function ApprovalsBell() {
  const { data: me } = useMe();
  // Approvals are an agent's requests; without an agent there is nothing to approve.
  if (!me?.agents.length) return null;
  const n = me.pendingApprovals;
  return (
    <Link
      href="/#approvals"
      aria-label={n ? `${n} approval${n === 1 ? '' : 's'} waiting` : 'Approvals: none waiting'}
      title="Approvals"
      // On a phone the header is tight; with nothing waiting, the approvals icon steps aside.
      className={`relative size-9 place-items-center rounded-xl text-ink-2 hover:bg-surface hover:text-ink ${n > 0 ? 'grid' : 'hidden sm:grid'}`}
    >
      <svg
        viewBox="0 0 24 24"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />
      </svg>
      {n > 0 && (
        <span className="absolute -top-0.5 -right-0.5 grid min-w-5 place-items-center rounded-full border-2 border-paper bg-bad px-1 text-[11px] font-bold text-white tnum">
          {n}
        </span>
      )}
    </Link>
  );
}

/** Sound and theme sit in the header; on a phone, signed-in players find them in the account menu. */
function Toggles() {
  const { data: me } = useMe();
  return (
    <div className={`items-center gap-1 sm:gap-1.5 ${me ? 'hidden sm:flex' : 'flex'}`}>
      <SoundToggle />
      <ThemeToggle />
    </div>
  );
}

/** Closes a popover on outside click or Escape, and hands focus back to its button. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const path = usePathname();
  // biome-ignore lint/correctness/useExhaustiveDependencies: close whenever the page changes
  useEffect(() => {
    setOpen(false);
  }, [path]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, ref, button };
}

const menuLink =
  'block rounded-lg px-2 py-1.5 font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink';

function AccountMenu() {
  const { data: me, mutate } = useMe();
  const { mutate: globalMutate } = useSWRConfig();
  const router = useRouter();
  const { open, setOpen, ref, button } = usePopover();
  if (!me) return null;
  return (
    <div ref={ref} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls="account-menu"
        onClick={() => setOpen((o) => !o)}
        className="grid size-9 place-items-center rounded-full border-2 border-line-strong bg-brand-soft font-display font-bold text-brand"
        aria-label={`Account: ${me.player.name}`}
      >
        {me.player.name.slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div
          id="account-menu"
          className="sticker absolute right-0 mt-2 w-[min(16rem,calc(100vw-1.5rem))] p-3 text-sm"
        >
          <p className="font-semibold">{me.player.name}</p>
          <p className="truncate text-muted">{me.player.email ?? 'Signed in with a passkey'}</p>
          <nav aria-label="Your things" className="mt-3 border-t border-line pt-2">
            {me.agents.map((a) => (
              <Link key={a.id} href={`/agents/${a.id}`} className={menuLink}>
                {a.name}
              </Link>
            ))}
            {me.agents.length === 0 && (
              <Link href="/" className={menuLink}>
                Adopt an agent
              </Link>
            )}
            <Link href="/wallet" className={menuLink}>
              Wallet
            </Link>
            <Link href="/jobs?status=mine" className={menuLink}>
              My tasks
            </Link>
          </nav>
          <div className="mt-2 flex items-center gap-1 border-t border-line pt-2 sm:hidden">
            <SoundToggle />
            <ThemeToggle />
            <span className="text-xs text-muted">Sound and theme</span>
          </div>
          <div className="mt-2 border-t border-line pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={async () => {
                await post('/api/auth/logout');
                await mutate(null, { revalidate: false });
                await globalMutate(() => true, undefined, { revalidate: true });
                setOpen(false);
                router.push('/');
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A header chip that says every amount is credits, and opens the controls that move the
 * clock or post a trap job. Kept out of the page on purpose: these exist for testing and demos.
 */
function SandboxChip() {
  const { data: world } = useWorld();
  const { data: me } = useMe();
  const { open, setOpen, ref, button } = usePopover();
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const { mutate } = useSWRConfig();
  // The API mounts these on the local NEAR node and on the simulator, never on testnet.
  const sandbox = world?.modes.chain === 'sim' || world?.modes.chain === 'sandbox';
  const hasAgent = !!me?.agents.length;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
      await mutate(() => true);
    } catch (err) {
      toast(errorText(err), 'bad');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls="sandbox-panel"
        title="Every dollar amount in Hustle is credits, not real money"
        aria-label="Sandbox: credits, not real money"
        onClick={() => setOpen((o) => !o)}
        className="rounded-full border-2 border-line-strong bg-coin px-2.5 py-1 text-xs font-bold whitespace-nowrap text-[#1a1d3a]"
      >
        Sandbox
      </button>
      {open && (
        <section
          id="sandbox-panel"
          aria-label="Sandbox"
          className="sticker fixed inset-x-3 top-16 p-4 text-sm sm:absolute sm:inset-x-auto sm:top-auto sm:right-0 sm:mt-2 sm:w-80"
        >
          <h2 className="font-display text-lg font-bold">Sandbox</h2>
          <p className="mt-1 text-ink-2">
            Every amount in Hustle is credits, never real money: nothing you do here moves real
            funds.
          </p>
          {sandbox && (
            <details className="mt-3 rounded-xl border-2 border-line p-3">
              <summary className="cursor-pointer font-semibold">Demo</summary>
              <p className="mt-1 text-ink-2">
                Shortcuts for demos. They run the same world forward; they don't pick outcomes.
              </p>
              <div className="mt-3 grid gap-2">
                <Button
                  busy={busy === 'day'}
                  disabled={!me || !!busy}
                  onClick={() =>
                    run('day', async () => {
                      await post('/api/sandbox/advance', {
                        to: 'day_end',
                      });
                      toast('Day ended: upkeep charged and day reports written.', 'good');
                    })
                  }
                >
                  Skip to end of day
                </Button>
                <Button
                  busy={busy === 'ticks'}
                  disabled={!me || !!busy}
                  onClick={() =>
                    run('ticks', async () => {
                      // Ten world ticks of two seconds each.
                      await post('/api/sandbox/advance', { ticks: 10 });
                      toast('Skipped ahead 20 seconds.', 'neutral');
                    })
                  }
                >
                  Skip ahead 20 seconds
                </Button>
                <Button
                  variant="danger"
                  busy={busy === 'trap'}
                  disabled={!hasAgent || !!busy}
                  aria-describedby={hasAgent ? undefined : 'trap-why'}
                  onClick={() =>
                    run('trap', async () => {
                      const r = await post<{ jobId: string | null }>('/api/sandbox/trap');
                      // Stay put: a call may be open on this page, and the trap reaches the
                      // agent as a call anyway.
                      toast(
                        'Trap job posted for your agent. Watch for its call.',
                        'shield',
                        r.jobId ? { href: `/jobs/${r.jobId}`, label: 'View job' } : undefined,
                      );
                    })
                  }
                >
                  Post a trap job for my agent
                </Button>
                <Button
                  variant="secondary"
                  busy={busy === 'streak'}
                  disabled={!hasAgent || !!busy}
                  onClick={() =>
                    run('streak', async () => {
                      await post('/api/sandbox/streak');
                      toast(
                        'Demo shortcut: your agent is on a streak of 3. A contract offer comes next.',
                        'good',
                      );
                    })
                  }
                >
                  Give my agent a streak of 3 (demo)
                </Button>
                {!me ? (
                  <p className="text-xs text-muted">Sign in to use these.</p>
                ) : (
                  !hasAgent && (
                    <p id="trap-why" className="text-xs text-muted">
                      The trap job is posted for your own agent. Adopt one first.
                    </p>
                  )
                )}
              </div>
            </details>
          )}
        </section>
      )}
    </div>
  );
}
