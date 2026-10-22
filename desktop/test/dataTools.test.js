const test = require('node:test');
const assert = require('node:assert/strict');

const { loadManifest, expandAction, checkFolder } = require('../src/core/manifest');
const { NAMES, FULL_MODEL, COLUMNS, TYPES, DATE_TYPES, RELATIONSHIPS } = require('../src/core/tables');
const { tableUrl, buildQuery, columnTypes } = require('../src/core/powerquery');
const { createPreviewReader } = require('../src/core/csvpreview');
const { dailyTimes, suggestRefreshTimes, formatTime } = require('../src/core/schedule');
const { surveysNeedingExport } = require('../src/core/exportwatch');

const exportAction = loadManifest().actions.export;

// --- export action ------------------------------------------------------------

test('the export command fills in surveys and a quoted folder', () => {
  assert.equal(
    expandAction(exportAction, { surveyIds: ['111', '222'], folder: 'C:\\Users\\me\\Documents\\SurveyMonkey data' }),
    'npm run export -- --survey 111,222 --out "C:\\Users\\me\\Documents\\SurveyMonkey data"'
  );
});

test('a trailing backslash is removed so it cannot escape the closing quote', () => {
  assert.equal(checkFolder('C:\\Data\\Exports\\'), 'C:\\Data\\Exports');
});

test('folders that could break out of the quotes are refused', () => {
  for (const folder of ['C:\\a"b', 'C:\\$env:TEMP', 'C:\\a`b', 'C:\\100%', 'C:\\wow!', 'C:\\a\nb']) {
    assert.throws(() => checkFolder(folder), /character the export cannot use/, folder);
  }
});

test('a relative path, a whole drive and an overlong path are refused', () => {
  assert.throws(() => checkFolder('exports'), /full folder path/);
  assert.throws(() => checkFolder('C:\\'), /not a whole drive/);
  assert.throws(() => checkFolder('C:\\' + 'x'.repeat(200)), /too long/);
});

test('the export needs at least one valid survey', () => {
  assert.throws(() => expandAction(exportAction, { surveyIds: [], folder: 'C:\\Data' }), /at least one survey/);
  assert.throws(() => expandAction(exportAction, { surveyIds: ['1; rm'], folder: 'C:\\Data' }), /Not a survey ID/);
});

// --- tables ---------------------------------------------------------------------

test('every typed column is a real column of its table', () => {
  for (const table of NAMES) {
    for (const column of Object.keys({ ...TYPES[table], ...DATE_TYPES[table] })) {
      assert.ok(COLUMNS[table].includes(column), `${table}.${column}`);
    }
  }
});

test('the full model is five tables and its relationships use real columns', () => {
  assert.deepEqual(FULL_MODEL, ['surveys', 'questions', 'choices', 'responses', 'answers']);
  for (const { from, to } of RELATIONSHIPS) {
    for (const ref of [from, to]) {
      const [, table, column] = /^(\w+)\[(\w+)\]$/.exec(ref);
      assert.ok(COLUMNS[table].includes(column), ref);
    }
  }
});

// --- Power Query ------------------------------------------------------------------

test('table URLs carry format and snapshot only when asked', () => {
  assert.equal(tableUrl({ surveyId: '111', table: 'answers' }), 'http://localhost:7071/api/surveys/111/data/answers');
  assert.equal(
    tableUrl({ surveyId: '111', table: 'answers', format: 'json', snapshot: '2026-10-22' }),
    'http://localhost:7071/api/surveys/111/data/answers?format=json&snapshot=2026-10-22'
  );
});

test('the CSV query keeps the base URL constant and puts the rest in RelativePath', () => {
  const m = buildQuery({ surveyId: '111', table: 'answers' });
  assert.match(m, /Web\.Contents\("http:\/\/localhost:7071", \[RelativePath = "api\/surveys\/111\/data\/answers"\]\)/);
  assert.match(m, /Csv\.Document\(Response, \[Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle\.Csv\]\)/);
  assert.ok(!/& *"/.test(m), 'no URL built by joining strings');
});

test('the query sets number, true/false and date types with a fixed culture', () => {
  const m = buildQuery({ surveyId: '111', table: 'answers' });
  assert.match(m, /\{"value_numeric", type number\}/);
  assert.match(m, /\{"is_skipped", type logical\}/);
  assert.match(m, /\{"snapshot_date", type date\}/);
  assert.match(m, /, "en-US"\)/);
});

