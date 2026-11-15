'use strict';
const { execFile } = require('child_process');

function cleanErr(s) {
  return String(s || '').replace(/#< CLIXML[\s\S]*$/m, '').trim();
}

// Executa um script PowerShell FIXO do código do app. Dados variáveis entram
// somente por variáveis de ambiente (env), nunca por concatenação de texto.
function runPS(script, opts = {}) {
  const { env = {}, timeout = 60000 } = opts;
  const wrapped = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'try {',
    script,
    '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
  ].join('\n');
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', encoded],
      { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env }, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout || '').trim(),
          stderr: cleanErr(stderr) || (error && error.killed ? 'Tempo esgotado.' : error ? error.message : ''),
        });
      }
    );
  });
}

async function runPSJson(script, opts) {
  const r = await runPS(script, opts);
  if (!r.ok) return { ...r, data: null };
  if (!r.stdout) return { ...r, data: null };
  try {
    return { ...r, data: JSON.parse(r.stdout) };
  } catch (e) {
    return { ...r, ok: false, data: null, stderr: 'Resposta inválida do PowerShell: ' + e.message };
  }
}

function runExe(file, args = [], opts = {}) {
  const { timeout = 30000, utf16 = false } = opts;
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' }, (error, stdout, stderr) => {
      const dec = (b) => {
        const buf = Buffer.isBuffer(b) ? b : Buffer.from(b || '');
        const text = utf16 ? buf.toString('utf16le').replace(/\u0000/g, '') : buf.toString('utf8');
        return text.replace(/\uFEFF/g, '').trim();
      };
      resolve({
        ok: !error,
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: dec(stdout),
        stderr: dec(stderr),
        notFound: !!(error && error.code === 'ENOENT'),
      });
    });
  });
}

module.exports = { runPS, runPSJson, runExe };
