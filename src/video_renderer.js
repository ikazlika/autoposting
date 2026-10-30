const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const config = require('./config');

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const VIDEO_MIMES = [
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska',
  'video/mpeg', 'video/avi', 'video/x-msvideo',
];

const downloadProgress = {};

function getDriveClient(credentials) {
  const { clientId, clientSecret, refreshToken } = credentials;
  if (!clientId || !clientSecret || !refreshToken) throw new Error('Google Drive credentials belum lengkap');
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth: oauth2 });
}

async function listDriveVideos(credentials, folderId, pageToken) {
  const drive = getDriveClient(credentials);
  const mimeQuery = VIDEO_MIMES.map(m => `mimeType='${m}'`).join(' or ');
  let q = `(${mimeQuery}) and trashed=false`;
  if (folderId) q = `'${folderId}' in parents and (${mimeQuery}) and trashed=false`;

  const res = await drive.files.list({
    q,
    fields: 'nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime, thumbnailLink)',
    pageSize: 50,
    orderBy: 'modifiedTime desc',
    pageToken: pageToken || undefined,
  });
  return {
    files: (res.data.files || []).map(f => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      sizeMB: f.size ? (parseInt(f.size) / 1024 / 1024).toFixed(2) : '?',
      createdTime: f.createdTime,
      modifiedTime: f.modifiedTime,
      thumbnailLink: f.thumbnailLink || null,
    })),
    nextPageToken: res.data.nextPageToken || null,
  };
}

async function listDriveFolders(credentials, parentId) {
  const drive = getDriveClient(credentials);
  let q = "mimeType='application/vnd.google-apps.folder' and trashed=false";
  if (parentId) q = `'${parentId}' in parents and ${q}`;

  const res = await drive.files.list({
    q,
    fields: 'files(id, name)',
    pageSize: 100,
    orderBy: 'name',
  });
  return res.data.files || [];
}

async function downloadDriveVideo(credentials, fileId, destDir) {
  const drive = getDriveClient(credentials);

  const meta = await drive.files.get({ fileId, fields: 'id,name,size,mimeType' });
  const fileName = meta.data.name;
  const fileSize = parseInt(meta.data.size || '0');

  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (!config.supportedExt.includes(ext)) {
    const newName = path.parse(fileName).name + '.mp4';
    console.warn(`[GDrive] Ekstensi .${ext} tidak didukung, simpan sebagai ${newName}`);
  }

  let destPath = path.join(destDir || config.videosDir, fileName);
  let i = 1;
  while (fs.existsSync(destPath)) {
    destPath = path.join(destDir || config.videosDir, `${path.parse(fileName).name}_${i}${path.extname(fileName)}`);
    i++;
  }

  downloadProgress[fileId] = { fileName, fileSize, downloaded: 0, percent: 0, status: 'downloading', destPath };

  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    let downloaded = 0;

    res.data.on('data', (chunk) => {
      downloaded += chunk.length;
      const percent = fileSize ? Math.round((downloaded / fileSize) * 100) : 0;
      downloadProgress[fileId] = { ...downloadProgress[fileId], downloaded, percent, status: 'downloading' };
    });

    res.data.on('end', () => {
      downloadProgress[fileId] = { ...downloadProgress[fileId], downloaded, percent: 100, status: 'done' };
      resolve({ file: path.basename(destPath), path: destPath, sizeMB: (downloaded / 1024 / 1024).toFixed(2) });
    });

    res.data.on('error', (err) => {
      downloadProgress[fileId] = { ...downloadProgress[fileId], status: 'error', error: err.message };
      try { fs.unlinkSync(destPath); } catch {}
      reject(err);
    });

    res.data.pipe(ws);
  });
}

function getDownloadProgress(fileId) {
  return downloadProgress[fileId] || null;
}

function clearProgress(fileId) {
  delete downloadProgress[fileId];
}

function getDriveAuthUrl(clientId, clientSecret) {
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, 'urn:ietf:wg:oauth:2.0:oob');
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...DRIVE_SCOPES, 'https://www.googleapis.com/auth/youtube.upload'],
  });
}

async function exchangeDriveCode(clientId, clientSecret, code) {
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, 'urn:ietf:wg:oauth:2.0:oob');
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google tidak mengembalikan refresh_token. Hapus akses app di https://myaccount.google.com/permissions lalu auth ulang.');
  return { refreshToken: tokens.refresh_token, accessToken: tokens.access_token };
}

// === Akses folder Google Drive PUBLIK (tanpa OAuth) ===
function extractFolderId(linkOrId) {
  const s = String(linkOrId || '').trim();
  const m = s.match(/\/folders\/([\w-]{10,})/);
  return m ? m[1] : (/^[\w-]{10,}$/.test(s) ? s : null);
}

async function listPublicFolder(folderId) {
  const res = await fetch(`https://drive.google.com/embeddedfolderview?id=${folderId}#list`);
  if (!res.ok) throw new Error(`Gagal akses folder (HTTP ${res.status}). Pastikan folder dibagikan "Siapa saja dengan link".`);
  const html = await res.text();
  const blocks = html.split('flip-entry" id="entry-').slice(1);
  const files = blocks.map(b => ({
    id: (b.match(/^([\w-]{20,})/) || [])[1] || '',
    name: (b.match(/flip-entry-title">([^<]+)</) || [])[1] || 'tanpa-nama',
    sizeText: (b.match(/flip-entry-size">([^<]+)</) || [])[1] || '',
  })).filter(f => f.id);
  return files;
}

/** Download file publik via drive.usercontent.google.com (confirm=t) */
async function downloadPublicFile(fileId, fileName, destDir) {
  destDir = destDir || config.videosDir;
  fs.mkdirSync(destDir, { recursive: true });
  let destPath = path.join(destDir, fileName);
  let i = 1;
  while (fs.existsSync(destPath)) {
    destPath = path.join(destDir, `${path.parse(fileName).name}_${i}${path.extname(fileName) || '.mp4'}`);
    i++;
  }
  const url = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download gagal (HTTP ${res.status})`);
  const total = parseInt(res.headers.get('content-length') || '0');
  downloadProgress[fileId] = { fileName, fileSize: total, downloaded: 0, percent: 0, status: 'downloading', destPath };
  try {
    const ws = fs.createWriteStream(destPath);
    let downloaded = 0;
    for await (const chunk of res.body) {
      downloaded += chunk.length;
      downloadProgress[fileId] = { ...downloadProgress[fileId], downloaded, percent: total ? Math.round(downloaded / total * 100) : 0 };
      if (!ws.write(chunk)) await new Promise(r => ws.once('drain', r));
    }
    ws.end();
    await new Promise((resolve, reject) => { ws.on('finish', resolve); ws.on('error', reject); });
    downloadProgress[fileId] = { ...downloadProgress[fileId], percent: 100, status: 'done' };
    return { file: path.basename(destPath), path: destPath, sizeMB: (downloaded / 1024 / 1024).toFixed(2) };
  } catch (e) {
    downloadProgress[fileId] = { ...downloadProgress[fileId], status: 'error', error: e.message };
    try { fs.unlinkSync(destPath); } catch {}
    throw e;
  }
}

module.exports = {
  listDriveVideos,
  listDriveFolders,
  downloadDriveVideo,
  getDownloadProgress,
  clearProgress,
  getDriveAuthUrl,
  exchangeDriveCode,
  getDriveClient,
  extractFolderId,
  listPublicFolder,
  downloadPublicFile,
};
