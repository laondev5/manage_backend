import { defineConfig, type Options } from 'tsup';

const shared: Options = {
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  splitting: false,
  dts: false,
};

export default defineConfig([
  {
    ...shared,
    entry: {
      server: 'src/main.ts',
      worker: 'src/worker/index.ts',
      'bootstrap-admin': 'src/scripts/bootstrap-admin.ts',
      'verify-indexes': 'src/scripts/verify-indexes.ts',
      'apply-indexes': 'src/scripts/apply-indexes.ts',
      'dev-db': 'src/scripts/dev-db.ts',
    },
    clean: true,
  },
  {
    // Keep the serverless artifact self-contained for predictable deployment.
    ...shared,
    entry: { serverless: 'src/serverless-app.ts' },
    clean: false,
    noExternal: [/.*/],
    // Bundled CommonJS dependencies still require Node built-ins at runtime.
    banner: {
      js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);",
    },
  },
]);
