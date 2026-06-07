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
let pumpTimerInterval = null;
let pumpStartTs = null;

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
  // Include both bottle feeding AND direct breastfeeding (DBF)
  const last = [...state.events]
    .filter(e => e.type === 'FEEDING' || e.type === 'DBF')
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  return last ? last.timestamp : null;
}

let lastTriggeredAt = null; // prevent duplicate triggers

function scheduleReminder() {
  if (reminderTimer) clearTimeout(reminderTimer);
  if (reminderCheckInterval) clearInterval(reminderCheckInterval);
  if (!settings.reminderEnabled) return;
  const lastFeedTs = getLastFeedingTime();
  if (!lastFeedTs) return;

  lastTriggeredAt = null; // reset when rescheduling after new feed
  const intervalMs = settings.reminderHours * 3600000;
  const delay = (lastFeedTs + intervalMs) - Date.now();

  if (delay <= 0) {
    triggerReminder(lastFeedTs);
  } else {
    reminderTimer = setTimeout(() => triggerReminder(lastFeedTs), delay);
  }

  // Check every minute — but only trigger once per feeding cycle
  reminderCheckInterval = setInterval(() => {
    const lf = getLastFeedingTime();
    if (!lf) return;
    const overdue = Date.now() - lf >= settings.reminderHours * 3600000;
    const alreadyTriggered = lastTriggeredAt && lastTriggeredAt >= lf;
    if (overdue && !alreadyTriggered) triggerReminder(lf);
  }, 60000);
}
function triggerReminder(lastFeedTs) {
  lastTriggeredAt = Date.now();
  playAlarm();
  const type = [...state.events]
    .filter(e => e.type === 'FEEDING' || e.type === 'DBF')
    .sort((a, b) => b.timestamp - a.timestamp)[0]?.type;
  const emoji = type === 'DBF' ? '🤱' : '🍼';
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(`${emoji} Waktunya menyusui!`, {
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

// ── Quick actions ─────────────────────────────────────────────────────────────
function quickDiaper(kind) {
  state.events.push({ id: nextId(), type: kind, timestamp: nowMs() });
  save(); render();
  // Haptic feedback
  if (navigator.vibrate) navigator.vibrate(30);
  showToast(kind === 'PEE' ? '💧 Pipis dicatat' : '💩 BAB dicatat');
}

function quickDbf() {
  // Open DBF section and scroll to it
  openSection('sec-dbf');
  document.getElementById('sec-dbf').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openMlModal() {
  document.getElementById('ml-modal').classList.add('open');
  document.getElementById('ml-input').value = '';
  // Pre-fill last used mL
  const lastBottle = [...state.events].reverse().find(e => e.type === 'FEEDING');
  if (lastBottle) document.getElementById('ml-input').value = lastBottle.value;
  setTimeout(() => document.getElementById('ml-input').focus(), 100);
}
function closeMlModal() {
  document.getElementById('ml-modal').classList.remove('open');
}
function confirmMlModal() {
  const ml = parseInt(document.getElementById('ml-input').value, 10);
  if (!ml || ml <= 0) { showToast('Masukkan jumlah mL'); return; }
  state.events.push({ id: nextId(), type: 'FEEDING', value: ml, timestamp: nowMs() });
  save(); render();
  if (navigator.vibrate) navigator.vibrate(30);
  closeMlModal();
  showToast('🍼 Feeding dicatat: ' + ml + ' mL');
  scheduleReminder();
}

function setMlPreset(ml) {
  document.getElementById('ml-input').value = ml;
}

// ── Collapsible ────────────────────────────────────────────────────────────────
function toggleSection(id, header) {
  const body = document.getElementById(id);
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  header.classList.toggle('open', !isOpen);
}
function openSection(id) {
  const body = document.getElementById(id);
  const header = body.previousElementSibling;
  body.classList.add('open');
  if (header) header.classList.add('open');
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

// ── Pumping ────────────────────────────────────────────────────────────────
function startPumpTimer() {
  if (pumpTimerInterval) return;
  pumpStartTs = Date.now();
  document.getElementById('pump-timer-start').disabled = true;
  document.getElementById('pump-timer-stop').disabled = false;
  document.getElementById('pump-timer-status').style.display = 'flex';
  pumpTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - pumpStartTs) / 1000);
    const m = Math.floor(elapsed / 60), s = elapsed % 60;
    document.getElementById('pump-elapsed').textContent =
      String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  }, 1000);
  showToast('⏱ Timer pumping dimulai');
}

function stopPumpTimer() {
  if (!pumpTimerInterval) return;
  clearInterval(pumpTimerInterval);
  pumpTimerInterval = null;
  const mins = Math.round((Date.now() - pumpStartTs) / 60000);
  document.getElementById('pump-duration').value = mins;
  document.getElementById('pump-timer-start').disabled = false;
  document.getElementById('pump-timer-stop').disabled = true;
  document.getElementById('pump-timer-status').style.display = 'none';
  showToast('⏱ Timer berhenti: ' + mins + ' menit');
}

function addPumping() {
  const dur   = parseInt(document.getElementById('pump-duration').value, 10);
  const left  = parseInt(document.getElementById('pump-left').value, 10) || 0;
  const right = parseInt(document.getElementById('pump-right').value, 10) || 0;
  if (!dur || dur <= 0) { showToast('Masukkan durasi pumping'); return; }
  const ts = inputToMs(document.getElementById('pump-time').value);
  const totalMl = left + right;

  state.events.push({
    id: nextId(), type: 'PUMP',
    duration: dur, leftMl: left, rightMl: right, totalMl,
    timestamp: ts
  });

  // Update kalibrasi pompa otomatis jika ada data per sisi
  const activeSides = (left > 0 ? 1 : 0) + (right > 0 ? 1 : 0);
  if (activeSides > 0) {
    const avgPerSide = Math.round(totalMl / activeSides);
    settings.avgPumpMlPerSide = avgPerSide;
    saveSettings();
  }

  document.getElementById('pump-duration').value = '';
  document.getElementById('pump-left').value = '';
  document.getElementById('pump-right').value = '';
  document.getElementById('pump-time').value = nowInputVal();
  pumpStartTs = null;

  save(); render();
  showToast('🔵 Pumping dicatat: ' + totalMl + ' mL · ' + dur + ' mnt');
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
  renderCharts();
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

  const pumps    = ev.filter(e => e.type === 'PUMP');
  const totalBottleMl = feeds.reduce((a, e) => a + (parseInt(e.value, 10) || 0), 0);
  const totalDbfMl    = dbfs.reduce((a, e) => a + (parseInt(e.estimatedMl, 10) || 0), 0);
  const totalPumpMl   = pumps.reduce((a, e) => a + (parseInt(e.totalMl, 10) || 0), 0);
  const totalMl       = totalBottleMl + totalDbfMl + totalPumpMl;
  const totalSleep    = sleeps.reduce((a, e) => a + (parseInt(e.duration, 10) || 0), 0);
  const totalFeedings = feeds.length + dbfs.length;

  document.getElementById('stat-feeds').textContent = totalFeedings;
  const pumpNote = totalPumpMl > 0 ? `<div style="font-size:10px;color:var(--muted)">~${totalPumpMl} mL dari pompa</div>` : '';
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
  // Last pump info
  const lastPump = [...state.events].filter(e => e.type === 'PUMP').pop();
  const lastPumpEl = document.getElementById('last-pump-info');
  if (lastPumpEl) {
    if (lastPump) {
      const hAgo = (Date.now() - lastPump.timestamp) / 3600000;
      const hh = Math.floor(hAgo), mm = Math.round((hAgo - hh) * 60);
      const ago = hh > 0 ? hh+'j '+mm+'mnt lalu' : mm+'mnt lalu';
      lastPumpEl.innerHTML = `<strong>${lastPump.totalMl} mL</strong> · ${fmtTime(lastPump.timestamp)} <span style="color:var(--muted)">(${ago})</span> · ${lastPump.duration} mnt`;
    } else {
      lastPumpEl.innerHTML = '<span style="color:var(--muted)">Belum ada pumping</span>';
    }
  }

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
      if (filterType === 'pump')    return e.type === 'PUMP';
      return true;
    });
  }
  if (events.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>Belum ada aktivitas</p></div>';
    return;
  }
  const icons = { FEEDING: '🍼', DBF: '🤱', PUMP: '🔵', PEE: '💧', POOP: '💩', SLEEP: '😴' };
  const typeLabel = { FEEDING: 'Botol', DBF: 'DBF', PUMP: 'Pompa', PEE: 'Pipis', POOP: 'BAB', SLEEP: 'Tidur' };
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
    if (e.type === 'PUMP') {
      const sides = [e.leftMl > 0 ? 'Ki '+e.leftMl+'mL' : '', e.rightMl > 0 ? 'Ka '+e.rightMl+'mL' : ''].filter(Boolean).join(' · ');
      detail = (sides || e.totalMl+'mL') + ' · ' + e.duration + 'mnt';
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

// ── Charts ────────────────────────────────────────────────────────────────────
function getLast7Days() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0,0,0,0);
    days.push({
      ts: d.getTime(),
      label: i === 0 ? 'Hari ini' : i === 1 ? 'Kemarin' : d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric' })
    });
  }
  return days;
}

