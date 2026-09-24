// Frontend app: ask → SSE progress → report workspace → export. No build step.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let current = null;
if (typeof window !== 'undefined') window.__setCurrentForScreenshot = (r) => { current = normalizeResult(r); try { showView('result'); renderResultHeader(); activateTab($('#tab-report'), false); } catch {} };
let serverKey = false;
let staticMode = false;
let serverModels = [];
let selectedSource = null;
let serverRuns = [];
// Static cache-busting version. MUST match ENGINE_V in direct.js (enforced by
// tests/static-version.test.js). Bump both on any static-mode change so Pages
// visitors never run a stale engine bundle (stale bundles caused confusing
// "process is not defined" errors after deploys).
const STATIC_V = '2026-09-24b';
const staticSuffix = () => (typeof window === 'undefined' ? '' : `?v=${STATIC_V}`);

const MODE_BLURB = {
  quick: ['Quick', '~2 searches, about 1–2 minutes. Escalates automatically if sources disagree.'],
  standard: ['Standard', '~10 searches + academic and books. Usually minutes; waits out rate limits for up to ~25 min.'],
  deep: ['Deep', '~24 searches, books, primary sources and provenance. Up to ~45 min on free-tier quota.'],
  exhaustive: ['Exhaustive', '~50 searches, documentary-grade. Up to ~90 min and the heaviest API use.'],
};
const MODE_LABEL = { quick: 'Quick', standard: 'Standard', deep: 'Deep', exhaustive: 'Exhaustive' };

function recommendMode(q) {
  const t = String(q || '').trim();
  if (t.length < 4) return '';
  if (/^(when|who|where|what year|how many)\b/i.test(t) && t.length < 90) return 'Looks focused and factual — Quick should do.';
  if (/why|causes?|collapse|compar|vs\.?|history of|explain|debate|controvers|myth/i.test(t) || t.length > 140) return 'Looks like a deep investigation — consider Deep.';
  return '';
}

// ---------- storage (every access guarded: private mode / blocked storage) ----------
function lsGet(k, fallback = null) { try { const v = localStorage.getItem(k); return v === null ? fallback : v; } catch { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }

function getStoredKeys() {
  try {
    const arr = JSON.parse(lsGet('gemini_keys', '[]'));
    if (Array.isArray(arr)) {
      const clean = arr.map((k) => String(k || '').trim()).filter(Boolean);
      if (clean.length) return clean;
    }
  } catch { /* fall through */ }
  const single = (lsGet('gemini_key', '') || '').trim();
  return single ? [single] : [];
}
function setStoredKeys(keys) {
  if (keys.length) {
    lsSet('gemini_keys', JSON.stringify(keys));
    lsSet('gemini_key', keys[0]);
  } else {
    lsDel('gemini_keys');
    lsDel('gemini_key');
  }
  updateKeyStatus();
}
function getStoredModel() { return lsGet('gemini_model', '') || ''; }
function needsKey() { return !getStoredKeys().length && (staticMode || !serverKey); }
function modelLabel(id) {
  if (!id) return 'Auto model';
  return (serverModels.find((m) => m.id === id)?.label || id).replace(/^Gemini\s+/i, '');
}
function updateKeyStatus() {
  const n = getStoredKeys().length;
  $('#keyCount').textContent = String(n);
  const ready = n > 0 || (!staticMode && serverKey);
  $('#keyLabel').textContent = n ? `${n} key${n > 1 ? 's' : ''} · ${modelLabel(getStoredModel())}` : ready ? `Server key · ${modelLabel(getStoredModel())}` : 'Connect Gemini';
  $('#keyDot').className = 'key-dot ' + (ready ? 'ok' : 'off');
  $('#setupCard').classList.toggle('hidden', !needsKey());
}

function getHistory() {
  try { const h = JSON.parse(lsGet('er_history', '[]')); return Array.isArray(h) ? h : []; } catch { return []; }
}
function recordHistory(r) {
  if (!r?.id || !r.task) return;
  // De-duplicated by id: reopening a run must not add it again.
  const hist = getHistory().filter((h) => h.id !== r.id);
  hist.unshift({ id: r.id, question: r.task.question, mode: r.task.mode, at: r.completedAt, sources: (r.sources || []).length, ...(staticMode ? { direct: true } : {}) });
  lsSet('er_history', JSON.stringify(hist.slice(0, 100)));
}

// ---------- theme ----------
function resolvedTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set) return set;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function syncThemeButton() {
  const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
  $('#themeBtn').setAttribute('aria-label', `Switch to ${next} theme`);
}
$('#themeBtn').addEventListener('click', () => {
  const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  lsSet('er_theme', next);
  syncThemeButton();
});

