// ── State ──────────────────────────────────────────────────────────────────
const STORE_KEY = 'babyTrackerV2';
let state = load();
let currentView = 'dashboard';
let filterType = 'all';
let deferredInstallPrompt = null;

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || defaultState();
  } catch { return defaultState(); }
}
function defaultState() {
  return { events: [], growth: [], sleepStart: null, nextId: 1 };
}
function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

// ── Helpers ────────────────────────────────────────────────────────────────
function nowMs() { return Date.now(); }
function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(ms) {
  return new Date(ms).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}
function fmtDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return mins + ' mnt';
  const h = Math.floor(mins / 60), m = mins % 60;
  return h + 'j ' + (m > 0 ? m + 'mnt' : '');
}
function todayStart() {
  const d = new Date(); d.setHours(0,0,0,0); return d.getTime();
}
function todayEvents() {
  return state.events.filter(e => e.timestamp >= todayStart());
}
function nextId() { return state.nextId++; }

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

// ── Add events ─────────────────────────────────────────────────────────────
function addFeeding() {
  const ml = parseInt(document.getElementById('feed-ml').value);
  if (!ml || ml <= 0) { showToast('Masukkan jumlah mL yang valid'); return; }
  state.events.push({ id: nextId(), type: 'FEEDING', value: ml, timestamp: nowMs() });
  document.getElementById('feed-ml').value = '';
  save(); render(); showToast('🍼 Feeding dicatat: ' + ml + ' mL');
  scheduleReminderCheck();
}

function addDiaper(kind) {
  state.events.push({ id: nextId(), type: kind, timestamp: nowMs() });
  save(); render();
  showToast(kind === 'PEE' ? '💧 Pipis dicatat' : '💩 BAB dicatat');
}

function startSleep() {
  state.sleepStart = nowMs();
  save(); render(); showToast('😴 Tidur dimulai');
}
function endSleep() {
  if (!state.sleepStart) { showToast('Belum memulai tidur'); return; }
  const dur = nowMs() - state.sleepStart;
  state.events.push({
    id: nextId(), type: 'SLEEP',
    startTime: state.sleepStart, endTime: nowMs(),
    duration: dur, timestamp: nowMs()
  });
  state.sleepStart = null;
  save(); render(); showToast('☀️ Bangun dicatat: ' + fmtDuration(dur));
}

function addGrowth() {
  const w = parseFloat(document.getElementById('growth-weight').value);
  const h = parseFloat(document.getElementById('growth-height').value);
  if (!w && !h) { showToast('Masukkan berat atau panjang badan'); return; }
  state.growth.push({ id: nextId(), weight: w || null, height: h || null, timestamp: nowMs() });
  document.getElementById('growth-weight').value = '';
  document.getElementById('growth-height').value = '';
  save(); render(); showToast('⚖️ Data pertumbuhan disimpan');
}

function deleteEvent(id) {
  state.events = state.events.filter(e => e.id !== id);
  save(); render();
}

// ── Reminder check ─────────────────────────────────────────────────────────
function scheduleReminderCheck() {
  // browser notification after 3 hours from last feed
  if (!('Notification' in window)) return;
  const lastFeed = [...state.events].reverse().find(e => e.type === 'FEEDING');
  if (!lastFeed) return;
  const delay = (lastFeed.timestamp + 3 * 3600000) - Date.now();
  if (delay <= 0) return;
  setTimeout(() => {
    if (Notification.permission === 'granted') {
      new Notification('🍼 Sudah waktunya menyusui!', {
        body: 'Sudah 3 jam sejak feeding terakhir.',
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text y="52" font-size="52">🍼</text></svg>'
      });
    }
  }, delay);
}

function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(p => {
      if (p === 'granted') { showToast('✅ Notifikasi aktif'); scheduleReminderCheck(); }
    });
  }
}

// ── Export / Import ────────────────────────────────────────────────────────
function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'baby-tracker-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  showToast('📦 Data diekspor');
}

