/**
 * manifest.js
 *
 * Loads and validates the setup steps in steps/windows.json, and expands them
 * into the exact commands to run. The same file drives the README check in
 * test/setupSteps.test.js, which is what keeps the app and the documented
 * command-line path identical.
 *
 * No Electron and no I/O beyond reading the manifest, so it is testable in CI.
 */

const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_PATH = path.join(__dirname, '..', '..', 'steps', 'windows.json');
const SURVEY_PLACEHOLDER = '<survey-id>';
const FOLDER_PLACEHOLDER = '<folder>';
const SURVEY_ID = /^\d{1,20}$/;

function loadManifest(file = MANIFEST_PATH) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateManifest(manifest);
  return manifest;
}

function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.steps) || manifest.steps.length === 0) {
    throw new Error('Manifest must contain a non-empty steps array.');
  }

  const seen = new Set();
  for (const step of manifest.steps) {
    if (!step.id || !step.title || !step.summary) {
      throw new Error(`Step ${step.id || '(no id)'} needs an id, title and summary.`);
    }
    if (seen.has(step.id)) throw new Error(`Duplicate step id: ${step.id}`);
    seen.add(step.id);

    const kinds = ['tools', 'commands', 'open'].filter((k) => step[k] !== undefined);
    if (kinds.length !== 1) {
      throw new Error(`Step ${step.id} must have exactly one of tools, commands or open.`);
    }
    if (step.background && (!step.commands || step.commands.length !== 1)) {
      throw new Error(`Background step ${step.id} must have exactly one command.`);
    }
    for (const entry of step.settings || []) {
      if (!entry.key || (entry.value === undefined) === (entry.input === undefined)) {
        throw new Error(`Setting in ${step.id} needs a key and exactly one of value or input.`);
      }
    }
  }

  for (const [id, action] of Object.entries(manifest.actions || {})) {
    const single = typeof action.command === 'string';
    const list = Array.isArray(action.commands) && action.commands.length > 0 && action.commands.every((c) => typeof c === 'string');
    if (!action.title || !action.summary || single === list) {
      throw new Error(`Action ${id} needs a title, a summary, and either one command or a list of commands.`);
    }
  }
}

/** Every command an action runs, in order. Placeholders are only allowed in single-command actions. */
function actionCommands(action, options) {
  return action.commands ? action.commands.slice() : [expandAction(action, options)];
}

/**
 * Characters that would let a folder name escape the double quotes around it
 * in PowerShell ($ and backtick), or expand in cmd.exe (% and !) if npm runs
 * through npm.cmd. Folder pickers never need them for ordinary folders.
 */
const UNSAFE_FOLDER = /["$`%!\r\n]/;

/** Checks a folder chosen for the export and returns it normalized. */
function checkFolder(folder) {
  if (typeof folder !== 'string' || !folder.trim()) throw new Error('Choose a folder first.');
  if (UNSAFE_FOLDER.test(folder)) {
    throw new Error('That folder name contains a character the export cannot use: " $ ` % or !. Choose or rename the folder.');
  }
  if (!path.win32.isAbsolute(folder)) {
    throw new Error('Choose a full folder path, such as C:\\Users\\you\\Documents\\SurveyMonkey data.');
  }
  const resolved = path.win32.resolve(folder);
  if (path.win32.parse(resolved).root === resolved) throw new Error('Choose a folder, not a whole drive.');
  // Windows paths longer than about 260 characters break some tools; leave
  // room for the survey-<id>\snapshot-<date>\<table>.csv.tmp that goes inside.
  if (resolved.length > 180) throw new Error('That folder path is too long. Choose a folder closer to the top of the drive.');
  // No trailing backslash: before a closing quote it would escape the quote.
  return resolved.replace(/\\+$/, '');
}

/** The command an action runs, with its placeholders filled in and checked. */
function expandAction(action, { surveyIds = [], folder } = {}) {
  if (surveyIds.length === 0) throw new Error('Choose at least one survey.');
  for (const id of surveyIds) {
    if (!SURVEY_ID.test(id)) throw new Error(`Not a survey ID: ${id}`);
  }
  let command = action.command.split(SURVEY_PLACEHOLDER).join(surveyIds.join(','));
  if (command.includes(FOLDER_PLACEHOLDER)) command = command.split(FOLDER_PLACEHOLDER).join(checkFolder(folder));
  return command;
}

/** Every command the README must list, in order: tool installs, then step commands. */
function allCommands(manifest) {
  const out = [];
  for (const step of manifest.steps) {
    for (const tool of step.tools || []) out.push(tool.install);
    for (const command of step.commands || []) out.push(command);
  }
  return out;
}

/** The commands a step runs, with <survey-id> replaced once per survey. */
function expandCommands(step, surveyIds = []) {
  const commands = step.commands || [];
  if (!step.perSurvey) return commands.slice();

  const out = [];
  for (const id of surveyIds) {
    if (!SURVEY_ID.test(id)) throw new Error(`Not a survey ID: ${id}`);
    for (const command of commands) out.push(command.split(SURVEY_PLACEHOLDER).join(id));
  }
  return out;
}

/** Parses "123, 456" or "123 456" into IDs, reporting anything that isn't one. */
function parseSurveyIds(text) {
  const parts = String(text || '')
    .split(/[\s,]+/)
    .filter(Boolean);
  return {
    ids: parts.filter((p) => SURVEY_ID.test(p)),
    invalid: parts.filter((p) => !SURVEY_ID.test(p)),
  };
}

/** A SurveyMonkey access token is one line of printable characters. */
function isPlausibleToken(token) {
  return typeof token === 'string' && /^[\x21-\x7e]{10,1000}$/.test(token);
}

module.exports = {
  MANIFEST_PATH,
  SURVEY_PLACEHOLDER,
  FOLDER_PLACEHOLDER,
  loadManifest,
  validateManifest,
  allCommands,
  expandCommands,
  expandAction,
  actionCommands,
  checkFolder,
  parseSurveyIds,
  isPlausibleToken,
};
