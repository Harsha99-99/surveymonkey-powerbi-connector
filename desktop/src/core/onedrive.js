/**
 * onedrive.js
 *
 * Tells whether a folder is inside OneDrive. On many work PCs, Documents is
 * redirected into OneDrive, so anything put there is uploaded: the
 * connector's code (over twenty thousand files in node_modules), the token in
 * local.settings.json, and synced survey data.
 */

const path = require('node:path');

/** OneDrive folders Windows tells programs about, through environment variables. */
function oneDriveRoots(env = process.env) {
  return [env.OneDriveCommercial, env.OneDriveConsumer, env.OneDrive]
    .filter(Boolean)
    .map((root) => path.win32.resolve(root).toLowerCase());
}

function isInOneDrive(folder, env = process.env) {
  if (!folder) return false;
  const target = path.win32.resolve(folder).toLowerCase();
  return oneDriveRoots(env).some((root) => target === root || target.startsWith(root + '\\'));
}

module.exports = { isInOneDrive, oneDriveRoots };
