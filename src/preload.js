const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  scanNow: () => ipcRenderer.invoke('scan-now'),
  getNotionPrices: () => ipcRenderer.invoke('get-notion-prices')
});
