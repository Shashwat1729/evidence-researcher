// Frontend app: ask → SSE progress → tabbed dashboard → export. No build step.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let current = null;
if (typeof window !== 'undefined') window.__setCurrentForScreenshot = (r) => { current = normalizeResult(r); try { showView('result'); renderResultHeader(); renderTab('overview'); } catch {} };
let serverKey = false;
let staticMode = false;
let currentTab = 'overview';
// Static cache-busting version. MUST match ENGINE_V in direct.js (enforced by
// tests/static-version.test.js). Bump both on any static-mode change so Pages
// visitors never run a stale engine bundle (stale bundles caused confusing
// "process is not defined" errors after deploys).
const STATIC_V = '2026-09-24a';
const staticSuffix = () => (typeof window === 'undefined' ? '' : `?v=${STATIC_V}`);

const MODE_BLURB = {
  quick: 'Quick: ~2 searches, about 1–2 minutes. Basic verification; escalates automatically if sources disagree.',
  standard: 'Standard: ~10 searches + academic/books. Usually a few minutes; waits out rate limits for up to ~25 min.',
  deep: 'Deep: ~24 searches, books, primary sources and provenance. Up to ~45 min on free-tier quota.',
  exhaustive: 'Exhaustive: ~50 searches, documentary-grade. Up to ~90 min and the heaviest API use.',
};

function recommendMode(q) {
  const t = String(q || '').trim();
  if (t.length < 4) return '';
  if (/^(when|who|where|what year|how many)\b/i.test(t) && t.length < 90)
    return 'Looks focused and factual — Quick should do.';
  if (/why|causes?|collapse|compar|vs\.?|history of|explain|debate|controvers|myth/i.test(t) || t.length > 140)
    return 'Looks like a deep investigation — consider Deep or Exhaustive.';
  return 'Standard is a good default.';
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
  updateKeyBadge();
}
function getStoredModel() { return lsGet('gemini_model', '') || ''; }
function updateKeyBadge() {
  const n = getStoredKeys().length;
  $('#keyCount').textContent = String(n);
  $('#keyCount').classList.toggle('hidden', n === 0);
}

function getHistory() {
  try { const h = JSON.parse(lsGet('er_history', '[]')); return Array.isArray(h) ? h : []; } catch { return []; }
}
function recordHistory(r) {
  if (!r?.id || !r.task) return;
  // De-duplicated by id: reopening a run from history must not add it again.
  const hist = getHistory().filter((h) => h.id !== r.id);
  hist.unshift({ id: r.id, question: r.task.question, mode: r.task.mode, at: r.completedAt, sources: (r.sources || []).length, ...(staticMode ? { direct: true } : {}) });
  lsSet('er_history', JSON.stringify(hist.slice(0, 100)));
}

// ---------- views ----------
const VIEWS = ['askView', 'progressView', 'resultView', 'historyView'];
function showView(name) {
  const id = `${name}View`;
  for (const v of VIEWS) $('#' + v).classList.toggle('hidden', v !== id);
  window.scrollTo?.({ top: 0 });
}

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
  // Populate model selectors (shared: server list wins, static falls back
  // to the backend catalog so the picker works on Pages too). Runs OUTSIDE
  // the fetch try/catch: a 404 HTML page makes .json() throw, which used to
  // skip this entire block on Pages (picker stayed Auto-only forever).
  const populateModels = (models) => {
    const opts = models.map((m) => `<option value="${escapeAttr(m.id)}">${escapeHtml(m.label)}</option>`).join('');
    $('#modelSelect').innerHTML = '<option value="">Auto model</option>' + opts;
    $('#modelInput').innerHTML = '<option value="">Auto (per-task optimal)</option>'
      + models.map((m) => `<option value="${escapeAttr(m.id)}">${escapeHtml(m.label)} — ${escapeHtml(m.blurb || '')}</option>`).join('');
    // Drop retired saved ids (e.g. gemini-2.0-flash-lite): a stale picker
    // value would otherwise send a dead model id and fail every run.
    const savedModel = getStoredModel();
    if (savedModel && models.some((m) => m.id === savedModel)) {
      $('#modelSelect').value = savedModel;
      $('#modelInput').value = savedModel;
    } else if (savedModel) {
      lsDel('gemini_model');
    }
  };
  if (cfg && Array.isArray(cfg.models) && cfg.models.length) {
    populateModels(cfg.models);
  } else {
    // Static Pages mode has no /api/config: load the SAME backend catalog
    // the engine uses (single source of truth — never a hardcoded copy).
    try {
      const { AVAILABLE_MODELS } = await import(`../backend/src/config.js${staticSuffix()}`);
      if (Array.isArray(AVAILABLE_MODELS) && AVAILABLE_MODELS.length) populateModels(AVAILABLE_MODELS);
    } catch { /* Auto only — the engine default still works */ }
  }
  staticMode = !apiOk;
  $('#staticBanner').classList.toggle('hidden', !staticMode);
  const buildTag = $('#buildTag');
  if (buildTag) buildTag.textContent = `build ${STATIC_V}`;
  const updateCost = () => { $('#costNote').textContent = MODE_BLURB[val('mode')] || ''; };
  $$('input[name=mode]').forEach((r) => r.addEventListener('change', updateCost));
  updateCost();
  const updateHint = () => {
    $('#modeHint').textContent = recommendMode($('#q').value);
    $('#qCount').textContent = `${$('#q').value.length} / 5000`;
  };
  $('#q').addEventListener('input', updateHint);
  updateHint();
  $('#serverKeyNote').textContent = staticMode
    ? 'Static mode: this page runs entirely in your browser with your own key — no server involved.'
    : serverKey
      ? `The server has a Gemini key configured${hasFallback ? ' (plus a fallback key)' : ''}. Keys you add here override it for this browser only.`
      : 'No server-side key is configured — add your Gemini key to run research.';
  updateKeyBadge();
  $('#modelSelect').addEventListener('change', () => {
    const v = $('#modelSelect').value;
    lsSet('gemini_model', v);
    $('#modelInput').value = v;
    updateModelHint(v);
  });
  $('#modelInput').addEventListener('change', () => updateModelHint($('#modelInput').value));
  updateModelHint(getStoredModel());
  // Deep links from history (#run=<id>) survive reloads on the static host.
  const m = location.hash.match(/^#run=([\w-]+)$/);
  if (m) openRun(m[1], !!getHistory().find((h) => h.id === m[1] && h.direct));
}

