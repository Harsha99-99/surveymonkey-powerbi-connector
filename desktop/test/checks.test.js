const test = require('node:test');
const assert = require('node:assert/strict');

const { parseMajor, evaluateTool } = require('../src/core/checks');

const node = { name: 'Node.js', minMajor: 20 };
const git = { name: 'Git' };

test('reads the major version from each tool\'s output', () => {
  assert.equal(parseMajor('v24.22.0'), 24);
  assert.equal(parseMajor('4.16.0'), 4);
  assert.equal(parseMajor('git version 2.55.0.windows.1'), 2);
  assert.equal(parseMajor('command not found'), null);
});

test('a tool that ran and is new enough passes', () => {
  assert.equal(evaluateTool(node, { code: 0, output: 'v22.1.0' }).ok, true);
});

test('a tool that is too old fails with the version it needs', () => {
  const verdict = evaluateTool(node, { code: 0, output: 'v18.20.0' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /Version 20 or later/);
});

test('a tool that did not run is reported as not installed', () => {
  const verdict = evaluateTool(git, { code: 1, output: "The term 'git' is not recognized" });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not installed/);
});

test('a tool with no minimum only has to run', () => {
  assert.equal(evaluateTool(git, { code: 0, output: 'git version 2.55.0' }).ok, true);
});
