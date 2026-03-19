/* ============================================================
   STATE
   ============================================================ */
let currentTab = 'text';
let selectedFile = null;
let lastResult = null;
let lastResultHindi = null;   // cached Hindi translation
let currentLang = 'en';
let historyOpen = false;

/* ============================================================
   INIT
   ============================================================ */
/* ============================================================
   THEME
   ============================================================ */
function initTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  applyTheme(saved);
}

function applyTheme(theme) {
  const btn = document.getElementById('theme-toggle');
  if (theme === 'light') {
    document.body.classList.add('light');
    if (btn) btn.textContent = '🌙';
  } else {
    document.body.classList.remove('light');
    if (btn) btn.textContent = '☀️';
  }
  localStorage.setItem('theme', theme);
}

function toggleTheme() {
  const isLight = document.body.classList.contains('light');
  applyTheme(isLight ? 'dark' : 'light');
}

/* ============================================================
   PDF DOWNLOAD
   ============================================================ */
function downloadPDF() {
  if (!lastResult) return;
  window.print();
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  const textarea = document.getElementById('doc-text');
  const charCount = document.getElementById('char-count');

  textarea.addEventListener('input', () => {
    const n = textarea.value.length;
    charCount.textContent = n.toLocaleString() + ' character' + (n !== 1 ? 's' : '');
  });

  // Load active provider info
  fetch('/api/provider')
    .then(r => r.json())
    .then(data => {
      document.getElementById('provider-label').textContent = 'Powered by ' + data.label;
      document.getElementById('footer-text').textContent =
        'Built with ' + data.label + ' · DocAnalyzer AI © 2025';
    })
    .catch(() => {
      document.getElementById('provider-label').textContent = 'AI Powered';
    });

  // Drag-and-drop
  const dropZone = document.getElementById('drop-zone');
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) setFile(file);
  });
});

/* ============================================================
   TAB SWITCHING
   ============================================================ */
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
}

/* ============================================================
   FILE HANDLING
   ============================================================ */
function handleFileSelect(input) {
  if (input.files[0]) setFile(input.files[0]);
}

function setFile(file) {
  selectedFile = file;
  const preview = document.getElementById('file-preview');
  const icon = getFileIcon(file.name);
  const size = (file.size / 1024).toFixed(1) + ' KB';
  preview.innerHTML = `${icon} <strong>${file.name}</strong> <span style="color:var(--text-muted);margin-left:4px;">${size}</span>`;
  preview.style.display = 'flex';
}

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    pdf: '📄', docx: '📝', doc: '📝', txt: '📃', md: '📋', csv: '📊'
  };
  return icons[ext] || '📁';
}

/* ============================================================
   ANALYZE
   ============================================================ */
async function analyze() {
  hideError();
  hideResults();

  const btn = document.getElementById('analyze-btn');

  if (currentTab === 'text') {
    const text = document.getElementById('doc-text').value.trim();
    if (text.length < 20) {
      showError('Please paste some document text (at least 20 characters).');
      return;
    }
    setLoading(true);
    btn.disabled = true;
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.detail || data.error || 'Analysis failed.');
      renderResults(data.result, null, data.cached);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
      btn.disabled = false;
    }
  } else {
    if (!selectedFile) {
      showError('Please select a file to analyze.');
      return;
    }
    setLoading(true);
    btn.disabled = true;
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      const res = await fetch('/api/analyze-file', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.detail || data.error || 'Analysis failed.');
      renderResults(data.result, data.fileName, data.cached);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
      btn.disabled = false;
    }
  }
}

/* ============================================================
   RENDER RESULTS
   ============================================================ */
