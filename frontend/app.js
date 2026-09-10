// Frontend app: ask → SSE progress → tabbed dashboard → export. No build step.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let current = null;
let serverKey = false;
let staticMode = false;

const MODE_BLURB = {
  quick: 'Quick: ~2 searches, ~1 min. Basic verification (escalates on disagreement).',
  standard: 'Standard: ~10 searches + academic/books, a few minutes. Cross-checking + contradiction search.',
  deep: 'Deep: ~24 searches, up to ~15 min. Books, academic + primary sources, provenance.',
  exhaustive: 'Exhaustive: ~50 searches, up to ~30 min. Documentary-grade. Heavy API use.',
};

function recommendMode(q) {
  const t = String(q || '').trim();
  if (t.length < 4) return '';
  if (/^(when|who|where|what year|how many)\b/i.test(t) && t.length < 90)
    return 'Looks focused and factual — Quick should do (it still verifies, and escalates automatically if sources disagree).';
  if (/why|causes?|collapse|compar|vs\.?|history of|explain|debate|controvers|myth/i.test(t) || t.length > 140)
    return 'This looks like a deep investigation — consider Deep or Exhaustive.';
  return 'Standard is a good default; escalate if contradictions appear.';
}

function getStoredKeys() {
  try {
    const arr = JSON.parse(localStorage.getItem('gemini_keys') || '[]');
    if (Array.isArray(arr) && arr.length) return arr;
  } catch {}
  const single = localStorage.getItem('gemini_key');
  return single ? [single] : [];
}
function getStoredModel() {
  return localStorage.getItem('gemini_model') || '';
}

async function init() {
  let hasFallback = false;
  let apiOk = false;
  let cfg = null;
  try {
    cfg = await (await fetch('/api/config')).json();
    serverKey = !!cfg.serverKey;
    hasFallback = !!cfg.hasFallback;
    apiOk = Array.isArray(cfg.modes);
    // Populate model selectors
    if (cfg.models && Array.isArray(cfg.models)) {
      const opts = cfg.models.map(m => `<option value="${m.id}">${m.label} — ${m.blurb}</option>`).join('');
      $('#modelSelect').innerHTML = '<option value="">Auto (server default)</option>' + opts;
      $('#modelInput').innerHTML = '<option value="">Auto (server default)</option>' + opts;
      const savedModel = getStoredModel();
      if (savedModel) {
        $('#modelSelect').value = savedModel;
        $('#modelInput').value = savedModel;
      }
    }
  } catch { /* offline → static mode */ }
  staticMode = !apiOk;
  $('#staticBanner').classList.toggle('hidden', !staticMode);
  $('#costNote').textContent = MODE_BLURB.standard;
  $$('input[name=mode]').forEach((r) => r.addEventListener('change', () => {
    $('#costNote').textContent = MODE_BLURB[document.querySelector('input[name=mode]:checked').value];
  }));
  const updateHint = () => { $('#modeHint').textContent = recommendMode($('#q').value); };
  $('#q').addEventListener('input', () => { updateHint(); $('#qCount').textContent = `${$('#q').value.length} / 5000`; });
  updateHint();
  $('#qCount').textContent = `${$('#q').value.length} / 5000`;
  $('#serverKeyNote').textContent = staticMode
    ? 'Static demo mode: this page runs 100% in your browser with your own key — no server needed. Some page fetches may be limited by site CORS policies; grounding excerpts are still cited.'
    : serverKey
      ? `Server has a Gemini key configured${hasFallback ? ' (+ fallback key for rate limits)' : ''}. You can still override with your own below (used for this browser only).`
      : 'No server-side key configured. Enter your Gemini key to run research in private mode.';
  // Migrate old single key to new array format display
  const keys = getStoredKeys();
  $('#keyCount').textContent = keys.length ? String(keys.length) : '0';
  $('#keyCount').classList.toggle('hidden', keys.length === 0);
  renderKeyList();
  // Model selector change handlers
  $('#modelSelect').addEventListener('change', () => {
    const v = $('#modelSelect').value;
    localStorage.setItem('gemini_model', v);
    $('#modelInput').value = v;
  });
  $('#modelInput').addEventListener('change', () => {
    const v = $('#modelInput').value;
    localStorage.setItem('gemini_model', v);
    $('#modelSelect').value = v;
  });
}

