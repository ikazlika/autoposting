const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');

const IS_WIN = process.platform === 'win32';
const DEFAULT_FFMPEG = process.env.FFMPEG_PATH || (IS_WIN ? 'D:/PROGRAM LAPTOP/projek node/snip yt/bin/ffmpeg.exe' : 'ffmpeg');
const DEFAULT_FFPROBE = process.env.FFPROBE_PATH || (IS_WIN ? 'D:/PROGRAM LAPTOP/projek node/snip yt/bin/ffprobe.exe' : 'ffprobe');
const DEFAULT_FONT_BOLD = process.env.FONT_BOLD || (IS_WIN ? 'C:/Windows/Fonts/arialbd.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf');
const DEFAULT_FONT_REG = process.env.FONT_REG || (IS_WIN ? 'C:/Windows/Fonts/arial.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');

// Batas thread ffmpeg. Di container/sandbox, ffmpeg bisa gagal ("Resource temporarily
// unavailable") kalau membuat terlalu banyak thread. Default 1, bisa diatur via env.
const FFMPEG_THREADS = Math.max(1, Number(process.env.FFMPEG_THREADS) || 1);

// Cari binary di PATH (biar 'ffmpeg' tetap ketemu di Linux), atau path absolut apa adanya.
function resolveBin(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return null;
  if (s.includes('/') || s.includes('\\')) return fs.existsSync(s) ? s : null;
  const exts = IS_WIN ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const cand = path.join(dir, s + ext);
      try { if (fs.existsSync(cand)) return cand; } catch {}
    }
  }
  return null;
}

function resolveFont(p, fallback) {
  if (p && fs.existsSync(p)) return p;
  if (fallback && fs.existsSync(fallback)) return fallback;
  return p;
}

const OUTPUT_DIR = path.resolve(process.env.COMPILE_OUTPUT_DIR || path.join(__dirname, '..', 'output'));
const MEMORY_FILE = path.join(OUTPUT_DIR, '.compile-memory.json');

function loadMemory() {
  try {
    const j = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    return { used: Array.isArray(j.used) ? j.used : [], runs: Array.isArray(j.runs) ? j.runs : [] };
  } catch { return { used: [], runs: [] }; }
}
function saveMemory(mem) {
  try { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2)); } catch {}
}
function resetMemory() {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify({ used: [], runs: [] }, null, 2)); } catch {}
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function run(bin, args, onStderr, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    if (opts.onSpawn) { try { opts.onSpawn(p); } catch {} }
    let out = '', err = '';
    // Error handler di stream wajib ada: tanpa ini, EPIPE saat ffmpeg
    // dimatikan (cancel/OOM) bisa jadi uncaught exception yang mematikan server.
    p.stdout.on('error', () => {});
    p.stderr.on('error', () => {});
    p.stdout.on('data', d => { out += d; if (out.length > 200000) out = out.slice(-100000); });
    p.stderr.on('data', d => {
      err += d;
      if (err.length > 200000) err = err.slice(-100000);
      if (onStderr) { try { onStderr(String(d)); } catch {} }
    });
    p.on('error', reject);
    p.on('close', code => resolve({ code, out, err }));
  });
}

/** Download file Drive publik ke disk (pakai usercontent endpoint). */
async function downloadPublic(fileId, dest, onChunk) {
  const url = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ws = fs.createWriteStream(dest);
  let downloaded = 0;
  const total = parseInt(res.headers.get('content-length') || '0');
  for await (const chunk of res.body) {
    downloaded += chunk.length;
    if (onChunk) onChunk(downloaded, total);
    if (!ws.write(chunk)) await new Promise(r => ws.once('drain', r));
  }
  ws.end();
  await new Promise((resolve, reject) => { ws.on('finish', resolve); ws.on('error', reject); });
  if (downloaded < 4096) throw new Error('file terlalu kecil');
  return dest;
}

