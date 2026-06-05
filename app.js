// ── State ──────────────────────────────────────────────────────────────────
const STORE_KEY = 'babyTrackerV2';
const SETTINGS_KEY = 'babyTrackerSettings';
let state = load();
let settings = loadSettings();
let currentView = 'dashboard';
let filterType = 'all';
let deferredInstallPrompt = null;
let reminderTimer = null;
let reminderCheckInterval = null;

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || defaultState(); }
  catch { return defaultState(); }
}
function defaultState() {
  return { events: [], growth: [], sleepStart: null, nextId: 1 };
}
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || defaultSettings(); }
  catch { return defaultSettings(); }
}
function defaultSettings() {
  return {
    reminderHours: 2,
    reminderEnabled: true,
    babyAgeWeeks: 0,       // usia bayi dalam minggu
    avgPumpMlPerSide: null  // kalibrasi pompa, null = pakai estimasi default
  };
}
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }

// ── Helpers ────────────────────────────────────────────────────────────────
function nowMs() { return Date.now(); }
function fmtTime(ms) {
  if (!ms || isNaN(ms)) return '—';
  return new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(ms) {
  if (!ms || isNaN(ms)) return '—';
  return new Date(ms).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}
function fmtDuration(ms) {
  if (!ms || isNaN(ms) || ms <= 0) return '0 mnt';
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

function inputToMs(val) {
  if (!val) return nowMs();
  const parts = val.split(':');
  if (parts.length < 2) return nowMs();
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return nowMs();
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
function nowInputVal() {
  return new Date().toTimeString().slice(0, 5);
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ── DBF Estimasi mL ────────────────────────────────────────────────────────
// Tabel base rate mL/menit berdasarkan usia bayi
function getDbfRateByAge(ageWeeks) {
  if (ageWeeks <= 2)  return { rate: 1.8, label: '0–2 minggu' };
  if (ageWeeks <= 6)  return { rate: 2.5, label: '2–6 minggu' };
  if (ageWeeks <= 12) return { rate: 3.2, label: '1–3 bulan' };
  if (ageWeeks <= 24) return { rate: 3.8, label: '3–6 bulan' };
  return                     { rate: 3.5, label: '6+ bulan' };  // mulai MPASI, sedikit turun
}

function estimateDbfMl(leftMins, rightMins) {
  const ageWeeks = settings.babyAgeWeeks || 0;
  const { rate } = getDbfRateByAge(ageWeeks);

  // Jika ada data kalibrasi pompa, gunakan sebagai base
  let mlPerMin = rate;
  if (settings.avgPumpMlPerSide && settings.avgPumpMlPerSide > 0) {
    // Asumsi rata-rata sesi pompa ~15 menit untuk kosongkan 1 sisi
    mlPerMin = settings.avgPumpMlPerSide / 15;
  }

  // Efisiensi hisap bayi lebih baik dari pompa, faktor 1.1–1.2
  const babyEfficiency = 1.15;
  const totalMins = (leftMins || 0) + (rightMins || 0);
  const est = Math.round(totalMins * mlPerMin * babyEfficiency);

  // Min/max guard per usia
  const limits = {
    0:  [5, 80],
    2:  [20, 120],
    6:  [40, 160],
    12: [60, 180],
    24: [60, 200]
  };
  const key = ageWeeks <= 2 ? 0 : ageWeeks <= 6 ? 2 : ageWeeks <= 12 ? 6 : ageWeeks <= 24 ? 12 : 24;
  const [minMl, maxMl] = limits[key];
  return Math.max(minMl, Math.min(maxMl, est));
}

// ── Alarm sound ────────────────────────────────────────────────────────────
function playAlarm() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.3, 0.6].forEach(offset => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880; osc.type = 'sine';
      gain.gain.setValueAtTime(0.4, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.25);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.25);
    });
  } catch(e) {}
}

