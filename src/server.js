const http = require('http');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const { loadAccounts, saveAccounts, updateAccount } = require('./accounts');
const { loadGroups, addGroup, updateGroup, removeGroup, getGroup, renameMember, removeMember } = require('./groups');
const { listVideos, loadPosted, getMetadata } = require('./queue');
const { postOne } = require('./post');
const { getSettings, saveSettings } = require('./settings');
const { refreshAllTokens } = require('./token_refresher');
const { listDriveVideos, listDriveFolders, downloadDriveVideo, getDownloadProgress, clearProgress, getDriveAuthUrl, exchangeDriveCode, extractFolderId, listPublicFolder, downloadPublicFile } = require('./video_renderer');
const { compile, listOutputs, loadMemory, resetMemory, OUTPUT_DIR } = require('./compiler');
const { loadLinks, addLink, removeLink } = require('./drive_links');
const { loadSchedules, addSchedule, updateSchedule, removeSchedule, markRun } = require('./compile_scheduler');
const sources = require('./sources');
const multer = require('multer');
// simpan upload langsung ke videosDir dengan nama asli
const upload = multer({
  dest: path.join(config.videosDir, '.tmp'),
  limits: { fileSize: 500 * 1024 * 1024 },
});
// upload thumbnail (jpg/png, maks 2MB aturan YouTube)
const uploadImg = multer({
  dest: path.join(config.videosDir, '.tmp'),
  limits: { fileSize: 3 * 1024 * 1024 },
});
const { THUMB_EXTS, thumbPathFor, deleteThumb } = require('./queue');

const PORT = parseInt(process.env.PORT || String(config.port) || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) reject(new Error('Body terlalu besar')); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON tidak valid')); }
    });
  });
}

function invalidGroupAccounts(accounts) {
  if (accounts === undefined) return null;
  if (!Array.isArray(accounts)) return 'Daftar akun grup tidak valid.';
  const data = loadAccounts();
  for (const a of accounts) {
    if (!a || !['youtube', 'facebook'].includes(a.platform) || !a.name) return 'Format akun grup tidak valid.';
    if (!(data[a.platform] || []).some(x => x.name === a.name)) return `Akun ${a.platform}/${a.name} tidak ditemukan.`;
  }
  return null;
}

function handleMulter(req, res, middleware, cb) {
  middleware(req, res, (err) => {
    if (err) return send(res, 400, JSON.stringify({ error: err.message }));
    cb();
  });
}
// pastikan folder tmp ada
try { fs.mkdirSync(path.join(config.videosDir, '.tmp'), { recursive: true }); } catch {}

// Simpan log posting terakhir di memory untuk ditampilkan di UI
let lastLog = [];
const origLog = console.log;
const origErr = console.error;
function captureLog(...args) {
  const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  lastLog.push(`[${new Date().toLocaleTimeString('id-ID')}] ${msg}`);
  if (lastLog.length > 200) lastLog.shift();
  origLog(...args);
}
console.log = captureLog;
console.error = (...a) => captureLog('[ERR]', ...a);

function getStatus() {
  const { getYouTubeAccounts, getFacebookAccounts } = require('./accounts');
  return {
    videosDir: config.videosDir,
    schedule: config.schedule,
    timezone: config.timezone,
    strategy: config.postStrategy,
    postGroup: config.postGroup,
    enableYouTube: config.enableYouTube,
    enableFacebook: config.enableFacebook,
    youtubeCount: getYouTubeAccounts().length,
    facebookCount: getFacebookAccounts().length,
    groups: loadGroups(),
    videos: listVideos().map(p => {
      const stat = fs.statSync(p);
      const meta = getMetadata(p);
      return {
        file: path.basename(p),
        sizeMB: (stat.size / 1024 / 1024).toFixed(2),
        title: meta.title,
        description: meta.description,
        tags: meta.tags || [],
        categoryId: meta.categoryId,
        privacyStatus: meta.privacyStatus || null,
        madeForKids: !!meta.madeForKids,
        publishAt: meta.publishAt || null,
        fbCaption: meta.fbCaption || null,
        fbUseReels: meta.fbUseReels,
        hasThumb: !!thumbPathFor(p),
        mtime: stat.mtime.toISOString(),
      };
    }),
    postedCount: loadPosted().length,
  };
}

// === Kompilasi otomatis (JUARA n ... JUARA 1) ===
let compileState = { running: false, logs: [], result: null, error: null, ffmpegProc: null, pendingPost: null, posting: false, uploads: {}, progress: null };
let compileRunner = null;
const COMPILE_POST_DELAY_MS = 120000; // 2 menit review sebelum auto-post
const OUTPUT_KEEP = 10; // simpan 10 video Output terbaru agar tetap bisa diputar

/** Hapus video Output terlama, sisakan `keep` terbaru. Return daftar nama yang dihapus. */
function cleanupOldOutputs(keep = OUTPUT_KEEP) {
  try {
    const files = fs.readdirSync(OUTPUT_DIR)
      .filter(f => /\.(mp4|mov|webm|mkv)$/i.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    const removed = [];
    for (const item of files.slice(keep)) {
      try { fs.rmSync(path.join(OUTPUT_DIR, item.f), { force: true }); removed.push(item.f); } catch {}
    }
    return removed;
  } catch { return []; }
}

/** Timer: tunggu video terdeteksi di Output, lalu upload, lalu rapikan Output. */
setInterval(async () => {
  const pp = compileState.pendingPost;
  if (!pp || Date.now() < pp.at) return;
  const src = path.join(OUTPUT_DIR, pp.file);
  // 1) DETEKSI: tunggu sampai file benar-benar ada & ukurannya stabil (render selesai).
  let st;
  try { st = fs.statSync(src); } catch {
    return; // belum muncul di Output — tunggu siklus berikutnya
  }
  if (!st.size) return; // masih 0 byte — belum siap
  if (!pp.detected) {
    if (st.size !== pp.lastSize) {
      pp.lastSize = st.size; // ukuran masih berubah — tunggu stabil
      return;
    }
    pp.detected = true;
    lastLog.push(`[AUTOPOST] Video terdeteksi di Output (${(st.size / 1024 / 1024).toFixed(2)} MB) — mulai upload…`);
  }
  compileState.pendingPost = null;
  compileState.posting = true;
  if (compileState.progress) Object.assign(compileState.progress, { phase: 'upload', upload: { percent: 5, message: 'Menyalin ke antrean posting…' } });
  // salin ke videos/ agar tercatat di antrean & history
  let dest = path.join(config.videosDir, pp.file);
  let i = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(config.videosDir, `${path.parse(pp.file).name}_${i}${path.extname(pp.file)}`);
    i++;
  }
  try {
    fs.copyFileSync(src, dest);
  } catch (e) {
    compileState.posting = false;
    lastLog.push(`[AUTOPOST][ERR] Gagal salin file: ${e.message}`);
    return;
  }
  const meta = {
    title: pp.title,
    description: `${pp.subtitle || ''}\n\n#Shorts`,
    tags: ['shorts', 'kompilasi', 'lucu'],
    fbCaption: `${pp.title}\n${pp.subtitle || ''}\n\n#Reels`,
  };
  lastLog.push(`[AUTOPOST] Mulai posting: ${path.basename(dest)}`);
  if (compileState.progress) Object.assign(compileState.progress, { phase: 'upload', upload: { percent: 20, message: 'Mengunggah ke YouTube & Facebook…' } });
  // Hormati target pilihan user di UI: {platform, account, group}. Tanpa pilihan → semua akun.
  const target = pp.postTarget || {};
  const platform = ['youtube', 'facebook'].includes(target.platform) ? target.platform : 'all';
  const postOpts = {
    platform, now: true, file: dest, meta,
    onUploadStatus: (plat, accName, state, message) => {
      if (!compileState.uploads) compileState.uploads = {};
      compileState.uploads[plat] = { ...(compileState.uploads[plat] || {}), account: accName, state, message: message || '', updatedAt: Date.now() };
      lastLog.push(`[${plat === 'youtube' ? 'YouTube' : 'Facebook'}:${accName}] ${message || state}`);
    },
    onUploadProgress: (plat, accName, percent, message) => {
      if (!compileState.uploads) compileState.uploads = {};
      const prev = compileState.uploads[plat] || {};
      compileState.uploads[plat] = { ...prev, account: accName, percent, state: 'uploading', message: message || prev.message || '', updatedAt: Date.now() };
    },
  };
  if (target.account) postOpts.account = target.account;
  if (target.group) postOpts.group = target.group;
  let uploadOk = false;
  try {
    const results = await postOne(dest, postOpts);
    uploadOk = true;
    if (compileState.progress) Object.assign(compileState.progress, { phase: 'upload', upload: { percent: 100, message: 'Upload selesai' }, uploads: compileState.uploads });
    lastLog.push('[AUTOPOST] Selesai: ' + JSON.stringify(results).slice(0, 500));
  } catch (e) {
    lastLog.push(`[AUTOPOST][ERR] ${e.message}`);
  } finally {
    compileState.posting = false;
  }
  // 2) Rapikan Output: simpan N video terbaru agar tetap bisa diputar,
  //    hapus yang lebih lama supaya disk tidak penuh.
  if (uploadOk) {
    try {
      const removed = cleanupOldOutputs(OUTPUT_KEEP);
      if (removed.length) lastLog.push(`[AUTOPOST] Output dibersihkan: ${removed.length} video lama dihapus (simpan ${OUTPUT_KEEP} terbaru).`);
    } catch (e) {
      lastLog.push(`[AUTOPOST][ERR] Gagal bersihkan Output: ${e.message}`);
    }
  }
}, 3000);

