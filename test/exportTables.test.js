const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { TABLES, parseArgs, surveyFolder, tableUrl, exportSurvey } = require('../scripts/exportTables');
const { TABLE_NAMES } = require('../src/lib/schema');

// --- argument handling ------------------------------------------------------

test('exports every table the connector serves', () => {
  assert.deepEqual(TABLES, TABLE_NAMES);
});

test('parses surveys, folder and snapshot', () => {
  const opts = parseArgs(['--survey', '111,222', '--out', 'exports', '--snapshot', '2026-10-22']);
  assert.deepEqual(opts.surveys, ['111', '222']);
  assert.equal(opts.out, path.resolve('exports'));
  assert.equal(opts.snapshot, '2026-10-22');
  assert.equal(opts.base, 'http://localhost:7071');
});

test('rejects a missing survey, a bad survey ID, a missing folder and a bad date', () => {
  assert.throws(() => parseArgs(['--out', 'x']), /--survey is required/);
  assert.throws(() => parseArgs(['--survey', '12a', '--out', 'x']), /Not a survey ID/);
  assert.throws(() => parseArgs(['--survey', '111']), /--out is required/);
  assert.throws(() => parseArgs(['--survey', '111', '--out', 'x', '--snapshot', 'yesterday']), /--snapshot/);
  assert.throws(() => parseArgs(['--survey', '111', '--out']), /needs a value/);
  assert.throws(() => parseArgs(['--survey', '111', '--out', 'x', '--nope']), /Unknown option/);
});

test('folders are named by survey ID, with snapshots in their own subfolder', () => {
  assert.equal(surveyFolder('/data', '111', null), path.join('/data', 'survey-111'));
  assert.equal(surveyFolder('/data', '111', '2026-10-22'), path.join('/data', 'survey-111', 'snapshot-2026-10-22'));
});

test('table URLs match the ones Power BI uses', () => {
  assert.equal(tableUrl('http://localhost:7071', '111', 'answers', null), 'http://localhost:7071/api/surveys/111/data/answers');
  assert.equal(
    tableUrl('http://localhost:7071', '111', 'answers', '2026-10-22'),
    'http://localhost:7071/api/surveys/111/data/answers?snapshot=2026-10-22'
  );
});

// --- against a fake connector ----------------------------------------------

const BOM = '﻿';
const csvFor = (table) =>
  table === 'surveys'
    ? `${BOM}survey_id,title\r\n111,"Staff survey, 2026"\r\n`
    : `${BOM}survey_id,value\r\n111,${table}\r\n`;

async function fakeConnector(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-'));
}

test('writes every table byte-for-byte, plus about.txt with the title', async () => {
  const { server, base } = await fakeConnector((req, res) => {
    const match = /^\/api\/surveys\/111\/(data\/(\w+)|status)/.exec(req.url);
    if (match && match[2]) {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
      return res.end(csvFor(match[2]));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ synced: true, last_sync_at: '2026-10-22T16:43:03.479Z' }));
  });

  const out = tempDir();
  try {
    const folder = await exportSurvey({ out, base, snapshot: null }, '111', { log: () => {} });

    for (const table of TABLES) {
      assert.equal(fs.readFileSync(path.join(folder, `${table}.csv`), 'utf8'), csvFor(table), `${table}.csv`);
    }
    const about = fs.readFileSync(path.join(folder, 'about.txt'), 'utf8');
    assert.match(about, /Survey: Staff survey, 2026/);
    assert.match(about, /Last synced: 2026-10-22T16:43:03.479Z/);
    assert.deepEqual(fs.readdirSync(folder).filter((f) => f.endsWith('.tmp')), [], 'no temp files left');
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('an unsynced survey fails with a plain message and leaves existing files alone', async () => {
  const { server, base } = await fakeConnector((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_synced', message: 'not synced' }));
  });

  const out = tempDir();
  const folder = surveyFolder(out, '111', null);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'surveys.csv'), 'previous export');

  try {
    await assert.rejects(exportSurvey({ out, base, snapshot: null }, '111', { log: () => {} }), /has not synced yet/);
    assert.equal(fs.readFileSync(path.join(folder, 'surveys.csv'), 'utf8'), 'previous export');
    assert.deepEqual(fs.readdirSync(folder).filter((f) => f.endsWith('.tmp')), []);
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('an unreachable connector says so', async () => {
  const out = tempDir();
  try {
    await assert.rejects(
      exportSurvey({ out, base: 'http://127.0.0.1:9', snapshot: null }, '111', { log: () => {} }),
      /Could not reach the connector/
    );
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
