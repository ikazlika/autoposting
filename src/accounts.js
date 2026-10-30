const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * Format data/accounts.json:
 * {
 *   "youtube": [
 *     { "name": "akun1", "clientId": "...", "clientSecret": "...", "refreshToken": "...", "privacyStatus": "public", "enabled": true }
 *   ],
 *   "facebook": [
 *     { "name": "page1", "pageId": "...", "token": "...", "enabled": true }
 *   ]
 * }
 * Jika kosong, otomatis fallback ke credential .env (mode single-akun lama).
 */

function ensureFile() {
  const dir = path.dirname(config.accountsFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(config.accountsFile)) {
    fs.writeFileSync(config.accountsFile, JSON.stringify({ youtube: [], facebook: [] }, null, 2));
  }
}

function loadAccounts() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(config.accountsFile, 'utf8'));
    return {
      youtube: Array.isArray(raw.youtube) ? raw.youtube : [],
      facebook: Array.isArray(raw.facebook) ? raw.facebook : [],
    };
  } catch {
    return { youtube: [], facebook: [] };
  }
}

function saveAccounts(data) {
  ensureFile();
  fs.writeFileSync(config.accountsFile, JSON.stringify(data, null, 2));
  console.log(`✔ Tersimpan di ${config.accountsFile}`);
}

// Nilai placeholder (isi_client_id_anda / ISI_...) dianggap BELUM diisi
function isReal(v) {
  if (!v || typeof v !== 'string') return false;
  const t = v.trim();
  if (!t) return false;
  return !/^isi_/i.test(t) && !t.includes('ISI_') && !t.includes('isi_');
}

// Fallback .env sebagai 1 akun (agar kompatibel ke belakang)
function getYouTubeAccounts() {
  const all = loadAccounts().youtube.filter(a => a.enabled !== false && isReal(a.refreshToken));
  if (all.length > 0) return all;
  if (isReal(config.youtube.clientId) && isReal(config.youtube.refreshToken)) {
    return [{
      name: 'default(.env)',
      clientId: config.youtube.clientId,
      clientSecret: config.youtube.clientSecret,
      refreshToken: config.youtube.refreshToken,
      privacyStatus: config.youtube.privacyStatus,
      fromEnv: true,
    }];
  }
  return [];
}

function getFacebookAccounts() {
  const all = loadAccounts().facebook.filter(a => a.enabled !== false && isReal(a.token));
  if (all.length > 0) return all;
  if (isReal(config.facebook.pageId) && isReal(config.facebook.token)) {
    return [{ name: 'default(.env)', pageId: config.facebook.pageId, token: config.facebook.token, fromEnv: true }];
  }
  return [];
}

function addYouTubeAccount(acc) {
  const data = loadAccounts();
  if (data.youtube.some(a => a.name === acc.name)) throw new Error(`Nama akun YouTube "${acc.name}" sudah ada.`);
  data.youtube.push({ privacyStatus: config.youtube.privacyStatus, enabled: true, ...acc });
  saveAccounts(data);
}

function addFacebookAccount(acc) {
  const data = loadAccounts();
  if (data.facebook.some(a => a.name === acc.name)) throw new Error(`Nama akun Facebook "${acc.name}" sudah ada.`);
  data.facebook.push({ enabled: true, ...acc });
  saveAccounts(data);
}

function removeAccount(platform, name) {
  const data = loadAccounts();
  const before = data[platform].length;
  data[platform] = data[platform].filter(a => a.name !== name);
  if (data[platform].length === before) throw new Error(`Akun ${platform}/${name} tidak ditemukan.`);
  saveAccounts(data);
}

function toggleAccount(platform, name, enabled) {
  const data = loadAccounts();
  const acc = data[platform].find(a => a.name === name);
  if (!acc) throw new Error(`Akun ${platform}/${name} tidak ditemukan.`);
  acc.enabled = enabled;
  saveAccounts(data);
}

function updateAccount(platform, name, patch) {
  const data = loadAccounts();
  const acc = data[platform].find(a => a.name === name);
  if (!acc) throw new Error(`Akun ${platform}/${name} tidak ditemukan.`);
  if (patch.name && patch.name !== name) {
    if (data[platform].some(a => a.name === patch.name)) throw new Error(`Nama "${patch.name}" sudah ada.`);
    acc.name = patch.name;
  }
  if (platform === 'youtube') {
    if (patch.clientId !== undefined) acc.clientId = patch.clientId;
    if (patch.clientSecret !== undefined) acc.clientSecret = patch.clientSecret;
    if (patch.refreshToken !== undefined) acc.refreshToken = patch.refreshToken;
    if (patch.privacyStatus) acc.privacyStatus = patch.privacyStatus;
    for (const key of ['defaultTitle', 'defaultDescription', 'defaultTags']) {
      if (patch[key] !== undefined) acc[key] = Array.isArray(patch[key]) ? patch[key] : String(patch[key]);
    }
  } else {
    if (patch.pageId !== undefined) acc.pageId = patch.pageId;
    if (patch.token !== undefined) {
      acc.token = patch.token;
      delete acc.expired;
    }
    if (patch.expired !== undefined) {
      if (patch.expired) acc.expired = true;
      else delete acc.expired;
    }
    if (patch.pageName !== undefined) acc.pageName = patch.pageName;
    for (const key of ['defaultTitle', 'defaultDescription', 'defaultTags']) {
      if (patch[key] !== undefined) acc[key] = Array.isArray(patch[key]) ? patch[key] : String(patch[key]);
    }
  }
  if (patch.enabled !== undefined) acc.enabled = patch.enabled;
  saveAccounts(data);
  return acc;
}

/** Pilih akun untuk strategi rotate: giliran berdasarkan jumlah video terposting. */
function pickRotate(accounts, postedCount) {
  if (!accounts.length) return null;
  return accounts[postedCount % accounts.length];
}

module.exports = {
  loadAccounts,
  saveAccounts,
  getYouTubeAccounts,
  getFacebookAccounts,
  addYouTubeAccount,
  addFacebookAccount,
  removeAccount,
  toggleAccount,
  updateAccount,
  pickRotate,
};
