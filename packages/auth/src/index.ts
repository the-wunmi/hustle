import {
  createHmac,
  createPublicKey,
  createVerify,
  type JsonWebKey,
  randomBytes,
} from 'node:crypto';

export interface Identity {
  /** Auth0 `sub` (or `wallet:<account>` for NEAR wallet sign-in), stable per person and method. */
  sub: string;
  email: string | null;
  method: 'email' | 'passkey' | 'wallet';
}

/**
 * NEAR Auth (formerly FastAuth): Auth0 login (email, Google, Apple, passkey) whose JWT the MPC network
 * trusts to derive a per-identity key. The game only needs the verified identity; it then creates the
 * player's NEAR account itself, since NEAR Auth derives a key but doesn't create a named account.
 */
export interface NearAuth {
  readonly mode: 'mock' | 'live';
  verifyIdToken(token: string): Promise<Identity>;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** How long a simulated Auth0 id token stays valid. */
const TOKEN_TTL_S = 300;

/**
 * Plays Auth0 + NEAR Auth in mock mode: issues HS256 id tokens for identities the game's simulated
 * email-code and passkey steps produced. No real email is sent; the UI shows the code in a simulated
 * inbox and says so.
 */
export class NearAuthSimulator implements NearAuth {
  readonly mode = 'mock' as const;
  constructor(private readonly secret: string) {}

  issueIdToken(identity: Identity): string {
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64url(
      JSON.stringify({
        iss: 'https://login.sim.fast-auth.local/',
        sub: identity.sub,
        email: identity.email,
        amr: [identity.method === 'passkey' ? 'webauthn' : 'otp'],
        iat: now,
        exp: now + TOKEN_TTL_S,
      }),
    );
    const sig = createHmac('sha256', this.secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${sig}`;
  }

  newPasskeySubject(): string {
    return `passkey|${randomBytes(12).toString('hex')}`;
  }

  async verifyIdToken(token: string): Promise<Identity> {
    const [header, payload, sig] = token.split('.');
    if (!header || !payload || !sig) throw new AuthError('Malformed token');
    const expected = createHmac('sha256', this.secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    if (expected !== sig) throw new AuthError('Bad token signature');
    return identityFromClaims(JSON.parse(Buffer.from(payload, 'base64url').toString()));
  }
}

function identityFromClaims(claims: {
  sub?: string;
  email?: string | null;
  amr?: string[];
  exp?: number;
}): Identity {
  if (!claims.sub) throw new AuthError('Token has no subject');
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new AuthError('Token expired');
  return {
    sub: claims.sub,
    email: claims.email ?? null,
    method: claims.amr?.includes('webauthn') ? 'passkey' : 'email',
  };
}

/**
 * Verifies a real NEAR Auth (Auth0) RS256 id token against the tenant's JWKS (fetched live from
 * `https://<domain>/.well-known/jwks.json`). Not yet run against a token from a real sign-in: that
 * needs a person to sign in through the popup.
 */
export class NearAuthClient implements NearAuth {
  readonly mode = 'live' as const;
  constructor(
    private readonly domain: string,
    private readonly clientId: string,
  ) {}

  async verifyIdToken(token: string): Promise<Identity> {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) throw new AuthError('Malformed token');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as {
      kid?: string;
      alg?: string;
    };
    if (header.alg !== 'RS256') throw new AuthError('Unexpected token algorithm');
    const res = await fetch(`https://${this.domain}/.well-known/jwks.json`, {
      signal: AbortSignal.timeout(10_000),
    });
    const { keys } = (await res.json()) as { keys: (JsonWebKey & { kid?: string })[] };
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) throw new AuthError('Unknown signing key');
    const ok = createVerify('RSA-SHA256')
      .update(`${h}.${p}`)
      .verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
    if (!ok) throw new AuthError('Bad token signature');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as {
      aud?: string | string[];
      iss?: string;
      sub?: string;
      email?: string | null;
      amr?: string[];
      exp?: number;
    };
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.clientId)) throw new AuthError('Token is for another client');
    if (claims.iss !== `https://${this.domain}/`) throw new AuthError('Token from another issuer');
    return identityFromClaims(claims);
  }
}

/**
 * NEAR Auth's shared testnet client (docs.auth.near.org/resources/testnet, read 2026-11-12): for
 * development only. Its Auth0 app accepts sign-ins from http://localhost:3000 alone (checked
 * 2026-11-12: /authorize answers "Callback URL mismatch" for every other localhost port tried).
 */
export const NEAR_AUTH_TESTNET = {
  domain: 'login.testnet.fast-auth.com',
  clientId: 'np8paqIpMWmNbzT4xAvOOapZBjsOpptl',
  /** The audience its JWT guard (`auth0.jwt.fast-auth.testnet`) expects of an access token. */
  audience: 'auth0.jwt.fast-auth.testnet',
  allowedOrigins: ['http://localhost:3000'],
} as const;

/** The player's NEAR account name: a short, stable hash of the identity under the game's root. */
export function playerAccountId(secret: string, sub: string, root: string): string {
  const h = createHmac('sha256', secret).update(`player:${sub}`).digest('hex').slice(0, 12);
  return `p-${h}.${root}`;
}
export * from './nep413.ts';
