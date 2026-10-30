/**
 * Helper untuk mendapatkan YT_REFRESH_TOKEN (cukup 1x saja).
 * Cara pakai:
 *   1. Isi YT_CLIENT_ID & YT_CLIENT_SECRET di .env
 *   2. npm run auth:youtube
 *   3. Buka URL yang muncul, login Google, paste kode -> dapat refresh_token
 *   4. Masukkan ke .env sebagai YT_REFRESH_TOKEN
 */
require('dotenv').config();
const readline = require('readline');
const { google } = require('googleapis');

const clientId = process.env.YT_CLIENT_ID;
const clientSecret = process.env.YT_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Isi dulu YT_CLIENT_ID & YT_CLIENT_SECRET di .env');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(
  clientId,
  clientSecret,
  'urn:ietf:wg:oauth:2.0:oob'
);

const url = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/youtube.upload'],
});

console.log('\n1. Buka URL ini di browser:\n');
console.log(url);
console.log('\n2. Login & izinkan, lalu copy kode verifikasinya.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Paste kode di sini: ', async (code) => {
  try {
    const { tokens } = await oauth2.getToken(code.trim());
    console.log('\n=== SUKSES ===');
    console.log('Refresh token Anda:\n');
    console.log(tokens.refresh_token);
    console.log('\nMasukkan ke .env sebagai YT_REFRESH_TOKEN');
  } catch (e) {
    console.error('Gagal:', e.message);
  }
  rl.close();
});