function updateModelHint(value) {
  const hint = $('#modelHint');
  if (!hint) return;
  hint.classList.toggle('hidden', !!value);
  if (!value) hint.textContent = 'Auto uses Flash-Lite (latest) for planning and analysis and Gemini 2.5 Flash for search and writing — two separate quota buckets. If a picked model is unavailable on your key, the run falls back to Flash with a warning.';
}

function val(name) { return document.querySelector(`input[name=${name}]:checked`)?.value || ''; }

let running = false;
let currentAbort = null;
$('#askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  startFromForm();
});
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); startFromForm(); }
});
function startFromForm() {
  if (running) return; // one run at a time — parallel runs would burn quota
  const question = $('#q').value.trim();
  if (question.length < 3) {
    showNotice('Enter a research question (at least 3 characters).', 'error');
    $('#q').focus();
    return;
  }
  if (staticMode && !getStoredKeys().length) {
    showNotice('Static mode needs a Gemini API key — add one to start (it stays in this browser).', 'error');
    openKeyDialog();
    return;
  }
  running = true;
  $('#start').disabled = true;
  run({ question, mode: val('mode'), stance: val('stance'), hypothesis: $('#hyp').value.trim(), documentary: $('#docu').checked, fresh: $('#fresh').checked, model: getStoredModel() || undefined });
}

function showNotice(msg, kind = '') {
  const n = $('#notice');
  $('#noticeText').textContent = msg;
  n.className = 'notice' + (kind ? ' ' + kind : '');
  n.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}
function hideNotice() { $('#notice').classList.add('hidden'); }
$('#noticeClose').addEventListener('click', hideNotice);

