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

module.exports = [
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
