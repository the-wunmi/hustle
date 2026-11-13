'use client';

import { useEffect } from 'react';
import { WalletSignIn } from '@/components/onboarding/sign-in';

/**
 * NEAR wallet sign-in. This page alone loads the wallet connector, whose sandboxed wallet code
 * needs a wider content security policy (served for this path only). Links away from it load the
 * next page afresh, so the rest of the game never runs under that policy.
 */
export default function SignInPage() {
  useEffect(() => {
    const leave = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!link || link.target === '_blank' || e.defaultPrevented) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname)
        return;
      // Stop Next's client-side navigation: a full load picks up the strict policy again.
      e.preventDefault();
      e.stopPropagation();
      window.location.assign(url.href);
    };
    document.addEventListener('click', leave, true);
    return () => document.removeEventListener('click', leave, true);
  }, []);
  return (
    <div className="mx-auto max-w-md py-6">
      <WalletSignIn />
    </div>
  );
}