// Home navigation: progress/result/history → ask view, controls reset,
// question text preserved. The single safe landing for cancel + errors.
function goHome(notice, kind = '') {
  running = false;
  currentAbort = null;
  $('#start').disabled = false;
  $('#skeleton').classList.add('hidden');
  setBar(0);
  $('#progressView').setAttribute('aria-busy', 'false');
  showView('ask');
  if (notice) showNotice(notice, kind);
  else hideNotice();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

function setBar(pct) {
  $('#progressFill').style.width = pct + '%';
  $('.progress-bar').setAttribute('aria-valuenow', String(Math.round(pct)));
}

// Pipeline phases in order, with the display title and bar anchor each maps to.
// The bar only ever reflects reached milestones — never guesses ahead.
const PHASES = {
  plan: ['Planning research…', 8],
  search: ['Searching the web…', 28],
  read: ['Reading sources…', 48],
  analyze: ['Analyzing evidence…', 66],
  provenance: ['Checking independence…', 78],
  synthesize: ['Writing report…', 90],
  verify: ['Verifying citations…', 96],
  done: ['Complete', 100],
};
const PHASE_ORDER = Object.keys(PHASES);

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtNum(n) {
  n = n || 0;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function run(body) {
  hideNotice();
  showView('progress');
  $('#progressTitle').textContent = 'Researching…';
  $('#progressQuestion').textContent = body.question;
  setBar(4);
  $('#steps').innerHTML = '';
  $('#liveStats').innerHTML = '';
  $('#skeleton').classList.remove('hidden');
  $('#progressView').setAttribute('aria-busy', 'true');
  $$('#phaseTrack li').forEach((li) => li.classList.remove('done', 'active'));
  const t0 = Date.now();
  const live = { stats: null, sources: 0, claims: 0, phase: 'plan', bar: 4, stepped: false, gotResult: false, gotError: false };
  const renderLive = () => {
    const s = live.stats || {};
    const cells = [['Elapsed', fmtElapsed(Date.now() - t0)]];
    if (s.searchCalls) cells.push(['Searches', s.searchCalls]);
    if (live.sources) cells.push(['Sources', live.sources]);
    if (live.claims) cells.push(['Claims', live.claims]);
    if (s.modelCalls) cells.push(['Model calls', s.modelCalls]);
    const tok = (s.tokensIn || 0) + (s.tokensOut || 0);
    if (tok) cells.push(['Tokens', fmtNum(tok)]);
    $('#liveStats').innerHTML = cells.map(([k, v]) => `<span><b>${escapeHtml(v)}</b>${escapeHtml(k)}</span>`).join('');
  };
  const setPhase = (phase) => {
    if (!phase || !PHASES[phase]) return;
    live.phase = phase;
    $('#progressTitle').textContent = PHASES[phase][0];
    live.bar = Math.max(live.bar, PHASES[phase][1]);
    setBar(live.bar);
    const idx = PHASE_ORDER.indexOf(phase);
    $$('#phaseTrack li').forEach((li) => {
      const i = PHASE_ORDER.indexOf(li.dataset.phase);
      li.classList.toggle('done', i < idx || phase === 'done');
      li.classList.toggle('active', i === idx);
    });
  };
  setPhase('plan');
  renderLive();
  const timer = setInterval(renderLive, 1000);
  const step = (cls, text) => {
    if (!live.stepped) { live.stepped = true; $('#skeleton').classList.add('hidden'); }
    const d = document.createElement('div');
    d.className = 'step';
    d.innerHTML = `<span class="dot ${cls}" aria-hidden="true">${cls === 'ok' ? '✓' : cls === 'warn' ? '!' : '→'}</span><span>${escapeHtml(text)}</span>`;
    const steps = $('#steps');
    const nearBottom = steps.scrollHeight - steps.scrollTop - steps.clientHeight < 60;
    steps.appendChild(d);
    // Keep only the newest 400 lines: long exhaustive runs stay responsive.
    while (steps.childElementCount > 400) steps.firstElementChild.remove();
    if (nearBottom) steps.scrollTop = steps.scrollHeight;
    return d;
  };
  // Hooks shared with handleEvent so both SSE and static runs update one UI.
  const hooks = {
    onPhase: setPhase,
    onResult: () => { live.gotResult = true; },
    onError: () => { live.gotError = true; },
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
    currentAbort = null;
    $('#start').disabled = false;
    $('#skeleton').classList.add('hidden');
    $('#progressView').setAttribute('aria-busy', 'false');
  };
  // Cancel handler — aborting the fetch triggers server-side cancellation
  // via the isCancelled refcount (no extra endpoint needed), then home.
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
  // Build headers with multi-key and model support
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
      const res = await fetch('/api/research', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      // 429 from our own server (per-IP limiter or busy upstream): honor
      // Retry-After (header or JSON body), else a short jittered wait.
      if (res.status === 429 && attempts < maxAttempts) {
        const e = await res.json().catch(() => ({}));
        const retryAfter = parseInt(res.headers.get('Retry-After') || '', 10) || Number(e.retryAfter) || 0;
        const waitMs = retryAfter ? Math.min(retryAfter, 120) * 1000 : (8000 + Math.floor(Math.random() * 4000));
        step('run', `Server is rate-limiting — retrying in ${Math.ceil(waitMs / 1000)}s…`);
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
        step('run', `Retrying in ${Math.ceil(waitMs / 1000)}s…`);
        try { await asleep(waitMs); } catch { finish(); return; }
        return doFetch();
      }
      finish();
      goHome('Network error: ' + e.message + '. Check your connection, then retry — your question is kept.', 'error');
    }
  };
  doFetch();
}

// Static-mode run: same engine, executed in-page via frontend/direct.js.
async function runDirectFlow(body, step, finish, signal, keys = [], model = '', hooks = {}) {
  if (!keys.length) {
    const msg = 'Static mode needs a Gemini API key — open Keys to add one (stored in this browser only).';
    step('warn', msg);
    finish();
    goHome(msg, 'error');
    openKeyDialog();
    return;
  }
  if (signal?.aborted) { finish(); goHome(); return; }
  try {
    const { runDirect, saveLocalResult } = await import(`./direct.js${staticSuffix()}`);
    step('run', `Running in your browser with ${keys.length} key${keys.length > 1 ? 's' : ''}${model ? ` · model ${model}` : ''}…`);
    const result = await runDirect({ ...body, model: model || body.model }, { key: keys, emit: (ev) => handleEvent(ev, step, hooks), signal });
    if (signal?.aborted) return; // cancel already navigated home
    finish();
    const saved = saveLocalResult(result);
    showResult(result);
    if (!saved) showNotice('This report is too large to keep in browser storage — export it (Markdown/HTML/JSON) to keep a copy.', '');
  } catch (e) {
    finish();
    if (signal?.aborted || e.name === 'AbortError' || e.code === 'CANCELLED') return;
    const raw = e.message || 'research failed';
    // Distinguish daily quota vs per-minute vs no evidence. Be blunt about
    // same-project keys: rotation across keys that share one project quota
    // changes nothing, and "wait a minute" is wrong advice for daily limits.
    let msg = raw;
    if (/RPD|daily quota|billing/i.test(raw)) msg = 'Daily Gemini quota exhausted (resets at midnight Pacific). Add a key from a different project or a billed project, or try Quick mode, which uses fewer calls.';
    else if (/quota|rate|429/i.test(raw)) msg = `All ${keys.length} saved key(s) are rate-limited. Keys from the same Google Cloud project share one quota — extra keys only help when each comes from a different project. Per-minute limits reset in ~1 min; daily limits at midnight PT.`;
    else if (/API key|key not valid|401|403/i.test(raw)) msg = 'Gemini rejected the API key. Check it under Keys and try again.';
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
    // message instead of stranding the user on the progress view.
    // (If a result already rendered, leave it alone.)
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
    if (ev.message && /cache|joined/i.test(ev.message)) step('ok', ev.message);
    return showResult(ev.result);
  }
  if (ev.type === 'plan') {
    step('ok', 'Research plan created');
    if (ev.plan) step('', `Domain: ${ev.plan.domain} · complexity: ${ev.plan.complexity}`);
    return;
  }
  if (ev.type === 'sources' || ev.type === 'claims') return step('ok', ev.message);
  step(ev.type === 'warning' ? 'warn' : ev.type === 'done' ? 'ok' : 'run', ev.message || ev.type);
}

// ---------- dashboard ----------
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
  if (record) recordHistory(current);
  showView('result');
  // Fallback inventory banner: synthesis used evidence inventory due to quota.
  // NOTE: do NOT call step() here — showResult is also driven by SSE
  // handleEvent where step is not in scope; step-in-showResult crashed Pages
  // with "step is not defined" and left the user on a blank home view.
  if (current.report.synthesisFallback) {
    showNotice('Model quota was hit — this report is an evidence inventory built from the gathered sources. Add keys from other projects or try Quick mode for a full write-up.', '');
  } else {
    hideNotice();
  }
  renderResultHeader();
  const first = $('#tab-overview');
  activateTab(first, false);
  if (current.id) history.replaceState(null, '', `#run=${encodeURIComponent(current.id)}`);
}

