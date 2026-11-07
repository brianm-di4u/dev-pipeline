import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.pipeline/**', '.claude/**', 'evals/**', 'test-results/**', 'playwright-report/**', 'dist/**'] },
  ...tseslint.configs.recommended,
);
