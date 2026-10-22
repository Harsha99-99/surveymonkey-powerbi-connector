/**
 * Electron main process for the Windows setup app.
 *
 * The window shows the steps from steps/windows.json and runs them on request,
 * plus three screens built on the running connector: Data (sync and CSV
 * files), Power BI (tables, previews and queries) and Scheduled refresh.
 *
 * The renderer can only ask for a step or an action by id. The commands
 * themselves always come from the manifest, and anything the user typed or
 * picked (token, survey IDs, folders, tables, dates) is validated here before
 * it reaches a file, a command or a query.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, nativeImage, Notification } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadManifest, parseSurveyIds, isPlausibleToken, actionCommands, checkFolder } = require('./core/manifest');
const { isInOneDrive } = require('./core/onedrive');
const { runStep, CONNECTOR } = require('./core/steps');
const { Runner, isPortOpen, fetchJson, sleep } = require('./core/runner');
const { readSettings, writeSettings, describeSettings } = require('./core/settings');
const { listSurveys } = require('./core/surveymonkey');
const { TABLES, NAMES, FULL_MODEL, RELATIONSHIPS } = require('./core/tables');
const { tableUrl, buildQuery } = require('./core/powerquery');
const { createPreviewReader } = require('./core/csvpreview');
const { surveysNeedingExport } = require('./core/exportwatch');
const { dailyTimes, suggestRefreshTimes, formatTime } = require('./core/schedule');

const SMOKE_TEST = process.argv.includes('--smoke-test');
const BACKGROUND = process.argv.includes('--background');
const TOKEN_KEY = 'SM_ACCESS_TOKEN_LOCAL_OVERRIDE';
const SURVEY_ID = /^\d{1,20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PREVIEW_ROWS = 25;
const WATCH_INTERVAL_MS = 60 * 1000;

// Links the app may open in the browser. Everything else is refused.
const OPEN_ALLOWED = [
  /^http:\/\/localhost:7071\//,
  /^https:\/\/developer\.surveymonkey\.com\//,
  /^https:\/\/github\.com\/Harsha99-99\/surveymonkey-powerbi-connector(\/|$)/,
  /^https:\/\/go\.microsoft\.com\/fwlink\/\?LinkId=820925(&|$)/,
  /^https:\/\/app\.powerbi\.com\//,
  /^https:\/\/learn\.microsoft\.com\//,
];

// Tests must not collide with, or change, the settings of a copy someone has open.
if (process.env.SMPBI_USER_DATA) app.setPath('userData', process.env.SMPBI_USER_DATA);
else if (SMOKE_TEST) app.setPath('userData', path.join(os.tmpdir(), 'smpbi-smoke'));

const manifest = loadManifest();
const secrets = new Set();
let win = null;
let tray = null;
let busy = false;
let quitting = false;
let toldAboutTray = false;
const titles = new Map(); // survey ID -> title, read from the synced surveys table

function redact(text) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join('••••••');
  return out;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const log = (text) => send('setup:output', redact(text));
const runner = new Runner({ onOutput: (line) => send('setup:output', line), redact });

// --- remembered settings (folders and options; never the token) -------------

const configFile = () => path.join(app.getPath('userData'), 'config.json');

// Electron keeps settings in a folder named after the app, and the app used to
// be called "SurveyMonkey Power BI Setup". Bring those settings along once.
const LEGACY_CONFIG = path.join('SurveyMonkey Power BI Setup', 'config.json');

function loadConfig() {
  const file = configFile();
  try {
    const legacy = path.join(app.getPath('appData'), LEGACY_CONFIG);
    const isolated = SMOKE_TEST || Boolean(process.env.SMPBI_USER_DATA);
    if (!isolated && !fs.existsSync(file) && fs.existsSync(legacy)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(legacy, file);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

let config = {};

function saveConfig() {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}

/**
 * Where the connector goes unless the user picks a folder. Not Documents: on
 * many work PCs Documents is in OneDrive, which would upload the connector's
 * code, its token and synced survey data. A connector already set up in
 * Documents by an earlier version stays where it is.
 */
