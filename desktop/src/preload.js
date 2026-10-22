/**
 * The only bridge between the page and the main process. The page can ask
 * for a step or an action by id, but it cannot run arbitrary commands.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  // Setup steps
  manifest: () => ipcRenderer.invoke('setup:manifest'),
  state: () => ipcRenderer.invoke('setup:state'),
  chooseFolder: () => ipcRenderer.invoke('setup:choose-folder'),
  listSurveys: (token) => ipcRenderer.invoke('setup:list-surveys', token),
  runStep: (id, inputs) => ipcRenderer.invoke('setup:run-step', id, inputs),

  // Data
  overview: () => ipcRenderer.invoke('data:overview'),
  startConnector: () => ipcRenderer.invoke('data:start-connector'),
  updateConnector: () => ipcRenderer.invoke('data:update-connector'),
  sync: (surveyId) => ipcRenderer.invoke('data:sync', surveyId),
  exportCsv: (surveyIds) => ipcRenderer.invoke('data:export', surveyIds),
  chooseExportFolder: () => ipcRenderer.invoke('data:choose-export-folder'),
  openFolder: (which) => ipcRenderer.invoke('data:open-folder', which),
  setOption: (name, value) => ipcRenderer.invoke('data:set-option', name, value),
  onDataChanged: (callback) => ipcRenderer.on('data:changed', () => callback()),

  // Power BI
  catalog: () => ipcRenderer.invoke('pbi:catalog'),
  query: (options) => ipcRenderer.invoke('pbi:query', options),
  preview: (options) => ipcRenderer.invoke('pbi:preview', options),

  // General
  copy: (text) => ipcRenderer.invoke('app:copy', text),
  openExternal: (url) => ipcRenderer.invoke('setup:open-external', url),
  onOutput: (callback) => ipcRenderer.on('setup:output', (_event, line) => callback(line)),
  ready: (report) => ipcRenderer.send('setup:renderer-ready', report),
});