// ── Reminder ───────────────────────────────────────────────────────────────
function getLastFeedingTime() {
  const last = [...state.events].reverse().find(e => e.type === 'FEEDING' || e.type === 'DBF');
  return last ? last.timestamp : null;
}
function scheduleReminder() {
  if (reminderTimer) clearTimeout(reminderTimer);
  if (reminderCheckInterval) clearInterval(reminderCheckInterval);
  if (!settings.reminderEnabled) return;
  const lastFeedTs = getLastFeedingTime();
  if (!lastFeedTs) return;
  const delay = (lastFeedTs + settings.reminderHours * 3600000) - Date.now();
  if (delay <= 0) { triggerReminder(lastFeedTs); }
  else { reminderTimer = setTimeout(() => triggerReminder(lastFeedTs), delay); }
  reminderCheckInterval = setInterval(() => {
    const lf = getLastFeedingTime();
    if (lf && (Date.now() - lf) >= settings.reminderHours * 3600000) triggerReminder(lf);
  }, 60000);
}
function triggerReminder(lastFeedTs) {
  playAlarm();
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('🍼 Waktunya menyusui!', {
      body: `Sudah ${settings.reminderHours} jam sejak feeding terakhir (${fmtTime(lastFeedTs)})`,
      icon: 'icons/icon-192.png', tag: 'feeding-reminder', renotify: true
    });
  }
  renderFeedingReminder(true);
}
function requestNotifPermission() {
  if (!('Notification' in window)) { showToast('Browser tidak mendukung notifikasi'); return; }
  if (Notification.permission === 'granted') { showToast('✅ Notifikasi sudah aktif'); return; }
  Notification.requestPermission().then(p => {
    if (p === 'granted') { showToast('✅ Notifikasi aktif!'); scheduleReminder(); }
    else showToast('❌ Izin notifikasi ditolak');
  });
}

// ── Settings ───────────────────────────────────────────────────────────────
function openSettings() {
  const m = document.getElementById('settings-modal');
  m.classList.add('open');
  document.getElementById('reminder-hours').value = settings.reminderHours;
  document.getElementById('reminder-enabled').checked = settings.reminderEnabled;
  document.getElementById('baby-age-weeks').value = settings.babyAgeWeeks || '';
  document.getElementById('pump-ml-per-side').value = settings.avgPumpMlPerSide || '';
  // sync hour buttons
  document.querySelectorAll('.hour-btn').forEach((b, i) => {
    b.classList.toggle('active', i + 1 === settings.reminderHours);
  });
  renderNotifStatus();
  renderAgeLabel();
}
function closeSettings() {
  document.getElementById('settings-modal').classList.remove('open');
}
function saveSettingsFromModal() {
  const h = parseInt(document.getElementById('reminder-hours').value, 10);
  settings.reminderHours = (h >= 1 && h <= 6) ? h : 2;
  settings.reminderEnabled = document.getElementById('reminder-enabled').checked;
  const ageWeeks = parseInt(document.getElementById('baby-age-weeks').value, 10);
  settings.babyAgeWeeks = isNaN(ageWeeks) ? 0 : ageWeeks;
  const pump = parseFloat(document.getElementById('pump-ml-per-side').value);
  settings.avgPumpMlPerSide = isNaN(pump) || pump <= 0 ? null : pump;
  saveSettings();
  scheduleReminder();
  closeSettings();
  showToast('✅ Pengaturan disimpan');
  render();
}
function renderNotifStatus() {
  const el = document.getElementById('notif-status');
  if (!('Notification' in window)) {
    el.textContent = 'Browser tidak mendukung notifikasi'; el.style.color = 'var(--muted)';
  } else if (Notification.permission === 'granted') {
    el.textContent = '✅ Aktif'; el.style.color = 'var(--weight)';
  } else if (Notification.permission === 'denied') {
    el.textContent = '❌ Diblokir'; el.style.color = 'var(--danger)';
  } else {
    el.innerHTML = '<button class="btn btn-primary" style="padding:6px 12px;font-size:12px" onclick="requestNotifPermission()">Izinkan</button>';
  }
}
function renderAgeLabel() {
  const el = document.getElementById('age-estimate-label');
  if (!el) return;
  const w = settings.babyAgeWeeks || 0;
  const { label } = getDbfRateByAge(w);
  el.textContent = w > 0 ? `Kelompok usia: ${label}` : 'Belum diset';
}

// ── Add events ─────────────────────────────────────────────────────────────
function addFeeding() {
  const ml = parseInt(document.getElementById('feed-ml').value, 10);
  if (!ml || ml <= 0) { showToast('Masukkan jumlah mL yang valid'); return; }
  const ts = inputToMs(document.getElementById('feed-time').value);
  state.events.push({ id: nextId(), type: 'FEEDING', value: ml, timestamp: ts });
  document.getElementById('feed-ml').value = '';
  document.getElementById('feed-time').value = nowInputVal();
  save(); render(); showToast('🍼 Feeding dicatat: ' + ml + ' mL');
  scheduleReminder();
}