function defaultParentDir() {
  const documents = app.getPath('documents');
  if (fs.existsSync(path.join(documents, manifest.folderName, 'package.json'))) return documents;
  return path.join(os.homedir(), 'SurveyMonkey Power BI');
}

const parentDir = () => config.parentDir || defaultParentDir();
const suggestedParentDir = () => path.join(os.homedir(), 'SurveyMonkey Power BI');
const repoDir = () => path.join(parentDir(), manifest.folderName);
const settingsFile = () => path.join(repoDir(), 'local.settings.json');
const storageFolder = () => path.join(repoDir(), '.azurite');
const exportFolder = () => config.exportFolder || path.join(app.getPath('documents'), 'SurveyMonkey data');

function currentSettings() {
  try {
    const settings = readSettings(settingsFile());
    const token = settings && settings.Values && settings.Values[TOKEN_KEY];
    if (token) secrets.add(token);
    return settings;
  } catch {
    return null;
  }
}

/** The connector copy's npm scripts, or null if it isn't downloaded. */
function connectorScripts() {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoDir(), 'package.json'), 'utf8')).scripts || {};
  } catch {
    return null;
  }
}

function currentState() {
  const settings = currentSettings();
  return {
    parentDir: parentDir(),
    repoDir: repoDir(),
    installInOneDrive: isInOneDrive(parentDir()),
    suggestedParentDir: suggestedParentDir(),
    repoExists: fs.existsSync(path.join(repoDir(), 'package.json')),
    settingsExists: Boolean(settings),
    ...describeSettings(settings, TOKEN_KEY),
    running: { azurite: runner.isRunning('azurite'), function: runner.isRunning('function') },
  };
}

// --- input validation ----------------------------------------------------------

function resolveInputs(raw = {}) {
  const token = typeof raw.token === 'string' ? raw.token.trim() : '';
  if (token && !isPlausibleToken(token)) {
    throw new Error('That does not look like a SurveyMonkey access token. Copy it again, without spaces.');
  }
  if (token) secrets.add(token);

  const { ids, invalid } = parseSurveyIds(Array.isArray(raw.surveyIds) ? raw.surveyIds.join(',') : raw.surveyIds);
  if (invalid.length > 0) throw new Error(`These are not survey IDs: ${invalid.join(', ')}`);

  const surveyIds = ids.length > 0 ? ids : describeSettings(currentSettings(), TOKEN_KEY).surveyIds;
  return { token, surveyIds };
}

function checkSurveyId(id) {
  if (!SURVEY_ID.test(String(id))) throw new Error(`Not a survey ID: ${id}`);
  return String(id);
}

function checkTableOptions(raw = {}) {
  const surveyId = checkSurveyId(raw.surveyId);
  if (!NAMES.includes(raw.table)) throw new Error(`Not a table: ${raw.table}`);
  const format = raw.format === 'json' ? 'json' : 'csv';
  const snapshot = raw.snapshot ? String(raw.snapshot) : null;
  if (snapshot && !DATE.test(snapshot)) throw new Error('A snapshot must look like 2026-10-22.');
  return { surveyId, table: raw.table, format, snapshot };
}

// --- running steps and actions ---------------------------------------------------

function stepCtx(inputs) {
  return {
    parentDir: parentDir(),
    repoDir: repoDir(),
    inputs,
    run: (command, cwd) => runner.run(command, cwd),
    refreshPath: async () => runner.refreshPath(),
    startBackground: (id, command, cwd) => runner.startBackground(id, command, cwd),
    isPortOpen,
    fetchJson,
    exists: (file) => fs.existsSync(file),
    readSettings,
    writeSettings,
    openUrl: (url) => shell.openExternal(url),
    log,
    sleep,
  };
}

/** Runs one thing at a time, so two commands never fight over the same files. */
async function exclusive(task) {
  if (busy) return { ok: false, message: 'Something else is still running. Wait for it to finish.' };
  busy = true;
  try {
    return await task();
  } catch (err) {
    return { ok: false, message: redact(err.message) };
  } finally {
    busy = false;
  }
}

