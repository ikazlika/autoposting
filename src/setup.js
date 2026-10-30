/**
 * CLI interaktif untuk input credential banyak akun.
 * Jalankan: npm run setup
 *
 * Menu:
 *  1. Tambah akun YouTube
 *  2. Tambah akun Facebook Page
 *  3. Lihat daftar akun
 *  4. Hapus akun
 *  5. Aktif / nonaktifkan akun
 *  6. Panduan dapat credential
 *  0. Keluar
 */
const readline = require('readline');
const config = require('./config');
const {
  loadAccounts,
  addYouTubeAccount,
  addFacebookAccount,
  removeAccount,
  toggleAccount,
} = require('./accounts');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def = '') =>
  new Promise((res) => rl.question(`${q}${def ? ` [${def}]` : ''}: `, (a) => res(a.trim() || def)));

async function tambahYouTube() {
  console.log('\n--- Tambah Akun YouTube ---');
  const name = await ask('Nama akun (misal: akun1, channel-utama)');
  if (!name) return console.log('Batal: nama wajib diisi.');
  const clientId = await ask('Client ID', config.youtube.clientId);
  const clientSecret = await ask('Client Secret', config.youtube.clientSecret);
  console.log('\nButuh Refresh Token? Jalankan di terminal lain: npm run auth:youtube');
  const refreshToken = await ask('Refresh Token');
  const privacyStatus = await ask('Privacy (public/unlisted/private)', 'public');
  if (!clientId || !clientSecret || !refreshToken) return console.log('Batal: Client ID/Secret/Refresh Token wajib diisi.');
  try {
    addYouTubeAccount({ name, clientId, clientSecret, refreshToken, privacyStatus });
    console.log(`✔ Akun YouTube "${name}" tersimpan.`);
  } catch (e) { console.error('✘ ' + e.message); }
}

async function tambahFacebook() {
  console.log('\n--- Tambah Facebook Page ---');
  const name = await ask('Nama akun (misal: page1, olshop-jkt)');
  if (!name) return console.log('Batal: nama wajib diisi.');
  const pageId = await ask('Page ID');
  const token = await ask('Page Access Token');
  if (!pageId || !token) return console.log('Batal: Page ID & Token wajib diisi.');
  try {
    addFacebookAccount({ name, pageId, token });
    console.log(`✔ Akun Facebook "${name}" tersimpan.`);
  } catch (e) { console.error('✘ ' + e.message); }
}

function lihatAkun() {
  const data = loadAccounts();
  console.log('\n=== Akun YouTube ===');
  if (!data.youtube.length) console.log('(kosong — akan fallback ke .env bila diisi)');
  data.youtube.forEach((a, i) => console.log(` ${i + 1}. ${a.name} [${a.enabled === false ? 'OFF' : 'ON'}] privacy=${a.privacyStatus || 'public'}`));
  console.log('\n=== Akun Facebook ===');
  if (!data.facebook.length) console.log('(kosong — akan fallback ke .env bila diisi)');
  data.facebook.forEach((a, i) => console.log(` ${i + 1}. ${a.name} [${a.enabled === false ? 'OFF' : 'ON'}] pageId=${a.pageId}`));
  console.log(`\nFile: ${config.accountsFile}`);
  console.log(`Strategi posting: ${config.postStrategy} (atur di .env POST_STRATEGY=all|rotate)`);
}

async function hapusAkun() {
  lihatAkun();
  const platform = await ask('\nHapus dari platform? (youtube/facebook)');
  if (!['youtube', 'facebook'].includes(platform)) return console.log('Batal.');
  const name = await ask('Nama akun yang dihapus');
  try { removeAccount(platform, name); console.log(`✔ Akun ${platform}/${name} dihapus.`); }
  catch (e) { console.error('✘ ' + e.message); }
}

async function toggleAkun() {
  lihatAkun();
  const platform = await ask('\nPlatform? (youtube/facebook)');
  if (!['youtube', 'facebook'].includes(platform)) return console.log('Batal.');
  const name = await ask('Nama akun');
  const on = await ask('Aktifkan? (y/n)', 'y');
  try { toggleAccount(platform, name, on.toLowerCase() === 'y'); console.log('✔ Status diubah.'); }
  catch (e) { console.error('✘ ' + e.message); }
}

function panduan() {
  console.log(`
=== PANDUAN CREDENTIAL ===

[YouTube - per akun/channel]
1. https://console.cloud.google.com -> buat project -> aktifkan "YouTube Data API v3"
2. Credentials -> OAuth Client ID (Desktop) -> dapat Client ID & Secret
3. npm run auth:youtube -> login channel tsb -> dapat Refresh Token
4. Ulangi langkah 3 untuk tiap channel Google berbeda (login akun berbeda).
   Catatan: 1 OAuth Client bisa dipakai banyak channel, yang beda = Refresh Token-nya.

[Facebook - per Page]
1. https://developers.facebook.com -> buat App
2. Graph API Explorer -> pilih Page -> centang pages_manage_posts -> Generate Token
3. Salin Page ID + Token. Ulangi untuk tiap Page.
4. Token berumur pendek; perpanjang jadi long-lived token (60 hari) via docs Meta,
   lalu refresh berkala. Simpan 1 token per Page di sini.
`);
}

async function main() {
  console.log('=== Setup Multi-Akun Auto Posting ===');
  for (;;) {
    console.log('\n1. Tambah akun YouTube\n2. Tambah akun Facebook\n3. Lihat daftar akun\n4. Hapus akun\n5. Aktif/nonaktifkan akun\n6. Panduan credential\n0. Keluar');
    const p = await ask('Pilih');
    if (p === '1') await tambahYouTube();
    else if (p === '2') await tambahFacebook();
    else if (p === '3') lihatAkun();
    else if (p === '4') await hapusAkun();
    else if (p === '5') await toggleAkun();
    else if (p === '6') panduan();
    else if (p === '0') break;
    else console.log('Pilihan tidak dikenal.');
  }
  rl.close();
}

main();
