/**
 * Jest config for the end-to-end smoke tests.
 *
 * Kept separate from `jest.config.cjs` because these tests require a built `dist/` bundle, whereas the unit tests
 * import from `src/` and run without one.
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.smoke.json' }],
  },
  moduleFileExtensions: ['ts', 'js'],
  testMatch: ['<rootDir>/test/smoke/**/*.test.ts'],
  // The CLI spawns a language server per run, so allow more than the 5s default.
  testTimeout: 60000,
  verbose: true,
};
