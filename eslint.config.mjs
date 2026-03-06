import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslintPluginPrettier from 'eslint-plugin-prettier/recommended';
import jsdoc from 'eslint-plugin-jsdoc';
import jest from 'eslint-plugin-jest';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  jsdoc.configs['flat/recommended-typescript'],
  eslintConfigPrettier,
  eslintPluginPrettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['src/*.test.ts', 'eslint.config.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/**/*.test.ts'],
    ...jest.configs['flat/recommended'],
  },
  {
    ignores: ['dist/', 'node_modules/', 'jest.config.cjs', 'bin/'],
  },
);
