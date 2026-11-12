'use client';

import { useId, useState } from 'react';
import { useSWRConfig } from 'swr';
import { post, useApi } from '@/lib/api';
import { type NearAuthConfig, nearAuthIdToken } from '@/lib/near-auth';
import { Button, Field, InlineError, inputClass, Segmented } from '../ui';

interface Challenge {
  challengeId: string;
  simulatedInbox: { to: string; code: string };
}

/** Sign-in: real NEAR Auth, or (only when the API runs AUTH_MODE=mock) the labelled simulator. */
export function SignIn() {
  const { data: cfg } = useApi<NearAuthConfig>('/api/auth/config');
  if (!cfg) return <div className="sticker skeleton h-48 p-5" />;
  return cfg.mode === 'live' ? <LiveSignIn cfg={cfg} /> : <SimulatedSignIn />;
}

function LiveSignIn({ cfg }: { cfg: NearAuthConfig }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const done = useSignedIn();
  const nameId = useId();
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const allowed = cfg.allowedOrigins.length === 0 || cfg.allowedOrigins.includes(origin);
  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const idToken = await nearAuthIdToken(cfg);
      await post('/api/auth/id-token', { idToken, ...(name.trim() ? { name: name.trim() } : {}) });
      await done();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sticker p-5 sm:p-6">
      <h2 className="text-2xl font-extrabold">Start playing</h2>
      <p className="mt-1 text-sm text-ink-2">
        Sign in with NEAR Auth: email, Google or a passkey in a popup. No seed phrase, no gas fees.
        Your NEAR account is made for you.
      </p>
      <div className="mt-4 space-y-3">
        <Field label="Your name (optional)" htmlFor={nameId} hint="Shown next to your agent.">
          <input
            id={nameId}
            className={inputClass}
            value={name}
            maxLength={24}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {!allowed && (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm font-semibold text-warn">
            NEAR Auth's shared testnet client only accepts sign-ins from{' '}
            {cfg.allowedOrigins.join(' or ')}. Open the game there (run the web with WEB_PORT=3000)
            to sign in.
          </p>
        )}
        <Button busy={busy} disabled={!allowed} onClick={signIn}>
          Sign in with NEAR Auth
        </Button>
        <InlineError error={error} />
      </div>
    </div>
  );
}

function SimulatedSignIn() {
  const [method, setMethod] = useState<'email' | 'passkey'>('email');
  return (
    <div className="sticker p-5 sm:p-6">
      <h2 className="text-2xl font-extrabold">Start playing</h2>
      <p className="mt-1 text-sm text-ink-2">
        Simulated sign-in (AUTH_MODE=mock): the code shows on screen and nothing is sent. Your game
        account is made for you when you sign in.
      </p>
      <div className="mt-4">
        <Segmented
          label="Sign-in method"
          value={method}
          onChange={setMethod}
          size="sm"
          options={[
            { value: 'email', label: 'Email code' },
            { value: 'passkey', label: 'Passkey' },
          ]}
        />
      </div>
      <div className="mt-4">{method === 'email' ? <EmailSignIn /> : <PasskeySignIn />}</div>
    </div>
  );
}

function useSignedIn() {
  const { mutate } = useSWRConfig();
  return async () => {
    await mutate(() => true);
  };
}

function EmailSignIn() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const done = useSignedIn();
  const emailId = useId();
  const codeId = useId();
  const nameId = useId();

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      setChallenge(await post<Challenge>('/api/auth/email/start', { email }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/email/verify', {
        challengeId: challenge.challengeId,
        code: code.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      await done();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  if (!challenge) {
    return (
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Field label="Email" htmlFor={emailId}>
          <input
            id={emailId}
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
        </Field>
        <InlineError error={error} />
        <Button type="submit" variant="primary" size="lg" className="w-full" busy={busy}>
          Send me a code
        </Button>
      </form>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void verify();
      }}
    >
      <section
        aria-label="Simulated inbox"
        className="rounded-xl border-2 border-dashed border-warn/60 bg-warn-soft p-3"
      >
        <p className="text-xs font-semibold text-warn">Simulated inbox: no real email is sent</p>
        <p className="mt-1 text-sm">
          To {challenge.simulatedInbox.to}: your Hustle code is{' '}
          <strong className="font-display text-lg tracking-widest tnum">
            {challenge.simulatedInbox.code}
          </strong>
        </p>
        <Button size="sm" className="mt-2" onClick={() => setCode(challenge.simulatedInbox.code)}>
          Use this code
        </Button>
      </section>
      <Field label="6-digit code" htmlFor={codeId}>
        <input
          id={codeId}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className={`${inputClass} tracking-[0.3em] tnum`}
        />
      </Field>
      <Field
        label="Your name (optional)"
        htmlFor={nameId}
        hint="Shown next to your agent on the leaderboard."
      >
        <input
          id={nameId}
          autoComplete="given-name"
          maxLength={24}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
        />
      </Field>
      <InlineError error={error} />
      <div className="flex gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            setChallenge(null);
            setCode('');
            setError(null);
          }}
        >
          Change email
        </Button>
        <Button type="submit" variant="primary" size="lg" className="flex-1" busy={busy}>
          Sign in
        </Button>
      </div>
    </form>
  );
}

function PasskeySignIn() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const done = useSignedIn();
  const nameId = useId();
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await post('/api/auth/passkey', { name: name.trim() });
          await done();
        } catch (err) {
          setError(err);
          setBusy(false);
        }
      }}
    >
      <Field
        label="Your name"
        htmlFor={nameId}
        hint="Simulated passkey: this build makes the key for you, no device prompt."
      >
        <input
          id={nameId}
          required
          minLength={2}
          maxLength={24}
          autoComplete="given-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
        />
      </Field>
      <InlineError error={error} />
      <Button type="submit" variant="primary" size="lg" className="w-full" busy={busy}>
        Continue with a passkey
      </Button>
    </form>
  );
}
