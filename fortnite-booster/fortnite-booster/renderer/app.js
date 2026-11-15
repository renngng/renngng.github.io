(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  // Cria elementos sem innerHTML: nomes de processos nunca viram HTML.
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), kind === 'error' ? 7000 : 3500);
  }

  async function call(action, params) {
    const r = await window.fb.invoke(action, params || {});
    if (!r.ok) throw new Error(r.error || 'Falha desconhecida.');
    return r.data;
  }

  // Executa uma ação de botão: desativa, trata erro e cancelamento.
  async function run(btns, fn) {
    const list = [].concat(btns);
    list.forEach((b) => (b.disabled = true));
    try { return await fn(); }
    catch (e) {
      if (e.message === 'Cancelado pelo usuário.') toast('Cancelado.');
      else toast(e.message, 'error');
      return null;
    } finally { list.forEach((b) => (b.disabled = false)); }
  }

  const na = (el, text) => { el.textContent = text || 'indisponível'; el.classList.add('na'); };
  const val = (el, text) => { el.textContent = text; el.classList.remove('na'); };
  const level = (p) => (p >= 90 ? 'crit' : p >= 75 ? 'warn' : '');
  function setBar(id, p) {
    const b = $(id);
    if (p == null) { b.style.width = '0%'; b.className = ''; return; }
    b.style.width = Math.max(0, Math.min(100, p)) + '%';
    b.className = level(p);
  }

  // ---------- navegação ----------
  const hooks = {
    fortnite: () => refreshFortnite(),
    restore: () => loadChanges(),
    performance: () => refreshFps(),
    terminal: () => setTimeout(() => $('#termIn').focus(), 50),
  };
  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-btn');
    if (!b) return;
    $$('.nav-btn').forEach((x) => x.classList.toggle('active', x === b));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + b.dataset.view));
    if (hooks[b.dataset.view]) hooks[b.dataset.view]();
  });

  // ---------- informações do sistema ----------
  let isAdmin = false;
  async function loadInfo() {
    try {
      const d = await call('system.info');
      isAdmin = d.admin;
      const s = d.static || {};
      $('#sysLine').textContent = [s.os, s.cpu].filter(Boolean).join(' • ') || 'Windows';
      const gpus = (s.gpus || []).map((g) => g.name).join(' + ') || 'indisponível';
      const rows = [
        ['SO', `${s.os || 'indisponível'} (build ${s.build || '?'}, ${s.arch || ''})`],
        ['CPU', `${s.cpu || 'indisponível'} — ${s.cores || '?'} núcleos / ${s.threads || '?'} threads`],
        ['GPU', gpus],
        ['RAM instalada', s.totalRamMB ? Math.round(s.totalRamMB / 1024) + ' GB' : 'indisponível'],
        ['Equipamento', [s.manufacturer, s.model].filter(Boolean).join(' ') + (s.isLaptop ? ' (notebook)' : '')],
      ];
      const box = $('#sysInfo');
      box.textContent = '';
      rows.forEach(([k, v]) => box.append(h('div', null, h('span', { class: 'muted' }, k + ': '), v)));
      const badge = $('#adminBadge');
      badge.textContent = isAdmin ? 'Executando como administrador' : 'Sem privilégios de administrador';
      badge.className = 'badge ' + (isAdmin ? 'ok' : 'warn');
      $('#btnAdmin').classList.toggle('hidden', isAdmin);
    } catch (e) { toast(e.message, 'error'); }
  }
  $('#btnAdmin').addEventListener('click', (e) => run(e.target, () => call('admin.relaunch')));

  // ---------- telemetria ----------
  const hist = { cpu: [], ram: [], gpu: [] };
  const MAXH = 60;
  function push(k, v) { hist[k].push(v); if (hist[k].length > MAXH) hist[k].shift(); }

  function onMetrics(m) {
    if (m.cpu != null) { val($('#m-cpu'), m.cpu + '%'); setBar('#b-cpu', m.cpu); val($('#p-cpu'), m.cpu + '%'); }
    $('#s-cpu').textContent = '';
    if (m.ram) {
      val($('#m-ram'), m.ram.percent + '%'); setBar('#b-ram', m.ram.percent);
      $('#s-ram').textContent = `${(m.ram.usedMB / 1024).toFixed(1)} de ${(m.ram.totalMB / 1024).toFixed(1)} GB`;
      val($('#p-ram'), m.ram.percent + '%');
    }
    if (m.gpuUsage != null) { val($('#m-gpu'), m.gpuUsage + '%'); setBar('#b-gpu', m.gpuUsage); $('#s-gpu').textContent = 'Fonte: ' + m.gpuSource; val($('#p-gpu'), m.gpuUsage + '%'); $('#p-gpus').textContent = 'Fonte: ' + m.gpuSource; }
    else if ('disks' in m) { na($('#m-gpu')); setBar('#b-gpu', null); $('#s-gpu').textContent = 'Sem contador "GPU Engine" nem nvidia-smi'; na($('#p-gpu')); }
    const d = (m.disks || []).find((x) => x.id === 'C:') || (m.disks || [])[0];
    if (d) {
      const usedPct = Math.round((1 - d.freeGB / d.totalGB) * 1000) / 10;
      val($('#m-disk'), d.freeGB + ' GB livres'); setBar('#b-disk', usedPct);
      $('#s-disk').textContent = `${d.id} • ${usedPct}% usado de ${d.totalGB} GB`;
    }
    if ('disks' in m) {
      if (m.cpuTempC != null) { val($('#m-tcpu'), m.cpuTempC + ' °C'); $('#s-tcpu').textContent = 'Fonte: ' + m.cpuTempSource; }
      else { na($('#m-tcpu')); $('#s-tcpu').textContent = 'Este PC não expõe o sensor ACPI (comum). Pode exigir administrador.'; }
      if (m.gpuTempC != null) { val($('#m-tgpu'), m.gpuTempC + ' °C'); $('#s-tgpu').textContent = 'Fonte: nvidia-smi'; }
      else { na($('#m-tgpu')); $('#s-tgpu').textContent = 'Disponível apenas para GPUs NVIDIA (nvidia-smi).'; }
    }
    if (m.processCount != null) val($('#m-proc'), String(m.processCount));
    if (m.cpu != null) push('cpu', m.cpu);
    if (m.ram) push('ram', m.ram.percent);
    push('gpu', m.gpuUsage == null ? null : m.gpuUsage);
    const n = hist.cpu.length;
    if (n >= 5) {
      let ok = 0;
      for (let i = 0; i < n; i++) if (hist.cpu[i] < 90 && (hist.ram[i] ?? 0) < 90) ok++;
      val($('#p-stab'), Math.round((ok / n) * 100) + '%');
    }
    if ($('#view-performance').classList.contains('active')) drawChart();
  }

  function drawChart() {
    const c = $('#chart');
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#1b222b'; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { const y = (H / 4) * i; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    const line = (arr, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
      let started = false;
      arr.forEach((v, i) => {
        if (v == null) { started = false; return; }
        const x = (i / (MAXH - 1)) * W, y = H - (v / 100) * H;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    line(hist.cpu, '#2dff8a'); line(hist.ram, '#2f7bff'); line(hist.gpu, '#ffc233');
  }

  // ---------- FPS ----------
  async function refreshFps() {
    try {
      const s = await call('fps.status');
      $('#btnFpsStart').classList.toggle('hidden', s.running);
      $('#btnFpsStop').classList.toggle('hidden', !s.running);
      $('#fpsNote').textContent = s.available
        ? 'PresentMon encontrado. Abra o Fortnite e inicie a captura (pode exigir administrador).'
        : 'FPS indisponível: o PresentMon não está na pasta "tools" (veja o README). Nenhum valor é estimado.';
    } catch (e) { toast(e.message, 'error'); }
  }
  $('#btnFpsStart').addEventListener('click', (e) => run(e.target, async () => { await call('fps.start'); await refreshFps(); toast('Captura de FPS iniciada.', 'ok'); }));
  $('#btnFpsStop').addEventListener('click', (e) => run(e.target, async () => { await call('fps.stop'); await refreshFps(); resetFps(); }));
  function resetFps() { ['#f-fps', '#f-low', '#f-ms'].forEach((s) => na($(s))); }
  function onFps(f) {
    if (!f.running) { resetFps(); refreshFps(); return; }
    if (f.fps == null) { na($('#f-fps'), 'aguardando o jogo…'); return; }
    val($('#f-fps'), f.fps + ' FPS'); val($('#f-low'), f.low1 + ' FPS'); val($('#f-ms'), f.frameMs + ' ms');
  }

  // ---------- passos / progresso ----------
  function renderSteps(ul, steps) {
    ul.textContent = '';
    const sym = { ok: '✓', skip: '○', error: '✕' };
    steps.forEach((s) => ul.append(h('li', null, h('span', { class: 'st ' + s.status }, sym[s.status] || '•'), h('span', null, h('b', null, s.name + ' '), h('span', { class: 'muted' }, s.detail || '')))));
  }
  function onProgress(p) {
    $('#termBar').style.width = p.pct + '%';
    const map = { optimize: ['#optProgress', '#optBar', '#optLabel'], analyze: ['#anProgress', '#anBar', '#anLabel'] }[p.id];
    if (map) {
      $(map[0]).classList.remove('hidden');
      $(map[1]).style.width = p.pct + '%';
      $(map[2]).textContent = p.label || '';
    }
  }

  // ---------- início: otimizar ----------
  function setScore(score) {
    $('#scoreVal').textContent = score;
    $('#scoreLabel').textContent = score >= 80 ? 'PC em bom estado' : score >= 55 ? 'Há pontos de atenção' : 'Precisa de atenção';
    const fg = $('#ringFg');
    fg.style.strokeDashoffset = String(326.7 * (1 - score / 100));
    fg.style.stroke = score >= 80 ? '#2dff8a' : score >= 55 ? '#ffc233' : '#ff4d5e';
  }
  $('#btnOptimize').addEventListener('click', (e) => run(e.target, async () => {
    $('#optSteps').textContent = '';
    const r = await call('optimize.run', { restorePoint: $('#optRestore').checked, cleanShader: $('#optShader').checked, integrity: $('#optIntegrity').checked });
    if (r) {
      renderSteps($('#optSteps'), r.steps);
      if (r.score != null) setScore(r.score);
      toast('Otimização concluída.', 'ok');
    }
  }));

  // ---------- diagnóstico ----------
  function table(cols, rows) {
    return h('table', null, h('thead', null, h('tr', null, cols.map((c) => h('th', null, c)))), h('tbody', null, rows));
  }
  async function renderStartup(box, items) {
    box.textContent = '';
    if (!items.length) { box.append(h('p', { class: 'muted' }, 'Nenhum item encontrado.')); return; }
    box.append(table(['Programa', 'Origem', ''], items.map((i) => h('tr', null,
      h('td', null, h('b', null, i.name), h('div', { class: 'cmd' }, i.command)),
      h('td', null, i.scope, i.enabled ? '' : ' (desativado)'),
      h('td', { class: 'num' }, i.scope === 'Usuário'
        ? h('button', { class: 'ghost small', onclick: (ev) => run(ev.target, async () => { await call('startup.set', { name: i.name, enabled: !i.enabled }); renderStartup(box, await call('startup.list')); toast('Inicialização atualizada (reversível em Restaurar).', 'ok'); }) }, i.enabled ? 'Desativar' : 'Reativar')
        : h('span', { class: 'muted' }, 'só leitura'))))));
  }
  function renderAnalysis(a) {
    setScore(a.score);
    const f = $('#findings');
    f.textContent = '';
    const order = { crit: 0, warn: 1, info: 2, na: 3, ok: 4 };
    a.findings.slice().sort((x, y) => order[x.severity] - order[y.severity]).forEach((x) => {
      f.append(h('div', { class: 'finding ' + x.severity }, h('span', { class: 'sev' }), h('div', null, h('b', null, x.title), h('p', null, x.detail), x.recommendation ? h('p', { class: 'rec' }, 'Recomendação: ' + x.recommendation) : null)));
    });
    const t = $('#anTables');
    t.textContent = '';
    t.append(
      h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Mais CPU')), table(['Processo', 'CPU', 'RAM'], (a.top.byCpu || []).map((p) => h('tr', null, h('td', null, p.name), h('td', { class: 'num' }, p.cpu + '%'), h('td', { class: 'num' }, p.ramMB + ' MB'))))),
      h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Mais RAM')), table(['Processo', 'RAM'], (a.top.byRam || []).map((p) => h('tr', null, h('td', null, p.name), h('td', { class: 'num' }, p.ramMB + ' MB'))))),
    );
    const sbox = h('div');
    const startPanel = h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Programas que iniciam com o Windows')), sbox);
    renderStartup(sbox, a.startup || []);
    const svcPanel = h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Serviços opcionais em execução')),
      h('p', { class: 'muted' }, 'Somente informação. O app não desativa serviços.'),
      (a.services || []).length ? table(['Serviço', 'Observação'], a.services.map((s) => h('tr', null, h('td', null, h('b', null, s.display || s.name), h('div', { class: 'cmd' }, s.name + ' • ' + s.startType)), h('td', null, s.note)))) : h('p', { class: 'muted' }, 'Nenhum serviço da lista está em execução.'));
    t.append(startPanel, svcPanel);
  }
  $('#btnAnalyze').addEventListener('click', (e) => run(e.target, async () => {
    const a = await call('analyze.run');
    if (a) { renderAnalysis(a); $('#anLabel').textContent = 'Análise concluída.'; }
  }));

  // ---------- modo Fortnite ----------
  let fnActive = false;
  async function loadApps() {
    const box = $('#appList');
    box.textContent = '';
    try {
      const apps = await call('processes.userApps');
      if (!apps.length) { box.append(h('p', { class: 'muted' }, 'Nenhum aplicativo elegível aberto.')); return; }
      apps.forEach((a) => box.append(h('label', null, h('input', { type: 'checkbox', value: String(a.pid) }), h('span', { class: 't' }, a.name + ' — ' + a.title), h('span', { class: 'm' }, a.ramMB + ' MB'))));
    } catch (e) { toast(e.message, 'error'); }
  }
  async function refreshFortnite() {
    try {
      const s = await call('fortnite.status');
      fnActive = s.active;
      const box = $('#fnStatus');
      box.textContent = '';
      const item = (label, text, on) => h('div', null, h('label', null, label), h('span', { class: 'dot' + (on ? ' on' : '') }, text));
      box.append(
        item('Instalação', s.installed ? s.location : (s.reason || 'não encontrada'), s.installed),
        item('Jogo', s.running ? 'Aberto' : 'Fechado', s.running),
        item('Epic Games Launcher', s.launcherRunning ? 'Aberto' : 'Fechado', s.launcherRunning),
        item('Modo Fortnite', s.active ? 'Ativo' : 'Inativo', s.active),
      );
      $('#btnFnOn').classList.toggle('hidden', s.active);
      $('#btnFnOff').classList.toggle('hidden', !s.active);
      renderRecs(s.recommendations);
    } catch (e) { toast(e.message, 'error'); }
    loadApps();
  }
  function renderRecs(list) {
    const ul = $('#fnRecs');
    ul.textContent = '';
    (list || []).forEach((r) => ul.append(h('li', null, r.text, h('small', null, '(' + r.source + ')'))));
  }
  $('#btnRefreshApps').addEventListener('click', loadApps);
  $('#btnFnOn').addEventListener('click', (e) => run(e.target, async () => {
    const pids = $$('#appList input:checked').map((i) => parseInt(i.value, 10));
    $('#fnSteps').textContent = '';
    const r = await call('fortnite.activate', { closePids: pids });
    if (r) { renderSteps($('#fnSteps'), r.steps); renderRecs(r.recommendations); toast('Modo Fortnite ativo.', 'ok'); }
    refreshFortnite();
  }));
  $('#btnFnOff').addEventListener('click', (e) => run(e.target, async () => {
    const r = await call('fortnite.deactivate');
    toast(`Modo desativado: ${r.reverted} alteração(ões) revertida(s).`, 'ok');
    $('#fnSteps').textContent = '';
    refreshFortnite();
  }));

  // ---------- terminal ----------
  const term = $('#termOut');
  const cmdHist = [];
  let cmdIdx = 0;
  function appendLog(e) {
    const t = new Date(e.ts);
    const ts = t.toLocaleTimeString('pt-BR', { hour12: false });
    term.append(h('div', { class: 'ln ' + e.level }, h('span', { class: 'ts' }, ts), e.msg));
    while (term.childElementCount > 1500) term.firstElementChild.remove();
    term.scrollTop = term.scrollHeight;
  }
  $('#termIn').addEventListener('keydown', (e) => {
    const input = e.target;
    if (e.key === 'Enter') {
      const line = input.value.trim();
      if (!line) return;
      cmdHist.push(line); cmdIdx = cmdHist.length;
      input.value = '';
      input.disabled = true;
      call('terminal.exec', { line }).catch((err) => toast(err.message, err.message === 'Cancelado pelo usuário.' ? '' : 'error')).finally(() => { input.disabled = false; input.focus(); });
    } else if (e.key === 'ArrowUp' && cmdIdx > 0) { cmdIdx--; input.value = cmdHist[cmdIdx]; e.preventDefault(); }
    else if (e.key === 'ArrowDown') { cmdIdx = Math.min(cmdHist.length, cmdIdx + 1); input.value = cmdHist[cmdIdx] || ''; e.preventDefault(); }
  });
  $('#btnClear').addEventListener('click', () => { term.textContent = ''; });
  $('#btnHist').addEventListener('click', (e) => run(e.target, async () => {
    const list = await call('history.get');
    appendLog({ ts: new Date().toISOString(), level: 'info', msg: `— histórico salvo (${list.length} registros) —` });
    list.forEach(appendLog);
  }));

  // ---------- restaurar ----------
  async function loadChanges() {
    const box = $('#changes');
    try {
      const list = await call('restore.list');
      box.textContent = '';
      if (!list.length) { box.append(h('p', { class: 'muted' }, 'Nenhuma alteração registrada ainda.')); return; }
      list.forEach((c) => box.append(h('div', { class: 'change' },
        h('div', { class: 'd' }, h('div', null, c.description), h('div', { class: 'when' }, new Date(c.ts).toLocaleString('pt-BR') + (c.revertedAt ? ' • revertido em ' + new Date(c.revertedAt).toLocaleString('pt-BR') : ''))),
        c.reverted ? h('span', { class: 'tag rev' }, 'revertido') : c.undo ? h('button', { class: 'ghost small', onclick: (ev) => run(ev.target, async () => { await call('restore.undo', { id: c.id }); toast('Alteração revertida.', 'ok'); loadChanges(); refreshFortnite(); }) }, 'Reverter') : h('span', { class: 'tag irr' }, 'irreversível'))));
    } catch (e) { toast(e.message, 'error'); }
  }
  $('#btnUndoAll').addEventListener('click', (e) => run(e.target, async () => { const r = await call('restore.undoAll'); if (r) toast(`${r.reverted} revertida(s), ${r.failed} falha(s).`, r.failed ? 'error' : 'ok'); loadChanges(); }));
  $('#btnRestorePoint').addEventListener('click', (e) => run(e.target, async () => { await call('restorepoint.create'); toast('Ponto de restauração criado.', 'ok'); loadChanges(); }));
  $('#btnDism').addEventListener('click', (e) => run(e.target, async () => { const r = await call('integrity.quick'); toast(r.ok ? 'DISM: sem corrupção detectada.' : 'DISM reportou problemas. Veja o Terminal.', r.ok ? 'ok' : 'error'); }));
  $('#btnSfc').addEventListener('click', (e) => run(e.target, async () => { toast('SFC em andamento. Acompanhe no Terminal; pode levar vários minutos.'); const r = await call('integrity.sfc'); toast(r.ok ? 'SFC: sem violações.' : 'SFC reportou problemas. Veja o Terminal.', r.ok ? 'ok' : 'error'); }));

  // ---------- eventos do main ----------
  window.fb.on('log', appendLog);
  window.fb.on('progress', onProgress);
  window.fb.on('metrics', onMetrics);
  window.fb.on('fps', onFps);
  window.fb.on('state', (s) => {
    if (s.clearTerminal) term.textContent = '';
    if (typeof s.fortniteActive === 'boolean') { fnActive = s.fortniteActive; $('#btnFnOn').classList.toggle('hidden', fnActive); $('#btnFnOff').classList.toggle('hidden', !fnActive); }
  });

  resetFps();
  loadInfo();
  appendLog({ ts: new Date().toISOString(), level: 'info', msg: 'FORTNITE BOOSTER pronto. Digite "help" para ver os comandos autorizados.' });
})();