// ---------- views + navigation ----------
const VIEWS = ['askView', 'progressView', 'resultView'];
function showView(name) {
  const id = `${name}View`;
  for (const v of VIEWS) $('#' + v).classList.toggle('hidden', v !== id);
  closeNav();
  window.scrollTo?.({ top: 0 });
}
function announce(msg) { $('#srStatus').textContent = msg; }
function openNav() {
  document.body.classList.add('nav-open');
  $('#scrim').hidden = false;
  $('#menuBtn').setAttribute('aria-expanded', 'true');
  $('#newBtn').focus();
}
function closeNav() {
  if (!document.body.classList.contains('nav-open')) return;
  document.body.classList.remove('nav-open');
  $('#scrim').hidden = true;
  $('#menuBtn').setAttribute('aria-expanded', 'false');
}
$('#menuBtn').addEventListener('click', openNav);
$('#closeNav').addEventListener('click', closeNav);
$('#scrim').addEventListener('click', closeNav);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('#keyDialog').open) return;
  if (document.body.classList.contains('nav-open')) closeNav();
  $$('details.menu[open]').forEach((d) => { d.open = false; });
  if (selectedSource) selectSource(null);
});
// Close popover menus on outside click.
document.addEventListener('click', (e) => {
  $$('details.menu[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
});

async function init() {
  let hasFallback = false;
  let apiOk = false;
  let cfg = null;
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (res.ok) {
      cfg = await res.json();
      serverKey = !!cfg.serverKey;
      hasFallback = !!cfg.hasFallback;
      apiOk = Array.isArray(cfg.modes);
    }
  } catch { /* offline or static host → static mode */ }
  // Populate the model picker (server list wins, static falls back to the
  // backend catalog so Pages gets the same list). Runs OUTSIDE the fetch
  // try/catch: a 404 HTML page makes .json() throw on Pages.
  const populateModels = (models) => {
    serverModels = models;
    $('#modelInput').innerHTML = '<option value="">Auto — best model per task</option>'
      + models.map((m) => `<option value="${escapeAttr(m.id)}">${escapeHtml(m.label)} — ${escapeHtml(m.blurb || '')}</option>`).join('');
    // Drop retired saved ids: a stale value would send a dead model id.
    const savedModel = getStoredModel();
    if (savedModel && models.some((m) => m.id === savedModel)) $('#modelInput').value = savedModel;
    else if (savedModel) lsDel('gemini_model');
  };
  if (cfg && Array.isArray(cfg.models) && cfg.models.length) {
    populateModels(cfg.models);
  } else {
    try {
      const { AVAILABLE_MODELS } = await import(`../backend/src/config.js${staticSuffix()}`);
      if (Array.isArray(AVAILABLE_MODELS) && AVAILABLE_MODELS.length) populateModels(AVAILABLE_MODELS);
    } catch { /* Auto only — the engine default still works */ }
  }
  staticMode = !apiOk;
  $('#staticBanner').classList.toggle('hidden', !staticMode);
  $('#buildTag').textContent = `build ${STATIC_V}`;
  $('#serverKeyNote').textContent = staticMode
    ? 'Research runs in your browser on your own Gemini key. It stays in this browser and is sent only to Google.'
    : serverKey
      ? `This server has its own key${hasFallback ? ' (plus a fallback)' : ''}. Keys you add here are used instead, for this browser only.`
      : 'Research runs on your own Gemini key. It stays in this browser and is sent only with your runs — never stored on the server.';
  $('#setupText').textContent = staticMode
    ? 'It\'s free from Google AI Studio. The key stays in this browser — research runs right here.'
    : 'It\'s free from Google AI Studio and stays in this browser.';
  const updateComposer = () => {
    const [name, blurb] = MODE_BLURB[val('mode')] || ['', ''];
    $('#costNote').innerHTML = name ? `<b>${escapeHtml(name)}</b> — ${escapeHtml(blurb)}` : '';
    $('#modeHint').textContent = recommendMode($('#q').value);
    $('#qCount').textContent = `${$('#q').value.length} / 5000`;
    const n = [$('#hyp').value.trim(), $('#docu').checked, $('#fresh').checked].filter(Boolean).length;
    $('#optCount').textContent = String(n);
    $('#optCount').classList.toggle('hidden', !n);
  };
  $$('input[name=mode]').forEach((r) => r.addEventListener('change', updateComposer));
  ['#hyp', '#docu', '#fresh'].forEach((s) => $(s).addEventListener('input', updateComposer));
  ['#docu', '#fresh'].forEach((s) => $(s).addEventListener('change', updateComposer));
  $('#q').addEventListener('input', () => { updateComposer(); autoGrow(); });
  updateComposer();
  updateKeyStatus();
  syncThemeButton();
  $('#modelInput').addEventListener('change', () => updateModelHint($('#modelInput').value));
  updateModelHint(getStoredModel());
  renderRuns();
  refreshServerRuns();
  // Deep links (#run=<id>) survive reloads.
  const m = location.hash.match(/^#run=([\w-]+)$/);
  if (m) openRun(m[1], !!getHistory().find((h) => h.id === m[1] && h.direct));
  else $('#q').focus({ preventScroll: true });
}

function autoGrow() {
  const q = $('#q');
  q.style.height = 'auto';
  q.style.height = Math.min(q.scrollHeight, 320) + 'px';
}

function updateModelHint(value) {
  const hint = $('#modelHint');
  hint.classList.toggle('hidden', !!value);
  if (!value) hint.textContent = 'Auto uses Flash-Lite for planning and analysis and Gemini 2.5 Flash for search and writing — two separate quota buckets. If a picked model is unavailable on your key, the run falls back to Flash and says so.';
}

function val(name) {
  if (name === 'stance') return $('#stance').value || 'neutral';
  return document.querySelector(`input[name=${name}]:checked`)?.value || '';
}

let running = false;
let runningQuestion = '';
let currentAbort = null;
$('#askForm').addEventListener('submit', (e) => { e.preventDefault(); startFromForm(); });
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); startFromForm(); }
});
function startFromForm() {
  if (running) { showNotice('A research run is already in progress.', ''); return; }
  const question = $('#q').value.trim();
  if (question.length < 3) {
    showNotice('Type a research question first (at least 3 characters).', 'error');
    $('#q').focus();
    return;
  }
  if (needsKey()) {
    showNotice('Connect a Gemini API key to start — it stays in this browser.', 'error');
    openKeyDialog();
    return;
  }
  $('#optionsMenu').open = false;
  running = true;
  runningQuestion = question;
  $('#start').disabled = true;
  run({ question, mode: val('mode'), stance: val('stance'), hypothesis: $('#hyp').value.trim(), documentary: $('#docu').checked, fresh: $('#fresh').checked, model: getStoredModel() || undefined });
}
$('#newBtn').addEventListener('click', () => {
  if (running) { showView('progress'); showNotice('A run is in progress — cancel it to start a new one.', ''); return; }
  goHome();
  $('#q').focus();
});
$('#setupBtn').addEventListener('click', () => openKeyDialog());

function showNotice(msg, kind = '') {
  const n = $('#notice');
  $('#noticeText').textContent = msg;
  n.className = 'notice' + (kind ? ' ' + kind : '');
  n.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}
function hideNotice() { $('#notice').classList.add('hidden'); }
$('#noticeClose').addEventListener('click', hideNotice);

// Home: the single safe landing for new research, cancel and errors.
// Question text is preserved so a retry is one click.
function goHome(notice, kind = '') {
  running = false;
  runningQuestion = '';
  currentAbort = null;
  $('#start').disabled = false;
  setBar(0);
  $('#progressView').setAttribute('aria-busy', 'false');
  showView('ask');
  if (notice) showNotice(notice, kind);
  else hideNotice();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  renderRuns();
}

function setBar(pct) {
  $('#progressFill').style.width = pct + '%';
  $('.progress-bar').setAttribute('aria-valuenow', String(Math.round(pct)));
}

