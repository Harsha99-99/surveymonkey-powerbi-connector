/*
 * Scheduled refresh screen: the guide, the "keep running" option, and refresh
 * times worked out from the connector's own sync schedule.
 */

App.refresh = (function () {
  'use strict';

  var api = App.api;
  var $ = App.$;
  var GATEWAY_DOWNLOAD = 'https://go.microsoft.com/fwlink/?LinkId=820925&clcid=0x409';
  var POWER_BI_SERVICE = 'https://app.powerbi.com/';

  async function refresh() {
    var overview = await api.overview();

    var keep = $('#keep-running');
    keep.checked = overview.keepRunning;
    keep.disabled = !overview.keepRunningAvailable;
    $('#keep-running-note').textContent = overview.keepRunningAvailable
      ? 'When this is on, closing the window leaves the connector running. Quit it from its icon by the clock.'
      : 'This option works in the installed app. You are running it from the source code.';

    var schedule = overview.schedule;
    if (!overview.connectorRunning) {
      $('#sync-times').textContent = 'Start the connector to see when it syncs.';
      $('#refresh-times').textContent = '';
    } else if (schedule.syncTimes) {
      $('#sync-times').textContent =
        'The connector syncs at ' + schedule.syncTimes.join(', ') + ", this PC's time (" + schedule.expression + ').';
      $('#refresh-times').textContent =
        'Suggested times, 30 minutes after each sync: ' + schedule.refreshTimes.join(', ') + '.';
    } else {
      $('#sync-times').textContent = 'The connector syncs on this schedule: ' + (schedule.expression || 'unknown') + '.';
      $('#refresh-times').textContent = 'Pick times a little after the connector syncs.';
    }
  }

  function init() {
    $('#keep-running').addEventListener('change', async function (event) {
      await api.setOption('keepRunning', event.target.checked);
      refresh();
    });
    $('#open-gateway').addEventListener('click', function () {
      api.openExternal(GATEWAY_DOWNLOAD);
    });
    $('#open-powerbi').addEventListener('click', function () {
      api.openExternal(POWER_BI_SERVICE);
    });
    App.registerView('refresh', refresh);
  }

  return { init: init, refresh: refresh };
})();