function renderCharts() {
  const days = getLast7Days();

  // Build per-day data
  const data = days.map(day => {
    const nextDay = day.ts + 86400000;
    const ev = state.events.filter(e => e.timestamp >= day.ts && e.timestamp < nextDay);
    const feeds = ev.filter(e => e.type === 'FEEDING' || e.type === 'DBF');
    const bottleMl = ev.filter(e => e.type === 'FEEDING').reduce((a,e) => a + (parseInt(e.value,10)||0), 0);
    const dbfMl = ev.filter(e => e.type === 'DBF').reduce((a,e) => a + (parseInt(e.estimatedMl,10)||0), 0);
    const pumpMl = ev.filter(e => e.type === 'PUMP').reduce((a,e) => a + (parseInt(e.totalMl,10)||0), 0);
    return {
      label: day.label,
      totalMl: bottleMl + dbfMl + pumpMl,
      bottleMl, dbfMl, pumpMl,
      feedCount: feeds.length,
      pee: ev.filter(e => e.type === 'PEE').length,
      poop: ev.filter(e => e.type === 'POOP').length,
    };
  });

  drawStackedBarChart('chart-ml', data, d => d.label,
    [
      { valFn: d => d.bottleMl, color: '#e8c5a0', label: 'Botol' },
      { valFn: d => d.dbfMl,    color: '#f0a0c0', label: 'DBF' },
    ], { unit: 'mL' });
  drawBarChart('chart-freq', data, d => d.feedCount, d => d.label,
    { color: '#9b9ef0', unit: 'x', title: 'Frekuensi feeding per hari' });
  drawDualBarChart('chart-diaper', data, d => d.pee, d => d.poop, d => d.label,
    { color1: '#f2cc60', color2: '#a07850', label1: 'Pipis', label2: 'BAB', title: 'Popok per hari' });
}

