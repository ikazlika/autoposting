const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getNextVideo, getMetadata, markAsPosted, loadPosted } = require('./queue');
const { getYouTubeAccounts, getFacebookAccounts, pickRotate } = require('./accounts');
const { getGroup } = require('./groups');
const { uploadToYouTube } = require('./youtube');
const { uploadToFacebook } = require('./facebook');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { now: false, platform: 'all', file: null, account: null, group: null, strategy: config.postStrategy };
  for (const a of args) {
    if (a === '--now') opts.now = true;
    else if (a.startsWith('--platform=')) opts.platform = a.split('=')[1];
    else if (a.startsWith('--file=')) opts.file = path.resolve(a.split('=')[1]);
    else if (a.startsWith('--account=')) opts.account = a.split('=')[1];
    else if (a.startsWith('--group=')) opts.group = a.split('=')[1];
    else if (a.startsWith('--strategy=')) opts.strategy = a.split('=')[1].toLowerCase();
  }
  return opts;
}

function filterByName(list, name) {
  if (!name) return list;
  // format: "yt:akun1" atau "fb:page1" atau nama umum untuk kedua platform
  if (name.includes(':')) {
    const [pfx] = name.split(':');
    return list; // filtering platform sudah via --platform; nama detail difilter di bawah
  }
  return list.filter(a => a.name === name);
}

function matchAccount(filter, accName) {
  if (!filter) return true;
  if (filter === accName) return true;
  const parts = filter.split(':');
  if (parts.length === 2 && parts[1] === accName) return true;
  return false;
}

