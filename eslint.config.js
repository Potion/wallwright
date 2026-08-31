const globals = {
  node: {
    require: 'readonly',
    module: 'writable',
    process: 'readonly',
    console: 'readonly',
    __dirname: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    URL: 'readonly',
    Set: 'readonly',
    Map: 'readonly',
    Buffer: 'readonly',
  },
  browser: {
    window: 'readonly',
    document: 'readonly',
    fetch: 'readonly',
    location: 'readonly',
    console: 'readonly',
    setInterval: 'readonly',
    setTimeout: 'readonly',
    URL: 'readonly',
  },
};

// eslint:recommended is the baseline, applied to the same file set as the rules
// below rather than globally, so it does not start linting dist/ or the mock
// pages. The rules after it are additions and tightenings, not replacements: where
// both define a rule, the later object wins, which is why `no-unused-vars` is
// restated with the `_` prefix exemption this repo uses.
const js = require('@eslint/js');

module.exports = [
  {
    ...js.configs.recommended,
    files: ['src/**/*.js', 'test/**/*.js', 'eslint.config.js'],
  },
  {
    files: ['src/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Renderer-side files run in the page, not in node.
    files: ['src/overlay.js', 'src/content-preload.js', 'src/preload.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  { ignores: ['node_modules/**', 'dist/**', 'out/**', 'src/dev/mock/**'] },
];