function drawBarChart(canvasId, data, valFn, labelFn, opts) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.offsetWidth * devicePixelRatio;
  const H = canvas.height = canvas.offsetHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  ctx.clearRect(0, 0, w, h);

  const vals = data.map(valFn);
  const maxVal = Math.max(...vals, 1);
  const padL = 36, padR = 8, padT = 24, padB = 36;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;
  const barW = (chartW / data.length) * 0.6;
  const gap  = chartW / data.length;

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  [0.25, 0.5, 0.75, 1].forEach(f => {
    const y = padT + chartH * (1 - f);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
  });

  // Y axis labels
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.font = `${10 * devicePixelRatio / devicePixelRatio}px DM Sans`;
  ctx.textAlign = 'right';
  [0, 0.5, 1].forEach(f => {
    const y = padT + chartH * (1 - f);
    const val = Math.round(maxVal * f);
    ctx.fillText(val + (f > 0 ? '' : ''), padL - 4, y + 4);
  });

  // Bars
  data.forEach((d, i) => {
    const val = valFn(d);
    const x = padL + i * gap + (gap - barW) / 2;
    const barH = (val / maxVal) * chartH;
    const y = padT + chartH - barH;
    const isToday = i === data.length - 1;

    // Bar bg
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    roundRect(ctx, x, padT, barW, chartH, 4);
    ctx.fill();

    // Bar fill
    if (val > 0) {
      ctx.fillStyle = isToday ? opts.color : opts.color + '99';
      ctx.beginPath();
      roundRect(ctx, x, y, barW, barH, 4);
      ctx.fill();
    }

    // Value label on top
    if (val > 0) {
      ctx.fillStyle = isToday ? opts.color : 'rgba(255,255,255,0.4)';
      ctx.font = `bold ${9}px DM Sans`;
      ctx.textAlign = 'center';
      ctx.fillText(val + opts.unit, x + barW / 2, y - 4);
    }

    // X label
    ctx.fillStyle = isToday ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)';
    ctx.font = `${9}px DM Sans`;
    ctx.textAlign = 'center';
    const lbl = labelFn(d);
    ctx.fillText(lbl.length > 6 ? lbl.slice(0,6) : lbl, x + barW / 2, h - padB + 14);
  });
}

