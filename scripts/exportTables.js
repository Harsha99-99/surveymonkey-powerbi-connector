#!/usr/bin/env node
/**
 * scripts/exportTables.js
 *
 * Saves a survey's synced tables as CSV files in a folder, so they can be
 * opened in Excel or read with Power BI's Folder connector. It downloads them
 * from a running connector through the same URLs Power BI uses, so the files
 * hold exactly what Power BI would see.
 *
 * Usage:
 *   npm run export -- --survey <survey-id> --out "<folder>"
 *
 * Options:
 *   --survey    one or more survey IDs, comma-separated (required)
 *   --out       folder to write into, created if missing (required)
 *   --snapshot  YYYY-MM-DD: export that dated snapshot instead of the latest data
 *   --base      connector address (default http://localhost:7071)
 *
 * For a deployed connector, put the function key in the CONNECTOR_FUNCTION_KEY
 * environment variable rather than on the command line.
 *
 * Layout:
 *   <out>/survey-<id>/<table>.csv                 latest data
 *   <out>/survey-<id>/snapshot-<date>/<table>.csv with --snapshot
 *   <out>/survey-<id>/about.txt                   survey title, sync and export times
 *
 * Folders are named by survey ID, not title, so a renamed survey doesn't break
 * a Power BI report pointed at the folder. Each file is written under a
 * temporary name and then renamed into place, so nothing ever reads a
 * half-written file.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { fromCsv } = require('../src/lib/csv');

const TABLES = ['surveys', 'questions', 'choices', 'responses', 'answers', 'flat'];
const SURVEY_ID = /^\d{1,20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_BASE = 'http://localhost:7071';

function parseArgs(argv) {
  const opts = { surveys: [], out: null, snapshot: null, base: DEFAULT_BASE };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value.`);
      i += 1;
      return next;
    };

    if (arg === '--survey') {
      opts.surveys.push(...value().split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg === '--out') {
      opts.out = value();
    } else if (arg === '--snapshot') {
      opts.snapshot = value();
    } else if (arg === '--base') {
      opts.base = value().replace(/\/+$/, '');
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (opts.surveys.length === 0) {
    throw new Error('--survey is required, for example --survey 123456789');
  }
  const bad = opts.surveys.filter((s) => !SURVEY_ID.test(s));
  if (bad.length > 0) throw new Error(`Not a survey ID: ${bad.join(', ')}`);
  if (!opts.out) throw new Error('--out is required, for example --out "C:\\Users\\you\\Documents\\SurveyMonkey data"');
  if (opts.snapshot && !DATE.test(opts.snapshot)) throw new Error('--snapshot must look like 2026-10-22.');

  opts.out = path.resolve(opts.out);
  return opts;
}

function surveyFolder(out, surveyId, snapshot) {
  const folder = path.join(out, `survey-${surveyId}`);
  return snapshot ? path.join(folder, `snapshot-${snapshot}`) : folder;
}

function tableUrl(base, surveyId, table, snapshot) {
  const url = new URL(`${base}/api/surveys/${surveyId}/data/${table}`);
  if (snapshot) url.searchParams.set('snapshot', snapshot);
  return url.toString();
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Downloads one table to `file`, replacing it only once the download is complete. */
async function downloadTable(url, file, { fetchImpl = fetch, headers = {} } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch {
    throw new Error(`Could not reach the connector at ${new URL(url).origin}. Is it running?`);
  }

  if (!response.ok) {
    const body = await readJson(response);
    if (body && body.error === 'not_synced') throw new Error('This survey has not synced yet. Sync it first.');
    throw new Error((body && body.message) || `The connector returned ${response.status}.`);
  }

  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmp));
    replaceFile(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return fs.statSync(file).size;
}

function replaceFile(tmp, file) {
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) {
      throw new Error(`${path.basename(file)} is open in another program, probably Excel. Close it and export again.`);
    }
    throw err;
  }
}

function surveyTitle(surveysCsvFile) {
  const text = fs.readFileSync(surveysCsvFile, 'utf8').replace(/^\uFEFF/, '');
  const [row] = fromCsv(text);
  return (row && row.title) || null;
}

function aboutText({ surveyId, title, snapshot, lastSyncAt, source }) {
  return [
    `Survey: ${title || '(title not available)'}`,
    `Survey ID: ${surveyId}`,
    snapshot ? `Snapshot: ${snapshot}` : 'Data: latest sync',
    `Last synced: ${lastSyncAt || 'unknown'}`,
    `Exported: ${new Date().toISOString()}`,
    `Source: ${source}`,
    '',
    'These files are replaced on every export. Save copies elsewhere if you edit them.',
    '',
  ].join('\r\n');
}

function formatSize(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

async function exportSurvey(opts, surveyId, { fetchImpl = fetch, headers = {}, log = console.log } = {}) {
  const folder = surveyFolder(opts.out, surveyId, opts.snapshot);
  fs.mkdirSync(folder, { recursive: true });
  log(`Survey ${surveyId} -> ${folder}`);

  for (const table of TABLES) {
    const bytes = await downloadTable(
      tableUrl(opts.base, surveyId, table, opts.snapshot),
      path.join(folder, `${table}.csv`),
      { fetchImpl, headers }
    );
    log(`  ${table}.csv (${formatSize(bytes)})`);
  }

  let lastSyncAt = null;
  try {
    const response = await fetchImpl(`${opts.base}/api/surveys/${surveyId}/status`, { headers });
    const status = response.ok ? await readJson(response) : null;
    lastSyncAt = status && status.last_sync_at;
  } catch {
    lastSyncAt = null;
  }

  fs.writeFileSync(
    path.join(folder, 'about.txt'),
    aboutText({
      surveyId,
      title: surveyTitle(path.join(folder, 'surveys.csv')),
      snapshot: opts.snapshot,
      lastSyncAt,
      source: `${opts.base}/api/surveys/${surveyId}/data/`,
    })
  );
  return folder;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const key = process.env.CONNECTOR_FUNCTION_KEY;
  const headers = key ? { 'x-functions-key': key } : {};

  let failures = 0;
  for (const surveyId of opts.surveys) {
    try {
      await exportSurvey(opts, surveyId, { headers });
    } catch (err) {
      failures += 1;
      console.error(`  Survey ${surveyId} failed: ${err.message}`);
    }
  }

  console.log(failures === 0 ? 'Export finished.' : `Export finished with ${failures} failed survey(s).`);
  return failures === 0 ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    }
  );
}

module.exports = { TABLES, parseArgs, surveyFolder, tableUrl, downloadTable, exportSurvey, main };