/**
 * Cek kesehatan token YouTube. Yang mati ditandai `expired: true` supaya
 * UI menampilkan peringatan & tombol perbarui token. Yang hidup lagi
 * otomatis dilepas tanda expired-nya.
 */
async function checkYouTubeTokens() {
  const data = loadAccounts();
  const results = [];
  for (const acc of data.youtube || []) {
    if (!acc.clientId || !acc.clientSecret || !acc.refreshToken) {
      if (acc.enabled !== false) updateAccount('youtube', acc.name, { expired: true });
      results.push({ name: acc.name, ok: false, reason: 'kredensial tidak lengkap' });
      continue;
    }
    try {
      const { google } = require('googleapis');
      const oauth2 = new google.auth.OAuth2(acc.clientId, acc.clientSecret);
      oauth2.setCredentials({ refresh_token: acc.refreshToken });
      await oauth2.getAccessToken();
      if (acc.expired) updateAccount('youtube', acc.name, { expired: false });
      results.push({ name: acc.name, ok: true });
    } catch (e) {
      updateAccount('youtube', acc.name, { expired: true });
      results.push({ name: acc.name, ok: false, reason: (e.response?.data && e.response.data.error) || e.message });
    }
  }
  return results;
}

/** Perbarui SEMUA token: Facebook (perpanjang) + YouTube (cek & tandai expired). */
async function refreshAllAccounts() {
  const fb = config.enableFacebook ? await refreshAllTokens() : { sukses: [], gagal: [] };
  const yt = await checkYouTubeTokens();
  return { facebook: fb, youtube: yt };
}

// Auto-perbarui token: 30 detik setelah start, lalu tiap 6 jam.
// Tanpa ini token Facebook hanya diperpanjang oleh scheduler CLI (npm start),
// sehingga kalau hanya pakai dashboard web tokennya tetap expired.
setTimeout(() => { refreshAllAccounts().catch(e => lastLog.push('[TOKEN][ERR] ' + e.message)); }, 30000);
setInterval(() => { refreshAllAccounts().catch(e => lastLog.push('[TOKEN][ERR] ' + e.message)); }, 6 * 60 * 60 * 1000);