async function postOne(videoPath, cliOpts = null) {
  const opts = cliOpts ? { ...parseArgs(), ...cliOpts } : parseArgs();
  if (!videoPath) videoPath = getNextVideo();
  if (!videoPath) {
    console.log('Tidak ada video baru di folder videos/. Tambahkan file .mp4 vertikal.');
    return null;
  }
  if (!fs.existsSync(videoPath)) throw new Error('File tidak ditemukan: ' + videoPath);

  const fileMeta = getMetadata(videoPath);
  // opts.meta = override dari form UI (seperti form YT Studio/FB), menang atas file .json bila diisi
  const o = opts.meta || {};
  const nonEmpty = v => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
  const meta = { ...fileMeta };
  for (const k of ['title', 'description', 'tags', 'categoryId', 'privacyStatus', 'madeForKids', 'publishAt', 'fbCaption', 'fbUseReels']) {
    if (nonEmpty(o[k])) meta[k] = o[k];
  }
  if (typeof meta.tags === 'string') meta.tags = meta.tags.split(',').map(s => s.trim()).filter(Boolean);
  console.log(`\n=== Posting: ${path.basename(videoPath)} ===`);
  console.log(`Judul: ${meta.title}`);
  console.log(`Strategi: ${opts.strategy} | Platform: ${opts.platform}${opts.group ? ` | Grup: ${opts.group}` : ''}${opts.account ? ` | Akun: ${opts.account}` : ''}${meta.publishAt ? ` | Jadwal YT: ${meta.publishAt}` : ''}`);

  let ytAccounts = getYouTubeAccounts().filter(a => matchAccount(opts.account, a.name));
  let fbAccounts = getFacebookAccounts().filter(a => matchAccount(opts.account, a.name));
  let selectedGroup = null;

  // Grup: batasi akun sesuai anggota grup (multi upload dalam 1 grup)
  if (opts.group) {
    selectedGroup = getGroup(opts.group);
    if (!selectedGroup) throw new Error(`Grup "${opts.group}" tidak ditemukan.`);
    const group = selectedGroup;
    if (group.enabled === false) throw new Error(`Grup "${group.name}" sedang nonaktif.`);
    const ytMembers = new Set(group.accounts.filter(a => a.platform === 'youtube').map(a => a.name));
    const fbMembers = new Set(group.accounts.filter(a => a.platform === 'facebook').map(a => a.name));
    ytAccounts = ytAccounts.filter(a => ytMembers.has(a.name));
    fbAccounts = fbAccounts.filter(a => fbMembers.has(a.name));
    const activeKeys = new Set([
      ...ytAccounts.map(a => `youtube:${a.name}`),
      ...fbAccounts.map(a => `facebook:${a.name}`),
    ]);
    const skipped = group.accounts.filter(m => !activeKeys.has(`${m.platform}:${m.name}`));
    console.log(`[Group] ${group.name}: ${ytAccounts.length} YouTube + ${fbAccounts.length} Facebook`);
    if (skipped.length) {
      console.warn(`[Group] Dilewati (nonaktif/token tidak valid): ${skipped.map(m => `${m.platform}/${m.name}`).join(', ')}`);
    }
    if (!ytAccounts.length && !fbAccounts.length) {
      throw new Error(`Grup "${group.name}" tidak punya akun aktif. Aktifkan akun atau perbarui tokennya dulu.`);
    }
  }

  // Strategi rotate: pilih 1 akun per platform secara bergiliran
  // (tidak dipakai bila memakai grup — semua anggota grup diupload sekaligus)
  if (opts.strategy === 'rotate' && !opts.group) {
    const n = loadPosted().length;
    if (ytAccounts.length > 1) {
      const pick = pickRotate(ytAccounts, n);
      console.log(`[Rotate] YouTube giliran: ${pick.name}`);
      ytAccounts = [pick];
    }
    if (fbAccounts.length > 1) {
      const pick = pickRotate(fbAccounts, n);
      console.log(`[Rotate] Facebook giliran: ${pick.name}`);
      fbAccounts = [pick];
    }
  }

  const results = {};
  const platform = (opts.platform || 'all').toLowerCase();

  if ((platform === 'all' || platform === 'youtube') && config.enableYouTube) {
    if (!ytAccounts.length) {
      console.log('[YouTube] Tidak ada akun terdaftar. Jalankan: npm run setup');
      results.youtube = { error: 'no-accounts' };
    } else {
      results.youtube = {};
      await Promise.all(ytAccounts.map(async acc => {
        try {
          const accountMeta = {
            ...meta,
            title: acc.defaultTitle || meta.title,
            description: acc.defaultDescription || meta.description,
            tags: acc.defaultTags || meta.tags,
          };
          results.youtube[acc.name] = await uploadToYouTube(videoPath, accountMeta, acc, {
            status: (state, message) => opts.onUploadStatus?.('youtube', acc.name, state, message),
            progress: (percent, message) => opts.onUploadProgress?.('youtube', acc.name, percent, message),
          });
        } catch (e) {
          const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
          console.error(`[YouTube:${acc.name}] Gagal:`, msg);
          opts.onUploadStatus?.('youtube', acc.name, 'error', `YouTube gagal: ${msg}`);
          results.youtube[acc.name] = { error: msg, account: acc.name };
        }
      }));
    }
  }

  if ((platform === 'all' || platform === 'facebook') && config.enableFacebook) {
    if (!fbAccounts.length) {
      console.log('[Facebook] Tidak ada akun terdaftar. Jalankan: npm run setup');
      results.facebook = { error: 'no-accounts' };
    } else {
      results.facebook = {};
      await Promise.all(fbAccounts.map(async acc => {
        try {
          const accountMeta = {
            ...meta,
            title: acc.defaultTitle || meta.title,
            description: acc.defaultDescription || meta.description,
            fbCaption: acc.defaultDescription || acc.defaultTitle || meta.fbCaption || meta.description,
            tags: acc.defaultTags || meta.tags,
          };
          results.facebook[acc.name] = await uploadToFacebook(videoPath, accountMeta, acc, {
            status: (state, message) => opts.onUploadStatus?.('facebook', acc.name, state, message),
            progress: (percent, message) => opts.onUploadProgress?.('facebook', acc.name, percent, message),
          });
        } catch (e) {
          const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
          console.error(`[Facebook:${acc.name}] Gagal:`, msg);
          opts.onUploadStatus?.('facebook', acc.name, 'error', `Facebook gagal: ${msg}`);
          results.facebook[acc.name] = { error: msg, account: acc.name };
        }
      }));
    }
  }

  const sukses = [...Object.values(results.youtube || {}), ...Object.values(results.facebook || {})]
    .some(r => r && typeof r === 'object' && !r.error);

  if (sukses) {
    markAsPosted(path.basename(videoPath), { strategy: opts.strategy, group: selectedGroup?.name || null, ...results });
    console.log('✔ Dicatat di data/posted.json');
    if (config.deleteAfterPost) {
      fs.unlinkSync(videoPath);
      console.log('(File dihapus karena DELETE_AFTER_POST=true)');
    }
  } else {
    console.log('✘ Semua akun/platform gagal, video TIDAK ditandai posted (akan dicoba lagi).');
  }
  return results;
}

// Jika dijalankan langsung:
// node src/post.js --now [--platform=all|youtube|facebook] [--account=nama] [--strategy=all|rotate] [--file=...]
if (require.main === module) {
  const opts = parseArgs();
  if (!opts.now && !opts.file) {
    console.log('Pakai: node src/post.js --now [--platform=youtube|facebook|all] [--account=nama] [--group="Grup 1"] [--strategy=all|rotate] [--file=videos/xxx.mp4]');
    process.exit(0);
  }
  const { getNextVideo: gnv } = require('./queue');
  const target = opts.file || gnv();
  postOne(target, opts).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { postOne, parseArgs };
