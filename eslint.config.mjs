import { defineConfig, globalIgnores } from 'eslint/config';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslintPluginPrettier from 'eslint-plugin-prettier/recommended';
import jsdoc from 'eslint-plugin-jsdoc';
import jest from 'eslint-plugin-jest';

export default defineConfig([
  eslint.configs.recommended,
  eslintConfigPrettier,
  eslintPluginPrettier,
  {
    files: ['**/*.ts'],
    extends: [
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      jsdoc.configs['flat/recommended-typescript'],
      {
        languageOptions: {
          parserOptions: {
            project: ['tsconfig.json', 'tsconfig.test.json'],
          },
        },
      },
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [jsdoc.configs['flat/recommended']],
  },
  {
    files: ['src/**/*.test.ts'],
    extends: [jest.configs['flat/recommended']],
  },
  globalIgnores(['dist/', 'node_modules/', 'bin/']),
]);
