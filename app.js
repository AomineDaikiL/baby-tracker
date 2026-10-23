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
  try {
    return normalizeState(JSON.parse(localStorage.getItem(STORE_KEY)) || defaultState());
  } catch { return defaultState(); }
}
function defaultState() {
  return {
    events: [],
    growth: [],
    foods: [],             // makanan yang pernah dicoba: { id, key, name, firstTs, firstEventId, note }
    sleepStart: null,
    nextId: 1
  };
}
// Pastikan struktur state lengkap (data lama / hasil import lama tidak punya "foods")
function normalizeState(st) {
  if (!st || typeof st !== 'object') return defaultState();
  if (!Array.isArray(st.events)) st.events = [];
  if (!Array.isArray(st.growth)) st.growth = [];
  if (!Array.isArray(st.foods)) st.foods = [];
  if (typeof st.nextId !== 'number') {
    const ids = [...st.events, ...st.growth, ...st.foods].map(x => x.id || 0);
    st.nextId = 1 + Math.max(0, ...ids);
  }
  return st;
}
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || defaultSettings(); }
  catch { return defaultSettings(); }
}
function defaultSettings() {
  return {
    reminderHours: 2,
    reminderEnabled: true,
    babyName: '',
    babyBirthDate: '',     // ISO date string YYYY-MM-DD
    babyGender: '',        // 'boy' | 'girl' | ''
    babyAgeWeeks: 0,       // fallback if no birthdate set
    avgPumpMlPerSide: null,
    chartDays: 7,          // rentang grafik: 7 / 14 / 21 / 30 hari
    foodWatchDays: 3,      // lama makanan baru ditandai "dipantau" (hari)
    retentionDays: 90      // 0 = nonaktif; install lama tanpa field ini = nonaktif sampai dipilih
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
let _todayStartCache = null;
let _todayStartDate = '';
function todayStart() {
  const dateStr = new Date().toDateString();
  if (dateStr !== _todayStartDate) {
    _todayStartDate = dateStr;
    const d = new Date(); d.setHours(0,0,0,0);
    _todayStartCache = d.getTime();
  }
  return _todayStartCache;
}
function todayEvents() {
  const ts = todayStart();
  return state.events.filter(e => e.timestamp >= ts);
}
function nextId() { return state.nextId++; }

function inputToMs(val, dateVal) {
  if (dateVal) {
    // Tanggal eksplisit (maks. 7 hari ke belakang, tidak boleh di masa depan)
    const dp = dateVal.split('-').map(n => parseInt(n, 10));
    const tp = (val || nowInputVal()).split(':').map(n => parseInt(n, 10));
    if (dp.length === 3 && !dp.some(isNaN) && tp.length >= 2 && !tp.some(isNaN)) {
      const d = new Date(dp[0], dp[1] - 1, dp[2], tp[0], tp[1], 0, 0);
      const min = new Date(); min.setDate(min.getDate() - 7); min.setHours(0, 0, 0, 0);
      return Math.min(Math.max(d.getTime(), min.getTime()), nowMs());
    }
  }
  if (!val) return nowMs();
  const parts = val.split(':');
  if (parts.length < 2) return nowMs();
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return nowMs();
  const d = new Date();
  d.setHours(h, m, 0, 0);
  // If resulting time is more than 1 hour in the future, assume it was yesterday
  if (d.getTime() > Date.now() + 3600000) {
    d.setDate(d.getDate() - 1);
  }
  return d.getTime();
}
function nowInputVal() {
  return new Date().toTimeString().slice(0, 5);
}
function dateInputStr(offsetDays) {
  const d = new Date(); d.setDate(d.getDate() + (offsetDays || 0));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// Field tanggal Botol/Popok: default hari ini, bisa mundur sampai 7 hari
function resetBackdateInputs() {
  ['feed-date', 'diaper-date', 'mpasi-date'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.min = dateInputStr(-7);
    el.max = dateInputStr(0);
    el.value = dateInputStr(0);
  });
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ── DBF Estimasi mL ────────────────────────────────────────────────────────
// Tabel base rate mL/menit berdasarkan usia bayi
function getBabyAgeWeeks() {
  if (settings.babyBirthDate) {
    const birth = new Date(settings.babyBirthDate);
    const diffMs = Date.now() - birth.getTime();
    return Math.max(0, Math.floor(diffMs / (7 * 24 * 3600000)));
  }
  return settings.babyAgeWeeks || 0;
}

function getBabyAgeLabel() {
  const weeks = getBabyAgeWeeks();
  if (weeks < 4) return weeks + ' minggu';
  const months = Math.floor(weeks / 4.33);
  const remWeeks = Math.floor(weeks - months * 4.33);
  if (months < 12) return months + ' bulan' + (remWeeks > 0 ? ' ' + remWeeks + ' minggu' : '');
  const years = Math.floor(months / 12), remMonths = months % 12;
  return years + ' tahun' + (remMonths > 0 ? ' ' + remMonths + ' bulan' : '');
}

function getDbfRateByAge(ageWeeks) {
  if (ageWeeks <= 2)  return { rate: 1.8, label: '0–2 minggu' };
  if (ageWeeks <= 6)  return { rate: 2.5, label: '2–6 minggu' };
  if (ageWeeks <= 12) return { rate: 3.2, label: '1–3 bulan' };
  if (ageWeeks <= 24) return { rate: 3.8, label: '3–6 bulan' };
  return                     { rate: 3.5, label: '6+ bulan' };  // mulai MPASI, sedikit turun
}

function estimateDbfMl(leftMins, rightMins) {
  const ageWeeks = getBabyAgeWeeks();
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
  document.getElementById('settings-modal').classList.add('open');
  document.getElementById('reminder-hours').value = settings.reminderHours;
  document.getElementById('reminder-enabled').checked = settings.reminderEnabled;
  document.getElementById('retention-days').value = String(settings.retentionDays ?? 0);
  document.getElementById('food-watch-days').value = String(settings.foodWatchDays ?? 3);
  const verEl = document.getElementById('app-version');
  if (verEl) verEl.textContent = 'Versi app ' + APP_VERSION;
  const pumpEl = document.getElementById('pump-ml-per-side');
  if (pumpEl) pumpEl.value = settings.avgPumpMlPerSide || '';
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
  settings.reminderHours = (h >= 1 && h <= 5) ? h : 2;
  settings.reminderEnabled = document.getElementById('reminder-enabled').checked;

  const pumpEl = document.getElementById('pump-ml-per-side');
  if (pumpEl) {
    const pump = parseFloat(pumpEl.value);
    settings.avgPumpMlPerSide = isNaN(pump) || pump <= 0 ? null : pump;
  }
  settings.foodWatchDays = parseInt(document.getElementById('food-watch-days').value, 10) || 3;
  settings.retentionDays = parseInt(document.getElementById('retention-days').value, 10) || 0;
  saveSettings();
  runDataCleanup();
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
  const w = getBabyAgeWeeks();
  const { label } = getDbfRateByAge(w);
  const ageStr = w > 0 ? getBabyAgeLabel() : null;
  el.textContent = ageStr ? `${ageStr} · ${label}` : 'Belum diset';
}

// ── Quick actions ─────────────────────────────────────────────────────────────
function quickDiaper(kind) {
  state.events.push({ id: nextId(), type: kind, timestamp: nowMs() });
  save(); render('diaper');
  // Haptic feedback
  if (navigator.vibrate) navigator.vibrate(30);
  showToast(kind === 'PEE' ? '💧 Pipis dicatat' : '💩 BAB dicatat');
}

function quickSleep() {
  if (state.sleepStart) {
    // Already sleeping — stop it
    const dur = nowMs() - state.sleepStart;
    state.events.push({ id: nextId(), type: 'SLEEP', startTime: state.sleepStart, endTime: nowMs(), duration: dur, timestamp: nowMs() });
    state.sleepStart = null;
    save(); render('sleep');
    if (navigator.vibrate) navigator.vibrate([30, 50, 30]);
    showToast('☀️ Bangun: ' + fmtDuration(dur));
  } else {
    state.sleepStart = nowMs();
    save(); render('sleep');
    if (navigator.vibrate) navigator.vibrate(30);
    showToast('😴 Tidur dimulai');
  }
}

function quickDbf() {
  document.getElementById('dbf-modal').classList.add('open');
  document.getElementById('dbf-modal-left').value = '';
  document.getElementById('dbf-modal-right').value = '';
  document.getElementById('dbf-modal-result').textContent = '';
  setTimeout(() => document.getElementById('dbf-modal-left').focus(), 100);
}
function closeDbfModal() {
  document.getElementById('dbf-modal').classList.remove('open');
}
function previewDbfModal() {
  const l = parseInt(document.getElementById('dbf-modal-left').value, 10) || 0;
  const r = parseInt(document.getElementById('dbf-modal-right').value, 10) || 0;
  const el = document.getElementById('dbf-modal-result');
  if (l > 0 || r > 0) {
    const est = estimateDbfMl(l, r);
    el.textContent = '~' + est + ' mL';
    el.style.color = 'var(--accent)';
  } else {
    el.textContent = '';
  }
}
function confirmDbfModal() {
  const l = parseInt(document.getElementById('dbf-modal-left').value, 10) || 0;
  const r = parseInt(document.getElementById('dbf-modal-right').value, 10) || 0;
  if (l <= 0 && r <= 0) { showToast('Masukkan durasi minimal 1 sisi'); return; }
  const estMl = estimateDbfMl(l, r);
  state.events.push({ id: nextId(), type: 'DBF', leftMins: l, rightMins: r, estimatedMl: estMl, ageWeeks: getBabyAgeWeeks(), timestamp: nowMs() });
  save(); render('feed');
  if (navigator.vibrate) navigator.vibrate(30);
  closeDbfModal();
  showToast('🤱 DBF dicatat · ~' + estMl + ' mL');
  scheduleReminder();
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
  save(); render('feed');
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
  const mlEl = document.getElementById('feed-ml');
  const ml = parseInt(mlEl.value, 10);
  if (!ml || ml <= 0) {
    mlEl.style.borderColor = 'var(--danger)';
    setTimeout(() => mlEl.style.borderColor = '', 2000);
    showToast('⚠️ Masukkan jumlah mL yang valid'); return;
  }
  mlEl.style.borderColor = '';
  const ts = inputToMs(document.getElementById('feed-time').value, document.getElementById('feed-date').value);
  state.events.push({ id: nextId(), type: 'FEEDING', value: ml, timestamp: ts });
  document.getElementById('feed-ml').value = '';
  document.getElementById('feed-time').value = nowInputVal();
  resetBackdateInputs();
  save(); render('feed'); showToast('🍼 Feeding dicatat: ' + ml + ' mL');
  scheduleReminder();
}

// ── MPASI ──────────────────────────────────────────────────────────────────
const MPASI_PORTION = { sedikit: 'Sedikit', setengah: 'Setengah', habis: 'Habis' };
const MPASI_REACTION = { suka: '😋 Suka', biasa: '😐 Biasa', menolak: '🙅 Menolak' };

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function normFood(n) { return String(n).trim().toLowerCase().replace(/\s+/g, ' '); }
function titleFood(n) { return n.replace(/(^|\s)\S/g, c => c.toUpperCase()); }
function parseFoodList(text) {
  const seen = new Set(), out = [];
  String(text || '').split(/[,;\n]+/).forEach(part => {
    const key = normFood(part).slice(0, 30);
    if (key && !seen.has(key)) { seen.add(key); out.push(key); }
  });
  return out.slice(0, 12);
}
function findFood(key) { return state.foods.find(f => f.key === key); }

function selectChip(groupId, btn) {
  const wasActive = btn.classList.contains('active');
  document.querySelectorAll('#' + groupId + ' .chip').forEach(c => c.classList.remove('active'));
  if (!wasActive) btn.classList.add('active');   // tap lagi = batal pilih
}
function getChip(groupId) {
  const el = document.querySelector('#' + groupId + ' .chip.active');
  return el ? el.dataset.val : '';
}
function clearChips(groupId) {
  document.querySelectorAll('#' + groupId + ' .chip').forEach(c => c.classList.remove('active'));
}

function previewMpasiFoods() {
  const el = document.getElementById('mpasi-foods-hint');
  if (!el) return;
  const keys = parseFoodList(document.getElementById('mpasi-foods').value);
  if (!keys.length) { el.textContent = ''; return; }
  const fresh = keys.filter(k => !findFood(k)).map(k => esc(titleFood(k)));
  const known = keys.filter(k => findFood(k)).map(k => esc(titleFood(k)));
  el.innerHTML = (fresh.length ? '🆕 Baru: <b>' + fresh.join(', ') + '</b>' : '') +
    (fresh.length && known.length ? ' · ' : '') +
    (known.length ? 'Pernah: ' + known.join(', ') : '');
}

function openMpasiForm() {
  switchView('log');
  openSection('sec-mpasi');
  setTimeout(() => {
    const el = document.getElementById('mpasi-menu');
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
  }, 120);
}

function addMpasi() {
  const menuEl = document.getElementById('mpasi-menu');
  const menu = menuEl.value.trim();
  const foodKeys = parseFoodList(document.getElementById('mpasi-foods').value);
  if (!menu && !foodKeys.length) {
    menuEl.style.borderColor = 'var(--danger)';
    setTimeout(() => menuEl.style.borderColor = '', 2000);
    showToast('⚠️ Isi menu atau bahan makanan'); return;
  }
  const portion = getChip('mpasi-portion');
  const reaction = getChip('mpasi-reaction');
  const note = document.getElementById('mpasi-note').value.trim();
  const ts = inputToMs(document.getElementById('mpasi-time').value, document.getElementById('mpasi-date').value);

  const ev = {
    id: nextId(), type: 'MPASI',
    menu, foods: foodKeys.map(titleFood),
    portion, reaction, note,
    timestamp: ts
  };
  state.events.push(ev);

  // Daftar makanan: tambah yang baru, geser tanggal pertama kalau diisi lebih awal
  const newNames = [];
  foodKeys.forEach(key => {
    const existing = findFood(key);
    if (!existing) {
      state.foods.push({
        id: nextId(), key, name: titleFood(key), firstTs: ts, firstEventId: ev.id,
        note: note ? fmtDate(ts) + ': ' + note : ''
      });
      newNames.push(titleFood(key));
    } else if (ts < existing.firstTs) {
      existing.firstTs = ts; existing.firstEventId = ev.id;
    }
  });

  ['mpasi-menu', 'mpasi-foods', 'mpasi-note'].forEach(id => document.getElementById(id).value = '');
  clearChips('mpasi-portion'); clearChips('mpasi-reaction');
  document.getElementById('mpasi-foods-hint').textContent = '';
  document.getElementById('mpasi-time').value = nowInputVal();
  resetBackdateInputs();

  save(); render('mpasi');
  if (navigator.vibrate) navigator.vibrate(30);
  showToast(newNames.length ? '🥣 MPASI dicatat · baru: ' + newNames.join(', ') : '🥣 MPASI dicatat');
}

function foodDayNumber(food) {
  // hari ke-1 = hari pertama dikenalkan (hitung per tanggal kalender)
  const a = new Date(food.firstTs); a.setHours(0, 0, 0, 0);
  const b = new Date(); b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86400000) + 1;
}
function foodsUnderWatch() {
  const n = settings.foodWatchDays ?? 3;
  return state.foods.filter(f => foodDayNumber(f) <= n).sort((x, y) => y.firstTs - x.firstTs);
}

function renderMpasiWatch() {
  const card = document.getElementById('mpasi-watch');
  if (!card) return;
  const list = foodsUnderWatch();
  if (!list.length) { card.style.display = 'none'; return; }
  const n = settings.foodWatchDays ?? 3;
  card.style.display = 'block';
  document.getElementById('mpasi-watch-list').innerHTML = list.map(f =>
    `<div class="watch-line"><strong>${esc(f.name)}</strong> <span style="color:var(--muted)">· hari ke-${foodDayNumber(f)} dari ${n}</span></div>`
  ).join('');
}

function renderFoods() {
  const el = document.getElementById('food-list');
  if (!el) return;
  const title = document.getElementById('food-title');
  if (title) title.textContent = 'Makanan yang sudah dicoba' + (state.foods.length ? ' (' + state.foods.length + ')' : '');
  if (!state.foods.length) {
    el.innerHTML = '<div class="card" style="font-size:12px;color:var(--muted)">Belum ada. Isi kolom "Bahan / makanan" saat mencatat MPASI — tiap makanan baru otomatis masuk sini.</div>';
    return;
  }
  const n = settings.foodWatchDays ?? 3;
  el.innerHTML = [...state.foods].sort((a, b) => b.firstTs - a.firstTs).map(f => {
    const day = foodDayNumber(f);
    const watching = day <= n;
    return `<div class="food-item">
      <div class="food-main">
        <div class="food-name">${esc(f.name)}${watching ? `<span class="food-badge">dipantau · hari ke-${day}</span>` : ''}</div>
        <div class="food-meta">Pertama dicoba ${esc(new Date(f.firstTs).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }))}</div>
        ${f.note ? `<div class="food-note">${esc(f.note)}</div>` : ''}
      </div>
      <div class="food-actions">
        <button onclick="editFoodNote(${f.id})" aria-label="Edit catatan">✏️</button>
        <button onclick="deleteFood(${f.id})" aria-label="Hapus">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function editFoodNote(id) {
  const f = state.foods.find(x => x.id === id);
  if (!f) return;
  const val = prompt('Catatan reaksi untuk ' + f.name + ' (kosongkan untuk menghapus):', f.note || '');
  if (val === null) return;
  f.note = val.trim().slice(0, 200);
  save(); renderFoods();
}
function deleteFood(id) {
  const f = state.foods.find(x => x.id === id);
  if (!f) return;
  if (!confirm('Hapus ' + f.name + ' dari daftar makanan yang dicoba? (catatan MPASI di Riwayat tetap ada)')) return;
  state.foods = state.foods.filter(x => x.id !== id);
  save(); renderFoods(); renderMpasiWatch();
}

function addDbf() {
  const leftEl = document.getElementById('dbf-left');
  const rightEl = document.getElementById('dbf-right');
  const left  = parseInt(leftEl.value, 10) || 0;
  const right = parseInt(rightEl.value, 10) || 0;
  if (left <= 0 && right <= 0) {
    [leftEl, rightEl].forEach(el => { el.style.borderColor = 'var(--danger)'; setTimeout(() => el.style.borderColor = '', 2000); });
    showToast('⚠️ Masukkan durasi minimal 1 sisi'); return;
  }
  const ts = inputToMs(document.getElementById('dbf-time').value);
  const estMl = estimateDbfMl(left, right);

  state.events.push({
    id: nextId(), type: 'DBF',
    leftMins: left, rightMins: right,
    estimatedMl: estMl,
    ageWeeks: getBabyAgeWeeks(),
    timestamp: ts
  });

  document.getElementById('dbf-left').value = '';
  document.getElementById('dbf-right').value = '';
  document.getElementById('dbf-time').value = nowInputVal();
  document.getElementById('dbf-result').style.display = 'none';

  save(); render('feed');
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
  const ts = inputToMs(document.getElementById('diaper-time').value, document.getElementById('diaper-date').value);
  state.events.push({ id: nextId(), type: kind, timestamp: ts });
  document.getElementById('diaper-time').value = nowInputVal();
  resetBackdateInputs();
  save(); render('diaper');
  showToast(kind === 'PEE' ? '💧 Pipis dicatat' : '💩 BAB dicatat');
}

function startSleep() {
  const ts = inputToMs(document.getElementById('sleep-start-time').value);
  state.sleepStart = ts;
  save(); render('sleep'); showToast('😴 Tidur dimulai ' + fmtTime(ts));
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
  save(); render('sleep'); showToast('☀️ Bangun: ' + fmtDuration(dur));
}

function addGrowth() {
  const w = parseFloat(document.getElementById('growth-weight').value);
  const h = parseFloat(document.getElementById('growth-height').value);
  const hc = parseFloat(document.getElementById('growth-headcirc').value);
  if (!w && !h && !hc) {
    ['growth-weight','growth-height','growth-headcirc'].forEach(id => {
      const el = document.getElementById(id);
      el.style.borderColor = 'var(--danger)';
      setTimeout(() => el.style.borderColor = '', 2000);
    });
    showToast('⚠️ Masukkan berat, panjang, atau lingkar kepala'); return;
  }
  const dateVal = document.getElementById('growth-date-input').value;
  const ts = dateVal ? new Date(dateVal).getTime() : nowMs();
  state.growth.push({ id: nextId(), weight: w || null, height: h || null, headCirc: hc || null, timestamp: ts });
  document.getElementById('growth-weight').value = '';
  document.getElementById('growth-height').value = '';
  document.getElementById('growth-headcirc').value = '';
  save(); render();
  showToast('⚖️ Pengukuran disimpan');
}

function deleteGrowth(id) {
  if (!confirm('Hapus data pengukuran ini?')) return;
  state.growth = state.growth.filter(g => g.id !== id);
  save(); render();
}

function deleteEvent(id) {
  const removed = state.events.find(e => e.id === id);
  state.events = state.events.filter(e => e.id !== id);
  if (removed && removed.type === 'MPASI') syncFoodsAfterDelete(id);
  save(); render(removed && removed.type === 'MPASI' ? 'mpasi' : 'feed'); renderTimeline(true);
}
// Makanan yang pertama kali dicatat di event ini: pindahkan ke catatan MPASI berikutnya,
// atau hapus dari daftar kalau tidak ada lagi. (Tidak dipakai oleh pembersihan otomatis.)
function syncFoodsAfterDelete(eventId) {
  state.foods = state.foods.filter(f => {
    if (f.firstEventId !== eventId) return true;
    const next = state.events
      .filter(e => e.type === 'MPASI' && (e.foods || []).some(n => normFood(n) === f.key))
      .sort((a, b) => a.timestamp - b.timestamp)[0];
    if (!next) return false;
    f.firstTs = next.timestamp; f.firstEventId = next.id;
    return true;
  });
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
  if (totalMl <= 0) { showToast('Masukkan volume minimal 1 sisi'); return; }

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

  save(); render('pump');
  showToast('🔵 Pumping dicatat: ' + totalMl + ' mL');
}

// ── Export / Import ────────────────────────────────────────────────────────
function exportJSON() {
  const exportData = { ...state, settings };
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'baby-tracker-' + new Date().toISOString().slice(0,10) + '.json';
  a.click(); showToast('📦 Data + settings diekspor');
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
        if (imported.settings) { settings = imported.settings; saveSettings(); }
        const { settings: _, ...stateOnly } = imported;
        state = normalizeState(stateOnly); save(); render(); showToast('✅ Data + settings diimpor');
      } catch { showToast('❌ File tidak valid'); }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ── Render ─────────────────────────────────────────────────────────────────
// Render only what's needed — avoids full re-render on every action
function render(scope) {
  // scope: undefined = full, 'feed' = feeding actions, 'diaper', 'sleep', 'pump', 'profile'
  const full = !scope;

  // Always update header (lightweight)
  renderHeader();

  if (full || scope === 'feed' || scope === 'sleep' || scope === 'pump' || scope === 'diaper' || scope === 'mpasi') {
    renderDashboard();
    renderFeedingReminder(false);
  }

  if (full || scope === 'sleep') {
    renderSleepState();
  }

  // Timeline only when visible or full render
  if (full || currentView === 'timeline') {
    renderTimeline();
  }

  // Profile only when visible or full
  if (full || currentView === 'growth' || scope === 'profile' || scope === 'mpasi') {
    renderProfile();
    renderGrowth();
    renderFoods();
    if (currentView === 'growth') setTimeout(renderGrowthCharts, 50);
  }

  if (currentView === 'charts' && (full || scope === 'feed' || scope === 'diaper' || scope === 'mpasi')) {
    renderCharts();
  }
}

function renderFeedingReminder(forceShow) {
  const badge = document.getElementById('feed-reminder');
  if (!badge) return;
  const lastFeedTs = getLastFeedingTime();
  if (!lastFeedTs) { badge.classList.remove('show'); return; }
  const hoursAgo = (Date.now() - lastFeedTs) / 3600000;
  const threshold = settings.reminderHours;
  if (forceShow || hoursAgo >= threshold) {
    badge.classList.add('show');
    const h = Math.floor(hoursAgo), m = Math.round((hoursAgo - h) * 60);
    const strong = badge.querySelector('.reminder-text strong');
    const span = badge.querySelector('.reminder-text span');
    if (strong) strong.textContent =
      `⚠️ Sudah ${h > 0 ? h+'j ' : ''}${m}mnt sejak feeding terakhir!`;

    if (span) span.textContent = `Terakhir: ${fmtTime(lastFeedTs)} · Reminder setiap ${threshold} jam`;
    const actions = badge.querySelector('.reminder-actions');
    if (actions) actions.innerHTML = '';
  } else { badge.classList.remove('show'); }
}

function renderSleepState() {
  const status = document.getElementById('sleep-status');
  const btn = document.getElementById('btn-sleep-start');
  const endRow = document.getElementById('sleep-end-row');
  const quickSleepBtn = document.getElementById('quick-sleep-btn');
  const quickSleepSub = document.getElementById('quick-sleep-sub');
  if (state.sleepStart) {
    status.classList.add('visible');
    status.querySelector('.sleep-dur').textContent = 'Tidur sejak ' + fmtTime(state.sleepStart) + ' · ' + fmtDuration(Date.now() - state.sleepStart);
    btn.disabled = true;
    if (endRow) endRow.style.display = 'block';
    // Update quick button
    if (quickSleepBtn) {
      quickSleepBtn.querySelector('.qb-icon').textContent = '☀️';
      quickSleepBtn.querySelector('.qb-label').textContent = 'Bangun';
      quickSleepBtn.style.borderColor = 'rgba(155,158,240,0.5)';
      quickSleepBtn.style.background = 'rgba(155,158,240,0.08)';
    }
    if (quickSleepSub) quickSleepSub.textContent = fmtDuration(Date.now() - state.sleepStart);
  } else {
    status.classList.remove('visible');
    btn.disabled = false;
    if (endRow) endRow.style.display = 'none';
    // Reset quick button
    if (quickSleepBtn) {
      quickSleepBtn.querySelector('.qb-icon').textContent = '😴';
      quickSleepBtn.querySelector('.qb-label').textContent = 'Tidur';
      quickSleepBtn.style.borderColor = '';
      quickSleepBtn.style.background = '';
    }
    if (quickSleepSub) quickSleepSub.textContent = 'Tap untuk catat';
  }
}

function renderHeader() {
  const nameEl = document.getElementById('app-title');
  const subtitleEl = document.getElementById('header-date');
  if (nameEl && settings.babyName) {
    nameEl.textContent = settings.babyName;
  } else if (nameEl) {
    nameEl.textContent = 'BabyTrack';
  }
  if (subtitleEl && settings.babyBirthDate) {
    const ageLabel = getBabyAgeLabel();
    const today = new Date().toLocaleDateString('id-ID', {weekday:'long', day:'numeric', month:'long'});
    subtitleEl.textContent = ageLabel + ' · ' + today;
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
  // Total ASI/sufor = hanya asupan bayi (botol + DBF), BUKAN hasil pumping
  const totalMl       = totalBottleMl + totalDbfMl;
  const totalSleep    = sleeps.reduce((a, e) => a + (parseInt(e.duration, 10) || 0), 0);
  const totalFeedings = feeds.length + dbfs.length;

  document.getElementById('stat-feeds').textContent = totalFeedings;
  document.getElementById('stat-ml').innerHTML = totalMl +
    `<span>mL</span>${totalDbfMl > 0 ? `<div style="font-size:10px;color:var(--muted)">~${totalDbfMl} mL dari DBF</div>` : ''}`;
  document.getElementById('stat-pee').textContent = pee.length;
  const mpasiEl = document.getElementById('stat-mpasi');
  if (mpasiEl) mpasiEl.textContent = ev.filter(e => e.type === 'MPASI').length;
  renderMpasiWatch();
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

let timelinePage = 1;
const TIMELINE_PAGE_SIZE = 40;

function renderTimeline(resetPage) {
  if (resetPage) timelinePage = 1;
  const container = document.getElementById('timeline');
  let events = [...state.events].sort((a,b) => b.timestamp - a.timestamp);
  if (filterType !== 'all') {
    events = events.filter(e => {
      if (filterType === 'feeding') return e.type === 'FEEDING' || e.type === 'DBF';
      if (filterType === 'diaper')  return e.type === 'PEE' || e.type === 'POOP';
      if (filterType === 'sleep')   return e.type === 'SLEEP';
      if (filterType === 'pump')    return e.type === 'PUMP';
      if (filterType === 'mpasi')   return e.type === 'MPASI';
      return true;
    });
  }
  if (events.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>Belum ada aktivitas</p></div>';
    return;
  }
  const totalEvents = events.length;
  const pageEnd = timelinePage * TIMELINE_PAGE_SIZE;
  events = events.slice(0, pageEnd);

  const icons = { FEEDING: '🍼', DBF: '🤱', PUMP: '🔵', PEE: '💧', POOP: '💩', SLEEP: '😴', MPASI: '🥣' };
  const typeLabel = { FEEDING: 'Botol', DBF: 'DBF', PUMP: 'Pompa', PEE: 'Pipis', POOP: 'BAB', SLEEP: 'Tidur', MPASI: 'MPASI' };
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
    if (e.type === 'MPASI') {
      const bits = [];
      const main = e.menu || (e.foods || []).join(', ');
      if (main) bits.push(esc(main));
      if (e.portion && MPASI_PORTION[e.portion]) bits.push(MPASI_PORTION[e.portion]);
      if (e.reaction && MPASI_REACTION[e.reaction]) bits.push(MPASI_REACTION[e.reaction]);
      if (e.note) bits.push('📝 ' + esc(e.note));
      detail = bits.join(' · ');
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
  }).join('') + (totalEvents > pageEnd ?
    `<div style="text-align:center;padding:16px 0">
      <button class="btn btn-secondary" style="font-size:12px;padding:8px 20px" onclick="loadMoreTimeline()">
        Muat lebih banyak (${totalEvents - pageEnd} lagi)
      </button>
    </div>` : '');
}

function loadMoreTimeline() {
  timelinePage++;
  renderTimeline(false);
}

function renderProfile() {
  const nameEl = document.getElementById('profile-name');
  const ageEl = document.getElementById('profile-age');
  const bornEl = document.getElementById('profile-born');
  const avatarEl = document.getElementById('profile-avatar');
  const genderEl = document.getElementById('profile-gender');

  const name = settings.babyName || 'Baby';
  if (nameEl) nameEl.textContent = name;

  if (avatarEl) {
    avatarEl.textContent = settings.babyGender === 'boy' ? '👦' : settings.babyGender === 'girl' ? '👧' : '👶';
  }
  if (genderEl) {
    if (settings.babyGender === 'boy') { genderEl.textContent = '♂ Laki-laki'; genderEl.style.color = '#80aaee'; }
    else if (settings.babyGender === 'girl') { genderEl.textContent = '♀ Perempuan'; genderEl.style.color = '#f0a0c0'; }
    else { genderEl.textContent = ''; }
  }

  if (settings.babyBirthDate) {
    const birth = new Date(settings.babyBirthDate);
    const ageLabel = getBabyAgeLabel();
    const genderLabel = settings.babyGender === 'boy' ? '· Laki-laki' : settings.babyGender === 'girl' ? '· Perempuan' : '';
    if (ageEl) ageEl.textContent = ageLabel + ' ' + genderLabel;
    if (bornEl) bornEl.textContent = 'Lahir ' + birth.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  } else {
    const genderLabel = settings.babyGender === 'boy' ? 'Laki-laki' : settings.babyGender === 'girl' ? 'Perempuan' : '—';
    if (ageEl) ageEl.textContent = genderLabel;
    if (bornEl) bornEl.textContent = 'Tanggal lahir belum diset';
  }

  // Latest stats
  const latestW = [...state.growth].filter(g => g.weight).pop();
  const latestH = [...state.growth].filter(g => g.height).pop();
  const latestHc = [...state.growth].filter(g => g.headCirc).pop();
  const pwEl = document.getElementById('profile-weight');
  const phEl = document.getElementById('profile-height');
  const phcEl = document.getElementById('profile-headcirc');
  const pwdEl = document.getElementById('profile-weight-date');
  const phdEl = document.getElementById('profile-height-date');
  const phcdEl = document.getElementById('profile-headcirc-date');
  const peEl = document.getElementById('profile-entries');

  if (pwEl) pwEl.textContent = latestW ? latestW.weight : '—';
  if (phEl) phEl.textContent = latestH ? latestH.height : '—';
  if (phcEl) phcEl.textContent = latestHc ? latestHc.headCirc : '—';
  if (pwdEl) pwdEl.textContent = latestW ? fmtDate(latestW.timestamp) : '';
  if (phdEl) phdEl.textContent = latestH ? fmtDate(latestH.timestamp) : '';
  if (phcdEl) phcdEl.textContent = latestHc ? fmtDate(latestHc.timestamp) : '';
  if (peEl) peEl.textContent = state.growth.length;

  // Percentile chips
  const chipSpecs = [
    { entry: latestW,  metric: 'weight',   elId: 'profile-weight-pct' },
    { entry: latestH,  metric: 'height',   elId: 'profile-height-pct' },
    { entry: latestHc, metric: 'headCirc', elId: 'profile-headcirc-pct' },
  ];
  chipSpecs.forEach(spec => {
    const el = document.getElementById(spec.elId);
    if (!el) return;
    if (!spec.entry) { el.textContent = ''; el.className = 'pct-chip'; return; }
    const ageMonths = ageInMonthsAt(spec.entry.timestamp);
    const val = spec.entry[spec.metric];
    const pct = getPercentileForValue(spec.metric, ageMonths, val);
    const info = percentileChipInfo(pct);
    el.textContent = info.text;
    el.className = 'pct-chip' + (info.cls ? ' ' + info.cls : '');
  });

  // Set growth date input default to today
  const gdi = document.getElementById('growth-date-input');
  if (gdi && !gdi.value) gdi.value = new Date().toISOString().slice(0,10);
}

function toggleProfileEdit() {
  const form = document.getElementById('profile-edit-form');
  const isOpen = form.style.display !== 'none';
  form.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    document.getElementById('profile-name-input').value = settings.babyName || '';
    document.getElementById('profile-birthdate-input').value = settings.babyBirthDate || '';
    document.querySelectorAll('.gender-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.gender === settings.babyGender);
    });
  }
}

function saveProfile() {
  settings.babyName = document.getElementById('profile-name-input').value.trim();
  settings.babyBirthDate = document.getElementById('profile-birthdate-input').value || '';
  const activeGender = document.querySelector('.gender-btn.active');
  settings.babyGender = activeGender ? activeGender.dataset.gender : '';
  // Sync to settings modal
  const si = document.getElementById('baby-name-input');
  const sd = document.getElementById('baby-birthdate-input');
  if (si) si.value = settings.babyName;
  if (sd) sd.value = settings.babyBirthDate;
  saveSettings();
  toggleProfileEdit();
  render('profile');
  showToast('✅ Profil disimpan');
}

function selectGender(gender) {
  document.querySelectorAll('.gender-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.gender === gender);
  });
}

function renderGrowth() {
  const container = document.getElementById('growth-list');
  if (!container) return;
  if (state.growth.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📏</div><p>Belum ada data pengukuran</p></div>';
    return;
  }
  container.innerHTML = [...state.growth].reverse().map(g => `
    <div class="growth-item">
      <div style="font-size:16px">📊</div>
      <div style="flex:1">
        ${g.weight ? `<span class="growth-val" style="color:var(--weight)">${g.weight} kg</span> ` : ''}
        ${g.height ? `<span class="growth-val" style="color:var(--height)">${g.height} cm</span> ` : ''}
        ${g.headCirc ? `<span class="growth-val" style="color:var(--headcirc)">${g.headCirc} cm LK</span>` : ''}
      </div>
      <div class="growth-date" style="font-size:11px;color:var(--muted)">${fmtDate(g.timestamp)}</div>
      <button class="growth-delete" onclick="deleteGrowth(${g.id})" aria-label="Hapus">✕</button>
    </div>`).join('');
}

// ── WHO Growth Standards (LMS, 0–24 bulan) ─────────────────────────────────
// Sumber: WHO Child Growth Standards (data.who.int), tabel L/M/S per bulan usia.
const WHO_LMS = {
  weight: {
    boy: [
      [0.3487,3.3464,0.14602],[0.2297,4.4709,0.13395],[0.1970,5.5675,0.12385],[0.1738,6.3762,0.11727],
      [0.1553,7.0023,0.11316],[0.1395,7.5105,0.11080],[0.1257,7.9340,0.10958],[0.1134,8.2970,0.10902],
      [0.1021,8.6151,0.10882],[0.0917,8.9014,0.10881],[0.0820,9.1649,0.10891],[0.0730,9.4122,0.10906],
      [0.0644,9.6479,0.10925],[0.0563,9.8749,0.10949],[0.0487,10.0953,0.10976],[0.0413,10.3108,0.11007],
      [0.0343,10.5228,0.11041],[0.0275,10.7319,0.11079],[0.0211,10.9385,0.11119],[0.0148,11.1430,0.11164],
      [0.0087,11.3462,0.11211],[0.0029,11.5486,0.11261],[-0.0028,11.7504,0.11314],[-0.0083,11.9514,0.11369],
      [-0.0137,12.1515,0.11426]
    ],
    girl: [
      [0.3809,3.2322,0.14171],[0.1714,4.1873,0.13724],[0.0962,5.1282,0.13000],[0.0402,5.8458,0.12619],
      [-0.0050,6.4237,0.12402],[-0.0430,6.8985,0.12274],[-0.0756,7.2970,0.12204],[-0.1039,7.6422,0.12178],
      [-0.1288,7.9487,0.12181],[-0.1507,8.2254,0.12199],[-0.1700,8.4800,0.12223],[-0.1872,8.7192,0.12247],
      [-0.2024,8.9481,0.12268],[-0.2158,9.1699,0.12283],[-0.2278,9.3870,0.12294],[-0.2384,9.6008,0.12299],
      [-0.2478,9.8124,0.12303],[-0.2562,10.0226,0.12306],[-0.2637,10.2315,0.12309],[-0.2703,10.4393,0.12315],
      [-0.2762,10.6464,0.12323],[-0.2815,10.8534,0.12335],[-0.2862,11.0608,0.12350],[-0.2903,11.2688,0.12369],
      [-0.2941,11.4775,0.12390]
    ]
  },
  height: {
    boy: [
      [1,49.8842,0.03795],[1,54.7244,0.03557],[1,58.4249,0.03424],[1,61.4292,0.03328],[1,63.8860,0.03257],
      [1,65.9026,0.03204],[1,67.6236,0.03165],[1,69.1645,0.03139],[1,70.5994,0.03124],[1,71.9687,0.03117],
      [1,73.2812,0.03118],[1,74.5388,0.03125],[1,75.7488,0.03137],[1,76.9186,0.03154],[1,78.0497,0.03174],
      [1,79.1458,0.03197],[1,80.2113,0.03222],[1,81.2487,0.03250],[1,82.2587,0.03279],[1,83.2418,0.03310],
      [1,84.1996,0.03342],[1,85.1348,0.03376],[1,86.0477,0.03410],[1,86.9410,0.03445],[1,87.8161,0.03479]
    ],
    girl: [
      [1,49.1477,0.03790],[1,53.6872,0.03640],[1,57.0673,0.03568],[1,59.8029,0.03520],[1,62.0899,0.03486],
      [1,64.0301,0.03463],[1,65.7311,0.03448],[1,67.2873,0.03441],[1,68.7498,0.03440],[1,70.1435,0.03444],
      [1,71.4818,0.03452],[1,72.7710,0.03464],[1,74.0150,0.03479],[1,75.2176,0.03496],[1,76.3817,0.03514],
      [1,77.5099,0.03534],[1,78.6055,0.03555],[1,79.6710,0.03576],[1,80.7079,0.03598],[1,81.7182,0.03620],
      [1,82.7036,0.03643],[1,83.6654,0.03666],[1,84.6040,0.03688],[1,85.5202,0.03711],[1,86.4153,0.03734]
    ]
  },
  headCirc: {
    boy: [
      [1,34.4618,0.03686],[1,37.2759,0.03133],[1,39.1285,0.02997],[1,40.5135,0.02918],[1,41.6317,0.02868],
      [1,42.5576,0.02837],[1,43.3306,0.02817],[1,43.9803,0.02804],[1,44.5300,0.02796],[1,44.9998,0.02792],
      [1,45.4051,0.02790],[1,45.7573,0.02789],[1,46.0661,0.02789],[1,46.3395,0.02789],[1,46.5844,0.02791],
      [1,46.8060,0.02792],[1,47.0088,0.02795],[1,47.1962,0.02797],[1,47.3711,0.02800],[1,47.5357,0.02803],
      [1,47.6919,0.02806],[1,47.8408,0.02810],[1,47.9833,0.02813],[1,48.1201,0.02817],[1,48.2515,0.02821]
    ],
    girl: [
      [1,33.8787,0.03496],[1,36.5463,0.03210],[1,38.2521,0.03168],[1,39.5328,0.03140],[1,40.5817,0.03119],
      [1,41.4590,0.03102],[1,42.1995,0.03087],[1,42.8290,0.03075],[1,43.3671,0.03063],[1,43.8300,0.03053],
      [1,44.2319,0.03044],[1,44.5844,0.03035],[1,44.8965,0.03027],[1,45.1752,0.03019],[1,45.4265,0.03012],
      [1,45.6551,0.03006],[1,45.8650,0.02999],[1,46.0598,0.02993],[1,46.2424,0.02987],[1,46.4152,0.02982],
      [1,46.5801,0.02977],[1,46.7384,0.02972],[1,46.8913,0.02967],[1,47.0391,0.02962],[1,47.1822,0.02957]
    ]
  }
};
const WHO_MAX_MONTH = 24;
// Z-scores untuk garis persentil standar
const PCT_LINES = [
  { p: 3,  z: -1.881, dash: [4,3], w: 1 },
  { p: 15, z: -1.036, dash: [4,3], w: 1 },
  { p: 50, z: 0,      dash: [],    w: 1.5 },
  { p: 85, z: 1.036,  dash: [4,3], w: 1 },
  { p: 97, z: 1.881,  dash: [4,3], w: 1 },
];

function erf(x) {
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1) * t * Math.exp(-x*x);
  return sign * y;
}
function zToPercentile(z) { return 0.5 * (1 + erf(z / Math.SQRT2)) * 100; }
function lmsZ(L, M, S, X) {
  if (Math.abs(L) < 1e-9) return Math.log(X / M) / S;
  return (Math.pow(X / M, L) - 1) / (L * S);
}
function lmsValueAtZ(L, M, S, Z) {
  if (Math.abs(L) < 1e-9) return M * Math.exp(S * Z);
  return M * Math.pow(1 + L * S * Z, 1 / L);
}
function interpolateLMS(table, ageMonths) {
  const clamped = Math.max(0, Math.min(WHO_MAX_MONTH, ageMonths));
  const lo = Math.floor(clamped), hi = Math.min(WHO_MAX_MONTH, lo + 1);
  const frac = clamped - lo;
  const a = table[lo], b = table[hi];
  return [
    a[0] + (b[0] - a[0]) * frac,
    a[1] + (b[1] - a[1]) * frac,
    a[2] + (b[2] - a[2]) * frac,
  ];
}
function getSexKey() {
  if (settings.babyGender === 'boy') return 'boy';
  if (settings.babyGender === 'girl') return 'girl';
  return null;
}
function ageInMonthsAt(ts) {
  if (!settings.babyBirthDate) return null;
  const birth = new Date(settings.babyBirthDate).getTime();
  return Math.max(0, (ts - birth) / (1000 * 60 * 60 * 24 * 30.4368));
}
function getPercentileForValue(metric, ageMonths, value) {
  const sex = getSexKey();
  if (!sex || ageMonths == null) return null;
  const table = WHO_LMS[metric][sex];
  const [L, M, S] = interpolateLMS(table, ageMonths);
  const z = lmsZ(L, M, S, value);
  return zToPercentile(z);
}
function percentileChipInfo(pct) {
  if (pct == null) return { text: '', cls: '' };
  const p = Math.round(pct);
  if (p < 3)  return { text: `P${p} · di bawah normal`, cls: 'pct-low' };
  if (p > 97) return { text: `P${p} · di atas normal`, cls: 'pct-high' };
  return { text: `Persentil ~${p}`, cls: 'pct-normal' };
}

function renderGrowthCharts() {
  const metrics = [
    { key: 'weight',   canvas: 'chart-growth-weight',   legend: 'legend-weight',   color: 'var(--weight)',   colorHex: '#80c9b8', unit: 'kg', field: 'weight' },
    { key: 'height',   canvas: 'chart-growth-height',   legend: 'legend-height',   color: 'var(--height)',   colorHex: '#f07ca0', unit: 'cm', field: 'height' },
    { key: 'headCirc', canvas: 'chart-growth-headcirc', legend: 'legend-headcirc', color: 'var(--headcirc)', colorHex: '#9b9ef0', unit: 'cm', field: 'headCirc' },
  ];

  const sex = getSexKey();
  const noteEl = document.getElementById('growth-chart-note');
  let note = '';
  if (!settings.babyBirthDate) note = '📅 Set tanggal lahir di profil supaya grafik bisa dihitung berdasarkan usia.';
  else if (!sex) note = '👶 Set jenis kelamin di profil untuk menampilkan kurva persentil WHO.';
  if (noteEl) {
    noteEl.style.display = note ? 'block' : 'none';
    noteEl.textContent = note;
  }

  metrics.forEach(m => {
    const pts = state.growth
      .filter(g => g[m.field] != null && (settings.babyBirthDate ? ageInMonthsAt(g.timestamp) != null : true))
      .map(g => ({ x: settings.babyBirthDate ? ageInMonthsAt(g.timestamp) : null, y: g[m.field], ts: g.timestamp }))
      .sort((a, b) => a.ts - b.ts);

    const legendEl = document.getElementById(m.legend);
    if (legendEl) {
      if (sex && settings.babyBirthDate) {
        legendEl.innerHTML = `
          <span><i style="background:rgba(255,255,255,0.3)"></i>P3–P97 (rentang normal)</span>
          <span><i style="background:${m.colorHex}"></i>${settings.babyName || 'Bayi'}</span>`;
      } else {
        legendEl.innerHTML = `<span><i style="background:${m.colorHex}"></i>${settings.babyName || 'Bayi'} (tanpa kurva WHO)</span>`;
      }
    }

    drawGrowthChart(m.canvas, pts, { sex, metric: m.key, color: m.colorHex, unit: m.unit });
  });
}

function drawGrowthChart(canvasId, points, opts) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth * devicePixelRatio;
  canvas.height = canvas.offsetHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  ctx.clearRect(0, 0, w, h);

  if (points.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '11px DM Sans'; ctx.textAlign = 'center';
    ctx.fillText('Belum ada data pengukuran', w / 2, h / 2);
    return;
  }

  const hasAge = points.every(p => p.x != null);
  const canShowWHO = hasAge && opts.sex;

  // Determine x range (age in months) or fallback index range
  const xs = hasAge ? points.map(p => p.x) : points.map((_, i) => i);
  let xMin = Math.min(0, ...xs), xMax = Math.max(canShowWHO ? Math.min(WHO_MAX_MONTH, Math.max(...xs) + 2) : 0, ...xs);
  if (xMax === xMin) xMax = xMin + 1;

  // Determine y range
  let yVals = points.map(p => p.y);
  let yMin, yMax;
  if (canShowWHO) {
    const table = WHO_LMS[opts.metric][opts.sex];
    const steps = 13;
    for (let i = 0; i <= steps; i++) {
      const age = xMin + (xMax - xMin) * (i / steps);
      const [L, M, S] = interpolateLMS(table, age);
      yVals.push(lmsValueAtZ(L, M, S, PCT_LINES[0].z));
      yVals.push(lmsValueAtZ(L, M, S, PCT_LINES[PCT_LINES.length - 1].z));
    }
  }
  yMin = Math.min(...yVals); yMax = Math.max(...yVals);
  const yPad = (yMax - yMin) * 0.1 || 1;
  yMin -= yPad; yMax += yPad;

  const padL = 34, padR = 8, padT = 10, padB = 24;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const xToPx = x => padL + ((x - xMin) / (xMax - xMin)) * chartW;
  const yToPx = y => padT + chartH - ((y - yMin) / (yMax - yMin)) * chartH;

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
  [0.25, 0.5, 0.75, 1].forEach(f => {
    const y = padT + chartH * (1 - f);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
  });
  ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.font = '9px DM Sans'; ctx.textAlign = 'right';
  [0, 0.5, 1].forEach(f => {
    const y = padT + chartH * (1 - f);
    ctx.fillText((yMin + (yMax - yMin) * f).toFixed(1), padL - 4, y + 3);
  });

  // WHO percentile bands
  if (canShowWHO) {
    const table = WHO_LMS[opts.metric][opts.sex];
    const steps = 24;
    PCT_LINES.forEach(line => {
      ctx.beginPath();
      ctx.setLineDash(line.dash);
      ctx.strokeStyle = line.p === 50 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.16)';
      ctx.lineWidth = line.w;
      for (let i = 0; i <= steps; i++) {
        const age = xMin + (xMax - xMin) * (i / steps);
        const [L, M, S] = interpolateLMS(table, age);
        const val = lmsValueAtZ(L, M, S, line.z);
        const px = xToPx(age), py = yToPx(val);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      // label at right end
      const lastAge = xMax;
      const [L, M, S] = interpolateLMS(table, lastAge);
      const lastVal = lmsValueAtZ(L, M, S, line.z);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.font = '8px DM Sans'; ctx.textAlign = 'left';
      ctx.fillText('P' + line.p, Math.min(xToPx(lastAge) + 2, w - padR - 14), yToPx(lastVal) + 3);
    });
    ctx.setLineDash([]);
  }

  // Child's own data line + dots
  ctx.beginPath();
  ctx.strokeStyle = opts.color; ctx.lineWidth = 2;
  points.forEach((p, i) => {
    const px = xToPx(hasAge ? p.x : i), py = yToPx(p.y);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();
  points.forEach((p, i) => {
    const px = xToPx(hasAge ? p.x : i), py = yToPx(p.y);
    ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2);
    ctx.fillStyle = opts.color; ctx.fill();
    ctx.strokeStyle = '#0f1117'; ctx.lineWidth = 1.5; ctx.stroke();
  });

  // X axis labels (age in months)
  ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.font = '9px DM Sans'; ctx.textAlign = 'center';
  const xTicks = 4;
  for (let i = 0; i <= xTicks; i++) {
    const age = xMin + (xMax - xMin) * (i / xTicks);
    const px = xToPx(age);
    const label = hasAge ? Math.round(age) + 'bln' : '';
    if (label) ctx.fillText(label, px, h - padB + 12);
  }
}

// ── Charts ────────────────────────────────────────────────────────────────────
function getLastDays(n) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0,0,0,0);
    days.push({
      ts: d.getTime(),
      label: i === 0 ? 'Hr ini' : d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })
    });
  }
  return days;
}

const CHART_RANGES = [7, 14, 21, 30];
function getChartDays() {
  return CHART_RANGES.includes(settings.chartDays) ? settings.chartDays : 7;
}
function setChartRange(n) {
  if (!CHART_RANGES.includes(n)) return;
  settings.chartDays = n;
  saveSettings();
  renderCharts();
}
// Jarak label sumbu-X supaya tidak bertumpuk: tiap hari (<=7), 2 hari (<=14), mingguan (lebih)
function labelStep(n) { return n <= 7 ? 1 : n <= 14 ? 2 : 7; }

function getChartData(n) {
  return getLastDays(n).map(day => {
    const nextDay = day.ts + 86400000;
    const ev = state.events.filter(e => e.timestamp >= day.ts && e.timestamp < nextDay);
    const feeds = ev.filter(e => e.type === 'FEEDING' || e.type === 'DBF');
    const bottleMl = ev.filter(e => e.type === 'FEEDING').reduce((a,e) => a + (parseInt(e.value,10)||0), 0);
    const dbfMl = ev.filter(e => e.type === 'DBF').reduce((a,e) => a + (parseInt(e.estimatedMl,10)||0), 0);
    const pumps = ev.filter(e => e.type === 'PUMP');
    const pumpLeft = pumps.reduce((a,e) => a + (parseInt(e.leftMl,10)||0), 0);
    const pumpRight = pumps.reduce((a,e) => a + (parseInt(e.rightMl,10)||0), 0);
    const pumpTotal = pumps.reduce((a,e) => a + (parseInt(e.totalMl,10)||0), 0);
    // Pumping TIDAK dihitung sebagai asupan bayi
    return {
      label: day.label,
      totalMl: bottleMl + dbfMl,
      bottleMl, dbfMl,
      feedCount: feeds.length,
      pee: ev.filter(e => e.type === 'PEE').length,
      poop: ev.filter(e => e.type === 'POOP').length,
      mpasi: ev.filter(e => e.type === 'MPASI').length,
      pumpCount: pumps.length,
      pumpLeft, pumpRight,
      pumpOther: Math.max(0, pumpTotal - pumpLeft - pumpRight),   // data lama tanpa rincian sisi
      pumpTotal,
    };
  });
}

function renderCharts() {
  const n = getChartDays();
  const data = getChartData(n);

  document.querySelectorAll('#chart-range .chip').forEach(c =>
    c.classList.toggle('active', parseInt(c.dataset.days, 10) === n));
  const titleEl = document.getElementById('chart-range-title');
  if (titleEl) titleEl.textContent = n + ' hari terakhir';

  const sumEl = document.getElementById('pump-chart-summary');
  if (sumEl) {
    const total = data.reduce((a, d) => a + d.pumpTotal, 0);
    const sessions = data.reduce((a, d) => a + d.pumpCount, 0);
    const activeDays = data.filter(d => d.pumpCount > 0).length;
    sumEl.innerHTML = sessions
      ? `<span>Total ${total} mL</span><span>${sessions} sesi</span><span>rata-rata ${Math.round(total / Math.max(1, activeDays))} mL/hari aktif</span>`
      : '<span>Belum ada pumping di periode ini</span>';
  }

  drawStackedBarChart('chart-ml', data, d => d.label,
    [
      { valFn: d => d.bottleMl, color: '#e8c5a0', label: 'Botol' },
      { valFn: d => d.dbfMl,    color: '#f0a0c0', label: 'DBF' },
    ], { unit: 'mL' });
  drawBarChart('chart-freq', data, d => d.feedCount, d => d.label,
    { color: '#9b9ef0', unit: 'x', title: 'Frekuensi feeding per hari' });
  drawStackedBarChart('chart-pump', data, d => d.label,
    [
      { valFn: d => d.pumpLeft,  color: '#80aaee', label: 'Kiri' },
      { valFn: d => d.pumpRight, color: '#b8d0f8', label: 'Kanan' },
      { valFn: d => d.pumpOther, color: '#8890a8', label: 'Lainnya' },
    ], { unit: 'mL' });
  drawBarChart('chart-mpasi', data, d => d.mpasi, d => d.label,
    { color: '#c9d48f', unit: 'x', title: 'MPASI per hari' });
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

  const dense = data.length > 10;
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
    if (val > 0 && !dense) {
      ctx.fillStyle = isToday ? opts.color : 'rgba(255,255,255,0.4)';
      ctx.font = `bold ${9}px DM Sans`;
      ctx.textAlign = 'center';
      ctx.fillText(val + opts.unit, x + barW / 2, y - 4);
    }

    // X label
    if ((data.length - 1 - i) % labelStep(data.length) === 0) {
      ctx.fillStyle = isToday ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)';
      ctx.font = `${9}px DM Sans`;
      ctx.textAlign = 'center';
      const lbl = labelFn(d);
      ctx.fillText(lbl.length > 6 ? lbl.slice(0,6) : lbl, x + barW / 2, h - padB + 14);
    }
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

  const dense = data.length > 10;
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
    if (total > 0 && !dense) {
      ctx.fillStyle = isToday ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)';
      ctx.font = 'bold 9px DM Sans'; ctx.textAlign = 'center';
      ctx.fillText(total + (opts.unit||''), x + barW/2, padT + chartH - (total/maxVal)*chartH - 4);
    }

    // X label
    if ((data.length - 1 - i) % labelStep(data.length) === 0) {
      ctx.fillStyle = isToday ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)';
      ctx.font = '9px DM Sans'; ctx.textAlign = 'center';
      const lbl = labelFn(d);
      ctx.fillText(lbl.length > 6 ? lbl.slice(0,6) : lbl, x + barW/2, h - padB + 14);
    }
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

  const dense = data.length > 10;
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
      if (!dense) {
        ctx.fillStyle = isToday ? opts.color1 : 'rgba(255,255,255,0.35)';
        ctx.font = 'bold 9px DM Sans'; ctx.textAlign = 'center';
        ctx.fillText(v1, x + singleW/2, padT + chartH - bh - 3);
      }
    }
    // bar 2 (BAB)
    if (v2 > 0) {
      const bh = (v2 / maxVal) * chartH;
      ctx.fillStyle = isToday ? opts.color2 : opts.color2 + '88';
      ctx.beginPath(); roundRect(ctx, x + singleW + 2, padT + chartH - bh, singleW, bh, 3); ctx.fill();
      if (!dense) {
        ctx.fillStyle = isToday ? opts.color2 : 'rgba(255,255,255,0.35)';
        ctx.font = 'bold 9px DM Sans'; ctx.textAlign = 'center';
        ctx.fillText(v2, x + singleW + 2 + singleW/2, padT + chartH - bh - 3);
      }
    }

    // X label
    if ((data.length - 1 - i) % labelStep(data.length) === 0) {
      ctx.fillStyle = isToday ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)';
      ctx.font = '9px DM Sans'; ctx.textAlign = 'center';
      const lbl = labelFn(d);
      ctx.fillText(lbl.length > 6 ? lbl.slice(0,6) : lbl, x + totalBarW/2, h - padB + 14);
    }
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
  if (v === 'charts') setTimeout(renderCharts, 50);
  if (v === 'growth') { renderProfile(); setTimeout(renderGrowthCharts, 50); }
}
function setFilter(type) {
  filterType = type;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  renderTimeline(true);
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
    state = normalizeState(imported); save(); render();
    closeBackupModal(); showToast('✅ Data berhasil diimpor');
  } catch { showToast('❌ Format JSON tidak valid'); }
}

// ── Tickers ────────────────────────────────────────────────────────────────
let lastDateStr = new Date().toDateString();
setInterval(() => {
  // Skip heavy work if app is not visible (iOS background)
  if (document.visibilityState !== 'visible') return;
  if (state.sleepStart) renderSleepState();
  if (currentView === 'dashboard') renderDashboard();
  // Update header date if day changed
  const nowDateStr = new Date().toDateString();
  if (nowDateStr !== lastDateStr) {
    lastDateStr = nowDateStr;
    const el = document.getElementById('header-date');
    if (el) el.textContent = new Date().toLocaleDateString('id-ID', {weekday:'long', day:'numeric', month:'long'});
  }
}, 30000);

// ── SW ─────────────────────────────────────────────────────────────────────
const APP_VERSION = 'v7';
let swRegistration = null;
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then(reg => { swRegistration = reg; reg.update().catch(() => {}); })
    .catch(() => {});
  // SW baru mengambil alih → muat ulang sekali supaya langsung pakai file terbaru.
  // Tidak dilakukan saat install pertama, atau saat timer pumping sedang jalan.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    if (pumpTimerInterval) { showToast('🔄 Versi baru tersedia — tutup & buka app lagi'); return; }
    reloading = true;
    location.reload();
  });
}
// Cek update SW tiap app kembali aktif (penting untuk iOS/Android PWA yang jarang di-reload)
function checkForAppUpdate() {
  if (swRegistration) swRegistration.update().catch(() => {});
}

// ── iOS resume fix ─────────────────────────────────────────────────────────
// When user reopens the app after it was backgrounded, refresh state + check reminder
let lastActiveAt = Date.now();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    checkForAppUpdate();
    const away = Date.now() - lastActiveAt;
    // If away for more than 60 seconds, reload state and re-render
    if (away > 60000) {
      state = load();
      settings = loadSettings();
      render();
      scheduleReminder();
      // Reset time inputs to current time
      ['feed-time','dbf-time','pump-time','diaper-time','sleep-start-time','sleep-end-time','mpasi-time'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = nowInputVal();
      });
      resetBackdateInputs();
      runDataCleanup();
      // Check if overdue and show banner immediately
      checkOverdueOnResume();
    }
  } else {
    lastActiveAt = Date.now();
  }
});

// iOS Safari: pageshow fires when restoring from bfcache
window.addEventListener('pageshow', (e) => {
  checkForAppUpdate();
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

// ── Scheduler: bersihkan data tak terpakai ─────────────────────────────────
// - Event (feeding/DBF/popok/tidur/pumping) lebih lama dari retentionDays dihapus.
//   Minimum 35 hari supaya grafik 30 hari tidak pernah terpengaruh.
// - Data pertumbuhan (growth) dan daftar makanan yang dicoba (foods) TIDAK pernah dihapus.
// - Sisa data stok ASI versi lama (state.bottles) dibuang karena fiturnya sudah dihapus.
// Jalan saat app dibuka, saat kembali aktif, setelah ganti pengaturan, dan tiap 6 jam.
const CLEANUP_INTERVAL_MS = 6 * 3600000;
function runDataCleanup() {
  let changed = false;
  if ('bottles' in state) { delete state.bottles; changed = true; }

  const days = settings.retentionDays ?? 0;
  let removed = 0;
  if (days > 0) {
    const cutoff = Date.now() - Math.max(days, 35) * 86400000;
    const before = state.events.length;
    state.events = state.events.filter(e => e.timestamp >= cutoff);
    removed = before - state.events.length;
    if (removed > 0) changed = true;
  }
  if (changed) {
    save();
    if (removed > 0) {
      render();
      showToast('🧹 ' + removed + ' catatan lama dibersihkan');
    }
  }
  return removed;
}
setInterval(runDataCleanup, CLEANUP_INTERVAL_MS);

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  ['feed-time','dbf-time','pump-time','diaper-time','sleep-start-time','sleep-end-time','mpasi-time'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = nowInputVal();
  });
  resetBackdateInputs();
  checkOverdueOnResume();
});

runDataCleanup();
render();
scheduleReminder();