// Pipeline phases in order, with the display title and bar anchor each maps to.
// The bar only ever reflects reached milestones — never guesses ahead.
const PHASES = {
  plan: ['Planning', 8],
  search: ['Searching', 28],
  read: ['Reading sources', 48],
  analyze: ['Analyzing evidence', 66],
  provenance: ['Checking independence', 78],
  synthesize: ['Writing the report', 90],
  verify: ['Verifying citations', 96],
  done: ['Complete', 100],
};
const PHASE_ORDER = Object.keys(PHASES);

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function fmtNum(n) {
  n = n || 0;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function run(body) {
  hideNotice();
  selectedSource = null;
  showView('progress');
  $('#progressQuestion').textContent = body.question;
  setBar(3);
  $('#progressView').setAttribute('aria-busy', 'true');
  $('#waitNote').classList.add('hidden');
  $('#tipNote').classList.remove('hidden');
  $$('#stages > li').forEach((li) => {
    li.className = '';
    li.dataset.state = '';
    li.querySelector('.st-meta').textContent = '';
    li.querySelector('.st-events').innerHTML = '';
    li.querySelector('.st-head').setAttribute('aria-expanded', 'false');
  });
  renderRuns();
  const t0 = Date.now();
  const live = { stats: null, sources: 0, claims: 0, phase: 'plan', bar: 3, gotResult: false, gotError: false };
  const modeLabel = MODE_LABEL[body.mode] || '';
  const renderLive = () => {
    const s = live.stats || {};
    $('#progressEyebrow').innerHTML = `Researching · ${escapeHtml(modeLabel)} · <span class="mono">${fmtElapsed(Date.now() - t0)}</span>`;
    const cells = [['sources', live.sources], ['claims', live.claims], ['searches', s.searchCalls || 0], ['model calls', s.modelCalls || 0]];
    const tok = (s.tokensIn || 0) + (s.tokensOut || 0);
    if (tok) cells.push(['tokens', fmtNum(tok)]);
    $('#liveStats').innerHTML = cells.map(([k, v]) => `<div><b>${escapeHtml(v)}</b><span>${escapeHtml(k)}</span></div>`).join('');
  };
  const stageMeta = (phase) => {
    const s = live.stats || {};
    if (phase === 'search') return `${s.searchCalls || 0} searches · ${live.sources} sources`;
    if (phase === 'read') return s.fetches ? `${s.fetches} pages fetched` : '';
    if (phase === 'analyze') return live.claims ? `${live.claims} claims` : '';
    return '';
  };
  const setPhase = (phase) => {
    if (!phase || !PHASES[phase]) return;
    const prev = live.phase;
    live.phase = phase;
    live.bar = Math.max(live.bar, PHASES[phase][1]);
    setBar(live.bar);
    const idx = PHASE_ORDER.indexOf(phase);
    $$('#stages > li').forEach((li) => {
      const i = PHASE_ORDER.indexOf(li.dataset.phase);
      const state = i < idx || phase === 'done' ? 'done' : i === idx ? 'active' : '';
      if (li.dataset.state !== state) {
        li.dataset.state = state;
        li.className = state;
        li.querySelector('.st-head').setAttribute('aria-expanded', String(state === 'active'));
      }
      if (state === 'done') { const m = stageMeta(li.dataset.phase); if (m) li.querySelector('.st-meta').textContent = m; }
    });
    if (prev !== phase) announce(PHASES[phase][0]);
  };
  setPhase('plan');
  renderLive();
  const timer = setInterval(renderLive, 1000);
  const step = (cls, text) => {
    const li = $(`#stages > li[data-phase="${live.phase === 'done' ? 'verify' : live.phase}"]`) || $('#stages > li');
    const list = li.querySelector('.st-events');
    const d = document.createElement('li');
    d.className = 'ev ' + (cls || 'info');
    d.textContent = text;
    list.appendChild(d);
    // Keep each stage's log bounded so long runs stay responsive.
    while (list.childElementCount > 60) list.firstElementChild.remove();
    return d;
  };
  // Hooks shared with handleEvent so both SSE and static runs update one UI.
  const hooks = {
    onPhase: setPhase,
    onResult: () => { live.gotResult = true; },
    onError: () => { live.gotError = true; },
    onWait: () => { $('#waitNote').classList.remove('hidden'); $('#tipNote').classList.add('hidden'); },
    onStats: (stats, extra = {}) => {
      if (stats) live.stats = stats;
      if (extra.sources != null) live.sources = extra.sources;
      if (extra.claims != null) live.claims = extra.claims;
      renderLive();
    },
  };
  const keys = getStoredKeys();
  const model = body.model || getStoredModel() || '';
  const finish = () => {
    clearInterval(timer);
    running = false;
    runningQuestion = '';
    currentAbort = null;
    $('#start').disabled = false;
    $('#progressView').setAttribute('aria-busy', 'false');
  };
  // Cancel — aborting the fetch triggers server-side cancellation via the
  // isCancelled refcount (no extra endpoint needed), then home.
  const abort = new AbortController();
  currentAbort = abort;
  const asleep = (ms) => new Promise((res, rej) => {
    if (abort.signal.aborted) return rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const t = setTimeout(res, ms);
    abort.signal.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
  });
  $('#cancelBtn').onclick = () => {
    if (abort.signal.aborted) return;
    abort.abort();
    finish();
    goHome('Research cancelled — your question is kept, ready to retry.');
  };
  if (staticMode) {
    runDirectFlow(body, step, finish, abort.signal, keys, model, hooks);
    return;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (keys.length === 1) headers['x-gemini-key'] = keys[0];
  else if (keys.length > 1) headers['x-gemini-keys'] = JSON.stringify(keys);
  if (model) headers['x-gemini-model'] = model;

  let attempts = 0;
  const maxAttempts = 3;
  const doFetch = async () => {
    attempts++;
    let streamed = false;
    try {
      const res = await fetch('/api/research', { method: 'POST', headers, body: JSON.stringify(body), signal: abort.signal });
      // 429 from our own server (per-IP limiter or busy upstream): honor
      // Retry-After (header or JSON body), else a short jittered wait.
      if (res.status === 429 && attempts < maxAttempts) {
        const e = await res.json().catch(() => ({}));
        const retryAfter = parseInt(res.headers.get('Retry-After') || '', 10) || Number(e.retryAfter) || 0;
        const waitMs = retryAfter ? Math.min(retryAfter, 120) * 1000 : (8000 + Math.floor(Math.random() * 4000));
        step('warn', `Server is rate-limiting — retrying in ${Math.ceil(waitMs / 1000)}s`);
        await asleep(waitMs);
        return doFetch();
      }
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        const msg = e.error || `server returned status ${res.status}`;
        step('warn', 'Error: ' + msg);
        finish();
        goHome('Error: ' + msg, 'error');
        if (res.status === 401) openKeyDialog();
        return;
      }
      if (!res.body) throw new Error('empty response stream');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        streamed = true;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const p of parts) {
          const data = p.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (!data) continue; // heartbeat comment
          let ev;
          try { ev = JSON.parse(data); } catch { continue; }
          handleEvent(ev, step, hooks);
        }
      }
      finish();
      // Stream closed with neither a result nor an error (server restart,
      // proxy timeout): never strand the user on a frozen progress view.
      if (!live.gotResult && !live.gotError) {
        goHome('The connection closed before the research finished. Your question is kept — try again (a finished run is served from cache).', 'error');
      }
    } catch (e) {
      if (e.name === 'AbortError' || abort.signal.aborted) { finish(); return; }
      step('warn', 'Network error: ' + e.message);
      // Retry only if nothing streamed yet: a mid-stream retry would silently
      // start a whole new research run and double the quota spend.
      if (!streamed && attempts < maxAttempts) {
        const waitMs = Math.min(10000, 1000 * Math.pow(2, attempts));
        step('info', `Retrying in ${Math.ceil(waitMs / 1000)}s…`);
        try { await asleep(waitMs); } catch { finish(); return; }
        return doFetch();
      }
      finish();
      goHome('Network error: ' + e.message + '. Check your connection, then retry — your question is kept.', 'error');
    }
  };
  doFetch();
}

// Stage headers toggle their log (the active stage starts open).
$('#stages').addEventListener('click', (e) => {
  const head = e.target.closest('.st-head');
  if (!head) return;
  const li = head.closest('li');
  if (li.classList.contains('active')) li.classList.toggle('collapsed');
  else li.classList.toggle('open');
  const expanded = li.classList.contains('active') ? !li.classList.contains('collapsed') : li.classList.contains('open');
  head.setAttribute('aria-expanded', String(expanded));
});

// Static-mode run: same engine, executed in-page via frontend/direct.js.
async function runDirectFlow(body, step, finish, signal, keys = [], model = '', hooks = {}) {
  if (!keys.length) {
    const msg = 'Connect a Gemini API key to run research (it stays in this browser).';
    step('warn', msg);
    finish();
    goHome(msg, 'error');
    openKeyDialog();
    return;
  }
  if (signal?.aborted) { finish(); goHome(); return; }
  try {
    const { runDirect, saveLocalResult } = await import(`./direct.js${staticSuffix()}`);
    step('info', `Running in your browser with ${keys.length} key${keys.length > 1 ? 's' : ''}${model ? ` · ${model}` : ''}`);
    const result = await runDirect({ ...body, model: model || body.model }, { key: keys, emit: (ev) => handleEvent(ev, step, hooks), signal });
    if (signal?.aborted) return; // cancel already navigated home
    finish();
    const saved = saveLocalResult(result);
    showResult(result);
    if (!saved) showNotice('This report is too large to keep in browser storage — export it to keep a copy.', '');
  } catch (e) {
    finish();
    if (signal?.aborted || e.name === 'AbortError' || e.code === 'CANCELLED') return;
    const raw = e.message || 'research failed';
    // Distinguish daily quota vs per-minute vs bad key vs no evidence. Same-
    // project keys share one quota, and "wait a minute" is wrong for daily caps.
    let msg = raw;
    if (/RPD|daily quota|billing/i.test(raw)) msg = 'Daily Gemini quota exhausted (resets at midnight Pacific). Add a key from a different project or a billed project, or try Quick mode.';
    else if (/quota|rate|429/i.test(raw)) msg = `All ${keys.length} saved key(s) are rate-limited. Keys from one Google Cloud project share a single quota — extra keys only help from different projects. Per-minute limits reset in ~1 min.`;
    else if (/API key|key not valid|401|403/i.test(raw)) msg = 'Gemini rejected the API key. Check it and try again.';
    else if (/Insufficient evidence/i.test(raw)) msg = raw + ' Try Quick mode or rephrase — some networks block the free academic sources.';
    step('warn', 'Error: ' + msg);
    goHome('Error: ' + msg, 'error');
  }
}

function handleEvent(ev, step, hooks = {}) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.type === 'error') {
    hooks.onError?.();
    step('warn', 'Error: ' + (ev.message || 'research failed'));
    // Terminal: the server ends the stream right after. Land home with the
    // message instead of stranding the user (unless a result already shows).
    if ($('#resultView').classList.contains('hidden')) goHome('Error: ' + (ev.message || 'research failed'), 'error');
    return;
  }
  if (ev.phase) hooks.onPhase?.(ev.phase);
  if (ev.stats || ev.type === 'sources' || ev.type === 'claims') {
    hooks.onStats?.(ev.stats || null, {
      ...(ev.type === 'sources' && ev.count != null ? { sources: ev.count } : {}),
      ...(ev.type === 'claims' && ev.count != null ? { claims: ev.count } : {}),
    });
  }
  if (ev.type === 'result') {
    hooks.onResult?.();
    return showResult(ev.result);
  }
  if (ev.type === 'plan') {
    step('ok', ev.plan ? `Plan ready — ${ev.plan.domain}, ${ev.plan.complexity} complexity` : 'Plan ready');
    return;
  }
  if (/waiting for api quota|quota is hot/i.test(ev.message || '')) hooks.onWait?.();
  if (ev.type === 'sources' || ev.type === 'claims') return step('ok', ev.message);
  step(ev.type === 'warning' ? 'warn' : ev.type === 'done' ? 'ok' : 'info', ev.message || ev.type);
}