/**
 * Ambil 1 video ke `dest` dari sumber mana pun.
 * v.src === 'local' -> salin dari v.path (file di videos/)
 * selain itu        -> unduh dari Google Drive publik (v.id)
 */
async function fetchVideo(v, dest, onChunk) {
  if (v && v.src === 'local' && v.path) {
    if (!fs.existsSync(v.path)) throw new Error('file lokal tidak ada: ' + v.path);
    if (onChunk) {
      const total = fs.statSync(v.path).size;
      let done = 0;
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(v.path);
        const ws = fs.createWriteStream(dest);
        rs.on('data', c => { done += c.length; onChunk(done, total); });
        rs.on('error', reject); ws.on('error', reject); ws.on('finish', resolve);
        rs.pipe(ws);
      });
    } else {
      fs.copyFileSync(v.path, dest);
    }
    if (fs.statSync(dest).size < 4096) throw new Error('file terlalu kecil');
    return dest;
  }
  return downloadPublic(v.id, dest, onChunk);
}

const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v|avi|flv|3gp|ts|ogv|mpg|mpeg|wmv|mk3d|m2ts)$/i;

async function probeMedia(ffprobe, file) {
  const r = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) throw new Error('ffprobe gagal: ' + r.err.slice(0, 300));
  const j = JSON.parse(r.out);
  const v = j.streams.find(s => s.codec_type === 'video');
  if (!v) throw new Error('File tidak memiliki stream video');
  return {
    duration: Number(j.format.duration || 0),
    hasAudio: j.streams.some(s => s.codec_type === 'audio'),
    width: v.width,
    height: v.height,
    fps: v.r_frame_rate,
  };
}

