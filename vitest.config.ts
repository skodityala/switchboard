import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve workspace packages to their SOURCE, not their built dist/.
 *
 * Cross-package test imports otherwise go through package.json "exports" to
 * dist/, which is gitignored — so `npm test` on a fresh clone failed while
 * passing locally, because dist/ already existed. Pointing at src makes the
 * suite independent of build state.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@switchboard/catalog': join(root, 'packages/catalog/src/index.ts'),
      '@switchboard/memory': join(root, 'packages/memory/src/index.ts'),
      '@switchboard/reasoner': join(root, 'packages/reasoner/src/index.ts'),
      '@switchboard/channel': join(root, 'packages/channel/src/index.ts'),
      '@switchboard/ui': join(root, 'packages/ui/src/index.ts'),
    },
  },
});
