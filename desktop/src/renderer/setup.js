/*
 * Setup screen. Shows the manifest's steps, collects the token and the
 * surveys to sync, and asks the main process to run steps.
 */

App.setup = (function () {
  'use strict';

  var api = App.api;
  var $ = App.$;
  var el = App.el;
  var TOKEN_HELP_URL = 'https://developer.surveymonkey.com/apps/';
  var STATUS_TEXT = { pending: '', running: 'Running…', done: 'Done', failed: 'Needs attention' };

  var steps = [];
  var state = null;
  var current = 0;
  var status = {}; // step id -> pending | running | done | failed
  var results = {}; // step id -> { ok, message }
  var ui = { token: '', showToken: false, selected: new Set(), surveys: null, surveyError: '' };
  var listeners = [];

  // --- status ---------------------------------------------------------------

  function inferStatus() {
    steps.forEach(function (step) {
      if (!status[step.id]) status[step.id] = 'pending';
      if (status[step.id] === 'running') return;

      if (step.background) {
        // Background steps are only done while their process is alive.
        var alive = state.running[step.id];
        if (alive) status[step.id] = 'done';
        else if (status[step.id] === 'done') status[step.id] = 'pending';
      } else if (step.id === 'get-code' && state.repoExists) {
        status[step.id] = 'done';
      } else if (step.settings && state.settingsExists && state.hasToken && state.surveyIds.length > 0) {
        status[step.id] = 'done';
      }
    });
  }

  function firstIncomplete() {
    for (var i = 0; i < steps.length; i += 1) {
      if (status[steps[i].id] !== 'done') return i;
    }
    return steps.length - 1;
  }

  function setState(next) {
    state = next;
    inferStatus();
    $('#folder').textContent = state.repoDir;
    var warning = $('#folder-onedrive');
    warning.hidden = !state.installInOneDrive;
    warning.textContent = state.installInOneDrive
      ? 'This folder is in OneDrive, so the connector\'s files, your SurveyMonkey token and synced survey data are uploaded to it, ' +
        'and syncing its 20,000+ files slows the PC down. Choose a folder outside OneDrive, such as ' +
        state.suggestedParentDir + ', and run the setup steps again.'
      : '';
    App.setChips(state.running);
    listeners.forEach(function (listener) {
      listener(state);
    });
  }

  // --- rendering --------------------------------------------------------------

  function renderStepList() {
    var list = $('#step-list');
    App.clear(list);

    steps.forEach(function (step, index) {
      var item = el('li');
      var button = el('button', 'step ' + status[step.id]);
      if (index === current) button.setAttribute('aria-current', 'step');
      button.disabled = App.isBusy();

      button.appendChild(el('span', 'num', status[step.id] === 'done' ? '✓' : String(index + 1)));
      var text = el('span', 'text');
      text.appendChild(el('span', 'name', step.title));
      if (STATUS_TEXT[status[step.id]]) text.appendChild(el('span', 'state', STATUS_TEXT[status[step.id]]));
      button.appendChild(text);

      button.addEventListener('click', function () {
        select(index);
      });
      item.appendChild(button);
      list.appendChild(item);
    });
  }

  function select(index) {
    current = index;
    var step = steps[index];

    $('#step-number').textContent = 'Step ' + (index + 1) + ' of ' + steps.length;
    $('#step-title').textContent = step.title;
    $('#step-summary').textContent = step.summary;
    $('#step-note').textContent = step.note || '';
    $('#step-note').hidden = !step.note;
    renderInputs(step);
    $('#step-commands').textContent = commandsFor(step);
    App.setResult($('#step-result'), results[step.id]);

    var busy = App.isBusy();
    $('#run-step').disabled = busy;
    $('#run-step').textContent = status[step.id] === 'done' ? 'Run this step again' : 'Run this step';
    $('#next-step').disabled = busy || index === steps.length - 1;
    $('#run-all').disabled = busy;
    $('#choose-folder').disabled = busy;
    renderStepList();
  }

  function commandsFor(step) {
    if (step.tools) {
      var lines = [];
      step.tools.forEach(function (tool) {
        lines.push(tool.check);
        lines.push('# only if ' + tool.name + ' is missing:');
        lines.push(tool.install);
      });
      return lines.join('\n');
    }
    if (step.open) return 'Opens ' + step.open + ' in your browser';

    var commands = step.commands.slice();
    if (step.perSurvey) {
      var ids = Array.from(ui.selected);
      if (ids.length === 0) return commands.join('\n');
      var expanded = [];
      ids.forEach(function (id) {
        commands.forEach(function (command) {
          expanded.push(command.split('<survey-id>').join(id));
        });
      });
      commands = expanded;
    }
    return commands.join('\n');
  }

  function renderInputs(step) {
    var container = $('#step-inputs');
    App.clear(container);
    if (!step.settings) return;

    // Token
    var tokenField = el('div', 'field');
    var label = el('label', null, 'SurveyMonkey access token');
    label.htmlFor = 'token';
    tokenField.appendChild(label);

    var row = el('div', 'row');
    var input = el('input');
    input.id = 'token';
    input.type = ui.showToken ? 'text' : 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = ui.token;
    input.placeholder = state.hasToken ? 'Saved already. Leave blank to keep it.' : 'Paste your token here';
    input.addEventListener('input', function () {
      ui.token = input.value.trim();
    });
    row.appendChild(input);

    var toggle = el('button', 'ghost small', ui.showToken ? 'Hide' : 'Show');
    toggle.type = 'button';
    toggle.addEventListener('click', function () {
      ui.showToken = !ui.showToken;
      renderInputs(step);
    });
    row.appendChild(toggle);
    tokenField.appendChild(row);

    var help = el('ol', 'help');
    help.appendChild(el('li', null, 'Sign in at developer.surveymonkey.com/apps.'));
    help.appendChild(el('li', null, 'Create a private app, and turn on View Surveys and View Responses.'));
    help.appendChild(el('li', null, "Open the app's Settings and copy its Access Token."));
    tokenField.appendChild(help);

    var helpLink = el('button', 'link', 'Open the SurveyMonkey developer site');
    helpLink.type = 'button';
    helpLink.addEventListener('click', function () {
      api.openExternal(TOKEN_HELP_URL);
    });
    tokenField.appendChild(helpLink);
    container.appendChild(tokenField);

    // Surveys
    var surveyField = el('div', 'field');
    surveyField.appendChild(el('span', 'label', 'Surveys to sync'));
    surveyField.appendChild(
      el('p', 'hint', 'Only the surveys you choose are synced. Choose a test survey first if you have one.')
    );

    var find = el('button', 'ghost', ui.surveys ? 'Refresh my surveys' : 'Find my surveys');
    find.type = 'button';
    find.addEventListener('click', function () {
      findSurveys(step, find);
    });
    surveyField.appendChild(find);

    if (ui.surveyError) surveyField.appendChild(el('p', 'result bad', ui.surveyError));

    var manual = el('input');
    if (ui.surveys) {
      var list = el('ul', 'survey-list');
      ui.surveys.forEach(function (survey) {
        var item = el('li');
        var box = el('input');
        box.type = 'checkbox';
        box.id = 'survey-' + survey.id;
        box.checked = ui.selected.has(survey.id);
        box.addEventListener('change', function () {
          if (box.checked) ui.selected.add(survey.id);
          else ui.selected.delete(survey.id);
          manual.value = Array.from(ui.selected).join(', ');
        });
        var boxLabel = el('label');
        boxLabel.htmlFor = box.id;
        boxLabel.appendChild(el('span', null, survey.title));
        var meta = survey.id + (survey.responseCount === null ? '' : ' · ' + survey.responseCount + ' responses');
        boxLabel.appendChild(el('span', 'meta', meta));
        item.appendChild(box);
        item.appendChild(boxLabel);
        list.appendChild(item);
      });
      surveyField.appendChild(list);
    }

    var manualLabel = el('label', 'label', 'Or type survey IDs, separated by commas');
    manualLabel.htmlFor = 'survey-ids';
    surveyField.appendChild(manualLabel);
    manual.id = 'survey-ids';
    manual.inputMode = 'numeric';
    manual.value = Array.from(ui.selected).join(', ');
    manual.addEventListener('input', function () {
      ui.selected = new Set(
        manual.value.split(/[\s,]+/).filter(function (part) {
          return /^\d+$/.test(part);
        })
      );
      App.$$('.survey-list input[type=checkbox]').forEach(function (box) {
        box.checked = ui.selected.has(box.id.replace('survey-', ''));
      });
    });
    surveyField.appendChild(manual);
    container.appendChild(surveyField);
  }

  async function findSurveys(step, button) {
    button.disabled = true;
    button.textContent = 'Looking…';
    var result = await api.listSurveys(ui.token);
    if (result.ok) {
      ui.surveys = result.surveys;
      ui.surveyError = result.surveys.length === 0 ? 'This token cannot see any surveys.' : '';
    } else {
      ui.surveyError = result.message;
    }
    renderInputs(step);
  }

  // --- running ----------------------------------------------------------------

  async function runStepById(id) {
    var step = steps.find(function (s) {
      return s.id === id;
    });

    status[id] = 'running';
    select(current);
    App.appendOutput('');
    App.appendOutput('──── ' + step.title + ' ────');

    var result = await api.runStep(id, { token: ui.token, surveyIds: Array.from(ui.selected) });

    status[id] = result.ok ? 'done' : 'failed';
    results[id] = { ok: result.ok, message: result.message };
    if (result.ok && step.settings) ui.token = ''; // saved to the file; no need to hold it here
    setState(result.state);
    return result.ok;
  }

  function missingInputs(step) {
    if (!step.settings) return null;
    if (!ui.token && !state.hasToken) return 'Paste your SurveyMonkey access token, then press the button again.';
    if (ui.selected.size === 0) return 'Choose at least one survey to sync, then press the button again.';
    return null;
  }

  function runCurrent() {
    var step = steps[current];
    var missing = missingInputs(step);
    if (missing) {
      results[step.id] = { ok: false, message: missing };
      return select(current);
    }
    return App.whileBusy(function () {
      return runStepById(step.id);
    });
  }

  function runAll() {
    return App.whileBusy(async function () {
      for (var i = firstIncomplete(); i < steps.length; i += 1) {
        if (status[steps[i].id] === 'done') continue;
        current = i;
        select(i);
        var missing = missingInputs(steps[i]);
        if (missing) {
          results[steps[i].id] = { ok: false, message: missing };
          return select(i);
        }
        if (!(await runStepById(steps[i].id))) return;
      }
    });
  }

  async function chooseFolder() {
    setState(await api.chooseFolder());
    select(current);
  }

  async function refreshState() {
    setState(await api.state());
    select(current);
  }

  // --- start -------------------------------------------------------------------

  function init(manifest, initialState) {
    steps = manifest.steps;
    setState(initialState);
    ui.selected = new Set(state.surveyIds);
    select(firstIncomplete());

    $('#choose-folder').addEventListener('click', chooseFolder);
    $('#run-step').addEventListener('click', runCurrent);
    $('#next-step').addEventListener('click', function () {
      select(Math.min(current + 1, steps.length - 1));
    });
    $('#run-all').addEventListener('click', runAll);

    App.onBusyChange(function () {
      select(current);
    });
    App.registerView('setup', refreshState);
  }

  return {
    init: init,
    refreshState: refreshState,
    onStateChange: function (listener) {
      listeners.push(listener);
    },
  };
})();
