const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * Format data/groups.json:
 * {
 *   "groups": [
 *     {
 *       "id": "grp_...",
 *       "name": "Grup 1",
 *       "enabled": true,
 *       "accounts": [
 *         { "platform": "youtube", "name": "channel-1" },
 *         { "platform": "facebook", "name": "page-1" }
 *       ]
 *     }
 *   ]
 * }
 * Anggota grup direferensikan lewat nama akun di data/accounts.json.
 */

const PLATFORMS = ['youtube', 'facebook'];

function ensureFile() {
  const dir = path.dirname(config.groupsFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(config.groupsFile)) {
    fs.writeFileSync(config.groupsFile, JSON.stringify({ groups: [] }, null, 2));
  }
}

function normalize(g) {
  const seen = new Set();
  const accounts = (Array.isArray(g.accounts) ? g.accounts : [])
    .filter(a => a && PLATFORMS.includes(a.platform) && a.name)
    .map(a => ({ platform: a.platform, name: String(a.name) }))
    .filter(a => {
      const key = `${a.platform}:${a.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    id: String(g.id || ''),
    name: String(g.name || '').trim(),
    enabled: g.enabled !== false,
    accounts,
  };
}

function loadGroups() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(config.groupsFile, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.groups;
    if (!Array.isArray(list)) return [];
    return list.map(normalize).filter(g => g.id && g.name);
  } catch {
    return [];
  }
}

function saveGroups(list) {
  ensureFile();
  fs.writeFileSync(config.groupsFile, JSON.stringify({ groups: list.map(normalize) }, null, 2));
}

function newId() {
  return 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function getGroup(idOrName) {
  if (!idOrName) return null;
  const key = String(idOrName).toLowerCase();
  return loadGroups().find(g => g.id.toLowerCase() === key || g.name.toLowerCase() === key) || null;
}

function getEnabledGroups() {
  return loadGroups().filter(g => g.enabled !== false);
}

function addGroup(data) {
  const list = loadGroups();
  const name = String(data.name || '').trim();
  if (!name) throw new Error('Nama grup wajib diisi.');
  if (list.some(g => g.name.toLowerCase() === name.toLowerCase())) throw new Error(`Grup "${name}" sudah ada.`);
  const group = normalize({ id: newId(), name, enabled: data.enabled !== false, accounts: data.accounts });
  if (!group.accounts.length) throw new Error('Pilih minimal 1 akun untuk grup.');
  list.push(group);
  saveGroups(list);
  return group;
}

function updateGroup(id, data) {
  const list = loadGroups();
  const group = list.find(g => g.id === id || g.name.toLowerCase() === String(id).toLowerCase());
  if (!group) throw new Error('Grup tidak ditemukan.');
  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw new Error('Nama grup wajib diisi.');
    if (list.some(g => g.id !== group.id && g.name.toLowerCase() === name.toLowerCase())) throw new Error(`Grup "${name}" sudah ada.`);
    group.name = name;
  }
  if (data.enabled !== undefined) group.enabled = !!data.enabled;
  if (data.accounts !== undefined) {
    const next = normalize({ accounts: data.accounts }).accounts;
    if (!next.length) throw new Error('Pilih minimal 1 akun untuk grup.');
    group.accounts = next;
  }
  saveGroups(list);
  return group;
}

function removeGroup(id) {
  const list = loadGroups();
  const group = list.find(g => g.id === id || g.name.toLowerCase() === String(id).toLowerCase());
  if (!group) throw new Error('Grup tidak ditemukan.');
  saveGroups(list.filter(g => g.id !== group.id));
  return group;
}

function renameMember(platform, oldName, newName) {
  const list = loadGroups();
  let changed = false;
  for (const g of list) {
    for (const a of g.accounts) {
      if (a.platform === platform && a.name === oldName) { a.name = newName; changed = true; }
    }
  }
  if (changed) saveGroups(list);
}

function removeMember(platform, name) {
  const list = loadGroups();
  let changed = false;
  for (const g of list) {
    const before = g.accounts.length;
    g.accounts = g.accounts.filter(a => !(a.platform === platform && a.name === name));
    if (g.accounts.length !== before) changed = true;
  }
  if (changed) saveGroups(list);
}

/** Pilih grup berikutnya secara bergiliran berdasarkan jumlah video terposting. */
function pickGroup(postedCount) {
  const groups = getEnabledGroups();
  if (!groups.length) return null;
  return groups[postedCount % groups.length];
}

module.exports = {
  loadGroups,
  saveGroups,
  addGroup,
  updateGroup,
  removeGroup,
  getGroup,
  getEnabledGroups,
  renameMember,
  removeMember,
  pickGroup,
};
