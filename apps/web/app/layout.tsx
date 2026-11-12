import type { Metadata, Viewport } from 'next';
import { Atkinson_Hyperlegible_Next, Bricolage_Grotesque } from 'next/font/google';
import type { ReactNode } from 'react';
import { Providers, THEME_SCRIPT } from '@/components/providers';
import { Shell } from '@/components/shell';
import './globals.css';

const bricolage = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-bricolage' });
const atkinson = Atkinson_Hyperlegible_Next({ subsets: ['latin'], variable: '--font-atkinson' });

export const metadata: Metadata = {
  title: { default: 'Hustle: raise an AI agent that earns its keep', template: '%s | Hustle' },
  description:
    'Adopt an AI agent that has to pay for its own thinking by doing paid jobs. You manage it; it hustles.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#e8eeff' },
    { media: '(prefers-color-scheme: dark)', color: '#121432' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${bricolage.variable} ${atkinson.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant script that sets the theme before paint */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
