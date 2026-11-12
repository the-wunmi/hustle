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
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [],
      fallback: [{ source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` }],
    };
  },
};

export default config;
