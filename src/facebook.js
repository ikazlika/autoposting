const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const config = require('./config');

function fbBase() {
  return `https://graph.facebook.com/${config.facebook.apiVersion}`;
}

/**
 * Upload sebagai Facebook Reels (3 tahap: start -> upload binary -> finish/publish).
 * Docs: developers.facebook.com/docs/video-api/guides/reels-publishing
 */
function buildFbCaption({ title, description, fbCaption } = {}) {
  // Caption khusus FB (seperti kolom komposer Reels). Fallback: judul + deskripsi.
  if (fbCaption) return String(fbCaption).slice(0, 2200);
  return [title, description || config.facebook.defaultDesc].filter(Boolean).join('\n\n').slice(0, 2200);
}

async function uploadReels(videoPath, meta = {}, account, hooks = {}) {
  const pageId = account.pageId;
  const token = account.token;
  if (!pageId || !token) throw new Error(`Facebook credential akun "${account.name || '?'}" belum lengkap. Tambahkan via: npm run setup`);
  const desc = buildFbCaption(meta);

  const maxRetries = 5;
  const baseDelayMs = 3000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Facebook:${account.name}] Upload Reels (start attempt ${attempt}): ${path.basename(videoPath)}`);
      hooks.status?.('uploading', `Facebook upload attempt ${attempt}/${maxRetries}`);

      // 1. START
      const startRes = await axios.post(`${fbBase()}/${pageId}/video_reels`, null, {
        params: { upload_phase: 'start', access_token: token },
      });
      const videoId = startRes.data.video_id;
      if (!videoId) throw new Error('Gagal start upload reels: ' + JSON.stringify(startRes.data));
      console.log(`[Facebook:${account.name}] video_id: ${videoId}`);
      hooks.progress?.(5, `Facebook: video ID ${videoId}, mulai upload`);

      // 2. UPLOAD BINARY (rupload) — pakai stream agar tidak load seluruh file ke RAM
      const fileSize = fs.statSync(videoPath).size;
      hooks.progress?.(10, `Facebook: menyiapkan file`);
      const fileStream = fs.createReadStream(videoPath);
      let uploadedBytes = 0;
      fileStream.on('data', chunk => { uploadedBytes += chunk.length; hooks.progress?.(10 + Math.round(uploadedBytes / fileSize * 60), `Facebook: uploading ${account.name || 'halaman'}…`); });
      hooks.progress?.(30, `Facebook: mengunggah ${account.name || 'halaman'}`);
      await axios.post(
        `https://rupload.facebook.com/video-upload/${config.facebook.apiVersion}/${videoId}`,
        fileStream,
        {
          headers: {
            Authorization: `OAuth ${token}`,
            'Content-Type': 'application/octet-stream',
            file_offset: 0,
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          params: { file_size: fileSize, upload_phase: 'transfer' },
          maxNetworkBufferSize: 256 * 1024,
          timeout: 0,
        }
      );
      console.log(`[Facebook:${account.name}] Binary terupload, finishing...`);
      hooks.progress?.(80, `Facebook: memproses publish`);

      // 3. FINISH + PUBLISH
      const finishRes = await axios.post(`${fbBase()}/${pageId}/video_reels`, null, {
        params: {
          upload_phase: 'finish',
          video_id: videoId,
          video_state: 'PUBLISHED',
          description: desc,
          access_token: token,
        },
      });

      console.log(`[Facebook:${account.name}] Reels sukses:`, JSON.stringify(finishRes.data));
      hooks.progress?.(100, `Facebook selesai: ${account.name}`);
      hooks.status?.('success', `Facebook berhasil: https://www.facebook.com/reel/${finishRes.data?.video_id || videoId}`);
      return { videoId, response: finishRes.data, url: `https://www.facebook.com/reel/${finishRes.data?.video_id || videoId}`, account: account.name };

    } catch (err) {
      const isRetryable = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' ||
        err.code === 'socketHangUp' || err.code === 'PROTOCOL_CONNECTION_LOST' ||
        (err.message && /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|getaddrinfo|connection reset|handshake failed|request timeout/i.test(err.message));
      if (attempt === maxRetries) throw err;
      const waitMs = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`[Facebook:${account.name}] Gagal attempt ${attempt}/${maxRetries} — ${err.code || err.message?.slice(0, 100)}, retry dalam ${waitMs}ms…`);
      hooks.status?.('uploading', `Facebook retry ${attempt + 1}/${maxRetries} dalam ${waitMs / 1000}s…`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

/**
 * Upload video biasa ke Page (/videos) — fallback jika Reels API tidak tersedia.
 */
async function uploadVideoBiasa(videoPath, meta = {}, account, hooks = {}) {
  const pageId = account.pageId;
  const token = account.token;
  if (!pageId || !token) throw new Error(`Facebook credential akun "${account.name || '?'}" belum lengkap.`);
  const desc = buildFbCaption(meta);

  console.log(`[Facebook:${account.name}] Upload /videos: ${path.basename(videoPath)}`);
  hooks.progress?.(20, `Facebook: menyiapkan upload video biasa`);
  const fileSize = fs.statSync(videoPath).size;
  const fileStream = fs.createReadStream(videoPath);
  let uploadedBytes = 0;
  fileStream.on('data', chunk => { uploadedBytes += chunk.length; hooks.progress?.(20 + Math.round(uploadedBytes / fileSize * 70), `Facebook: uploading ${account.name}…`); });
  const form = new FormData();
  form.append('file', fileStream);
  form.append('description', desc);
  form.append('access_token', token);

  hooks.progress?.(30, `Facebook: mengunggah ${account.name || 'halaman'}`);
  const res = await axios.post(`${fbBase()}/${pageId}/videos`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  console.log(`[Facebook:${account.name}] Sukses:`, JSON.stringify(res.data));
  hooks.progress?.(100, `Facebook selesai: ${account.name}`);
  hooks.status?.('success', `Facebook berhasil: https://www.facebook.com/watch/?v=${res.data.id}`);
  return { videoId: res.data.id, response: res.data, url: `https://www.facebook.com/watch/?v=${res.data.id}`, account: account.name };
}

async function uploadToFacebook(videoPath, meta = {}, account = {}, hooks = {}) {
  hooks.status?.('uploading', `Upload Facebook dimulai: ${account.name || 'halaman'}`);
  // fbUseReels per-upload (seperti pilihan Reels/Video di komposer FB), fallback ke default
  const wantReels = meta.fbUseReels !== undefined ? !!meta.fbUseReels : config.facebook.useReels;
  console.log(`[Facebook:${account.name}] Mode: ${wantReels ? 'Reels' : 'Video biasa'} | Caption: ${(buildFbCaption(meta)).slice(0, 80)}...`);
  if (wantReels) {
    try {
      return await uploadReels(videoPath, meta, account, hooks);
    } catch (err) {
      const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.warn(`[Facebook:${account.name}] Reels gagal (${msg}), fallback ke /videos...`);
return await uploadVideoBiasa(videoPath, meta, account, hooks);
    }
  }
  return await uploadVideoBiasa(videoPath, meta, account);
}

module.exports = { uploadToFacebook };
