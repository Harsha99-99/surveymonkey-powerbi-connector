/*
 * Power BI screen: pick a survey, the data (latest or a snapshot), the format
 * and the tables, preview them, and copy the URLs and Power Query for each.
 */

App.powerbi = (function () {
  'use strict';

  var api = App.api;
  var $ = App.$;
  var $$ = App.$$;
  var el = App.el;

  // From docs/powerbi.md.
  var MEASURES = [
    'Average Rating = AVERAGE(answers[value_numeric])',
    'Response Count = DISTINCTCOUNT(answers[response_id])',
    'Answered Rate =\nDIVIDE(\n    CALCULATE(COUNTROWS(answers), answers[is_skipped] = FALSE),\n    COUNTROWS(answers)\n)',
  ];

  var catalog = null;
  var overview = null;
  var choice = { surveyId: null, snapshot: '', format: 'csv', tables: null, preview: null };
  var queryRender = 0; // lets a newer rebuild of the query cards cancel an older one

  function surveyById(id) {
    return (overview.surveys || []).find(function (s) {
      return s.id === id;
    });
  }

  function syncedSurveys() {
    return overview.surveys.filter(function (s) {
      return s.synced;
    });
  }

  function options(table) {
    return { surveyId: choice.surveyId, table: table, format: choice.format, snapshot: choice.snapshot || null };
  }

  // --- rendering ------------------------------------------------------------------

  function renderSurveyPicker() {
    var picker = $('#pbi-survey');
    App.clear(picker);
    syncedSurveys().forEach(function (survey) {
      var option = el('option', null, (survey.title || 'Survey ' + survey.id) + ' (' + survey.id + ')');
      option.value = survey.id;
      picker.appendChild(option);
    });
    if (!surveyById(choice.surveyId) || !surveyById(choice.surveyId).synced) {
      var first = syncedSurveys()[0];
      choice.surveyId = first ? first.id : null;
    }
    picker.value = choice.surveyId || '';
  }

  function renderSnapshotPicker(survey) {
    var picker = $('#pbi-snapshot');
    App.clear(picker);
    var latest = el('option', null, 'Latest sync');
    latest.value = '';
    picker.appendChild(latest);
    survey.snapshots.forEach(function (date) {
      var option = el('option', null, 'Snapshot from ' + date);
      option.value = date;
      picker.appendChild(option);
    });
    if (choice.snapshot && survey.snapshots.indexOf(choice.snapshot) === -1) choice.snapshot = '';
    picker.value = choice.snapshot;
    picker.disabled = survey.snapshots.length === 0;
  }

  function renderStatus(survey) {
    var parts = [
      'Last synced ' + App.formatDate(survey.lastSyncAt),
      survey.responseCount + ' responses',
      survey.historyEnabled ? 'history is on' : 'history is off',
    ];
    $('#pbi-status').textContent = parts.join(' · ');

    var hints = [];
    hints.push(
      choice.format === 'json'
        ? 'JSON downloads are larger, but numbers and true/false values arrive already typed.'
        : 'CSV is the default and the quickest to download. The queries set number, true/false and date types for you.'
    );
    if (!survey.historyEnabled) {
      hints.push('To keep dated snapshots, turn on history in the browser wizard (step 3, "Keep dated snapshots").');
    } else if (choice.snapshot) {
      hints.push('A snapshot is frozen: refreshing it in Power BI always gives the data as it was on ' + choice.snapshot + '.');
    }
    $('#pbi-hint').textContent = hints.join(' ');
  }

  function renderTables(survey) {
    var list = $('#pbi-tables');
    App.clear(list);

    catalog.tables.forEach(function (table) {
      var item = el('li');
      var box = el('input');
      box.type = 'checkbox';
      box.id = 'pbi-table-' + table.name;
      box.checked = choice.tables.has(table.name);
      box.addEventListener('change', function () {
        if (box.checked) choice.tables.add(table.name);
        else choice.tables.delete(table.name);
        renderQueries();
      });

      var label = el('label');
      label.htmlFor = box.id;
      var count = survey.rowCounts[table.name];
      label.appendChild(el('span', 'name', table.label));
      label.appendChild(el('span', 'meta', (count === undefined ? '?' : count) + ' rows · ' + table.description));

      var preview = el('button', 'ghost small', 'Preview');
      preview.type = 'button';
      preview.addEventListener('click', function () {
        showPreview(table);
      });

      item.appendChild(box);
      item.appendChild(label);
      item.appendChild(preview);
      list.appendChild(item);
    });
  }

  function selectedInOrder() {
    return catalog.tables
      .map(function (t) {
        return t.name;
      })
      .filter(function (name) {
        return choice.tables.has(name);
      });
  }

  function renderRelationships() {
    var relevant = catalog.relationships.filter(function (r) {
      return choice.tables.has(r.from.split('[')[0]) && choice.tables.has(r.to.split('[')[0]);
    });
    var list = $('#pbi-relationships');
    App.clear(list);
    relevant.forEach(function (r) {
      var item = el('li');
      item.appendChild(el('code', null, r.from));
      item.appendChild(document.createTextNode(' → '));
      item.appendChild(el('code', null, r.to));
      list.appendChild(item);
    });
    $('#pbi-relationships-step').hidden = relevant.length === 0;
  }

  async function renderQueries() {
    var mine = ++queryRender;
    renderRelationships();
    var container = $('#pbi-queries');
    App.clear(container);

    var tables = selectedInOrder();
    if (tables.length === 0) {
      container.appendChild(el('p', 'muted', 'Choose at least one table above.'));
      return;
    }

    for (var i = 0; i < tables.length; i += 1) {
      var table = tables[i];
      var result = await api.query(options(table));
      if (mine !== queryRender) return;
      var card = el('div', 'query-card');
      var head = el('div', 'query-head');
      head.appendChild(el('h3', null, table));

      if (!result.ok) {
        card.appendChild(head);
        card.appendChild(el('p', 'result bad', result.message));
        container.appendChild(card);
        continue;
      }

      var actions = el('div', 'actions tight');
      actions.appendChild(App.copyButton(result.query, 'Copy query'));
      actions.appendChild(App.copyButton(result.url, 'Copy URL'));
      head.appendChild(actions);
      card.appendChild(head);

      var url = el('p', 'hint');
      url.appendChild(document.createTextNode('URL: '));
      url.appendChild(el('code', null, result.url));
      card.appendChild(url);

      var details = el('details');
      details.appendChild(el('summary', null, 'Show the query'));
      details.appendChild(el('pre', 'commands', result.query));
      card.appendChild(details);
      container.appendChild(card);
    }
  }

  async function showPreview(table) {
    var card = $('#pbi-preview-card');
    card.hidden = false;
    $('#pbi-preview-title').textContent = 'Preview: ' + table.label + (choice.snapshot ? ' (snapshot ' + choice.snapshot + ')' : '');
    $('#pbi-preview-note').textContent = 'Loading…';
    var grid = $('#pbi-preview');
    App.clear(grid);

    var result = await api.preview({ surveyId: choice.surveyId, table: table.name, snapshot: choice.snapshot || null });
    if (!result.ok) {
      $('#pbi-preview-note').textContent = result.message;
      return;
    }

    var head = el('tr');
    result.columns.forEach(function (column) {
      head.appendChild(el('th', null, column));
    });
    var thead = el('thead');
    thead.appendChild(head);
    grid.appendChild(thead);

    var body = el('tbody');
    result.rows.forEach(function (cells) {
      var row = el('tr');
      result.columns.forEach(function (_column, i) {
        row.appendChild(el('td', null, cells[i] === undefined ? '' : cells[i]));
      });
      body.appendChild(row);
    });
    grid.appendChild(body);

    var survey = surveyById(choice.surveyId);
    var total = survey && survey.rowCounts[table.name];
    $('#pbi-preview-note').textContent =
      result.rows.length === 0
        ? 'This table has no rows yet.'
        : 'Showing the first ' + result.rows.length + (total !== undefined ? ' of ' + total : '') + ' rows, as the CSV holds them.' +
          (result.truncated ? ' Power BI loads all of them.' : '');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderMeasures() {
    $('#pbi-measures').textContent = MEASURES.join('\n\n');
    var actions = $('#pbi-measures-actions');
    App.clear(actions);
    MEASURES.forEach(function (measure) {
      actions.appendChild(App.copyButton(measure, 'Copy ' + measure.split(' =')[0]));
    });
  }

  function renderAll() {
    var hasData = overview.connectorRunning && syncedSurveys().length > 0;
    if (!overview.connectorRunning) {
      App.banner($('#pbi-banner'), 'warn', "The connector isn't running. Start it on the Data screen.", 'Go to Data', function () {
        App.showView('data');
      });
    } else if (!hasData) {
      App.banner($('#pbi-banner'), 'warn', 'No survey has synced yet. Sync one on the Data screen first.', 'Go to Data', function () {
        App.showView('data');
      });
    } else {
      App.banner($('#pbi-banner'), '', '');
    }

    $$('#view-powerbi .card').forEach(function (card) {
      card.classList.toggle('disabled', !hasData);
    });
    if (!hasData) return;

    renderSurveyPicker();
    var survey = surveyById(choice.surveyId);
    renderSnapshotPicker(survey);
    renderStatus(survey);
    renderTables(survey);
    renderQueries();
  }

  async function refresh() {
    if (!catalog) catalog = await api.catalog();
    if (!choice.tables) choice.tables = new Set(catalog.fullModel);
    overview = await api.overview();
    renderMeasures();
    renderAll();
  }

  function init() {
    $('#pbi-survey').addEventListener('change', function (event) {
      choice.surveyId = event.target.value;
      $('#pbi-preview-card').hidden = true;
      renderAll();
    });
    $('#pbi-snapshot').addEventListener('change', function (event) {
      choice.snapshot = event.target.value;
      $('#pbi-preview-card').hidden = true;
      renderAll();
    });
    $$('input[name="pbi-format"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        choice.format = radio.value;
        renderAll();
      });
    });
    $('#pick-full').addEventListener('click', function () {
      choice.tables = new Set(catalog.fullModel);
      renderAll();
    });
    $('#pick-flat').addEventListener('click', function () {
      choice.tables = new Set(['flat']);
      renderAll();
    });

    App.registerView('powerbi', refresh);
  }

  return { init: init, refresh: refresh };
})();