function renderKeyList() {
  const keys = getStoredKeys();
  const container = $('#keyList');
  if (!container) return;
  container.innerHTML = keys.map((k, i) => `
    <div class="key-item">
      <input type="password" value="${k}" data-idx="${i}" placeholder="AIza…" autocomplete="off">
      <button type="button" class="btn ghost small" data-remove="${i}" aria-label="Remove key">×</button>
    </div>
  `).join('') || '<p class="hint">No keys added yet. Add at least one Gemini API key.</p>';
  container.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.remove);
      const arr = getStoredKeys();
      arr.splice(idx, 1);
      localStorage.setItem('gemini_keys', JSON.stringify(arr));
      if (arr.length === 0) localStorage.removeItem('gemini_key');
      else localStorage.setItem('gemini_key', arr[0]);
      renderKeyList();
      $('#keyCount').textContent = arr.length ? String(arr.length) : '0';
      $('#keyCount').classList.toggle('hidden', arr.length === 0);
    });
  });
  container.querySelectorAll('input[data-idx]').forEach(inp => {
    inp.addEventListener('change', () => {
      const idx = parseInt(inp.dataset.idx);
      const arr = getStoredKeys();
      arr[idx] = inp.value.trim();
      localStorage.setItem('gemini_keys', JSON.stringify(arr.filter(Boolean)));
      localStorage.setItem('gemini_key', arr[0] || '');
    });
  });
}

function val(name) { return document.querySelector(`input[name=${name}]:checked`).value; }

let running = false;
let currentAbort = null;
$('#start').addEventListener('click', () => {
  if (running) return; // one run at a time — parallel runs would burn quota
  const question = $('#q').value.trim();
  if (question.length < 3) return alert('Enter a research question.');
  running = true;
  $('#start').disabled = true;
  run({ question, mode: val('mode'), stance: val('stance'), hypothesis: $('#hyp').value.trim(), documentary: $('#docu').checked, fresh: $('#fresh').checked, model: getStoredModel() || undefined });
});

function run(body) {
  $('#askView').classList.add('hidden');
  $('#resultView').classList.add('hidden');
  $('#progressView').classList.remove('hidden');
  $('#progressFill').style.width = '8%';
  $('#steps').innerHTML = '';
  $('#errorBanner').classList.add('hidden');
  $('#skeleton').classList.remove('hidden');
  let progress = 8;
  const step = (cls, text) => {
    const d = document.createElement('div');
    d.className = 'step';
    d.innerHTML = `<span class="${cls}">${cls === 'ok' ? '✓' : cls === 'warn' ? '!' : '→'}</span> ${escapeHtml(text)}`;
    $('#steps').appendChild(d);
    // Animate progress bar
    progress = Math.min(92, progress + (cls === 'ok' ? 12 : cls === 'run' ? 4 : 2));
    $('#progressFill').style.width = progress + '%';
    return d;
  };
  const keys = getStoredKeys();
  const model = body.model || getStoredModel() || '';
  const finish = () => {
    running = false;
    if (currentAbort) { currentAbort = null; }
    $('#start').disabled = false;
    $('#skeleton').classList.add('hidden');
    $('#progressFill').style.width = '100%';
    setTimeout(() => $('#progressFill').style.width = '0%', 400);
    $('#progressView').setAttribute('aria-busy', 'false');
  };
  // Cancel handler — aborting the fetch triggers server-side cancellation
  // via the isCancelled refcount (no extra endpoint needed)
  const abort = new AbortController();
  currentAbort = abort;
  $('#cancelBtn').onclick = () => {
    if (abort.signal.aborted) return;
    abort.abort();
    step('warn', 'Cancelled by user — stopping…');
  };
  if (staticMode) {
    const key = keys[0] || '';
    runDirectFlow(body, key, step, finish, abort.signal, keys, model);
    return;
  }
  // Build headers with multi-key and model support
  const headers = { 'Content-Type': 'application/json' };
  if (keys.length === 1) headers['x-gemini-key'] = keys[0];
  else if (keys.length > 1) headers['x-gemini-keys'] = JSON.stringify(keys);
  if (model) headers['x-gemini-model'] = model;

  // Dynamic retry with exponential backoff for rate limits
  let attempts = 0;
  const maxAttempts = 3;
  const doFetch = async () => {
    attempts++;
    try {
      const res = await fetch('/api/research', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      // Handle 429 with Retry-After — dynamic wait and retry
      if (res.status === 429 && attempts < maxAttempts) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || res.headers.get('retry-after') || '0');
        const waitMs = retryAfter ? retryAfter * 1000 : Math.min(60000, 1000 * Math.pow(2, attempts) + Math.random()*1000);
        step('warn', `Rate limited — retrying in ${Math.ceil(waitMs/1000)}s (attempt ${attempts}/${maxAttempts})…`);
        await new Promise(r => setTimeout(r, waitMs));
        return doFetch();
      }
      if (!res.ok && res.headers.get('content-type')?.includes('json')) {
        const e = await res.json();
        // Also handle JSON 429 with retry
        if (res.status === 429 && e.retryAfter && attempts < maxAttempts) {
          const waitMs = e.retryAfter * 1000;
          step('warn', `Rate limited — retrying in ${e.retryAfter}s…`);
          await new Promise(r => setTimeout(r, waitMs));
          return doFetch();
        }
        step('warn', 'Error: ' + (e.error || res.status));
        finish();
        return;
      }
      if (!res.ok || !res.body) {
        step('warn', 'Error: server returned status ' + res.status);
        finish();
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const p of parts) {
          const line = p.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          try { handleEvent(JSON.parse(line.slice(5)), step); }
          catch { /* keep-alive */ }
        }
      }
      finish();
    } catch (e) {
      if (e.name === 'AbortError') {
        step('warn', 'Cancelled.');
        finish();
      } else {
        step('warn', 'Network error: ' + e.message);
        // Retry on network error with backoff
        if (attempts < maxAttempts && !abort.signal.aborted) {
          const waitMs = Math.min(10000, 1000 * Math.pow(2, attempts));
          step('warn', `Retrying in ${Math.ceil(waitMs/1000)}s…`);
          await new Promise(r => setTimeout(r, waitMs));
          return doFetch();
        }
        finish();
      }
    }
  };
  doFetch();
}

