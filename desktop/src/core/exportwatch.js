/**
 * exportwatch.js
 *
 * Decides which surveys need their CSV files saved again. A survey needs it
 * when it has synced since its last export. That covers syncs the app ran and
 * the connector's own scheduled syncs, which the app only learns about by
 * checking each survey's status.
 */

/**
 * @param {Record<string, {synced?: boolean, last_sync_at?: string}>} statuses by survey ID
 * @param {Record<string, string>} exported last_sync_at at the time of each survey's last export
 * @returns {string[]} survey IDs to export
 */
function surveysNeedingExport(statuses, exported) {
  return Object.entries(statuses)
    .filter(([, status]) => status && status.synced && status.last_sync_at)
    .filter(([id, status]) => exported[id] !== status.last_sync_at)
    .map(([id]) => id)
    .sort();
}

module.exports = { surveysNeedingExport };
