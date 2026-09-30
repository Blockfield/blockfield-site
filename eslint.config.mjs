import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import astro from 'eslint-plugin-astro'
import globals from 'globals'

export default [
  { ignores: ['dist/**', '.astro/**', 'node_modules/**', '.cache/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // Existing external JSON and SQL rows keep their dynamic contracts.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true }],
      '@typescript-eslint/no-this-alias': ['error', { allowedNames: ['image'] }],
    },
  },
]
