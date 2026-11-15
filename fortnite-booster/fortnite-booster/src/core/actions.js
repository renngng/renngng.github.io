'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { runPS, runPSJson, runExe } = require('./powershell');
const sys = require('./system');
const fps = require('./fps');

const FORTNITE_PROC = 'FortniteClient-Win64-Shipping';
const HIGH_PERF = '8c5e7fda-e8bf-4a54-9ae3-d3ee2efa0c8e';
const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITIES = ['Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High'];

// Processos que NUNCA aparecem para encerramento (sistema, segurança, launcher, o próprio app).
const PROTECTED = new Set([
  'system', 'idle', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'svchost', 'dwm',
  'explorer', 'fontdrvhost', 'sihost', 'taskhostw', 'ctfmon', 'searchhost', 'searchapp', 'startmenuexperiencehost',
  'shellexperiencehost', 'textinputhost', 'applicationframehost', 'systemsettings', 'msmpeng', 'nissrv',
  'securityhealthsystray', 'securityhealthservice', 'mpdefendercoreservice', 'smartscreen', 'taskmgr', 'lockapp',
  'runtimebroker', 'widgets', 'conhost', 'wudfhost', 'audiodg', 'electron', 'fortnite booster',
  'epicgameslauncher', 'fortniteclient-win64-shipping', 'fortnitelauncher', 'easyanticheat', 'beservice',
]);

// Únicas chaves de registro que o app pode alterar (e restaurar).
const REG_ALLOW = [
  { path: 'HKCU:\\Software\\Microsoft\\GameBar', name: 'AutoGameModeEnabled', values: [0, 1] },
  { path: 'HKCU:\\System\\GameConfigStore', name: 'GameDVR_Enabled', values: [0, 1] },
  { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR', name: 'AppCaptureEnabled', values: [0, 1] },
];

// Serviços apenas LISTADOS (nunca desativados pelo app).
const SERVICE_NOTES = {
  DiagTrack: 'Telemetria do Windows. Pode ser desativado manualmente, mas o app não faz isso.',
  SysMain: 'Superfetch/pré-carregamento. Em SSD costuma ter pouco efeito.',
  WSearch: 'Indexação de pesquisa. Usa disco/CPU durante a indexação.',
  Fax: 'Serviço de fax. Raramente usado.',
  MapsBroker: 'Mapas offline. Raramente usado.',
  RetailDemo: 'Modo demonstração de loja.',
  WMPNetworkSvc: 'Compartilhamento de mídia do Windows Media Player.',
  XblGameSave: 'Salvamento em nuvem de jogos Xbox. Necessário só para jogos Xbox/Store.',
  XboxNetApiSvc: 'Rede Xbox Live. Necessário só para jogos Xbox/Store.',
  XblAuthManager: 'Autenticação Xbox Live. Necessário só para jogos Xbox/Store.',
  TabletInputService: 'Teclado de toque/caneta. Desnecessário em PCs sem tela sensível ao toque.',
  PhoneSvc: 'Serviço de telefone.',
  lfsvc: 'Serviço de localização.',
};

// ---------- Scripts PowerShell fixos ----------
const PS = {
  admin: String.raw`([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`,
  top: String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$n = [Environment]::ProcessorCount
$ram = @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 | ForEach-Object {
  [ordered]@{ pid=$_.Id; name=$_.ProcessName; ramMB=[math]::Round($_.WorkingSet64/1MB,0) } })
$cpu = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } |
  Sort-Object PercentProcessorTime -Descending | Select-Object -First 8 | ForEach-Object {
  [ordered]@{ pid=[int]$_.IDProcess; name=$_.Name; cpu=[math]::Round($_.PercentProcessorTime/$n,1); ramMB=[math]::Round($_.WorkingSetPrivate/1MB,0) } })
ConvertTo-Json -InputObject ([ordered]@{ byRam=$ram; byCpu=$cpu }) -Compress -Depth 5`,
  userApps: String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$x = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object {
  [ordered]@{ pid=$_.Id; name=$_.ProcessName; title=$_.MainWindowTitle; ramMB=[math]::Round($_.WorkingSet64/1MB,0) } } | Sort-Object { $_.ramMB } -Descending)
ConvertTo-Json -InputObject $x -Compress -Depth 4`,
  closeApp: String.raw`
$p = Get-Process -Id ([int]$env:FB_PID)
[void]$p.CloseMainWindow()
if ($p.WaitForExit(8000)) { 'closed' } else { 'pending' }`,
  startup: String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$items = @()
$sets = @(
  @{ p='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'; a='HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'; scope='Usuário' },
  @{ p='HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'; a='HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'; scope='Máquina' }
)
foreach ($e in $sets) {
  $props = Get-ItemProperty -LiteralPath $e.p
  if ($props) {
    foreach ($n in ($props.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' })) {
      $enabled = $true
      $ap = Get-ItemProperty -LiteralPath $e.a -Name $n.Name
      if ($ap) { $b = $ap.($n.Name); if ($b -and (($b[0] -band 1) -eq 1)) { $enabled = $false } }
      $items += [ordered]@{ name=$n.Name; command=[string]$n.Value; scope=$e.scope; enabled=$enabled }
    }
  }
}
ConvertTo-Json -InputObject @($items) -Compress -Depth 4`,
  setStartup: String.raw`
$k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
if (-not (Test-Path -LiteralPath $k)) { New-Item -Path $k -Force | Out-Null }
if ($env:FB_ENABLE -eq '1') { $v = [byte[]](2,0,0,0,0,0,0,0,0,0,0,0) } else { $v = [byte[]](3,0,0,0,0,0,0,0,0,0,0,0) }
Set-ItemProperty -LiteralPath $k -Name $env:FB_NAME -Value $v -Type Binary`,
  services: String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$names = $env:FB_NAMES -split ','
$x = @(Get-Service -Name $names | Where-Object { $_.Status -eq 'Running' } | ForEach-Object {
  [ordered]@{ name=$_.Name; display=$_.DisplayName; startType=[string]$_.StartType } })
ConvertTo-Json -InputObject $x -Compress -Depth 4`,
  regGet: String.raw`
$v = (Get-ItemProperty -LiteralPath $env:FB_PATH -Name $env:FB_NAME -ErrorAction SilentlyContinue).($env:FB_NAME)
if ($null -eq $v) { 'NULL' } else { [string]$v }`,
  regSet: String.raw`
if (-not (Test-Path -LiteralPath $env:FB_PATH)) { New-Item -Path $env:FB_PATH -Force | Out-Null }
Set-ItemProperty -LiteralPath $env:FB_PATH -Name $env:FB_NAME -Value ([int]$env:FB_VALUE) -Type DWord`,
  regRemove: String.raw`Remove-ItemProperty -LiteralPath $env:FB_PATH -Name $env:FB_NAME -ErrorAction SilentlyContinue`,
  priority: String.raw`
$out = @()
foreach ($x in @(Get-Process -Name 'FortniteClient-Win64-Shipping' -ErrorAction SilentlyContinue)) {
  $out += $x.PriorityClass.ToString()
  $x.PriorityClass = $env:FB_PRIO
}
ConvertTo-Json -InputObject @($out) -Compress`,
  restorePoint: String.raw`Checkpoint-Computer -Description 'FORTNITE BOOSTER' -RestorePointType 'MODIFY_SETTINGS'`,
};