async function runStepById(stepId, rawInputs) {
  const step = manifest.steps.find((s) => s.id === stepId);
  if (!step) return { ok: false, message: 'Unknown step.' };

  const inputs = resolveInputs(rawInputs);
  fs.mkdirSync(parentDir(), { recursive: true });
  const result = await runStep(step, stepCtx(inputs));
  if (result.ok && step.id === 'sync') await exportIfWanted(inputs.surveyIds);
  return { ...result, message: redact(result.message) };
}

/** Why the CSV export can't run with this copy of the connector, or null if it can. */
function exportBlocker() {
  const scripts = connectorScripts();
  if (!scripts) return 'The connector isn\'t downloaded yet. Run "Get the code and install dependencies" in Setup first.';
  if (!scripts.export) {
    return `Your copy of the connector, in ${repoDir()}, is older than this app and can't save CSV files. Choose "Update the connector" at the top of this screen.`;
  }
  return null;
}

/** The manifest's export command, for these surveys, into the chosen folder. */
async function runExport(surveyIds) {
  const blocker = exportBlocker();
  if (blocker) return { ok: false, message: blocker };

  const [command] = actionCommands(manifest.actions.export, { surveyIds, folder: exportFolder() });
  fs.mkdirSync(checkFolder(exportFolder()), { recursive: true });

  log('');
  log(`──── ${manifest.actions.export.title} ────`);
  log(`> ${command}`);
  const { code } = await runner.run(command, repoDir());
  if (code !== 0) {
    return { ok: false, message: 'The CSV files could not all be saved. The output below says why.' };
  }

  // Remember which sync each export reflects, so a later sync triggers a new one.
  config.exported = config.exported || {};
  for (const id of surveyIds) {
    const { body } = await fetchJson(`${CONNECTOR}/api/surveys/${id}/status`);
    if (body && body.last_sync_at) config.exported[id] = body.last_sync_at;
  }
  config.exportedAt = new Date().toISOString();
  saveConfig();
  send('data:changed');
  return { ok: true, message: `Saved CSV files for ${surveyIds.length} survey(s) in ${exportFolder()}.` };
}

async function exportIfWanted(surveyIds) {
  if (!config.autoExport || surveyIds.length === 0) return;
  const result = await runExport(surveyIds);
  log(result.message);
}

/**
 * The manifest's update commands, in the connector folder. If the app started
 * the connector, it restarts it so the new version is the one running.
 */
async function runUpdate() {
  if (!connectorScripts()) {
    return { ok: false, message: 'The connector isn\'t downloaded yet. Run "Get the code and install dependencies" in Setup first.' };
  }

  const action = manifest.actions.update;
  log('');
  log(`──── ${action.title} ────`);
  for (const command of actionCommands(action)) {
    log(`> ${command}`);
    const { code } = await runner.run(command, repoDir());
    if (code !== 0) return { ok: false, message: `This command failed (exit code ${code}): ${command}` };
  }

  const parts = ['The connector is up to date.'];
  if (runner.isRunning('function')) {
    runner.stop('function');
    const restart = await runStepById('function', {});
    parts.push(restart.ok ? 'It was restarted, so the new version is running.' : `Restarting it failed: ${restart.message}`);
  } else if (await connectorRunning()) {
    parts.push('A connector this app didn\'t start is running. Restart it to use the new version.');
  }
  if (!(connectorScripts() || {}).export) {
    parts.push('This version still can\'t save CSV files. That comes in a newer version of the connector that hasn\'t been published yet.');
  }

  send('data:changed');
  return { ok: true, message: parts.join(' ') };
}

// --- connector data ------------------------------------------------------------------

async function connectorRunning() {
  return (await fetchJson(`${CONNECTOR}/api/health`)).status === 200;
}

async function surveyTitle(id) {
  if (titles.has(id)) return titles.get(id);
  const { body } = await fetchJson(`${tableUrl({ surveyId: id, table: 'surveys', format: 'json' })}`);
  const title = body && body.data && body.data[0] && body.data[0].title;
  if (title) titles.set(id, title);
  return title || null;
}

