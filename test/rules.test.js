const assert = require('node:assert/strict');
const test = require('node:test');

const {
  findFixedTabPosition,
  findMatchingRule,
  formatFixedTabLines,
  isValidRule,
  matchesPattern,
  parseFixedTabLines
} = require('../rules.js');

test('matches exact URLs case-insensitively', () => {
  assert.equal(matchesPattern('https://Example.com/Path', 'https://example.com/path'), true);
});

test('matches root domains and www subdomains', () => {
  assert.equal(matchesPattern('https://example.com/dashboard', 'example.com'), true);
  assert.equal(matchesPattern('https://www.example.com/dashboard', 'example.com'), true);
  assert.equal(matchesPattern('https://app.example.com/dashboard', 'example.com'), false);
});

test('matches wildcard subdomain patterns', () => {
  assert.equal(matchesPattern('https://example.com', '*.example.com'), true);
  assert.equal(matchesPattern('https://app.example.com', '*.example.com'), true);
  assert.equal(matchesPattern('https://notexample.com', '*.example.com'), false);
});

test('matches simple glob URL patterns', () => {
  assert.equal(matchesPattern('https://example.com/projects/123', 'https://example.com/projects/*'), true);
  assert.equal(matchesPattern('https://example.com/settings', 'https://example.com/projects/*'), false);
});

test('finds the first valid matching rule', () => {
  const rules = [
    { id: 'invalid', name: '', patterns: ['example.com'] },
    { id: 'work', name: 'Work', patterns: ['*.example.com'], color: 'blue' },
    { id: 'later', name: 'Later', patterns: ['app.example.com'], color: 'red' }
  ];

  assert.equal(isValidRule(rules[0]), false);
  assert.equal(findMatchingRule(rules, 'https://app.example.com')?.id, 'work');
});

test('parses fixed tab position lines', () => {
  assert.deepEqual(parseFixedTabLines(`
0, https://example.com/app
1 https://example.com/dashboard
https://example.com/inferred
bad line
2 | https://example.com/reports
3, http://192.0.2.1:9000/*
  `), [
    { index: 0, url: 'https://example.com/app' },
    { index: 1, url: 'https://example.com/dashboard' },
    { index: 2, url: 'https://example.com/inferred' },
    { index: 2, url: 'https://example.com/reports' },
    { index: 3, url: 'http://192.0.2.1:9000/*' }
  ]);
});

test('formats fixed tab position lines', () => {
  assert.equal(formatFixedTabLines([
    { index: 0, url: 'https://example.com/app' },
    { index: 1, url: 'https://example.com/dashboard' }
  ]), '0, https://example.com/app\n1, https://example.com/dashboard');
});

test('finds fixed tab positions by exact normalized URL or wildcard pattern', () => {
  const rule = {
    fixedTabs: [
      { index: 0, url: 'https://example.com/app' },
      { index: 1, url: 'https://example.com/app?mode=full' },
      { index: 2, url: 'http://192.0.2.1:9000/*' }
    ]
  };

  assert.equal(findFixedTabPosition(rule, 'https://example.com/app'), 0);
  assert.equal(findFixedTabPosition(rule, 'https://example.com/app?mode=full'), 1);
  assert.equal(findFixedTabPosition(rule, 'http://192.0.2.1:9000/#/auth'), 2);
  assert.equal(findFixedTabPosition(rule, 'http://192.0.2.1:9000/projects/1'), 2);
  assert.equal(findFixedTabPosition(rule, 'https://example.com/app/other'), null);
});
