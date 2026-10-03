export default {
  rules: {
    'at-rule-no-unknown': true,
    'block-no-empty': true,
    'color-no-invalid-hex': true,
    'declaration-block-no-duplicate-properties': [
      true,
      { ignore: ['consecutive-duplicates-with-different-values'] },
    ],
    'function-no-unknown': true,
    'property-no-unknown': true,
    'unit-no-unknown': true,
  },
  overrides: [{ files: ['**/*.{astro,html}'], customSyntax: 'postcss-html' }],
}