/** Surveys the connector is configured to sync, with their latest status. */
async function surveyOverview() {
  const running = await connectorRunning();
  const ids = new Set(describeSettings(currentSettings(), TOKEN_KEY).surveyIds);
  let schedule = null;

  if (running) {
    const { body } = await fetchJson(`${CONNECTOR}/api/setup/status`);
    if (body) {
      for (const id of (body.config && body.config.surveyIds) || []) ids.add(String(id));
      for (const s of body.surveys || []) ids.add(String(s.survey_id));
      schedule = body.active_schedule || null;
    }
  }

  const surveys = [];
  for (const id of [...ids].filter((i) => SURVEY_ID.test(i)).sort()) {
    const status = running ? (await fetchJson(`${CONNECTOR}/api/surveys/${id}/status`)).body : null;
    surveys.push({
      id,
      title: status && status.synced ? await surveyTitle(id) : null,
      synced: Boolean(status && status.synced),
      lastSyncAt: (status && status.last_sync_at) || null,
      responseCount: status && status.synced ? status.response_count : null,
      rowCounts: (status && status.row_counts) || {},
      historyEnabled: Boolean(status && status.history_enabled),
      snapshots: (status && status.snapshots) || [],
      exportedSync: (config.exported || {})[id] || null,
    });
  }

  const times = schedule ? dailyTimes(schedule) : null;
  const scripts = connectorScripts();
  return {
    connectorRunning: running,
    connectorDownloaded: Boolean(scripts),
    exportAvailable: Boolean(scripts && scripts.export),
    exportBlocker: exportBlocker(),
    updateCommands: manifest.actions.update.commands,
    storageFolder: storageFolder(),
    exportFolder: exportFolder(),
    exportInOneDrive: isInOneDrive(exportFolder()),
    installInOneDrive: isInOneDrive(parentDir()),
    autoExport: Boolean(config.autoExport),
    keepRunning: Boolean(config.keepRunning),
    keepRunningAvailable: app.isPackaged,
    exportCommand: manifest.actions.export.command,
    exportSummary: manifest.actions.export.summary,
    schedule: {
      expression: schedule,
      syncTimes: times ? times.map(formatTime) : null,
      refreshTimes: times ? suggestRefreshTimes(times).map(formatTime) : null,
    },
    surveys,
  };
}

/** Downloads just enough of a table's CSV to show its first rows. */
async function previewTable(options) {
  const url = tableUrl({ ...options, format: 'csv' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      let message = `The connector returned ${response.status}.`;
      try {
        const body = await response.json();
        if (body && body.message) message = body.message;
      } catch {
        // keep the status message
      }
      return { ok: false, message };
    }

    const reader = createPreviewReader(PREVIEW_ROWS);
    const decoder = new TextDecoder('utf-8');
    let enough = false;
    for await (const chunk of response.body) {
      if (reader.push(decoder.decode(chunk, { stream: true }))) {
        enough = true;
        break; // leaving the loop cancels the rest of the download
      }
    }
    if (enough) controller.abort();
    return { ok: true, ...reader.finish() };
  } catch {
    return { ok: false, message: 'Could not read the table. Is the connector running?' };
  } finally {
    clearTimeout(timer);
  }
}

// --- IPC: setup ----------------------------------------------------------------------

ipcMain.handle('setup:manifest', () => manifest);
ipcMain.handle('setup:state', () => currentState());

ipcMain.handle('setup:choose-folder', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose where to install the connector',
    defaultPath: parentDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!result.canceled && result.filePaths[0]) {
    config.parentDir = result.filePaths[0];
    saveConfig();
  }
  return currentState();
});

ipcMain.handle('setup:list-surveys', async (_event, rawToken) => {
  try {
    let token = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (!token) {
      const settings = currentSettings();
      token = (settings && settings.Values && settings.Values[TOKEN_KEY]) || '';
    }
    if (!isPlausibleToken(token)) {
      return { ok: false, message: 'Enter your SurveyMonkey access token first.' };
    }
    secrets.add(token);
    return { ok: true, surveys: await listSurveys(token) };
  } catch (err) {
    return { ok: false, message: redact(err.message) };
  }
});

