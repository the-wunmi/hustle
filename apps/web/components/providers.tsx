'use client';

import type { FeedEventView } from '@hustle/core/browser';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SWRConfig, useSWRConfig } from 'swr';
import { api, fetcher, useMe } from '@/lib/api';

// ── Theme ───────────────────────────────────────────────────────────────────────────────────────

export type ThemePref = 'system' | 'light' | 'dark';
const THEME_KEY = 'hustle-theme';

/** Runs before paint (inlined in <head>) so the page never flashes the wrong theme. */
export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem('${THEME_KEY}')||'system';var d=p==='dark'||(p==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';}catch(e){}})();`;

const ThemeCtx = createContext<{ pref: ThemePref; setPref: (p: ThemePref) => void }>({
  pref: 'system',
  setPref: () => {},
});
export const useTheme = () => useContext(ThemeCtx);

function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>('system');
  useEffect(() => {
    setPrefState((localStorage.getItem(THEME_KEY) as ThemePref | null) ?? 'system');
  }, []);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = pref === 'dark' || (pref === 'system' && mq.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [pref]);
  const setPref = useCallback((p: ThemePref) => {
    localStorage.setItem(THEME_KEY, p);
    setPrefState(p);
  }, []);
  return <ThemeCtx.Provider value={{ pref, setPref }}>{children}</ThemeCtx.Provider>;
}

// ── Sound ───────────────────────────────────────────────────────────────────────────────────────

type Sfx = 'coin' | 'shield' | 'win' | 'spend' | 'call';
const SOUND_KEY = 'hustle-muted';

const SoundCtx = createContext<{ muted: boolean; toggle: () => void; play: (s: Sfx) => void }>({
  muted: true,
  toggle: () => {},
  play: () => {},
});
export const useSound = () => useContext(SoundCtx);

/** Notes for each effect: [frequency Hz, start s, length s, waveform]. */
const NOTES: Record<Sfx, [number, number, number, OscillatorType][]> = {
  coin: [
    [988, 0, 0.08, 'square'],
    [1319, 0.07, 0.22, 'square'],
  ],
  win: [
    [784, 0, 0.1, 'triangle'],
    [988, 0.09, 0.1, 'triangle'],
    [1319, 0.18, 0.25, 'triangle'],
  ],
  shield: [
    [330, 0, 0.12, 'sawtooth'],
    [262, 0.1, 0.22, 'sawtooth'],
  ],
  spend: [[520, 0, 0.05, 'triangle']],
  call: [
    [660, 0, 0.11, 'sine'],
    [880, 0.13, 0.11, 'sine'],
    [660, 0.3, 0.11, 'sine'],
    [880, 0.43, 0.16, 'sine'],
  ],
};

function SoundProvider({ children }: { children: ReactNode }) {
  const [muted, setMuted] = useState(true);
  const ctx = useRef<AudioContext | null>(null);
  useEffect(() => {
    setMuted(localStorage.getItem(SOUND_KEY) === '1');
  }, []);
  const toggle = useCallback(() => {
    setMuted((m) => {
      localStorage.setItem(SOUND_KEY, m ? '0' : '1');
      return !m;
    });
  }, []);
  const play = useCallback(
    (s: Sfx) => {
      if (muted || typeof window === 'undefined') return;
      try {
        ctx.current ??= new AudioContext();
        const ac = ctx.current;
        // Browsers keep audio suspended until the page has had a click; skip quietly until then.
        if (ac.state === 'suspended') void ac.resume();
        const t0 = ac.currentTime;
        for (const [freq, start, len, type] of NOTES[s]) {
          const osc = ac.createOscillator();
          const gain = ac.createGain();
          osc.type = type;
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, t0 + start);
          gain.gain.exponentialRampToValueAtTime(0.06, t0 + start + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + len);
          osc.connect(gain).connect(ac.destination);
          osc.start(t0 + start);
          osc.stop(t0 + start + len + 0.02);
        }
      } catch {
        // No audio device or API: the game works silently.
      }
    },
    [muted],
  );
  return <SoundCtx.Provider value={{ muted, toggle, play }}>{children}</SoundCtx.Provider>;
}