/** Timer: cek jadwal kompilasi tiap 30 detik (satu render sekaligus). */
setInterval(() => {
  if (compileState.running || compileState.pendingPost) return;
  const now = new Date();
  let currentHour;
  try {
    currentHour = Number(now.toLocaleString('en-US', { timeZone: config.timezone, hour: 'numeric', hour12: false }));
  } catch {
    currentHour = now.getHours();
  }
  let triggered = false;
  for (const sch of loadSchedules()) {
    if (!sch.enabled) continue;
    let due = false;
    if (sch.type === 'once') {
      due = !!sch.runAt && !sch.lastRun && Date.now() >= new Date(sch.runAt).getTime();
    } else if (sch.type === 'interval') {
      const last = sch.lastRun ? new Date(sch.lastRun).getTime() : 0;
      due = Date.now() - last >= sch.everyMinutes * 60000;
    } else {
      const times = Array.isArray(sch.times) && sch.times.length
        ? sch.times
        : (Array.isArray(sch.hours) ? sch.hours.map(h => `${String(h).padStart(2, '0')}:00`) : []);
      let localNow;
      try { localNow = now.toLocaleTimeString('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).slice(0, 5); }
      catch { localNow = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`; }
      const lastRun = sch.lastRun ? new Date(sch.lastRun).getTime() : 0;
      const sameMinute = lastRun > 0 && Date.now() - lastRun < 60000;
      due = times.includes(localNow) && !sameMinute;
    }
    if (!due) continue;
    lastLog.push(`[SCHEDULE] Jadwal "${sch.name}" terpicu — mulai kompilasi.`);
    // Masuk melalui endpoint internal agar runner selalu terinisialisasi,
    // meskipun belum ada request /api/compile dari browser.
    const body = { ...sch.options, _scheduleId: sch.id, _scheduleName: sch.name };
    const bodyStr = JSON.stringify(body);
    fetch(`http://127.0.0.1:${PORT}/api/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr,
    }).then(async r => {
      if (!r.ok) throw new Error(await r.text());
    }).catch(e => {
      lastLog.push(`[SCHEDULE][ERR] ${e.message}`);
      try { fs.appendFileSync(path.join(__dirname, '..', 'server_err.txt'), `${new Date().toISOString()} [SCHEDULE][ERR] ${e?.message || e}\n`); } catch {}
    });
    break; // satu render sekaligus
  }
}, 30000);

async function handleApi(req, res, parsed) {
  const pathname = parsed.pathname;

  // CORS untuk dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (pathname === '/api/status' && req.method === 'GET') {
    return send(res, 200, JSON.stringify({ ...getStatus(), lastLog: lastLog.slice(-80) }));
  }

  if (pathname === '/api/accounts' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(loadAccounts()));
  }

  if (pathname === '/api/accounts' && req.method === 'POST') {
    const body = await parseBody(req);
    // body: { platform: "youtube"|"facebook", account: {...} }
    const platform = body.platform;
    const acc = body.account;
    if (!['youtube', 'facebook'].includes(platform)) return send(res, 400, JSON.stringify({ error: 'platform harus youtube/facebook' }));
    if (!acc || !acc.name) return send(res, 400, JSON.stringify({ error: 'nama akun wajib' }));
    const data = loadAccounts();
    if (data[platform].some(a => a.name === acc.name)) return send(res, 409, JSON.stringify({ error: `Nama "${acc.name}" sudah ada` }));
    if (platform === 'youtube') {
      if (!acc.clientId || !acc.clientSecret || !acc.refreshToken) return send(res, 400, JSON.stringify({ error: 'Client ID/Secret/Refresh Token wajib' }));
      if (acc.privacyStatus && !['public','unlisted','private'].includes(acc.privacyStatus)) return send(res,400,JSON.stringify({error:'privacyStatus harus public/unlisted/private'}));
      data.youtube.push({ privacyStatus: 'private', enabled: true, ...acc });
    } else {
      if (!acc.pageId || !acc.token) return send(res, 400, JSON.stringify({ error: 'Page ID & Token wajib' }));
      data.facebook.push({ enabled: true, ...acc });
    }
    saveAccounts(data);
    return send(res, 200, JSON.stringify({ ok: true }));
  }

  if (pathname.startsWith('/api/accounts/') && req.method === 'DELETE') {
    const parts = pathname.split('/'); // /api/accounts/youtube/nama
    const platform = parts[3];
    const name = decodeURIComponent(parts[4] || '');
    const data = loadAccounts();
    const before = data[platform]?.length || 0;
    data[platform] = (data[platform] || []).filter(a => a.name !== name);
    if (data[platform].length === before) return send(res, 404, JSON.stringify({ error: 'Akun tidak ditemukan' }));
    saveAccounts(data);
    removeMember(platform, name);
    return send(res, 200, JSON.stringify({ ok: true }));
  }

  if (pathname.startsWith('/api/accounts/') && req.method === 'POST' && pathname.endsWith('/toggle')) {
    const parts = pathname.split('/'); // /api/accounts/youtube/nama/toggle
    const platform = parts[3];
    const name = decodeURIComponent(parts[4] || '');
    const body = await parseBody(req);
    const data = loadAccounts();
    const acc = (data[platform] || []).find(a => a.name === name);
    if (!acc) return send(res, 404, JSON.stringify({ error: 'Akun tidak ditemukan' }));
    acc.enabled = !!body.enabled;
    saveAccounts(data);
    return send(res, 200, JSON.stringify({ ok: true }));
  }

  if (pathname.startsWith('/api/accounts/') && req.method === 'PUT') {
    const parts = pathname.split('/'); // /api/accounts/youtube/nama
    const platform = parts[3];
    const name = decodeURIComponent(parts[4] || '');
    const patch = await parseBody(req);
    try {
      const updated = updateAccount(platform, name, patch);
      if (updated.name !== name) renameMember(platform, name, updated.name);
      return send(res, 200, JSON.stringify({ ok: true, account: updated }));
    } catch (e) {
      return send(res, 400, JSON.stringify({ error: e.message }));
    }
  }

  // === Grup multi upload ===
  if (pathname === '/api/groups' && req.method === 'GET') {
    return send(res, 200, JSON.stringify({ groups: loadGroups() }));
  }

  if (pathname === '/api/groups' && req.method === 'POST') {
    const body = await parseBody(req);
    const data = body.group || body;
    const bad = invalidGroupAccounts(data.accounts);
    if (bad) return send(res, 400, JSON.stringify({ error: bad }));
    try { return send(res, 200, JSON.stringify({ ok: true, group: addGroup(data) })); }
    catch (e) { return send(res, 400, JSON.stringify({ error: e.message })); }
  }

  if (pathname.startsWith('/api/groups/') && req.method === 'PUT') {
    const id = decodeURIComponent(pathname.split('/')[3] || '');
    const body = await parseBody(req);
    const data = body.group || body;
    const bad = invalidGroupAccounts(data.accounts);
    if (bad) return send(res, 400, JSON.stringify({ error: bad }));
    try { return send(res, 200, JSON.stringify({ ok: true, group: updateGroup(id, data) })); }
    catch (e) { return send(res, 400, JSON.stringify({ error: e.message })); }
  }

  if (pathname.startsWith('/api/groups/') && req.method === 'DELETE') {
    const id = decodeURIComponent(pathname.split('/')[3] || '');
    try { removeGroup(id); return send(res, 200, JSON.stringify({ ok: true })); }
    catch (e) { return send(res, 404, JSON.stringify({ error: e.message })); }
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(getSettings()));
  }
  if (pathname === '/api/settings' && req.method === 'PUT') {
    const patch = await parseBody(req);
    const allowed = ['POST_SCHEDULE','TIMEZONE','POST_STRATEGY','POST_GROUP','YT_PRIVACY_STATUS','YT_CATEGORY_ID','YT_DEFAULT_TAGS','YT_DEFAULT_DESC','FB_USE_REELS','FB_DEFAULT_DESC','ENABLE_YOUTUBE','ENABLE_FACEBOOK','PORT'];
    const clean = {};
    for (const k of allowed) if (patch[k] !== undefined) clean[k] = String(patch[k]);
    if (clean.POST_STRATEGY && !['all','rotate'].includes(clean.POST_STRATEGY.toLowerCase())) return send(res,400,JSON.stringify({error:'POST_STRATEGY harus all/rotate'}));
    if (clean.POST_GROUP && clean.POST_GROUP.toLowerCase() !== 'rotate' && !getGroup(clean.POST_GROUP)) return send(res,400,JSON.stringify({error:`Grup "${clean.POST_GROUP}" tidak ditemukan`}));
    if (clean.YT_PRIVACY_STATUS && !['public','unlisted','private'].includes(clean.YT_PRIVACY_STATUS)) return send(res,400,JSON.stringify({error:'Privacy harus public/unlisted/private'}));
    try { saveSettings(clean); return send(res,200,JSON.stringify({ok:true, settings:getSettings()})); }
    catch(e){ return send(res,500,JSON.stringify({error:e.message})); }
  }

  if (pathname === '/api/post' && req.method === 'POST') {
    const body = await parseBody(req);
    // body: { platform, account, strategy, file, meta: {title,description,tags,categoryId,privacyStatus,madeForKids,publishAt,fbCaption,fbUseReels} }
    lastLog.push(`[MANUAL] Posting dipicu via UI: ${JSON.stringify(body).slice(0, 500)}`);
    const file = body.file ? path.join(config.videosDir, path.basename(body.file)) : null;
    const opts = {
      platform: body.platform || 'all',
      account: body.account || null,
      group: body.group || null,
      strategy: (body.strategy || config.postStrategy).toLowerCase(),
      now: true,
      file,
      meta: body.meta || {},
    };
    // jalankan async tapi jangan block response lama — kirim progress via log polling
    postOne(file, opts).then(r => {
      lastLog.push('[MANUAL] Selesai: ' + JSON.stringify(r).slice(0, 800));
    }).catch(e => {
      lastLog.push('[MANUAL][ERR] ' + e.message);
    });
    return send(res, 200, JSON.stringify({ ok: true, msg: 'Posting dimulai, lihat log di dashboard' }));
  }

  if (pathname === '/api/videos' && req.method === 'GET') {
    const vids = listVideos().map(p => path.basename(p));
    return send(res, 200, JSON.stringify(vids));
  }

  if (pathname === '/api/videos/meta' && req.method === 'POST') {
    const body = await parseBody(req);
    const file = body.file;
    if (!file) return send(res, 400, JSON.stringify({ error: 'file wajib' }));
    const { saveMetadata } = require('./queue');
    const vPath = path.join(config.videosDir, path.basename(file));
    const jsonPath = saveMetadata(vPath, {
      title: body.title, description: body.description, tags: body.tags,
      categoryId: body.categoryId, privacyStatus: body.privacyStatus || undefined,
      madeForKids: body.madeForKids, publishAt: body.publishAt || undefined,
      fbCaption: body.fbCaption, fbUseReels: body.fbUseReels,
    });
    return send(res, 200, JSON.stringify({ ok: true, path: jsonPath }));
  }

  if (pathname === '/api/categories' && req.method === 'GET') {
    const { YT_CATEGORIES } = require('./queue');
    return send(res, 200, JSON.stringify(YT_CATEGORIES));
  }

  if (pathname === '/api/videos/meta-get' && req.method === 'GET') {
    const file = parsed.searchParams.get('file');
    if (!file) return send(res, 400, JSON.stringify({ error: 'file wajib' }));
    const vPath = path.join(config.videosDir, path.basename(file));
    if (!fs.existsSync(vPath)) return send(res, 404, JSON.stringify({ error: 'Video tidak ditemukan' }));
    return send(res, 200, JSON.stringify(getMetadata(vPath)));
  }

  if (pathname === '/api/history' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(loadPosted().slice(-100).reverse()));
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    // .env parsing sederhana (tanpa expose token penuh)
    const mask = (v) => (!v ? '' : v.length > 12 ? v.slice(0, 6) + '***' + v.slice(-4) : '***');
    return send(res, 200, JSON.stringify({
      schedule: config.schedule,
      timezone: config.timezone,
      strategy: config.postStrategy,
      enableYouTube: config.enableYouTube,
      enableFacebook: config.enableFacebook,
      privacyStatus: config.youtube.privacyStatus,
      ytMasked: { clientId: mask(config.youtube.clientId), refreshToken: mask(config.youtube.refreshToken) },
      fbMasked: { pageId: config.facebook.pageId || '', token: mask(config.facebook.token) },
    }));
  }

  // === YouTube OAuth via Browser (tanpa BAT) ===
  if (pathname === '/api/youtube/auth-url' && req.method === 'POST') {
    const body = await parseBody(req);
    const clientId = (body.clientId || '').trim();
    const clientSecret = (body.clientSecret || '').trim();
    if (!clientId || !clientSecret) return send(res, 400, JSON.stringify({ error: 'Client ID & Secret wajib' }));
    const { google } = require('googleapis');
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret, 'urn:ietf:wg:oauth:2.0:oob');
    const authUrl = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/youtube.upload'],
    });
    return send(res, 200, JSON.stringify({ authUrl }));
  }

  if (pathname === '/api/youtube/exchange' && req.method === 'POST') {
    const body = await parseBody(req);
    const clientId = (body.clientId || '').trim();
    const clientSecret = (body.clientSecret || '').trim();
    const code = (body.code || '').trim();
    if (!clientId || !clientSecret || !code) return send(res, 400, JSON.stringify({ error: 'Client ID, Secret & Kode wajib' }));
    try {
      const { google } = require('googleapis');
      const oauth2 = new google.auth.OAuth2(clientId, clientSecret, 'urn:ietf:wg:oauth:2.0:oob');
      const { tokens } = await oauth2.getToken(code);
      if (!tokens.refresh_token) {
        return send(res, 400, JSON.stringify({ error: 'Google tidak mengembalikan refresh_token. Coba lagi: saat login pilih akun yang benar & Allow. Jika sudah pernah Allow, buka https://myaccount.google.com/permissions lalu hapus akses app ini, lalu auth ulang.' }));
      }
      return send(res, 200, JSON.stringify({ refreshToken: tokens.refresh_token, accessToken: tokens.access_token }));
    } catch (e) {
      const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      return send(res, 400, JSON.stringify({ error: msg }));
    }
  }

  if (pathname === '/api/youtube/test' && req.method === 'POST') {
    const body = await parseBody(req);
    let acc = body;
    if (body.name && !body.refreshToken) {
      const data = loadAccounts();
      acc = data.youtube.find(a => a.name === body.name);
      if (!acc) return send(res, 404, JSON.stringify({ error: 'Akun tidak ditemukan' }));
    }
    if (!acc.clientId || !acc.clientSecret || !acc.refreshToken) return send(res, 400, JSON.stringify({ error: 'Client ID/Secret/RefreshToken belum lengkap — kesalahan umum: Client ID dobel/paste 2x, Secret kepotong, atau refreshToken masih pakai kode 4/... bukan 1//... . Pakai flow browser: Buka Login → Tukar Kode.' }));
    try {
      const { google } = require('googleapis');
      const oauth2 = new google.auth.OAuth2(acc.clientId, acc.clientSecret);
      oauth2.setCredentials({ refresh_token: acc.refreshToken });
      await oauth2.getAccessToken();
      return send(res, 200, JSON.stringify({ ok: true, msg: 'Token valid' }));
    } catch (e) {
      const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      let hint = '';
      if (msg.includes('invalid_client')) hint = ' — Client ID/Secret salah. Cek di console.cloud.google.com → Credentials → Desktop app, copy ulang (jangan dobel).';
      else if (msg.includes('invalid_grant')) hint = ' — Refresh Token salah/expired. Jangan paste kode 4/... langsung, harus Tukar Kode dulu jadi 1//... . Atau token 7 hari Testing expired, buat ulang.';
      return send(res, 400, JSON.stringify({ error: msg + hint }));
    }
  }

  // === Test token Facebook Page (validasi + ambil Page ID/nama) ===
  if (pathname === '/api/facebook/test' && req.method === 'POST') {
    const body = await parseBody(req);
    let acc = { pageId: body.pageId || '', token: body.token || '' };
    let storedName = null;
    if (body.name) {
      const data = loadAccounts();
      const found = data.facebook.find(a => a.name === body.name);
      if (!found) return send(res, 404, JSON.stringify({ error: 'Akun Facebook tidak ditemukan' }));
      acc = found;
      storedName = body.name;
    }
    if (!acc.token) return send(res, 400, JSON.stringify({ error: 'Token Facebook belum diisi' }));
    try {
      const endpoint = acc.pageId
        ? `${acc.pageId}?fields=id,name`
        : 'me?fields=id,name';
      const r = await fetch(`https://graph.facebook.com/${config.facebook.apiVersion}/${endpoint}&access_token=${encodeURIComponent(acc.token)}`);
      const j = await r.json();
      if (!r.ok || j.error) {
        if (storedName) updateAccount('facebook', storedName, { expired: true });
        return send(res, 400, JSON.stringify({ error: j.error?.message || 'Token Facebook tidak valid' }));
      }
      if (storedName) {
        const patch = { expired: false, pageName: j.name || '' };
        if (!acc.pageId && j.id) patch.pageId = j.id;
        updateAccount('facebook', storedName, patch);
      }
      return send(res, 200, JSON.stringify({ ok: true, id: j.id, name: j.name, pageId: j.id }));
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: e.message }));
    }
   }

   if (pathname === '/api/accounts/refresh-all' && req.method === 'POST') {
     try {
       const r = await refreshAllAccounts();
       const ytBad = (r.youtube || []).filter(x => !x.ok).map(x => x.name);
       const fbOk = (r.facebook && r.facebook.sukses) || [];
       lastLog.push(`[TOKEN] Periksa manual: YouTube ${(r.youtube || []).length - ytBad.length}/${(r.youtube || []).length} valid${ytBad.length ? ', expired: ' + ytBad.join(', ') : ''}${fbOk.length ? `; Facebook diperpanjang: ${fbOk.join(', ')}` : ''}`);
       return send(res, 200, JSON.stringify({ ok: true, ...r }));
     } catch (e) {
       return send(res, 500, JSON.stringify({ error: e.message }));
     }
   }

   if (pathname === '/api/facebook/refresh' && req.method === 'POST') {
     const body = await parseBody(req);
     const force = body.force === true || body.force === 'true';
     try {
       const results = await refreshAllTokens(force);
       return send(res, 200, JSON.stringify({ ok: true, results }));
     } catch (e) {
       return send(res, 500, JSON.stringify({ error: e.message }));
     }
   }

   if (pathname === '/api/facebook/token-status' && req.method === 'GET') {
     const data = loadAccounts();
     const status = (data.facebook || []).map(acc => {
       const expiredAt = acc.expired_at || acc.expiredAt;
       const now = Date.now();
       const expiresAt = expiredAt ? new Date(expiredAt).getTime() : null;
       const daysLeft = expiresAt ? Math.ceil((expiresAt - now) / 86400000) : null;
       const needsRefresh = daysLeft !== null && daysLeft < 7;
       return {
         name: acc.name,
         pageName: acc.pageName || '',
         pageId: acc.pageId || '',
         enabled: acc.enabled,
         expired: acc.expired || false,
         expiresAt: expiredAt,
         daysLeft,
         needsRefresh,
       };
     });
     return send(res, 200, JSON.stringify({ status }));
   }

   // === Upload file langsung (tidak permanen) ===
  if (pathname === '/api/upload' && req.method === 'POST') {
    // multer handle multipart
    return handleMulter(req, res, upload.single('video'), async () => {
      if (!req.file) return send(res, 400, JSON.stringify({ error: 'Pilih file video dulu' }));
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!config.supportedExt.includes(ext.slice(1))) {
        fs.unlinkSync(req.file.path);
        return send(res, 400, JSON.stringify({ error: `Format tidak didukung: ${ext}. Harus ${config.supportedExt.join(',')}` }));
      }
      const dest = path.join(config.videosDir, req.file.originalname);
      // jika nama sudah ada, tambah suffix
      let finalDest = dest;
      let i = 1;
      while (fs.existsSync(finalDest)) {
        const base = path.parse(dest).name;
        finalDest = path.join(config.videosDir, `${base}_${i}${ext}`);
        i++;
      }
      fs.mkdirSync(path.dirname(finalDest), { recursive: true });
      fs.renameSync(req.file.path, finalDest);
      return send(res, 200, JSON.stringify({ ok: true, file: path.basename(finalDest) }));
    });
  }

  if (pathname === '/api/post-direct' && req.method === 'POST') {
    return handleMulter(req, res, upload.single('video'), async () => {
      if (!req.file) return send(res, 400, JSON.stringify({ error: 'Pilih file video dulu' }));
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!config.supportedExt.includes(ext.slice(1))) {
        fs.unlinkSync(req.file.path);
        return send(res, 400, JSON.stringify({ error: `Format tidak didukung: ${ext}` }));
      }
      const tmpPath = req.file.path; // file sudah di .tmp
      const deleteAfter = req.body.deleteAfter === 'true' || req.body.deleteAfter === '1';
      // Field form ala YT Studio + FB composer (semua opsional, kosong = ikut default/file)
      const parseTags = v => !v ? undefined : String(v).split(',').map(s => s.trim()).filter(Boolean);
      const meta = {
        title: req.body.title || path.parse(req.file.originalname).name,
        description: req.body.description || '',
        tags: parseTags(req.body.tags),
        categoryId: req.body.categoryId || undefined,
        privacyStatus: req.body.privacyStatus || undefined,
        madeForKids: req.body.madeForKids === 'true' || req.body.madeForKids === '1',
        publishAt: req.body.publishAt || undefined,
        fbCaption: req.body.fbCaption || undefined,
        fbUseReels: req.body.fbUseReels === undefined || req.body.fbUseReels === '' || req.body.fbUseReels === 'default' ? undefined : (req.body.fbUseReels === 'true'),
      };
      const platform = req.body.platform || 'all';
      const account = req.body.account || null;
      const group = req.body.group || null;
      const strategy = (req.body.strategy || config.postStrategy).toLowerCase();
      lastLog.push(`[DIRECT] Upload langsung: ${req.file.originalname} (${(req.file.size/1024/1024).toFixed(2)}MB) deleteAfter=${deleteAfter} privacy=${meta.privacyStatus||'default'} cat=${meta.categoryId||'default'}`);
      try {
        const opts = { platform, account: account||null, group, strategy, now:true, file: tmpPath, meta };
        const { saveMetadata } = require('./queue');
        saveMetadata(tmpPath, meta);
        const results = await postOne(tmpPath, opts);
        // hapus file temp jika minta deleteAfter dan sukses
        const sukses = results && [...Object.values(results.youtube||{}), ...Object.values(results.facebook||{})].some(r=>r && !r.error);
        if (sukses && deleteAfter) {
          try { fs.unlinkSync(tmpPath); fs.unlinkSync(tmpPath+'.json'); } catch {}
          lastLog.push(`[DIRECT] File temp dihapus karena deleteAfter=true`);
        } else if (sukses && !deleteAfter) {
          // pindahkan ke videosDir agar jadi permanen
          const dest = path.join(config.videosDir, req.file.originalname);
          let finalDest = dest; let i=1;
          while (fs.existsSync(finalDest)) { finalDest = path.join(config.videosDir, `${path.parse(dest).name}_${i}${ext}`); i++; }
          fs.renameSync(tmpPath, finalDest);
          try { fs.renameSync(tmpPath+'.json', finalDest.replace(/\.[^.]+$/, '.json')); } catch {}
          lastLog.push(`[DIRECT] File dipindah ke videos/${path.basename(finalDest)} (tidak dihapus)`);
        } else {
          // gagal, biarkan file di tmp untuk retry
          lastLog.push(`[DIRECT] Gagal, file tetap di tmp`);
        }
        return send(res, 200, JSON.stringify({ ok: true, results, deleted: sukses && deleteAfter }));
      } catch (e) {
        const msg = e.message;
        lastLog.push(`[DIRECT][ERR] ${msg}`);
        return send(res, 400, JSON.stringify({ error: msg }));
      }
    });
  }

  // === Thumbnail custom (seperti di YT Studio) ===
  if (pathname === '/api/thumbnail' && req.method === 'POST') {
    return handleMulter(req, res, uploadImg.single('image'), async () => {
      const video = path.basename(req.body.video || '');
      if (!video) { if (req.file) fs.unlinkSync(req.file.path); return send(res, 400, JSON.stringify({ error: 'Pilih video dulu' })); }
      const vPath = path.join(config.videosDir, video);
      if (!fs.existsSync(vPath)) { if (req.file) fs.unlinkSync(req.file.path); return send(res, 404, JSON.stringify({ error: 'Video tidak ditemukan' })); }
      if (!req.file) return send(res, 400, JSON.stringify({ error: 'Pilih file gambar dulu' }));
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!THUMB_EXTS.includes(ext)) { fs.unlinkSync(req.file.path); return send(res, 400, JSON.stringify({ error: 'Format harus JPG/PNG' })); }
      if (req.file.size > 2 * 1024 * 1024) { fs.unlinkSync(req.file.path); return send(res, 400, JSON.stringify({ error: 'Ukuran maks 2MB (aturan YouTube)' })); }
      deleteThumb(vPath);
      const dest = vPath.replace(/\.[^.]+$/, ext);
      fs.renameSync(req.file.path, dest);
      lastLog.push(`[THUMB] Terpasang untuk ${video}: ${path.basename(dest)}`);
      return send(res, 200, JSON.stringify({ ok: true, file: path.basename(dest) }));
    });
  }

  if (pathname === '/api/thumb' && req.method === 'GET') {
    const vPath = path.join(config.videosDir, path.basename(parsed.searchParams.get('file') || ''));
    const thumb = thumbPathFor(vPath);
    if (!thumb) return send(res, 404, JSON.stringify({ error: 'Belum ada thumbnail' }));
    const ext = path.extname(thumb).toLowerCase();
    res.writeHead(200, { 'Content-Type': ext === '.png' ? 'image/png' : 'image/jpeg' });
    fs.createReadStream(thumb).pipe(res);
    return;
  }

  if (pathname === '/api/thumb' && req.method === 'DELETE') {
    const body = await parseBody(req);
    const vPath = path.join(config.videosDir, path.basename(body.file || ''));
    if (!deleteThumb(vPath)) return send(res, 404, JSON.stringify({ error: 'Belum ada thumbnail' }));
    return send(res, 200, JSON.stringify({ ok: true }));
  }

  // === Streaming file video untuk pratinjau (dukung Range agar bisa seek) ===
  if (pathname === '/api/video-file' && req.method === 'GET') {
    const vPath = path.join(config.videosDir, path.basename(parsed.searchParams.get('file') || ''));
    if (!fs.existsSync(vPath)) return send(res, 404, JSON.stringify({ error: 'Video tidak ditemukan' }));
    const ext = path.extname(vPath).toLowerCase();
    const mime = ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : ext === '.mkv' ? 'video/x-matroska' : 'video/mp4';
    const size = fs.statSync(vPath).size;
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (isNaN(start) || isNaN(end) || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      const e = Math.min(end, size - 1);
      res.writeHead(206, { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${e}/${size}`, 'Content-Length': e - start + 1 });
      fs.createReadStream(vPath, { start, end: e }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Length': size });
    fs.createReadStream(vPath).pipe(res);
    return;
  }

  if (pathname.startsWith('/api/videos/') && req.method === 'DELETE') {
    const name = decodeURIComponent(pathname.replace('/api/videos/',''));
    const filePath = path.join(config.videosDir, path.basename(name));
    if (!fs.existsSync(filePath)) return send(res, 404, JSON.stringify({ error: 'File tidak ditemukan' }));
    try {
      fs.unlinkSync(filePath);
      const jsonPath = filePath.replace(/\.[^.]+$/, '.json');
      if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
      deleteThumb(filePath);
      // hapus dari posted.json juga agar bisa upload ulang jika mau
      const posted = loadPosted().filter(p=>p.file!==path.basename(name));
      const { savePosted } = require('./queue');
      // savePosted ada di queue, kita require ulang
      fs.writeFileSync(config.postedDb, JSON.stringify(posted, null, 2));
      return send(res, 200, JSON.stringify({ ok: true }));
    } catch(e){ return send(res,500,JSON.stringify({error:e.message})); }
  }

  // === Google Drive ===
  function getDriveCredentials(body) {
    if (body && body.clientId && body.clientSecret && body.refreshToken) {
      return { clientId: body.clientId, clientSecret: body.clientSecret, refreshToken: body.refreshToken };
    }
    const data = loadAccounts();
    const yt = (data.youtube || []).find(a => a.enabled !== false && a.clientId && a.clientSecret && a.refreshToken);
    if (yt) return { clientId: yt.clientId, clientSecret: yt.clientSecret, refreshToken: yt.refreshToken };
    return { clientId: config.youtube.clientId, clientSecret: config.youtube.clientSecret, refreshToken: config.youtube.refreshToken };
  }

  if (pathname === '/api/drive/auth-url' && req.method === 'POST') {
    const body = await parseBody(req);
    const clientId = (body.clientId || '').trim();
    const clientSecret = (body.clientSecret || '').trim();
    if (!clientId || !clientSecret) return send(res, 400, JSON.stringify({ error: 'Client ID & Secret wajib' }));
    try {
      const authUrl = getDriveAuthUrl(clientId, clientSecret);
      return send(res, 200, JSON.stringify({ authUrl }));
    } catch (e) { return send(res, 500, JSON.stringify({ error: e.message })); }
  }

  if (pathname === '/api/drive/exchange' && req.method === 'POST') {
    const body = await parseBody(req);
    const clientId = (body.clientId || '').trim();
    const clientSecret = (body.clientSecret || '').trim();
    const code = (body.code || '').trim();
    if (!clientId || !clientSecret || !code) return send(res, 400, JSON.stringify({ error: 'Client ID, Secret & Kode wajib' }));
    try {
      const result = await exchangeDriveCode(clientId, clientSecret, code);
      return send(res, 200, JSON.stringify(result));
    } catch (e) { return send(res, 400, JSON.stringify({ error: e.message })); }
  }

  if (pathname === '/api/drive/files' && req.method === 'POST') {
    const body = await parseBody(req);
    const creds = getDriveCredentials(body);
    if (!creds.refreshToken) return send(res, 400, JSON.stringify({ error: 'Belum ada akun YouTube/Google yang terhubung. Tambah channel YouTube dulu, atau auth Google Drive.' }));
    try {
      const result = await listDriveVideos(creds, body.folderId || null, body.pageToken || null);
      return send(res, 200, JSON.stringify(result));
    } catch (e) { return send(res, 400, JSON.stringify({ error: e.message })); }
  }

  if (pathname === '/api/drive/folders' && req.method === 'POST') {
    const body = await parseBody(req);
    const creds = getDriveCredentials(body);
    if (!creds.refreshToken) return send(res, 400, JSON.stringify({ error: 'Belum ada akun Google yang terhubung.' }));
    try {
      const folders = await listDriveFolders(creds, body.parentId || null);
      return send(res, 200, JSON.stringify({ folders }));
    } catch (e) { return send(res, 400, JSON.stringify({ error: e.message })); }
  }

  if (pathname === '/api/drive/download' && req.method === 'POST') {
    const body = await parseBody(req);
    const fileId = (body.fileId || '').trim();
    if (!fileId) return send(res, 400, JSON.stringify({ error: 'fileId wajib' }));
    const creds = getDriveCredentials(body);
    if (!creds.refreshToken) return send(res, 400, JSON.stringify({ error: 'Belum ada akun Google yang terhubung.' }));
    lastLog.push(`[GDrive] Download dimulai: ${fileId}`);
    downloadDriveVideo(creds, fileId).then(result => {
      lastLog.push(`[GDrive] Selesai download: ${result.file} (${result.sizeMB}MB)`);
    }).catch(e => {
      lastLog.push(`[GDrive][ERR] Download gagal: ${e.message}`);
    });
    return send(res, 200, JSON.stringify({ ok: true, msg: 'Download dimulai' }));
  }

  if (pathname === '/api/drive/progress' && req.method === 'GET') {
    const fileId = parsed.searchParams.get('fileId') || '';
    if (!fileId) return send(res, 400, JSON.stringify({ error: 'fileId wajib' }));
    const progress = getDownloadProgress(fileId);
    if (!progress) return send(res, 404, JSON.stringify({ error: 'Tidak ada download aktif untuk file ini' }));
    return send(res, 200, JSON.stringify(progress));
  }

  if (pathname === '/api/drive/progress' && req.method === 'DELETE') {
    const body = await parseBody(req);
    clearProgress(body.fileId || '');
    return send(res, 200, JSON.stringify({ ok: true }));
  }

  // === Google Drive folder PUBLIK (tanpa OAuth) ===
  if (pathname === '/api/drive/public-list' && req.method === 'POST') {
    const body = await parseBody(req);
    const folderId = extractFolderId(body.link || body.folderId || '');
    if (!folderId) return send(res, 400, JSON.stringify({ error: 'Link folder Google Drive tidak valid. Contoh: https://drive.google.com/drive/folders/xxxx' }));
    try {
      const files = await listPublicFolder(folderId);
      return send(res, 200, JSON.stringify({ folderId, files }));
    } catch (e) { return send(res, 400, JSON.stringify({ error: e.message })); }
  }

  if (pathname === '/api/drive/public-download' && req.method === 'POST') {
    const body = await parseBody(req);
    const fileId = (body.fileId || '').trim();
    const fileName = (body.fileName || 'video.mp4').trim();
    if (!fileId) return send(res, 400, JSON.stringify({ error: 'fileId wajib' }));
    if (!/\.(mp4|mov|webm|mkv)$/i.test(fileName)) return send(res, 400, JSON.stringify({ error: 'Hanya video mp4/mov/webm/mkv' }));
    lastLog.push(`[GDrive] Download publik dimulai: ${fileName}`);
    downloadPublicFile(fileId, fileName).then(r => {
      lastLog.push(`[GDrive] Selesai: ${r.file} (${r.sizeMB}MB)`);
    }).catch(e => {
      lastLog.push(`[GDrive][ERR] ${e.message}`);
    });
    return send(res, 200, JSON.stringify({ ok: true, msg: 'Download dimulai' }));
  }

  // === SUMBER VIDEO: lokal (videos/) + YouTube ===
  if (pathname === '/api/sources/local' && req.method === 'GET') {
    return send(res, 200, JSON.stringify({ videos: sources.listLocalVideos(), dir: config.videosDir }));
  }

  if (pathname === '/api/sources/local' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      const r = sources.addLocalVideo(body.path);
      lastLog.push(`[SUMBER] Video lokal ditambah: ${r.file} (${r.sizeMB}MB)`);
      return send(res, 200, JSON.stringify({ ok: true, ...r }));
    } catch (e) { return send(res, 400, JSON.stringify({ error: e.message })); }
  }

  // upload file video dari browser -> videos/
  if (pathname === '/api/sources/upload' && req.method === 'POST') {
    return upload.single('file')(req, res, (err) => {
      if (err) return send(res, 400, JSON.stringify({ error: err.message || 'Upload gagal' }));
      if (!req.file) return send(res, 400, JSON.stringify({ error: 'Tidak ada file' }));
      // Salin via stream (bukan readFileSync) agar tidak memboros RAM untuk file besar.
      try {
        const r = sources.saveUploadedVideoStream(req.file.path, req.file.originalname);
        try { fs.unlinkSync(req.file.path); } catch {}
        lastLog.push(`[SUMBER] Video diupload: ${r.file} (${r.sizeMB}MB)`);
        return send(res, 200, JSON.stringify({ ok: true, ...r }));
      } catch (e) {
        try { fs.unlinkSync(req.file.path); } catch {}
        return send(res, 400, JSON.stringify({ error: e.message }));
      }
    });
  }

  if (pathname === '/api/sources/youtube' && req.method === 'POST') {
    const body = await parseBody(req);
    const info = sources.parseYouTube(body.url);
    if (!info) return send(res, 400, JSON.stringify({ error: 'Link YouTube tidak valid' }));
    lastLog.push(`[SUMBER] Download YouTube dimulai: ${body.url}`);
    sources.downloadYouTube(body.url)
      .then(r => lastLog.push(`[SUMBER] YouTube selesai: ${r.file || '?'} (${r.sizeMB || '?'}MB)`))
      .catch(e => lastLog.push(`[SUMBER][ERR] YouTube gagal: ${e.message}`));
    return send(res, 200, JSON.stringify({ ok: true, msg: 'Download YouTube dimulai' }));
  }

  if (pathname === '/api/sources/progress' && req.method === 'GET') {
    return send(res, 200, JSON.stringify({ progress: sources.getProgress() }));
  }

  // Download SEMUA video dari folder Drive publik -> videos/
  if (pathname === '/api/drive/download-all' && req.method === 'POST') {
    const body = await parseBody(req);
    const folderId = extractFolderId(body.link || body.folderId || '');
    if (!folderId) return send(res, 400, JSON.stringify({ error: 'Link folder Google Drive tidak valid' }));
    let files = body.files;
    if (!Array.isArray(files) || !files.length) {
      try { files = await listPublicFolder(folderId); }
      catch (e) { return send(res, 400, JSON.stringify({ error: e.message })); }
    }
    if (!files.length) return send(res, 400, JSON.stringify({ error: 'Folder kosong atau tidak bisa dibaca' }));
    lastLog.push(`[GDrive] Download semua dimulai: ${files.length} file`);
    sources.downloadAllFromFolder(folderId, files)
      .then(rs => {
        const ok = rs.filter(r => r.ok).length;
        lastLog.push(`[GDrive] Download semua selesai: ${ok}/${rs.length} berhasil`);
      })
      .catch(e => lastLog.push(`[GDrive][ERR] Download semua gagal: ${e.message}`));
    return send(res, 200, JSON.stringify({ ok: true, total: files.length, msg: 'Download semua dimulai' }));
  }

  // === Daftar link Google Drive tersimpan ===
  if (pathname === '/api/drive-links' && req.method === 'GET') {
    return send(res, 200, JSON.stringify({ links: loadLinks() }));
  }

  if (pathname === '/api/drive-links' && req.method === 'POST') {
    const body = await parseBody(req);
    const link = String(body.link || '').trim();
    if (!extractFolderId(link)) return send(res, 400, JSON.stringify({ error: 'Link folder Google Drive tidak valid' }));
    try {
      const item = addLink({ name: body.name, link });
      return send(res, 200, JSON.stringify({ ok: true, link: item }));
    } catch (e) { return send(res, 400, JSON.stringify({ error: e.message })); }
  }

  if (pathname.startsWith('/api/drive-links/') && req.method === 'DELETE') {
    const id = decodeURIComponent(pathname.replace('/api/drive-links/', ''));
    if (!removeLink(id)) return send(res, 404, JSON.stringify({ error: 'Link tidak ditemukan' }));
    return send(res, 200, JSON.stringify({ ok: true }));
  }

  // === Kompilasi otomatis (JUARA n ... JUARA 1) ===
  function runCompileJob(body, { fromSchedule = null } = {}) {
    return (async () => {
      // Sumber video: 'local' = pakai file di videos/, selain itu = folder Google Drive publik.
      const sourceMode = body.source === 'local' ? 'local' : 'gdrive';
      let videos;
      if (sourceMode === 'local') {
        const local = sources.listLocalVideos();
        videos = local.map(v => ({ id: 'local:' + v.name, name: v.name, src: 'local', path: path.join(config.videosDir, v.name) }));
        if (!videos.length) throw new Error('Belum ada video lokal di folder videos/. Tambah video dulu.');
      } else {
        const folderId = extractFolderId(body.link || body.folderId || '');
        if (!folderId) throw new Error('Link folder Google Drive tidak valid');
        let files;
        try { files = await listPublicFolder(folderId); }
        catch (e) { throw new Error(e.message); }
        // Deduplicate berdasarkan file ID agar satu render tidak pernah memuat video yang sama dua kali.
        videos = [...new Map(
          files.filter(f => /\.(mp4|mov|webm|mkv)$/i.test(f.name)).map(f => [f.id, f])
        ).values()];
        if (!videos.length) throw new Error('Tidak ada video di folder itu');
      }
      if (body.filterKeyword) {
        const kw = String(body.filterKeyword).toLowerCase();
        const filtered = videos.filter(v => v.name.toLowerCase().includes(kw));
        if (!filtered.length) throw new Error(`Tidak ada video cocok filter "${body.filterKeyword}"`);
        videos.splice(0, videos.length, ...filtered);
      }

      compileState = { running: true, logs: [], result: null, error: null, ffmpegProc: null, pendingPost: null, uploads: {}, progress: { phase: 'download', download: { percent: 0, done: 0, totalFiles: 0, current: '', percentFile: 0 }, render: { percent: 0, doneSec: 0, totalSec: 0, speed: 0 }, upload: { percent: 0, message: 'Menunggu' }, startedAt: Date.now(), updatedAt: Date.now() } };
      const opts = {
        videos,
        title: body.title || 'TOP VIDEO',
        subtitle: body.subtitle || 'KOMPILASI PILIHAN',
        mode: body.mode === 'count' ? 'count' : 'duration',
        count: Number(body.count) || 0,
        targetDuration: Number(body.targetDuration) || 60,
        crf: Number(body.crf) || 22,
        height: Number(body.height) || 1920,
        encoder: body.encoder || 'auto',
        draft: body.draft === true,
        draftSec: Number(body.draftSec) || 4,
        // Jangan blokir video yang pernah dipakai di render sebelumnya.
        // Pemilihan acak dari `videos` tetap unik dalam satu render.
        useMemory: false,
        watermark: body.watermark || null,
        onProc: p => { compileState.ffmpegProc = p; },
        onProgress: p => {
          try {
            const phase = p.phase || 'download';
            const prev = compileState.progress || { download: { percent: 0 }, render: { percent: 0 }, upload: { percent: 0 } };
            compileState.progress = {
              ...prev,
              phase,
              download: { ...(prev.download || { percent: 0 }), ...(phase === 'download' ? p : {}) },
              render: { ...(prev.render || { percent: 0 }), ...(phase === 'render' ? p : {}) },
              upload: { ...(prev.upload || { percent: 0 }), ...(phase === 'upload' ? p : {}) },
              updatedAt: Date.now(),
            };
          } catch (e) {
            lastLog.push(`[COMPILE][ERR] onProgress: ${e.message}`);
          }
        },
        onLog: msg => { compileState.logs.push(msg); if (compileState.logs.length > 300) compileState.logs.shift(); },
      };
      lastLog.push(`[COMPILE] Mulai kompilasi${fromSchedule ? ' (jadwal: ' + fromSchedule + ')' : ''}: ${videos.length} kandidat (sumber: ${sourceMode === 'local' ? 'video lokal' : 'Google Drive'}), mode=${body.mode || 'duration'}`);
      try {
        const r = await compile(opts);
        compileState.running = false;
        compileState.result = { ...r, ytAccounts: body.ytAccounts || [], fbAccounts: body.fbAccounts || [] };
        compileState.ffmpegProc = null;
        lastLog.push(`[COMPILE] Selesai: ${r.outName} (${r.count} video, ${r.duration.toFixed(1)}s, render ${(r.renderMs / 1000).toFixed(0)}s)`);
        // Setelah render selesai: JANGAN upload langsung. Tunggu sampai video terdeteksi
        // ada & stabil di Output Kompilasi, baru upload otomatis (lihat timer di atas).
        if (r.outName && !body.draft) {
          compileState.pendingPost = {
            file: r.outName,
            at: Date.now(),
            title: opts.title,
            subtitle: opts.subtitle,
            postTarget: body.postTarget || {},
            detected: false,
            lastSize: -1,
          };
          lastLog.push(`[COMPILE] Menunggu video "${r.outName}" terdeteksi di Output Kompilasi sebelum upload…`);
        } else if (r.outName) {
          lastLog.push(`[COMPILE] Selesai: ${r.outName} — pratinjau, tidak diupload otomatis.`);
        }
        return r;
      } catch (e) {
        compileState.running = false;
        compileState.error = e.message;
        compileState.ffmpegProc = null;
        lastLog.push(`[COMPILE][ERR] ${e.message}`);
        throw e;
      }
    })();
  }

  // Simpan runner di scope modul agar timer jadwal dapat memakainya setelah request selesai.
  compileRunner = runCompileJob;

  if (pathname === '/api/compile' && req.method === 'POST') {
    if (compileState.running) return send(res, 409, JSON.stringify({ error: 'Kompilasi sedang berjalan' }));
    const body = await parseBody(req);
    if (body._scheduleId) markRun(body._scheduleId);
    // Sumber lokal tidak butuh link folder Google Drive.
    if (body.source !== 'local') {
      const folderId = extractFolderId(body.link || body.folderId || '');
      if (!folderId) return send(res, 400, JSON.stringify({ error: 'Link folder Google Drive tidak valid' }));
    }
    runCompileJob(body).catch(e => {
      // Error sudah dicatat di compileState.error & lastLog oleh runCompileJob.
      // Tapi pastikan juga masuk server_err.txt agar tidak hilang saat server mati.
      try { fs.appendFileSync(path.join(__dirname, '..', 'server_err.txt'), `${new Date().toISOString()} [COMPILE][ERR] ${e?.stack || e?.message || e}\n`); } catch {}
    });
    return send(res, 200, JSON.stringify({ ok: true, msg: 'Kompilasi dimulai' }));
  }

  if (pathname === '/api/compile/status' && req.method === 'GET') {
    const pp = compileState.pendingPost;
    return send(res, 200, JSON.stringify({
      running: compileState.running,
      logs: compileState.logs.slice(-100),
      result: compileState.result,
      error: compileState.error,
      pendingPost: pp ? { file: pp.file, remainingMs: Math.max(0, pp.at - Date.now()) } : null,
      progress: compileState.progress,
      posting: compileState.posting,
      uploads: compileState.uploads || {},
    }));
  }

  if (pathname === '/api/compile/control' && req.method === 'POST') {
    const body = await parseBody(req);
    const action = body.action;
    if (action === 'cancel' && compileState.ffmpegProc) {
      try { compileState.ffmpegProc.kill('SIGKILL'); } catch {}
      compileState.logs.push('Dibatalkan oleh user.');
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    if (action === 'cancel-post') {
      if (compileState.pendingPost) {
        lastLog.push(`[AUTOPOST] Dibatalkan — ${compileState.pendingPost.file} tidak diposting.`);
        compileState.pendingPost = null;
        return send(res, 200, JSON.stringify({ ok: true }));
      }
      return send(res, 400, JSON.stringify({ error: 'Tidak ada auto-post yang menunggu' }));
    }
    if (action === 'post-now' && compileState.pendingPost) {
      compileState.pendingPost.at = Date.now();
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    return send(res, 400, JSON.stringify({ error: 'Aksi tidak dikenal' }));
  }

  if (pathname === '/api/compile/memory' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(loadMemory()));
  }
  if (pathname === '/api/compile/memory' && req.method === 'DELETE') {
    resetMemory();
    return send(res, 200, JSON.stringify({ ok: true }));
  }

  // === Jadwal kompilasi otomatis ===
  if (pathname === '/api/schedules' && req.method === 'GET') {
    const now = Date.now();
    const schedules = loadSchedules().map(s => {
      let nextRunAt = null;
      if (s.enabled) {
        if (s.type === 'once') {
          nextRunAt = s.runAt || null;
        } else if (s.type === 'interval') {
          const base = s.lastRun ? new Date(s.lastRun).getTime() : now;
          nextRunAt = new Date(Math.max(base, now - s.everyMinutes * 60000) + s.everyMinutes * 60000).toISOString();
      } else {
          const times = Array.isArray(s.times) && s.times.length ? s.times : (s.hours || []).map(h => `${String(h).padStart(2, '0')}:00`);
          // Cari jadwal berikutnya sampai level menit, bukan hanya jam.
          // Ini mendukung waktu seperti 06:15, 12:30, dan 17:45.
          for (let i = 1; i <= 7 * 24 * 60 && !nextRunAt; i++) {
            const d = new Date(now + i * 60000);
            let local;
            try { local = d.toLocaleTimeString('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hour12: false }); }
            catch { local = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
            const hhmm = local.slice(0, 5);
            if (times.includes(hhmm)) nextRunAt = d.toISOString();
          }
        }
      }
      return { ...s, nextRunAt };
    });
    return send(res, 200, JSON.stringify({ schedules }));
  }

  if (pathname === '/api/schedules' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.name || !String(body.name).trim()) return send(res, 400, JSON.stringify({ error: 'Nama jadwal wajib' }));
    if (body.source !== 'local' && (!body.options || !body.options.link)) return send(res, 400, JSON.stringify({ error: 'Pilih folder Google Drive dulu' }));
    try {
      const item = addSchedule(body);
      return send(res, 200, JSON.stringify({ ok: true, schedule: item }));
    } catch (e) { return send(res, 400, JSON.stringify({ error: e.message })); }
  }

  if (pathname.startsWith('/api/schedules/') && req.method === 'PUT') {
    const id = decodeURIComponent(pathname.replace('/api/schedules/', ''));
    const body = await parseBody(req);
    const item = updateSchedule(id, body);
    if (!item) return send(res, 404, JSON.stringify({ error: 'Jadwal tidak ditemukan' }));
    return send(res, 200, JSON.stringify({ ok: true, schedule: item }));
  }

  if (pathname.startsWith('/api/schedules/') && req.method === 'DELETE') {
    const id = decodeURIComponent(pathname.replace('/api/schedules/', ''));
    if (!removeSchedule(id)) return send(res, 404, JSON.stringify({ error: 'Jadwal tidak ditemukan' }));
    return send(res, 200, JSON.stringify({ ok: true }));
  }

  if (pathname.startsWith('/api/schedules/') && req.method === 'POST' && pathname.endsWith('/run')) {
    const id = decodeURIComponent(pathname.replace('/api/schedules/', '').replace('/run', ''));
    const sch = loadSchedules().find(s => s.id === id);
    if (!sch) return send(res, 404, JSON.stringify({ error: 'Jadwal tidak ditemukan' }));
    if (compileState.running) return send(res, 409, JSON.stringify({ error: 'Kompilasi sedang berjalan' }));
    markRun(id);
    runCompileJob(sch.options, { fromSchedule: sch.name }).catch(e => {
      try { fs.appendFileSync(path.join(__dirname, '..', 'server_err.txt'), `${new Date().toISOString()} [SCHEDULE][ERR] ${e?.stack || e?.message || e}\n`); } catch {}
    });
    return send(res, 200, JSON.stringify({ ok: true, msg: 'Jadwal dijalankan sekarang' }));
  }

  if (pathname === '/api/outputs' && req.method === 'GET') {
    return send(res, 200, JSON.stringify({ outputs: listOutputs() }));
  }

  // Streaming/delete output kompilasi
  if (pathname.startsWith('/api/output/') && req.method === 'GET') {
    const name = decodeURIComponent(pathname.replace('/api/output/', ''));
    const filePath = path.join(OUTPUT_DIR, path.basename(name));
    if (!fs.existsSync(filePath)) return send(res, 404, JSON.stringify({ error: 'File tidak ditemukan' }));
    const size = fs.statSync(filePath).size;
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (isNaN(start) || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      const e2 = Math.min(end, size - 1);
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${e2}/${size}`, 'Content-Length': e2 - start + 1 });
      fs.createReadStream(filePath, { start, end: e2 }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (pathname.startsWith('/api/output/') && req.method === 'DELETE') {
    const name = decodeURIComponent(pathname.replace('/api/output/', ''));
    const filePath = path.join(OUTPUT_DIR, path.basename(name));
    if (!fs.existsSync(filePath)) return send(res, 404, JSON.stringify({ error: 'File tidak ditemukan' }));
    fs.unlinkSync(filePath);
    return send(res, 200, JSON.stringify({ ok: true }));
  }

  // Pindahkan hasil kompilasi ke folder videos/ agar bisa diposting
  if (pathname === '/api/output/to-videos' && req.method === 'POST') {
    const body = await parseBody(req);
    const name = path.basename(body.file || '');
    const src = path.join(OUTPUT_DIR, name);
    if (!fs.existsSync(src)) return send(res, 404, JSON.stringify({ error: 'File tidak ditemukan' }));
    let dest = path.join(config.videosDir, name);
    let i = 1;
    while (fs.existsSync(dest)) {
      dest = path.join(config.videosDir, `${path.parse(name).name}_${i}${path.extname(name)}`);
      i++;
    }
    fs.copyFileSync(src, dest);
    return send(res, 200, JSON.stringify({ ok: true, file: path.basename(dest) }));
  }

  return send(res, 404, JSON.stringify({ error: 'Not found' }));
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');

  if (parsed.pathname.startsWith('/api/')) {
    try { await handleApi(req, res, parsed); }
    catch (e) { send(res, 500, JSON.stringify({ error: e.message })); }
    return;
  }

  // Static files
  let filePath = path.join(PUBLIC_DIR, parsed.pathname === '/' ? 'index.html' : parsed.pathname);
  // cegah traversal
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain');
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');

  if (fs.existsSync(filePath)) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    // video preview: support mp4 inline
    if (ext === '.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' });
    } else if (['.html', '.css', '.js'].includes(ext)) {
      // jangan cache file UI agar perubahan langsung terlihat tanpa hard refresh
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
    } else {
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
    }
    fs.createReadStream(filePath).pipe(res);
  } else {
    // SPA fallback: serve index.html untuk route tidak dikenal (bukan /api)
    const idx = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store, no-cache, must-revalidate' });
      fs.createReadStream(idx).pipe(res);
    } else {
      send(res, 404, 'Not found', 'text/plain');
    }
  }
});