function renderResultHeader() {
  const r = current;
  if (!r) return;
  $('#resultQuestion').textContent = r.task.question || 'Untitled research';
  const pills = [
    `<span class="pill">${escapeHtml(r.task.mode || '')}</span>`,
    `<span class="pill">${escapeHtml(r.task.stance || 'neutral')}</span>`,
    `<span class="pill">${r.sources.length} sources</span>`,
    `<span class="pill">${r.claims.length} claims</span>`,
    r.completedAt ? `<span class="pill ghost">${escapeHtml(fmtDate(r.completedAt))}</span>` : '',
    r.report.synthesisFallback ? '<span class="pill warn">evidence inventory</span>' : '',
  ];
  $('#resultMeta').innerHTML = pills.join('');
  const counts = {
    claims: r.claims.length,
    sources: r.sources.length,
    books: r.sources.filter((s) => s.sourceType === 'book').length,
    academic: r.sources.filter((s) => s.sourceType === 'paper').length,
    primary: r.sources.filter(isPrimary).length,
    contra: r.contradictions.length,
  };
  for (const [tab, n] of Object.entries(counts)) {
    const b = $(`#tab-${tab}`);
    if (!b) continue;
    const label = b.dataset.label || (b.dataset.label = b.textContent);
    b.innerHTML = `${escapeHtml(label)}<span class="tab-count">${n}</span>`;
  }
}

