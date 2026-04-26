const assert = require('node:assert/strict');
const test = require('node:test');

const { findMatchingRule, isValidRule, matchesPattern } = require('../rules.js');

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
