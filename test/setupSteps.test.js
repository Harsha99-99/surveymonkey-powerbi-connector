/**
 * Keeps the README's Windows setup steps and the desktop setup app identical.
 *
 * The app runs the commands in desktop/steps/windows.json. These tests fail if
 * README.md's "Windows (PowerShell)" section lists different commands, a
 * different settings table, or a different wizard URL, so the two paths can
 * only change together.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadManifest, allCommands } = require('../desktop/src/core/manifest');

const manifest = loadManifest();
const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n');

function windowsSection() {
  const start = readme.indexOf('\n### Windows (PowerShell)\n');
  assert.ok(start !== -1, 'README needs a "### Windows (PowerShell)" section');
  const end = readme.indexOf('\n### ', start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
}

function powershellCommands(section) {
  const commands = [];
  const fence = /```powershell\n([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(section)) !== null) {
    for (const line of match[1].split('\n')) {
      if (line.trim()) commands.push(line.trim());
    }
  }
  return commands;
}

function settingsRows(section) {
  const rows = [];
  for (const line of section.split('\n')) {
    const match = /^\|\s*`([A-Z_]+)`\s*\|\s*(.+?)\s*\|$/.exec(line.trim());
    if (match) rows.push({ key: match[1], value: match[2] });
  }
  return rows;
}

test('README Windows commands match the setup app, in order', () => {
  assert.deepEqual(powershellCommands(windowsSection()), allCommands(manifest));
});

test('README settings table matches the values the setup app writes', () => {
  const entries = manifest.steps.find((s) => s.id === 'settings').settings;
  const rows = settingsRows(windowsSection());

  assert.deepEqual(
    rows.map((r) => r.key),
    entries.map((e) => e.key),
    'same settings, in the same order'
  );

  for (const entry of entries) {
    if (entry.value === undefined) continue;
    const row = rows.find((r) => r.key === entry.key);
    if (entry.value === '') {
      assert.match(row.value, /^empty\b/, `${entry.key} should be documented as empty`);
    } else {
      assert.ok(row.value.includes('`' + entry.value + '`'), `${entry.key} should be documented as ${entry.value}`);
    }
  }
});

test('README Windows section opens the same wizard URL as the setup app', () => {
  const wizard = manifest.steps.find((s) => s.open);
  assert.ok(windowsSection().includes('`' + wizard.open + '`'));
});

// --- data tools ----------------------------------------------------------------

const desktopTables = require('../desktop/src/core/tables');
const { TABLE_COLUMNS, TABLE_TYPES } = require('../src/lib/schema');

test('the setup app describes the same tables, columns and types as the connector', () => {
  assert.deepEqual(desktopTables.COLUMNS, TABLE_COLUMNS);
  assert.deepEqual(desktopTables.TYPES, TABLE_TYPES);
});

test('README documents every command the setup app runs from its other screens', () => {
  const blocks = [...readme.matchAll(/```powershell\n([\s\S]*?)```/g)].map((m) =>
    m[1].split('\n').map((line) => line.trim()).filter(Boolean)
  );
  for (const [id, action] of Object.entries(manifest.actions)) {
    const expected = action.commands || [action.command];
    assert.ok(
      blocks.some((lines) => JSON.stringify(lines) === JSON.stringify(expected)),
      `README needs a powershell block for the "${id}" action with exactly:\n${expected.join('\n')}`
    );
  }
});