ipcMain.handle('setup:run-step', async (_event, stepId, rawInputs) => {
  const result = await exclusive(() => runStepById(stepId, rawInputs));
  return { ...result, state: currentState() };
});

ipcMain.handle('setup:open-external', async (_event, url) => {
  if (typeof url !== 'string' || !OPEN_ALLOWED.some((pattern) => pattern.test(url))) return false;
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('app:copy', (_event, text) => {
  if (typeof text !== 'string' || text.length > 200000) return false;
  clipboard.writeText(text);
  return true;
});

// --- IPC: data -------------------------------------------------------------------------

ipcMain.handle('data:overview', () => surveyOverview());

ipcMain.handle('data:start-connector', () =>
  exclusive(async () => {
    for (const id of ['azurite', 'function']) {
      const result = await runStepById(id, {});
      if (!result.ok) return result;
    }
    return { ok: true, message: 'The storage emulator and the connector are running.' };
  })
);

ipcMain.handle('data:update-connector', () => exclusive(runUpdate));

ipcMain.handle('data:sync', (_event, surveyId) =>
  exclusive(() => runStepById('sync', { surveyIds: [checkSurveyId(surveyId)] }))
);

ipcMain.handle('data:export', (_event, surveyIds) =>
  exclusive(() => {
    const ids = (Array.isArray(surveyIds) ? surveyIds : [surveyIds]).map(checkSurveyId);
    return runExport(ids);
  })
);

ipcMain.handle('data:choose-export-folder', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose where to save the CSV files',
    defaultPath: exportFolder(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: true };
  try {
    config.exportFolder = checkFolder(result.filePaths[0]);
    config.exported = {}; // a new folder needs every survey saved into it
    saveConfig();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('data:open-folder', async (_event, which) => {
  const folder = which === 'storage' ? storageFolder() : exportFolder();
  if (which !== 'storage') fs.mkdirSync(folder, { recursive: true });
  if (!fs.existsSync(folder)) return { ok: false, message: 'That folder does not exist yet. Start the storage emulator first.' };
  const error = await shell.openPath(folder);
  return error ? { ok: false, message: error } : { ok: true };
});

ipcMain.handle('data:set-option', (_event, name, value) => {
  if (name === 'autoExport') {
    config.autoExport = Boolean(value);
  } else if (name === 'keepRunning') {
    config.keepRunning = Boolean(value) && app.isPackaged;
    applyKeepRunning();
  } else {
    return { ok: false, message: 'Unknown option.' };
  }
  saveConfig();
  return { ok: true };
});

// --- IPC: Power BI ---------------------------------------------------------------------

ipcMain.handle('pbi:catalog', () => ({ tables: TABLES, fullModel: FULL_MODEL, relationships: RELATIONSHIPS }));

ipcMain.handle('pbi:query', (_event, raw) => {
  try {
    const options = checkTableOptions(raw);
    return { ok: true, url: tableUrl(options), query: buildQuery(options) };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('pbi:preview', async (_event, raw) => {
  try {
    return await previewTable(checkTableOptions(raw));
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

// --- automatic CSV export for the connector's own scheduled syncs ----------------------

async function watchForSyncs() {
  // An older connector copy can't export; don't retry (and log a failure) every minute.
  if (!config.autoExport || busy || exportBlocker() || !(await connectorRunning())) return;

  const statuses = {};
  for (const id of describeSettings(currentSettings(), TOKEN_KEY).surveyIds) {
    if (SURVEY_ID.test(id)) statuses[id] = (await fetchJson(`${CONNECTOR}/api/surveys/${id}/status`)).body;
  }
  const ids = surveysNeedingExport(statuses, config.exported || {});
  if (ids.length === 0 || busy) return;

  await exclusive(async () => {
    const result = await runExport(ids);
    log(result.message);
    return result;
  });
}

// --- keep running in the background ------------------------------------------------------

function trayIcon() {
  const image = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
  return image.isEmpty() ? image : image.resize({ width: 16, height: 16 });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function applyKeepRunning() {
  if (!app.isPackaged || SMOKE_TEST) return;

  app.setLoginItemSettings({ openAtLogin: Boolean(config.keepRunning), args: ['--background'] });

  if (config.keepRunning && !tray) {
    tray = new Tray(trayIcon());
    tray.setToolTip('SurveyMonkey Power BI Connector: the connector is running');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open SurveyMonkey Power BI Connector', click: showWindow },
        { type: 'separator' },
        { label: 'Quit (stops the connector)', click: () => app.quit() },
      ])
    );
    tray.on('click', showWindow);
  } else if (!config.keepRunning && tray) {
    tray.destroy();
    tray = null;
  }
}

/** Started with Windows: bring the connector up without showing the window. */
async function startInBackground() {
  if (!currentState().repoExists || !currentState().settingsExists) return;
  await exclusive(async () => {
    for (const id of ['azurite', 'function']) {
      const result = await runStepById(id, {});
      if (!result.ok) {
        if (Notification.isSupported()) {
          new Notification({ title: 'SurveyMonkey Power BI Connector', body: `Could not start: ${result.message}` }).show();
        }
        return result;
      }
    }
    return { ok: true };
  });
}

// --- window ---------------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    // Until the page loads and sets its own title. On some PCs security
    // software makes the first page take many seconds to appear.
    title: 'Starting SurveyMonkey → Power BI…',
    backgroundColor: '#f6f7f9',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    show: !SMOKE_TEST && !BACKGROUND,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The window only ever shows the bundled page; links open in the browser.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // With "keep running" on, closing the window leaves the connector running in the tray.
  win.on('close', (event) => {
    if (config.keepRunning && tray && !quitting) {
      event.preventDefault();
      win.hide();
      if (!toldAboutTray && Notification.isSupported()) {
        toldAboutTray = true;
        new Notification({
          title: 'Still running in the background',
          body: 'The connector keeps syncing. Open or quit the app from its icon by the clock.',
        }).show();
      }
    }
  });

  // In a smoke test nobody can see the window, so report what goes wrong in it.
  if (SMOKE_TEST) {
    win.webContents.on('console-message', (details) => {
      const message = details && details.message !== undefined ? details.message : String(details);
      console.error(`page: ${message}`);
    });
    win.webContents.on('preload-error', (_event, file, error) => console.error(`preload failed (${file}): ${error.message}`));
    win.webContents.on('render-process-gone', (_event, info) => console.error(`renderer gone: ${info.reason}`));
    win.webContents.on('did-fail-load', (_event, code, description) => console.error(`load failed: ${code} ${description}`));
    win.webContents.on('did-finish-load', () => console.log(`timing: page loaded at ${process.uptime().toFixed(1)}s`));
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

if (!SMOKE_TEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    config = loadConfig();
    app.setAppUserModelId('io.github.harsha99-99.surveymonkey-powerbi-setup');

    if (SMOKE_TEST) {
      console.log(`timing: app ready at ${process.uptime().toFixed(1)}s`);
      const timer = setTimeout(() => {
        console.error('SMOKE FAIL: renderer did not report ready');
        app.exit(1);
      }, 60000); // a freshly built app can take a while to launch while antivirus scans it
      ipcMain.once('setup:renderer-ready', (_event, report) => {
        clearTimeout(timer);
        const ok = report && report.steps === manifest.steps.length && report.views === 4;
        console.log(`timing: page ready at ${process.uptime().toFixed(1)}s`);
        console.log(`SMOKE ${ok ? 'OK' : 'FAIL'}: renderer loaded ${report && report.steps} steps and ${report && report.views} screens`);
        app.exit(ok ? 0 : 1);
      });
    }

    createWindow();
    applyKeepRunning();
    if (BACKGROUND) startInBackground();
    if (!SMOKE_TEST) setInterval(() => watchForSyncs().catch(() => {}), WATCH_INTERVAL_MS);
  });

  // Background processes belong to this app; quitting stops them.
  app.on('before-quit', () => {
    quitting = true;
    runner.stopAll();
  });
  app.on('window-all-closed', () => {
    if (!(config.keepRunning && tray)) app.quit();
  });
}