function addDbf() {
  const left  = parseInt(document.getElementById('dbf-left').value, 10) || 0;
  const right = parseInt(document.getElementById('dbf-right').value, 10) || 0;
  if (left <= 0 && right <= 0) { showToast('Masukkan durasi minimal 1 sisi'); return; }
  const ts = inputToMs(document.getElementById('dbf-time').value);
  const estMl = estimateDbfMl(left, right);

  state.events.push({
    id: nextId(), type: 'DBF',
    leftMins: left, rightMins: right,
    estimatedMl: estMl,
    ageWeeks: settings.babyAgeWeeks || 0,
    timestamp: ts
  });

  document.getElementById('dbf-left').value = '';
  document.getElementById('dbf-right').value = '';
  document.getElementById('dbf-time').value = nowInputVal();
  document.getElementById('dbf-result').style.display = 'none';

  save(); render();
  showToast(`🤱 DBF dicatat · ~${estMl} mL`);
  scheduleReminder();
}

function previewDbf() {
  const left  = parseInt(document.getElementById('dbf-left').value, 10) || 0;
  const right = parseInt(document.getElementById('dbf-right').value, 10) || 0;
  if (left <= 0 && right <= 0) { document.getElementById('dbf-result').style.display = 'none'; return; }
  const est = estimateDbfMl(left, right);
  const el = document.getElementById('dbf-result');
  const ageW = settings.babyAgeWeeks || 0;
  const { label } = getDbfRateByAge(ageW);
  el.style.display = 'block';
  el.innerHTML = `
    <div style="font-size:13px;color:var(--text)">
      Estimasi: <strong style="color:var(--accent);font-size:16px">~${est} mL</strong>
      <span style="color:var(--muted);font-size:11px;margin-left:6px">(perkiraan)</span>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-top:4px">
      Usia: ${label} · Total ${left + right} menit
      ${settings.avgPumpMlPerSide ? ' · Kalibrasi dari data pompa' : ' · Estimasi standar'}
    </div>`;
}

function addDiaper(kind) {
  const ts = inputToMs(document.getElementById('diaper-time').value);
  state.events.push({ id: nextId(), type: kind, timestamp: ts });
  document.getElementById('diaper-time').value = nowInputVal();
  save(); render();
  showToast(kind === 'PEE' ? '💧 Pipis dicatat' : '💩 BAB dicatat');
}

function startSleep() {
  const ts = inputToMs(document.getElementById('sleep-start-time').value);
  state.sleepStart = ts;
  save(); render(); showToast('😴 Tidur dimulai ' + fmtTime(ts));
}
function endSleep() {
  if (!state.sleepStart) { showToast('Belum memulai tidur'); return; }
  const endTs = inputToMs(document.getElementById('sleep-end-time').value);
  if (endTs <= state.sleepStart) { showToast('Waktu bangun harus setelah tidur'); return; }
  const dur = endTs - state.sleepStart;
  state.events.push({ id: nextId(), type: 'SLEEP', startTime: state.sleepStart, endTime: endTs, duration: dur, timestamp: endTs });
  state.sleepStart = null;
  document.getElementById('sleep-start-time').value = nowInputVal();
  document.getElementById('sleep-end-time').value = nowInputVal();
  save(); render(); showToast('☀️ Bangun: ' + fmtDuration(dur));
}

function addGrowth() {
  const w = parseFloat(document.getElementById('growth-weight').value);
  const h = parseFloat(document.getElementById('growth-height').value);
  if (!w && !h) { showToast('Masukkan berat atau panjang badan'); return; }
  const ts = inputToMs(document.getElementById('growth-time').value);
  state.growth.push({ id: nextId(), weight: w || null, height: h || null, timestamp: ts });
  document.getElementById('growth-weight').value = '';
  document.getElementById('growth-height').value = '';
  document.getElementById('growth-time').value = nowInputVal();
  save(); render(); showToast('⚖️ Data pertumbuhan disimpan');
}

function deleteEvent(id) {
  state.events = state.events.filter(e => e.id !== id);
  save(); render();
}

