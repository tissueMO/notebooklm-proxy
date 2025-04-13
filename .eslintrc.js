module.exports = {
  env: {
    es6: true,
    node: true,
  },
  extends: 'eslint:recommended',
  parser: '@babel/eslint-parser',
  parserOptions: {
    sourceType: 'module',
    requireConfigFile: false,
  },
  rules: {
    indent: ['error', 2, { SwitchCase: 1 }],
    'linebreak-style': ['error', 'unix'],
    quotes: ['error', 'single'],
    semi: ['error', 'always'],
  },
};
