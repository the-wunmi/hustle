import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Sandbox scenarios send dozens of transactions each, and the day-reset one fast-forwards about
    // 1,200 blocks: ~30s on an idle machine, minutes on a busy one. The simulator's take milliseconds.
    testTimeout: process.env.NEAR_SANDBOX_TESTS === '1' ? 600_000 : 5_000,
    hookTimeout: 180_000,
  },
});
