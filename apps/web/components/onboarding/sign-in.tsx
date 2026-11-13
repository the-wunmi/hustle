'use client';

import { useId, useState } from 'react';
import { useSWRConfig } from 'swr';
import { post, useApi } from '@/lib/api';
import { type NearAuthConfig, nearAuthIdToken } from '@/lib/near-auth';
import { Button, ButtonLink, Field, InlineError, inputClass, Segmented } from '../ui';

interface Challenge {
  challengeId: string;
  simulatedInbox: { to: string; code: string };
}

/**
 * Sign-in: a NEAR testnet wallet first (works on any domain); NEAR Auth's popup where its client
 * accepts this origin; and the labelled stand-in only where the API offers it (AUTH_MODE=mock,
 * never in production unless explicitly allowed).
 */
export function SignIn() {
  const { data: cfg } = useApi<NearAuthConfig>('/api/auth/config');
  if (!cfg) return <div className="sticker skeleton h-48 p-5" />;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const nearAuth =
    cfg.mode === 'live' && (cfg.allowedOrigins.length === 0 || cfg.allowedOrigins.includes(origin));
  return (
    <div className="sticker p-5 sm:p-6">
      <h2 className="text-2xl font-extrabold">Start playing</h2>
      <WalletIntro />
      {/* A full page load: the wallet connector runs only on /sign-in, under that page's own
          (wider) content security policy; every other page keeps the strict one. */}
      <ButtonLink
        href={WALLET_SIGN_IN_PATH}
        fullLoad
        variant="primary"
        className="mt-3 h-12 w-full text-base"
      >
        Sign in with a NEAR wallet
      </ButtonLink>
      <WalletHelp />
      {nearAuth && <LiveSignIn cfg={cfg} />}
      {cfg.mock && <SimulatedSignIn />}
    </div>
  );
}

/** The only page that loads the wallet connector (and is served with the CSP it needs). */
export const WALLET_SIGN_IN_PATH = '/sign-in';

function WalletIntro() {
  return (
    <p className="mt-2 text-sm text-ink-2">
      Sign in with your NEAR testnet account. Your wallet only signs a message to prove it's you:
      nothing is sent and it pays nothing. The game makes and funds everything else.
    </p>
  );
}

function WalletHelp() {
  return (
    <p className="mt-3 text-xs text-muted">
      No testnet account yet? Create one free in{' '}
      <a
        href={TESTNET_WALLET.url}
        target="_blank"
        rel="noreferrer"
        className="font-semibold underline underline-offset-2"
      >
        {TESTNET_WALLET.name}
      </a>{' '}
      (switch it to testnet), or use Intear, Nightly or a Ledger.
    </p>
  );
}

/** Where to send players without a testnet account: a wallet NEAR Connect offers on testnet that can sign a message (its manifest, 2026-11-13). */
const TESTNET_WALLET = { name: 'Meteor Wallet', url: 'https://wallet.meteorwallet.app' };

/**
 * The wallet sign-in itself, on /sign-in only. On success it leaves with a full page load, so the
 * game runs under the strict policy again.
 */
export function WalletSignIn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="sticker p-5 sm:p-6">
      <h1 className="text-2xl font-extrabold">Sign in with a NEAR wallet</h1>
      <WalletIntro />
      <p className="mt-2 text-sm font-semibold">Only sign this on hustle.clanker.show.</p>
      <Button
        variant="primary"
        size="lg"
        className="mt-3 w-full"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const { walletSignIn } = await import('@/lib/near-wallet');
            await walletSignIn();
            window.location.assign('/');
          } catch (err) {
            setError(err);
            setBusy(false);
          }
        }}
      >
        Choose a wallet
      </Button>
      <InlineError error={error} />
      <WalletHelp />
      <p className="mt-4 text-sm">
        <a href="/" className="font-semibold underline underline-offset-2">
          Back to the game
        </a>
      </p>
    </div>
  );
}

/** NEAR Auth's popup (email, Google, passkey), offered only where its client accepts this origin. */
function LiveSignIn({ cfg }: { cfg: NearAuthConfig }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const done = useSignedIn();
  const nameId = useId();
  return (
    <div className="mt-5 space-y-3 border-t border-line pt-4">
      <p className="text-sm text-ink-2">
        Or sign in with NEAR Auth: email, Google or a passkey in a popup. No seed phrase, no gas
        fees.
      </p>
      <Field label="Your name (optional)" htmlFor={nameId} hint="Shown next to your agent.">
        <input
          id={nameId}
          className={inputClass}
          value={name}
          maxLength={24}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Button
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const idToken = await nearAuthIdToken(cfg);
            await post('/api/auth/id-token', {
              idToken,
              ...(name.trim() ? { name: name.trim() } : {}),
            });
            await done();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        Sign in with NEAR Auth
      </Button>
      <InlineError error={error} />
    </div>
  );
}

function SimulatedSignIn() {
  const [method, setMethod] = useState<'email' | 'passkey'>('email');
  return (
    <div className="mt-5 border-t border-line pt-4">
      <p className="text-sm text-ink-2">
        Or use the stand-in sign-in (this server runs AUTH_MODE=mock): the code shows on screen and
        nothing is sent.
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
        <Button type="submit" variant="secondary" className="w-full" busy={busy}>
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
        <Button type="submit" variant="secondary" className="flex-1" busy={busy}>
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
      <Button type="submit" variant="secondary" className="w-full" busy={busy}>
        Continue with a passkey
      </Button>
    </form>
  );
}