const isPrimary = (s) => s.proximity === 'primary' || s.tier === 1;
function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function srcById(id) { return (current?.sources || []).find((s) => s.id === id); }
// Only http(s) links are clickable: model- or API-supplied URLs must never
// become javascript:/data: hrefs (defense in depth — server already filters).
function safeUrl(u) { return /^https?:\/\//i.test(String(u || '')) ? u : '#'; }
function extLink(url, text) {
  return `<a href="${escapeAttr(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
}
function srcLink(id) {
  const s = srcById(id);
  return s ? extLink(s.url, s.title || s.domain || s.url) : '<i>unknown source</i>';
}
/** Model prose → paragraphs (blank lines split, single newlines kept). */
function paras(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  return t.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

/** Section list that hides itself when empty (bare headers look broken). */
function secList(title, items) {
  if (!items || !items.length) return '';
  return `<h3>${escapeHtml(title)}</h3><ul>${items.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
}
function stateClass(st) {
  const s = String(st || '');
  return /strongly-supported|^supported/.test(s) ? 'good' : /contradicted|disputed|unsupported/.test(s) ? 'bad' : 'mid';
}
function empty(msg) { return `<div class="empty-state"><p>${escapeHtml(msg)}</p></div>`; }

function renderTab(tab) {
  currentTab = tab;
  const r = current;
  const el = $('#tabBody');
  if (!r || !r.task) {
    el.innerHTML = empty('No result loaded.');
    return;
  }
  const rep = r.report;
  if (tab === 'overview') {
    const fallbackBanner = rep.synthesisFallback ? '<div class="banner warn">Evidence inventory — model synthesis was unavailable (quota). The sources and claims are real and cited; see the Sources and Claims tabs for raw evidence.</div>' : '';
    const stateCounts = {};
    for (const c of r.claims) stateCounts[c.state || 'unknown'] = (stateCounts[c.state || 'unknown'] || 0) + 1;
    el.innerHTML = `${fallbackBanner}
      <div class="stat-grid">
        <div class="stat"><b>${r.sources.length}</b><span>sources</span></div>
        <div class="stat"><b>${r.sources.filter((s) => s.verified).length}</b><span>inspected in full</span></div>
        <div class="stat"><b>${r.claims.length}</b><span>claims</span></div>
        <div class="stat"><b>${r.contradictions.length}</b><span>contradictions</span></div>
      </div>
      ${r.claims.length ? `<p class="state-row">${Object.entries(stateCounts).map(([k, v]) => `<span class="state ${stateClass(k)}">${escapeHtml(k)} · ${v}</span>`).join('')}</p>` : ''}
      ${r.stanceDisclosure ? `<p class="hint">${escapeHtml(r.stanceDisclosure)}</p>` : ''}
      <h3>Executive summary</h3>${paras(rep.executiveSummary) || '<p class="hint">No summary was produced.</p>'}
      ${secList('What we can establish', rep.established)}
      ${secList('Uncertainty', rep.uncertainty)}`;
  } else if (tab === 'claims') {
    el.innerHTML = r.claims.length ? r.claims.map((c) => `<div class="claim ${stateClass(c.state)}"><span class="state ${stateClass(c.state)}">${escapeHtml(c.state || 'unknown')}</span> ${escapeHtml(c.text)}
      ${c.confidenceWhy ? `<div class="hint">${escapeHtml(c.confidenceWhy)}</div>` : ''}
      <div class="cites"><span class="hint">Supports:</span> ${(c.supporting || []).map(srcLink).join(' · ') || '<i>none</i>'}
      ${(c.contradicting || []).length ? `<br><span class="hint">Contradicted by:</span> ${c.contradicting.map(srcLink).join(' · ')}` : ''}</div></div>`).join('') : empty('No claims were extracted.');
  } else if (tab === 'sources' || tab === 'books' || tab === 'academic' || tab === 'primary') {
    const list = r.sources.filter((s) =>
      tab === 'sources' ? true
      : tab === 'books' ? s.sourceType === 'book'
      : tab === 'academic' ? s.sourceType === 'paper'
      : isPrimary(s));
    if (!list.length) { el.innerHTML = empty(`No ${tab === 'sources' ? '' : tab + ' '}sources in this run.`); return; }
    el.innerHTML = `<div class="table-tools"><p class="hint">${list.length} item(s). Tier 1 = primary evidence … tier 7 = social/UGC (leads only). Book metadata is not inspected text.</p>
      <label class="visually-hidden" for="srcFilter">Filter sources</label><input id="srcFilter" class="filter" type="search" placeholder="Filter by title or domain…"></div>
      <div class="table-wrap"><table><thead><tr><th scope="col">Source</th><th scope="col">Tier</th><th scope="col">Access</th><th scope="col">Passage</th></tr></thead><tbody>${list.map((s) => `<tr data-q="${escapeAttr(`${s.title || ''} ${s.domain || ''} ${s.author || ''}`.toLowerCase())}">
      <td>${extLink(s.url, s.title || s.url)}<div class="hint">${escapeHtml([s.domain, s.author, s.publishedDate].filter(Boolean).join(' · '))}</div><div class="hint">${escapeHtml(s.tierReason || '')}${s.note ? ' · ' + escapeHtml(s.note) : ''}${(s.relatedCopies || []).length ? ` · ${s.relatedCopies.length} related cop${s.relatedCopies.length > 1 ? 'ies' : 'y'} (same underlying source — not independent confirmation)` : ''}</div></td>
      <td><span class="pill t${escapeAttr(s.tier ?? '')}">${escapeHtml(s.tier ?? '?')}</span></td>
      <td>${s.verified ? 'inspected' : escapeHtml(s.accessibility || '')}</td>
      <td class="hint passage">${escapeHtml((s.passages[0]?.text || '').slice(0, 280))}</td></tr>`).join('')}</tbody></table></div>`;
    $('#srcFilter').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      $$('#tabBody tbody tr').forEach((tr) => tr.classList.toggle('hidden', !!q && !tr.dataset.q.includes(q)));
    });
  } else if (tab === 'contra') {
    el.innerHTML = `<h3>Contradictions</h3>${r.contradictions.map((c) => `<div class="claim bad"><span class="state bad">${escapeHtml(c.severity || 'flag')}</span> ${escapeHtml(c.against || c.text || '')}<div class="cites">${(c.sources || []).map(srcLink).join(' · ')}</div></div>`).join('') || '<p class="hint">None found — but absence of contradiction is not proof; check the Uncertainty section.</p>'}
      ${secList('Competing explanations', rep.competing)}
      ${secList('Contradictory evidence (report)', rep.contradictions)}`;
  } else if (tab === 'graph') {
    el.innerHTML = `<p class="hint">Claims (left) → sources (right). Green = supports, red = contradicts; dashed source = derived from another source. Showing up to 8 claims.</p>${r.claims.length ? '<svg class="graph" id="g" role="img" aria-label="Claim to source graph"></svg>' : empty('No claims extracted — nothing to graph yet.')}`;
    if (r.claims.length) drawGraph();
  } else if (tab === 'process') {
    const st = r.stats;
    el.innerHTML = `<h3>Methodology</h3>${paras(rep.methodology) || '<p class="hint">Not recorded.</p>'}
      <h3>Iterations</h3>${(r.iterations || []).length ? `<ul>${r.iterations.map((i) => `<li>Pass ${escapeHtml(i.n)}: gaps — ${escapeHtml((i.gaps || []).join('; ') || 'none')} ${i.sufficient ? '(sufficient)' : ''}</li>`).join('')}</ul>` : '<p class="hint">Single pass.</p>'}
      <h3>Budget</h3><div class="stat-grid">
        <div class="stat"><b>${escapeHtml(st.modelCalls ?? '?')}</b><span>model calls</span></div>
        <div class="stat"><b>${escapeHtml(st.searchCalls ?? '?')}</b><span>searches</span></div>
        <div class="stat"><b>${escapeHtml(st.fetches ?? '?')}</b><span>pages fetched</span></div>
        <div class="stat"><b>${escapeHtml(fmtElapsed(st.runtimeMs || 0))}</b><span>runtime</span></div>
      </div>
      <p class="hint">Tokens in/out ${(st.tokensIn || 0).toLocaleString()} / ${(st.tokensOut || 0).toLocaleString()} (API-reported; cost follows current Google pricing)${st.escalated ? ' · escalated (disagreement found)' : ''}${st.keyRotations ? ` · ${st.keyRotations} key rotation(s)` : ''}${st.quotaWaitMs ? ` · ${Math.round(st.quotaWaitMs / 1000)}s waiting for quota` : ''}</p>
      ${st.note ? `<p class="hint">${escapeHtml(st.note)}</p>` : ''}
      ${st.phases && Object.keys(st.phases).length ? `<h3>Phase timings</h3><p class="hint">${Object.entries(st.phases).map(([k, v]) => `${escapeHtml(k)}: ${(v / 1000).toFixed(1)}s`).join(' · ')}</p>` : ''}
      ${st.fetchIssues && Object.keys(st.fetchIssues).length ? `<h3>Fetch issues</h3><p class="hint">${Object.entries(st.fetchIssues).map(([k, v]) => `${escapeHtml(v)}× ${escapeHtml(k)}`).join(' · ')}</p>` : ''}
      ${secList('Research gaps', rep.gaps)}`;
  } else if (tab === 'report') {
    const cite = (ids = []) => (ids || []).map((id) => { const s = srcById(id); return s ? `<a class="cite" href="${escapeAttr(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer" title="${escapeAttr(s.title || s.url)}">${escapeHtml((s.title || s.domain || '').slice(0, 40))}</a>` : ''; }).join(' ');
    const findings = rep.findings || [];
    el.innerHTML = `<article class="report">
      <h2>Final report</h2>${paras(rep.executiveSummary)}
      ${findings.length > 1 ? `<nav class="toc" aria-label="Contents"><h3>Contents</h3><ol>${findings.map((f, i) => `<li><a href="#f-${i}" data-jump="f-${i}">${escapeHtml((f.heading || `Finding ${i + 1}`).slice(0, 90))}</a></li>`).join('')}</ol></nav>` : ''}
      ${findings.map((f, i) => { const v = (rep.verification || []).find((x) => x.n === i); return `<section class="finding"><h3 id="f-${i}">${escapeHtml(f.heading || `Finding ${i + 1}`)}</h3>${paras(f.body)}${(f.cite || []).length ? `<p class="cites">${cite(f.cite)}</p>` : ''}` + (v ? `<p class="hint">Cross-check: <b>${escapeHtml(v.supported)}</b> — ${escapeHtml(v.note)}</p>` : '') + '</section>'; }).join('')}
      ${(rep.timeline || []).length ? `<h3>Chronology</h3><div class="table-wrap"><table><thead><tr><th scope="col">Date</th><th scope="col">Event</th></tr></thead><tbody>${rep.timeline.map((t) => `<tr><td><b>${escapeHtml(t.date || '')}</b></td><td>${escapeHtml(t.event || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${rep.sourceQuality ? `<h3>Source quality</h3>${paras(rep.sourceQuality)}` : ''}
      ${rep.independence ? `<h3>Source independence</h3>${paras(rep.independence)}` : ''}
      ${secList('Books', rep.books)}
      ${secList('Primary sources', rep.primarySources)}
      ${secList('Uncertainty', rep.uncertainty)}
      ${rep.methodology ? `<h3>Methodology</h3>${paras(rep.methodology)}` : ''}
      ${(rep.appendix || []).length ? `<details class="appendix"><summary><b>Evidence appendix</b> — every extracted claim with its sources (${rep.appendix.length})</summary>${rep.appendix.map((a) => `<div class="claim ${stateClass(a.state)}"><b>${escapeHtml(a.n)}.</b> <span class="state ${stateClass(a.state)}">${escapeHtml(a.state)}</span> ${escapeHtml(a.text)}${a.why ? `<div class="hint">${escapeHtml(a.why)}</div>` : ''}<div class="cites"><span class="hint">Supports:</span> ${(a.supporting || []).map((s) => extLink(s.url, s.title)).join(' · ') || '<i>none listed</i>'}${(a.contradicting || []).length ? `<br><span class="hint">Contradicted by:</span> ${a.contradicting.map((s) => extLink(s.url, s.title)).join(' · ')}` : ''}</div></div>`).join('')}</details>` : ''}
      <h3>Sources</h3><ol class="source-list">${r.sources.map((s) => `<li>${extLink(s.url, s.title || s.url)} <span class="hint">tier ${escapeHtml(s.tier ?? '?')} · ${escapeHtml(s.accessibility || '')}${s.verified ? ' · inspected' : ''}</span></li>`).join('')}</ol>
    </article>`;
    // In-report jumps must not replace the #run= deep link in the address bar.
    $$('#tabBody [data-jump]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(a.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  }
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
  const srcIds = [...new Set(rels.map((x) => x.sid))].filter((sid) => srcById(sid)).slice(0, 14);
  const W = 900;
  const H = Math.max(260, 60 + Math.max(claims.length, srcIds.length) * 34);
  const pos = {};
  const spread = (n, i) => 30 + (i + 0.5) * ((H - 60) / Math.max(n, 1));
  claims.forEach((c, i) => { pos['c' + i] = [150, spread(claims.length, i)]; });
  srcIds.forEach((sid, i) => { pos[sid] = [610, spread(srcIds.length, i)]; });
  const derived = new Set((current.relations || []).filter((x) => x.kind === 'derived_from').map((x) => x.from));
  const tierClass = (t) => (t <= 2 ? 'g-t-hi' : t <= 4 ? 'g-t-mid' : 'g-t-lo');
  let s = '';
  for (const x of rels) {
    const a = pos['c' + x.c]; const p = pos[x.sid]; if (!a || !p) continue;
    s += `<line x1="${a[0] + 130}" y1="${a[1]}" x2="${p[0] - 10}" y2="${p[1]}" class="${x.k === 'contradicts' ? 'g-bad' : 'g-ok'}"/>`;
  }
  claims.forEach((c, i) => {
    const [x, y] = pos['c' + i];
    const text = String(c.text || '');
    s += `<g><title>${escapeHtml(text)}</title><rect x="${x - 130}" y="${y - 14}" width="260" height="28" rx="6" class="g-claim ${stateClass(c.state)}"/><text x="${x}" y="${y + 4}" text-anchor="middle" class="g-label">${escapeHtml(text.length > 38 ? text.slice(0, 37) + '…' : text)}</text></g>`;
  });
  srcIds.forEach((sid) => {
    const src = srcById(sid); const [x, y] = pos[sid];
    const isDerived = derived.has(sid);
    s += `<g><title>${escapeHtml(src?.title || sid)}</title><circle cx="${x}" cy="${y}" r="9" class="${isDerived ? 'g-derived' : tierClass(src?.tier ?? 9)}"/><text x="${x + 16}" y="${y + 4}" class="g-src">${escapeHtml((src?.domain || sid).slice(0, 30))}</text></g>`;
  });
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.height = `${Math.round(H * 0.8)}px`;
  svg.innerHTML = s;
}

// ---------- export / history ----------
$$('.exports [data-exp]').forEach((b) => b.addEventListener('click', async () => {
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
    if (staticMode) { showNotice('Export failed in this browser — try JSON export.', 'error'); return; }
    window.open(`/api/export/${encodeURIComponent(current.id)}?format=${fmt}`, '_blank', 'noopener');
  }
}));
$('#printBtn').addEventListener('click', () => {
  if (!current) return;
  activateTab($('#tab-report'), false);
  setTimeout(() => window.print(), 60); // print dialog → Save as PDF
});
$('#again').addEventListener('click', () => { goHome(); $('#q').focus(); });

async function openRun(id, local) {
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
      showNotice(local ? 'That saved result is no longer in this browser (storage may have been cleared).' : 'Could not open that run — it may have been deleted.', 'error');
      return;
    }
    showResult(r, { record: false });
  } catch (e) {
    showNotice('Could not open that run: ' + (e.message || 'network error'), 'error');
  }
}

async function renderHistory() {
  const box = $('#histList');
  box.innerHTML = '<p class="hint">Loading…</p>';
  let server = [];
  if (!staticMode) {
    try {
      const res = await fetch('/api/history');
      if (res.ok) server = (await res.json()).items || [];
    } catch { /* server unreachable */ }
  }
  const local = getHistory();
  const serverIds = new Set(server.map((h) => h.id));
  const row = (h, where) => `<div class="hist-item">
      <div class="hist-main"><strong>${escapeHtml(h.question || 'Untitled')}</strong>
      <span class="hint">${escapeHtml(h.mode || '')}${h.sources != null ? ` · ${escapeHtml(h.sources)} sources` : ''}${h.createdAt || h.at ? ` · ${escapeHtml(fmtDate(h.createdAt || h.at))}` : ''}</span></div>
      <div class="hist-actions">
        ${where === 'server' || h.direct ? `<button type="button" class="btn small" data-open="${escapeAttr(h.id)}" data-where="${where}">Open</button>` : '<span class="hint">not stored</span>'}
        <button type="button" class="btn small ghost danger" data-del="${escapeAttr(h.id)}" data-where="${where}" aria-label="Delete ${escapeAttr(h.question || 'run')}">Delete</button>
      </div></div>`;
  const localOnly = local.filter((h) => !serverIds.has(h.id));
  box.innerHTML = (staticMode ? '' : `<h3>On this server</h3>${server.map((h) => row(h, 'server')).join('') || '<p class="hint">No saved runs yet.</p>'}`)
    + `<h3>In this browser</h3>${localOnly.map((h) => row(h, 'local')).join('') || '<p class="hint">No runs yet.</p>'}`;
  $$('#histList [data-open]').forEach((b) => b.addEventListener('click', () => openRun(b.dataset.open, b.dataset.where === 'local')));
  $$('#histList [data-del]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.del;
    if (b.dataset.where === 'server') {
      try { await fetch('/api/history/' + encodeURIComponent(id), { method: 'DELETE' }); } catch { /* ignore */ }
    }
    lsSet('er_history', JSON.stringify(getHistory().filter((h) => h.id !== id)));
    try { const { removeLocalResult } = await import(`./direct.js${staticSuffix()}`); removeLocalResult(id); } catch { /* ignore */ }
    renderHistory();
  }));
}
$('#historyBtn').addEventListener('click', () => {
  if (running) { showNotice('A research run is in progress — cancel it first to browse history.', ''); return; }
  hideNotice();
  showView('history');
  renderHistory();
});
$('#backAsk').addEventListener('click', () => { if (current) showView('result'); else goHome(); });
$('#clearHist').addEventListener('click', async () => {
  if (!confirm('Clear the research history and saved results stored in this browser?')) return;
  lsDel('er_history');
  try { const { clearLocalResults } = await import(`./direct.js${staticSuffix()}`); clearLocalResults(); } catch { /* ignore */ }
  renderHistory();
  showNotice('This browser\'s history was cleared.', '');
});