// ── Export / Import ────────────────────────────────────────────────────────
function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'baby-tracker-' + new Date().toISOString().slice(0,10) + '.json';
  a.click(); showToast('📦 Data diekspor');
}
function importJSON() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (!imported.events) throw new Error();
        state = imported; save(); render(); showToast('✅ Data berhasil diimpor');
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
  renderFeedingReminder(false);
}

function renderFeedingReminder(forceShow) {
  const badge = document.getElementById('feed-reminder');
  const lastFeedTs = getLastFeedingTime();
  if (!lastFeedTs) { badge.classList.remove('show'); return; }
  const hoursAgo = (Date.now() - lastFeedTs) / 3600000;
  const threshold = settings.reminderHours;
  if (forceShow || hoursAgo >= threshold) {
    badge.classList.add('show');
    const h = Math.floor(hoursAgo), m = Math.round((hoursAgo - h) * 60);
    badge.querySelector('.reminder-text strong').textContent =
      `⚠️ Sudah ${h > 0 ? h+'j ' : ''}${m}mnt sejak feeding terakhir!`;
    badge.querySelector('.reminder-text span').textContent =
      `Terakhir: ${fmtTime(lastFeedTs)} · Reminder setiap ${threshold} jam`;
  } else { badge.classList.remove('show'); }
}

function renderSleepState() {
  const status = document.getElementById('sleep-status');
  const btn = document.getElementById('btn-sleep-start');
  const endRow = document.getElementById('sleep-end-row');
  if (state.sleepStart) {
    status.classList.add('visible');
    status.querySelector('.sleep-dur').textContent = 'Tidur sejak ' + fmtTime(state.sleepStart) + ' · ' + fmtDuration(Date.now() - state.sleepStart);
    btn.disabled = true;
    if (endRow) endRow.style.display = 'block';
  } else {
    status.classList.remove('visible');
    btn.disabled = false;
    if (endRow) endRow.style.display = 'none';
  }
}

function renderDashboard() {
  const ev = todayEvents();
  const feeds    = ev.filter(e => e.type === 'FEEDING');
  const dbfs     = ev.filter(e => e.type === 'DBF');
  const pee      = ev.filter(e => e.type === 'PEE');
  const poop     = ev.filter(e => e.type === 'POOP');
  const sleeps   = ev.filter(e => e.type === 'SLEEP');

  const totalBottleMl = feeds.reduce((a, e) => a + (parseInt(e.value, 10) || 0), 0);
  const totalDbfMl    = dbfs.reduce((a, e) => a + (parseInt(e.estimatedMl, 10) || 0), 0);
  const totalMl       = totalBottleMl + totalDbfMl;
  const totalSleep    = sleeps.reduce((a, e) => a + (parseInt(e.duration, 10) || 0), 0);
  const totalFeedings = feeds.length + dbfs.length;

  document.getElementById('stat-feeds').textContent = totalFeedings;
  document.getElementById('stat-ml').innerHTML = totalMl +
    `<span>mL</span>${totalDbfMl > 0 ? `<div style="font-size:10px;color:var(--muted)">~${totalDbfMl} mL dari DBF</div>` : ''}`;
  document.getElementById('stat-pee').textContent = pee.length;
  document.getElementById('stat-poop').textContent = poop.length;

  const sleepEl = document.getElementById('stat-sleep');
  if (totalSleep > 0) {
    const h = Math.floor(totalSleep / 3600000), m = Math.round((totalSleep % 3600000) / 60000);
    sleepEl.innerHTML = h + '<span>j</span> ' + m + '<span>mnt</span>';
  } else sleepEl.textContent = '—';

  // Last feeding (bottle or DBF)
  const lastAny = [...state.events].filter(e => e.type === 'FEEDING' || e.type === 'DBF').pop();
  const lastFeedEl = document.getElementById('last-feed-info');
  if (lastAny) {
    const hoursAgo = (Date.now() - lastAny.timestamp) / 3600000;
    const h = Math.floor(hoursAgo), m = Math.round((hoursAgo - h) * 60);
    const timeAgo = h > 0 ? `${h}j ${m}mnt lalu` : `${m}mnt lalu`;
    const label = lastAny.type === 'DBF'
      ? `🤱 DBF ~${lastAny.estimatedMl} mL`
      : `🍼 ${lastAny.value} mL`;
    lastFeedEl.innerHTML = `<strong>${label}</strong> · ${fmtTime(lastAny.timestamp)} <span style="color:var(--muted)">(${timeAgo})</span>`;
  } else lastFeedEl.innerHTML = '<span style="color:var(--muted)">Belum ada feeding</span>';

  // Growth
  const lg = state.growth[state.growth.length - 1];
  document.getElementById('stat-weight').innerHTML = lg?.weight ? lg.weight + '<span>kg</span>' : '—';
  document.getElementById('stat-heightval').innerHTML = lg?.height ? lg.height + '<span>cm</span>' : '—';

  // Countdown
  const nextFeedEl = document.getElementById('next-feed-time');
  if (nextFeedEl) {
    const lf = getLastFeedingTime();
    if (lf) {
      const diff = (lf + settings.reminderHours * 3600000) - Date.now();
      if (diff > 0) {
        const ml = Math.round(diff / 60000);
        const hl = Math.floor(ml / 60), mml = ml % 60;
        nextFeedEl.textContent = hl > 0 ? `${hl}j ${mml}mnt lagi` : `${mml}mnt lagi`;
        nextFeedEl.style.color = ml < 30 ? 'var(--danger)' : 'var(--weight)';
      } else { nextFeedEl.textContent = 'Sekarang!'; nextFeedEl.style.color = 'var(--danger)'; }
    } else { nextFeedEl.textContent = '—'; nextFeedEl.style.color = 'var(--muted)'; }
  }
}

