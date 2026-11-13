import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Engine tests drive the chain stand-in and Postgres end to end; under a full parallel run on a
    // busy machine a few take longer than vitest's 5 s default.
    testTimeout: 20_000,
  },
});