test('the JSON query asks for JSON, keeps every column, and passes the snapshot as a query value', () => {
  const m = buildQuery({ surveyId: '111', table: 'responses', format: 'json', snapshot: '2026-10-22' });
  assert.match(m, /Query = \[format = "json", snapshot = "2026-10-22"\]/);
  assert.match(m, /Table\.FromRecords\(Parsed\[data\], \{"survey_id", "response_id"/);
  assert.match(m, /\{"date_created", type datetimezone\}/);
});

test('column types follow the table\'s column order', () => {
  assert.deepEqual(
    columnTypes('surveys').map(([c]) => c),
    ['question_count', 'page_count', 'response_count', 'date_created', 'date_modified', 'snapshot_date']
  );
});

test('anything that is not a known value is refused before it reaches a query', () => {
  assert.throws(() => buildQuery({ surveyId: '11"1', table: 'answers' }), /Not a survey ID/);
  assert.throws(() => buildQuery({ surveyId: '111', table: 'secrets' }), /Not a table/);
  assert.throws(() => buildQuery({ surveyId: '111', table: 'answers', format: 'xml' }), /csv or json/);
  assert.throws(() => buildQuery({ surveyId: '111', table: 'answers', snapshot: 'today"' }), /snapshot/);
  assert.throws(() => buildQuery({ surveyId: '111', table: 'answers', baseUrl: 'http://x" & y' }), /connector address/);
});

// --- CSV preview -------------------------------------------------------------------

function previewOf(text, maxRows, chunkSize = text.length) {
  const reader = createPreviewReader(maxRows);
  for (let i = 0; i < text.length; i += chunkSize) {
    if (reader.push(text.slice(i, i + chunkSize))) break;
  }
  return reader.finish();
}

const SAMPLE =
  '\uFEFFid,text,n\r\n' +
  '1,"Faster exports, please. Also: ""dark mode"", and\nnewlines.",4\r\n' +
  '2,plain,\r\n' +
  '3,"",5\r\n';

test('reads header and rows, with quotes, commas and line breaks inside fields', () => {
  const preview = previewOf(SAMPLE, 10);
  assert.deepEqual(preview.columns, ['id', 'text', 'n']);
  assert.deepEqual(preview.rows, [
    ['1', 'Faster exports, please. Also: "dark mode", and\nnewlines.', '4'],
    ['2', 'plain', ''],
    ['3', '', '5'],
  ]);
  assert.equal(preview.truncated, false);
});

test('gives the same result however the download is split into chunks', () => {
  const whole = previewOf(SAMPLE, 10);
  for (const size of [1, 2, 3, 5, 7]) {
    assert.deepEqual(previewOf(SAMPLE, 10, size), whole, `chunk size ${size}`);
  }
});

test('stops after the requested rows and reports there are more', () => {
  const preview = previewOf(SAMPLE, 2);
  assert.equal(preview.rows.length, 2);
  assert.equal(preview.truncated, true);
});

test('a file without a final line break still yields its last row', () => {
  assert.deepEqual(previewOf('a,b\r\n1,2', 5).rows, [['1', '2']]);
});

// --- schedule -------------------------------------------------------------------

test('the default every-6-hours schedule becomes four daily times', () => {
  assert.deepEqual(dailyTimes('0 0 */6 * * *').map(formatTime), ['12:00 AM', '6:00 AM', '12:00 PM', '6:00 PM']);
});

test('hour lists and ranges are understood', () => {
  assert.deepEqual(dailyTimes('0 30 9,17 * * *').map(formatTime), ['9:30 AM', '5:30 PM']);
  assert.deepEqual(dailyTimes('0 0 8-10 * * *').map(formatTime), ['8:00 AM', '9:00 AM', '10:00 AM']);
});

test('schedules that are not simple daily times return null', () => {
  assert.equal(dailyTimes('0 */5 * * * *'), null);
  assert.equal(dailyTimes('0 0 9 * * 1-5'), null);
  assert.equal(dailyTimes('0 0 9 * *'), null);
  assert.equal(dailyTimes(''), null);
});

test('refresh suggestions come 30 minutes after each sync and stay within 8 a day', () => {
  assert.deepEqual(suggestRefreshTimes(dailyTimes('0 0 */6 * * *')).map(formatTime), [
    '12:30 AM',
    '6:30 AM',
    '12:30 PM',
    '6:30 PM',
  ]);
  assert.equal(suggestRefreshTimes(dailyTimes('0 0 * * * *')).length, 8);
  assert.deepEqual(suggestRefreshTimes([{ hour: 23, minute: 45 }]).map(formatTime), ['12:15 AM']);
});

// --- export watch ------------------------------------------------------------------

test('only surveys that synced since their last export are exported again', () => {
  const statuses = {
    111: { synced: true, last_sync_at: '2026-10-22T16:00:00Z' },
    222: { synced: true, last_sync_at: '2026-10-22T17:00:00Z' },
    333: { synced: false },
  };
  assert.deepEqual(surveysNeedingExport(statuses, { 111: '2026-10-22T16:00:00Z' }), ['222']);
  assert.deepEqual(surveysNeedingExport(statuses, {}), ['111', '222']);
});
