const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const config = require('./config');

function getOAuthClient(account) {
  const clientId = account.clientId || config.youtube.clientId;
  const clientSecret = account.clientSecret || config.youtube.clientSecret;
  const refreshToken = account.refreshToken || config.youtube.refreshToken;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      `YouTube credential akun "${account.name || '?'}" belum lengkap. Tambahkan via: npm run setup`
    );
  }
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

/**
 * Upload 1 video sebagai YouTube Shorts ke 1 akun spesifik.
 * Field mirip form YouTube Studio: title(<=100), description(<=5000),
 * tags, categoryId, privacyStatus, madeForKids, publishAt (jadwal tayang).
 * Syarat Shorts: vertikal (9:16), durasi <= 60 dtk, judul/deskripsi ada #Shorts.
 */
async function uploadToYouTube(videoPath, { title, description, tags, categoryId, privacyStatus: metaPrivacy, madeForKids, publishAt } = {}, account = {}, hooks = {}) {
  hooks.status?.('connecting', `Menghubungkan ke YouTube: ${account.name || 'akun'}`);
  const auth = getOAuthClient(account);
  const youtube = google.youtube({ version: 'v3', auth });

  const fileSize = fs.statSync(videoPath).size;
  const finalTitle = (title || path.parse(videoPath).name).slice(0, 100);
  let desc = (description || config.youtube.defaultDesc || '').slice(0, 5000);
  if (!/#shorts/i.test(desc)) desc = `${desc}\n#Shorts`.trim().slice(0, 5000);
  const privacyStatus = metaPrivacy || account.privacyStatus || config.youtube.privacyStatus;
  const kids = madeForKids === true;
  const finalCategory = categoryId || config.youtube.categoryId || '22';
  const finalTags = (tags && tags.length ? tags : config.youtube.defaultTags).slice(0, 500);

  const status = {
    privacyStatus,
    madeForKids: kids,
    selfDeclaredMadeForKids: kids,
  };
  // Jadwal tayang ala YouTube Studio ("Schedule"): privacy harus private + publishAt masa depan
  let schedNote = '';
  if (publishAt) {
    const dt = new Date(publishAt);
    if (!isNaN(dt) && dt > new Date()) {
      status.privacyStatus = 'private';
      status.publishAt = dt.toISOString();
      schedNote = ` (terjadwal ${dt.toLocaleString('id-ID')})`;
    }
  }

  console.log(`[YouTube:${account.name || 'default'}] Uploading: ${path.basename(videoPath)} (${(fileSize / 1024 / 1024).toFixed(2)} MB) "${finalTitle}" [${status.privacyStatus}${kids ? ', kids' : ''}]${schedNote}`);

  const maxRetries = 5;
  const baseDelayMs = 3000;
  let res, lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      hooks.status?.('uploading', attempt > 1 ? `YouTube retry ${attempt}/${maxRetries}…` : `Upload YouTube dimulai: ${account.name || 'akun'}`);
      hooks.progress?.(5, `Mengunggah ke YouTube: ${account.name || 'akun'} (attempt ${attempt})`);
      res = await youtube.videos.insert({
        part: ['snippet', 'status'],
        requestBody: {
          snippet: { title: finalTitle, description: desc, tags: finalTags, categoryId: finalCategory },
          status,
        },
        media: { body: fs.createReadStream(videoPath) },
      }, { timeout: 0 }); // no timeout for large file uploads
      break;
    } catch (err) {
      lastErr = err;
      const isRetryable = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' ||
        err.code === 'socketHangUp' || err.code === 'PROTOCOL_CONNECTION_LOST' ||
        (err.message && /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|getaddrinfo|connection reset|handshake failed|request timeout/i.test(err.message));
      if (attempt === maxRetries || !isRetryable) throw err;
      const waitMs = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`[YouTube:${account.name}] Gagal attempt ${attempt}/${maxRetries} — ${err.code || err.message?.slice(0, 100)}, retry dalam ${waitMs}ms…`);
      hooks.status?.('uploading', `YouTube retry ${attempt + 1}/${maxRetries} dalam ${waitMs / 1000}s…`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  const videoId = res.data.id;
  const url = `https://youtu.be/${videoId}`;
  hooks.progress?.(100, `YouTube selesai: ${account.name || 'akun'}`);
  hooks.status?.('success', `YouTube berhasil: ${url}`);
  console.log(`[YouTube:${account.name || 'default'}] Sukses: ${url}`);
  let thumbApplied = false;
  try {
    const { thumbPathFor } = require('./queue');
    const thumb = thumbPathFor(videoPath);
    if (thumb) {
      if (kids) {
        console.warn(`[YouTube:${account.name || 'default'}] Thumbnail dilewati: video anak-anak tidak boleh custom thumbnail.`);
      } else if (fs.statSync(thumb).size > 2 * 1024 * 1024) {
        console.warn(`[YouTube:${account.name || 'default'}] Thumbnail dilewati: ukuran > 2MB.`);
      } else {
        await youtube.thumbnails.set({ videoId, media: { body: fs.createReadStream(thumb) } });
        console.log(`[YouTube:${account.name || 'default'}] Thumbnail terpasang: ${path.basename(thumb)}`);
        thumbApplied = true;
      }
    }
  } catch (e) {
    const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.warn(`[YouTube:${account.name || 'default'}] Thumbnail gagal (video tetap terupload): ${msg}`);
  }
  return { videoId, url, account: account.name, title: finalTitle, privacyStatus: status.privacyStatus, publishAt: status.publishAt || null, thumbApplied };
}

module.exports = { uploadToYouTube };
