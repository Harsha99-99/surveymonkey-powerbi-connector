const test = require('node:test');
const assert = require('node:assert/strict');

const { applySettings, describeSettings } = require('../src/core/settings');
const { loadManifest } = require('../src/core/manifest');

const entries = loadManifest().steps.find((s) => s.id === 'settings').settings;
const TOKEN_KEY = 'SM_ACCESS_TOKEN_LOCAL_OVERRIDE';

const example = {
  IsEncrypted: false,
  Values: {
    FUNCTIONS_WORKER_RUNTIME: 'node',
    SECRETS_BACKEND: 'keyvault',
    KEY_VAULT_URI: 'https://your-vault-name.vault.azure.net/',
    SYNC_SCHEDULE: '0 0 */6 * * *',
  },
};

test('applies the README values and keeps every other setting', () => {
  const next = applySettings(example, entries, { token: 'tok-123456789', surveyIds: ['111', '222'] });

  assert.equal(next.Values.SECRETS_BACKEND, 'local-override');
  assert.equal(next.Values.SM_ACCESS_TOKEN_SECRET_NAME, 'surveymonkey-access-token');
  assert.equal(next.Values[TOKEN_KEY], 'tok-123456789');
  assert.equal(next.Values.KEY_VAULT_URI, '');
  assert.equal(next.Values.STORAGE_ACCOUNT_URL, '');
  assert.equal(next.Values.STORAGE_CONNECTION_STRING, 'UseDevelopmentStorage=true');
  assert.equal(next.Values.SYNC_SURVEY_IDS, '111,222');
  assert.equal(next.Values.SYNC_SCHEDULE, '0 0 */6 * * *');
  assert.equal(next.Values.FUNCTIONS_WORKER_RUNTIME, 'node');
});

test('does not modify the object it was given', () => {
  applySettings(example, entries, { token: 'tok-123456789', surveyIds: ['111'] });
  assert.equal(example.Values.SECRETS_BACKEND, 'keyvault');
});

test('a blank token keeps the token already in the file', () => {
  const saved = { Values: { [TOKEN_KEY]: 'already-saved-token' } };
  const next = applySettings(saved, entries, { token: '', surveyIds: ['111'] });
  assert.equal(next.Values[TOKEN_KEY], 'already-saved-token');
});

test('a blank token with none saved is refused', () => {
  assert.throws(() => applySettings(example, entries, { surveyIds: ['111'] }), /access token/);
});

test('at least one survey is required', () => {
  assert.throws(() => applySettings(example, entries, { token: 'tok-123456789', surveyIds: [] }), /at least one survey/);
});

test('describeSettings reports whether a token exists but never the token', () => {
  const description = describeSettings({ Values: { [TOKEN_KEY]: 'secret-value', SYNC_SURVEY_IDS: '111, 222' } }, TOKEN_KEY);
  assert.deepEqual(description, { hasToken: true, surveyIds: ['111', '222'] });
  assert.ok(!JSON.stringify(description).includes('secret-value'));
});

test('describeSettings copes with no file', () => {
  assert.deepEqual(describeSettings(null, TOKEN_KEY), { hasToken: false, surveyIds: [] });
});
