'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const { Logger } = require('./src/core/logger');
const { Store } = require('./src/core/store');
const { runPS } = require('./src/core/powershell');
const sys = require('./src/core/system');
const { createActions } = require('./src/core/actions');

let win = null;
let latest = {};

const send = (channel, data) => {
  if (win && !win.isDestroyed()) win.webContents.send('fb:' + channel, data);
};

function confirm(message, detail) {
  return dialog
    .showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancelar', 'Confirmar'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'FORTNITE BOOSTER',
      message,
      detail,
    })
    .then((r) => r.response === 1);
}

async function relaunchAsAdmin() {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const args = app.isPackaged ? '' : '"' + app.getAppPath() + '"';
  app.releaseSingleInstanceLock();
  const script = String.raw`
    if ($env:FB_ARGS) { Start-Process -FilePath $env:FB_EXE -ArgumentList $env:FB_ARGS -Verb RunAs }
    else { Start-Process -FilePath $env:FB_EXE -Verb RunAs }`;
  const r = await runPS(script, { env: { FB_EXE: exe, FB_ARGS: args }, timeout: 120000 });
  if (!r.ok) {
    app.requestSingleInstanceLock();
    throw new Error('Reinício como administrador cancelado ou negado. ' + r.stderr);
  }
  setTimeout(() => app.quit(), 300);
  return true;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#07090c',
    title: 'FORTNITE BOOSTER',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    if (process.platform !== 'win32') {
      dialog.showErrorBox('FORTNITE BOOSTER', 'Este aplicativo funciona apenas no Windows 10 ou 11.');
      app.quit();
      return;
    }
    Menu.setApplicationMenu(null);
    const userData = app.getPath('userData');
    const logger = new Logger(path.join(userData, 'historico.jsonl'), send);
    const store = new Store(path.join(userData, 'estado.json'));
    const toolDirs = [
      path.join(userData, 'tools'),
      path.join(process.resourcesPath || '', 'tools'),
      path.join(__dirname, 'tools'),
    ];
    const actions = createActions({
      logger, store, send, confirm, relaunchAsAdmin, toolDirs,
      selfPid: process.pid,
      getMetrics: () => latest,
      appVersion: app.getVersion(),
    });

    ipcMain.handle('fb:invoke', async (event, action, params) => {
      const fromUs = win && event.sender === win.webContents && String(event.senderFrame.url).startsWith('file://');
      if (!fromUs) return { ok: false, error: 'Origem não autorizada.' };
      try {
        return { ok: true, data: await actions.run(String(action), params && typeof params === 'object' ? params : {}) };
      } catch (err) {
        logger.error(err.message);
        return { ok: false, error: err.message };
      }
    });

    createWindow();

    // Telemetria leve: CPU/RAM a cada 2 s; contadores mais caros a cada 10 s.
    const cpuSampler = sys.createCpuSampler();
    let slowBusy = false;
    let lastSlow = 0;
    setInterval(() => {
      if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return;
      latest = { ...latest, cpu: cpuSampler(), ram: sys.memInfo(), ts: Date.now() };
      if (!slowBusy && Date.now() - lastSlow > 10000) {
        slowBusy = true;
        lastSlow = Date.now();
        sys.slowMetrics().then((s) => { latest = { ...latest, ...s }; }).finally(() => { slowBusy = false; });
      }
      send('metrics', latest);
    }, 2000);
  });

  app.on('window-all-closed', () => app.quit());
}