function importJSON() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (!imported.events) throw new Error('Format tidak valid');
        state = imported;
        save(); render();
        showToast('✅ Data berhasil diimpor');
      } catch { showToast('❌ File tidak valid'); }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ── Render ─────────────────────────────────────────────────────────────────
function render() {
  renderDashboard();
  renderTimeline();
  renderGrowth();
  renderSleepState();
  renderFeedingReminder();
}

function renderFeedingReminder() {
  const badge = document.getElementById('feed-reminder');
  const lastFeed = [...state.events].reverse().find(e => e.type === 'FEEDING');
  if (!lastFeed) { badge.classList.remove('show'); return; }
  const hoursAgo = (Date.now() - lastFeed.timestamp) / 3600000;
  if (hoursAgo >= 3) {
    badge.classList.add('show', 'warning');
    badge.querySelector('.reminder-text strong').textContent = '⚠️ Sudah ' + Math.floor(hoursAgo) + ' jam sejak feeding!';
    badge.querySelector('.reminder-text span').textContent = 'Feeding terakhir: ' + fmtTime(lastFeed.timestamp) + ' (' + lastFeed.value + ' mL)';
  } else {
    badge.classList.remove('show');
  }
}

function renderSleepState() {
  const status = document.getElementById('sleep-status');
  const btn = document.getElementById('btn-sleep-start');
  if (state.sleepStart) {
    status.classList.add('visible');
    const dur = fmtDuration(Date.now() - state.sleepStart);
    status.querySelector('.sleep-dur').textContent = 'Tidur sejak ' + fmtTime(state.sleepStart) + ' · ' + dur;
    btn.disabled = true;
  } else {
    status.classList.remove('visible');
    btn.disabled = false;
  }
}

function renderDashboard() {
  const ev = todayEvents();
  const feeds = ev.filter(e => e.type === 'FEEDING');
  const pee = ev.filter(e => e.type === 'PEE');
  const poop = ev.filter(e => e.type === 'POOP');
  const sleeps = ev.filter(e => e.type === 'SLEEP');
  const totalMl = feeds.reduce((a, e) => a + e.value, 0);
  const totalSleep = sleeps.reduce((a, e) => a + e.duration, 0);
  const lastFeed = feeds[feeds.length - 1];

  document.getElementById('stat-feeds').textContent = feeds.length;
  document.getElementById('stat-ml').innerHTML = totalMl + '<span>mL</span>';
  document.getElementById('stat-pee').textContent = pee.length;
  document.getElementById('stat-poop').textContent = poop.length;

  const sleepEl = document.getElementById('stat-sleep');
  if (totalSleep > 0) {
    const h = Math.floor(totalSleep / 3600000);
    const m = Math.round((totalSleep % 3600000) / 60000);
    sleepEl.innerHTML = h + '<span>j</span> ' + m + '<span>mnt</span>';
  } else {
    sleepEl.textContent = '—';
  }

  const lastFeedEl = document.getElementById('last-feed-info');
  if (lastFeed) {
    const hoursAgo = ((Date.now() - lastFeed.timestamp) / 3600000).toFixed(1);
    lastFeedEl.innerHTML = `<strong>${lastFeed.value} mL</strong> · ${fmtTime(lastFeed.timestamp)} (${hoursAgo} jam lalu)`;
  } else {
    lastFeedEl.innerHTML = '<span style="color:var(--muted)">Belum ada feeding hari ini</span>';
  }

  // latest growth
  const latestGrowth = state.growth[state.growth.length - 1];
  const gwEl = document.getElementById('stat-weight');
  const ghEl = document.getElementById('stat-heightval');
  if (latestGrowth) {
    gwEl.innerHTML = latestGrowth.weight ? latestGrowth.weight + '<span>kg</span>' : '—';
    ghEl.innerHTML = latestGrowth.height ? latestGrowth.height + '<span>cm</span>' : '—';
  } else {
    gwEl.textContent = '—'; ghEl.textContent = '—';
  }
}

