const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runStep } = require('../src/core/steps');
const { loadManifest } = require('../src/core/manifest');

const manifest = loadManifest();
const step = (id) => manifest.steps.find((s) => s.id === id);

const PARENT = path.resolve('/home/user/Documents');
const REPO = path.join(PARENT, 'surveymonkey-powerbi-connector');

/** A fake machine: records what ran, answers from scripted results. */
function fakeCtx(overrides = {}) {
  const ran = [];
  const ctx = {
    parentDir: PARENT,
    repoDir: REPO,
    inputs: { token: '', surveyIds: [] },
    files: new Set(),
    written: null,
    logs: [],
    ran,
    run: async (command, cwd) => {
      ran.push({ command, cwd });
      return ctx.results[command] || { code: 0, output: '' };
    },
    results: {},
    refreshPath: async () => {},
    startBackground: () => ({ exited: new Promise(() => {}) }),
    isPortOpen: async () => false,
    fetchJson: async () => ({ status: 0, body: null }),
    exists: (file) => ctx.files.has(file),
    readSettings: () => ({ Values: {} }),
    writeSettings: (file, value) => {
      ctx.written = { file, value };
    },
    openUrl: async (url) => {
      ctx.opened = url;
    },
    log: (text) => ctx.logs.push(text),
    sleep: async () => {},
    ...overrides,
  };
  return ctx;
}

// --- tools ---------------------------------------------------------------

test('tools that are already installed are not reinstalled', async () => {
  const ctx = fakeCtx();
  ctx.results = {
    'node --version': { code: 0, output: 'v22.0.0' },
    'func --version': { code: 0, output: '4.16.0' },
    'git --version': { code: 0, output: 'git version 2.55.0' },
  };

  const result = await runStep(step('tools'), ctx);
  assert.equal(result.ok, true);
  assert.ok(!ctx.ran.some((r) => r.command.startsWith('winget')));
});

test('a missing tool is installed and checked again', async () => {
  const ctx = fakeCtx();
  let installed = false;
  ctx.run = async (command) => {
    ctx.ran.push({ command });
    if (command.startsWith('winget install --id Git.Git')) installed = true;
    if (command === 'git --version') return installed ? { code: 0, output: 'git version 2.55.0' } : { code: 1, output: '' };
    if (command === 'node --version') return { code: 0, output: 'v22.0.0' };
    if (command === 'func --version') return { code: 0, output: '4.16.0' };
    return { code: 0, output: '' };
  };

  const result = await runStep(step('tools'), ctx);
  assert.equal(result.ok, true);
  assert.equal(ctx.ran.filter((r) => r.command === 'git --version').length, 2);
});

test('a tool that still is not there after installing fails the step', async () => {
  const ctx = fakeCtx();
  ctx.run = async (command) => (command === 'node --version' ? { code: 1, output: '' } : { code: 0, output: '4.0' });

  const result = await runStep(step('tools'), ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /Node\.js could not be installed/);
});

// --- commands ------------------------------------------------------------

test('get-code clones into the chosen folder and installs inside the repo', async () => {
  const ctx = fakeCtx();
  const result = await runStep(step('get-code'), ctx);

  assert.equal(result.ok, true);
  assert.deepEqual(ctx.ran, [
    { command: 'git clone https://github.com/Harsha99-99/surveymonkey-powerbi-connector.git', cwd: PARENT },
    { command: 'npm ci', cwd: REPO },
  ]);
});

test('get-code skips the clone when the code is already there', async () => {
  const ctx = fakeCtx();
  ctx.files.add(path.join(REPO, 'package.json'));

  await runStep(step('get-code'), ctx);
  assert.deepEqual(ctx.ran.map((r) => r.command), ['npm ci']);
});

test('a failing command stops the step and says which one', async () => {
  const ctx = fakeCtx();
  ctx.results['npm ci'] = { code: 1, output: 'npm ERR!' };

  const result = await runStep(step('get-code'), ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /npm ci/);
});

test('a step that needs the folder refuses to run without one', async () => {
  const result = await runStep(step('get-code'), fakeCtx({ parentDir: null }));
  assert.equal(result.ok, false);
  assert.match(result.message, /Choose a folder/);
});

// --- settings ------------------------------------------------------------

