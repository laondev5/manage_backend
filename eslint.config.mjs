import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.expo/**',
      '**/coverage/**',
      '**/*.d.ts',
      '.data/**',
      '**/android/**',
      '**/ios/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, __DEV__: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      // express-serve-static-core augments its Request type through `declare global` +
      // `namespace`; there is no module-syntax equivalent.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      // Every screen loads its data from the API in an effect and stores the result
      // in state. That is the supported pattern without a query library or the React
      // Compiler (which is not enabled here), so this compiler-adoption rule would
      // only force rewrites of correct code.
      'react-hooks/set-state-in-effect': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      // Expo/Metro/Tailwind config files are CommonJS and load plugin presets with
      // require(); they are never bundled as ESM.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
