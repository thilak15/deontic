import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@deontic/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@deontic/cli': path.resolve(__dirname, 'packages/cli/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
