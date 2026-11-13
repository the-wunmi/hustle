'use client';

import { createAuth0Client } from '@auth0/auth0-spa-js';

/** What the API says about live NEAR Auth: the Auth0 tenant and client the browser signs in with. */
export interface NearAuthConfig {
  mode: 'live' | 'mock';
  domain: string;
  clientId: string;
  /** Origins the tenant accepts as a callback (the shared testnet client: http://localhost:3000). */
  allowedOrigins: string[];
  /** Whether the labelled stand-in sign-in (email code on screen) is offered here. */
  mock: boolean;
  /** NEAR wallet sign-in: the network and the NEP-413 recipient the wallet signs for. */
  wallet: { network: 'testnet'; recipient: string };
}

/**
 * Real NEAR Auth sign-in: Auth0's popup (email code, Google, passkey…) on the NEAR Auth tenant.
 * Returns the raw id token, which the API verifies against the tenant's keys before it makes or
 * finds the player.
 */
export async function nearAuthIdToken(cfg: NearAuthConfig): Promise<string> {
  const client = await createAuth0Client({
    domain: cfg.domain,
    clientId: cfg.clientId,
    authorizationParams: { redirect_uri: window.location.origin, scope: 'openid profile email' },
    cacheLocation: 'memory',
  });
  await client.loginWithPopup({ authorizationParams: { prompt: 'login' } });
  const claims = await client.getIdTokenClaims();
  if (!claims?.__raw) throw new Error('NEAR Auth returned no id token');
  return claims.__raw;
}
