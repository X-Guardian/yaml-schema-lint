import * as esbuild from 'esbuild';
import esbuildPluginLicense from 'esbuild-plugin-license';
import process from 'node:process';
import console from 'node:console';

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
  sourcemap: 'external',
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
  plugins: [
    stubPrettier,
    esbuildPluginLicense({
      thirdParty: {
        includePrivate: false,
        output: {
          file: 'dist/THIRD-PARTY-LICENSES.txt',
          template(dependencies) {
            return dependencies
              .map(
                (dep) =>
                  `${dep.packageJson.name}@${dep.packageJson.version}\n` +
                  `License: ${dep.packageJson.license}\n` +
                  `Repository: ${dep.packageJson.repository?.url || 'N/A'}\n` +
                  `\n${dep.licenseText || 'No license text found.'}\n`,
              )
              .join('\n' + '-'.repeat(70) + '\n\n');
          },
        },
      },
    }),
  ],
});

if (isWatch) {
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