function showError(msg) {
  const b = $('#errorBanner');
  b.textContent = msg;
  b.classList.remove('hidden');
  b.focus?.();
}
// Static-mode run: same engine, executed in-page via frontend/direct.js.
async function runDirectFlow(body, key, step, finish, signal, allKeys = [], model = '') {
  const keys = allKeys.length ? allKeys : (key ? [key] : []);
  if (!keys.length) {
    const msg = 'Static mode needs a Gemini API key — click "API key" above to enter one (stored in this browser only).';
    step('warn', msg);
    showError(msg);
    finish();
    if (!$('#keyDialog').open) $('#keyDialog').showModal();
    return;
  }
  if (signal?.aborted) { finish(); return; }
  try {
    const { runDirect, saveLocalResult } = await import('./direct.js');
    step('run', `Static mode: running with ${keys.length} key(s)${model ? ` · model ${model}` : ''}…`);
    // Pass all keys and model for rotation — handles any topic dynamically
    const result = await runDirect({ ...body, model: model || body.model }, { key: keys, emit: (ev) => handleEvent(ev, step) });
    if (signal?.aborted) { step('warn', 'Cancelled.'); finish(); return; }
    saveLocalResult(result);
    showResult(result);
  } catch (e) {
    if (signal?.aborted || e.name === 'AbortError') { step('warn', 'Cancelled.'); finish(); return; }
    const raw = e.message || 'research failed';
    const msg = /quota|rate|429/i.test(raw) ? 'Gemini rate limit reached. Wait a minute and retry, or add more API keys (they rotate automatically).' : raw;
    step('warn', 'Error: ' + msg);
    showError(msg);
  } finally {
    finish();
  }
}

function handleEvent(ev, step) {
  if (ev.type === 'error') { step('warn', 'Error: ' + ev.message); showError(ev.message); return; }
  if (ev.type === 'result') return showResult(ev.result);
  if (ev.type === 'plan') {
    step('ok', 'Research plan created');
    step('', `Domain: ${ev.plan.domain} · Complexity: ${ev.plan.complexity}`);
    return;
  }
  if (ev.type === 'sources' || ev.type === 'claims') return step('ok', ev.message);
  step(ev.type === 'warning' ? 'warn' : ev.type === 'done' ? 'ok' : 'run', ev.message || ev.type);
  if (ev.stats) { const s = ev.stats; $('#liveStats').textContent = `model calls ${s.modelCalls} · searches ${s.searchCalls} · fetched ${s.fetches ?? 0}` + (((s.tokensIn || 0) + (s.tokensOut || 0)) ? ` · ${((s.tokensIn || 0) + (s.tokensOut || 0)).toLocaleString()} tokens (API-reported)` : ''); }
}