function escText(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\').replace(/:/g, '\\:')
    .replace(/'/g, "\\'").replace(/%/g, '\\%');
}
function escCommas(s) { return String(s).replace(/,/g, '\\,'); }
function escFont(p) { return p.replace(/\\/g, '/').replace(/:/g, '\\\\:'); }

const MEDAL = { 1: '0xFFC93C', 2: '0xD7DDE5', 3: '0xE0915C' };
const EXTRA_COLORS = ['0x7FB3FF', '0x9C8CFF', '0x6FE0C8', '0xFF9EC4', '0xB5E06F', '0xFFB37A'];
function medalColor(rank) {
  if (MEDAL[rank]) return MEDAL[rank];
  return EXTRA_COLORS[(rank - 4) % EXTRA_COLORS.length];
}
const MEDAL_GOLD_TEXT = '0x10151F';

function buildWatermark(watermark, { FONT }) {
  const text = String(watermark.text || '').trim();
  if (!text) return null;
  const size = Math.max(12, Math.min(160, Number(watermark.size) || 40));
  let color = String(watermark.color || '0xFFFFFF').trim();
  if (!/^0x[0-9A-Fa-f]{6}$/.test(color)) color = '0xFFFFFF';
  const opacity = Math.max(0.05, Math.min(1, Number(watermark.opacity) || 0.7));
  const pos = String(watermark.position || 'br');
  const pad = 40;
  const posMap = {
    tl: `x=${pad}:y=${pad}`,
    tr: `x=w-text_w-${pad}:y=${pad}`,
    bl: `x=${pad}:y=h-text_h-${pad - 30}`,
    br: `x=w-text_w-${pad}:y=h-text_h-${pad - 30}`,
    tc: `x=(w-text_w)/2:y=${pad}`,
    bc: `x=(w-text_w)/2:y=h-text_h-${pad - 30}`,
    cc: `x=(w-text_w)/2:y=(h-text_h)/2`,
  };
  const xy = posMap[pos] || posMap.br;
  return `drawtext=fontfile=${FONT}:text='${escText(text)}':fontcolor=${color}@${opacity}:fontsize=${size}:${xy}`;
}

/**
 * Bangun filter_complex kompilasi "JUARA n ... JUARA 1" portrait 1080x1920.
 * Input index 0 = JUARA 1 (terakhir tampil).
 */
function buildFilter(opts) {
  const {
    metas, duration, title = 'TOP VIDEO', subtitle = 'KOMPILASI PILIHAN',
    labels = [], footer = '',
    cardDur = 2.2, cuts = null, watermark = null, height = 1920,
  } = opts;

  const H = Math.max(360, Math.round(Number(height) || 1920));
  const W = Math.round((H * 9) / 16 / 2) * 2;
  const K = H / 1920;
  const S = v => Math.max(1, Math.round(v * K));
  const FONT = escFont(opts.fontBold), FONT_R = escFont(opts.fontReg);
  const f = [];
  const X = escCommas;
  const D = duration;

  const n = metas.length;
  const order = Array.from({ length: n }, (_, i) => n - 1 - i);
  const introDur = 2.4;

  const bodies = order.map(inputIdx =>
    cuts && cuts[inputIdx] != null ? cuts[inputIdx] : Math.max(0.5, (D - n * cardDur) / n)
  );
  let acc = 0;
  const segs = order.map((inputIdx, seg) => {
    const start = acc;
    const cardEnd = start + cardDur;
    const end = cardEnd + bodies[seg];
    acc = end;
    return { inputIdx, rank: n - seg, start, cardEnd, end, body: bodies[seg] };
  });
  const totalDur = acc + introDur;

  // ---- badan video full-screen ----
  segs.forEach((s, seg) => {
    const inp = s.inputIdx;
    const body = s.body.toFixed(3);
    f.push(`color=c=0x0B1020:s=${W}x${H}:d=${body}:r=30[bgc${seg}]`);
    // Render penuh: jangan trim video. Setiap input diputar sampai EOF.
    // Draft saja yang sudah dipotong di `cuts` sebelum filter dibangun.
    const videoChain = cuts && cuts[s.inputIdx] != null && cuts[s.inputIdx] < (metas[s.inputIdx]?.duration || Infinity)
      ? `fps=30,scale=-2:${H},setsar=1,trim=duration=${body},setpts=PTS-STARTPTS`
      : `fps=30,scale=-2:${H},setsar=1,setpts=PTS-STARTPTS`;
    f.push(`[${inp}:v]${videoChain}[fg${seg}]`);
    const aExpr = `min(1${X(',')}max(0,(t-0.2)/0.4))`;
    const ov = [];
    ov.push(`drawbox=x=0:y=0:w=${W}:h=${S(210)}:color=0x000000@0.45:t=fill`);
    ov.push(`drawtext=fontfile=${FONT}:text='${escText(title)}':fontcolor=white:fontsize=${S(56)}:x=(w-text_w)/2:y=${S(54)}:alpha='${aExpr}'`);
    ov.push(`drawtext=fontfile=${FONT_R}:text='${escText(subtitle)}':fontcolor=0xFFC93C:fontsize=${S(32)}:x=(w-text_w)/2:y=${S(132)}:alpha='${aExpr}'`);
    f.push(`[bgc${seg}][fg${seg}]overlay=(W-w)/2:0,${ov.join(',')},setpts=PTS-STARTPTS[body${seg}]`);
  });

  // ---- kartu peringkat + badan ----
  segs.forEach((s, seg) => {
    const col = medalColor(s.rank);
    const cardParts = [];
    cardParts.push(`drawbox=x=0:y=0:w=${W}:h=${H}:color=0x0B1020:t=fill`);
    cardParts.push(`drawbox=x=(iw-${S(360)})/2:y=${S(760)}:w=${S(360)}:h=${S(360)}:color=${col}:t=fill`);
    cardParts.push(`drawtext=fontfile=${FONT}:text='${s.rank}':fontcolor=${MEDAL_GOLD_TEXT}:fontsize=${S(220)}:x=(w-text_w)/2:y=${S(830)}:alpha='min(1${X(',')}max(0,t/0.35))'`);
    cardParts.push(`drawtext=fontfile=${FONT}:text='${escText('JUARA ' + s.rank)}':fontcolor=white:fontsize=${S(80)}:x=(w-text_w)/2:y=${S(1180)}:alpha='min(1${X(',')}max(0,(t-0.15)/0.4))'`);
    cardParts.push(`drawtext=fontfile=${FONT_R}:text='${escText(String(labels[seg] || '').slice(0, 26))}':fontcolor=0x8FA0B5:fontsize=${S(34)}:x=(w-text_w)/2:y=${S(1300)}:alpha='min(1${X(',')}max(0,(t-0.3)/0.4))'`);
    const cardChain = cardParts.join(',');
    f.push(`color=c=0x0B1020:s=${W}x${H}:d=${cardDur}:r=30,${cardChain},setpts=PTS-STARTPTS[card${seg}]`);
    f.push(`[card${seg}][body${seg}]concat=n=2:v=1:a=0[seg${seg}]`);
  });

  // ---- intro judul ----
  const introParts = [];
  introParts.push(`drawbox=x=0:y=0:w=${W}:h=${H}:color=0x0B1020:t=fill`);
  introParts.push(`drawtext=fontfile=${FONT}:text='${escText(title)}':fontcolor=white:fontsize=${S(78)}:x=(w-text_w)/2:y=(h-text_h)/2-${S(70)}:alpha='min(1${X(',')}max(0,min(t${X(',')}${introDur}-t)/0.4))'`);
  introParts.push(`drawtext=fontfile=${FONT_R}:text='${escText(subtitle)}':fontcolor=0xFFC93C:fontsize=${S(36)}:x=(w-text_w)/2:y=(h-text_h)/2+${S(50)}:alpha='min(1${X(',')}max(0,min(t${X(',')}${introDur}-t)/0.4))'`);
  introParts.push(`drawbox=x=(iw-${S(420)})/2:y=(ih/2)+${S(120)}:w=${S(420)}:h=${S(6)}:color=0xFFC93C:t=fill`);
  f.push(`color=c=0x0B1020:s=${W}x${H}:d=${introDur}:r=30,${introParts.join(',')},setpts=PTS-STARTPTS[intro]`);

  const seqLabels = ['[intro]', ...segs.map((s, seg) => `[seg${seg}]`)];
  f.push(`${seqLabels.join('')}concat=n=${seqLabels.length}:v=1:a=0[seqv]`);

  // ---- footer + watermark ----
  const deco = [];
  if (footer && String(footer).trim()) {
    deco.push(`drawtext=fontfile=${FONT_R}:text='${escText(footer)}':fontcolor=0x8FA0B5:fontsize=${S(22)}:x=(w-text_w)/2:y=${S(1848)}`);
  }
  if (watermark && watermark.text) {
    const wm = buildWatermark({ ...watermark, size: S(Number(watermark.size) || 44) }, { FONT });
    if (wm) deco.push(wm);
  }
  f.push(deco.length ? `[seqv]${deco.join(',')}[vout]` : `[seqv]null[vout]`);

  // ---- audio ----
  const audioChains = [];
  const audioLabels = [];
  audioChains.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${introDur},asetpts=PTS-STARTPTS[aintro]`);
  audioLabels.push('[aintro]');
  segs.forEach(s => {
    const meta = metas[s.inputIdx];
    if (meta && meta.hasAudio) {
      audioChains.push(`[${s.inputIdx}:a]atrim=duration=${s.body.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,adelay=${Math.round(cardDur * 1000)}:all=1[aseg${s.inputIdx}]`);
      audioLabels.push(`[aseg${s.inputIdx}]`);
    } else {
      const sil = cardDur + s.body;
      audioChains.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${sil.toFixed(3)},asetpts=PTS-STARTPTS[aseg${s.inputIdx}]`);
      audioLabels.push(`[aseg${s.inputIdx}]`);
    }
  });
  if (audioLabels.length) {
    f.push(audioChains.join(';'));
    f.push(`${audioLabels.join('')}concat=n=${audioLabels.length}:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=duration=${totalDur.toFixed(3)}[aout]`);
  }
  return { filter: f.join(';'), hasAudio: audioLabels.length > 0, W, H, totalDur };
}