test('settings copies the example and writes the values into it', async () => {
  const ctx = fakeCtx({ inputs: { token: 'tok-123456789', surveyIds: ['111'] } });
  const result = await runStep(step('settings'), ctx);

  assert.equal(result.ok, true);
  assert.deepEqual(ctx.ran.map((r) => r.command), ['Copy-Item local.settings.json.example local.settings.json']);
  assert.equal(ctx.written.file, path.join(REPO, 'local.settings.json'));
  assert.equal(ctx.written.value.Values.SM_ACCESS_TOKEN_LOCAL_OVERRIDE, 'tok-123456789');
  assert.equal(ctx.written.value.Values.SYNC_SURVEY_IDS, '111');
  assert.ok(!ctx.logs.join('\n').includes('tok-123456789'), 'the token must not be logged');
});

test('settings keeps an existing file rather than copying over it', async () => {
  const ctx = fakeCtx({ inputs: { token: 'tok-123456789', surveyIds: ['111'] } });
  ctx.files.add(path.join(REPO, 'local.settings.json'));

  await runStep(step('settings'), ctx);
  assert.deepEqual(ctx.ran, []);
  assert.ok(ctx.written);
});

test('settings without a token is refused with a clear message', async () => {
  const result = await runStep(step('settings'), fakeCtx({ inputs: { token: '', surveyIds: ['111'] } }));
  assert.equal(result.ok, false);
  assert.match(result.message, /access token/);
});

// --- background ----------------------------------------------------------

test('a background step that is already running is not started twice', async () => {
  let started = false;
  const ctx = fakeCtx({
    isPortOpen: async () => true,
    startBackground: () => {
      started = true;
      return { exited: new Promise(() => {}) };
    },
  });

  const result = await runStep(step('azurite'), ctx);
  assert.equal(result.ok, true);
  assert.equal(started, false);
});

test('a background step waits until it is ready', async () => {
  let polls = 0;
  const ctx = fakeCtx({
    fetchJson: async () => {
      polls += 1;
      return { status: polls >= 3 ? 200 : 0, body: null };
    },
  });

  const result = await runStep(step('function'), ctx);
  assert.equal(result.ok, true);
  assert.ok(polls >= 3);
});

test('a background step that exits before it is ready fails', async () => {
  const ctx = fakeCtx({ startBackground: () => ({ exited: Promise.resolve(1) }) });
  const result = await runStep(step('azurite'), ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /stopped unexpectedly/);
});

// --- verification ----------------------------------------------------------

test('check fails with a token message when SurveyMonkey rejects the token', async () => {
  const ctx = fakeCtx({
    fetchJson: async () => ({ status: 200, body: { checks: { tokenStored: true, tokenValid: false, storageReachable: true } } }),
  });
  const result = await runStep(step('check'), ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /did not accept your token/);
});

test('check passes and names the account when everything is reachable', async () => {
  const ctx = fakeCtx({
    fetchJson: async () => ({
      status: 200,
      body: { checks: { tokenStored: true, tokenValid: true, storageReachable: true }, account: { username: 'someone' } },
    }),
  });
  const result = await runStep(step('check'), ctx);
  assert.equal(result.ok, true);
  assert.match(result.message, /someone/);
});

test('sync counts only a sync that finished during this step', async () => {
  const stale = fakeCtx({
    inputs: { token: '', surveyIds: ['111'] },
    fetchJson: async () => ({ status: 200, body: { synced: true, last_sync_at: '2020-01-01T00:00:00Z', response_count: 5 } }),
  });
  assert.equal((await runStep(step('sync'), stale)).ok, false);

  const fresh = fakeCtx({
    inputs: { token: '', surveyIds: ['111'] },
    fetchJson: async () => ({ status: 200, body: { synced: true, last_sync_at: new Date().toISOString(), response_count: 5 } }),
  });
  const result = await runStep(step('sync'), fresh);
  assert.equal(result.ok, true);
  assert.match(result.message, /Survey 111: 5 responses synced/);
});

test('the wizard step opens the connector page at the Power BI step', async () => {
  const ctx = fakeCtx();
  const result = await runStep(step('wizard'), ctx);
  assert.equal(result.ok, true);
  assert.equal(ctx.opened, 'http://localhost:7071/api/ui#power-bi');
});

test('the wizard step explains that the browser skips to Power BI', () => {
  assert.match(step('wizard').note, /straight at Connect Power BI/);
});
