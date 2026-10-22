/**
 * settings.js
 *
 * Applies the manifest's settings to local.settings.json, the same values the
 * README's settings table tells people to type in by hand.
 *
 * The token is only ever written to that file, which the connector's
 * .gitignore keeps out of git. Leaving the token blank keeps the one already
 * in the file, so re-running the step does not ask for it again.
 */

const fs = require('node:fs');

function applySettings(current, entries, inputs = {}) {
  const next = JSON.parse(JSON.stringify(current || {}));
  next.Values = next.Values || {};

  for (const entry of entries) {
    if (entry.value !== undefined) {
      next.Values[entry.key] = entry.value;
    } else if (entry.input === 'token') {
      if (inputs.token) {
        next.Values[entry.key] = inputs.token;
      } else if (!next.Values[entry.key]) {
        throw new Error('Enter your SurveyMonkey access token.');
      }
    } else if (entry.input === 'surveyIds') {
      const ids = inputs.surveyIds || [];
      if (ids.length === 0) throw new Error('Choose at least one survey to sync.');
      next.Values[entry.key] = ids.join(',');
    } else {
      throw new Error(`Unknown setting input: ${entry.input}`);
    }
  }

  return next;
}

function readSettings(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeSettings(file, settings) {
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

/** What the app may show about an existing settings file. Never the token. */
function describeSettings(settings, tokenKey) {
  const values = (settings && settings.Values) || {};
  return {
    hasToken: Boolean(values[tokenKey]),
    surveyIds: String(values.SYNC_SURVEY_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

module.exports = { applySettings, readSettings, writeSettings, describeSettings };