// ---------- dashboard ----------
function activateTab(btn) {
  $$('.tabs button').forEach((x) => { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); x.tabIndex = -1; });
  btn.classList.add('active'); btn.setAttribute('aria-selected', 'true'); btn.tabIndex = 0; btn.focus();
  renderTab(btn.dataset.tab);
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => activateTab(b)));
// Keyboard: ArrowLeft/Right, Home/End cycle through tabs
document.querySelector('.tabs').addEventListener('keydown', (e) => {
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

function showResult(r) {
  current = r;
  try {
    const hist = JSON.parse(localStorage.getItem('er_history') || '[]');
    hist.unshift({ id: r.id, question: r.task.question, mode: r.task.mode, at: r.completedAt, ...(staticMode ? { direct: true } : {}) });
    localStorage.setItem('er_history', JSON.stringify(hist.slice(0, 100)));
  } catch { /* private mode */ }
  $('#progressView').classList.add('hidden');
  $('#resultView').classList.remove('hidden');
  renderTab('overview');
}

function srcById(id) { return (current.sources || []).find((s) => s.id === id); }
// Only http(s) links are clickable: model- or API-supplied URLs must never
// become javascript:/data: hrefs (defense in depth — server already filters).
function safeUrl(u) { return /^https?:\/\//i.test(String(u || '')) ? u : '#'; }
function srcLink(id) {
  const s = srcById(id);
  return s ? `<a href="${escapeAttr(safeUrl(s.url))}" target="_blank" rel="noopener">${escapeHtml(s.title || s.domain || s.url)}</a>` : '<i>unknown source</i>';
}

function renderTab(tab) {
  const r = current;
  const el = $('#tabBody');
  if (!r || !r.task) {
    el.innerHTML = '<div class="empty-state"><p>No result loaded.</p></div>';
    return;
  }
  r.stats = r.stats || {};
  r.report = r.report || {};
  if (tab === 'overview') {
    el.innerHTML = `<h2>${escapeHtml(r.task.question)}</h2>
      <p><span class="pill">${r.task.mode}</span><span class="pill">${r.task.stance}</span>
      <span class="pill">${r.sources.length} sources</span><span class="pill">${r.claims.length} claims</span></p>
      <p>${escapeHtml(r.stanceDisclosure || '')}</p>
      <h3>Executive summary</h3><p>${escapeHtml(r.report?.executiveSummary || '')}</p>
      <h3>What we can establish</h3><ul>${(r.report?.established || []).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
      <h3>Uncertainty</h3><ul>${(r.report?.uncertainty || []).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
  } else if (tab === 'claims') {
    el.innerHTML = (r.claims || []).map((c) => `<div class="claim"><b>[${escapeHtml(c.state)}]</b> ${escapeHtml(c.text)}
      ${c.confidenceWhy ? `<br><span class="hint">${escapeHtml(c.confidenceWhy)}</span>` : ''}
      <br><span class="hint">Supports:</span> ${(c.supporting || []).map(srcLink).join(' · ') || '<i>none</i>'}
      ${(c.contradicting || []).length ? `<br><span class="hint">Contradicted by:</span> ${c.contradicting.map(srcLink).join(' · ')}` : ''}</div>`).join('') || '<p>No claims extracted.</p>';
  } else if (tab === 'sources' || tab === 'books' || tab === 'academic' || tab === 'primary') {
    const list = (r.sources || []).filter((s) =>
      tab === 'sources' ? true
      : tab === 'books' ? s.sourceType === 'book'
      : tab === 'academic' ? s.sourceType === 'paper'
      : s.proximity === 'primary' || s.tier === 1);
    el.innerHTML = `<p class="hint">${list.length} item(s). Tier 1 = primary evidence … Tier 7 = social/UGC (leads only). Book metadata ≠ inspected text.</p>
      <table><tr><th>Source</th><th>Tier</th><th>Access</th><th>Passage</th></tr>${list.map((s) => `<tr>
      <td><a href="${escapeAttr(safeUrl(s.url))}" target="_blank" rel="noopener">${escapeHtml(s.title || s.url)}</a><br><span class="hint">${escapeHtml(s.domain)} · ${escapeHtml(s.author || '')} ${escapeHtml(s.publishedDate || '')}<br>${escapeHtml(s.tierReason || '')}${s.note ? ' · ' + escapeHtml(s.note) : ''}${(s.relatedCopies || []).length ? `<br>· ${s.relatedCopies.length} related cop${s.relatedCopies.length > 1 ? 'ies' : 'y'} (same canonical source — not independent confirmation)` : ''}</span></td>
      <td><span class="pill t${s.tier ?? ''}">${s.tier ?? '?'}</span></td>
      <td>${s.verified ? 'inspected' : escapeHtml(s.accessibility || '')}</td>
      <td class="hint">${escapeHtml((s.passages[0]?.text || '').slice(0, 280))}</td></tr>`).join('')}</table>`;
  } else if (tab === 'contra') {
    el.innerHTML = `<h3>Contradictions</h3>${(r.contradictions || []).map((c) => `<div class="claim"><b>[${c.severity}]</b> ${escapeHtml(c.against)}<br><span class="hint">${(c.sources || []).map(srcLink).join(' · ')}</span></div>`).join('') || '<p>None found.</p>'}
      <h3>Competing explanations</h3><ul>${(r.report?.competing || []).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
      <h3>Contradictory evidence (report)</h3><ul>${(r.report?.contradictions || []).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
  } else if (tab === 'graph') {
    el.innerHTML = `<p class="hint">Claims → sources. Red edges = contradicts, green = supports, dashed = derived from one underlying source.</p><svg class="graph" id="g"></svg>`;
    drawGraph();
  } else if (tab === 'process') {
    el.innerHTML = `<h3>Methodology</h3><p>${escapeHtml(r.report?.methodology || '')}</p>
      <h3>Iterations</h3><ul>${(r.iterations || []).map((i) => `<li>Pass ${i.n}: gaps: ${(i.gaps || []).join('; ') || 'none'} ${i.sufficient ? '(sufficient)' : ''}</li>`).join('')}</ul>
      <h3>Budget</h3><p class="hint">model calls ${r.stats.modelCalls} · searches ${r.stats.searchCalls} · fetched ${r.stats.fetches} · runtime ${(r.stats.runtimeMs / 1000).toFixed(1)}s · tokens in/out ${((r.stats.tokensIn || 0)).toLocaleString()}/${((r.stats.tokensOut || 0)).toLocaleString()} (API-reported; cost follows current Google pricing, estimate only)${r.stats.escalated ? ' · escalated (disagreement found)' : ''}${r.stats.keyRotations ? ` · ${r.stats.keyRotations} key rotation(s)` : ''}<br>${escapeHtml(r.stats.note || '')}</p>
      ${r.stats.phases && Object.keys(r.stats.phases).length ? `<h3>Phase timings</h3><p class="hint">${Object.entries(r.stats.phases).map(([k, v]) => `${escapeHtml(k)}: ${(v / 1000).toFixed(1)}s`).join(' · ')}</p>` : ''}
      ${r.stats.fetchIssues && Object.keys(r.stats.fetchIssues).length ? `<h3>Fetch issues</h3><p class="hint">${Object.entries(r.stats.fetchIssues).map(([k, v]) => `${v}× ${escapeHtml(k)}`).join(' · ')}</p>` : ''}
      <h3>Research gaps</h3><ul>${(r.report?.gaps || []).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
  } else if (tab === 'report') {
    const rep = r.report || {};
    const byId = (id) => srcById(id);
    const cite = (ids = []) => (ids || []).map((id) => { const s = byId(id); return s ? `<a href="${escapeAttr(safeUrl(s.url))}" target="_blank" rel="noopener">[${escapeHtml((s.title || s.domain || '').slice(0, 40))}]</a>` : ''; }).join(' ');
    el.innerHTML = `<h2>Final report</h2><p>${escapeHtml(rep.executiveSummary || '')}</p>
      ${(rep.findings || []).map((f, i) => { const v = (rep.verification || []).find((x) => x.n === i); return `<h3>${escapeHtml(f.heading || '')}</h3><p>${escapeHtml(f.body || '')}</p><p>${cite(f.cite)}</p>` + (v ? `<p class="hint">Cross-check: <b>${escapeHtml(v.supported)}</b> — ${escapeHtml(v.note)}</p>` : ''); }).join('')}
      <h3>Source quality</h3><p>${escapeHtml(rep.sourceQuality || '')}</p>
      <h3>Source independence</h3><p>${escapeHtml(rep.independence || '')}</p>
      <h3>Books</h3><ul>${(rep.books || []).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
      <h3>Primary sources</h3><ul>${(rep.primarySources || []).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
      <h3>Uncertainty</h3><ul>${(rep.uncertainty || []).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
      <h3>Methodology</h3><p>${escapeHtml(rep.methodology || '')}</p>
      <h3>Sources</h3><ul>${(r.sources || []).map((s) => `<li><a href="${escapeAttr(safeUrl(s.url))}" target="_blank" rel="noopener">${escapeHtml(s.title || s.url)}</a> <span class="hint">tier ${s.tier ?? '?'} · ${escapeHtml(s.accessibility || '')}${s.verified ? ' · inspected' : ''}</span></li>`).join('')}</ul>`;
  }
}

function drawGraph() {
  const svg = $('#g');
  if (!svg || !current) return;
  const claims = (current.claims || []).slice(0, 8);
  const rels = [];
  claims.forEach((c, i) => {
    (c.supporting || []).slice(0, 3).forEach((sid) => rels.push({ c: i, sid, k: 'supports' }));
    (c.contradicting || []).slice(0, 2).forEach((sid) => rels.push({ c: i, sid, k: 'contradicts' }));
  });
  const srcIds = [...new Set(rels.map((x) => x.sid))].slice(0, 14);
  const W = 900, H = 420;
  const pos = {};
  claims.forEach((c, i) => { pos['c' + i] = [140, 40 + i * ((H - 60) / Math.max(claims.length, 1))]; });
  srcIds.forEach((sid, i) => { pos[sid] = [620, 40 + i * ((H - 60) / Math.max(srcIds.length, 1))]; });
  const derived = new Set((current.relations || []).filter((x) => x.kind === 'derived_from').map((x) => x.from + '>' + x.to));
  const stateFill = (st) => /strongly-supported|supported/.test(st || '') ? '#12351f' : /contradicted|disputed/.test(st || '') ? '#3a1f1f' : '#3a2c12';
  const tierFill = (t) => t <= 2 ? '#2c4a2c' : t <= 4 ? '#1b2a44' : '#3a1f1f';
  let s = '';
  for (const x of rels) {
    const [x1, y1] = pos['c' + x.c]; const p = pos[x.sid]; if (!p) continue;
    const col = x.k === 'contradicts' ? 'var(--bad)' : 'var(--ok)';
    s += `<line x1="${x1}" y1="${y1}" x2="${p[0]}" y2="${p[1]}" stroke="${col}" stroke-width="1.2" opacity="0.7"/>`;
  }
  claims.forEach((c, i) => {
    const [x, y] = pos['c' + i];
    s += `<g><rect x="${x - 120}" y="${y - 14}" width="240" height="28" rx="6" fill="${stateFill(c.state)}"/><text x="${x}" y="${y + 4}" fill="#e8edf3" font-size="11" text-anchor="middle">${escapeHtml(c.text.slice(0, 34))}…</text></g>`;
  });
  srcIds.forEach((sid) => {
    const src = srcById(sid); const [x, y] = pos[sid];
    const isDerived = [...derived].some((d) => d.startsWith(sid + '>'));
    s += `<g><circle cx="${x}" cy="${y}" r="9" fill="${isDerived ? 'none' : tierFill(src?.tier ?? 9)}" stroke="${isDerived ? 'var(--warn)' : 'var(--ok)'}" stroke-dasharray="${isDerived ? '3 2' : 'none'}"/><text x="${x + 14}" y="${y + 4}" fill="#9aa7b8" font-size="11">${escapeHtml((src?.domain || sid).slice(0, 26))}</text></g>`;
  });
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = s;
}

// ---------- export / history / key ----------
$$('.exports [data-exp]').forEach((b) => b.addEventListener('click', async () => {
  if (!current) return;
  if (!staticMode) { window.open(`/api/export/${current.id}?format=${b.dataset.exp}`, '_blank'); return; }
  // Static mode: render client-side and download via Blob (no server).
  const { exportMarkdown, exportHtml } = await import('../backend/src/export.js');
  const fmt = b.dataset.exp;
  const text = fmt === 'json' ? JSON.stringify(current, null, 2) : fmt === 'html' ? exportHtml(current) : exportMarkdown(current);
  const type = fmt === 'json' ? 'application/json' : fmt === 'html' ? 'text/html' : 'text/markdown';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = `research-${current.id}.${fmt === 'html' ? 'html' : fmt === 'json' ? 'json' : 'md'}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}));
$('#printBtn').addEventListener('click', () => {
  if (!current) return;
  $$('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'report'));
  renderTab('report');
  setTimeout(() => window.print(), 60); // print dialog → Save as PDF
});
$('#again').addEventListener('click', () => {
  $('#resultView').classList.add('hidden');
  $('#askView').classList.remove('hidden');
});
$('#historyBtn').addEventListener('click', async () => {
  $('#askView').classList.add('hidden'); $('#resultView').classList.add('hidden');
  $('#historyView').classList.remove('hidden');
  let server = [];
  try { server = (await (await fetch('/api/history')).json()).items || []; } catch { /* no server */ }
  let local = [];
  try { local = JSON.parse(localStorage.getItem('er_history') || '[]'); } catch { local = []; }
  $('#histList').innerHTML = '<h3>Server</h3>' + (server.map((h) => `<div>◉ ${escapeHtml(h.question)} <span class="hint">${h.mode} · ${h.sources} sources</span> <button data-open="${h.id}">Open</button></div>`).join('') || '<p class="hint">none</p>')
    + '<h3>This browser</h3>' + (local.map((h) => `<div>◉ ${escapeHtml(h.question)} <span class="hint">${h.mode}</span>${h.direct ? ` <button data-local="${escapeAttr(h.id)}">Open</button>` : ''}</div>`).join('') || '<p class="hint">none</p>');
  $$('#histList [data-open]').forEach((b) => b.addEventListener('click', async () => {
    const r = await (await fetch('/api/history/' + b.dataset.open)).json();
    if (!r || !r.id || !r.task) { alert('Could not open that run (missing or corrupt).'); return; }
    $('#historyView').classList.add('hidden');
    showResult(r);
  }));
  $$('#histList [data-local]').forEach((b) => b.addEventListener('click', async () => {
    const { loadLocalResult } = await import('./direct.js');
    const r = loadLocalResult(b.dataset.local);
    if (!r || !r.id || !r.task) { alert('Saved result not found in this browser (storage may have been cleared).'); return; }
    $('#historyView').classList.add('hidden');
    showResult(r);
  }));
});
$('#backAsk').addEventListener('click', () => { $('#historyView').classList.add('hidden'); $('#askView').classList.remove('hidden'); });
$('#clearHist').addEventListener('click', () => { localStorage.removeItem('er_history'); alert('Local history cleared.'); });
$('#keyBtn').addEventListener('click', () => {
  if (!$('#keyDialog').open) {
    renderKeyList();
    $('#keyDialog').showModal();
  }
});
$('#closeKey').addEventListener('click', () => $('#keyDialog').close());
$('#addKey').addEventListener('click', () => {
  const keys = getStoredKeys();
  keys.push('');
  localStorage.setItem('gemini_keys', JSON.stringify(keys));
  renderKeyList();
  // Focus new input
  const inputs = $('#keyList').querySelectorAll('input');
  if (inputs.length) inputs[inputs.length - 1].focus();
});
$('#saveKey').addEventListener('click', () => {
  // Collect all keys from list
  const inputs = $('#keyList').querySelectorAll('input');
  const keys = [...inputs].map(i => i.value.trim()).filter(Boolean);
  if (keys.length) {
    localStorage.setItem('gemini_keys', JSON.stringify(keys));
    localStorage.setItem('gemini_key', keys[0]);
  }
  const model = $('#modelInput')?.value || '';
  localStorage.setItem('gemini_model', model);
  $('#modelSelect').value = model;
  $('#keyCount').textContent = keys.length ? String(keys.length) : '0';
  $('#keyCount').classList.toggle('hidden', keys.length === 0);
  $('#keyDialog').close();
});
$('#forgetKey').addEventListener('click', () => {
  localStorage.removeItem('gemini_keys');
  localStorage.removeItem('gemini_key');
  localStorage.removeItem('gemini_model');
  $('#keyList').innerHTML = '';
  $('#modelInput').value = '';
  $('#modelSelect').value = '';
  $('#keyCount').textContent = '0';
  $('#keyCount').classList.add('hidden');
  renderKeyList();
});

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

init();