// ============================================================
// CRASH PREVENTION — Wajib di Node.js 24 (unhandled rejection = exit)
// ============================================================

/** Tangani exception yang tidak ter-catch di level async. */
process.on('uncaughtException', (err, origin) => {
  const msg = `[CRASH][uncaughtException] ${err?.message || err} (origin: ${origin || 'unknown'})\n${err?.stack || ''}`;
  try { lastLog.push(msg); } catch {}
  try { fs.appendFileSync(path.join(__dirname, '..', 'server_err.txt'), `${new Date().toISOString()} ${msg}\n`); } catch {}
  // Jangan exit — coba lanjut. Jika ffmpeg crash, compileState masih bisa di-reset.
  if (err?.message && /EPIPE|ENOENT|EBADF|socket\s*hang|ECONNRESET/i.test(err.message)) {
    try { lastLog.push('[CRASH] Error I/O/network — server tetap jalan.'); } catch {}
    return;
  }
  // Error Fatal: reset compile state dan coba lanjut
  if (compileState.running) {
    try {
      compileState.running = false;
      compileState.error = '[CRASH] ' + (err?.message || String(err));
      compileState.ffmpegProc = null;
      compileState.posting = false;
    } catch {}
  }
  try { lastLog.push('[CRASH] Server survive — compile state di-reset.'); } catch {}
});

