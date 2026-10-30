const fs = require('fs');
const path = require('path');

const LINKS_FILE = path.resolve(process.env.DRIVE_LINKS_FILE || path.join(__dirname, '..', 'data', 'drive_links.json'));

function ensureFile() {
  const dir = path.dirname(LINKS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(LINKS_FILE)) fs.writeFileSync(LINKS_FILE, '[]');
}

function loadLinks() {
  ensureFile();
  try {
    const j = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function saveLinks(list) {
  ensureFile();
  fs.writeFileSync(LINKS_FILE, JSON.stringify(list, null, 2));
}

function addLink({ name, link }) {
  const cleanLink = String(link || '').trim();
  if (!cleanLink) throw new Error('Link wajib diisi');
  const list = loadLinks();
  const exists = list.find(l => l.link === cleanLink);
  if (exists) {
    if (name && exists.name !== name) {
      exists.name = String(name).trim();
      saveLinks(list);
    }
    return exists;
  }
  const item = {
    id: 'dl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(name || '').trim() || cleanLink.replace(/^https?:\/\//, '').slice(0, 40),
    link: cleanLink,
    createdAt: new Date().toISOString(),
  };
  list.push(item);
  saveLinks(list);
  return item;
}

function removeLink(id) {
  const list = loadLinks();
  const before = list.length;
  const filtered = list.filter(l => l.id !== id);
  if (filtered.length === before) return false;
  saveLinks(filtered);
  return true;
}

module.exports = { loadLinks, addLink, removeLink, LINKS_FILE };