function renderResults(result, fileName, cached = false, isTranslation = false) {
  if (!isTranslation) {
    lastResult = result;
    lastResultHindi = null;
    currentLang = 'en';
    // Reset toggle to EN
    document.getElementById('lang-en')?.classList.add('active');
    document.getElementById('lang-hi')?.classList.remove('active');
    document.getElementById('lang-toggle').style.display = 'flex';
  }

  // Overview
  document.getElementById('overview-text').textContent = result.overview || '—';

  // Key points
  const kpList = document.getElementById('key-points-list');
  kpList.innerHTML = '';
  (result.keyPoints || []).forEach(pt => {
    const li = document.createElement('li');
    li.textContent = pt;
    kpList.appendChild(li);
  });

  // Insights
  const iList = document.getElementById('insight-list');
  iList.innerHTML = '';
  (result.insights || []).forEach(ins => {
    const li = document.createElement('li');
    li.textContent = ins;
    iList.appendChild(li);
  });

  // Critical data
  const dList = document.getElementById('data-list');
  const dSection = document.getElementById('section-data');
  dList.innerHTML = '';
  const dataItems = result.criticalData || [];
  if (dataItems.length === 0) {
    dSection.style.display = 'none';
  } else {
    dSection.style.display = '';
    dataItems.forEach(d => {
      const li = document.createElement('li');
      li.textContent = d;
      dList.appendChild(li);
    });
  }

  // Conclusion
  document.getElementById('conclusion-text').textContent = result.conclusion || '—';

  // File badge
  const badge = document.getElementById('file-badge');
  if (fileName) {
    badge.textContent = fileName;
    badge.style.display = 'inline';
  } else {
    badge.style.display = 'none';
  }

  // Cache badge
  document.getElementById('cache-badge').style.display = cached ? 'inline-flex' : 'none';

  document.getElementById('results').style.display = 'block';
  document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ============================================================
   COPY RESULTS
   ============================================================ */
async function copyResults() {
  if (!lastResult) return;
  const r = lastResult;
  let text = `DOCUMENT ANALYSIS\n${'='.repeat(50)}\n\n`;
  text += `OVERVIEW\n${r.overview}\n\n`;
  text += `KEY POINTS\n${(r.keyPoints || []).map(p => '• ' + p).join('\n')}\n\n`;
  text += `INSIGHTS & TAKEAWAYS\n${(r.insights || []).map(i => '→ ' + i).join('\n')}\n\n`;
  if (r.criticalData?.length) {
    text += `CRITICAL DATA\n${r.criticalData.map(d => '# ' + d).join('\n')}\n\n`;
  }
  text += `CONCLUSION\n${r.conclusion}`;

  try {
    await navigator.clipboard.writeText(text);
    const btn = document.querySelector('.btn-copy');
    const orig = btn.innerHTML;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
    btn.style.color = 'var(--green)';
    setTimeout(() => { btn.innerHTML = orig; btn.style.color = ''; }, 2000);
  } catch (_) {}
}

/* ============================================================
   UI HELPERS
   ============================================================ */
function setLoading(on) {
  document.getElementById('loading').style.display = on ? 'block' : 'none';
  document.getElementById('analyze-btn').innerHTML = on
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Analyzing...`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Analyze Document`;
}

function showError(msg) {
  document.getElementById('error-msg').textContent = msg;
  document.getElementById('error-state').style.display = 'flex';
}

function hideError() {
  document.getElementById('error-state').style.display = 'none';
}

function closeError() { hideError(); }

function hideResults() {
  document.getElementById('results').style.display = 'none';
  document.getElementById('lang-toggle').style.display = 'none';
  lastResultHindi = null;
  currentLang = 'en';
}

function clearAll() {
  document.getElementById('doc-text').value = '';
  document.getElementById('char-count').textContent = '0 characters';
  selectedFile = null;
  lastResult = null;
  document.getElementById('file-input').value = '';
  document.getElementById('file-preview').style.display = 'none';
  hideError();
  hideResults();
}

/* ============================================================
   LANGUAGE TOGGLE (Hindi / English)
   ============================================================ */
async function switchLang(lang) {
  if (lang === currentLang) return;

  const btnEn = document.getElementById('lang-en');
  const btnHi = document.getElementById('lang-hi');

  if (lang === 'en') {
    currentLang = 'en';
    btnEn.classList.add('active');
    btnHi.classList.remove('active');
    renderResults(lastResult, null, false, true);
    return;
  }

  // Switch to Hindi
  if (lastResultHindi) {
    currentLang = 'hi';
    btnEn.classList.remove('active');
    btnHi.classList.add('active');
    renderResults(lastResultHindi, null, false, true);
    return;
  }

  // Translate via API
  btnHi.disabled = true;
  btnHi.textContent = '...';
  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: lastResult }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.detail || 'Translation failed.');
    lastResultHindi = data.result;
    currentLang = 'hi';
    btnEn.classList.remove('active');
    btnHi.classList.add('active');
    renderResults(lastResultHindi, null, false, true);
  } catch (err) {
    showError(err.message);
  } finally {
    btnHi.disabled = false;
    btnHi.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/><line x1="2" y1="12" x2="22" y2="12"/></svg> हिंदी`;
  }
}

/* ============================================================
   HISTORY
   ============================================================ */
async function openHistory() {
  historyOpen = true;
  document.getElementById('history-overlay').classList.add('open');
  document.getElementById('history-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  await loadHistory();
}

function closeHistory() {
  historyOpen = false;
  document.getElementById('history-overlay').classList.remove('open');
  document.getElementById('history-modal').classList.remove('open');
  document.body.style.overflow = '';
}

async function loadHistory() {
  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  const countEl = document.getElementById('history-count');

  list.innerHTML = '';
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    const items = data.items || [];

    countEl.textContent = items.length;

    if (items.length === 0) {
      list.appendChild(empty);
      empty.style.display = 'flex';
      document.getElementById('clear-history-btn').style.display = 'none';
      return;
    }

    document.getElementById('clear-history-btn').style.display = '';
    items.forEach(item => {
      const el = document.createElement('div');
      el.className = 'history-item';
      el.onclick = () => { renderResults(item.result, item.source !== 'Pasted text' ? item.source : null, item.cached); closeHistory(); };

      const time = new Date(item.timestamp).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });

      el.innerHTML = `
        <div class="history-item-header">
          <span class="history-item-source">${escHtml(item.source)}</span>
          <div class="history-item-meta">
            ${item.cached ? '<span class="history-item-cached">Cached</span>' : ''}
            <span class="history-item-provider">${escHtml(item.provider)}</span>
          </div>
        </div>
        <div class="history-item-overview">${escHtml(item.overview)}</div>
        <div style="margin-top:6px;font-size:0.68rem;color:var(--text-muted)">${time}</div>
      `;
      list.appendChild(el);
    });
  } catch (e) {
    list.appendChild(empty);
    empty.style.display = 'flex';
    empty.querySelector('p').innerHTML = 'No Recent chat history saved.';
    document.getElementById('clear-history-btn').style.display = 'none';
  }
}

async function clearHistory() {
  if (!confirm('Clear all history?')) return;
  try {
    await fetch('/api/history', { method: 'DELETE' });
    await loadHistory();
  } catch (e) {
    showError('Failed to clear history.');
  }
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
