/*
 * Data screen: where the data lives, the CSV folder, and syncing or saving
 * each survey.
 */

App.data = (function () {
  'use strict';

  var api = App.api;
  var $ = App.$;
  var el = App.el;
  var overview = null;

  function csvStatus(survey) {
    if (!survey.synced) return 'Sync first';
    if (!survey.exportedSync) return 'Not saved yet';
    return survey.exportedSync === survey.lastSyncAt ? 'Up to date' : 'Older sync';
  }

  function render() {
    var busy = App.isBusy();

    var banners = $('#data-banner');
    App.clear(banners);
    if (overview.connectorDownloaded && !overview.exportAvailable) {
      App.addBanner(
        banners,
        'warn',
        "Your copy of the connector is older than this app, so it can't save CSV files yet.",
        'Update the connector',
        updateConnector,
        'Runs ' + overview.updateCommands.join(', then ') + ' in the connector folder. Your settings and synced data are kept.'
      );
    }
    if (!overview.connectorRunning) {
      App.addBanner(banners, 'warn', "The connector isn't running, so surveys can't be synced or saved.", 'Start it', startConnector);
    }

    $('#export-folder').textContent = overview.exportFolder;
    $('#storage-folder').textContent = overview.storageFolder;
    $('#export-command').textContent = overview.exportCommand;
    $('#auto-export').checked = overview.autoExport;
    $('#export-onedrive').hidden = !overview.exportInOneDrive;
    $('#storage-onedrive').hidden = !overview.installInOneDrive;

    var synced = overview.surveys.filter(function (s) {
      return s.synced;
    });
    var canExport = overview.connectorRunning && overview.exportAvailable;
    $('#export-all').disabled = busy || !canExport || synced.length === 0;
    $('#change-export-folder').disabled = busy;
    $('#auto-export').disabled = busy;

    var rows = $('#survey-rows');
    App.clear(rows);
    if (overview.surveys.length === 0) {
      var empty = el('tr');
      var cell = el('td', 'muted', 'No surveys chosen yet. Choose them in Setup, step 3.');
      cell.colSpan = 5;
      empty.appendChild(cell);
      rows.appendChild(empty);
    }

    overview.surveys.forEach(function (survey) {
      var row = el('tr');

      var name = el('td');
      name.appendChild(el('div', null, survey.title || 'Survey ' + survey.id));
      name.appendChild(el('div', 'meta', survey.id + (survey.synced ? '' : ' · not synced yet')));
      row.appendChild(name);

      row.appendChild(el('td', null, survey.synced ? App.formatDate(survey.lastSyncAt) : '—'));
      row.appendChild(el('td', null, survey.synced ? String(survey.responseCount) : '—'));

      var state = csvStatus(survey);
      row.appendChild(el('td', state === 'Up to date' ? 'ok-text' : null, state));

      var actions = el('td', 'row-actions');
      var sync = el('button', 'ghost small', 'Sync now');
      sync.disabled = busy || !overview.connectorRunning;
      sync.addEventListener('click', function () {
        run(function () {
          return api.sync(survey.id);
        });
      });
      actions.appendChild(sync);

      var save = el('button', 'ghost small', 'Save CSVs');
      save.disabled = busy || !canExport || !survey.synced;
      save.addEventListener('click', function () {
        run(function () {
          return api.exportCsv([survey.id]);
        });
      });
      actions.appendChild(save);
      row.appendChild(actions);

      rows.appendChild(row);
    });
  }

  async function refresh() {
    overview = await api.overview();
    render();
  }

  async function run(task, resultNode) {
    var result = await App.whileBusy(task);
    App.setResult(resultNode || $('#survey-result'), result);
    await refresh();
    if (App.setup) App.setup.refreshState();
  }

  function startConnector() {
    return run(function () {
      return api.startConnector();
    });
  }

  function updateConnector() {
    return run(function () {
      return api.updateConnector();
    }, $('#export-result'));
  }

  function init() {
    $('#export-all').addEventListener('click', function () {
      var ids = overview.surveys
        .filter(function (s) {
          return s.synced;
        })
        .map(function (s) {
          return s.id;
        });
      run(function () {
        return api.exportCsv(ids);
      }, $('#export-result'));
    });

    $('#change-export-folder').addEventListener('click', async function () {
      var result = await api.chooseExportFolder();
      App.setResult($('#export-result'), result.ok ? null : result);
      refresh();
    });

    $('#open-export-folder').addEventListener('click', async function () {
      var result = await api.openFolder('export');
      if (!result.ok) App.setResult($('#export-result'), result);
    });

    $('#open-storage-folder').addEventListener('click', async function () {
      var result = await api.openFolder('storage');
      if (!result.ok) App.setResult($('#export-result'), result);
    });

    $('#auto-export').addEventListener('change', async function (event) {
      await api.setOption('autoExport', event.target.checked);
      App.setResult(
        $('#export-result'),
        event.target.checked
          ? { ok: true, message: 'CSV files will be saved after every sync while this app is running.' }
          : null
      );
      refresh();
    });

    App.onBusyChange(function () {
      if (overview) render();
    });
    App.registerView('data', refresh);
  }

  return { init: init, refresh: refresh };
})();