let _encCache = null;
async function testEncoder(ffmpeg, enc) {
  const tmp = path.join(os.tmpdir(), `ap_enc_${process.pid}.mp4`);
  const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=256x144:rate=10', '-t', '0.3', '-c:v', enc, tmp]);
  try { fs.rmSync(tmp, { force: true }); } catch {}
  return r.code === 0;
}
async function resolveEncoder(ffmpeg, requested, onLog) {
  const req = String(requested || 'auto').toLowerCase();
  const map = { cpu: 'libx264', amf: 'h264_amf', nvenc: 'h264_nvenc', qsv: 'h264_qsv' };
  if (map[req]) {
    if (map[req] === 'libx264') return 'libx264';
    if (await testEncoder(ffmpeg, map[req])) return map[req];
    onLog && onLog(`Encoder ${map[req]} tidak tersedia — memakai CPU.`);
    return 'libx264';
  }
  if (_encCache) return _encCache;
  for (const c of ['h264_amf', 'h264_nvenc', 'h264_qsv']) {
    if (await testEncoder(ffmpeg, c)) {
      _encCache = c;
      onLog && onLog(`Encoder GPU terdeteksi: ${encName(c)}`);
      return c;
    }
  }
  _encCache = 'libx264';
  return 'libx264';
}
function encName(enc) {
  return { h264_amf: 'GPU AMD', h264_nvenc: 'GPU NVIDIA', h264_qsv: 'GPU Intel', libx264: 'CPU' }[enc] || enc;
}
function videoCodecArgs(enc, crf, preset) {
  const q = Math.max(0, Math.min(51, Number(crf) || 18));
  if (enc === 'h264_amf') return ['-c:v', 'h264_amf', '-quality', 'balanced', '-usage', 'transcoding', '-bf', '0', '-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(Math.min(51, q + 2)), '-qp_b', String(Math.min(51, q + 4))];
  if (enc === 'h264_nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(q), '-b:v', '0', '-bf', '0'];
  if (enc === 'h264_qsv') return ['-c:v', 'h264_qsv', '-global_quality', String(q), '-bf', '0'];
  return ['-c:v', 'libx264', '-preset', preset || 'veryfast', '-crf', String(q), '-threads', String(FFMPEG_THREADS)];
}

/**
 * Jalankan kompilasi.
 * videos: [{id, name}] — file Google Drive publik.
 */
async function compile(opts) {
  const {
    videos, outDir = OUTPUT_DIR,
    ffmpeg: ffmpegOpt = DEFAULT_FFMPEG, ffprobe: ffprobeOpt = DEFAULT_FFPROBE,
    fontBold: fontBoldOpt = DEFAULT_FONT_BOLD, fontReg: fontRegOpt = DEFAULT_FONT_REG,
    title = 'TOP VIDEO', subtitle = 'KOMPILASI PILIHAN',
    mode = 'duration', count = 0, targetDuration = 60,
    minCount = 2, crf = 22, preset = 'veryfast',
    useMemory = true, watermark = null, encoder = 'auto', height = 1920,
    previewOnly = false, draft = false, draftSec = 4,
    filterKeyword = '',
    exclude = [],
    onProc = null, onLog = () => {}, onProgress = () => {},
  } = opts;

  const ffmpeg = resolveBin(ffmpegOpt);
  const ffprobe = resolveBin(ffprobeOpt);
  if (!ffmpeg) throw new Error('ffmpeg tidak ditemukan: ' + ffmpegOpt);
  if (!ffprobe) throw new Error('ffprobe tidak ditemukan: ' + ffprobeOpt);
  const fontBold = resolveFont(fontBoldOpt, DEFAULT_FONT_BOLD);
  const fontReg = resolveFont(fontRegOpt, DEFAULT_FONT_REG);
  if (!videos.length) throw new Error('Tidak ada video untuk dikompilasi');

  const cardDur = 2.2;
  const introDur = 2.4;

  const countMode = mode === 'count' && Number(count) >= 1;
  let effMin = minCount, effMax = Infinity;
  if (countMode) {
    const c = Math.max(1, Math.floor(Number(count)));
    effMin = c; effMax = c;
  }
  const effectiveTarget = countMode ? Infinity : targetDuration;

  const mem = loadMemory();
  const usedSet = new Set(mem.used);
  // Kunci memory: Drive pakai id file, lokal pakai "local:<nama>".
  const memKey = v => v.src === 'local' ? ('local:' + v.name) : v.id;
  const excludeArr = (Array.isArray(exclude) ? exclude : []).map(e => String(e || '').toLowerCase()).filter(Boolean);
  let pool = videos.filter(v => (!excludeArr.some(e => (v.name || '').toLowerCase().includes(e))) && (!useMemory || !usedSet.has(memKey(v))));
  let didReset = false;
  if (pool.length < effMin) {
    onLog('Stok video baru habis — mengosongkan memory agar bisa dipakai ulang.');
    resetMemory();
    pool = [...videos];
    didReset = true;
  }

  const TAIL_TOLERANCE = Math.max(cardDur + 2, targetDuration * 0.15);
  const shuffled = shuffle(pool);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-compile-'));
  const files = [];
  try {
    const projectedWith = (n, sumDur) => sumDur + cardDur * n + introDur;

    for (let i = 0; i < shuffled.length; i++) {
      if (files.length >= effMax) break;
      const v = shuffled[i];
      const dest = path.join(work, `in${i}.mp4`);
      onLog(`${v.src === 'local' ? 'Menyalin' : 'Mengunduh'} kandidat #${files.length + 1}: ${v.name}`);
      const totalFilesEst = Math.max(1, shuffled.length);
      const overallPct = Math.round(((files.length + 0) / totalFilesEst) * 100);
      onProgress({ phase: 'download', percent: overallPct, totalFiles: totalFilesEst, current: v.name, percentFile: 0, doneFiles: files.length });
      try {
        await fetchVideo(v, dest, (dl, total) => {
          const pf = total ? Math.round(dl / total * 100) : 0;
          const overall = Math.round(((files.length + pf / 100) / totalFilesEst) * 100);
          onProgress({ phase: 'download', percent: overall, totalFiles: totalFilesEst, current: v.name, percentFile: pf, doneFiles: files.length });
        });
      } catch {
        onLog(`  lewati (gagal unduh): ${v.name}`);
        continue;
      }
      let meta;
      try {
        meta = await probeMedia(ffprobe, dest);
      } catch {
        onLog(`  lewati (probe gagal): ${v.name}`);
        try { fs.rmSync(dest, { force: true }); } catch {}
        continue;
      }
      if (meta.duration < 0.5) {
        onLog(`  lewati (terlalu pendek): ${v.name}`);
        try { fs.rmSync(dest, { force: true }); } catch {}
        continue;
      }

      if (countMode) {
        files.push({ v, dest, meta });
        const sum0 = files.reduce((a, x) => a + x.meta.duration, 0);
        onLog(`  ambil #${files.length}: ${v.name} — ${meta.duration.toFixed(1)}s (total ${projectedWith(files.length, sum0).toFixed(1)}s)`);
        continue;
      }

      const sumBefore = files.reduce((a, x) => a + x.meta.duration, 0);
      const nIfAdded = files.length + 1;
      const projectedIfAdded = projectedWith(nIfAdded, sumBefore + meta.duration);
      const needNow = effectiveTarget - projectedWith(files.length, sumBefore);

      const overshootTooMuch = projectedIfAdded > effectiveTarget + TAIL_TOLERANCE;
      if (files.length >= effMin && overshootTooMuch) {
        // cari penutup terdekat dari kandidat berikutnya
        let best = { file: { v, dest, meta }, diff: Math.abs(meta.duration - needNow) };
        const maxProbe = Math.min(shuffled.length - i - 1, 8);
        for (let k = i + 1; k < i + 1 + maxProbe; k++) {
          if (best.diff <= Math.min(2, TAIL_TOLERANCE * 0.5)) break;
          const cand = shuffled[k];
          const cd = path.join(work, `tail${k}.mp4`);
          try {
            await fetchVideo(cand, cd);
            const cm = await probeMedia(ffprobe, cd);
            if (cm.duration < 0.5) throw new Error('pendek');
            const diff = Math.abs(cm.duration - needNow);
            if (diff < best.diff) {
              try { fs.rmSync(best.file.dest, { force: true }); } catch {}
              best = { file: { v: cand, dest: cd, meta: cm }, diff };
            } else {
              try { fs.rmSync(cd, { force: true }); } catch {}
            }
          } catch {
            try { fs.rmSync(cd, { force: true }); } catch {}
          }
        }
        files.push(best.file);
        const sum2 = files.reduce((a, x) => a + x.meta.duration, 0);
        onLog(`  penutup: ${best.file.v.name} — ${best.file.meta.duration.toFixed(1)}s (total ${projectedWith(files.length, sum2).toFixed(1)}s)`);
        break;
      }

      files.push({ v, dest, meta });
      const sum = files.reduce((a, x) => a + x.meta.duration, 0);
      const projected = projectedWith(files.length, sum);
      onLog(`  ambil #${files.length}: ${v.name} — ${meta.duration.toFixed(1)}s (total ${projected.toFixed(1)}s)`);

      if (files.length >= effMin && projected >= effectiveTarget) {
        onLog(`Target ~${targetDuration}s tercapai dengan ${files.length} video (full).`);
        break;
      }
    }

    if (files.length < effMin) throw new Error(`Hanya dapat ${files.length} video valid (butuh minimal ${effMin})`);

    const dSec = Math.max(1, Number(draftSec) || 4);
    const cuts = files.map(x => draft ? Math.min(x.meta.duration, dSec) : x.meta.duration);
    const D = cuts.reduce((a, b) => a + b, 0) + cardDur * files.length + introDur;
    const labels = files.map(x => x.v.name.replace(VIDEO_EXT, '').slice(0, 40));

    if (previewOnly) {
      const picks = files.map((x, i) => ({
        rank: files.length - i,
        name: x.v.name,
        id: x.v.id,
        duration: Number(x.meta.duration.toFixed(2)),
      }));
      onLog(`Preview: ${files.length} video, total ~${D.toFixed(1)}s (belum dirender).`);
      return { preview: true, picks, count: files.length, duration: Number(D.toFixed(2)), outName: null, outPath: null, renderMs: 0 };
    }

    const { filter, hasAudio, W, H, totalDur } = buildFilter({
      metas: files.map(x => x.meta), duration: D, title, subtitle, labels,
      cardDur, cuts, fontBold, fontReg, watermark, height,
    });

    const now = new Date();
    const p2 = n => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}-${p2(now.getHours())}-${p2(now.getMinutes())}-${p2(now.getSeconds())}`;
    const slug = String(title || 'kompilasi').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'kompilasi';
    const outName = `${draft ? 'preview' : 'top'}_${slug}-${stamp}.mp4`;
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, outName);

    const enc = await resolveEncoder(ffmpeg, encoder, onLog);
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error', '-stats',
      ...files.flatMap(x => ['-threads', String(FFMPEG_THREADS), '-i', x.dest]),
      '-filter_threads', String(FFMPEG_THREADS),
      '-filter_complex_threads', String(FFMPEG_THREADS),
      '-filter_complex', filter,
      '-map', '[vout]',
      ...(hasAudio ? ['-map', '[aout]'] : []),
      ...videoCodecArgs(enc, crf, preset),
      '-pix_fmt', 'yuv420p',
      ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']),
      '-movflags', '+faststart',
      '-t', totalDur.toFixed(3),
      outPath,
    ];

    onLog(`Merender dengan ${encName(enc)} (${W}x${H})...`);
    const t0 = Date.now();
    const onProg = chunk => {
      const m = chunk.match(/time=(\d+):(\d+):(\d+)(?:\.\d+)?/);
      if (m) {
        const doneSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        const pct = Math.max(0, Math.min(99, Math.round((doneSec / totalDur) * 100)));
        onProgress({ phase: 'render', percent: pct, doneSec, totalSec: totalDur, speed: null, message: `Render ${pct}% — ${m[1]}:${m[2]}:${m[3]}` });
        onLog(`  render ${pct}% — ${m[1]}:${m[2]}:${m[3]}`);
      }
      const speed = chunk.match(/speed=([0-9.]+)x/);
      if (speed) onProgress({ phase: 'render', speed: Number(speed[1]) });
    };
    let r = await run(ffmpeg, args, onProg, { onSpawn: onProc });
    if (r.code !== 0 && enc !== 'libx264') {
      onLog(`GPU gagal — fallback ke CPU (libx264).`);
      r = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-stats',
        ...files.flatMap(x => ['-threads', String(FFMPEG_THREADS), '-i', x.dest]),
        '-filter_threads', String(FFMPEG_THREADS),
        '-filter_complex_threads', String(FFMPEG_THREADS),
        '-filter_complex', filter,
        '-map', '[vout]',
        ...(hasAudio ? ['-map', '[aout]'] : []),
        ...videoCodecArgs('libx264', crf, preset),
        '-pix_fmt', 'yuv420p',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']),
        '-movflags', '+faststart',
        '-t', totalDur.toFixed(3),
        outPath], onProg, { onSpawn: onProc });
    }
    if (r.code !== 0) {
      try { fs.rmSync(outPath, { force: true }); } catch {}
      throw new Error('ffmpeg gagal: ' + r.err.slice(-600));
    }
    const ms = Date.now() - t0;

    if (useMemory && !draft) {
      const mem2 = didReset ? { used: [], runs: [] } : loadMemory();
      const usedSet2 = new Set(mem2.used);
      files.forEach(x => usedSet2.add(x.v.src === 'local' ? ('local:' + x.v.name) : x.v.id));
      mem2.used = [...usedSet2];
      mem2.runs.push({ at: new Date().toISOString(), out: outName, count: files.length, duration: Number(totalDur.toFixed(2)), ids: files.map(x => x.v.id) });
      if (mem2.runs.length > 200) mem2.runs = mem2.runs.slice(-200);
      saveMemory(mem2);
      onLog(`Memory: ${mem2.used.length}/${videos.length} video sudah pernah dipakai.`);
    }

    const ordered = [...files].reverse();
    const picks = ordered.map(x => x.v);
    return {
      outPath, outName, duration: totalDur, renderMs: ms, count: files.length,
      winner: picks[0],
      picks: picks.map((p, i) => ({ rank: i + 1, id: p.id, name: p.name })),
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function listOutputs() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  return fs.readdirSync(OUTPUT_DIR)
    .filter(f => /\.(mp4|mov|webm|mkv)$/i.test(f))
    .map(f => {
      const p = path.join(OUTPUT_DIR, f);
      const st = fs.statSync(p);
      return { file: f, draft: f.startsWith('preview_'), sizeMB: (st.size / 1024 / 1024).toFixed(2), mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

module.exports = {
  compile, buildFilter, probeMedia, loadMemory, saveMemory, resetMemory,
  listOutputs, OUTPUT_DIR, DEFAULT_FFMPEG, DEFAULT_FFPROBE,
};