function drawStackedBarChart(canvasId, data, labelFn, series, opts) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth * devicePixelRatio;
  canvas.height = canvas.offsetHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  ctx.clearRect(0, 0, w, h);

  const totals = data.map(d => series.reduce((a, s) => a + (s.valFn(d) || 0), 0));
  const maxVal = Math.max(...totals, 1);
  const padL = 38, padR = 8, padT = 30, padB = 36;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;
  const barW = (chartW / data.length) * 0.6;
  const gap  = chartW / data.length;

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  [0.25, 0.5, 0.75, 1].forEach(f => {
    const y = padT + chartH * (1 - f);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '9px DM Sans'; ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxVal * f), padL - 4, y + 3);
  });

  // Legend top
  let lx = padL;
  series.forEach(s => {
    const hasData = data.some(d => s.valFn(d) > 0);
    if (!hasData) return;
    ctx.fillStyle = s.color;
    ctx.beginPath(); ctx.arc(lx + 4, 10, 4, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '9px DM Sans'; ctx.textAlign = 'left';
    ctx.fillText(s.label, lx + 11, 14);
    lx += ctx.measureText(s.label).width + 22;
  });

  // Stacked bars
  data.forEach((d, i) => {
    const total = totals[i];
    const x = padL + i * gap + (gap - barW) / 2;
    const isToday = i === data.length - 1;

    // bg track
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.beginPath(); roundRect(ctx, x, padT, barW, chartH, 4); ctx.fill();

    // stacked segments bottom-up
    let yOffset = padT + chartH;
    series.forEach(s => {
      const val = s.valFn(d) || 0;
      if (val <= 0) return;
      const segH = (val / maxVal) * chartH;
      yOffset -= segH;
      ctx.fillStyle = isToday ? s.color : s.color + '88';
      ctx.beginPath(); roundRect(ctx, x, yOffset, barW, segH, 3); ctx.fill();
    });

    // total label on top
    if (total > 0) {
      ctx.fillStyle = isToday ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)';
      ctx.font = 'bold 9px DM Sans'; ctx.textAlign = 'center';
      ctx.fillText(total + (opts.unit||''), x + barW/2, padT + chartH - (total/maxVal)*chartH - 4);
    }

    // X label
    ctx.fillStyle = isToday ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)';
    ctx.font = '9px DM Sans'; ctx.textAlign = 'center';
    const lbl = labelFn(d);
    ctx.fillText(lbl.length > 6 ? lbl.slice(0,6) : lbl, x + barW/2, h - padB + 14);
  });
}

