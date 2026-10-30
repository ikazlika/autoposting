const fs = require('fs');
const path = require('path');

const SCHEDULES_FILE = path.resolve(process.env.COMPILE_SCHEDULES_FILE || path.join(__dirname, '..', 'data', 'compile_schedules.json'));

function ensureFile() {
  const dir = path.dirname(SCHEDULES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(SCHEDULES_FILE)) fs.writeFileSync(SCHEDULES_FILE, '[]');
}

function loadSchedules() {
  ensureFile();
  try {
    const j = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function saveSchedules(list) {
  ensureFile();
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(list, null, 2));
}

function addSchedule(data) {
  const list = loadSchedules();
  const item = {
    id: 'sch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: String(data.name || 'Jadwal').trim().slice(0, 60) || 'Jadwal',
    enabled: data.enabled !== false,
    type: ['interval', 'once'].includes(data.type) ? data.type : 'daily',
    runAt: data.runAt || null,
    hours: Array.isArray(data.hours) ? data.hours.map(Number).filter(n => n >= 0 && n <= 23) : [],
    times: Array.isArray(data.times) ? data.times.map(String).filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) : [],
    everyMinutes: Math.max(1, Math.min(1440, Number(data.everyMinutes) || 60)),
    options: data.options || {},
    lastRun: null,
    createdAt: new Date().toISOString(),
  };
  if (item.type === 'daily' && !item.hours.length) item.hours = [6, 12, 18];
  list.push(item);
  saveSchedules(list);
  return item;
}

function updateSchedule(id, patch) {
  const list = loadSchedules();
  const item = list.find(s => s.id === id);
  if (!item) return null;
  if (patch.name !== undefined) item.name = String(patch.name).slice(0, 60);
  if (patch.enabled !== undefined) item.enabled = !!patch.enabled;
  if (patch.type !== undefined) item.type = patch.type === 'interval' ? 'interval' : 'daily';
  if (patch.hours !== undefined) item.hours = patch.hours.map(Number).filter(n => n >= 0 && n <= 23);
  if (patch.everyMinutes !== undefined) item.everyMinutes = Math.max(1, Math.min(1440, Number(patch.everyMinutes) || 60));
  if (patch.options !== undefined) item.options = patch.options;
  saveSchedules(list);
  return item;
}

function removeSchedule(id) {
  const list = loadSchedules();
  const filtered = list.filter(s => s.id !== id);
  if (filtered.length === list.length) return false;
  saveSchedules(filtered);
  return true;
}

function markRun(id, at = new Date().toISOString()) {
  const list = loadSchedules();
  const item = list.find(s => s.id === id);
  if (!item) return null;
  item.lastRun = at;
  saveSchedules(list);
  return item;
}

module.exports = { loadSchedules, saveSchedules, addSchedule, updateSchedule, removeSchedule, markRun, SCHEDULES_FILE };
