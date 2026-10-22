const test = require('node:test');
const assert = require('node:assert/strict');

const { loadManifest, validateManifest, actionCommands } = require('../src/core/manifest');
const { isInOneDrive } = require('../src/core/onedrive');

const manifest = loadManifest();

// --- actions -------------------------------------------------------------------

test('the update action pulls the latest connector and reinstalls exactly', () => {
  assert.deepEqual(actionCommands(manifest.actions.update), [
    'git restore package-lock.json',
    'git pull --ff-only',
    'npm ci',
  ]);
});

test('setup installs with npm ci, so the lockfile is never rewritten and later updates can pull', () => {
  const getCode = manifest.steps.find((s) => s.id === 'get-code');
  assert.ok(getCode.commands.includes('npm ci'));
  assert.ok(!getCode.commands.includes('npm install'));
});

test('a single-command action gets its placeholders filled in', () => {
  assert.deepEqual(actionCommands(manifest.actions.export, { surveyIds: ['111'], folder: 'C:\\Data' }), [
    'npm run export -- --survey 111 --out "C:\\Data"',
  ]);
});

test('an action must have one command or a list of commands, not both or neither', () => {
  const step = { id: 's', title: 't', summary: 'u', commands: ['x'] };
  const action = (extra) => ({ steps: [step], actions: { a: { title: 't', summary: 'u', ...extra } } });
  assert.throws(() => validateManifest(action({})), /either one command or a list/);
  assert.throws(() => validateManifest(action({ command: 'x', commands: ['y'] })), /either one command or a list/);
  assert.throws(() => validateManifest(action({ commands: [] })), /either one command or a list/);
  assert.doesNotThrow(() => validateManifest(action({ commands: ['x', 'y'] })));
});

// --- OneDrive ------------------------------------------------------------------

const env = {
  OneDriveCommercial: 'C:\\Users\\me\\OneDrive - Contoso',
  OneDrive: 'C:\\Users\\me\\OneDrive - Contoso',
};

test('folders inside OneDrive are recognised, whatever the letter case', () => {
  assert.equal(isInOneDrive('C:\\Users\\me\\OneDrive - Contoso\\Documents', env), true);
  assert.equal(isInOneDrive('c:\\users\\ME\\onedrive - contoso\\Documents\\SurveyMonkey data', env), true);
  assert.equal(isInOneDrive('C:\\Users\\me\\OneDrive - Contoso', env), true);
});

test('folders outside OneDrive, or merely named like it, are not', () => {
  assert.equal(isInOneDrive('C:\\Users\\me\\SurveyMonkey Power BI', env), false);
  assert.equal(isInOneDrive('C:\\Users\\me\\OneDrive - Contoso Backup\\x', env), false);
  assert.equal(isInOneDrive('C:\\Users\\me\\Documents', {}), false);
  assert.equal(isInOneDrive('', env), false);
});
