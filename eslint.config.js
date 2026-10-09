export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.ai-manager/**',
      '**/*.tsbuildinfo',
    ],
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