// ---------- keys dialog (edits a draft; storage changes only on save) ----------
let keyDraft = [];
function openKeyDialog() {
  if ($('#keyDialog').open) return;
  keyDraft = getStoredKeys();
  if (!keyDraft.length) keyDraft = [''];
  $('#modelInput').value = getStoredModel();
  updateModelHint($('#modelInput').value);
  setKeyStatus('');
  renderKeyList();
  $('#keyDialog').showModal();
  $('#keyList input')?.focus();
}
function syncDraftFromInputs() {
  keyDraft = $$('#keyList input').map((i) => i.value);
}
function renderKeyList() {
  const container = $('#keyList');
  container.innerHTML = keyDraft.map((k, i) => `
    <div class="key-item">
      <label class="visually-hidden" for="key-${i}">Gemini API key ${i + 1}</label>
      <input id="key-${i}" type="password" value="${escapeAttr(k)}" placeholder="AIza…" autocomplete="off" spellcheck="false">
      <button type="button" class="icon-btn" data-toggle="${i}" aria-label="Show key ${i + 1}" aria-pressed="false">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
      <button type="button" class="icon-btn" data-remove="${i}" aria-label="Remove key ${i + 1}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/></svg>
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
      const res = await fetch('/api/keys/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys }),
      });
      const data = await res.json().catch(() => ({}));
      if (Array.isArray(data.results)) return data.results;
    } catch { /* fall through to direct check */ }
  }
  try {
    return await Promise.all(keys.map(async (key) => {
      const masked = key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : `${key.slice(0, 2)}…`;
      if (!/^AIza[\w-]{20,}$/.test(key)) return { valid: false, masked, error: 'not a Gemini key format (starts with AIza)' };
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
  let keys = parseKeyInputs(keyDraft);
  const model = $('#modelInput').value || '';
  const saveModel = () => {
    lsSet('gemini_model', model);
    $('#modelSelect').value = model;
  };
  if (keys.length > 5) { keys = keys.slice(0, 5); }
  if (!keys.length) {
    // Model-only save is fine when the server has its own key.
    if (!staticMode && serverKey) { setStoredKeys([]); saveModel(); $('#keyDialog').close(); showNotice('Saved — using the server\'s key.', ''); return; }
    setKeyStatus('Add at least one Gemini API key.', 'error');
    $('#keyList input')?.focus();
    return;
  }
  const saveBtn = $('#saveKey');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Validating…';
  setKeyStatus(`Checking ${keys.length} key(s) with Google…`);
  try {
    const results = await validateKeys(keys);
    let note = '';
    if (results) {
      const valid = keys.filter((_, i) => results[i]?.valid);
      const invalid = results.map((r, i) => (r?.valid ? null : `${r?.masked || keys[i].slice(0, 6) + '…'} (${r?.error || 'invalid'})`)).filter(Boolean);
      if (!valid.length) {
        setKeyStatus(`No working keys: ${invalid.join(', ')}. Check and try again.`, 'error');
        return;
      }
      keys = valid;
      const warned = results.filter((r) => r?.valid && r.warning).length;
      note = invalid.length ? `Saved ${valid.length} key(s); removed ${invalid.length} invalid: ${invalid.join(', ')}.`
        : warned ? `Saved ${valid.length} key(s). ${warned} currently over quota — they will work after the limit resets.`
          : `Saved ${valid.length} working key(s).`;
    } else {
      note = `Saved ${keys.length} key(s) without validation (offline).`;
    }
    setStoredKeys(keys);
    saveModel();
    keyDraft = keys.slice();
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
  $('#modelSelect').value = '';
  updateModelHint('');
  renderKeyList();
  setKeyStatus('All keys removed from this browser.');
});

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

init();
