const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadManifest,
  validateManifest,
  allCommands,
  expandCommands,
  parseSurveyIds,
  isPlausibleToken,
} = require('../src/core/manifest');

const manifest = loadManifest();
const step = (id) => manifest.steps.find((s) => s.id === id);

test('the Windows manifest loads and passes validation', () => {
  assert.equal(manifest.platform, 'windows');
  assert.deepEqual(
    manifest.steps.map((s) => s.id),
    ['tools', 'get-code', 'settings', 'azurite', 'function', 'check', 'sync', 'wizard']
  );
});

test('allCommands lists tool installs first, then step commands, in order', () => {
  const commands = allCommands(manifest);
  assert.match(commands[0], /^winget install --id OpenJS\.NodeJS\.LTS/);
  assert.equal(commands[3], 'git clone https://github.com/Harsha99-99/surveymonkey-powerbi-connector.git');
  assert.equal(commands[commands.length - 1], 'curl.exe "http://localhost:7071/api/surveys/<survey-id>/data/answers"');
});

test('per-survey commands repeat once per survey with the ID filled in', () => {
  const commands = expandCommands(step('sync'), ['111', '222']);
  assert.equal(commands.length, 6);
  assert.equal(commands[0], 'curl.exe -X POST http://localhost:7071/api/sync/111');
  assert.equal(commands[3], 'curl.exe -X POST http://localhost:7071/api/sync/222');
  assert.ok(commands.every((c) => !c.includes('<survey-id>')));
});

test('a survey ID that is not all digits never reaches a command', () => {
  assert.throws(() => expandCommands(step('sync'), ['123; Remove-Item C:\\']), /Not a survey ID/);
});

test('steps without a placeholder are returned unchanged', () => {
  assert.deepEqual(expandCommands(step('get-code'), ['111']), step('get-code').commands);
});

test('survey ID text is split on commas and spaces, and junk is reported', () => {
  assert.deepEqual(parseSurveyIds('111, 222 333'), { ids: ['111', '222', '333'], invalid: [] });
  assert.deepEqual(parseSurveyIds('111,abc'), { ids: ['111'], invalid: ['abc'] });
  assert.deepEqual(parseSurveyIds(''), { ids: [], invalid: [] });
});

test('a token must be one line of printable characters', () => {
  assert.equal(isPlausibleToken('abcDEF123-._~xyz'), true);
  assert.equal(isPlausibleToken('short'), false);
  assert.equal(isPlausibleToken('has space in it ok'), false);
  assert.equal(isPlausibleToken('line1\nline2xxxxxx'), false);
  assert.equal(isPlausibleToken(undefined), false);
});

test('validation rejects a step with two kinds of action', () => {
  assert.throws(
    () => validateManifest({ steps: [{ id: 'x', title: 'x', summary: 'x', commands: ['a'], open: 'b' }] }),
    /exactly one of tools, commands or open/
  );
});

test('validation rejects duplicate step ids', () => {
  const s = { id: 'x', title: 'x', summary: 'x', commands: ['a'] };
  assert.throws(() => validateManifest({ steps: [s, { ...s }] }), /Duplicate step id/);
});

test('validation rejects a setting with both a value and an input', () => {
  const bad = { id: 'x', title: 'x', summary: 'x', commands: ['a'], settings: [{ key: 'K', value: '', input: 'token' }] };
  assert.throws(() => validateManifest({ steps: [bad] }), /exactly one of value or input/);
});
