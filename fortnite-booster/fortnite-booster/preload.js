'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set(['log', 'progress', 'metrics', 'fps', 'state']);

contextBridge.exposeInMainWorld('fb', {
  // Única porta de entrada: o main valida a ação contra uma lista fechada.
  invoke: (action, params) => ipcRenderer.invoke('fb:invoke', String(action), params || {}),
  on: (channel, callback) => {
    if (!CHANNELS.has(channel)) return () => {};
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('fb:' + channel, listener);
    return () => ipcRenderer.removeListener('fb:' + channel, listener);
  },
});