function renderTimeline() {
  const container = document.getElementById('timeline');
  let events = [...state.events].sort((a,b) => b.timestamp - a.timestamp);
  if (filterType !== 'all') {
    events = events.filter(e => {
      if (filterType === 'feeding') return e.type === 'FEEDING' || e.type === 'DBF';
      if (filterType === 'diaper')  return e.type === 'PEE' || e.type === 'POOP';
      if (filterType === 'sleep')   return e.type === 'SLEEP';
      return true;
    });
  }
  if (events.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>Belum ada aktivitas</p></div>';
    return;
  }
  const icons = { FEEDING: '🍼', DBF: '🤱', PEE: '💧', POOP: '💩', SLEEP: '😴' };
  const typeLabel = { FEEDING: 'Botol', DBF: 'DBF', PEE: 'Pipis', POOP: 'BAB', SLEEP: 'Tidur' };
  let lastDate = '';
  container.innerHTML = events.map(e => {
    const d = fmtDate(e.timestamp);
    let dateSep = '';
    if (d !== lastDate) {
      lastDate = d;
      const isToday = d === fmtDate(Date.now());
      dateSep = `<div class="tl-date-sep">${isToday ? 'Hari ini' : d}</div>`;
    }
    let detail = '';
    if (e.type === 'FEEDING') detail = e.value + ' mL';
    if (e.type === 'DBF') {
      const parts = [];
      if (e.leftMins > 0) parts.push('Ki ' + e.leftMins + 'm');
      if (e.rightMins > 0) parts.push('Ka ' + e.rightMins + 'm');
      detail = parts.join(' · ') + ' ~' + e.estimatedMl + 'mL';
    }
    if (e.type === 'SLEEP') detail = fmtDuration(e.duration) + ' (' + fmtTime(e.startTime) + '-' + fmtTime(e.endTime) + ')';
    return dateSep + `<div class="tl-item" ontouchstart="this.classList.add('show-delete')" ontouchend="setTimeout(()=>this.classList.remove('show-delete'),2000)">
        <div class="tl-time">${fmtTime(e.timestamp)}</div>
        <div class="tl-icon">${icons[e.type] || '•'}</div>
        <div class="tl-body">
          <span class="tl-type">${typeLabel[e.type] || e.type}</span>
          ${detail ? `<span class="tl-detail">${detail}</span>` : ''}
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

// ── PWA ────────────────────────────────────────────────────────────────────
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredInstallPrompt = e;
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

// ── Backup ─────────────────────────────────────────────────────────────────
function openBackupModal() { document.getElementById('backup-modal').classList.add('open'); document.getElementById('import-area').value = ''; }
function closeBackupModal() { document.getElementById('backup-modal').classList.remove('open'); }
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

// ── Tickers ────────────────────────────────────────────────────────────────
setInterval(() => { if (state.sleepStart) renderSleepState(); renderDashboard(); }, 30000);

// ── SW ─────────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  ['feed-time','dbf-time','diaper-time','sleep-start-time','sleep-end-time','growth-time'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = nowInputVal();
  });
});

render();
scheduleReminder();
