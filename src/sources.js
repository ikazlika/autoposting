const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const config = require('./config');

const YTDLP = path.resolve(__dirname, '..', 'bin', 'yt-dlp.exe');

/** Progres download terpusat: { key: {...} } */
const progress = {};
const listeners = [];

function emit() {
  const snap = JSON.parse(JSON.stringify(progress));
  listeners.forEach(fn => { try { fn(snap); } catch {} });
}
function onProgress(fn) { listeners.push(fn); }
function getProgress() { return JSON.parse(JSON.stringify(progress)); }
function clearProgress(key) { delete progress[key]; emit(); }

function setProg(key, patch) {
  progress[key] = { ...(progress[key] || {}), ...patch, updatedAt: Date.now() };
  emit();
}

/** Cari binary yt-dlp: folder projek dulu, lalu PATH. */
function resolveYtDlp() {
  if (fs.existsSync(YTDLP)) return YTDLP;
  try { execSync('yt-dlp --version', { stdio: 'ignore' }); return 'yt-dlp'; } catch {}
  throw new Error('yt-dlp tidak ditemukan. Letakkan yt-dlp.exe di folder bin/ projek.');
}

const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v|avi|flv|3gp|ts|ogv|mpg|mpeg|wmv|m2ts)$/i;

/** Daftar video yang ada di folder videos/ (sumber lokal). */
function listLocalVideos() {
  const dir = config.videosDir;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => VIDEO_EXT.test(f))
    .map(f => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, sizeMB: (st.size / 1024 / 1024).toFixed(2), mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** Tambah video lokal: salin dari path mana pun ke videos/. */
function addLocalVideo(srcPath) {
  const src = path.resolve(String(srcPath || '').trim().replace(/^["']|["']$/g, ''));
  if (!src || !fs.existsSync(src)) throw new Error('File tidak ditemukan: ' + srcPath);
  if (!fs.statSync(src).isFile()) throw new Error('Bukan file: ' + srcPath);
  if (!VIDEO_EXT.test(src)) throw new Error('Bukan file video (mp4/mov/webm/mkv): ' + path.basename(src));
  fs.mkdirSync(config.videosDir, { recursive: true });
  let dest = path.join(config.videosDir, path.basename(src));
  let i = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(config.videosDir, `${path.parse(src).name}_${i}${path.extname(src)}`);
    i++;
  }
  fs.copyFileSync(src, dest);
  return { file: path.basename(dest), sizeMB: (fs.statSync(dest).size / 1024 / 1024).toFixed(2) };
}

/** Simpan file yang di-upload (multipart sudah di-parse jadi buffer) ke videos/. */
function saveUploadedVideo(buffer, originalName) {
  if (!VIDEO_EXT.test(originalName || '')) throw new Error('Bukan file video: ' + originalName);
  fs.mkdirSync(config.videosDir, { recursive: true });
  let dest = path.join(config.videosDir, path.basename(originalName));
  let i = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(config.videosDir, `${path.parse(originalName).name}_${i}${path.extname(originalName)}`);
    i++;
  }
  fs.writeFileSync(dest, buffer);
  return { file: path.basename(dest), sizeMB: (fs.statSync(dest).size / 1024 / 1024).toFixed(2) };
}

/** Parse URL YouTube (watch, youtu.be, shorts) -> valid? */
function parseYouTube(url) {
  const s = String(url || '').trim();
  const m = s.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? { id: m[1], url: s } : null;
}

/** Download video YouTube ke videos/ via yt-dlp. */
async function downloadYouTube(url) {
  const info = parseYouTube(url);
  if (!info) throw new Error('Link YouTube tidak valid. Contoh: https://www.youtube.com/shorts/xxxx');
  const bin = resolveYtDlp();
  const key = 'yt:' + info.id;
  fs.mkdirSync(config.videosDir, { recursive: true });
  const outTpl = path.join(config.videosDir, `yt_${info.id}_%(title).80s.%(ext)s`);
  setProg(key, { kind: 'youtube', url, status: 'starting', percent: 0, title: '' });

  const args = [
    '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b[height<=1080]/b',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--newline',
    '--no-warnings',
    '-o', outTpl,
    info.url,
  ];
  // ffmpeg yt-dlp untuk merge
  const ffmpegDir = path.resolve(__dirname, '..', '..', 'snip yt', 'bin');
  if (fs.existsSync(ffmpegDir)) args.unshift('--ffmpeg-location', ffmpegDir);

  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let err = '';
    p.stdout.on('data', d => {
      const line = String(d);
      const dm = line.match(/\[download\]\s+([\d.]+)%/);
      if (dm) setProg(key, { status: 'downloading', percent: Math.min(99, parseFloat(dm[1])) });
      const tm = line.match(/\[download\]\s+Destination:\s*(.+)/);
      if (tm) setProg(key, { title: path.basename(tm[1].trim()) });
      const fm = line.match(/\[Merger\]\s+Merging formats into\s+"(.+)"/);
      if (fm) setProg(key, { status: 'merging', percent: 99, title: path.basename(fm[1].trim()) });
    });
    p.stderr.on('data', d => { err += d; if (err.length > 60000) err = err.slice(-30000); });
    p.on('error', e => { setProg(key, { status: 'error', error: e.message }); reject(new Error('Gagal jalankan yt-dlp: ' + e.message)); });
    p.on('close', code => {
      if (code !== 0) {
        const msg = (err.match(/ERROR:.*/) || [])[0] || 'yt-dlp exit ' + code;
        setProg(key, { status: 'error', error: msg });
        return reject(new Error(msg));
      }
      // cari file hasil
      const made = listLocalVideos().filter(v => v.name.startsWith(`yt_${info.id}_`));
      const file = made[0];
      setProg(key, { status: 'done', percent: 100, file: file ? file.name : null });
      setTimeout(() => clearProgress(key), 15000);
      resolve({ file: file ? file.name : null, sizeMB: file ? file.sizeMB : null });
    });
  });
}

/** Download SEMUA video dari folder Google Drive publik ke videos/. */
async function downloadAllFromFolder(folderId, files) {
  if (!folderId) throw new Error('folderId wajib');
  const list = Array.isArray(files) ? files : [];
  if (!list.length) throw new Error('Tidak ada file di folder');
  const { downloadPublicFile } = require('./video_renderer');
  const key = 'folder:' + folderId;
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    setProg(key, {
      kind: 'folder', folderId, status: 'downloading',
      done: i, total: list.length, current: f.name,
      percent: Math.round((i / list.length) * 100),
    });
    try {
      const r = await downloadPublicFile(f.id, f.name, config.videosDir);
      results.push({ name: r.file, ok: true, sizeMB: r.sizeMB });
    } catch (e) {
      results.push({ name: f.name, ok: false, error: e.message });
    }
    setProg(key, { done: i + 1, percent: Math.round(((i + 1) / list.length) * 100) });
  }
  setProg(key, { status: 'done', percent: 100, results });
  setTimeout(() => clearProgress(key), 20000);
  return results;
}

module.exports = {
  listLocalVideos,
  addLocalVideo,
  saveUploadedVideo,
  parseYouTube,
  downloadYouTube,
  downloadAllFromFolder,
  getProgress,
  onProgress,
  clearProgress,
  resolveYtDlp,
};
