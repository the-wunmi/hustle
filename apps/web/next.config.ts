import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const API_ORIGIN = process.env.HUSTLE_API_ORIGIN ?? 'http://localhost:4300';

const config: NextConfig = {
  reactStrictMode: true,
  // A self-contained server for the production image (apps/web/Dockerfile); traced from the
  // monorepo root so workspace packages are included.
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  devIndicators: false,
  // @hustle/core ships TypeScript sources with .ts import specifiers.
  transpilePackages: ['@hustle/core'],
  // The live feed is Server-Sent Events through the /api rewrite; compressing it would buffer it.
  compress: false,
  typescript: {
    // Type checking runs through `pnpm typecheck` (tsc --noEmit), which uses the workspace compiler.
    ignoreBuildErrors: true,
  },
  // The re-run frame has an opaque origin (sandboxed iframe), so it fetches Pyodide cross-origin.
  // These are public, static files: any origin may read them.
  async headers() {
    return [
      { source: '/pyodide/:path*', headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }] },
      {
        // The re-run frame runs code the viewer didn't write: it may load scripts and fetch only
        // from this site (Pyodide), start its blob worker, and nothing else; and it is sandboxed
        // even if opened on its own.
        source: '/rerun/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value:
              "sandbox allow-scripts; default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src blob:; connect-src 'self'",
          },
        ],
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [],
      fallback: [{ source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` }],
    };
  },
};

export default config;
