#!/usr/bin/env node
/**
 * scripts/runTests.js
 *
 * Cross-platform test runner behind `npm test` and `npm run test:integration`.
 * The npm scripts used to depend on POSIX shell behaviour: an inline
 * `VAR=value command` prefix, and the shell expanding `test/*.test.js`. Windows
 * cmd and PowerShell support neither, and Node 20 does not expand globs itself.
 * This runner expands the file list and sets the environment in-process, so the
 * same command works on every platform.
 *
 * Usage:
 *   node scripts/runTests.js                 offline unit tests
 *   node scripts/runTests.js --integration   also runs storage tests against Azurite
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const testDir = path.join(root, 'test');

const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join('test', name));

if (files.length === 0) {
  console.error(`No *.test.js files found in ${testDir}`);
  process.exit(1);
}

const env = { ...process.env };
if (process.argv.includes('--integration')) {
  // Forced rather than defaulted, so the integration suite always targets
  // Azurite and never a real storage account that happens to be in the env.
  env.STORAGE_CONNECTION_STRING = 'UseDevelopmentStorage=true';
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
