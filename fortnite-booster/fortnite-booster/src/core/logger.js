'use strict';
const fs = require('fs');
const path = require('path');

class Logger {
  constructor(file, send) {
    this.file = file;
    this.send = send;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  log(level, msg) {
    const entry = { ts: new Date().toISOString(), level, msg: String(msg) };
    fs.appendFile(this.file, JSON.stringify(entry) + '\n', () => {});
    this.send('log', entry);
    return entry;
  }
  cmd(m) { return this.log('cmd', m); }
  out(m) { return this.log('out', m); }
  info(m) { return this.log('info', m); }
  ok(m) { return this.log('ok', m); }
  warn(m) { return this.log('warn', m); }
  error(m) { return this.log('error', m); }
  progress(id, pct, label) { this.send('progress', { id, pct, label }); }
  history(limit = 500) {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }
}
module.exports = { Logger };
