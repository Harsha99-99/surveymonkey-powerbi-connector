/*
 * Starts the page: loads the steps, wires the screen tabs and the output
 * panel, and tells the main process the page is ready.
 */

(function () {
  'use strict';

  var api = App.api;

  async function init() {
    api.onOutput(App.appendOutput);

    var manifest = await api.manifest();
    var state = await api.state();

    App.setup.init(manifest, state);
    App.data.init();
    App.powerbi.init();
    App.refresh.init();

    App.$$('[data-view]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        App.showView(tab.dataset.view);
      });
    });
    App.$$('[data-goto-view]').forEach(function (link) {
      link.addEventListener('click', function () {
        App.showView(link.dataset.gotoView);
      });
    });
    App.$('#clear-output').addEventListener('click', App.clearOutput);

    // Exports and scheduled syncs happen in the background; keep the open screen current.
    api.onDataChanged(function () {
      var view = App.currentView();
      if (view === 'data') App.data.refresh();
      if (view === 'powerbi') App.powerbi.refresh();
    });

    api.ready({ steps: manifest.steps.length, views: App.$$('.view').length });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