// ---------- Utilidades ----------
const fmtBytes = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : (b / 1048576).toFixed(1) + ' MB');
const trunc = (s, n = 1500) => (s.length > n ? s.slice(0, n) + '…' : s);
const isIntArray = (a) => Array.isArray(a) && a.length <= 200 && a.every((n) => Number.isInteger(n) && n > 0);

async function cleanDir(dir, { olderThanMs }) {
  let freed = 0, files = 0, skipped = 0;
  async function walk(d) {
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      try {
        if (e.isSymbolicLink()) continue; // nunca seguir links
        if (e.isDirectory()) {
          await walk(p);
          try { await fsp.rmdir(p); } catch { /* não está vazia */ }
        } else {
          const st = await fsp.stat(p);
          if (Date.now() - st.mtimeMs < olderThanMs) { skipped++; continue; }
          await fsp.unlink(p);
          freed += st.size;
          files++;
        }
      } catch { skipped++; } // arquivo em uso / sem permissão
    }
  }
  await walk(dir);
  return { freed, files, skipped };
}

function createActions({ logger, store, send, confirm, relaunchAsAdmin, toolDirs, selfPid, getMetrics, appVersion }) {
  let adminCache = null;
  let busy = null;
  let lastAnalysis = null;
  let staticCache = null;
  let watcher = null;
  let priorityApplied = false;

  // ----- execução com registro no terminal -----
  async function ps(label, script, opts = {}) {
    logger.cmd('PowerShell › ' + label);
    const r = await runPS(script, opts);
    if (r.ok) { if (r.stdout && !opts.quiet) logger.out(trunc(r.stdout)); }
    else logger.error(`${label}: ${r.stderr || 'falhou (código ' + r.code + ')'}`);
    return r;
  }
  async function psJson(label, script, opts = {}) {
    logger.cmd('PowerShell › ' + label);
    const r = await runPSJson(script, opts);
    if (!r.ok) logger.error(`${label}: ${r.stderr || 'falhou'}`);
    return r;
  }
  async function exe(label, file, args, opts = {}) {
    if (!opts.quiet) logger.cmd(`${file} ${args.join(' ')}`.trim());
    const r = await runExe(file, args, opts);
    if (!opts.quiet) {
      if (r.ok && r.stdout && !opts.noOut) logger.out(trunc(r.stdout));
      if (!r.ok) logger.error(`${label}: ${r.stderr || r.stdout || 'falhou (código ' + r.code + ')'}`);
    }
    return r;
  }
  async function withLock(name, fn) {
    if (busy) throw new Error(`Aguarde: "${busy}" ainda está em andamento.`);
    busy = name;
    try { return await fn(); } finally { busy = null; }
  }

  async function isAdmin() {
    if (adminCache !== null) return adminCache;
    const r = await runPS(PS.admin, { timeout: 15000 });
    adminCache = r.ok && r.stdout.trim().toLowerCase() === 'true';
    return adminCache;
  }
  async function getStatic() {
    if (!staticCache) staticCache = await sys.staticInfo();
    return staticCache;
  }

  // ----- energia -----
  async function activePlan() {
    const r = await exe('powercfg', 'powercfg', ['/getactivescheme'], { noOut: true });
    const m = /([0-9a-f]{8}-[0-9a-f-]{27})\s+\(([^)]*)\)/i.exec(r.stdout);
    return m ? { guid: m[1].toLowerCase(), name: m[2] } : null;
  }
  async function planExists(guid) {
    const r = await exe('powercfg', 'powercfg', ['/list'], { quiet: true });
    return r.stdout.toLowerCase().includes(guid.toLowerCase());
  }
  async function setHighPerformance(group) {
    const cur = await activePlan();
    if (!cur) throw new Error('Não foi possível ler o plano de energia atual.');
    if (cur.guid === HIGH_PERF) { logger.info('O plano Alto Desempenho já está ativo.'); return { changed: false, name: cur.name }; }
    let target = HIGH_PERF;
    let created = null;
    if (!(await planExists(HIGH_PERF))) {
      const d = await exe('powercfg', 'powercfg', ['-duplicatescheme', HIGH_PERF]);
      const m = /([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(d.stdout);
      if (!d.ok || !m) throw new Error('O plano Alto Desempenho não está disponível neste PC.');
      target = created = m[1].toLowerCase();
    }
    const s = await exe('powercfg', 'powercfg', ['/setactive', target]);
    if (!s.ok) throw new Error('powercfg /setactive falhou: ' + (s.stderr || s.stdout));
    store.add({
      type: 'powerplan', group,
      description: `Plano de energia: ${cur.name} → Alto Desempenho`,
      undo: { kind: 'powerplan', guid: cur.guid, name: cur.name, createdGuid: created },
    });
    logger.ok(`Plano de energia alterado de "${cur.name}" para Alto Desempenho.`);
    return { changed: true, name: cur.name };
  }

  // ----- registro (somente chaves permitidas) -----
  const regRule = (p, n) => REG_ALLOW.find((r) => r.path === p && r.name === n);
  async function regGet(p, n) {
    if (!regRule(p, n)) throw new Error('Chave de registro não autorizada.');
    const r = await ps(`ler ${n}`, PS.regGet, { env: { FB_PATH: p, FB_NAME: n }, quiet: true, timeout: 15000 });
    if (!r.ok) throw new Error(r.stderr);
    return r.stdout.trim() === 'NULL' ? null : parseInt(r.stdout.trim(), 10);
  }
  async function regSet(p, n, v) {
    if (!regRule(p, n) || !Number.isInteger(v) || v < 0) throw new Error('Alteração de registro não autorizada.');
    const r = await ps(`gravar ${n}=${v}`, PS.regSet, { env: { FB_PATH: p, FB_NAME: n, FB_VALUE: String(v) }, timeout: 15000 });
    if (!r.ok) throw new Error(r.stderr);
  }
  async function regRemove(p, n) {
    if (!regRule(p, n)) throw new Error('Chave de registro não autorizada.');
    const r = await ps(`remover ${n}`, PS.regRemove, { env: { FB_PATH: p, FB_NAME: n }, timeout: 15000 });
    if (!r.ok) throw new Error(r.stderr);
  }
  async function applyReg(p, n, v, group, description) {
    const rule = regRule(p, n);
    if (!rule || !rule.values.includes(v)) throw new Error('Valor não autorizado.');
    const prev = await regGet(p, n);
    if (prev === v) { logger.info(`${n} já está em ${v}.`); return false; }
    await regSet(p, n, v);
    store.add({ type: 'registry', group, description, undo: { kind: 'registry', path: p, name: n, previous: prev } });
    logger.ok(description);
    return true;
  }

  // ----- processos / apps -----
  async function listUserApps() {
    const r = await psJson('listar apps com janela', PS.userApps, { timeout: 30000 });
    const arr = Array.isArray(r.data) ? r.data : [];
    return arr.filter((a) => a && Number.isInteger(a.pid) && a.pid !== selfPid && !PROTECTED.has(String(a.name).toLowerCase()));
  }
  async function closeApps(pids) {
    if (!isIntArray(pids)) throw new Error('Lista de processos inválida.');
    if (!pids.length) return [];
    const eligible = new Map((await listUserApps()).map((a) => [a.pid, a]));
    const results = [];
    for (const pid of pids) {
      const a = eligible.get(pid);
      if (!a) { logger.warn(`PID ${pid} ignorado: não é um aplicativo de usuário elegível.`); continue; }
      const r = await ps(`fechar ${a.name} (PID ${pid})`, PS.closeApp, { env: { FB_PID: String(pid) }, timeout: 20000, quiet: true });
      if (r.ok && r.stdout.trim() === 'closed') {
        logger.ok(`${a.name} fechado.`);
        store.add({ type: 'close-app', description: `Aplicativo fechado: ${a.name}`, undo: null });
        results.push({ name: a.name, status: 'closed' });
      } else if (r.ok) {
        logger.warn(`${a.name} não fechou em 8 s (talvez esteja pedindo para salvar). Nada foi forçado.`);
        results.push({ name: a.name, status: 'pending' });
      } else results.push({ name: a.name, status: 'error' });
    }
    return results;
  }
  async function topProcesses() {
    const r = await psJson('processos que mais consomem', PS.top, { timeout: 45000 });
    return r.data || { byRam: [], byCpu: [] };
  }

  // ----- inicialização -----
  async function listStartup() {
    const r = await psJson('programas de inicialização', PS.startup, { timeout: 30000 });
    return Array.isArray(r.data) ? r.data : [];
  }
  async function setStartup(name, enabled) {
    const r = await ps(`${enabled ? 'reativar' : 'desativar'} inicialização: ${name}`, PS.setStartup, { env: { FB_NAME: name, FB_ENABLE: enabled ? '1' : '0' }, timeout: 15000 });
    if (!r.ok) throw new Error(r.stderr);
  }
  async function toggleStartup({ name, enabled }) {
    if (typeof name !== 'string' || typeof enabled !== 'boolean') throw new Error('Parâmetros inválidos.');
    const item = (await listStartup()).find((i) => i.name === name && i.scope === 'Usuário');
    if (!item) throw new Error('Só é possível alterar itens de inicialização do usuário listados pelo app.');
    if (item.enabled === enabled) return { changed: false };
    await setStartup(name, enabled);
    store.add({
      type: 'startup', description: `Inicialização com o Windows: ${name} ${enabled ? 'reativado' : 'desativado'}`,
      undo: { kind: 'startup', name, enabled: item.enabled },
    });
    logger.ok(`${name} ${enabled ? 'reativado' : 'desativado'} na inicialização.`);
    return { changed: true };
  }

  async function listServices() {
    const r = await psJson('serviços candidatos (somente leitura)', PS.services, { env: { FB_NAMES: Object.keys(SERVICE_NOTES).join(',') }, timeout: 30000 });
    return (Array.isArray(r.data) ? r.data : []).map((s) => ({ ...s, note: SERVICE_NOTES[s.name] || '' }));
  }

  // ----- limpeza -----
  function tempDirs(admin) {
    const dirs = new Set([os.tmpdir()]);
    if (process.env.LOCALAPPDATA) dirs.add(path.join(process.env.LOCALAPPDATA, 'Temp'));
    if (admin && process.env.windir) dirs.add(path.join(process.env.windir, 'Temp'));
    return [...dirs].filter((d) => /[\\/](temp|tmp)$/i.test(d) && d.length > 8 && fs.existsSync(d));
  }
  async function cleanTemp() {
    const admin = await isAdmin();
    let freed = 0, files = 0, skipped = 0;
    for (const d of tempDirs(admin)) {
      logger.cmd(`limpar arquivos com mais de 24 h em ${d}`);
      const r = await cleanDir(d, { olderThanMs: 24 * 3600 * 1000 });
      freed += r.freed; files += r.files; skipped += r.skipped;
      logger.out(`${d}: ${r.files} arquivos removidos (${fmtBytes(r.freed)}), ${r.skipped} ignorados (em uso ou recentes).`);
    }
    store.add({ type: 'cleanup', description: `Arquivos temporários: ${files} removidos (${fmtBytes(freed)})`, undo: null });
    logger.ok(`Temporários: ${fmtBytes(freed)} liberados.`);
    return { freed, files, skipped };
  }
  async function cleanShader() {
    if (await fortniteRunning()) throw new Error('Feche o Fortnite antes de limpar o cache de shaders.');
    const L = process.env.LOCALAPPDATA;
    if (!L) throw new Error('LOCALAPPDATA indisponível.');
    const candidates = [
      path.join(L, 'D3DSCache'),
      path.join(L, 'NVIDIA', 'DXCache'),
      path.join(L, 'NVIDIA', 'GLCache'),
      path.join(L, 'AMD', 'DxCache'),
      path.join(L, 'FortniteGame', 'Saved', 'PipelineCaches'),
    ].filter((d) => fs.existsSync(d));
    if (!candidates.length) { logger.info('Nenhuma pasta de cache de shaders encontrada.'); return { freed: 0, files: 0, dirs: 0 }; }
    let freed = 0, files = 0;
    for (const d of candidates) {
      logger.cmd(`limpar cache de shaders: ${d}`);
      const r = await cleanDir(d, { olderThanMs: 0 });
      freed += r.freed; files += r.files;
      logger.out(`${d}: ${r.files} arquivos (${fmtBytes(r.freed)}).`);
    }
    store.add({ type: 'cleanup', description: `Cache de shaders: ${files} arquivos (${fmtBytes(freed)}); será recriado automaticamente`, undo: null });
    logger.ok(`Cache de shaders: ${fmtBytes(freed)} liberados. O primeiro jogo depois disso pode ter travadinhas enquanto recompila.`);
    return { freed, files, dirs: candidates.length };
  }

  // ----- Fortnite -----
  async function fortniteRunning() {
    const r = await exe('tasklist', 'tasklist', ['/FI', `IMAGENAME eq ${FORTNITE_PROC}.exe`, '/FO', 'CSV', '/NH'], { quiet: true });
    return r.stdout.toLowerCase().includes(FORTNITE_PROC.toLowerCase() + '.exe');
  }
  async function launcherRunning() {
    const r = await exe('tasklist', 'tasklist', ['/FI', 'IMAGENAME eq EpicGamesLauncher.exe', '/FO', 'CSV', '/NH'], { quiet: true });
    return r.stdout.toLowerCase().includes('epicgameslauncher.exe');
  }
  async function detectFortnite() {
    const dir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
    let files;
    try { files = (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.item')); }
    catch { return { installed: false, reason: 'Manifestos do Epic Games Launcher não encontrados.' }; }
    for (const f of files) {
      try {
        const j = JSON.parse((await fsp.readFile(path.join(dir, f), 'utf8')).replace(/^\uFEFF/, ''));
        const isFn = String(j.AppName || '').toLowerCase() === 'fortnite' || String(j.DisplayName || '').toLowerCase() === 'fortnite';
        if (isFn && j.InstallLocation && fs.existsSync(j.InstallLocation)) {
          return { installed: true, location: j.InstallLocation, version: j.AppVersionString || null };
        }
      } catch { /* manifesto ilegível */ }
    }
    return { installed: false, reason: 'O Fortnite não consta nos manifestos do Epic Games Launcher.' };
  }
  async function applyPriority(group) {
    const r = await ps('prioridade Alta para o Fortnite', PS.priority, { env: { FB_PRIO: 'High' }, timeout: 15000, quiet: true });
    if (!r.ok) throw new Error(r.stderr);
    let prev = [];
    try { prev = JSON.parse(r.stdout || '[]'); } catch { /* vazio */ }
    if (!prev.length) return false;
    store.add({
      type: 'priority', group, description: `Prioridade do processo do Fortnite: ${prev[0]} → High`,
      undo: { kind: 'priority', previous: PRIORITIES.includes(prev[0]) ? prev[0] : 'Normal' },
    });
    logger.ok(`Prioridade do Fortnite elevada para Alta (era ${prev[0]}).`);
    return true;
  }
  function recommendations(a, fortnite) {
    const out = [];
    if (a) {
      for (const f of a.findings) if (f.recommendation && (f.severity === 'warn' || f.severity === 'crit' || f.severity === 'info')) out.push({ source: 'análise do seu PC', text: f.recommendation });
    } else {
      out.push({ source: 'dica', text: 'Execute ANALISAR MEU PC para receber recomendações baseadas no seu hardware.' });
    }
    out.push(
      { source: 'boas práticas', text: 'Mantenha o driver de vídeo atualizado e o Fortnite instalado em SSD.' },
      { source: 'boas práticas', text: 'Limite o FPS no jogo um pouco abaixo da taxa do monitor: a estabilidade do frametime costuma melhorar mais que o FPS máximo.' },
      { source: 'boas práticas', text: 'Em PCs mais fracos, teste o modo de renderização "Desempenho" e reduza distância de visão e sombras.' },
      { source: 'boas práticas', text: 'Em notebooks, jogue na tomada.' },
    );
    return out;
  }

  // ----- reverter -----
  async function undoChange(c) {
    const u = c.undo;
    if (!u) throw new Error('Esta alteração é irreversível (ex.: arquivos apagados).');
    if (u.kind === 'powerplan') {
      let target = u.guid;
      if (!GUID_RE.test(target)) throw new Error('GUID inválido no registro.');
      if (!(await planExists(target))) { logger.warn('O plano anterior não existe mais; voltando para Equilibrado.'); target = BALANCED; }
      const s = await exe('powercfg', 'powercfg', ['/setactive', target]);
      if (!s.ok) throw new Error('Falha ao restaurar plano de energia: ' + (s.stderr || s.stdout));
      if (u.createdGuid && GUID_RE.test(u.createdGuid)) await exe('powercfg', 'powercfg', ['/delete', u.createdGuid]);
      logger.ok(`Plano de energia restaurado: ${u.name || target}.`);
    } else if (u.kind === 'registry') {
      if (u.previous === null) await regRemove(u.path, u.name);
      else await regSet(u.path, u.name, u.previous);
      logger.ok(`Registro restaurado: ${u.name}.`);
    } else if (u.kind === 'startup') {
      await setStartup(u.name, !!u.enabled);
      logger.ok(`Inicialização restaurada: ${u.name}.`);
    } else if (u.kind === 'priority') {
      if (await fortniteRunning()) {
        const r = await ps('restaurar prioridade', PS.priority, { env: { FB_PRIO: PRIORITIES.includes(u.previous) ? u.previous : 'Normal' }, timeout: 15000, quiet: true });
        if (!r.ok) throw new Error(r.stderr);
      } else logger.info('Fortnite fechado: a prioridade já voltou ao normal sozinha.');
    } else throw new Error('Tipo de alteração desconhecido.');
    store.markReverted(c.id);
  }
  async function undoMany(list) {
    let ok = 0, fail = 0;
    for (const c of list.slice().reverse()) {
      try { await undoChange(c); ok++; } catch (e) { fail++; logger.error(`Não foi possível reverter "${c.description}": ${e.message}`); }
    }
    return { reverted: ok, failed: fail };
  }
  const pendingUndoable = (group) => store.list().filter((c) => !c.reverted && c.undo && (!group || c.group === group));

  // ----- análise -----
  async function analyze() {
    const steps = 7;
    let i = 0;
    const prog = (label) => logger.progress('analyze', Math.round((i++ / steps) * 100), label);
    logger.info('Iniciando análise real do computador...');
    prog('Lendo informações do sistema');
    const info = await getStatic();
    prog('Medindo CPU e RAM (3 s)');
    const sampler = sys.createCpuSampler();
    const cpuSamples = [];
    for (let k = 0; k < 3; k++) { await new Promise((r) => setTimeout(r, 1000)); cpuSamples.push(sampler()); }
    const cpuAvg = Math.round((cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length) * 10) / 10;
    const ram = sys.memInfo();
    prog('Lendo disco, GPU e temperaturas');
    const slow = await sys.slowMetrics();
    prog('Procurando processos pesados');
    const top = await topProcesses();
    prog('Lendo programas de inicialização');
    const startup = await listStartup();
    prog('Verificando serviços e energia');
    const services = await listServices();
    const plan = await activePlan();
    prog('Verificando configurações de jogo');
    let gameMode = null, dvr = null;
    try {
      gameMode = await regGet(REG_ALLOW[0].path, REG_ALLOW[0].name);
      dvr = await regGet(REG_ALLOW[2].path, REG_ALLOW[2].name);
    } catch { /* não crítico */ }
    const fortnite = await detectFortnite();

    const F = [];
    const add = (id, severity, title, detail, recommendation) => F.push({ id, severity, title, detail, recommendation });
    const names = (arr, key) => arr.slice(0, 3).map((p) => `${p.name} (${p[key]}${key === 'cpu' ? '%' : ' MB'})`).join(', ');

    const heavyCpu = (top.byCpu || []).filter((p) => p.cpu > 1);
    if (cpuAvg >= 85) add('cpu', 'crit', 'Gargalo de CPU', `Uso médio de ${cpuAvg}% na medição.${heavyCpu.length ? ' Maiores consumidores: ' + names(heavyCpu, 'cpu') + '.' : ''}`, 'Feche programas pesados antes de jogar (use o MODO FORTNITE).');
    else if (cpuAvg >= 65) add('cpu', 'warn', 'CPU sob carga', `Uso médio de ${cpuAvg}% com o PC em repouso aparente.`, 'Verifique os processos pesados listados abaixo.');
    else add('cpu', 'ok', 'CPU com folga', `Uso médio de ${cpuAvg}%.`);

    if (ram.percent >= 90) add('ram', 'crit', 'Gargalo de memória RAM', `${ram.percent}% em uso (${ram.usedMB} de ${ram.totalMB} MB). Maiores: ${names(top.byRam || [], 'ramMB')}.`, 'Feche navegadores e apps abertos antes de jogar.');
    else if (ram.percent >= 80) add('ram', 'warn', 'RAM quase cheia', `${ram.percent}% em uso (${ram.usedMB} de ${ram.totalMB} MB).`, 'Feche apps em segundo plano para evitar uso de arquivo de paginação.');
    else add('ram', 'ok', 'RAM com folga', `${ram.percent}% em uso (${ram.usedMB} de ${ram.totalMB} MB).`);
    if (ram.totalMB < 7500) add('ramtotal', 'warn', 'Pouca memória instalada', `${Math.round(ram.totalMB / 1024)} GB de RAM.`, 'Para Fortnite, 8 GB é o mínimo comum e 16 GB é o recomendado.');

    if (slow.gpuUsage == null) add('gpu', 'na', 'Uso de GPU indisponível', 'Nem o contador do Windows nem o nvidia-smi retornaram dados.', null);
    else if (slow.gpuUsage >= 95) add('gpu', 'info', 'GPU em uso intenso', `${slow.gpuUsage}% (fonte: ${slow.gpuSource}). Durante o jogo isso é esperado e indica limite de GPU.`, 'Se o FPS está baixo, reduza resolução e qualidade gráfica.');
    else add('gpu', 'ok', 'GPU com folga', `${slow.gpuUsage}% de uso (fonte: ${slow.gpuSource}).`);

    for (const d of slow.disks || []) {
      const pct = d.totalGB ? (d.freeGB / d.totalGB) * 100 : 100;
      if (pct < 10 || d.freeGB < 15) add('disk-' + d.id, 'crit', `Disco ${d.id} quase cheio`, `${d.freeGB} GB livres de ${d.totalGB} GB.`, `Libere espaço em ${d.id}. SSDs cheios ficam mais lentos.`);
      else if (pct < 20) add('disk-' + d.id, 'warn', `Pouco espaço em ${d.id}`, `${d.freeGB} GB livres de ${d.totalGB} GB.`, `Tente manter mais de 20% livre em ${d.id}.`);
      else add('disk-' + d.id, 'ok', `Espaço em ${d.id}`, `${d.freeGB} GB livres de ${d.totalGB} GB.`);
    }
    if ((info.physicalDisks || []).some((d) => String(d.media).toUpperCase() === 'HDD')) add('hdd', 'info', 'Há disco HDD no PC', 'HDDs aumentam o tempo de carregamento e podem causar engasgos.', 'Instale o Fortnite em um SSD, se possível.');

    const isHigh = plan && (plan.guid === HIGH_PERF || /alto desempenho|high performance|ultimate|desempenho m|desempenho superior/i.test(plan.name));
    if (plan && !isHigh) add('power', 'warn', 'Plano de energia não otimizado para jogos', `Plano atual: ${plan.name}.`, 'Ative o plano Alto Desempenho (OTIMIZAR MEU PC ou MODO FORTNITE; reversível).');
    else if (plan) add('power', 'ok', 'Plano de energia adequado', plan.name);

    const en = startup.filter((s) => s.enabled).length;
    if (en >= 10) add('startup', 'warn', 'Muitos programas iniciam com o Windows', `${en} itens ativos.`, 'Desative os que você não precisa na seção de inicialização abaixo (reversível).');
    else if (en >= 6) add('startup', 'info', 'Programas na inicialização', `${en} itens ativos.`, 'Revise a lista de inicialização abaixo.');
    else add('startup', 'ok', 'Inicialização enxuta', `${en} itens ativos.`);

    if (gameMode === 0) add('gamemode', 'info', 'Modo de Jogo do Windows desativado', 'Configuração do usuário em 0.', 'O MODO FORTNITE ativa o Modo de Jogo (reversível).');
    if (dvr === 1) add('dvr', 'info', 'Captura em segundo plano (Xbox Game Bar) ativa', 'Gravação em segundo plano pode custar desempenho.', 'O MODO FORTNITE desliga a captura em segundo plano (reversível).');

    const svcRunning = services.length;
    if (svcRunning >= 3) add('services', 'info', 'Serviços opcionais em execução', `${svcRunning} serviços da lista de candidatos estão rodando. O app não desativa nenhum.`, 'Consulte a lista abaixo e decida manualmente.');

    if (slow.cpuTempC != null && slow.cpuTempC >= 90) add('temp-cpu', 'warn', 'Temperatura alta (zona térmica ACPI)', `${slow.cpuTempC} °C.`, 'Verifique ventilação, poeira e pasta térmica.');
    if (slow.gpuTempC != null && slow.gpuTempC >= 85) add('temp-gpu', 'warn', 'Temperatura alta da GPU', `${slow.gpuTempC} °C.`, 'Verifique ventilação e curva de fans.');

    const penalty = { crit: 20, warn: 10, info: 3 };
    const score = Math.max(0, 100 - F.reduce((a, f) => a + (penalty[f.severity] || 0), 0));
    lastAnalysis = { ts: Date.now(), score, findings: F };
    logger.progress('analyze', 100, 'Análise concluída');
    logger.ok(`Análise concluída. Índice: ${score}/100 (${F.filter((f) => f.severity === 'crit' || f.severity === 'warn').length} pontos de atenção).`);
    return { score, findings: F, info, top, startup, services, disks: slow.disks, power: plan, metrics: { cpuAvg, ram, gpuUsage: slow.gpuUsage, processCount: slow.processCount }, fortnite };
  }

  // ----- integridade -----
  async function integrityQuick() {
    if (!(await isAdmin())) throw new Error('A verificação de integridade exige executar como administrador.');
    logger.info('DISM /CheckHealth: leitura rápida do repositório de componentes do Windows.');
    const r = await exe('DISM', 'DISM.exe', ['/Online', '/Cleanup-Image', '/CheckHealth'], { timeout: 180000 });
    if (r.ok) logger.ok('DISM não encontrou corrupção no repositório de componentes.');
    else logger.error('DISM retornou código ' + r.code + '. Veja a saída acima.');
    return { ok: r.ok, code: r.code };
  }
  async function integritySfc() {
    if (!(await isAdmin())) throw new Error('O SFC exige executar como administrador.');
    logger.info('sfc /verifyonly: somente verifica, não altera nada. Pode levar vários minutos.');
    const r = await exe('SFC', 'sfc.exe', ['/verifyonly'], { timeout: 1800000, utf16: true });
    if (r.ok) logger.ok('SFC não encontrou violações de integridade.');
    else logger.warn('SFC reportou problemas ou não concluiu (código ' + r.code + '). Para corrigir, execute "sfc /scannow" em um terminal de administrador.');
    return { ok: r.ok, code: r.code };
  }
  async function createRestorePoint() {
    if (!(await isAdmin())) throw new Error('Criar ponto de restauração exige executar como administrador.');
    if (!(await confirm('Criar um ponto de restauração do Windows agora?', 'O Windows pode limitar a criação a um ponto a cada 24 horas e exige que a Proteção do Sistema esteja ativada.'))) throw new Error('Cancelado pelo usuário.');
    const r = await ps('Checkpoint-Computer', PS.restorePoint, { timeout: 180000 });
    if (!r.ok) throw new Error('Não foi possível criar o ponto de restauração: ' + r.stderr);
    store.add({ type: 'restore-point', description: 'Ponto de restauração criado', undo: null });
    logger.ok('Ponto de restauração criado.');
    return true;
  }

  // ----- otimização -----
  async function optimize(params) {
    const o = { cleanShader: !!params.cleanShader, restorePoint: !!params.restorePoint, integrity: !!params.integrity };
    const admin = await isAdmin();
    const planned = [
      'Limpar arquivos temporários com mais de 24 h (irreversível)',
      'Ativar o plano de energia Alto Desempenho (reversível)',
      o.cleanShader ? 'Limpar cache de shaders (irreversível; será recriado)' : null,
      o.restorePoint ? 'Criar ponto de restauração' : null,
      o.integrity ? 'Verificar integridade com DISM /CheckHealth' : null,
      'Analisar processos, inicialização e serviços (somente leitura)',
    ].filter(Boolean);
    if (!(await confirm('Iniciar a otimização do PC?', planned.map((s) => '• ' + s).join('\n') + (admin ? '' : '\n\nObservação: sem administrador, alguns passos serão ignorados.')))) throw new Error('Cancelado pelo usuário.');

    const steps = [];
    const total = planned.length;
    let n = 0;
    const step = async (name, fn) => {
      logger.progress('optimize', Math.round((n++ / total) * 100), name);
      logger.info('▶ ' + name);
      try {
        const r = await fn();
        steps.push({ name, status: r && r.skip ? 'skip' : 'ok', detail: (r && (r.skip || r.detail)) || '' });
      } catch (e) {
        logger.error(`${name}: ${e.message}`);
        steps.push({ name, status: 'error', detail: e.message });
      }
    };
    if (o.restorePoint) await step('Ponto de restauração', async () => {
      if (!admin) return { skip: 'Requer administrador.' };
      const r = await ps('Checkpoint-Computer', PS.restorePoint, { timeout: 180000 });
      if (!r.ok) throw new Error(r.stderr);
      store.add({ type: 'restore-point', description: 'Ponto de restauração criado', undo: null });
      return { detail: 'Criado.' };
    });
    await step('Arquivos temporários', async () => { const r = await cleanTemp(); return { detail: `${fmtBytes(r.freed)} liberados (${r.files} arquivos).` }; });
    if (o.cleanShader) await step('Cache de shaders', async () => { const r = await cleanShader(); return { detail: `${fmtBytes(r.freed)} liberados.` }; });
    await step('Plano de energia', async () => { const r = await setHighPerformance('optimize'); return { detail: r.changed ? `Alterado (anterior: ${r.name}).` : 'Já estava em Alto Desempenho.' }; });
    if (o.integrity) await step('Integridade do sistema (DISM)', async () => {
      if (!admin) return { skip: 'Requer administrador.' };
      const r = await integrityQuick();
      return { detail: r.ok ? 'Sem corrupção detectada.' : 'Verifique o terminal.' };
    });
    await step('Análise de processos, inicialização e serviços', async () => {
      const a = await analyze();
      const attention = a.findings.filter((f) => f.severity === 'crit' || f.severity === 'warn').length;
      return { detail: `Índice ${a.score}/100, ${attention} pontos de atenção. Veja a aba Diagnóstico.` };
    });
    logger.progress('optimize', 100, 'Otimização concluída');
    logger.ok('Otimização concluída.');
    return { steps, score: lastAnalysis ? lastAnalysis.score : null };
  }

  // ----- modo Fortnite -----
  function startWatcher() {
    if (watcher) return;
    priorityApplied = false;
    watcher = setInterval(async () => {
      try {
        const running = await fortniteRunning();
        if (running && !priorityApplied) { priorityApplied = true; await applyPriority('fortnite'); }
        if (!running) priorityApplied = false;
      } catch { /* tenta de novo no próximo ciclo */ }
    }, 5000);
  }
  function stopWatcher() { if (watcher) clearInterval(watcher); watcher = null; }

  async function fortniteStatus() {
    const [inst, running, launcher] = await Promise.all([detectFortnite(), fortniteRunning(), launcherRunning()]);
    const active = !!store.getMeta('fortniteActive');
    if (active && !watcher) startWatcher();
    return { ...inst, running, launcherRunning: launcher, active, recommendations: recommendations(lastAnalysis, inst), fps: fps.status(toolDirs) };
  }
  async function fortniteActivate(params) {
    const closePids = params.closePids || [];
    if (!isIntArray(closePids)) throw new Error('Lista de processos inválida.');
    const inst = await detectFortnite();
    const running = await fortniteRunning();
    const lines = [
      closePids.length ? `Fechar ${closePids.length} aplicativo(s) selecionado(s) (pedido educado de fechamento; nada é forçado).` : 'Nenhum aplicativo será fechado.',
      'Ativar o plano de energia Alto Desempenho.',
      'Ativar o Modo de Jogo do Windows e desligar a captura em segundo plano da Xbox Game Bar.',
      'Elevar a prioridade do Fortnite para Alta (nunca Tempo real).',
      'Tudo isso é revertido ao desativar o modo.',
    ];
    if (!(await confirm('Ativar o MODO FORTNITE?', lines.map((s) => '• ' + s).join('\n')))) throw new Error('Cancelado pelo usuário.');
    const steps = [];
    let n = 0;
    const total = 5;
    const step = async (name, fn) => {
      logger.progress('fortnite', Math.round((n++ / total) * 100), name);
      logger.info('▶ ' + name);
      try { const d = await fn(); steps.push({ name, status: d && d.skip ? 'skip' : 'ok', detail: (d && (d.skip || d.detail)) || '' }); }
      catch (e) { logger.error(`${name}: ${e.message}`); steps.push({ name, status: 'error', detail: e.message }); }
    };
    await step('Instalação do Fortnite', async () => {
      if (!inst.installed) { logger.warn(inst.reason); return { skip: inst.reason }; }
      logger.ok(`Fortnite encontrado em ${inst.location}.`);
      return { detail: inst.location };
    });
    await step('Aplicativos em segundo plano', async () => {
      if (!closePids.length) return { skip: 'Nenhum selecionado.' };
      const r = await closeApps(closePids);
      return { detail: `${r.filter((x) => x.status === 'closed').length} fechado(s), ${r.filter((x) => x.status === 'pending').length} pendente(s).` };
    });
    await step('Plano de energia', async () => { const r = await setHighPerformance('fortnite'); return { detail: r.changed ? 'Alto Desempenho ativo.' : 'Já estava ativo.' }; });
    await step('Configurações de jogo do Windows', async () => {
      const a = await applyReg(REG_ALLOW[0].path, REG_ALLOW[0].name, 1, 'fortnite', 'Modo de Jogo do Windows ativado');
      const b = await applyReg(REG_ALLOW[1].path, REG_ALLOW[1].name, 0, 'fortnite', 'Game DVR desativado');
      const c = await applyReg(REG_ALLOW[2].path, REG_ALLOW[2].name, 0, 'fortnite', 'Captura em segundo plano desativada');
      return { detail: a || b || c ? 'Aplicadas.' : 'Já estavam aplicadas.' };
    });
    await step('Prioridade do processo', async () => {
      startWatcher();
      if (!running) return { skip: 'Fortnite fechado: a prioridade será aplicada assim que o jogo abrir (o app monitora enquanto o modo estiver ativo).' };
      priorityApplied = true;
      const ok = await applyPriority('fortnite');
      return { detail: ok ? 'Prioridade Alta aplicada.' : 'Processo não encontrado.' };
    });
    store.setMeta('fortniteActive', true);
    logger.progress('fortnite', 100, 'Modo Fortnite ativo');
    logger.ok('MODO FORTNITE ativo.');
    send('state', { fortniteActive: true });
    return { steps, recommendations: recommendations(lastAnalysis, inst) };
  }
  async function fortniteDeactivate() {
    stopWatcher();
    const pending = pendingUndoable('fortnite');
    const r = await undoMany(pending);
    store.setMeta('fortniteActive', false);
    logger.ok(`MODO FORTNITE desativado. ${r.reverted} alteração(ões) revertida(s)${r.failed ? `, ${r.failed} falharam` : ''}.`);
    send('state', { fortniteActive: false });
    return r;
  }

  // ----- terminal autorizado -----
  const fmtRow = (cols) => cols.join('  ');
  const COMMANDS = {
    help: { desc: 'Lista os comandos autorizados', run: async () => { for (const [k, v] of Object.entries(COMMANDS)) logger.info(k.padEnd(16) + v.desc); } },
    status: { desc: 'Resumo de CPU, RAM, disco e processos', run: async () => {
      const m = getMetrics();
      const f = (v, u = '') => (v == null ? 'indisponível' : v + u);
      logger.out(`CPU ${f(m.cpu, '%')} | RAM ${f(m.ram && m.ram.percent, '%')} | GPU ${f(m.gpuUsage, '%')} | processos ${f(m.processCount)}`);
      for (const d of m.disks || []) logger.out(`Disco ${d.id}: ${d.freeGB} GB livres de ${d.totalGB} GB`);
    } },
    admin: { desc: 'Mostra se está executando como administrador', run: async () => logger.out((await isAdmin()) ? 'Executando como administrador.' : 'Sem privilégios de administrador.') },
    analyze: { desc: 'Executa a análise completa do PC', run: () => withLock('Análise', analyze) },
    optimize: { desc: 'Executa a otimização padrão (pede confirmação)', run: () => withLock('Otimização', () => optimize({})) },
    processes: { desc: 'Lista os processos que mais consomem', run: async () => {
      const t = await topProcesses();
      logger.out('Por CPU:\n' + (t.byCpu || []).map((p) => fmtRow([String(p.cpu).padStart(5) + '%', String(p.ramMB).padStart(6) + ' MB', p.name])).join('\n'));
      logger.out('Por RAM:\n' + (t.byRam || []).map((p) => fmtRow([String(p.ramMB).padStart(6) + ' MB', p.name])).join('\n'));
    } },
    startup: { desc: 'Lista programas que iniciam com o Windows', run: async () => {
      const s = await listStartup();
      logger.out(s.length ? s.map((i) => `${i.enabled ? '[ativo]  ' : '[inativo]'} ${i.scope.padEnd(8)} ${i.name}`).join('\n') : 'Nenhum item encontrado.');
    } },
    services: { desc: 'Lista serviços opcionais em execução (só leitura)', run: async () => {
      const s = await listServices();
      logger.out(s.length ? s.map((i) => `${i.name} (${i.startType}) - ${i.note}`).join('\n') : 'Nenhum serviço da lista está em execução.');
    } },
    disk: { desc: 'Espaço livre nos discos', run: async () => {
      const s = await sys.slowMetrics();
      logger.out((s.disks || []).map((d) => `${d.id} ${d.freeGB} GB livres de ${d.totalGB} GB`).join('\n') || 'Sem dados.');
    } },
    power: { desc: 'Plano de energia ativo', run: async () => { const p = await activePlan(); logger.out(p ? `${p.name} (${p.guid})` : 'Indisponível.'); } },
    integrity: { desc: 'DISM /CheckHealth (administrador)', run: () => withLock('Integridade', integrityQuick) },
    'fortnite status': { desc: 'Instalação e estado do Fortnite', run: async () => {
      const s = await fortniteStatus();
      logger.out(`Instalado: ${s.installed ? s.location : 'não (' + s.reason + ')'} | aberto: ${s.running ? 'sim' : 'não'} | modo: ${s.active ? 'ativo' : 'inativo'}`);
    } },
    'fortnite on': { desc: 'Ativa o MODO FORTNITE (sem fechar apps)', run: () => withLock('Modo Fortnite', () => fortniteActivate({})) },
    'fortnite off': { desc: 'Desativa o MODO FORTNITE e reverte', run: () => withLock('Modo Fortnite', fortniteDeactivate) },
    'restore list': { desc: 'Alterações que podem ser revertidas', run: async () => {
      const p = pendingUndoable();
      logger.out(p.length ? p.map((c) => `${c.id}  ${c.description}`).join('\n') : 'Nada a reverter.');
    } },
    'restore all': { desc: 'Reverte tudo que o app alterou (confirma antes)', run: () => restoreAll() },
    history: { desc: 'Mostra as últimas operações registradas', run: async () => {
      for (const c of store.list().slice(-15)) logger.out(`${c.ts.slice(0, 19).replace('T', ' ')}  ${c.reverted ? '[revertido] ' : ''}${c.description}`);
    } },
    clear: { desc: 'Limpa a tela do terminal', run: async () => send('state', { clearTerminal: true }) },
    version: { desc: 'Versão do app', run: async () => logger.out('FORTNITE BOOSTER ' + appVersion) },
  };
  async function terminalExec({ line }) {
    if (typeof line !== 'string' || !/^[a-zA-Z ]{1,32}$/.test(line.trim())) { logger.warn('Comando não autorizado. Digite "help".'); return false; }
    const key = line.trim().toLowerCase().replace(/\s+/g, ' ');
    logger.cmd('› ' + key);
    const c = COMMANDS[key];
    if (!c) { logger.warn(`Comando não autorizado: "${key}". Digite "help".`); return false; }
    await c.run();
    return true;
  }

  async function restoreAll() {
    const pending = pendingUndoable();
    if (!pending.length) { logger.info('Nada a reverter.'); return { reverted: 0, failed: 0 }; }
    if (!(await confirm('Reverter todas as alterações feitas pelo app?', pending.map((c) => '• ' + c.description).join('\n')))) throw new Error('Cancelado pelo usuário.');
    return withLock('Restauração', async () => {
      const r = await undoMany(pending);
      if (store.getMeta('fortniteActive') && !pendingUndoable('fortnite').length) { stopWatcher(); store.setMeta('fortniteActive', false); send('state', { fortniteActive: false }); }
      logger.ok(`Restauração: ${r.reverted} revertida(s), ${r.failed} falha(s).`);
      return r;
    });
  }

  // ----- tabela de ações autorizadas (única superfície exposta ao renderer) -----
  const HANDLERS = {
    'system.info': async () => ({ static: await getStatic(), admin: await isAdmin(), version: appVersion }),
    'system.metrics': async () => getMetrics(),
    'admin.relaunch': async () => {
      if (await isAdmin()) return { already: true };
      if (!(await confirm('Reiniciar o app como administrador?', 'O Windows pedirá sua autorização (UAC). Alguns recursos, como ponto de restauração, DISM/SFC e PresentMon, exigem isso.'))) throw new Error('Cancelado pelo usuário.');
      return relaunchAsAdmin();
    },
    'analyze.run': () => withLock('Análise', analyze),
    'optimize.run': (p) => withLock('Otimização', () => optimize(p)),
    'processes.userApps': () => listUserApps(),
    'startup.list': () => listStartup(),
    'startup.set': (p) => withLock('Inicialização', () => toggleStartup(p)),
    'services.list': () => listServices(),
    'integrity.quick': () => withLock('Integridade', integrityQuick),
    'integrity.sfc': () => withLock('Integridade', integritySfc),
    'restorepoint.create': () => withLock('Ponto de restauração', createRestorePoint),
    'fortnite.status': () => fortniteStatus(),
    'fortnite.activate': (p) => withLock('Modo Fortnite', () => fortniteActivate(p)),
    'fortnite.deactivate': () => withLock('Modo Fortnite', fortniteDeactivate),
    'restore.list': async () => store.list().slice().reverse().slice(0, 300),
    'restore.undo': async (p) => {
      const c = store.get(String(p.id));
      if (!c || c.reverted) throw new Error('Alteração não encontrada ou já revertida.');
      if (!(await confirm('Reverter esta alteração?', c.description))) throw new Error('Cancelado pelo usuário.');
      return withLock('Restauração', async () => {
        await undoChange(c);
        if (c.group === 'fortnite' && !pendingUndoable('fortnite').length) { stopWatcher(); store.setMeta('fortniteActive', false); send('state', { fortniteActive: false }); }
        return true;
      });
    },
    'restore.undoAll': () => restoreAll(),
    'history.get': async () => logger.history(500),
    'terminal.exec': (p) => terminalExec(p),
    'terminal.commands': async () => Object.entries(COMMANDS).map(([k, v]) => ({ name: k, desc: v.desc })),
    'fps.status': async () => fps.status(toolDirs),
    'fps.start': async () => fps.start({ dirs: toolDirs, processName: FORTNITE_PROC + '.exe', emit: send, log: logger }),
    'fps.stop': async () => fps.stop(),
  };

  async function run(action, params) {
    const h = Object.prototype.hasOwnProperty.call(HANDLERS, action) ? HANDLERS[action] : null;
    if (!h) throw new Error('Ação não autorizada: ' + action);
    return h(params || {});
  }
  return { run };
}

module.exports = { createActions };
