/*
 * Shared helpers for the app's screens: element creation, the output panel,
 * screen switching, and one "busy" flag so two screens can't start commands
 * at the same time. The page never runs commands itself; it asks the main
 * process through window.setup.
 */

window.App = (function () {
  'use strict';

  var api = window.setup;
  var MAX_OUTPUT_LINES = 2000;
  var outputLines = [];
  var viewHandlers = {};
  var busyListeners = [];
  var busy = false;

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setResult(node, result) {
    node.textContent = result ? result.message || '' : '';
    node.className = 'result' + (result ? (result.ok ? ' ok' : ' bad') : '');
  }

  function formatDate(iso) {
    if (!iso) return 'Never';
    var date = new Date(iso);
    return isNaN(date.getTime()) ? iso : date.toLocaleString();
  }

  function copyButton(getText, label) {
    var button = el('button', 'ghost small', label || 'Copy');
    button.type = 'button';
    button.addEventListener('click', async function () {
      var ok = await api.copy(typeof getText === 'function' ? getText() : getText);
      var original = button.textContent;
      button.textContent = ok ? 'Copied' : 'Could not copy';
      setTimeout(function () {
        button.textContent = original;
      }, 1500);
    });
    return button;
  }

  /** Adds a banner without removing the ones already there. */
  function addBanner(container, kind, message, actionLabel, onAction, detail) {
    if (!message) return;
    var box = el('div', 'banner ' + kind);
    var text = el('div');
    text.appendChild(el('span', null, message));
    if (detail) text.appendChild(el('span', 'meta', detail));
    box.appendChild(text);
    if (actionLabel) {
      var button = el('button', 'primary small', actionLabel);
      button.type = 'button';
      button.disabled = isBusy();
      button.addEventListener('click', onAction);
      box.appendChild(button);
    }
    container.appendChild(box);
  }

  function banner(container, kind, message, actionLabel, onAction) {
    clear(container);
    addBanner(container, kind, message, actionLabel, onAction);
  }

  // --- output -------------------------------------------------------------------

  function appendOutput(line) {
    outputLines.push(line);
    if (outputLines.length > MAX_OUTPUT_LINES) outputLines.splice(0, outputLines.length - MAX_OUTPUT_LINES);
    var pane = $('#output');
    var atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
    pane.textContent = outputLines.join('\n');
    if (atBottom) pane.scrollTop = pane.scrollHeight;
  }

  function clearOutput() {
    outputLines = [];
    $('#output').textContent = '';
  }

  // --- service chips --------------------------------------------------------------

  function setChips(running) {
    setChip('#svc-azurite', 'Storage emulator', running.azurite);
    setChip('#svc-function', 'Connector', running.function);
  }

  function setChip(selector, name, on) {
    var chip = $(selector);
    chip.textContent = name + ': ' + (on ? 'running' : 'stopped');
    chip.classList.toggle('on', Boolean(on));
  }

  // --- screens ----------------------------------------------------------------------

  function registerView(name, onShow) {
    viewHandlers[name] = onShow;
  }

  function currentView() {
    var tab = $('[data-view][aria-selected="true"]');
    return tab ? tab.dataset.view : 'setup';
  }

  function showView(name) {
    $$('.view').forEach(function (view) {
      view.hidden = view.id !== 'view-' + name;
    });
    $$('[data-view]').forEach(function (tab) {
      tab.setAttribute('aria-selected', String(tab.dataset.view === name));
    });
    if (viewHandlers[name]) viewHandlers[name]();
  }

  // --- busy -------------------------------------------------------------------------

  function isBusy() {
    return busy;
  }

  function onBusyChange(listener) {
    busyListeners.push(listener);
  }

  /** Runs a task that starts commands, with every screen's buttons disabled meanwhile. */
  async function whileBusy(task) {
    if (busy) return { ok: false, message: 'Something else is still running. Wait for it to finish.' };
    busy = true;
    busyListeners.forEach(function (listener) {
      listener(true);
    });
    try {
      return await task();
    } finally {
      busy = false;
      busyListeners.forEach(function (listener) {
        listener(false);
      });
    }
  }

  return {
    api: api,
    $: $,
    $$: $$,
    el: el,
    clear: clear,
    setResult: setResult,
    formatDate: formatDate,
    copyButton: copyButton,
    banner: banner,
    addBanner: addBanner,
    appendOutput: appendOutput,
    clearOutput: clearOutput,
    setChips: setChips,
    registerView: registerView,
    currentView: currentView,
    showView: showView,
    isBusy: isBusy,
    onBusyChange: onBusyChange,
    whileBusy: whileBusy,
  };
})();