function renderTimeline() {
  const container = document.getElementById('timeline');
  let events = [...state.events].reverse();
  if (filterType !== 'all') {
    events = events.filter(e => {
      if (filterType === 'feeding') return e.type === 'FEEDING';
      if (filterType === 'diaper') return e.type === 'PEE' || e.type === 'POOP';
      if (filterType === 'sleep') return e.type === 'SLEEP';
      return true;
    });
  }

  if (events.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>Belum ada aktivitas yang dicatat</p></div>';
    return;
  }

  const icons = { FEEDING: '🍼', PEE: '💧', POOP: '💩', SLEEP: '😴' };
  const typeLabel = { FEEDING: 'Feeding', PEE: 'Pipis', POOP: 'BAB', SLEEP: 'Tidur' };

  let lastDate = '';
  container.innerHTML = events.map(e => {
    const d = fmtDate(e.timestamp);
    let dateSep = '';
    if (d !== lastDate) {
      lastDate = d;
      dateSep = `<div style="font-size:11px;color:var(--muted);padding:10px 0 4px;letter-spacing:0.3px;text-transform:uppercase;">${d === fmtDate(Date.now()) ? 'Hari ini' : d}</div>`;
    }
    let detail = '';
    if (e.type === 'FEEDING') detail = e.value + ' mL';
    if (e.type === 'SLEEP') detail = fmtDuration(e.duration) + ' · ' + fmtTime(e.startTime) + '–' + fmtTime(e.endTime);

    return dateSep + `
      <div class="tl-item">
        <div class="tl-time">${fmtTime(e.timestamp)}</div>
        <div class="tl-dot">${icons[e.type] || '•'}</div>
        <div class="tl-body">
          <div class="tl-type">${typeLabel[e.type] || e.type}</div>
          ${detail ? `<div class="tl-detail">${detail}</div>` : ''}
        </div>
        <button class="tl-delete" onclick="deleteEvent(${e.id})" aria-label="Hapus">✕</button>
      </div>`;
  }).join('');
}

function renderGrowth() {
  const container = document.getElementById('growth-list');
  if (state.growth.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📏</div><p>Belum ada data pertumbuhan</p></div>';
    return;
  }
  container.innerHTML = [...state.growth].reverse().slice(0, 10).map(g => `
    <div class="growth-item">
      <div class="tl-dot" style="background:var(--surface)">📊</div>
      <div style="flex:1">
        ${g.weight ? `<span class="growth-val" style="color:var(--weight)">${g.weight} kg</span> ` : ''}
        ${g.height ? `<span class="growth-val" style="color:var(--height)">${g.height} cm</span>` : ''}
      </div>
      <div class="growth-date">${fmtDate(g.timestamp)}</div>
    </div>`).join('');
}

// ── View switching ─────────────────────────────────────────────────────────
function switchView(v) {
  currentView = v;
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById('view-' + v).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`[data-view="${v}"]`).classList.add('active');
}

function setFilter(type) {
  filterType = type;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  renderTimeline();
}

// ── PWA install ────────────────────────────────────────────────────────────
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  document.getElementById('install-banner').classList.add('show');
});

function installPWA() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.then(() => {
    deferredInstallPrompt = null;
    document.getElementById('install-banner').classList.remove('show');
  });
}

// ── Backup modal ────────────────────────────────────────────────────────────
function openBackupModal() {
  document.getElementById('backup-modal').classList.add('open');
  document.getElementById('import-area').value = '';
}
function closeBackupModal() {
  document.getElementById('backup-modal').classList.remove('open');
}
function importFromTextarea() {
  const txt = document.getElementById('import-area').value.trim();
  if (!txt) { showToast('Tempel JSON terlebih dahulu'); return; }
  try {
    const imported = JSON.parse(txt);
    if (!imported.events) throw new Error();
    state = imported; save(); render();
    closeBackupModal(); showToast('✅ Data berhasil diimpor');
  } catch { showToast('❌ Format JSON tidak valid'); }
}

// ── Sleep timer tick ───────────────────────────────────────────────────────
setInterval(() => { if (state.sleepStart) renderSleepState(); }, 30000);

// ── Service Worker ─────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ── Init ───────────────────────────────────────────────────────────────────
render();
scheduleReminderCheck();
