'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { post, useMe } from '@/lib/api';
import { fmt, parseDollars } from '@/lib/money';
import { useSound, useToast } from './providers';
import { Button, Dialog, Field, InlineError, inputClass } from './ui';

type Mode = 'topup' | 'withdraw' | 'back';

const COPY: Record<
  Mode,
  { title: (n: string) => string; verb: string; done: (n: string, a: string) => string }
> = {
  topup: {
    title: (n) => `Top up ${n}`,
    verb: 'Top up',
    done: (n, a) => `Sent ${a} to ${n}.`,
  },
  withdraw: {
    title: (n) => `Withdraw from ${n}`,
    verb: 'Withdraw',
    done: (n, a) => `Moved ${a} from ${n} to your wallet.`,
  },
  back: {
    title: (n) => `Back ${n}`,
    verb: 'Back this agent',
    done: (n, a) => `You backed ${n} with ${a}.`,
  },
};

const QUICK = ['0.50', '1', '2'];

/** Moves credits between your wallet and an agent: top up, withdraw, or back someone else's. */
export function MoneyDialog({
  agent,
  mode,
  open,
  onClose,
}: {
  agent: { id: string; name: string; balance?: string };
  mode: Mode;
  open: boolean;
  onClose: () => void;
}) {
  const { data: me } = useMe();
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const { play } = useSound();
  const [value, setValue] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const id = useId();
  const copy = COPY[mode];
  const micro = parseDollars(value);
  // One id per transfer: a retry or a double click of the same amount reuses it, so the server
  // moves the money once. Opening the dialog or changing the amount starts a new transfer.
  const requestId = useRef<string>('');
  const inFlight = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new id whenever the transfer changes
  useEffect(() => {
    requestId.current = crypto.randomUUID();
  }, [open, value]);

  const submit = async () => {
    // A second click lands before React re-renders the disabled button; drop it here.
    if (inFlight.current) return;
    if (!micro || BigInt(micro) === 0n) {
      setError(new Error('Enter an amount in dollars, like 1.50'));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await post(`/api/agents/${agent.id}/${mode}`, {
        amount: micro,
        requestId: requestId.current,
      });
      requestId.current = crypto.randomUUID();
      play('coin');
      toast(copy.done(agent.name, fmt(micro)), 'good');
      await mutate(() => true);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={copy.title(agent.name)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        {mode === 'back' && (
          <p className="text-sm text-ink-2">
            Backing is a gift of credits from your wallet to {agent.name}'s own wallet. You don't
            get them back. If {agent.name} is asleep, enough credits wake it up.
          </p>
        )}
        {mode === 'withdraw' && agent.balance && (
          <p className="text-sm text-ink-2">
            {agent.name} has {fmt(agent.balance)}. Leave enough for thinking costs and the daily
            upkeep, or it will go to sleep. Credits only; nothing real is sent.
          </p>
        )}
        <Field
          label="Amount, in dollars"
          htmlFor={id}
          hint={me && mode !== 'withdraw' ? `Your wallet has ${fmt(me.player.wallet)}.` : undefined}
        >
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
              $
            </span>
            <input
              id={id}
              inputMode="decimal"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className={`${inputClass} pl-7 tnum`}
            />
          </div>
        </Field>
        <div className="flex gap-2">
          {QUICK.map((q) => (
            <Button key={q} size="sm" onClick={() => setValue(q)}>
              ${q}
            </Button>
          ))}
        </div>
        <InlineError error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={mode === 'withdraw' ? 'secondary' : 'coin'} busy={busy}>
            {copy.verb} {micro ? fmt(micro) : ''}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A button that opens the money dialog. */
export function MoneyButton({
  agent,
  mode,
  variant,
  size = 'md',
  className,
  children,
}: {
  agent: { id: string; name: string; balance?: string };
  mode: Mode;
  variant?: 'primary' | 'secondary' | 'coin' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant={variant ?? (mode === 'withdraw' ? 'secondary' : 'coin')}
        size={size}
        className={className}
        onClick={() => setOpen(true)}
      >
        {children ?? COPY[mode].verb}
      </Button>
      <MoneyDialog agent={agent} mode={mode} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
