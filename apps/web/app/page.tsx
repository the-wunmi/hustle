'use client';

import type { MarketplaceView } from '@hustle/core/browser';
import Link from 'next/link';
import { Hustle } from '@/components/home/hustle';
import { Landing } from '@/components/home/landing';
import { Creator } from '@/components/onboarding/creator';
import { ErrorNote, Loading } from '@/components/ui';
import { useApi, useMe } from '@/lib/api';
import { fmt } from '@/lib/money';

/**
 * A player left with no agent because they sold theirs sees what happened before the adopt form,
 * instead of a blank start as if the agent had vanished.
 */
function SoldNotice() {
  const { data } = useApi<MarketplaceView>('/api/marketplace');
  const sale = data?.recentSales.find((s) => s.sellerIsMe);
  if (!sale) return null;
  return (
    <div className="sticker mb-6 p-4">
      <p className="font-display text-lg font-extrabold">
        You sold {sale.agentName} to {sale.buyerName} for {fmt(sale.price)}.
      </p>
      <p className="text-sm text-ink-2">
        The price, less the market's fee, is in your{' '}
        <Link href="/wallet" className="font-semibold underline">
          wallet
        </Link>
        . {sale.agentName} kept its wallet, record and badges. Adopt a new agent below, or{' '}
        <Link href="/agents?tab=market" className="font-semibold underline">
          buy one on the marketplace
        </Link>
        .
      </p>
    </div>
  );
}

export default function HomePage() {
  const { data: me, error, isLoading, mutate } = useMe();
  if (isLoading) return <Loading rows={4} label="Loading your game" />;
  if (error) return <ErrorNote error={error} retry={() => mutate()} />;
  if (!me) return <Landing />;
  if (me.agents.length === 0) {
    return (
      <>
        <SoldNotice />
        <Creator first />
      </>
    );
  }
  return <Hustle me={me} />;
}
