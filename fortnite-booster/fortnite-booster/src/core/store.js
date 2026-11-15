'use strict';
const fs = require('fs');
const path = require('path');

// Registro persistente de alterações. Cada alteração reversível carrega
// o "undo" necessário para desfazê-la de verdade.
class Store {
  constructor(file) {
    this.file = file;
    this.data = { changes: [], meta: {} };
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data.changes = Array.isArray(d.changes) ? d.changes : [];
      this.data.meta = d.meta && typeof d.meta === 'object' ? d.meta : {};
    } catch { /* primeiro uso */ }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  add(change) {
    const rec = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: new Date().toISOString(),
      reverted: false,
      undo: null,
      ...change,
    };
    this.data.changes.push(rec);
    this.save();
    return rec;
  }
  list() { return this.data.changes.slice(); }
  get(id) { return this.data.changes.find((c) => c.id === id); }
  markReverted(id) {
    const c = this.get(id);
    if (c) { c.reverted = true; c.revertedAt = new Date().toISOString(); this.save(); }
  }
  setMeta(k, v) { this.data.meta[k] = v; this.save(); }
  getMeta(k) { return this.data.meta[k]; }
}
module.exports = { Store };
