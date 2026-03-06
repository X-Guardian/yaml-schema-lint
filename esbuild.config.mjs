import * as esbuild from 'esbuild';
import process from 'node:process';
import console from 'node:console';

/**
 * yaml-language-server hardcodes imports to vscode-json-languageservice/lib/umd/...
 * sub-paths. The UMD build uses a factory pattern with dynamic require() that
 * esbuild cannot statically analyse. The ESM build of the same files bundles
 * cleanly, so we redirect umd → esm at resolve time.
 */
const redirectUmdToEsm = {
  name: 'redirect-umd-to-esm',
  setup(build) {
    build.onResolve({ filter: /vscode-json-languageservice\/lib\/umd\// }, (args) => {
      return build.resolve(args.path.replace('/lib/umd/', '/lib/esm/'), {
        kind: args.kind,
        resolveDir: args.resolveDir,
      });
    });
  },
};

/**
 * yaml-language-server pulls in prettier (~600 KB) for its formatting service,
 * but this CLI only validates (format: false). Stub out the prettier imports
 * with empty modules to avoid bundling unused code.
 */
const stubPrettier = {
  name: 'stub-prettier',
  setup(build) {
    build.onResolve({ filter: /^prettier/ }, (args) => ({
      path: args.path,
      namespace: 'stub-prettier',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub-prettier' }, () => ({
      contents: 'module.exports = {};',
      loader: 'js',
    }));
  },
};

const isWatch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  mainFields: ['module', 'main'],
  outfile: 'dist/yaml-schema-lint.js',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
  minify: true,
  legalComments: 'linked',
  logLevel: 'info',
  plugins: [redirectUmdToEsm, stubPrettier],
});

if (isWatch) {
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