// ---------- runs sidebar ----------
async function refreshServerRuns() {
  if (staticMode) return;
  try {
    const res = await fetch('/api/history');
    if (res.ok) serverRuns = (await res.json()).items || [];
  } catch { /* server unreachable */ }
  renderRuns();
}
function relTime(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  if (m < 60 * 48) return 'yesterday';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function renderRuns() {
  const byId = new Map();
  for (const h of serverRuns) byId.set(h.id, { id: h.id, question: h.question, mode: h.mode, at: h.createdAt, where: 'server' });
  for (const h of getHistory()) if (!byId.has(h.id)) byId.set(h.id, { id: h.id, question: h.question, mode: h.mode, at: h.at, where: h.direct ? 'local' : 'gone' });
  const items = [...byId.values()].sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 60);
  const activeId = !$('#resultView').classList.contains('hidden') ? current?.id : null;
  let html = '';
  if (running && runningQuestion) {
    html += `<li class="run-row"><button type="button" class="run active running" data-running="1"><span class="run-q">${escapeHtml(runningQuestion)}</span><span class="run-meta">Researching…</span></button></li>`;
  }
  html += items.map((h) => `<li class="run-row">
      <button type="button" class="run${h.id === activeId ? ' active' : ''}" data-open="${escapeAttr(h.id)}" data-where="${h.where}"${h.where === 'gone' ? ' disabled title="This run was not stored"' : ''}${h.id === activeId ? ' aria-current="page"' : ''}>
        <span class="run-q">${escapeHtml(h.question || 'Untitled')}</span>
        <span class="run-meta">${escapeHtml(MODE_LABEL[h.mode] || h.mode || '')}${h.at ? ` · ${escapeHtml(relTime(h.at))}` : ''}</span>
      </button>
      <button type="button" class="run-del icon-btn small" data-del="${escapeAttr(h.id)}" data-where="${h.where}" aria-label="Delete “${escapeAttr((h.question || 'run').slice(0, 60))}”">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/></svg>
      </button></li>`).join('');
  $('#runList').innerHTML = html || '<li class="runs-empty">Your reports will appear here.</li>';
}
$('#runList').addEventListener('click', async (e) => {
  if (e.target.closest('[data-running]')) { showView('progress'); return; }
  const open = e.target.closest('[data-open]');
  if (open && !open.disabled) { openRun(open.dataset.open, open.dataset.where === 'local'); return; }
  const del = e.target.closest('[data-del]');
  if (!del) return;
  const id = del.dataset.del;
  if (!confirm('Delete this report? This cannot be undone.')) return;
  if (del.dataset.where === 'server') {
    try { await fetch('/api/history/' + encodeURIComponent(id), { method: 'DELETE' }); } catch { /* ignore */ }
    serverRuns = serverRuns.filter((h) => h.id !== id);
  }
  lsSet('er_history', JSON.stringify(getHistory().filter((h) => h.id !== id)));
  try { const { removeLocalResult } = await import(`./direct.js${staticSuffix()}`); removeLocalResult(id); } catch { /* ignore */ }
  if (current?.id === id && !$('#resultView').classList.contains('hidden')) { current = null; goHome(); }
  renderRuns();
});

async function openRun(id, local) {
  if (running) { showView('progress'); showNotice('A run is in progress — cancel it to open another report.', ''); return; }
  try {
    let r = null;
    if (local || staticMode) {
      const { loadLocalResult } = await import(`./direct.js${staticSuffix()}`);
      r = loadLocalResult(id);
    }
    if (!r && !staticMode) {
      const res = await fetch('/api/history/' + encodeURIComponent(id));
      r = res.ok ? await res.json() : null;
    }
    if (!r || !r.id || !r.task) {
      showNotice(local ? 'That report is no longer in this browser (storage may have been cleared).' : 'Could not open that report — it may have been deleted.', 'error');
      return;
    }
    showResult(r, { record: false });
  } catch (e) {
    showNotice('Could not open that report: ' + (e.message || 'network error'), 'error');
  }
}

