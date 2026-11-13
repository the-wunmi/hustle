'use client';

import { post } from '@/lib/api';

interface WalletChallenge {
  message: string;
  /** Base64 of 32 random bytes. */
  nonce: string;
  recipient: string;
}

interface SignedMessage {
  accountId: string;
  publicKey: string;
  signature: string;
}

/**
 * Sign in with a NEAR wallet on testnet (NEAR Connect, `@hot-labs/near-connect`): the player picks a
 * wallet, it signs the API's one-time challenge (NEP-413), and the API checks the signature and that
 * the key is a full-access key of the account before it starts a session. Nothing is sent on chain
 * and the wallet pays nothing; the connection is dropped once the message is signed.
 */
export async function walletSignIn(): Promise<void> {
  const challenge = await post<WalletChallenge>('/api/auth/wallet/challenge');
  const nonce = Uint8Array.from(atob(challenge.nonce), (c) => c.charCodeAt(0));
  const { NearConnector } = await import('@hot-labs/near-connect');
  const connector = new NearConnector({
    network: 'testnet',
    // Only wallets that can sign a message on testnet are offered.
    features: { signMessage: true, testnet: true },
    // WalletConnect needs a project id we don't have; Ethereum wallets can't sign NEP-413.
    excludedWallets: ['wallet-connect', 'ethereum-wallets'],
    autoConnect: false,
  });
  const params = { message: challenge.message, recipient: challenge.recipient, nonce };
  // Wallets that sign during sign-in report it with this event; the others are asked afterwards.
  let signed: SignedMessage | null = null;
  connector.on('wallet:signInAndSignMessage', (e) => {
    signed = e.accounts[0]?.signedMessage ?? null;
  });
  try {
    const wallet = await connector.connect({ signMessageParams: params });
    // The event can trail the connect promise slightly.
    for (let i = 0; i < 15 && !signed; i++) await new Promise((r) => setTimeout(r, 100));
    const proof: SignedMessage =
      (signed as SignedMessage | null) ??
      (await wallet.signMessage({ ...params, network: 'testnet' }));
    await post('/api/auth/wallet/verify', {
      accountId: proof.accountId,
      publicKey: proof.publicKey,
      signature: proof.signature,
      nonce: challenge.nonce,
      recipient: challenge.recipient,
    });
  } finally {
    await connector.disconnect().catch(() => undefined);
  }
}
