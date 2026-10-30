const cron = require('node-cron');
const config = require('./config');
const { postOne } = require('./post');
const { getYouTubeAccounts, getFacebookAccounts } = require('./accounts');
const { getGroup, getEnabledGroups, pickGroup } = require('./groups');
const { loadPosted } = require('./queue');
const { refreshAllTokens } = require('./token_refresher');

const ytN = getYouTubeAccounts().length;
const fbN = getFacebookAccounts().length;

function schedulerOpts() {
  const opts = { now: true, platform: 'all', account: null, file: null, strategy: config.postStrategy };
  const wanted = config.postGroup;
  if (!wanted) return opts;
  if (wanted.toLowerCase() === 'rotate') {
    const group = pickGroup(loadPosted().length);
    if (group) {
      opts.group = group.id;
      console.log(`[Scheduler] Giliran grup: ${group.name}`);
    }
    return opts;
  }
  const group = getGroup(wanted);
  if (group) opts.group = group.id;
  else console.warn(`[Scheduler] Grup "${wanted}" tidak ditemukan, posting ke semua akun.`);
  return opts;
}

console.log(`[Scheduler] Jadwal: "${config.schedule}" (${config.timezone}) | Strategi: ${config.postStrategy}`);
if (config.postGroup) {
  const label = config.postGroup.toLowerCase() === 'rotate'
    ? `giliran ${getEnabledGroups().length} grup`
    : (getGroup(config.postGroup)?.name || `"${config.postGroup}" (tidak ditemukan)`);
  console.log(`[Scheduler] Grup: ${label}`);
}
console.log(`[Scheduler] Folder: ${config.videosDir}`);
console.log(`[Scheduler] YouTube: ${config.enableYouTube ? `ON (${ytN} akun)` : 'OFF'} | Facebook: ${config.enableFacebook ? `ON (${fbN} akun)` : 'OFF'}`);
if (ytN === 0 && fbN === 0) {
  console.log('[Scheduler] Belum ada akun! Jalankan: npm run setup (atau isi .env untuk 1 akun).');
}

if (!cron.validate(config.schedule)) {
  console.error('Format POST_SCHEDULE tidak valid! Contoh valid: "0 10,18 * * *"');
  process.exit(1);
}

cron.schedule(config.schedule, async () => {
  console.log(`\n[Scheduler] Trigger ${new Date().toLocaleString('id-ID', { timeZone: config.timezone })}`);
  try {
    if (config.enableFacebook) {
      await refreshAllTokens();
    }
    await postOne(null, schedulerOpts());
  } catch (e) {
    console.error('[Scheduler] Error:', e.message);
  }
}, { timezone: config.timezone });

console.log('[Scheduler] Berjalan. Tekan Ctrl+C untuk berhenti.');

// Posting langsung saat start jika ada argumen --now
if (process.argv.includes('--now')) {
  postOne(null, schedulerOpts()).catch(e => console.error(e));
}