// ---------- result workspace ----------
function activateTab(btn, focus = true) {
  $$('.tabs button').forEach((x) => { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); x.tabIndex = -1; });
  btn.classList.add('active'); btn.setAttribute('aria-selected', 'true'); btn.tabIndex = 0;
  if (focus) btn.focus();
  $('#tabBody').setAttribute('aria-labelledby', btn.id);
  renderTab(btn.dataset.tab);
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => activateTab(b)));
// Keyboard: ArrowLeft/Right, Home/End cycle through tabs
$('.tabs').addEventListener('keydown', (e) => {
  const tabs = $$('.tabs button');
  const cur = tabs.indexOf(document.activeElement);
  if (cur === -1) return;
  let next = -1;
  if (e.key === 'ArrowRight') next = (cur + 1) % tabs.length;
  else if (e.key === 'ArrowLeft') next = (cur - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = tabs.length - 1;
  else return;
  e.preventDefault();
  activateTab(tabs[next]);
});

function normalizeResult(r) {
  r.task = r.task || {};
  r.stats = r.stats || {};
  r.report = r.report || {};
  r.sources = Array.isArray(r.sources) ? r.sources : [];
  r.claims = Array.isArray(r.claims) ? r.claims : [];
  r.contradictions = Array.isArray(r.contradictions) ? r.contradictions : [];
  for (const s of r.sources) if (!Array.isArray(s.passages)) s.passages = [];
  return r;
}

function showResult(r, opts) {
  const record = opts?.record !== false;
  if (!r || !r.task) { showNotice('The run finished but returned no readable result.', 'error'); return; }
  current = normalizeResult(r);
  selectedSource = null;
  if (record) recordHistory(current);
  showView('result');
  // Fallback inventory: synthesis used the evidence inventory due to quota.
  // NOTE: never call step() here — showResult is also driven by SSE
  // handleEvent where step is not in scope (that crashed Pages once).
  if (current.report.synthesisFallback) {
    showNotice('Model quota ran out before the write-up — this report is an evidence inventory built from the gathered sources. Add keys from other projects or try Quick mode for a full write-up.', '');
  } else {
    hideNotice();
  }
  renderResultHeader();
  activateTab($('#tab-report'), false);
  announce('Report ready');
  if (current.id) history.replaceState(null, '', `#run=${encodeURIComponent(current.id)}`);
  renderRuns();
  if (!staticMode) refreshServerRuns();
}

const isPrimary = (s) => s.proximity === 'primary' || s.tier === 1;
function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function renderResultHeader() {
  const r = current;
  if (!r) return;
  $('#resultEyebrow').textContent = ['Report', MODE_LABEL[r.task.mode] || r.task.mode, r.task.stance && r.task.stance !== 'neutral' ? `${r.task.stance} stance` : '', r.completedAt ? fmtDate(r.completedAt) : '']
    .filter(Boolean).join(' · ') + (r.report.synthesisFallback ? ' · evidence inventory' : '');
  $('#resultQuestion').textContent = r.task.question || 'Untitled research';
  const inspected = r.sources.filter((s) => s.verified).length;
  $('#resultMeta').textContent = [`${r.sources.length} sources`, inspected ? `${inspected} read in full` : '', `${r.claims.length} claims`, `${r.contradictions.length} contradiction${r.contradictions.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  const counts = { evidence: r.claims.length, sources: r.sources.length };
  for (const [tab, n] of Object.entries(counts)) {
    const b = $(`#tab-${tab}`);
    const label = b.dataset.label || (b.dataset.label = b.textContent);
    b.innerHTML = `${escapeHtml(label)}<span class="tab-count">${n}</span>`;
  }
}

function srcIndex() {
  const m = new Map();
  (current?.sources || []).forEach((s, i) => m.set(s.id, i + 1));
  return m;
}
function srcById(id) { return (current?.sources || []).find((s) => s.id === id); }
// Only http(s) links are clickable: model- or API-supplied URLs must never
// become javascript:/data: hrefs (defense in depth — server already filters).
function safeUrl(u) { return /^https?:\/\//i.test(String(u || '')) ? u : '#'; }
function extLink(url, text, cls = '') {
  const safe = safeUrl(url);
  if (safe === '#') return `<span class="${cls}">${escapeHtml(text)}</span>`;
  return `<a class="${cls}" href="${escapeAttr(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
}
function chips(ids = []) {
  const idx = srcIndex();
  return [...new Set(ids || [])].filter((id) => idx.has(id)).map((id) => {
    const s = srcById(id);
    return `<button type="button" class="cite${selectedSource === id ? ' on' : ''}" data-src="${escapeAttr(id)}" aria-label="Source ${idx.get(id)}: ${escapeAttr((s.title || s.domain || '').slice(0, 80))}">${idx.get(id)}</button>`;
  }).join('');
}
/** Model prose → paragraphs (blank lines split, single newlines kept). */
function paras(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  return t.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}
function list(items) {
  if (!items || !items.length) return '';
  return `<ul>${items.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
}
function section(title, inner, cls = '') {
  return inner ? `<section class="block ${cls}"><h2 class="block-h">${escapeHtml(title)}</h2>${inner}</section>` : '';
}
const STATE_ORDER = ['strongly-supported', 'supported', 'plausible', 'disputed', 'weakly-supported', 'unsupported', 'contradicted', 'unknown'];
const STATE_LABEL = { 'strongly-supported': 'Strongly supported', supported: 'Supported', plausible: 'Plausible', disputed: 'Disputed', 'weakly-supported': 'Weakly supported', unsupported: 'Unsupported', contradicted: 'Contradicted', unknown: 'Unclear' };
function stateClass(st) {
  const s = String(st || '');
  return s === 'strongly-supported' ? 's-strong' : s === 'supported' ? 's-good' : s === 'plausible' ? 's-mid' : s === 'disputed' ? 's-warn' : /contradicted|unsupported|weakly/.test(s) ? 's-bad' : 's-none';
}
function tierInfo(s) {
  const t = s.tier;
  const kind = isPrimary(s) ? 'primary' : s.sourceType === 'paper' ? 'scholarly' : s.sourceType === 'book' ? 'book' : s.sourceType === 'social' ? 'social' : 'web';
  const cls = t == null ? 't-none' : t <= 1 ? 't-1' : t <= 2 ? 't-2' : t <= 4 ? 't-3' : 't-5';
  return { label: t == null ? `Unrated · ${kind}` : `Tier ${t} · ${kind}`, cls };
}
function accessLabel(s) {
  if (s.verified) return 'Read in full';
  return { full: 'Read in full', partial: 'Partial (URL context)', grounding: 'Search excerpt', 'metadata-only': 'Metadata only', unavailable: 'Not retrievable', unknown: 'Not fetched' }[s.accessibility] || (s.accessibility || 'Not fetched');
}
function confBar(claims) {
  if (!claims.length) return '';
  const counts = {};
  for (const c of claims) counts[c.state || 'unknown'] = (counts[c.state || 'unknown'] || 0) + 1;
  const order = [...STATE_ORDER.filter((k) => counts[k]), ...Object.keys(counts).filter((k) => !STATE_ORDER.includes(k))];
  return `<div class="conf" role="img" aria-label="Claim confidence: ${escapeAttr(order.map((k) => `${counts[k]} ${STATE_LABEL[k] || k}`).join(', '))}">
    <div class="conf-bar">${order.map((k) => `<span class="${stateClass(k)}" style="flex-grow:${counts[k]}"></span>`).join('')}</div>
    <div class="conf-legend" aria-hidden="true">${order.map((k) => `<span><i class="${stateClass(k)}"></i>${escapeHtml(STATE_LABEL[k] || k)} <b>${counts[k]}</b></span>`).join('')}</div>
  </div>`;
}
function empty(msg) { return `<div class="empty-state"><p>${escapeHtml(msg)}</p></div>`; }

function renderTab(tab) {
  const r = current;
  const el = $('#tabBody');
  if (!r || !r.task) { el.innerHTML = empty('No report loaded.'); return; }
  const rep = r.report;
  if (tab === 'report') {
    const findings = rep.findings || [];
    const verdict = (i) => {
      const v = (rep.verification || []).find((x) => x.n === i);
      if (!v) return '';
      const cls = v.supported === 'yes' ? 'ok' : v.supported === 'no' ? 'bad' : 'warn';
      const label = v.supported === 'yes' ? 'Cross-check: supported by cited passages' : v.supported === 'no' ? 'Cross-check: not supported by its citations — provisional' : 'Cross-check: partly supported — treat as provisional';
      return `<p class="verdict ${cls}"${v.note ? ` title="${escapeAttr(v.note)}"` : ''}>${label}</p>`;
    };
    el.innerHTML = `<article class="report">
      ${rep.synthesisFallback ? '<div class="callout warn"><b>Evidence inventory</b>Model synthesis was unavailable (quota). The sources and claims are real and cited — see Evidence and Sources.</div>' : ''}
      <div class="bottom-line"><span class="kicker">Bottom line</span>${paras(rep.executiveSummary) || '<p>No summary was produced.</p>'}</div>
      ${confBar(r.claims)}
      ${findings.length > 2 ? `<nav class="toc" aria-label="Contents"><span class="kicker muted">Contents</span><ol>${findings.map((f, i) => `<li><a href="#f-${i}" data-jump="f-${i}">${escapeHtml((f.heading || `Finding ${i + 1}`).slice(0, 100))}</a></li>`).join('')}</ol></nav>` : ''}
      ${findings.map((f, i) => `<section class="finding" id="f-${i}"><h2><span class="num">${i + 1}.</span> ${escapeHtml(f.heading || `Finding ${i + 1}`)}</h2>
        ${paras(f.body)}${(f.cite || []).length ? `<p class="cites"><span class="hint">Sources</span> ${chips(f.cite)}</p>` : ''}${verdict(i)}</section>`).join('')}
      ${(rep.timeline || []).length ? section('Chronology', `<div class="table-wrap"><table><thead><tr><th scope="col">Date</th><th scope="col">Event</th></tr></thead><tbody>${rep.timeline.map((t) => `<tr><td class="nowrap"><b>${escapeHtml(t.date || '')}</b></td><td>${escapeHtml(t.event || '')}</td></tr>`).join('')}</tbody></table></div>`) : ''}
      ${section('What we can establish', list(rep.established))}
      ${section('Competing explanations', list(rep.competing))}
      ${section('Still uncertain', list(rep.uncertainty))}
      ${section('Books and scholarship', list(rep.books))}
      ${section('Primary sources', list(rep.primarySources))}
      ${section('Source quality', paras(rep.sourceQuality))}
      ${section('Source independence', paras(rep.independence))}
    </article>`;
    $$('#tabBody [data-jump]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(a.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  } else if (tab === 'evidence') {
    const groups = STATE_ORDER.map((st) => [st, r.claims.filter((c) => (c.state || 'unknown') === st)]).filter(([, cs]) => cs.length);
    const other = r.claims.filter((c) => !STATE_ORDER.includes(c.state || 'unknown'));
    if (other.length) groups.push(['other', other]);
    const claimHtml = (c) => `<li class="claim"><p>${escapeHtml(c.text)}</p>
      ${c.confidenceWhy ? `<p class="hint">${escapeHtml(c.confidenceWhy)}</p>` : ''}
      <p class="cites">${(c.supporting || []).length ? `<span class="hint">Supports</span> ${chips(c.supporting)}` : '<span class="hint">No supporting source linked</span>'}${(c.contradicting || []).length ? ` <span class="hint sep">Contradicts</span> ${chips(c.contradicting)}` : ''}</p></li>`;
    el.innerHTML = `<div class="evidence">
      ${confBar(r.claims)}
      ${r.contradictions.length ? section(`Contradictions (${r.contradictions.length})`, `<ul class="claims">${r.contradictions.map((c) => `<li class="claim contra"><p><span class="tag s-warn">${escapeHtml(c.severity || 'flag')}</span> ${escapeHtml(c.against || c.text || '')}</p><p class="cites">${chips(c.sources)}</p></li>`).join('')}</ul>`) : '<p class="hint">No contradictions were flagged — absence of contradiction is not proof; see what remains uncertain in the report.</p>'}
      ${groups.map(([st, cs]) => section(`${STATE_LABEL[st] || 'Other'} (${cs.length})`, `<ul class="claims">${cs.map(claimHtml).join('')}</ul>`, `grp ${stateClass(st)}`)).join('') || empty('No claims were extracted.')}
      ${section('Contradictory evidence noted in the report', list(rep.contradictions))}
    </div>`;
  } else if (tab === 'sources') {
    if (!r.sources.length) { el.innerHTML = empty('No sources were gathered in this run.'); return; }
    const idx = srcIndex();
    const citeCount = new Map();
    const bump = (id) => citeCount.set(id, (citeCount.get(id) || 0) + 1);
    for (const f of rep.findings || []) for (const id of f.cite || []) bump(id);
    for (const c of r.claims) for (const id of [...(c.supporting || []), ...(c.contradicting || [])]) bump(id);
    const kinds = [
      ['all', 'All', () => true],
      ['web', 'Web', (s) => s.sourceType !== 'book' && s.sourceType !== 'paper'],
      ['academic', 'Academic', (s) => s.sourceType === 'paper'],
      ['books', 'Books', (s) => s.sourceType === 'book'],
      ['primary', 'Primary', isPrimary],
    ].map(([k, label, fn]) => [k, label, fn, r.sources.filter(fn).length]).filter(([k, , , n]) => k === 'all' || n);
    el.innerHTML = `<div class="src-tools">
        <div class="chips" role="group" aria-label="Source type">${kinds.map(([k, label, , n], i) => `<button type="button" class="chip${i === 0 ? ' on' : ''}" data-kind="${k}" aria-pressed="${i === 0}">${label}<span>${n}</span></button>`).join('')}</div>
        <div class="src-filters">
          <label class="search"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/></svg><span class="visually-hidden">Filter sources</span><input id="srcFilter" type="search" placeholder="Filter by title or domain"></label>
          <label class="pill-select"><span class="visually-hidden">Tier</span><select id="tierFilter"><option value="">Any tier</option><option value="2">Tier 1–2</option><option value="4">Tier 1–4</option></select></label>
        </div>
      </div>
      <p class="hint">Tiers grade the evidence, not the domain: tier 1 is primary evidence, tier 7 a social lead only. Book metadata is never counted as read text.</p>
      <ol class="src-list">${r.sources.map((s) => {
        const ti = tierInfo(s);
        const n = citeCount.get(s.id) || 0;
        return `<li class="src-row" data-id="${escapeAttr(s.id)}" data-kinds="${kinds.filter(([, , fn]) => fn(s)).map(([k]) => k).join(' ')}" data-tier="${escapeAttr(s.tier ?? 9)}" data-q="${escapeAttr(`${s.title || ''} ${s.domain || ''} ${s.author || ''}`.toLowerCase())}">
          <button type="button" class="src-num" data-src="${escapeAttr(s.id)}" aria-label="Show details for source ${idx.get(s.id)}">${idx.get(s.id)}</button>
          <div class="src-main">${extLink(s.url, s.title || s.url, 'src-title')}
            <span class="src-by">${escapeHtml([s.domain, s.author, s.publishedDate].filter(Boolean).join(' · '))}</span>
            ${s.passages[0]?.text ? `<span class="src-quote">“${escapeHtml(s.passages[0].text.slice(0, 220))}${s.passages[0].text.length > 220 ? '…' : ''}”</span>` : ''}
            ${(s.relatedCopies || []).length ? `<span class="hint">${s.relatedCopies.length} related cop${s.relatedCopies.length > 1 ? 'ies' : 'y'} — same underlying source, not independent confirmation</span>` : ''}</div>
          <div class="src-side"><span class="tag ${ti.cls}">${escapeHtml(ti.label)}</span><span class="hint">${escapeHtml(accessLabel(s))}</span></div>
          <span class="src-cited">${n ? `cited ${n}×` : ''}</span></li>`;
      }).join('')}</ol>
      <p id="srcEmpty" class="hint hidden">No sources match these filters.</p>`;
    let kind = 'all';
    const apply = () => {
      const q = $('#srcFilter').value.trim().toLowerCase();
      const maxTier = Number($('#tierFilter').value || 99);
      let shown = 0;
      $$('#tabBody .src-row').forEach((li) => {
        const ok = li.dataset.kinds.split(' ').includes(kind) && (!q || li.dataset.q.includes(q)) && Number(li.dataset.tier) <= maxTier;
        li.classList.toggle('hidden', !ok);
        if (ok) shown++;
      });
      $('#srcEmpty').classList.toggle('hidden', shown > 0);
    };
    $$('#tabBody .chip').forEach((c) => c.addEventListener('click', () => {
      kind = c.dataset.kind;
      $$('#tabBody .chip').forEach((x) => { x.classList.toggle('on', x === c); x.setAttribute('aria-pressed', String(x === c)); });
      apply();
    }));
    $('#srcFilter').addEventListener('input', apply);
    $('#tierFilter').addEventListener('change', apply);
  } else if (tab === 'method') {
    const st = r.stats;
    el.innerHTML = `<div class="method">
      <div class="stat-grid">
        <div><b>${escapeHtml(st.searchCalls ?? '–')}</b><span>searches</span></div>
        <div><b>${escapeHtml(st.fetches ?? '–')}</b><span>pages fetched</span></div>
        <div><b>${escapeHtml(st.modelCalls ?? '–')}</b><span>model calls</span></div>
        <div><b>${escapeHtml(fmtElapsed(st.runtimeMs || 0))}</b><span>runtime</span></div>
      </div>
      <p class="hint">Tokens in/out ${(st.tokensIn || 0).toLocaleString()} / ${(st.tokensOut || 0).toLocaleString()} (API-reported)${st.escalated ? ' · escalated after sources disagreed' : ''}${st.keyRotations ? ` · ${st.keyRotations} key rotation(s)` : ''}${st.quotaWaitMs ? ` · ${Math.round(st.quotaWaitMs / 1000)}s waiting for quota` : ''}</p>
      ${section('Methodology', paras(rep.methodology))}
      ${r.stanceDisclosure ? section('Stance', paras(r.stanceDisclosure)) : ''}
      ${section('Research passes', (r.iterations || []).length ? `<ol>${r.iterations.map((i) => `<li>Gaps: ${escapeHtml((i.gaps || []).join('; ') || 'none')}${i.sufficient ? ' — judged sufficient' : ''}</li>`).join('')}</ol>` : '')}
      ${section('Research gaps', list(rep.gaps))}
      ${st.phases && Object.keys(st.phases).length ? section('Time per stage', `<p class="hint">${Object.entries(st.phases).map(([k, v]) => `${escapeHtml(k)} ${(v / 1000).toFixed(1)}s`).join(' · ')}</p>`) : ''}
      ${st.fetchIssues && Object.keys(st.fetchIssues).length ? section('Pages that could not be read', `<p class="hint">${Object.entries(st.fetchIssues).map(([k, v]) => `${escapeHtml(v)}× ${escapeHtml(k)}`).join(' · ')} — never bypassed.</p>`) : ''}
      ${r.claims.length ? section('Claim → source graph', '<p class="hint">Up to 8 claims. Lines show supports and contradicts; a dashed hollow circle is derived from another source.</p><svg class="graph" id="g" role="img" aria-label="Claim to source graph"></svg>') : ''}
      ${(rep.appendix || []).length ? `<details class="appendix"><summary>Evidence appendix — every claim with its sources (${rep.appendix.length})</summary><ol>${rep.appendix.map((a) => `<li><span class="tag ${stateClass(a.state)}">${escapeHtml(STATE_LABEL[a.state] || a.state)}</span> ${escapeHtml(a.text)}${a.why ? `<br><span class="hint">${escapeHtml(a.why)}</span>` : ''}<br><span class="hint">Supports:</span> ${(a.supporting || []).map((s) => extLink(s.url, s.title)).join(' · ') || '<i>none listed</i>'}${(a.contradicting || []).length ? `<br><span class="hint">Contradicts:</span> ${a.contradicting.map((s) => extLink(s.url, s.title)).join(' · ')}` : ''}</li>`).join('')}</ol></details>` : ''}
    </div>`;
    if (r.claims.length) drawGraph();
  }
  renderRail();
}

// Citation chips anywhere in the result open that source in the rail.
$('#resultView').addEventListener('click', (e) => {
  const b = e.target.closest('[data-src]');
  if (b) { selectSource(b.dataset.src === selectedSource && !b.classList.contains('src-num') ? null : b.dataset.src); return; }
  if (e.target.closest('#railClose')) { selectSource(null); return; }
  const go = e.target.closest('[data-goto]');
  if (go) activateTab($(`#tab-${go.dataset.goto}`));
});
function selectSource(id) {
  selectedSource = id;
  $$('#tabBody .cite').forEach((c) => c.classList.toggle('on', c.dataset.src === id));
  $$('#tabBody .src-row').forEach((c) => c.classList.toggle('on', c.dataset.id === id));
  renderRail();
  if (id) $('#railClose')?.focus({ preventScroll: true });
}
function renderRail() {
  const r = current;
  const rail = $('#rail');
  if (!r) { rail.innerHTML = ''; return; }
  const s = selectedSource ? srcById(selectedSource) : null;
  rail.classList.toggle('sheet-open', !!s);
  let card = '';
  if (s) {
    const idx = srcIndex().get(s.id);
    const ti = tierInfo(s);
    const findingsCiting = (r.report.findings || []).map((f, i) => ((f.cite || []).includes(s.id) ? i + 1 : 0)).filter(Boolean);
    const claimsSupported = r.claims.filter((c) => (c.supporting || []).includes(s.id)).length;
    const claimsContra = r.claims.filter((c) => (c.contradicting || []).includes(s.id)).length;
    const usage = [findingsCiting.length ? `Cited in finding${findingsCiting.length > 1 ? 's' : ''} ${findingsCiting.join(', ')}` : '', claimsSupported ? `supports ${claimsSupported} claim${claimsSupported > 1 ? 's' : ''}` : '', claimsContra ? `contradicts ${claimsContra}` : ''].filter(Boolean).join(' · ');
    card = `<div class="src-card" role="region" aria-label="Source ${idx}">
      <div class="src-card-head"><span class="mono accent">Source ${idx}</span><button id="railClose" type="button" class="icon-btn small" aria-label="Close source details"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></div>
      <div class="tags"><span class="tag ${ti.cls}">${escapeHtml(ti.label)}</span><span class="tag">${escapeHtml(accessLabel(s))}</span></div>
      <strong class="src-card-title">${escapeHtml(s.title || s.url)}</strong>
      <span class="hint">${escapeHtml([s.domain, s.author, s.publishedDate].filter(Boolean).join(' · '))}</span>
      ${s.passages[0]?.text ? `<blockquote>“${escapeHtml(s.passages[0].text.slice(0, 600))}${s.passages[0].text.length > 600 ? '…' : ''}”</blockquote>` : '<p class="hint">No passage was retrieved for this source.</p>'}
      ${s.tierReason ? `<p class="hint">${escapeHtml(s.tierReason)}</p>` : ''}
      ${s.note ? `<p class="hint">${escapeHtml(s.note)}</p>` : ''}
      ${usage ? `<p class="hint">${escapeHtml(usage)}</p>` : ''}
      ${safeUrl(s.url) !== '#' ? `<a class="ext-link" href="${escapeAttr(s.url)}" target="_blank" rel="noopener noreferrer">Open source <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></a>` : ''}
    </div>`;
  }
  const unc = (r.report.uncertainty || []).slice(0, 4);
  const glance = `<div class="glance">
    <span class="kicker muted">Still uncertain</span>
    ${unc.length ? list(unc) : '<p class="hint">Nothing flagged.</p>'}
    ${r.contradictions.length ? `<button type="button" class="link-btn" data-goto="evidence">${r.contradictions.length} contradiction${r.contradictions.length > 1 ? 's' : ''} → Evidence</button>` : ''}
    <p class="hint rail-tip">Select a numbered citation to see the passage behind it.</p>
  </div>`;
  rail.innerHTML = card + glance;
}

function drawGraph() {
  const svg = $('#g');
  if (!svg || !current) return;
  const claims = current.claims.slice(0, 8);
  const rels = [];
  claims.forEach((c, i) => {
    (c.supporting || []).slice(0, 3).forEach((sid) => rels.push({ c: i, sid, k: 'supports' }));
    (c.contradicting || []).slice(0, 2).forEach((sid) => rels.push({ c: i, sid, k: 'contradicts' }));
  });
  const idx = srcIndex();
  const srcIds = [...new Set(rels.map((x) => x.sid))].filter((sid) => srcById(sid)).slice(0, 14);
  const W = 900;
  const H = Math.max(240, 50 + Math.max(claims.length, srcIds.length) * 36);
  const pos = {};
  const spread = (n, i) => 25 + (i + 0.5) * ((H - 50) / Math.max(n, 1));
  claims.forEach((c, i) => { pos['c' + i] = [150, spread(claims.length, i)]; });
  srcIds.forEach((sid, i) => { pos[sid] = [600, spread(srcIds.length, i)]; });
  const derived = new Set((current.relations || []).filter((x) => x.kind === 'derived_from').map((x) => x.from));
  const tierClass = (t) => (t <= 2 ? 'g-t-hi' : t <= 4 ? 'g-t-mid' : 'g-t-lo');
  let s = '';
  for (const x of rels) {
    const a = pos['c' + x.c]; const p = pos[x.sid]; if (!a || !p) continue;
    s += `<line x1="${a[0] + 135}" y1="${a[1]}" x2="${p[0] - 11}" y2="${p[1]}" class="${x.k === 'contradicts' ? 'g-bad' : 'g-ok'}"/>`;
  }
  claims.forEach((c, i) => {
    const [x, y] = pos['c' + i];
    const text = String(c.text || '');
    s += `<g><title>${escapeHtml(text)}</title><rect x="${x - 135}" y="${y - 14}" width="270" height="28" rx="6" class="g-claim ${stateClass(c.state)}"/><text x="${x}" y="${y + 4}" text-anchor="middle" class="g-label">${escapeHtml(text.length > 40 ? text.slice(0, 39) + '…' : text)}</text></g>`;
  });
  srcIds.forEach((sid) => {
    const src = srcById(sid); const [x, y] = pos[sid];
    s += `<g><title>${escapeHtml(src?.title || sid)}</title><circle cx="${x}" cy="${y}" r="9" class="${derived.has(sid) ? 'g-derived' : tierClass(src?.tier ?? 9)}"/><text x="${x + 17}" y="${y + 4}" class="g-src">${idx.get(sid)}. ${escapeHtml((src?.domain || sid).slice(0, 30))}</text></g>`;
  });
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = s;
}

// ---------- export ----------
$$('#exportMenu [data-exp]').forEach((b) => b.addEventListener('click', async () => {
  $('#exportMenu').open = false;
  if (!current) return;
  const fmt = b.dataset.exp;
  const ext = fmt === 'html' ? 'html' : fmt === 'json' ? 'json' : 'md';
  const name = `research-${String(current.id || 'report').replace(/[^\w-]/g, '').slice(0, 40)}.${ext}`;
  // Client-side render first (works for every result, including ones the
  // server never saved); fall back to the server export if the shared
  // module is not reachable from this host.
  try {
    let text;
    if (fmt === 'json') text = JSON.stringify(current, null, 2);
    else {
      const { exportMarkdown, exportHtml } = await import(`../backend/src/export.js${staticSuffix()}`);
      text = fmt === 'html' ? exportHtml(current) : exportMarkdown(current);
    }
    const type = fmt === 'json' ? 'application/json' : fmt === 'html' ? 'text/html' : 'text/markdown';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch {
    if (staticMode) { showNotice('Export failed in this browser — try the raw data export.', 'error'); return; }
    window.open(`/api/export/${encodeURIComponent(current.id)}?format=${fmt}`, '_blank', 'noopener');
  }
}));
$('#printBtn').addEventListener('click', () => {
  if (!current) return;
  activateTab($('#tab-report'), false);
  setTimeout(() => window.print(), 60); // print dialog → Save as PDF
});

// ---------- keys dialog (edits a draft; storage changes only on save) ----------
let keyDraft = [];
let keyReturnFocus = null;
function openKeyDialog() {
  if ($('#keyDialog').open) return;
  closeNav();
  keyReturnFocus = document.activeElement;
  keyDraft = getStoredKeys();
  if (!keyDraft.length) keyDraft = [''];
  $('#modelInput').value = getStoredModel();
  updateModelHint($('#modelInput').value);
  setKeyStatus('');
  renderKeyList();
  $('#keyDialog').showModal();
  $('#keyList input')?.focus();
}
$('#keyDialog').addEventListener('close', () => { keyReturnFocus?.focus?.({ preventScroll: true }); });
function syncDraftFromInputs() { keyDraft = $$('#keyList input').map((i) => i.value); }
function renderKeyList(status = []) {
  const container = $('#keyList');
  container.innerHTML = keyDraft.map((k, i) => `
    <div class="key-item">
      <label class="visually-hidden" for="key-${i}">Gemini API key ${i + 1}</label>
      <input id="key-${i}" type="password" value="${escapeAttr(k)}" placeholder="AIza…" autocomplete="off" spellcheck="false">
      ${status[i] ? `<span class="key-state ${status[i].cls}">${escapeHtml(status[i].text)}</span>` : ''}
      <button type="button" class="icon-btn" data-toggle="${i}" aria-label="Show key ${i + 1}" aria-pressed="false">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
      <button type="button" class="icon-btn" data-remove="${i}" aria-label="Remove key ${i + 1}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/></svg>
      </button>
    </div>`).join('') || '<p class="hint">No keys yet — add one to run research.</p>';
  $('#addKey').disabled = keyDraft.length >= 5;
  container.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', () => {
    syncDraftFromInputs();
    keyDraft.splice(Number(btn.dataset.remove), 1);
    renderKeyList();
  }));
  container.querySelectorAll('[data-toggle]').forEach((btn) => btn.addEventListener('click', () => {
    const inp = $(`#key-${btn.dataset.toggle}`);
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} key ${Number(btn.dataset.toggle) + 1}`);
  }));
}
function setKeyStatus(msg, kind = '') {
  const el = $('#keyStatus');
  el.textContent = msg;
  el.className = 'key-status' + (kind ? ' ' + kind : '') + (msg ? '' : ' hidden');
}
/** Split pasted "k1, k2" / newline / JSON-array input into clean unique keys. */
function parseKeyInputs(values) {
  const keys = [];
  for (const raw0 of values) {
    const raw = String(raw0 || '').trim();
    if (!raw) continue;
    if (raw.startsWith('[')) {
      try { for (const k of JSON.parse(raw)) keys.push(String(k || '').trim()); continue; } catch { /* treat as text */ }
    }
    keys.push(...raw.split(/[\s,;]+/));
  }
  return [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
}
/** Validate keys: via the server when present, else directly against Google
 *  (ListModels — no generation quota). Returns per-key results or null. */
async function validateKeys(keys) {
  if (!staticMode) {
    try {
      const res = await fetch('/api/keys/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys }) });
      const data = await res.json().catch(() => ({}));
      if (Array.isArray(data.results)) return data.results;
    } catch { /* fall through to direct check */ }
  }
  try {
    return await Promise.all(keys.map(async (key) => {
      const masked = key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : `${key.slice(0, 2)}…`;
      if (!/^AIza[\w-]{20,}$/.test(key)) return { valid: false, masked, error: 'not a Gemini key' };
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key }, signal: ctrl.signal });
        if (res.ok) return { valid: true, masked };
        if (res.status === 429) return { valid: true, masked, warning: 'quota exceeded right now' };
        return { valid: false, masked, error: res.status === 400 ? 'invalid key' : `HTTP ${res.status}` };
      } finally { clearTimeout(t); }
    }));
  } catch {
    return null; // offline — save unvalidated; the run will report problems
  }
}
$('#keyBtn').addEventListener('click', openKeyDialog);
$('#keyBtnMobile').addEventListener('click', openKeyDialog);
$('#closeKey').addEventListener('click', () => $('#keyDialog').close());
$('#closeKeyX').addEventListener('click', () => $('#keyDialog').close());
$('#addKey').addEventListener('click', () => {
  syncDraftFromInputs();
  if (keyDraft.length >= 5) return;
  keyDraft.push('');
  renderKeyList();
  const inputs = $$('#keyList input');
  inputs[inputs.length - 1]?.focus();
});
$('#keyForm').addEventListener('submit', async (e) => {
  e.preventDefault(); // keep the dialog open while validating
  syncDraftFromInputs();
  let keys = parseKeyInputs(keyDraft).slice(0, 5);
  const model = $('#modelInput').value || '';
  const saveModel = () => { lsSet('gemini_model', model); updateKeyStatus(); };
  if (!keys.length) {
    // Model-only save is fine when the server has its own key.
    if (!staticMode && serverKey) { setStoredKeys([]); saveModel(); $('#keyDialog').close(); showNotice('Saved — using the server\'s key.', ''); return; }
    setKeyStatus('Add at least one Gemini API key.', 'error');
    $('#keyList input')?.focus();
    return;
  }
  const saveBtn = $('#saveKey');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Checking…';
  setKeyStatus(`Checking ${keys.length} key${keys.length > 1 ? 's' : ''} with Google…`);
  try {
    const results = await validateKeys(keys);
    let note = '';
    if (results) {
      keyDraft = keys.slice();
      renderKeyList(results.map((r) => (r?.valid ? { cls: r.warning ? 'warn' : 'ok', text: r.warning ? 'over quota' : '✓ working' } : { cls: 'bad', text: r?.error || 'invalid' })));
      const valid = keys.filter((_, i) => results[i]?.valid);
      const invalid = results.filter((r) => !r?.valid).length;
      if (!valid.length) {
        setKeyStatus('None of these keys work. Check them and try again.', 'error');
        return;
      }
      keys = valid;
      const warned = results.filter((r) => r?.valid && r.warning).length;
      note = invalid ? `Saved ${valid.length} working key${valid.length > 1 ? 's' : ''}; removed ${invalid} that did not work.`
        : warned ? `Saved ${valid.length} key${valid.length > 1 ? 's' : ''}. ${warned} currently over quota — they work again after the limit resets.`
          : `Connected — ${valid.length} working key${valid.length > 1 ? 's' : ''}.`;
    } else {
      note = `Saved ${keys.length} key${keys.length > 1 ? 's' : ''} without checking (offline).`;
    }
    setStoredKeys(keys);
    saveModel();
    $('#keyDialog').close();
    showNotice(note, '');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Validate & save';
  }
});
$('#forgetKey').addEventListener('click', () => {
  if (!confirm('Remove all saved API keys and the model choice from this browser?')) return;
  setStoredKeys([]);
  lsDel('gemini_model');
  keyDraft = [''];
  $('#modelInput').value = '';
  updateModelHint('');
  updateKeyStatus();
  renderKeyList();
  setKeyStatus('All keys removed from this browser.');
});

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

init();
