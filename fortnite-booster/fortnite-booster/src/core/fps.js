'use strict';
// Telemetria de FPS real via PresentMon (Intel, open source). Sem a ferramenta
// o FPS fica "indisponível" - nenhum valor é inventado.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let child = null;
let timer = null;
let frames = []; // { t, ms }
let running = false;

function findTool(dirs) {
  for (const d of dirs) {
    try {
      const f = fs.readdirSync(d).find((n) => /^presentmon.*\.exe$/i.test(n));
      if (f) return path.join(d, f);
    } catch { /* pasta inexistente */ }
  }
  return null;
}

function status(dirs) {
  const tool = findTool(dirs);
  return { available: !!tool, tool, running };
}

function launch(tool, dash, processName, onLine) {
  const args = [`${dash}process_name`, processName, `${dash}output_stdout`, `${dash}stop_existing_session`];
  const c = spawn(tool, args, { windowsHide: true });
  let buf = '';
  c.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
    }
  });
  let errText = '';
  c.stderr.on('data', (d) => { errText += d.toString('utf8'); });
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve({ c, ok: true }); } }, 2500);
    c.once('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(t); resolve({ c, ok: false, err: errText.trim() || `código ${code}` }); }
    });
    c.once('error', (e) => { if (!settled) { settled = true; clearTimeout(t); resolve({ c, ok: false, err: e.message }); } });
  });
}

async function start({ dirs, processName, emit, log }) {
  if (running) return { running: true };
  const tool = findTool(dirs);
  if (!tool) throw new Error('PresentMon não encontrado. Coloque PresentMon*.exe na pasta "tools" (veja o README).');
  let col = -1;
  let header = null;
  frames = [];
  const onLine = (line) => {
    if (!line) return;
    const cells = line.split(',');
    if (!header) {
      header = cells.map((c) => c.trim().toLowerCase());
      col = header.indexOf('frametime');
      if (col < 0) col = header.indexOf('msbetweenpresents');
      return;
    }
    if (col < 0) return;
    const ms = parseFloat(cells[col]);
    if (Number.isFinite(ms) && ms > 0) frames.push({ t: Date.now(), ms });
  };
  log.cmd(`${path.basename(tool)} process_name ${processName} (stdout CSV)`);
  let r = await launch(tool, '--', processName, onLine);
  if (!r.ok) {
    header = null;
    log.warn('PresentMon recusou a sintaxe 2.x; tentando sintaxe 1.x...');
    r = await launch(tool, '-', processName, onLine);
  }
  if (!r.ok) throw new Error('PresentMon não iniciou: ' + r.err + ' (ele costuma exigir administrador).');
  child = r.c;
  running = true;
  child.once('exit', () => { running = false; clearInterval(timer); emit('fps', { running: false }); });
  timer = setInterval(() => {
    const now = Date.now();
    frames = frames.filter((f) => now - f.t <= 10000);
    const last2 = frames.filter((f) => now - f.t <= 2000);
    if (!last2.length) { emit('fps', { running: true, fps: null, waiting: true }); return; }
    const avgMs = last2.reduce((a, f) => a + f.ms, 0) / last2.length;
    const sorted = frames.map((f) => f.ms).sort((a, b) => a - b);
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
    emit('fps', { running: true, fps: Math.round(1000 / avgMs), low1: Math.round(1000 / p99), frameMs: Math.round(avgMs * 10) / 10, samples: frames.length });
  }, 1000);
  return { running: true, tool };
}

function stop() {
  if (child) { try { child.kill(); } catch { /* já encerrou */ } }
  clearInterval(timer);
  running = false;
  child = null;
  return { running: false };
}

module.exports = { status, start, stop };