function drawDualBarChart(canvasId, data, val1Fn, val2Fn, labelFn, opts) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.offsetWidth * devicePixelRatio;
  const H = canvas.height = canvas.offsetHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  ctx.clearRect(0, 0, w, h);

  const vals1 = data.map(val1Fn), vals2 = data.map(val2Fn);
  const maxVal = Math.max(...vals1, ...vals2, 1);
  const padL = 28, padR = 8, padT = 24, padB = 36;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;
  const totalBarW = (chartW / data.length) * 0.7;
  const singleW = totalBarW / 2 - 1;
  const gap = chartW / data.length;

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  [0.5, 1].forEach(f => {
    const y = padT + chartH * (1 - f);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
  });

  // Legend
  ctx.fillStyle = opts.color1; ctx.fillRect(padL, 6, 8, 8);
  ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.font = '9px DM Sans'; ctx.textAlign = 'left';
  ctx.fillText(opts.label1, padL + 11, 14);
  ctx.fillStyle = opts.color2; ctx.fillRect(padL + 50, 6, 8, 8);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText(opts.label2, padL + 63, 14);

  data.forEach((d, i) => {
    const v1 = val1Fn(d), v2 = val2Fn(d);
    const x = padL + i * gap + (gap - totalBarW) / 2;
    const isToday = i === data.length - 1;

    // bar 1 (pipis)
    if (v1 > 0) {
      const bh = (v1 / maxVal) * chartH;
      ctx.fillStyle = isToday ? opts.color1 : opts.color1 + '88';
      ctx.beginPath(); roundRect(ctx, x, padT + chartH - bh, singleW, bh, 3); ctx.fill();
      ctx.fillStyle = isToday ? opts.color1 : 'rgba(255,255,255,0.35)';
      ctx.font = 'bold 9px DM Sans'; ctx.textAlign = 'center';
      ctx.fillText(v1, x + singleW/2, padT + chartH - bh - 3);
    }
    // bar 2 (BAB)
    if (v2 > 0) {
      const bh = (v2 / maxVal) * chartH;
      ctx.fillStyle = isToday ? opts.color2 : opts.color2 + '88';
      ctx.beginPath(); roundRect(ctx, x + singleW + 2, padT + chartH - bh, singleW, bh, 3); ctx.fill();
      ctx.fillStyle = isToday ? opts.color2 : 'rgba(255,255,255,0.35)';
      ctx.font = 'bold 9px DM Sans'; ctx.textAlign = 'center';
      ctx.fillText(v2, x + singleW + 2 + singleW/2, padT + chartH - bh - 3);
    }

    // X label
    ctx.fillStyle = isToday ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)';
    ctx.font = '9px DM Sans'; ctx.textAlign = 'center';
    const lbl = labelFn(d);
    ctx.fillText(lbl.length > 6 ? lbl.slice(0,6) : lbl, x + totalBarW/2, h - padB + 14);
  });
}

function roundRect(ctx, x, y, w, h, r) {
  if (h <= 0) return;
  r = Math.min(r, h/2, w/2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── View switching ─────────────────────────────────────────────────────────
function switchView(v) {
  currentView = v;
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById('view-' + v).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`[data-view="${v}"]`).classList.add('active');
  if (v === 'charts') setTimeout(renderCharts, 50); // wait for canvas to be visible
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

// ── iOS resume fix ─────────────────────────────────────────────────────────
// When user reopens the app after it was backgrounded, refresh state + check reminder
let lastActiveAt = Date.now();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const away = Date.now() - lastActiveAt;
    // If away for more than 60 seconds, reload state and re-render
    if (away > 60000) {
      state = load();
      settings = loadSettings();
      render();
      scheduleReminder();
      // Reset time inputs to current time
      ['feed-time','dbf-time','pump-time','diaper-time','sleep-start-time','sleep-end-time','growth-time'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = nowInputVal();
      });
      // Check if overdue and show banner immediately
      checkOverdueOnResume();
    }
  } else {
    lastActiveAt = Date.now();
  }
});

// iOS Safari: pageshow fires when restoring from bfcache
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    state = load();
    settings = loadSettings();
    render();
    scheduleReminder();
    checkOverdueOnResume();
  }
});

function checkOverdueOnResume() {
  const lf = getLastFeedingTime();
  if (!lf) return;
  const hoursAgo = (Date.now() - lf) / 3600000;
  if (hoursAgo >= settings.reminderHours) {
    // Show overdue banner without playing alarm (user just opened app)
    renderFeedingReminder(true);
    // Show a toast so it's immediately obvious
    const h = Math.floor(hoursAgo);
    const m = Math.round((hoursAgo - h) * 60);
    const ago = h > 0 ? `${h}j ${m}mnt` : `${m}mnt`;
    showToast(`⚠️ Feeding terakhir ${ago} lalu!`);
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  ['feed-time','dbf-time','pump-time','diaper-time','sleep-start-time','sleep-end-time','growth-time'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = nowInputVal();
  });
  checkOverdueOnResume();
});

render();
scheduleReminder();
