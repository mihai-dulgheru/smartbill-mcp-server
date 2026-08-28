// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      // projectService type-checks every file ESLint sees, including test/, which
      // tsconfig.json deliberately excludes from the build. This is what closes the
      // "tests are never typechecked" gap without a second tsconfig.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // The MCP wire is stdout. A stray console.log corrupts the JSON-RPC stream,
      // so only stderr writes are allowed in shipped code.
      'no-console': ['error', { allow: ['error'] }],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The SmartBill API returns loosely typed JSON; narrowing happens explicitly
      // in errors.ts. Flag genuinely unsafe access, but allow the deliberate casts
      // at the API boundary to be written without ceremony.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-coercion': 'error',
      'prefer-const': 'error',
      'object-shorthand': 'error',

      // Off deliberately: this codebase models everything as `type`, because the
      // load-bearing shapes (ClientResult, ToolOutcome) are unions that `interface`
      // cannot express. A mixed convention would be worse than either.
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/array-type': 'off',
    },
  },

  {
    files: ['test/**/*.ts'],
    rules: {
      // Tests deliberately construct malformed payloads and stub `fetch` with casts
      // to exercise failure paths the real types forbid.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',

      // `node:test`'s test() returns a promise the runner owns and awaits itself.
      // Every top-level test() call would otherwise be a floating promise.
      '@typescript-eslint/no-floating-promises': 'off',
      // Stub clocks and fetch impls are async by signature to match the real ones,
      // without necessarily awaiting anything inside.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },

  // This config file is plain JS and lives outside the tsconfig, so type-aware rules
  // cannot run on it.
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },

  // Must stay last: switches off every rule Prettier owns.
  prettier,
);