// ── Toasts ──────────────────────────────────────────────────────────────────────────────────────

type ToastTone = 'good' | 'bad' | 'neutral' | 'shield';
interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  link?: { href: string; label: string };
}
type PushToast = (text: string, tone?: ToastTone, link?: { href: string; label: string }) => void;
const ToastCtx = createContext<PushToast>(() => {});
export const useToast = () => useContext(ToastCtx);

const TOAST_TONE: Record<ToastTone, string> = {
  good: 'border-good text-ink',
  bad: 'border-bad text-ink',
  neutral: 'border-line-strong text-ink',
  shield: 'border-shield text-ink',
};

function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback<PushToast>((text, tone = 'neutral', link) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, text, tone, ...(link ? { link } : {}) }]);
    // A toast with a link stays longer, so there is time to use it.
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), link ? 9000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-3 bottom-3 left-3 z-50 flex flex-col items-end gap-2 sm:left-auto"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto max-w-md rounded-xl border-2 bg-surface px-4 py-2.5 text-sm font-semibold shadow-[3px_3px_0_var(--shadow)] ${TOAST_TONE[t.tone]}`}
          >
            {t.text}
            {t.link && (
              <a href={t.link.href} className="ml-2 text-brand underline underline-offset-2">
                {t.link.label}
              </a>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ── Live feed ───────────────────────────────────────────────────────────────────────────────────

/** Events kept in memory for the home feed. */
const FEED_CAP = 150;
/** If the stream sends nothing for this long, fall back to polling. */
const STREAM_SILENCE_MS = 9000;
const POLL_MS = 2000;
/** Every this many world ticks (2 s each) every mounted API view refreshes once. */
const HEARTBEAT_TICKS = 3;
/** Views that don't change with the world clock, or are expensive, skip the heartbeat. */
const STATIC_KEYS = ['/api/brains', '/api/task-ideas', '/api/vendors', '/api/attestation/live'];
/**
 * The holder console reads the chain when it loads (and a refused viewer would get a 403 every
 * heartbeat), so it refreshes on load and focus only.
 */
const isLiveKey = (k: unknown) =>
  typeof k === 'string' &&
  k.startsWith('/api/') &&
  !STATIC_KEYS.some((s) => k.startsWith(s)) &&
  !k.endsWith('/holder');

type FeedListener = (e: FeedEventView) => void;
interface FeedState {
  events: FeedEventView[];
  /** Sequence numbers that arrived after the first load, for highlighting. */
  fresh: Set<number>;
  transport: 'connecting' | 'live' | 'polling';
  tick: number | null;
  subscribe: (fn: FeedListener) => () => void;
}
const FeedCtx = createContext<FeedState>({
  events: [],
  fresh: new Set(),
  transport: 'connecting',
  tick: null,
  subscribe: () => () => {},
});
export const useFeed = () => useContext(FeedCtx);

function FeedProvider({ children }: { children: ReactNode }) {
  const { data: me } = useMe();
  const viewer = me?.player.id ?? 'anon';
  const { mutate } = useSWRConfig();
  const { play } = useSound();
  const [events, setEvents] = useState<FeedEventView[]>([]);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [transport, setTransport] = useState<FeedState['transport']>('connecting');
  const [tick, setTick] = useState<number | null>(null);
  const listeners = useRef(new Set<FeedListener>());
  const playRef = useRef(play);
  playRef.current = play;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the stream's visibility depends on who is signed in, so it restarts when the viewer changes
  useEffect(() => {
    let lastSeq = 0;
    let primed = false;
    let closed = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    setEvents([]);
    setFresh(new Set());

    // Asking for calls is what tells the server this player is watching, so ask every tick, but only
    // while the tab is visible: a hidden tab shouldn't keep raising calls nobody sees.
    const refreshCalls = () => {
      if (document.visibilityState === 'visible') void mutate('/api/calls');
    };

    const ingest = (incoming: FeedEventView[]) => {
      const added = incoming.filter((e) => e.seq > lastSeq).sort((a, b) => a.seq - b.seq);
      if (added.length === 0) return;
      lastSeq = added[added.length - 1]?.seq ?? lastSeq;
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.seq));
        const merged = [...added.filter((e) => !seen.has(e.seq)).reverse(), ...prev];
        return merged.slice(0, FEED_CAP);
      });
      if (!primed) return;
      setFresh((prev) => new Set([...prev, ...added.map((e) => e.seq)].slice(-40)));
      for (const e of added) {
        for (const fn of listeners.current) fn(e);
        if (!e.agent?.isMine) continue;
        if (e.kind === 'paid') playRef.current('coin');
        else if (e.kind === 'bid_won') playRef.current('win');
        else if (e.kind === 'spend_blocked') playRef.current('shield');
      }
      if (added.some((e) => e.agent?.isMine)) void mutate('/api/me');
      if (added.some((e) => e.kind === 'approval_requested')) void mutate('/api/approvals');
      // Pages showing a job or an agent refresh as soon as the feed says something happened to it.
      const jobs = new Set(added.flatMap((e) => (e.jobId ? [e.jobId] : [])));
      const agents = new Set(added.flatMap((e) => (e.agent ? [e.agent.id] : [])));
      void mutate(
        (k) =>
          typeof k === 'string' &&
          ([...jobs].some((id) => k === `/api/jobs/${id}` || k.startsWith(`/api/feed?job=${id}`)) ||
            [...agents].some(
              (id) => k === `/api/agents/${id}` || k.startsWith(`/api/feed?agent=${id}`),
            )),
      );
    };

    const startPolling = () => {
      if (pollTimer || closed) return;
      setTransport('polling');
      let polls = 0;
      const poll = async () => {
        try {
          const batch = await api<FeedEventView[]>(
            lastSeq ? `/api/feed?after=${lastSeq}&limit=100` : '/api/feed?limit=40',
          );
          ingest(batch);
          primed = true;
          // Polls run every 2 s, about one world tick each.
          refreshCalls();
          if (++polls % HEARTBEAT_TICKS === 0) void mutate(isLiveKey);
          else void mutate('/api/world');
        } catch {
          // Keep polling; the header shows the API state.
        }
      };
      void poll();
      pollTimer = setInterval(poll, POLL_MS);
    };

    const source = new EventSource('/api/feed/stream', { withCredentials: true });
    const armSilence = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        source.close();
        startPolling();
      }, STREAM_SILENCE_MS);
    };
    armSilence();
    source.addEventListener('feed', (msg) => {
      armSilence();
      try {
        ingest([JSON.parse((msg as MessageEvent<string>).data) as FeedEventView]);
      } catch {
        // A malformed event is skipped; the next one carries on.
      }
    });
    source.addEventListener('tick', (msg) => {
      armSilence();
      primed = true;
      setTransport('live');
      try {
        const t = JSON.parse((msg as MessageEvent<string>).data) as { tick: number };
        setTick(t.tick);
        refreshCalls();
        if (t.tick % HEARTBEAT_TICKS === 0) {
          void mutate(isLiveKey);
          return;
        }
      } catch {
        // Ignore.
      }
      void mutate('/api/world');
    });
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) startPolling();
      else setTransport('connecting');
    };

    return () => {
      closed = true;
      source.close();
      if (pollTimer) clearInterval(pollTimer);
      if (silenceTimer) clearTimeout(silenceTimer);
    };
  }, [viewer, mutate]);

  const subscribe = useCallback((fn: FeedListener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const value = useMemo(
    () => ({ events, fresh, transport, tick, subscribe }),
    [events, fresh, transport, tick, subscribe],
  );
  return <FeedCtx.Provider value={value}>{children}</FeedCtx.Provider>;
}

// ── Root ────────────────────────────────────────────────────────────────────────────────────────

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ fetcher, revalidateOnFocus: true, shouldRetryOnError: false }}>
      <ThemeProvider>
        <SoundProvider>
          <ToastProvider>
            <FeedProvider>{children}</FeedProvider>
          </ToastProvider>
        </SoundProvider>
      </ThemeProvider>
    </SWRConfig>
  );
}
