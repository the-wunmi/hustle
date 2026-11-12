'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';

export interface TabDef<T extends string> {
  id: T;
  label: string;
}

/** The current tab from `?tab=`, falling back to the first. */
export function useTab<T extends string>(tabs: readonly TabDef<T>[]): T {
  const asked = useSearchParams().get('tab');
  const first = tabs[0];
  if (!first) throw new Error('useTab needs at least one tab');
  return (tabs.find((t) => t.id === asked)?.id ?? first.id) as T;
}

/**
 * Tabs as links (`?tab=…`), so every tab has its own URL that can be shared or bookmarked, and the
 * browser's back button walks between them. Wraps onto a second line on a narrow screen.
 */
export function TabBar<T extends string>({
  tabs,
  current,
  label,
}: {
  tabs: readonly TabDef<T>[];
  current: T;
  label: string;
}) {
  const path = usePathname();
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-x-1 border-b-2 border-line">
        {tabs.map((t, i) => {
          const active = t.id === current;
          return (
            <li key={t.id}>
              <Link
                href={i === 0 ? path : `${path}?tab=${t.id}`}
                scroll={false}
                aria-current={active ? 'page' : undefined}
                className={`-mb-0.5 block border-b-4 px-3 py-2 text-sm font-semibold whitespace-nowrap ${active ? 'border-ink text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function TabPanel({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section aria-label={label} className="space-y-6">
      {children}
    </section>
  );
}
