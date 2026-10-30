const fs = require('fs');
const path = require('path');
const config = require('./config');

function ensureDirs() {
  if (!fs.existsSync(config.videosDir)) fs.mkdirSync(config.videosDir, { recursive: true });
  const dbDir = path.dirname(config.postedDb);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  if (!fs.existsSync(config.postedDb)) fs.writeFileSync(config.postedDb, '[]');
}

function loadPosted() {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(config.postedDb, 'utf8'));
  } catch {
    return [];
  }
}

function savePosted(list) {
  fs.writeFileSync(config.postedDb, JSON.stringify(list, null, 2));
}

function listVideos() {
  ensureDirs();
  const files = fs.readdirSync(config.videosDir)
    .filter(f => config.supportedExt.includes(path.extname(f).slice(1).toLowerCase()))
    .map(f => path.join(config.videosDir, f))
    .sort();
  return files;
}

function getNextVideo() {
  const posted = loadPosted();
  const postedSet = new Set(posted.map(p => p.file));
  const all = listVideos();
  return all.find(f => !postedSet.has(path.basename(f))) || null;
}

/** Kategori YouTube standar (id -> nama), mirip dropdown di YouTube Studio. */
const YT_CATEGORIES = {
  '1': 'Film & Animation',
  '2': 'Autos & Vehicles',
  '10': 'Music',
  '15': 'Pets & Animals',
  '17': 'Sports',
  '19': 'Travel & Events',
  '20': 'Gaming',
  '22': 'People & Blogs',
  '23': 'Comedy',
  '24': 'Entertainment',
  '25': 'News & Politics',
  '26': 'Howto & Style',
  '27': 'Education',
  '28': 'Science & Technology',
};

function jsonPathFor(videoPath) {
  const ext = path.extname(videoPath);
  if (!ext) return videoPath + '.json'; // file tmp multer tanpa ekstensi
  return videoPath.slice(0, -ext.length) + '.json';
}

/**
 * Baca metadata penuh mirip form YouTube Studio + komposer FB.
 * videos/namafile.json (opsional). Fallback dari nama file + default .env.
 * Field: title, description, tags, categoryId, privacyStatus, madeForKids,
 *         publishAt (ISO), fbCaption, fbUseReels (true/false/'default')
 */
function getMetadata(videoPath) {
  const jsonPath = jsonPathFor(videoPath);
  let j = {};
  if (fs.existsSync(jsonPath)) {
    try {
      j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (e) {
      console.warn(`[Queue] Gagal baca ${jsonPath}: ${e.message}`);
    }
  }
  return {
    title: (j.title || prettify(path.parse(videoPath).name)).slice(0, 100),
    description: j.description || '',
    tags: Array.isArray(j.tags) ? j.tags : undefined,
    categoryId: j.categoryId || config.youtube.categoryId || '22',
    privacyStatus: j.privacyStatus || undefined, // undefined = ikut akun/default
    madeForKids: j.madeForKids === true,
    publishAt: j.publishAt || undefined, // ISO string, opsional (jadwal tayang YT)
    fbCaption: j.fbCaption || undefined, // caption khusus FB, opsional
    fbUseReels: j.fbUseReels, // true/false/undefined(=ikut default)
  };
}

function saveMetadata(videoPath, meta) {
  const jsonPath = jsonPathFor(videoPath);
  const clean = {};
  if (meta.title !== undefined) clean.title = String(meta.title).slice(0, 100);
  if (meta.description !== undefined) clean.description = String(meta.description).slice(0, 5000);
  if (meta.tags !== undefined) clean.tags = Array.isArray(meta.tags) ? meta.tags : String(meta.tags).split(',').map(s => s.trim()).filter(Boolean);
  if (meta.categoryId !== undefined) clean.categoryId = String(meta.categoryId);
  if (meta.privacyStatus) clean.privacyStatus = meta.privacyStatus;
  if (meta.madeForKids !== undefined) clean.madeForKids = !!meta.madeForKids;
  if (meta.publishAt) clean.publishAt = meta.publishAt;
  if (meta.fbCaption !== undefined) clean.fbCaption = String(meta.fbCaption);
  if (meta.fbUseReels !== undefined && meta.fbUseReels !== 'default' && meta.fbUseReels !== '') clean.fbUseReels = meta.fbUseReels === true || meta.fbUseReels === 'true';
  fs.writeFileSync(jsonPath, JSON.stringify(clean, null, 2));
  return jsonPath;
}

function prettify(name) {
  return name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

// Thumbnail custom YouTube: videos/<namafile>.(jpg|jpeg|png), maks 2MB (aturan YT)
const THUMB_EXTS = ['.jpg', '.jpeg', '.png'];

function thumbBaseFor(videoPath) {
  const ext = path.extname(videoPath);
  return ext ? videoPath.slice(0, -ext.length) : videoPath;
}

/** Kembalikan path thumbnail yang ada, atau null bila belum ada. */
function thumbPathFor(videoPath) {
  const base = thumbBaseFor(videoPath);
  for (const e of THUMB_EXTS) {
    if (fs.existsSync(base + e)) return base + e;
  }
  return null;
}

/** Hapus semua varian thumbnail milik video. Return true bila ada yang dihapus. */
function deleteThumb(videoPath) {
  const base = thumbBaseFor(videoPath);
  let hapus = false;
  for (const e of THUMB_EXTS) {
    const p = base + e;
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); hapus = true; } catch {} }
  }
  return hapus;
}

function markAsPosted(fileName, results) {
  const posted = loadPosted();
  posted.push({ file: fileName, date: new Date().toISOString(), results });
  savePosted(posted);
}

module.exports = { listVideos, getNextVideo, getMetadata, saveMetadata, markAsPosted, loadPosted, YT_CATEGORIES, THUMB_EXTS, thumbPathFor, deleteThumb };