/** Tangani promise rejection yang tidak ter-catch. */
process.on('unhandledRejection', (reason, promise) => {
  const msg = `[CRASH][unhandledRejection] ${reason?.message || reason}\n${reason?.stack || ''}`;
  try { lastLog.push(msg); } catch {}
  try { fs.appendFileSync(path.join(__dirname, '..', 'server_err.txt'), `${new Date().toISOString()} ${msg}\n`); } catch {}
  // Reset compile state jika sedang running
  if (compileState?.running) {
    try {
      compileState.running = false;
      compileState.error = '[unhandledRejection] ' + (reason?.message || String(reason));
      compileState.ffmpegProc = null;
    } catch {}
  }
  try { lastLog.push('[CRASH] Unhandled promise rejected — server tetap jalan.'); } catch {}
});

function listenWithFallback(port, maxTries = 10) {
  const onError = (err) => {
    if (err.code === 'EADDRINUSE' && maxTries > 0) {
      console.warn(`[UI] Port ${port} sudah dipakai, coba port ${port + 1}...`);
      server.removeListener('error', onError);
      setTimeout(() => listenWithFallback(port + 1, maxTries - 1), 300);
    } else {
      console.error(`[UI] Gagal listen port ${port}:`, err.message);
      console.error('[UI] Solusi: ganti PORT di .env (mis. PORT=8787) atau tutup app yang pakai port tersebut.');
      process.exit(1);
    }
  };
  server.once('error', onError);
  server.listen(port, () => {
    server.removeListener('error', onError);
    const link = `http://localhost:${port}`;
    console.log(`\n[UI] Dashboard berjalan di ${link}`);
    console.log('[UI] Tekan Ctrl+C untuk berhenti.\n');
  });
}

if (require.main === module) {
  listenWithFallback(PORT);
}

module.exports = { server, PORT };

