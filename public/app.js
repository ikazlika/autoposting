const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const api = (path, opts = {}) => fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts }).then(async r => {
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = { raw: t } }
  if (!r.ok) throw new Error(j.error || t || r.statusText); return j;
});

function toast(msg, type = '') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ---------- navigasi sidebar ----------
$$('.sidenav button').forEach(b => b.onclick = () => {
  $$('.sidenav button').forEach(x => x.classList.remove('active'));
  $$('.tab-panel').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $('#tab-' + b.dataset.tab).classList.add('active');
});
$$('dialog [data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());

let currentMetaFile = null;
let lastVideos = [];
let lastAccounts = { youtube: [], facebook: [] };
let lastGroups = [];
const esc = s => String(s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
// Prefix subpath saat app dipasang di bawah path lain (mis. /youtube-studio/auto-posting).
// fetch('/api/...') sudah otomatis diberi prefix oleh shim di index.html.
const AP_BASE = window.__AP_BASE__ || '';
const FB_EXPLORER_URL = 'https://developers.facebook.com/tools/explorer/';
const fbTokenLink = text => `<a class="ext-link" href="${FB_EXPLORER_URL}" target="_blank" rel="noopener">${text} ↗</a>`;

// ---------- refresh ----------
async function refresh() {
  try {
    const s = await api('/api/status');
    lastVideos = s.videos;
    const _cfgS = $('#cfgSchedule'); if (_cfgS) _cfgS.textContent = s.schedule;
    const _cfgT = $('#cfgTz'); if (_cfgT) _cfgT.textContent = s.timezone;
    const _cfgA = $('#cfgAccounts'); if (_cfgA) _cfgA.textContent = `YT ${s.youtubeCount} • FB ${s.facebookCount} • ${s.groups?.length || 0} grup • ${s.strategy}`;
    const lb = $('#logBox');
    if (lb) { lb.textContent = (s.lastLog || []).join('\n'); lb.scrollTop = lb.scrollHeight; }
    const dot = $('#statusDot');
    dot.className = 'status ok'; dot.innerHTML = '<i></i><em>Terhubung</em>';

    // sync hidden compat (strategi manual selalu single-account)
    $('#strategySel').value = 'all';

    // pratinjau video + thumbnail yang akan diupload
    const pvSel = $('#previewSel');
    const prevPv = pendingPreviewFile || pvSel.value;
    pvSel.innerHTML = s.videos.map(v => `<option value="${esc(v.file)}">${esc(v.file)}${v.hasThumb ? ' 📷' : ''}</option>`).join('');
    if (s.videos.some(v => v.file === prevPv)) pvSel.value = prevPv;
    pendingPreviewFile = '';
    renderPreview();

    // Facebook nonaktif? sembunyikan semua pengaturan FB
    const fbOn = s.enableFacebook !== false;
    $('#mFbWrap').style.display = fbOn ? '' : 'none';
    $('#fbChannelCard').style.display = fbOn ? '' : 'none';

    // akun tujuan + grup multi upload
    // bila FB nonaktif, hanya channel YouTube yang bisa dipilih
    const acc = await api('/api/accounts');
    lastAccounts = acc;
    const gr = await api('/api/groups');
    lastGroups = gr.groups || [];
    const enabledGroups = lastGroups.filter(g => g.enabled !== false);
    const ytAll = acc.youtube.map(a => ({ ...a, platform: 'youtube', icon: '▶' }));
    const fbAll = fbOn ? acc.facebook.map(a => ({ ...a, platform: 'facebook', icon: 'ⓕ' })) : [];
    const allAccounts = [...ytAll, ...fbAll];
    const isActive = a => !!a && a.enabled !== false && !a.expired;
    const yt = ytAll.filter(isActive);
    const fb = fbAll.filter(isActive);
    const enabled = [...yt, ...fb];
    const activeCountOf = g => g.accounts.filter(m => isActive(allAccounts.find(a => a.platform === m.platform && a.name === m.name))).length;
    let sel = null;
    try { sel = localStorage.getItem('selAccount'); } catch {}
    if (!enabled.some(a => a.name === sel)) sel = enabled[0]?.name || '';
    const radio = (a) => {
      const off = a.enabled === false;
      const sub = a.platform === 'youtube' ? (a.privacyStatus === 'public' ? '🌍 Public' : a.privacyStatus === 'unlisted' ? '🔗 Unlisted' : '🔒 Private') : esc(a.pageId || '');
      return `<label class="acc-pick${off ? ' off' : ''}"><input type="radio" name="selAccount" value="${esc(a.name)}" data-platform="${a.platform}"${a.name === sel ? ' checked' : ''}${off ? ' disabled' : ''}><div class="meta"><b>${a.icon} ${esc(a.name)}</b><span>${off ? 'Nonaktif' : sub}</span></div></label>`;
    };
    $('#accountList').innerHTML = enabled.length
      ? `${yt.length ? '<div class="acc-group">YouTube</div>' + yt.map(radio).join('') : ''}`
        + `${fb.length ? '<div class="acc-group">Facebook</div>' + fb.map(radio).join('') : ''}`
      : (allAccounts.length
        ? '<div class="empty">Semua akun nonaktif.<br>Aktifkan atau perbarui token di tab <b>Channel</b>.</div>'
        : '<div class="empty">Belum ada akun.<br>Buka tab <b>Channel</b> → + Tambah 👆</div>');

    // pilih grup (default: grup pertama). "__manual__" = 1 akun, "__all__" = semua akun
    let savedGroup = null;
    try { savedGroup = localStorage.getItem('selGroup'); } catch {}
    let groupPick;
    if (savedGroup === '__manual__' || savedGroup === '__all__') groupPick = savedGroup;
    else if (savedGroup && enabledGroups.some(g => g.id === savedGroup)) groupPick = savedGroup;
    else groupPick = enabledGroups[0]?.id || '__manual__';
    $('#groupSel').innerHTML = [
      '<option value="__manual__">Manual (1 akun)</option>',
      ...enabledGroups.map(g => `<option value="${esc(g.id)}">👥 ${esc(g.name)} (${activeCountOf(g)}/${g.accounts.length} aktif)</option>`),
      '<option value="__all__">🌐 Semua akun</option>',
    ].join('');
    $('#groupSel').value = groupPick;
    $('#accountList').style.display = 'none';
    $('#groupHint').textContent = '';

    // ringkasan tujuan di sidebar kanan + status tombol
    const chosenGroup = enabledGroups.find(g => g.id === groupPick);
    const chosen = enabled.find(a => a.name === sel);
    if (chosenGroup) {
      const activeMembers = chosenGroup.accounts.filter(m => isActive(allAccounts.find(a => a.platform === m.platform && a.name === m.name)));
      const inactiveCount = chosenGroup.accounts.length - activeMembers.length;
      const members = activeMembers.map(m => `${m.platform === 'youtube' ? '▶' : 'ⓕ'} ${m.name}`).join(' + ');
      $('#targetIcon').textContent = '👥';
      $('#targetAccount').textContent = chosenGroup.name;
      $('#targetMeta').textContent = (members || 'Tidak ada akun aktif')
        + (inactiveCount ? ` • ⚠ ${inactiveCount} nonaktif` : '');
      const _bp1 = $('#btnPost'); if (_bp1) _bp1.disabled = !activeMembers.length;
    } else if (groupPick === '__all__') {
      $('#targetIcon').textContent = '🌐';
      $('#targetAccount').textContent = 'Semua akun';
      $('#targetMeta').textContent = `YouTube ${enabled.filter(a => a.platform === 'youtube').length} • Facebook ${enabled.filter(a => a.platform === 'facebook').length}`;
      const _bp2 = $('#btnPost'); if (_bp2) _bp2.disabled = !enabled.length;
    } else if (chosen) {
      $('#targetIcon').textContent = chosen.icon;
      $('#targetAccount').textContent = chosen.name;
      $('#targetMeta').textContent = chosen.platform === 'youtube'
        ? `YouTube • ${chosen.privacyStatus === 'public' ? 'Public' : chosen.privacyStatus === 'unlisted' ? 'Unlisted' : 'Private'}`
        : `Facebook • ${chosen.pageId || ''}`;
      const _bp3 = $('#btnPost'); if (_bp3) _bp3.disabled = false;
    } else {
      $('#targetIcon').textContent = '?';
      $('#targetAccount').textContent = 'Belum pilih akun';
      $('#targetMeta').textContent = 'Tambah akun di tab Channel';
      const _bp4 = $('#btnPost'); if (_bp4) _bp4.disabled = true;
    }
    $('#accountFilter').value = sel || '';

    // daftar grup di tab Channel
    $('#groupList').innerHTML = lastGroups.length ? lastGroups.map(g => {
      const activeN = activeCountOf(g);
      const members = g.accounts.map(m => {
        const ok = isActive(allAccounts.find(a => a.platform === m.platform && a.name === m.name));
        return `${ok ? '' : '⚠ '}${m.platform === 'youtube' ? '▶' : 'ⓕ'} ${esc(m.name)}`;
      }).join(' + ');
      const badgeCls = g.enabled === false ? 'off' : activeN < g.accounts.length ? 'warn' : 'on';
      const badgeText = g.enabled === false ? 'OFF' : `${activeN}/${g.accounts.length} AKTIF`;
      return `<div class="item"><div class="meta"><b>👥 ${esc(g.name)}</b><span>${members || 'Belum ada akun'}</span></div>
      <span class="badge ${badgeCls}">${badgeText}</span>
      <div class="acts">
        <button class="btn sm" onclick="editGroup('${esc(g.id)}')">Edit</button>
        <button class="btn sm" onclick="toggleGroup('${esc(g.id)}',${g.enabled === false})">${g.enabled === false ? 'On' : 'Off'}</button>
        <button class="btn sm danger" onclick="delGroup('${esc(g.id)}')">Hapus</button>
      </div></div>`;
    }).join('') : '<div class="empty">Belum ada grup.<br>Klik <b>+ Grup</b> untuk membuat grup multi upload.</div>';

    const pvBadge = p => p === 'public' ? '🌍 Public' : p === 'unlisted' ? '🔗 Unlisted' : '🔒 Private';
    $('#accYT').innerHTML = acc.youtube.length ? acc.youtube.map(a => `
      <div class="item"><div class="meta"><b>▶ ${esc(a.name)}</b><span>${a.expired ? '⚠ Token expired' : a.enabled === false ? 'Nonaktif' : 'Aktif'} • ${pvBadge(a.privacyStatus)}</span></div>
      <span class="badge ${a.expired || a.enabled === false ? 'off' : 'on'}">${a.expired ? 'EXPIRED' : a.enabled === false ? 'OFF' : 'ON'}</span>
      <div class="acts">
        <button class="btn sm${a.expired ? ' primary' : ''}" onclick="editYT('${esc(a.name)}')">${a.expired ? 'Perbarui' : 'Edit'}</button>
        <button class="btn sm" onclick="testYT('${esc(a.name)}')">Test</button>
        <button class="btn sm" onclick="toggleAcc('youtube','${esc(a.name)}',${a.enabled === false})">${a.enabled === false ? 'On' : 'Off'}</button>
        <button class="btn sm danger" onclick="delAcc('youtube','${esc(a.name)}')">Hapus</button>
      </div></div>`).join('')
      : '<div class="empty">Belum ada channel.<br>Klik <b>+ Tambah</b> 👆</div>';
    $('#accFB').innerHTML = acc.facebook.length ? acc.facebook.map(a => {
      const status = a.expired ? '⚠ Token expired' : a.enabled === false ? 'Nonaktif' : 'Aktif';
      const detail = [a.pageName, a.pageId].filter(Boolean).join(' • ') || 'tanpa Page ID';
      return `<div class="item"><div class="meta"><b>ⓕ ${esc(a.name)}</b><span>${status} • ${esc(detail)}</span></div>
      <span class="badge ${a.expired || a.enabled === false ? 'off' : 'on'}">${a.expired ? 'EXPIRED' : a.enabled === false ? 'OFF' : 'ON'}</span>
      <div class="acts">
        ${a.expired ? `<a class="link-btn" href="${FB_EXPLORER_URL}" target="_blank" rel="noopener">Perbarui token ↗</a>` : ''}
        <button class="btn sm" onclick="editFB('${esc(a.name)}')">Edit</button>
        <button class="btn sm" onclick="testFB('${esc(a.name)}')">Test</button>
        <button class="btn sm" onclick="toggleAcc('facebook','${esc(a.name)}',${a.enabled === false})">${a.enabled === false ? 'On' : 'Off'}</button>
        <button class="btn sm danger" onclick="delAcc('facebook','${esc(a.name)}')">Hapus</button>
      </div></div>`;
    }).join('')
      : '<div class="empty">Belum ada Page.<br>Klik <b>+ Tambah</b> 👆</div>';

  } catch (e) {
    const dot = $('#statusDot');
    dot.className = 'status err'; dot.innerHTML = '<i></i><em>Server mati? Jalankan BUKA-UI.bat</em>';
    if ($('#logBox')) $('#logBox').textContent += '\n[ERR] ' + e.message;
  }
}

// ---------- form detail global dihapus — judul/deskripsi/tags diatur per video
// via Edit + default Pengaturan. Fungsi ini dipertahankan agar aman dipanggil.
function getDetailMeta() { return {}; }
function saveDetail() {}
function loadDetail() {}
function updateCounters() {}
async function fillCategories() {
  try {
    const cats = await api('/api/categories');
    const opts = '<option value="">Ikut default</option>' + Object.entries(cats).map(([id, n]) => `<option value="${id}">${id} — ${n}</option>`).join('');
    for (const sel of ['#pdCategory', '#mCategory', '#setCategory']) {
      const el = $(sel); if (!el) continue;
      const prev = el.value;
      el.innerHTML = sel === '#setCategory' ? '<option value="">Ikut sebelumnya</option>' + Object.entries(cats).map(([id, n]) => `<option value="${id}">${id} — ${n}</option>`).join('') : opts;
      if (prev) el.value = prev;
    }
  } catch {}
}

// ---------- cache hashtag: tags yang pernah dipakai, klik untuk pakai lagi ----------
const TAG_KEY = 'tagCache';
function getTagCache() { try { return JSON.parse(localStorage.getItem(TAG_KEY) || '[]'); } catch { return []; } }
function cacheTags(tags) {
  let c = getTagCache();
  for (const t of (tags || [])) {
    const v = String(t).trim().replace(/^#+/, '');
    if (!v) continue;
    c = c.filter(x => x.toLowerCase() !== v.toLowerCase());
    c.unshift(v);
  }
  c = c.slice(0, 40);
  try { localStorage.setItem(TAG_KEY, JSON.stringify(c)); } catch {}
  renderTagChips();
}
function inputTags(input) { return input.value.split(',').map(s => s.trim().replace(/^#+/, '')).filter(Boolean); }
function renderTagChips() {
  for (const [boxId, inputId] of [['pdTagChips', 'pdTags'], ['mTagChips', 'mTags']]) {
    const box = $('#' + boxId), input = $('#' + inputId);
    if (!box || !input) continue;
    const cur = new Set(inputTags(input).map(s => s.toLowerCase()));
    const c = getTagCache();
    box.innerHTML = c.length
      ? c.map(t => `<button type="button" class="tagchip${cur.has(t.toLowerCase()) ? ' on' : ''}" data-tag="${t.replace(/"/g, '&quot;')}">#${esc(t)}</button>`).join('')
      : '<span class="muted">Tags yang dipakai akan tersimpan di sini — klik untuk pakai lagi.</span>';
  }
}
document.addEventListener('click', e => {
  const b = e.target.closest('.tagchip');
  if (!b) return;
  const input = $('#' + (b.closest('.tagchips').id === 'mTagChips' ? 'mTags' : 'pdTags'));
  if (!input) return;
  const tag = b.dataset.tag;
  let cur = inputTags(input);
  if (cur.map(s => s.toLowerCase()).includes(tag.toLowerCase())) cur = cur.filter(s => s.toLowerCase() !== tag.toLowerCase());
  else cur.push(tag);
  input.value = cur.join(', ');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  renderTagChips();
  if (input.id === 'pdTags') saveDetail();
});

// ---------- tujuan posting: grup multi upload atau 1 akun manual ----------
function selectedAccount() {
  const r = document.querySelector('input[name="selAccount"]:checked');
  if (!r || r.disabled) return null;
  return { name: r.value, platform: r.dataset.platform || 'all' };
}
function selectedGroup() {
  const v = $('#groupSel')?.value;
  if (!v || v === '__manual__') return null;
  if (v === '__all__') return { id: null, name: 'Semua akun', all: true };
  const g = lastGroups.find(x => x.id === v);
  return g ? { ...g, all: false } : null;
}
function currentTarget(file) {
  const g = selectedGroup();
  if (g) {
    $('#platformSel').value = 'all';
    $('#accountFilter').value = '';
    $('#strategySel').value = 'all';
    return { platform: 'all', account: null, group: g.all ? null : g.id, strategy: 'all', file, meta: getDetailMeta() };
  }
  const sel = selectedAccount();
  const platform = sel ? sel.platform : 'all';
  const account = sel?.name;
  $('#platformSel').value = platform;
  $('#accountFilter').value = account || '';
  $('#strategySel').value = 'all';
  return { platform, account, group: null, strategy: 'all', file, meta: getDetailMeta() };
}

async function doPost(file) {
  const g = selectedGroup();
  const t = currentTarget(file);
  const targetName = g ? g.name : t.account;
  if (!targetName) { toast('Pilih grup atau 1 akun tujuan dulu', 'err'); return; }
  if (t.meta?.tags?.length) cacheTags(t.meta.tags);
  if (!confirm(file ? `Posting ${file} ke ${targetName} sekarang?` : `Posting 1 video berikutnya ke ${targetName}?`)) return;
  const b = $('#btnPost');
  if (b) { b.disabled = true; b.textContent = '⏳ Memposting…'; }
  try {
    await api('/api/post', { method: 'POST', body: JSON.stringify(t) });
    toast('Posting dimulai — pantau di Log 👇', 'ok');
    setTimeout(refresh, 2500);
  } catch (e) { toast('Gagal: ' + e.message, 'err'); }
  finally {
    if (b) { b.disabled = false; b.textContent = '🚀 Posting'; }
  }
}
window.postFile = f => doPost(f);
if ($('#btnPost')) $('#btnPost').onclick = () => doPost();
$('#btnRefresh').onclick = () => { refresh(); toast('Data dimuat ulang'); };
if ($('#btnClearLog')) $('#btnClearLog').onclick = () => { const lb = $('#logBox'); if (lb) lb.textContent = ''; };
// simpan pilihan akun + update ringkasan langsung tanpa tunggu refresh
$('#accountList').addEventListener('change', e => {
  const r = e.target.closest('input[name="selAccount"]');
  if (!r || r.disabled) return;
  try { localStorage.setItem('selAccount', r.value); } catch {}
  try { localStorage.setItem('selGroup', '__manual__'); } catch {}
  $('#groupSel').value = '__manual__';
  $('#accountFilter').value = r.value;
  const label = r.closest('.acc-pick')?.querySelector('.meta span')?.textContent || '';
  $('#targetIcon').textContent = r.dataset.platform === 'youtube' ? '▶' : 'ⓕ';
  $('#targetAccount').textContent = r.value;
  $('#targetMeta').textContent = (r.dataset.platform === 'youtube' ? 'YouTube • ' : 'Facebook • ') + label;
  const _bp5 = $('#btnPost'); if (_bp5) _bp5.disabled = false;
});
$('#groupSel').addEventListener('change', () => {
  try { localStorage.setItem('selGroup', $('#groupSel').value); } catch {}
  refresh();
});

// ---------- pratinjau video + thumbnail ----------
function currentPreview() {
  const f = $('#previewSel')?.value;
  return lastVideos.find(x => x.file === f) || lastVideos[0] || null;
}
function renderPreview() {
  const v = currentPreview();
  const empty = !v;
  $('#previewEmpty').style.display = empty ? '' : 'none';
  $('#previewBody').style.display = empty ? 'none' : '';
  if (!v) return;
  const vid = $('#previewVideo');
  const src = AP_BASE + '/api/video-file?file=' + encodeURIComponent(v.file);
  if (vid.dataset.f !== v.file) { vid.dataset.f = v.file; vid.src = src; vid.load(); }
  $('#previewInfo').textContent = `${v.file} • ${v.sizeMB} MB`;
  const img = $('#previewThumb');
  img.onerror = () => { img.style.display = 'none'; $('#previewNoThumb').style.display = ''; };
  img.onload = () => { img.style.display = ''; $('#previewNoThumb').style.display = 'none'; };
  img.src = AP_BASE + '/api/thumb?file=' + encodeURIComponent(v.file) + '&t=' + Date.now();
  const tags = (v.tags || []).join(', ');
  $('#previewMeta').textContent = [v.title, tags ? 'Tags: ' + tags : '', v.hasThumb ? '📷 thumbnail terpasang' : ''].filter(Boolean).join(' • ');
  // input thumbnail sembunyi bila video ini sudah ada thumbnail
  $('#pvThumbWrap').style.display = v.hasThumb ? 'none' : '';
  $('#btnPvThumbDel').style.display = v.hasThumb ? '' : 'none';
}
$('#previewSel').onchange = renderPreview;
$('#btnPreviewEdit').onclick = () => { const v = currentPreview(); if (v) editMeta(v.file, v.title, v.description); };
$('#btnPvVideoDel').onclick = async () => {
  const v = currentPreview();
  if (!v) return toast('Belum ada video', 'err');
  if (!confirm('Hapus ' + v.file + '? (thumbnail & judulnya ikut terhapus)')) return;
  try {
    const res = await fetch('/api/videos/' + encodeURIComponent(v.file), { method: 'DELETE' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'Gagal hapus');
    const vid = $('#previewVideo');
    vid.removeAttribute('src'); vid.load(); vid.dataset.f = '';
    toast('Dihapus: ' + v.file, 'ok');
    refresh();
  } catch (e) { toast(e.message, 'err'); }
};
// input video sembunyi setelah sukses, muncul lagi via tombol
let hidePvVideo = false;
function updatePvVideoVisibility() {
  $('#pvVideoWrap').style.display = hidePvVideo ? 'none' : '';
  $('#btnPvVideoShow').style.display = hidePvVideo ? '' : 'none';
}
$('#btnPvVideoShow').onclick = () => { hidePvVideo = false; updatePvVideoVisibility(); $('#pvVideoFile').click(); };

// ---------- video: edit / hapus ----------
window.editMeta = async (file, title, desc) => {
  currentMetaFile = file;
  $('#metaTitle').textContent = 'Edit: ' + file;
  // prefill cepat, lalu lengkapi dari server (field penuh per-video)
  $('#mTitle').value = title || ''; $('#mDescription').value = desc || '';
  try {
    const m = await api('/api/videos/meta-get?file=' + encodeURIComponent(file));
    $('#mTitle').value = m.title || title || '';
    $('#mDescription').value = m.description || desc || '';
    $('#mTags').value = (m.tags || []).join(', ');
    if (m.categoryId) $('#mCategory').value = m.categoryId;
    const pv = m.privacyStatus || '';
    document.querySelectorAll('#dlgMeta input[name="privacyStatus"]').forEach(r => r.checked = r.value === pv || (!pv && r.value === ''));
    $('#mKids').checked = !!m.madeForKids;
    $('#mPublishAt').value = m.publishAt ? new Date(m.publishAt).toISOString().slice(0, 16) : '';
    $('#mFbCaption').value = m.fbCaption || '';
    const fbm = m.fbUseReels === true ? 'true' : m.fbUseReels === false ? 'false' : 'default';
    document.querySelectorAll('#dlgMeta input[name="fbUseReels"]').forEach(r => r.checked = r.value === fbm);
  } catch {}
  const upd = () => { $('#mTitleCount').textContent = `${$('#mTitle').value.length}/100`; };
  upd();
  renderTagChips();
  $('#dlgMeta').showModal();
};
window.deleteVideo = async file => {
  if (!confirm('Hapus ' + file + ' dari antrean?')) return;
  const res = await fetch('/api/videos/' + encodeURIComponent(file), { method: 'DELETE' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return toast(j.error || 'Gagal hapus', 'err');
  toast('Dihapus: ' + file, 'ok'); refresh();
};
$('#formMeta').onsubmit = async e => {
  e.preventDefault();
  const pub = $('#mPublishAt').value ? new Date($('#mPublishAt').value).toISOString() : undefined;
  const body = {
    file: currentMetaFile,
    title: $('#mTitle').value.trim(),
    description: $('#mDescription').value.trim(),
    tags: $('#mTags').value.split(',').map(s => s.trim()).filter(Boolean),
    categoryId: $('#mCategory').value || undefined,
    privacyStatus: document.querySelector('#dlgMeta input[name="privacyStatus"]:checked')?.value || undefined,
    madeForKids: $('#mKids').checked,
    publishAt: pub,
    fbCaption: $('#mFbCaption').value.trim() || undefined,
    fbUseReels: document.querySelector('#dlgMeta input[name="fbUseReels"]:checked')?.value || 'default',
  };
  await api('/api/videos/meta', { method: 'POST', body: JSON.stringify(body) });
  if (body.tags?.length) cacheTags(body.tags);
  $('#dlgMeta').close(); toast('Detail video tersimpan ✅', 'ok'); refresh();
};

let pendingPreviewFile = '';
// ---------- upload antrean ----------
async function uploadFileToQueue(file, opts = {}) {
  const fd = new FormData(); fd.append('video', file);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  const j = await res.json(); if (!res.ok) throw new Error(j.error || 'Upload gagal');
  if (opts.preview) pendingPreviewFile = j.file;
  toast('Masuk antrean: ' + j.file, 'ok'); refresh();
  return j.file;
}
const dz = $('#dropZone');
dz.ondragover = e => { e.preventDefault(); dz.classList.add('dragover'); };
dz.ondragleave = () => dz.classList.remove('dragover');
dz.ondrop = async e => { e.preventDefault(); dz.classList.remove('dragover'); const f = e.dataTransfer.files[0]; if (f) try { await uploadFileToQueue(f); } catch (err) { toast(err.message, 'err'); } };
$('#fileInput').onchange = async e => { const f = e.target.files[0]; if (f) try { await uploadFileToQueue(f); } catch (err) { toast(err.message, 'err'); } e.target.value = ''; };

// ---------- channel CRUD ----------
window.delAcc = async (platform, name) => {  if (!confirm(`Hapus ${platform}/${name}?`)) return;
  await api('/api/accounts/' + platform + '/' + encodeURIComponent(name), { method: 'DELETE' });
  toast('Dihapus', 'ok'); refresh();
};
window.toggleAcc = async (platform, name, enabled) => {
  await api('/api/accounts/' + platform + '/' + encodeURIComponent(name) + '/toggle', { method: 'POST', body: JSON.stringify({ enabled }) });
  refresh();
};

// ---------- periksa & perbarui token ----------
async function loadTokenStatus() {
  const box = $('#tokenStatus');
  if (!box) return;
  try {
    const [acc, fbSt] = await Promise.all([
      api('/api/accounts'),
      api('/api/facebook/token-status').catch(() => ({ status: [] })),
    ]);
    const fbMap = new Map((fbSt.status || []).map(s => [s.name, s]));
    const rows = [];
    (acc.youtube || []).forEach(a => rows.push({
      icon: '▶', name: a.name, platform: 'YouTube',
      ok: !a.expired && a.enabled !== false,
      state: a.expired ? 'Token expired — perlu diperbarui' : a.enabled === false ? 'Nonaktif' : 'Token valid',
    }));
    (acc.facebook || []).forEach(a => {
      const s = fbMap.get(a.name);
      const days = s && s.daysLeft !== null ? s.daysLeft : null;
      rows.push({
        icon: 'ⓕ', name: a.name, platform: 'Facebook',
        ok: !a.expired && a.enabled !== false,
        state: a.expired ? 'Token expired — perlu diperbarui'
          : days !== null && days < 7 ? `Sisa ${days} hari — akan diperpanjang otomatis`
          : a.enabled === false ? 'Nonaktif' : 'Token valid',
      });
    });
    box.innerHTML = rows.length ? rows.map(r => `
      <div class="item"><div class="meta"><b>${r.icon} ${esc(r.name)}</b><span>${esc(r.platform)} • ${esc(r.state)}</span></div>
      <span class="badge ${r.ok ? 'on' : 'off'}">${r.ok ? 'OK' : 'PERLU TINDAKAN'}</span></div>`).join('')
      : '<div class="empty">Belum ada akun.</div>';
  } catch (e) {
    box.innerHTML = '<div class="empty">⚠ ' + esc(e.message) + '</div>';
  }
}
$('#btnRefreshTokens')?.addEventListener('click', async () => {
  const btn = $('#btnRefreshTokens');
  btn.disabled = true; btn.textContent = 'Memeriksa…';
  try {
    const r = await api('/api/accounts/refresh-all', { method: 'POST', body: JSON.stringify({}) });
    const yt = r.youtube || [];
    const ytOk = yt.filter(x => x.ok).length;
    const fbOk = (r.facebook && r.facebook.sukses) || [];
    const ytBad = yt.filter(x => !x.ok);
    if (ytBad.length) {
      toast(`⚠ ${ytBad.length} channel YouTube token expired — klik "Perbarui" untuk perbaiki`, 'err');
    } else {
      toast(`✅ Semua token OK (YouTube ${ytOk}/${yt.length}${fbOk.length ? `, FB diperpanjang: ${fbOk.join(', ')}` : ''})`, 'ok');
    }
    loadTokenStatus();
    refresh();
  } catch (e) { toast('Gagal: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Periksa & perbarui'; }
});
loadTokenStatus();

// ---------- grup multi upload ----------
function groupAccountStatus(a) {
  if (a.expired) return { label: 'Token expired', cls: 'warn', active: false };
  if (a.enabled === false) return { label: 'Nonaktif', cls: 'off', active: false };
  if (a.platform === 'facebook' && !a.pageId) return { label: 'Page ID kosong', cls: 'warn', active: false };
  return { label: 'Aktif', cls: 'ok', active: true };
}

function updateGroupPicker() {
  const box = $('#groupAccounts');
  if (!box) return;
  const inputs = [...box.querySelectorAll('input.grp-acc')];
  const count = inputs.filter(i => i.checked).length;
  $('#groupCount').textContent = `${count} akun dipilih`;
  $('#groupSubmit').disabled = count === 0;
}

function openGroupDialog(group) {
  $('#groupOrigId').value = group?.id || '';
  $('#dlgGroupTitle').textContent = group ? 'Edit grup' : 'Tambah grup';
  $('#groupName').value = group?.name || '';
  $('#groupEnabled').checked = group ? group.enabled !== false : true;
  $('#groupMsg').textContent = '';
  $('#groupMsg').className = 'dlg-msg';
  const yt = (lastAccounts.youtube || []).map(a => ({ ...a, platform: 'youtube', icon: '▶' }));
  const fb = (lastAccounts.facebook || []).map(a => ({ ...a, platform: 'facebook', icon: 'ⓕ' }));
  const all = [...yt, ...fb];
  const row = a => {
    const st = groupAccountStatus(a);
    const checked = group?.accounts.some(x => x.platform === a.platform && x.name === a.name);
    const privacy = a.privacyStatus === 'public' ? 'Public' : a.privacyStatus === 'unlisted' ? 'Unlisted' : 'Private';
    const sub = a.platform === 'youtube'
      ? `YouTube • ${privacy}`
      : `Facebook${a.pageName ? ' • ' + esc(a.pageName) : a.pageId ? ' • ' + esc(a.pageId) : ' • Page ID belum diisi'}`;
    return `<label class="gp-item${st.active ? '' : ' is-off'}" data-active="${st.active ? '1' : '0'}">
      <input type="checkbox" class="grp-acc" data-platform="${a.platform}" value="${esc(a.name)}"${checked ? ' checked' : ''}>
      <span class="gp-ico ${a.platform}">${a.icon}</span>
      <span class="gp-meta"><b>${esc(a.name)}</b><small>${sub}</small></span>
      <span class="gp-badge ${st.cls}">${st.label}</span>
    </label>`;
  };
  const section = (title, list) => list.length
    ? `<div class="gp-section"><div class="gp-section-head"><span>${title}</span><span>${list.filter(a => groupAccountStatus(a).active).length}/${list.length} aktif</span></div>${list.map(row).join('')}</div>`
    : '';
  $('#groupAccounts').innerHTML = (section('YouTube', yt) + section('Facebook', fb))
    || '<div class="empty">Belum ada akun. Tambah channel dulu.</div>';
  const inactive = all.filter(a => !groupAccountStatus(a).active).length;
  const expiredFb = all.filter(a => a.platform === 'facebook' && a.expired).length;
  const hint = $('#groupAccHint');
  const hintText = !all.length
    ? 'Tambah akun YouTube atau Facebook terlebih dahulu.'
    : inactive
      ? `${inactive} akun tidak siap upload (nonaktif/token expired). Akun tetap bisa dipilih, tetapi akan dilewati saat posting.`
      : 'Semua akun siap dipakai.';
  hint.innerHTML = hintText + (expiredFb ? ' ' + fbTokenLink('Buat token FB baru') + '.' : '');
  hint.className = inactive ? 'gp-hint warn' : 'gp-hint';
  $('#dlgGroup').showModal();
  updateGroupPicker();
}
window.addGroup = () => openGroupDialog(null);
window.editGroup = async id => {
  try {
    const r = await api('/api/groups');
    lastGroups = r.groups || [];
    openGroupDialog(lastGroups.find(g => g.id === id));
  } catch (e) { toast(e.message, 'err'); }
};
window.delGroup = async id => {
  const g = lastGroups.find(x => x.id === id);
  if (!confirm(`Hapus grup "${g?.name || id}"?`)) return;
  try { await api('/api/groups/' + encodeURIComponent(id), { method: 'DELETE' }); toast('Grup dihapus', 'ok'); refresh(); }
  catch (e) { toast(e.message, 'err'); }
};
window.toggleGroup = async (id, enabled) => {
  try { await api('/api/groups/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ enabled }) }); refresh(); }
  catch (e) { toast(e.message, 'err'); }
};
$('#btnAddGroup').onclick = () => openGroupDialog(null);
$('#groupAccounts').addEventListener('change', updateGroupPicker);
$('#groupSelectActive').onclick = () => {
  document.querySelectorAll('#groupAccounts .gp-item[data-active="1"] input.grp-acc')
    .forEach(i => { i.checked = true; });
  updateGroupPicker();
};
$('#groupClear').onclick = () => {
  document.querySelectorAll('#groupAccounts input.grp-acc').forEach(i => { i.checked = false; });
  updateGroupPicker();
};
$('#formGroup').onsubmit = async e => {
  e.preventDefault();
  const id = $('#groupOrigId').value;
  const accounts = [...document.querySelectorAll('#groupAccounts input.grp-acc:checked')]
    .map(i => ({ platform: i.dataset.platform, name: i.value }));
  if (!accounts.length) return toast('Pilih minimal 1 akun untuk grup', 'err');
  const payload = { name: $('#groupName').value.trim(), enabled: $('#groupEnabled').checked, accounts };
  try {
    if (id) await api('/api/groups/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/groups', { method: 'POST', body: JSON.stringify({ group: payload }) });
    $('#dlgGroup').close();
    toast(id ? 'Grup diupdate ✅' : 'Grup dibuat ✅', 'ok');
    refresh();
  } catch (err) {
    $('#groupMsg').textContent = err.message;
    $('#groupMsg').className = 'dlg-msg err';
  }
};
window.testYT = async name => {
  toast('Mengetes ' + name + '…');
  try { await api('/api/youtube/test', { method: 'POST', body: JSON.stringify({ name }) }); toast('✅ Token valid: ' + name, 'ok'); }
  catch (e) { toast('❌ ' + name + ': ' + e.message, 'err'); alert('GAGAL: ' + e.message + '\n\nCek umum:\n• Client ID kepaste 2x → copy 1x saja\n• Secret kepotong (GOCSPX-… harus full)\n• Token masih kode 4/… → harus Tukar Kode dulu jadi 1//…'); }
};
window.testFB = async name => {
  toast('Mengetes ' + name + '…');
  try {
    const r = await api('/api/facebook/test', { method: 'POST', body: JSON.stringify({ name }) });
    toast(`✅ ${name} valid — Page: ${r.name || r.id}`, 'ok');
  } catch (e) {
    toast('❌ ' + name + ': ' + e.message, 'err');
  }
  refresh();
};
window.editYT = async name => {
  const accs = await api('/api/accounts');
  const a = accs.youtube.find(x => x.name === name);
  if (!a) return toast('Akun tidak ada', 'err');
  $('#editOrigName').value = a.name; $('#editName').value = a.name;
  $('#editClientId').value = a.clientId || ''; $('#editClientSecret').value = a.clientSecret || ''; $('#editRefresh').value = a.refreshToken || '';
  $('#editDefaultTitle').value = a.defaultTitle || '';
  $('#editDefaultDescription').value = a.defaultDescription || '';
  $('#editDefaultTags').value = Array.isArray(a.defaultTags) ? a.defaultTags.join(', ') : (a.defaultTags || '');
  $$( '#editPrivacyGroup input[name="privacyStatus"]').forEach(r => r.checked = r.value === (a.privacyStatus || 'private'));
  $('#editEnabled').checked = a.enabled !== false;
  $('#editMsg').textContent = ''; $('#editAuthHint').textContent = ''; $('#editTestHint').textContent = ''; $('#editYtCode').value = '';
  if (a.expired) {
    $('#editAuthHint').textContent = '⚠ Token akun ini sudah expired. Klik "🔑 Login Google ulang" untuk perbarui.';
    $('#editTestHint').textContent = '⚠ Token expired — perlu diperbarui.';
  }
  $('#dlgEditYT').showModal();
};
window.editFB = async name => {
  const accs = await api('/api/accounts');
  const a = accs.facebook.find(x => x.name === name);
  if (!a) return toast('Akun tidak ada', 'err');
  $('#editFBOrig').value = a.name; $('#editFBName').value = a.name;
  $('#editFBPageId').value = a.pageId || ''; $('#editFBToken').value = ''; $('#editFBEnabled').checked = a.enabled !== false;
  $('#editFBDefaultTitle').value = a.defaultTitle || '';
  $('#editFBDefaultDescription').value = a.defaultDescription || '';
  $('#editFBDefaultTags').value = Array.isArray(a.defaultTags) ? a.defaultTags.join(', ') : (a.defaultTags || '');
  $('#editFBTokenHelp').style.display = a.expired ? '' : 'none';
  $('#editFBMsg').textContent = ''; $('#dlgEditFB').showModal();
};
function openAddYT() { $('#ytMsg').textContent = ''; $('#authHint').textContent = ''; $('#testHint').textContent = ''; $('#dlgYTTitle').textContent = 'Tambah channel YouTube'; $('#dlgYT').showModal(); }
$('#btnAddYT').onclick = openAddYT;
$('#btnAddYT2').onclick = openAddYT;
$('#btnAddFB').onclick = () => $('#dlgFB').showModal();

// ---------- upload langsung di bagian preview (input sembunyi setelah sukses) ----------
$('#pvVideoFile').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    await uploadFileToQueue(f, { preview: true });
    hidePvVideo = true;
    updatePvVideoVisibility();
  }
  catch (err) { toast(err.message, 'err'); }
};
$('#pvThumbFile').onchange = async e => {
  const img = e.target.files[0];
  e.target.value = '';
  if (!img) return;
  const v = currentPreview();
  if (!v) return toast('Belum ada video untuk dipasangi thumbnail', 'err');
  const fd = new FormData();
  fd.append('image', img);
  fd.append('video', v.file);
  $('#pvMsg').textContent = 'Mengupload thumbnail…';
  try {
    const res = await fetch('/api/thumbnail', { method: 'POST', body: fd });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'Gagal');
    $('#pvMsg').textContent = 'Thumbnail terpasang: ' + j.file + ' ✅';
    toast('Thumbnail terpasang ✅', 'ok');
    refresh();
  } catch (err) { $('#pvMsg').textContent = 'Gagal: ' + err.message; toast(err.message, 'err'); }
};
$('#btnPvThumbDel').onclick = async () => {
  const v = currentPreview();
  if (!v) return toast('Belum ada video', 'err');
  try {
    const res = await fetch('/api/thumb', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: v.file }) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'Gagal');
    $('#pvMsg').textContent = 'Thumbnail dihapus.';
    toast('Thumbnail dihapus', 'ok');
    refresh();
  } catch (e) { toast(e.message, 'err'); }
};

// YouTube OAuth browser flow
$('#btnAuthUrl').onclick = async () => {
  const clientId = $('#ytClientId').value.trim(), clientSecret = $('#ytClientSecret').value.trim();
  if (!clientId || !clientSecret) return toast('Isi Client ID & Secret dulu', 'err');
  $('#authHint').textContent = 'Membuka Google…';
  try {
    const r = await api('/api/youtube/auth-url', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) });
    window.open(r.authUrl, '_blank');
    $('#authHint').textContent = 'Login di tab baru → Allow → copy Kode → paste di bawah.';
  } catch (e) { $('#authHint').textContent = 'Gagal: ' + e.message; }
};
$('#btnExchange').onclick = async () => {
  const clientId = $('#ytClientId').value.trim(), clientSecret = $('#ytClientSecret').value.trim(), code = $('#ytCode').value.trim();
  if (!code) return toast('Paste kode Google dulu', 'err');
  $('#ytMsg').textContent = 'Menukar kode…';
  try {
    const r = await api('/api/youtube/exchange', { method: 'POST', body: JSON.stringify({ clientId, clientSecret, code }) });
    $('#ytRefresh').value = r.refreshToken;
    $('#ytMsg').textContent = 'Berhasil! Token terisi — klik Simpan.';
    toast('Token didapat ✅', 'ok');
  } catch (e) { $('#ytMsg').textContent = 'Gagal: ' + e.message; toast(e.message, 'err'); }
};
$('#btnTestYT').onclick = async () => {
  const clientId = $('#ytClientId').value.trim(), clientSecret = $('#ytClientSecret').value.trim(), refreshToken = $('#ytRefresh').value.trim();
  if (!clientId || !clientSecret || !refreshToken) return toast('Lengkapi dulu', 'err');
  $('#testHint').textContent = 'Testing…';
  try { await api('/api/youtube/test', { method: 'POST', body: JSON.stringify({ clientId, clientSecret, refreshToken }) }); $('#testHint').textContent = '✅ Valid'; toast('Token valid ✅', 'ok'); }
  catch (e) { $('#testHint').textContent = '❌ ' + e.message; }
};
$('#formYT').onsubmit = async e => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target).entries());
  if (!d.refreshToken) return toast('Tukar kode dulu biar token terisi', 'err');
  try { await api('/api/accounts', { method: 'POST', body: JSON.stringify({ platform: 'youtube', account: d }) }); e.target.reset(); $('#ytCode').value = ''; $('#dlgYT').close(); toast('Channel tersimpan ✅', 'ok'); refresh(); }
  catch (err) { toast(err.message, 'err'); }
};
$('#formEditYT').onsubmit = async e => {
  e.preventDefault();
  const orig = $('#editOrigName').value;
  const pv = document.querySelector('#editPrivacyGroup input[name="privacyStatus"]:checked')?.value || 'private';
  const patch = { name: $('#editName').value.trim(), clientId: $('#editClientId').value.trim(), clientSecret: $('#editClientSecret').value.trim(), refreshToken: $('#editRefresh').value.trim(), privacyStatus: pv, enabled: $('#editEnabled').checked, defaultTitle: $('#editDefaultTitle').value.trim(), defaultDescription: $('#editDefaultDescription').value, defaultTags: $('#editDefaultTags').value.split(',').map(s => s.trim()).filter(Boolean) };
  try { await api('/api/accounts/youtube/' + encodeURIComponent(orig), { method: 'PUT', body: JSON.stringify(patch) }); $('#dlgEditYT').close(); toast('Channel diupdate ✅', 'ok'); refresh(); }
  catch (err) { $('#editMsg').textContent = err.message; }
};

// --- Perbarui token akun expired langsung dari dialog Edit channel ---
$('#btnEditAuthUrl').onclick = async () => {
  const clientId = $('#editClientId').value.trim(), clientSecret = $('#editClientSecret').value.trim();
  if (!clientId || !clientSecret) { $('#editAuthHint').textContent = 'Isi Client ID & Secret dulu.'; return toast('Isi Client ID & Secret dulu', 'err'); }
  $('#editAuthHint').textContent = 'Membuka Google…';
  try {
    const r = await api('/api/youtube/auth-url', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) });
    window.open(r.authUrl, '_blank');
    $('#editAuthHint').textContent = 'Login di tab baru → Allow → copy Kode → paste di bawah → Tukar kode.';
  } catch (e) { $('#editAuthHint').textContent = 'Gagal: ' + e.message; }
};
$('#btnEditExchange').onclick = async () => {
  const clientId = $('#editClientId').value.trim(), clientSecret = $('#editClientSecret').value.trim(), code = $('#editYtCode').value.trim();
  if (!code) return toast('Paste kode Google dulu', 'err');
  $('#editTestHint').textContent = 'Menukar kode…';
  try {
    const r = await api('/api/youtube/exchange', { method: 'POST', body: JSON.stringify({ clientId, clientSecret, code }) });
    $('#editRefresh').value = r.refreshToken;
    $('#editYtCode').value = '';
    $('#editTestHint').textContent = '✅ Token baru terisi — klik Update untuk simpan.';
    toast('Token baru didapat ✅', 'ok');
  } catch (e) { $('#editTestHint').textContent = '❌ ' + e.message; toast(e.message, 'err'); }
};
$('#btnEditTestYT').onclick = async () => {
  const clientId = $('#editClientId').value.trim(), clientSecret = $('#editClientSecret').value.trim(), refreshToken = $('#editRefresh').value.trim();
  if (!clientId || !clientSecret || !refreshToken) return toast('Lengkapi Client ID, Secret & Refresh Token dulu', 'err');
  $('#editTestHint').textContent = 'Testing…';
  try {
    await api('/api/youtube/test', { method: 'POST', body: JSON.stringify({ clientId, clientSecret, refreshToken }) });
    $('#editTestHint').textContent = '✅ Token valid';
    toast('Token valid ✅', 'ok');
  } catch (e) { $('#editTestHint').textContent = '❌ ' + e.message; toast('Token tidak valid: ' + e.message, 'err'); }
};
$('#formFB').onsubmit = async e => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target).entries());
  try { await api('/api/accounts', { method: 'POST', body: JSON.stringify({ platform: 'facebook', account: d }) }); e.target.reset(); $('#dlgFB').close(); toast('Page tersimpan ✅', 'ok'); refresh(); }
  catch (err) { toast(err.message, 'err'); }
};
$('#formEditFB').onsubmit = async e => {
  e.preventDefault();
  const orig = $('#editFBOrig').value;
  const patch = { name: $('#editFBName').value.trim(), pageId: $('#editFBPageId').value.trim(), enabled: $('#editFBEnabled').checked, defaultTitle: $('#editFBDefaultTitle').value.trim(), defaultDescription: $('#editFBDefaultDescription').value, defaultTags: $('#editFBDefaultTags').value.split(',').map(s => s.trim()).filter(Boolean) };
  const token = $('#editFBToken').value.trim();
  if (token) patch.token = token;
  try { await api('/api/accounts/facebook/' + encodeURIComponent(orig), { method: 'PUT', body: JSON.stringify(patch) }); $('#dlgEditFB').close(); toast('Page diupdate ✅', 'ok'); refresh(); }
  catch (err) { $('#editFBMsg').textContent = err.message; }
};

// ---------- pengaturan ----------
function buildHourGrid() {
  const g = $('#hourGrid'); if (!g || g.dataset.built) return; g.dataset.built = '1';
  for (let h = 0; h < 24; h++) {
    const lab = document.createElement('label');
    lab.innerHTML = `<input type="checkbox" value="${h}"> ${String(h).padStart(2, '0')}:00`;
    g.appendChild(lab);
  }
  g.addEventListener('change', syncCron);
  $('#chkEveryHour').addEventListener('change', syncCron);
  $('#chkEvery30').addEventListener('change', syncCron);
  $('#btnClearHours').addEventListener('click', () => { g.querySelectorAll('input').forEach(c => c.checked = false); $('#chkEveryHour').checked = false; $('#chkEvery30').checked = false; syncCron(); });
  $('#setSchedule').addEventListener('input', parseCronToChecks);
}
function syncCron() {
  if ($('#chkEvery30').checked) { $('#setSchedule').value = '*/30 * * * *'; $('#cronPreview').textContent = 'tiap 30 menit'; return; }
  if ($('#chkEveryHour').checked) { $('#setSchedule').value = '0 * * * *'; $('#cronPreview').textContent = 'tiap jam'; return; }
  const hrs = [...document.querySelectorAll('#hourGrid input:checked')].map(i => i.value).sort((a, b) => a - b);
  if (!hrs.length) { $('#cronPreview').textContent = '(belum pilih jam)'; return; }
  $('#setSchedule').value = `0 ${hrs.join(',')} * * *`;
  $('#cronPreview').textContent = hrs.map(h => String(h).padStart(2, '0') + ':00').join(', ') + ' WIB';
}
function parseCronToChecks() {
  const v = $('#setSchedule').value.trim();
  document.querySelectorAll('#hourGrid input').forEach(c => c.checked = false);
  $('#chkEveryHour').checked = false; $('#chkEvery30').checked = false;
  if (v === '*/30 * * * *') { $('#chkEvery30').checked = true; $('#cronPreview').textContent = 'tiap 30 menit'; return; }
  if (v === '0 * * * *') { $('#chkEveryHour').checked = true; $('#cronPreview').textContent = 'tiap jam'; return; }
  const m = v.match(/^0\s+([\d,]+)\s+\*\s+\*\s+\*/);
  if (m) { m[1].split(',').forEach(h => { const cb = document.querySelector(`#hourGrid input[value="${h.trim()}"]`); if (cb) cb.checked = true; }); syncCron(); }
}
async function loadSettings() {
  buildHourGrid();
  const s = await api('/api/settings');
  $$( '#setPrivacyGroup input[name="YT_PRIVACY_STATUS"]').forEach(r => r.checked = r.value === (s.YT_PRIVACY_STATUS || 'private'));
  $('#setSchedule').value = s.POST_SCHEDULE || '0 10,18 * * *';
  $('#setTz').value = s.TIMEZONE || 'Asia/Jakarta';
  $$( 'input[name="POST_STRATEGY"]').forEach(r => r.checked = r.value === (s.POST_STRATEGY || 'all'));
  $('#setTags').value = s.YT_DEFAULT_TAGS || '';
  $('#setEnableYT').checked = s.ENABLE_YOUTUBE === 'true';
  $('#setEnableFB').checked = s.ENABLE_FACEBOOK === 'true';
  try {
    const gr = await api('/api/groups');
    const groups = (gr.groups || []).filter(g => g.enabled !== false);
    $('#setPostGroup').innerHTML = '<option value="">Semua akun</option><option value="rotate">Rotasi grup</option>'
      + groups.map(g => `<option value="${esc(g.id)}">👥 ${esc(g.name)}</option>`).join('');
    const cur = s.POST_GROUP || '';
    const match = groups.find(g => g.id === cur || g.name === cur);
    $('#setPostGroup').value = cur === 'rotate' ? 'rotate' : (match?.id || '');
  } catch {}
  if ($('#setCategory')) $('#setCategory').value = s.YT_CATEGORY_ID || '';
  $$( 'input[name="FB_USE_REELS"]').forEach(r => r.checked = (r.value === 'true') === (s.FB_USE_REELS !== 'false'));
  if ($('#setYtDesc')) $('#setYtDesc').value = (s.YT_DEFAULT_DESC || '').replace(/\\n/g, '\n');
  if ($('#setFbDesc')) $('#setFbDesc').value = (s.FB_DEFAULT_DESC || '').replace(/\\n/g, '\n');
  $('#setMsg').textContent = '';
  parseCronToChecks();
}
// settings dimuat saat tab dibuka pertama kali (tab Pengaturan sudah dihapus — kode dipertahankan untuk kompatibilitas)
document.querySelector('[data-tab="settings"]')?.addEventListener('click', loadSettings, { once: false });
if ($('#formSettings')) $('#formSettings').onsubmit = async e => {
  e.preventDefault();
  const pv = document.querySelector('#setPrivacyGroup input[name="YT_PRIVACY_STATUS"]:checked')?.value || 'private';
  const strat = document.querySelector('input[name="POST_STRATEGY"]:checked')?.value || 'all';
  const fbReels = document.querySelector('input[name="FB_USE_REELS"]:checked')?.value || 'true';
  const patch = {
    YT_PRIVACY_STATUS: pv,
    POST_SCHEDULE: $('#setSchedule').value.trim(),
    TIMEZONE: $('#setTz').value.trim(),
    POST_STRATEGY: strat,
    POST_GROUP: $('#setPostGroup')?.value || '',
    YT_DEFAULT_TAGS: $('#setTags').value.trim(),
    YT_CATEGORY_ID: $('#setCategory')?.value || undefined,
    YT_DEFAULT_DESC: $('#setYtDesc')?.value.trim() || undefined,
    FB_USE_REELS: fbReels,
    FB_DEFAULT_DESC: $('#setFbDesc')?.value.trim() || undefined,
    ENABLE_YOUTUBE: $('#setEnableYT').checked ? 'true' : 'false',
    ENABLE_FACEBOOK: $('#setEnableFB').checked ? 'true' : 'false',
  };
  Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);
  if (!patch.POST_SCHEDULE) return toast('Centang jam dulu', 'err');
  try { await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }); $('#setMsg').textContent = '✅ Tersimpan! Restart scheduler agar jadwal aktif.'; toast('Pengaturan tersimpan', 'ok'); if (patch.YT_DEFAULT_TAGS) cacheTags(patch.YT_DEFAULT_TAGS.split(',')); setTimeout(refresh, 800); }
  catch (err) { $('#setMsg').textContent = err.message; toast(err.message, 'err'); }
};

// init detail posting + kategori + cache hashtag
fillCategories().then(() => loadDetail());
api('/api/settings').then(s => { if (s.YT_DEFAULT_TAGS) cacheTags(String(s.YT_DEFAULT_TAGS).split(',')); }).catch(() => {});
renderTagChips();
for (const id of ['#pdTitle', '#pdDescription', '#pdTags', '#pdFbCaption']) {
  $(id)?.addEventListener('input', saveDetail);
}
$('#pdTags')?.addEventListener('input', renderTagChips);
$('#mTags')?.addEventListener('input', renderTagChips);
document.querySelectorAll('input[name="pdPrivacy"], input[name="pdFbMode"]').forEach(r => r.addEventListener('change', saveDetail));
$('#pdCategory')?.addEventListener('change', saveDetail);
$('#pdKids')?.addEventListener('change', saveDetail);
$('#pdPublishAt')?.addEventListener('change', saveDetail);
$('#btnClearDetail')?.addEventListener('click', () => {
  $('#pdTitle').value = ''; $('#pdDescription').value = ''; $('#pdTags').value = '';
  $('#pdCategory').value = ''; $('#pdPublishAt').value = ''; $('#pdFbCaption').value = '';
  $('#pdKids').checked = false;
  document.querySelector('input[name="pdPrivacy"][value=""]')?.click();
  document.querySelector('input[name="pdFbMode"][value="default"]')?.click();
  saveDetail(); renderTagChips(); toast('Detail posting dikosongkan');
});
$('#btnAddShorts')?.addEventListener('click', () => {
  const el = $('#pdDescription');
  if (!/#shorts/i.test(el.value)) { el.value = (el.value.trim() + '\n#Shorts').trim(); saveDetail(); }
});
$('#mTitle')?.addEventListener('input', () => { $('#mTitleCount').textContent = `${$('#mTitle').value.length}/100`; });

// ---------- Daftar link Google Drive tersimpan ----------
async function loadSavedLinks() {
  try {
    const r = await api('/api/drive-links');
    const links = r.links || [];
    // dropdown di tab Kompilasi
    const sel = $('#compileLinkSel');
    if (sel) {
      const prev = sel.value;
      const preferred = links.find(l => /video lucu/i.test(l.name)) || links[0];
      const selected = prev || preferred?.link || '';
      sel.innerHTML = '<option value="">— pilih link tersimpan —</option>' +
        links.map(l => `<option value="${esc(l.link)}"${l.link === selected ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
      if (selected && $('#compileFolderLink') && !$('#compileFolderLink').value) {
        $('#compileFolderLink').value = selected;
        setTimeout(() => checkFolderCount(), 100);
      }
    }
    // daftar di dialog kelola
    const box = $('#dlgLinksList');
    if (box) {
      box.innerHTML = links.length
        ? links.map(l => `
          <div class="drive-file">
            <div class="drive-file-meta">
              <span class="drive-file-name">${esc(l.name)}</span>
              <span class="drive-file-info" style="word-break:break-all">${esc(l.link)}</span>
            </div>
            <div style="display:flex;gap:6px">
              <button class="drive-file-btn" data-uselink="${esc(l.link)}">Pakai</button>
              <button class="drive-file-btn" data-dellink="${esc(l.id)}">🗑</button>
            </div>
          </div>`).join('')
        : '<div class="empty">Belum ada link tersimpan</div>';
      $$('#dlgLinksList [data-uselink]').forEach(b => b.onclick = () => {
        $('#dlgLinkUrl').value = b.dataset.uselink;
        toast('Link dimuat ke form');
      });
      $$('#dlgLinksList [data-dellink]').forEach(b => b.onclick = async () => {
        try {
          await api('/api/drive-links/' + encodeURIComponent(b.dataset.dellink), { method: 'DELETE' });
          toast('Link dihapus', 'ok');
          loadSavedLinks();
        } catch (e) { toast('Gagal: ' + e.message, 'err'); }
      });
    }
  } catch (e) { toast('Gagal load link: ' + e.message, 'err'); }
}

async function saveDriveLink() {
  const link = $('#compileFolderLink')?.value || '';
  if (!link.trim()) { toast('Isi link folder dulu', 'err'); return; }
  const name = prompt('Nama untuk link ini:', link.replace(/^https?:\/\//, '').slice(0, 40));
  if (name === null) return;
  try {
    await api('/api/drive-links', { method: 'POST', body: JSON.stringify({ name, link }) });
    toast('Link tersimpan', 'ok');
    loadSavedLinks();
  } catch (e) { toast('Gagal simpan: ' + e.message, 'err'); }
}

$('#btnSaveLink')?.addEventListener('click', saveDriveLink);
$('#btnManageLinks')?.addEventListener('click', () => { loadSavedLinks(); $('#dlgLinks').showModal(); });
$('#btnDlgAddLink')?.addEventListener('click', async () => {
  const link = $('#dlgLinkUrl')?.value || '';
  const name = $('#dlgLinkName')?.value || '';
  if (!link.trim()) { toast('Isi link folder dulu', 'err'); return; }
  try {
    await api('/api/drive-links', { method: 'POST', body: JSON.stringify({ name, link }) });
    $('#dlgLinkUrl').value = ''; $('#dlgLinkName').value = '';
    toast('Link tersimpan', 'ok');
    loadSavedLinks();
  } catch (e) { toast('Gagal simpan: ' + e.message, 'err'); }
});
$('#compileLinkSel')?.addEventListener('change', () => {
  const v = $('#compileLinkSel').value;
  if (v) $('#compileFolderLink').value = v;
  checkFolderCount();
});

// ---------- Hitung jumlah video di folder terpilih ----------
let folderCountTimer = null;
async function checkFolderCount() {
  const el = $('#folderVideoCount');
  const link = $('#compileFolderLink')?.value || '';
  if (!link.trim()) { if (el) el.textContent = ''; return; }
  if (el) el.textContent = 'Menghitung video…';
  try {
    const r = await api('/api/drive/public-list', { method: 'POST', body: JSON.stringify({ link }) });
    const videos = (r.files || []).filter(f => /\.(mp4|mov|webm|mkv)$/i.test(f.name));
    // unik berdasarkan ID agar tidak dobel
    const uniq = [...new Map(videos.map(v => [v.id, v])).values()];
    const kw = ($('#compileFilter')?.value || '').trim().toLowerCase();
    const matched = kw ? uniq.filter(v => v.name.toLowerCase().includes(kw)) : uniq;
    if (el) {
      el.textContent = kw
        ? `📼 ${uniq.length} video di folder — ${matched.length} cocok filter "${kw}"`
        : `📼 ${uniq.length} video di folder`;
      el.className = matched ? 'muted' : 'muted';
    }
  } catch (e) {
    if (el) el.textContent = '⚠ ' + e.message;
  }
}
$('#btnCountVideos')?.addEventListener('click', checkFolderCount);
$('#compileFolderLink')?.addEventListener('change', checkFolderCount);
$('#compileFolderLink')?.addEventListener('input', () => {
  clearTimeout(folderCountTimer);
  folderCountTimer = setTimeout(checkFolderCount, 900);
});
$('#compileFilter')?.addEventListener('input', () => {
  clearTimeout(folderCountTimer);
  folderCountTimer = setTimeout(checkFolderCount, 600);
});

// ---------- Sumber video: Google Drive vs lokal ----------
function currentSource() {
  return document.querySelector('input[name="compileSource"]:checked')?.value || 'gdrive';
}
function applySourceUI() {
  const local = currentSource() === 'local';
  $('#srcGdrive').style.display = local ? 'none' : '';
  $('#srcLocal').style.display = local ? '' : 'none';
  $('#sourceHint').textContent = local
    ? 'Video diambil dari folder videos/ di komputer (hasil download / tambahan manual).'
    : 'Video diambil dari folder Google Drive publik (diunduh saat render).';
  if (local) loadLocalVideos();
  else checkFolderCount();
}
$$('input[name="compileSource"]').forEach(r => r.addEventListener('change', applySourceUI));

// --- Daftar file dalam folder Drive (dengan status sudah/belum diunduh) ---
let driveFilesCache = [];
async function loadDriveFolderFiles() {
  const box = $('#driveFolderFiles');
  const link = $('#compileFolderLink')?.value || '';
  if (!link.trim()) { if (box) box.innerHTML = ''; driveFilesCache = []; return; }
  if (box) box.innerHTML = '<div class="empty">Memuat daftar file folder…</div>';
  try {
    const r = await api('/api/drive/public-list', { method: 'POST', body: JSON.stringify({ link }) });
    driveFilesCache = (r.files || []).filter(f => /\.(mp4|mov|webm|mkv)$/i.test(f.name));
    renderDriveFolderFiles();
  } catch (e) {
    if (box) box.innerHTML = '<div class="empty">⚠ ' + esc(e.message) + '</div>';
  }
}
async function renderDriveFolderFiles() {
  const box = $('#driveFolderFiles');
  if (!box) return;
  if (!driveFilesCache.length) { box.innerHTML = '<div class="empty">Tidak ada video di folder ini.</div>'; return; }
  let localSet = new Set();
  try {
    const lr = await api('/api/sources/local');
    localSet = new Set((lr.videos || []).map(v => v.name));
  } catch {}
  box.innerHTML = driveFilesCache.map((f, i) => {
    const has = localSet.has(f.name);
    return `<div class="src-file">
      <span class="src-name">${has ? '✅' : '🎬'} ${esc(f.name)}</span>
      <span class="src-size">${esc(f.sizeText || '')}</span>
      <button type="button" class="btn xs src-dl" data-i="${i}" ${has ? 'disabled' : ''}>${has ? 'Sudah ada' : '⬇ Unduh'}</button>
    </div>`;
  }).join('');
  $$('#driveFolderFiles .src-dl').forEach(b => b.onclick = async () => {
    const f = driveFilesCache[Number(b.dataset.i)];
    if (!f) return;
    b.disabled = true; b.textContent = '…';
    try {
      await api('/api/drive/public-download', { method: 'POST', body: JSON.stringify({ fileId: f.id, fileName: f.name }) });
      toast('Download dimulai: ' + f.name, 'ok');
      watchSourceProgress('folder:' + '', () => renderDriveFolderFiles());
    } catch (e) { toast('Gagal: ' + e.message, 'err'); b.disabled = false; b.textContent = '⬇ Unduh'; }
  });
}
$('#btnUpdateFolder')?.addEventListener('click', async () => {
  toast('Mengecek video terbaru dari folder…');
  await loadDriveFolderFiles();
  await checkFolderCount();
  toast('Daftar video folder diperbarui', 'ok');
});

// --- Download semua video folder ---
$('#btnDownloadAll')?.addEventListener('click', async () => {
  const link = $('#compileFolderLink')?.value || '';
  if (!link.trim()) return toast('Pilih/link folder Google Drive dulu', 'err');
  const btn = $('#btnDownloadAll');
  btn.disabled = true; btn.textContent = '…';
  try {
    if (!driveFilesCache.length) await loadDriveFolderFiles();
    if (!driveFilesCache.length) { toast('Tidak ada video di folder', 'err'); return; }
    await api('/api/drive/download-all', {
      method: 'POST',
      body: JSON.stringify({ link, files: driveFilesCache.map(f => ({ id: f.id, name: f.name })) }),
    });
    toast(`Download semua dimulai (${driveFilesCache.length} video)`, 'ok');
    watchSourceProgress(null, () => { renderDriveFolderFiles(); loadLocalVideos(); });
  } catch (e) { toast('Gagal: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '⬇ Download semua'; }
});

// --- Video lokal ---
async function loadLocalVideos() {
  const box = $('#localVideoList');
  const cnt = $('#localVideoCount');
  try {
    const r = await api('/api/sources/local');
    const vids = r.videos || [];
    if (cnt) cnt.textContent = vids.length ? `— ${vids.length} video` : '';
    if (!box) return;
    if (!vids.length) {
      box.innerHTML = '<div class="empty">Belum ada video lokal.<br>Tambah dari path, pilih file, atau download dari YouTube / Google Drive.</div>';
      return;
    }
    box.innerHTML = vids.map(v => `<div class="src-file">
      <span class="src-name">🎬 ${esc(v.name)}</span>
      <span class="src-size">${esc(v.sizeMB)} MB</span>
      <button type="button" class="btn xs danger src-del" data-name="${esc(v.name)}" title="Hapus video">🗑</button>
    </div>`).join('');
    $$('#localVideoList .src-del').forEach(b => b.onclick = async () => {
      if (!confirm(`Hapus video "${b.dataset.name}" dari komputer?`)) return;
      try {
        await api('/api/videos/' + encodeURIComponent(b.dataset.name), { method: 'DELETE' });
        toast('Video dihapus', 'ok');
        loadLocalVideos();
      } catch (e) { toast('Gagal: ' + e.message, 'err'); }
    });
  } catch (e) {
    if (box) box.innerHTML = '<div class="empty">⚠ ' + esc(e.message) + '</div>';
  }
}

$('#btnAddLocalPath')?.addEventListener('click', async () => {
  const p = $('#localPathInput')?.value || '';
  if (!p.trim()) return toast('Isi path file video dulu', 'err');
  try {
    const r = await api('/api/sources/local', { method: 'POST', body: JSON.stringify({ path: p }) });
    toast('Video ditambah: ' + r.file, 'ok');
    $('#localPathInput').value = '';
    loadLocalVideos();
  } catch (e) { toast('Gagal: ' + e.message, 'err'); }
});

$('#localFileInput')?.addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) {
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch('/api/sources/upload', { method: 'POST', body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Upload gagal');
      toast('Video ditambah: ' + j.file, 'ok');
    } catch (err) { toast('Gagal upload ' + f.name + ': ' + err.message, 'err'); }
  }
  loadLocalVideos();
});

$('#btnAddYouTube')?.addEventListener('click', async () => {
  const url = $('#ytUrlInput')?.value || '';
  if (!url.trim()) return toast('Isi link YouTube dulu', 'err');
  const btn = $('#btnAddYouTube');
  btn.disabled = true; btn.textContent = '…';
  try {
    await api('/api/sources/youtube', { method: 'POST', body: JSON.stringify({ url }) });
    toast('Download YouTube dimulai', 'ok');
    watchSourceProgress(null, () => loadLocalVideos());
  } catch (e) { toast('Gagal: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '▶ YouTube'; }
});

// --- Poll progress sumber (folder / youtube) ---
let srcProgTimer = null;
function watchSourceProgress(keyFilter, onDone) {
  clearInterval(srcProgTimer);
  const tick = async () => {
    try {
      const r = await api('/api/sources/progress');
      const all = r.progress || {};
      const keys = Object.keys(all).filter(k => !keyFilter || k === keyFilter || keyFilter.startsWith('folder:'));
      if (!keys.length) { clearInterval(srcProgTimer); if (onDone) onDone(); return; }
      const k = keys[keys.length - 1];
      const p = all[k];
      renderSourceProgress(p);
      if (p.status === 'done' || p.status === 'error') {
        clearInterval(srcProgTimer);
        if (onDone) onDone();
        setTimeout(() => { $('#dlAllProgress').innerHTML = ''; $('#ytProgress').innerHTML = ''; }, 8000);
      }
    } catch { clearInterval(srcProgTimer); }
  };
  tick();
  srcProgTimer = setInterval(tick, 1200);
}
function renderSourceProgress(p) {
  const pct = Math.max(0, Math.min(100, Number(p.percent || 0)));
  const isFolder = (p.kind === 'folder');
  const box = isFolder ? $('#dlAllProgress') : $('#ytProgress');
  if (!box) return;
  const title = isFolder
    ? `Download folder — ${p.done || 0}/${p.total || 0} video`
    : 'Download YouTube';
  const detail = p.status === 'done'
    ? (isFolder ? `Selesai: ${(p.results || []).filter(r => r.ok).length}/${(p.results || []).length} berhasil` : (p.file ? 'Selesai: ' + p.file : 'Selesai'))
    : p.status === 'error' ? ('⚠ ' + (p.error || 'gagal'))
    : (p.current || p.title || 'Memproses…');
  const cls = p.status === 'error' ? 'err' : p.status === 'done' ? 'ok' : '';
  box.innerHTML = `<div class="src-prog ${cls}">
    <div class="src-prog-head"><b>${esc(title)}</b><span>${pct}%</span></div>
    <div class="src-prog-bar"><div class="src-prog-fill" style="width:${pct}%"></div></div>
    <div class="src-prog-detail">${esc(detail)}</div>
  </div>`;
}

// ---------- Jadwal kompilasi ----------
let editingScheduleId = null;

function fillTimeOptions(sel, selected, step) {
  sel.innerHTML = '';
  for (let v = 0; v < 60; v += step) {
    const val = String(v).padStart(2, '0');
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = val;
    if (val === selected) opt.selected = true;
    sel.appendChild(opt);
  }
  // kalau nilai tersimpan tidak ada di daftar (mis. menit ganjil), tambahkan agar tidak berubah diam-diam
  if (selected && !Array.from(sel.options).some(o => o.value === selected)) {
    const opt = document.createElement('option');
    opt.value = selected;
    opt.textContent = selected;
    sel.appendChild(opt);
    sel.value = selected;
  }
}

function addScheduleTime(value = '06:00') {
  const list = $('#schTimeList');
  if (!list) return;
  const [hh = '06', mm = '00'] = String(value).split(':');
  const row = document.createElement('div');
  row.className = 'schedule-time-row';
  const hourSel = document.createElement('select');
  hourSel.className = 'sch-hour';
  fillTimeOptions(hourSel, hh.padStart(2, '0'), 1);
  const minSel = document.createElement('select');
  minSel.className = 'sch-min';
  // menit 00–59, langkah 1 menit (sebelumnya 5 menit → terasa melompat jauh)
  fillTimeOptions(minSel, mm.padStart(2, '0'), 1);
  const sep = document.createElement('span');
  sep.className = 'sch-sep'; sep.textContent = ':';
  const del = document.createElement('button');
  del.type = 'button'; del.className = 'btn xs danger sch-remove-time'; del.title = 'Hapus jam'; del.textContent = '×';
  del.onclick = () => {
    if (list.querySelectorAll('.schedule-time-row').length > 1) row.remove();
    else { hourSel.value = '06'; minSel.value = '00'; }
  };
  row.append(hourSel, sep, minSel, del);
  list.appendChild(row);
}

function getScheduleTimes() {
  return $$('#schTimeList .schedule-time-row')
    .map(r => `${r.querySelector('.sch-hour').value}:${r.querySelector('.sch-min').value}`)
    .filter(Boolean);
}

function setScheduleTimes(values) {
  const list = $('#schTimeList');
  if (!list) return;
  list.innerHTML = '';
  (values.length ? values : ['06:00']).forEach(v => addScheduleTime(v));
}

/** Muat 1 jadwal ke form untuk diedit. */
async function editSchedule(id) {
  try {
    const r = await api('/api/schedules');
    const s = (r.schedules || []).find(x => x.id === id);
    if (!s) return toast('Jadwal tidak ditemukan', 'err');
    editingScheduleId = s.id;
    $('#schName').value = s.name || '';
    $('#schEnabled').checked = s.enabled !== false;
    const isDaily = s.type !== 'interval' && s.type !== 'once';
    $('#schDaily').checked = isDaily;
    $('#wrapSchDaily').style.display = isDaily ? '' : 'none';
    const times = (s.times && s.times.length)
      ? s.times
      : (Array.isArray(s.hours) ? s.hours.map(h => `${String(h).padStart(2, '0')}:00`) : ['06:00']);
    setScheduleTimes(times);
    $('#schSubmit').textContent = '💾 Simpan perubahan';
    $('#btnSchCancelEdit').style.display = '';
    $('#schMsg').textContent = `Mengedit jadwal "${s.name}" — ubah lalu klik Simpan perubahan.`;
    $('#schName').focus();
    $('#dlgSchedule')?.showModal();
  } catch (e) { toast('Gagal muat jadwal: ' + e.message, 'err'); }
}

function resetScheduleForm() {
  editingScheduleId = null;
  $('#schName').value = '';
  $('#schEnabled').checked = true;
  $('#schDaily').checked = true;
  $('#wrapSchDaily').style.display = '';
  setScheduleTimes(['06:00']);
  $('#schSubmit').textContent = '＋ Simpan jadwal';
  $('#btnSchCancelEdit').style.display = 'none';
  $('#schMsg').textContent = '';
}

async function loadSchedules() {
  try {
    const r = await api('/api/schedules');
    const list = r.schedules || [];
    $('#schCount').textContent = `${list.length} jadwal`;
    const box = $('#schList');
    if (!list.length) {
      box.innerHTML = '<div class="empty">Belum ada jadwal</div>';
      return;
    }
    box.innerHTML = list.map(s => {
      const freq = s.type === 'once'
        ? `sekali ${s.runAt ? new Date(s.runAt).toLocaleString('id-ID') : '-'}`
        : s.type === 'interval'
          ? `tiap ${s.everyMinutes} menit`
          : `harian ${(s.times && s.times.length ? s.times : (s.hours || []).map(h => String(h).padStart(2, '0') + ':00')).join(', ')}`;
      const last = s.lastRun ? new Date(s.lastRun).toLocaleString('id-ID') : 'belum pernah';
      return `<div class="gp-item${s.enabled ? '' : ' is-off'}">
        <input type="checkbox" data-tgl="${esc(s.id)}" ${s.enabled ? 'checked' : ''} title="Aktif/nonaktif">
        <div class="gp-ico">${s.enabled ? '⏰' : '⏸'}</div>
        <div class="gp-meta"><b>${esc(s.name)}</b><small>${freq} • terakhir: ${last}</small></div>
        <div style="display:flex;gap:4px">
          <button type="button" class="btn xs" data-run="${esc(s.id)}">▶ Jalankan</button>
          <button type="button" class="btn xs" data-edit="${esc(s.id)}">✏ Edit</button>
          <button type="button" class="btn xs danger" data-delsch="${esc(s.id)}">🗑</button>
        </div>
      </div>`;
    }).join('');
    $$('#schList [data-run]').forEach(b => b.onclick = async () => {
      try {
        await api('/api/schedules/' + encodeURIComponent(b.dataset.run) + '/run', { method: 'POST' });
        toast('Jadwal dijalankan sekarang', 'ok');
        const dlg = $('#dlgSchedule');
        if (dlg?.open) dlg.close();
      } catch (e) { toast('Gagal: ' + e.message, 'err'); }
    });
    $$('#schList [data-edit]').forEach(b => b.onclick = () => editSchedule(b.dataset.edit));
    $$('#schList [data-delsch]').forEach(b => b.onclick = async () => {
      try {
        await api('/api/schedules/' + encodeURIComponent(b.dataset.delsch), { method: 'DELETE' });
        toast('Jadwal dihapus', 'ok');
        loadSchedules();
      } catch (e) { toast('Gagal: ' + e.message, 'err'); }
    });
    $$('#schList [data-tgl]').forEach(c => c.onchange = async () => {
      try {
        await api('/api/schedules/' + encodeURIComponent(c.dataset.tgl), { method: 'PUT', body: JSON.stringify({ enabled: c.checked }) });
        toast(c.checked ? 'Jadwal diaktifkan' : 'Jadwal dinonaktifkan', 'ok');
        loadSchedules();
      } catch (e) { toast('Gagal: ' + e.message, 'err'); }
    });
  } catch (e) { toast('Gagal load jadwal: ' + e.message, 'err'); }
}

function openScheduleDialog() {
  resetScheduleForm();
  loadSchedules();
  $('#dlgSchedule').showModal();
}
$('#btnSchedule')?.addEventListener('click', openScheduleDialog);
$('#btnAddSchedule')?.addEventListener('click', openScheduleDialog);
$('#btnRefreshSchedules')?.addEventListener('click', loadSchedules);
$('#btnSchCancelEdit')?.addEventListener('click', resetScheduleForm);
$('#schDaily')?.addEventListener('change', () => {
  $('#wrapSchDaily').style.display = $('#schDaily').checked ? '' : 'none';
});
$('#btnSchAddTime')?.addEventListener('click', () => addScheduleTime('12:00'));
$('#btnSchPreset')?.addEventListener('click', () => setScheduleTimes(['06:00', '12:00', '18:00']));
$('#btnSchClearHours')?.addEventListener('click', () => setScheduleTimes(['06:00']));
$('#formSchedule')?.addEventListener('submit', async e => {
  e.preventDefault();
  const link = $('#compileFolderLink')?.value || '';
  const isDaily = $('#schDaily')?.checked !== false;
  const type = isDaily ? 'daily' : 'interval';
  const times = isDaily ? getScheduleTimes() : [];
  const hours = times.map(t => Number(t.split(':')[0])).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  if (isDaily && !times.length) { $('#schMsg').textContent = 'Pilih minimal satu jam.'; return; }
  const srcNow = currentSource();
  if (srcNow !== 'local' && !link.trim()) { $('#schMsg').textContent = 'Pilih folder Google Drive di form Kompilasi dulu (atau pilih sumber "Video lokal").'; return; }
  const name = $('#schName').value.trim();
  if (!name) { $('#schMsg').textContent = 'Isi nama jadwal dulu.'; return; }
  const options = getCompileOptions(false);
  options.postDelaySec = 120;
  options.postTarget = currentTarget();
  const payload = {
    name,
    type,
    hours,
    times,
    everyMinutes: 1440,
    enabled: $('#schEnabled').checked,
    options,
  };
  try {
    if (editingScheduleId) {
      await api('/api/schedules/' + encodeURIComponent(editingScheduleId), { method: 'PUT', body: JSON.stringify(payload) });
      toast('Jadwal diperbarui ✅', 'ok');
      resetScheduleForm();
    } else {
      await api('/api/schedules', { method: 'POST', body: JSON.stringify(payload) });
      $('#schName').value = '';
      toast('Jadwal tersimpan ✅', 'ok');
    }
    $('#schMsg').textContent = '';
    loadSchedules();
  } catch (e) { $('#schMsg').textContent = e.message; }
});

// ---------- Kompilasi ----------
let compilePolling = null;

function renderCompileLog(logs, running) {
  const box = $('#compileLog');
  if (!box) return;
  const rows = (logs || []).slice(-40).map((line, idx, arr) => {
    const isCurrent = running && idx === arr.length - 1;
    const isError = /\[ERR\]|gagal|error/i.test(line);
    const cls = isError ? 'error' : (isCurrent ? 'current' : 'done');
    const icon = isError ? '✕' : (isCurrent ? '◐' : '✓');
    return `<div class="ai-log-row ${cls}"><span class="ai-log-icon">${icon}</span><span class="ai-log-text">${esc(line)}</span></div>`;
  }).join('');
  box.innerHTML = rows || '<div class="ai-log-row"><span class="ai-log-icon">◐</span><span class="ai-log-text">Menyiapkan proses…</span></div>';
  box.scrollTop = box.scrollHeight;
}

function showCompileLoading(title = 'Sedang membuat video') {
  const panel = $('#compileProgress');
  if (!panel) return;
  panel.style.display = 'block';
  $('#compileBuildTitle').textContent = title;
  $('#compileBuildStep').textContent = 'Menyiapkan proses kompilasi…';
  $('#compilePercent').textContent = '0%';
  $('#compileEta').textContent = 'Menghitung waktu…';
  $('#buildStepDownload').className = 'active';
  $('#buildStepArrange').className = '';
  $('#buildStepRender').className = '';
  $('#btnCompileCancel').style.display = '';
  $('#compileBar').style.width = '0%';
  const _cl = $('#compileLog'); if (_cl) _cl.innerHTML = '<div class="ai-log-row current"><span class="ai-log-icon">◐</span><span class="ai-log-text">Menyiapkan proses kompilasi…</span></div>';
}

function getCompileOptions(draft) {
  const mode = document.querySelector('input[name="compileMode"]:checked')?.value || 'duration';
  const hex = $('#wmColor')?.value || '#ffffff';
  const colorInt = '0x' + hex.slice(1).toUpperCase();
  return {
    source: currentSource(),
    link: $('#compileFolderLink')?.value || '',
    filterKeyword: $('#compileFilter')?.value || '',
    title: $('#compileTitle')?.value || 'TOP VIDEO',
    subtitle: $('#compileSubtitle')?.value || 'KOMPILASI PILIHAN',
    mode,
    count: Number($('#compileCount')?.value) || 5,
    targetDuration: Number($('#compileDuration')?.value) || 60,
    crf: Number($('#compileQuality')?.value) || 22,
    height: Number($('#compileHeight')?.value) || 1920,
    encoder: $('#compileEncoder')?.value || 'auto',
    uniqueWithinRender: $('#compileUnique')?.checked !== false,
    useMemory: false,
    draft: !!draft,
    draftSec: 4,
    watermark: ($('#wmText')?.value || '').trim() ? {
      text: $('#wmText').value.trim(),
      position: $('#wmPosition')?.value || 'br',
      size: Number($('#wmSize')?.value) || 40,
      color: colorInt,
      opacity: Number($('#wmOpacity')?.value) || 0.7,
    } : null,
    exclude: (String($('#compileExclude')?.value || '').split(',').map(s => s.trim()).filter(Boolean)),
  };
}

async function startCompile(draft) {
  const opts = getCompileOptions(draft);
  opts.postTarget = currentTarget();
  if (opts.source !== 'local' && !opts.link.trim()) { toast('Isi link folder Google Drive dulu', 'err'); return; }
  if (opts.source === 'local') { opts.link = ''; }
  try {
    await api('/api/compile', { method: 'POST', body: JSON.stringify(opts) });
    toast(draft ? 'Pratinjau dimulai' : 'Render penuh dimulai');
    showCompileLoading(draft ? 'Sedang membuat pratinjau' : 'Sedang membuat video');
    if (draft) $('#btnCompileCancel').style.display = 'none';
    pollCompile();
  } catch (e) { toast('Gagal mulai kompilasi: ' + e.message, 'err'); }
}

function pollCompile() {
  if (compilePolling) clearInterval(compilePolling);
  compilePolling = setInterval(async () => {
    try {
      const s = await api('/api/compile/status');
      let displayLogs = [...(s.logs || [])];
      // Gabungkan log posting YouTube/Facebook dari server agar proses upload
      // terlihat di panel yang sama setelah render selesai.
      try {
        const st = await api('/api/status');
        const postLogs = (st.lastLog || []).filter(line => /AUTOPOST|YouTube|Facebook|Posting|Upload|Selesai/i.test(line));
        displayLogs = [...displayLogs, ...postLogs.slice(-30)];
      } catch {}
      displayLogs = [...new Set(displayLogs)];
      renderCompileLog(displayLogs, s.running);
      const _cl2 = $('#compileLog'); if (_cl2) _cl2.scrollTop = _cl2.scrollHeight;
      const allLogs = (s.logs || []).join('\n');
      const isPosting = /AUTOPOST|YouTube|Facebook|Posting|Upload/i.test(allLogs);
      const isRendering = /Merender|render \d+%|Encoder/i.test(allLogs);
      const isArranging = /ambil #|penutup|Target|Preview/i.test(allLogs);
      if (isPosting) {
        $('#compileBuildStep').textContent = 'Mengunggah ke YouTube dan Facebook…';
        $('#buildStepDownload').className = 'done';
        $('#buildStepArrange').className = 'done';
        $('#buildStepRender').className = 'done';
        $('#buildStepPost').className = 'active';
      } else if (isRendering) {
        $('#compileBuildStep').textContent = 'Menyusun frame dan audio dengan FFmpeg…';
        $('#buildStepDownload').className = 'done';
        $('#buildStepArrange').className = 'done';
        $('#buildStepRender').className = 'active';
        $('#buildStepPost').className = '';
      } else if (isArranging) {
        $('#compileBuildStep').textContent = 'Menyusun urutan video…';
        $('#buildStepDownload').className = 'done';
        $('#buildStepArrange').className = 'active';
        $('#buildStepRender').className = '';
        $('#buildStepPost').className = '';
      } else {
        $('#compileBuildStep').textContent = 'Mengambil video dari Google Drive…';
        $('#buildStepDownload').className = 'active';
        $('#buildStepArrange').className = '';
        $('#buildStepRender').className = '';
        $('#buildStepPost').className = '';
      }
      // progress resmi dari FFmpeg + estimasi waktu tersisa
      const progress = s.progress || {};
      const dl = progress.download || {}, rd = progress.render || {}, up = progress.upload || {};
      const dlPct = Math.max(0, Math.min(100, Number(dl.percentFile || 0)));
      const renderPct = Math.max(0, Math.min(100, Number(rd.percent || 0)));
      const uploadPct = Math.max(0, Math.min(100, Number(up.percent || 0)));
      $('#dlBar').style.width = dlPct + '%'; $('#dlPercent').textContent = dlPct + '%';
      $('#renderBar').style.width = renderPct + '%'; $('#renderPercent').textContent = renderPct + '%';
      $('#uploadBar').style.width = uploadPct + '%'; $('#uploadPercent').textContent = uploadPct + '%';
      $('#dlDetail').textContent = dl.current ? `Video: ${dl.current} (${dl.percentFile || 0}% — total ${dl.percent || 0}%)` : 'Menunggu…';
      $('#renderDetail').textContent = rd.message || (rd.totalSec ? `Render: ${fmtDur((rd.totalSec - (rd.doneSec || 0)) * 1000)} tersisa` : 'Menunggu…');
      $('#uploadDetail').textContent = up.message || 'Menunggu…';
      // Panel upload per platform (YouTube / Facebook terpisah)
      const ups = s.uploads || {};
      const yt = ups.youtube || {}, fb = ups.facebook || {};
      const setPanel = (sel, data) => {
        const el = $(sel);
        if (!el) return;
        const pct = Math.max(0, Math.min(100, Number(data.percent || (data.state === 'success' ? 100 : 0))));
        el.querySelector('.ai-upload-head b').textContent = pct + '%';
        el.querySelector('.ai-phase-fill').style.width = pct + '%';
        el.querySelector('small').textContent = data.message || (data.state === 'success' ? 'Berhasil' : 'Menunggu…');
        el.className = 'ai-upload ' + (data.state === 'success' ? 'success' : data.state === 'error' ? 'error' : data.state ? 'uploading' : '');
      };
      setPanel('#uploadYt', yt);
      setPanel('#uploadFb', fb);
      const anyUp = [yt, fb].filter(u => u.state === 'uploading').length;
      if (!up.message && anyUp) $('#uploadDetail').textContent = `${anyUp} upload sedang berjalan…`;
      $('#phaseDownload').className = 'ai-phase ' + (progress.phase === 'download' ? 'active' : (dlPct >= 100 ? 'done' : ''));
      $('#phaseRender').className = 'ai-phase ' + (progress.phase === 'render' ? 'active' : (renderPct >= 100 ? 'done' : ''));
      $('#phaseUpload').className = 'ai-phase ' + (progress.phase === 'upload' ? 'active' : (uploadPct >= 100 ? 'done' : ''));
      if (progress.percent !== undefined) {
        $('#compileBar').style.width = (progress.phase === 'render' ? renderPct : progress.percent) + '%';
        $('#compilePercent').textContent = (progress.phase === 'upload' ? uploadPct : progress.phase === 'download' ? dlPct : renderPct) + '%';
        if (progress.percent > 0 && progress.totalSec) {
          const elapsed = progress.updatedAt ? (Date.now() - (progress.startedAt || progress.updatedAt)) / 1000 : 0;
          const eta = progress.speed > 0 ? (progress.totalSec * (1 - progress.percent / 100)) / progress.speed : 0;
          $('#compileEta').textContent = eta > 0 ? `Sisa sekitar ${fmtDur(eta * 1000)}` : 'Menghitung waktu…';
        }
      }
      // fallback progress dari log "render N%"
      const m = (s.logs || []).join('\n').match(/render (\d+)%/g);
      if (m) {
        const last = m[m.length - 1].match(/(\d+)/)[1];
        $('#compileBar').style.width = last + '%';
        $('#compilePercent').textContent = last + '%';
      }
      if (s.error) {
        stopCompilePoll();
        toast('Kompilasi gagal: ' + s.error, 'err');
        $('#btnCompileCancel').style.display = 'none';
      }
      if (!s.running && s.result) {
        $('#compileBar').style.width = '100%';
        $('#compilePercent').textContent = '100%';
        $('#compileBuildTitle').textContent = 'Video selesai dibuat';
        $('#compileBuildStep').textContent = 'Kompilasi berhasil disimpan ke Output';
        $('#buildStepDownload').className = 'done';
        $('#buildStepArrange').className = 'done';
        $('#buildStepRender').className = 'done';
        $('#buildStepPost').className = s.posting ? 'active' : 'done';
        $('#btnCompileCancel').style.display = 'none';
        // Tetap polling selama upload YouTube/Facebook berlangsung.
        if (!s.posting && !s.pendingPost) stopCompilePoll();
        if (s.posting) {
          $('#compileBuildTitle').textContent = 'Sedang posting ke YouTube & Facebook';
          $('#compileBuildStep').textContent = 'Mengunggah video dan menunggu respons platform…';
          $('#compilePercent').textContent = 'UPLOAD';
          $('#buildStepDownload').className = 'done';
          $('#buildStepArrange').className = 'done';
          $('#buildStepRender').className = 'active';
        }
        if (s.result.outName) {
          loadOutputs();
        }
      }
      // countdown auto-post dinonaktifkan — upload manual dari Output
      // polling berhenti sendiri saat render selesai dan bukan posting
      if (!s.running && !s.posting) stopCompilePoll();
    } catch {}
  }, 1000);
}

function stopCompilePoll() {
  if (compilePolling) { clearInterval(compilePolling); compilePolling = null; }
}

async function loadOutputs() {
  try {
    const r = await api('/api/outputs');
    const box = $('#outputList');
    if (!r.outputs.length) {
      box.innerHTML = '<div class="empty">Belum ada hasil kompilasi</div>';
      return;
    }
    box.innerHTML = r.outputs.map(o => `
      <div class="drive-file">
        <div class="drive-file-meta">
          <span class="drive-file-name">${esc(o.file)} ${o.draft ? '<span class="gp-badge warn">draft</span>' : ''}</span>
          <span class="drive-file-info">${o.sizeMB}MB • ${new Date(o.mtime).toLocaleString('id-ID')}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button class="drive-file-btn" data-play="${esc(o.file)}">▶ Putar</button>
          <button class="drive-file-btn" data-tovid="${esc(o.file)}" title="Salin ke folder videos/ untuk diposting">📤 Ke Posting</button>
          <button class="drive-file-btn" data-del="${esc(o.file)}">🗑</button>
        </div>
      </div>`).join('');
    $$('#outputList [data-play]').forEach(b => b.onclick = () => playOutput(b.dataset.play));
    $$('#outputList [data-tovid]').forEach(b => b.onclick = async () => {
      try {
        const r = await api('/api/output/to-videos', { method: 'POST', body: JSON.stringify({ file: b.dataset.tovid }) });
        toast('Disalin ke videos/: ' + r.file, 'ok');
        refresh();
      } catch (e) { toast('Gagal: ' + e.message, 'err'); }
    });
    $$('#outputList [data-del]').forEach(b => b.onclick = async () => {
      try {
        await api('/api/output/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
        toast('Dihapus', 'ok');
        loadOutputs();
      } catch (e) { toast('Gagal: ' + e.message, 'err'); }
    });
  } catch (e) { toast('Gagal load output: ' + e.message, 'err'); }
}

function playOutput(file) {
  const url = AP_BASE + '/api/output/' + encodeURIComponent(file);
  const w = window.open('', '_blank', 'width=420,height=760');
  if (w) {
    w.document.write(`<!DOCTYPE html><html><body style="margin:0;background:#000"><video src="${url}" controls autoplay style="width:100vw;height:100vh;object-fit:contain"></video></body></html>`);
    w.document.close();
  }
}

async function loadCompileMemory() {
  try {
    const m = await api('/api/compile/memory');
    $('#compileMemoryInfo').textContent = `${m.used?.length || 0} video sudah dipakai`;
  } catch {}
}

$$('input[name="compileMode"]').forEach(r => r.onchange = () => {
  const isCount = document.querySelector('input[name="compileMode"]:checked').value === 'count';
  $('#wrapDuration').style.display = isCount ? 'none' : '';
  $('#wrapCount').style.display = isCount ? '' : 'none';
});
$('#wmOpacity')?.addEventListener('input', () => { $('#wmOpacityVal').textContent = $('#wmOpacity').value; });
$('#btnCompileDraft')?.addEventListener('click', () => startCompile(true));
$('#btnCompileFull')?.addEventListener('click', () => startCompile(false));
$('#btnCompileCancel')?.addEventListener('click', async () => {
  try { await api('/api/compile/control', { method: 'POST', body: JSON.stringify({ action: 'cancel' }) }); toast('Dibatalkan'); } catch {}
});
$('#btnResetMemory')?.addEventListener('click', async () => {
  try { await api('/api/compile/memory', { method: 'DELETE' }); toast('Memory direset', 'ok'); loadCompileMemory(); } catch (e) { toast('Gagal: ' + e.message, 'err'); }
});
$('#btnRefreshOutputs')?.addEventListener('click', loadOutputs);

// ---------- Google Drive: folder publik ----------
async function loadPublicFolder() {
  const link = $('#publicFolderLink')?.value || '';
  if (!link.trim()) { toast('Paste link folder dulu', 'err'); return; }
  const list = $('#publicFilesList');
  list.innerHTML = '<p class="muted">Memuat…</p>';
  try {
    const result = await api('/api/drive/public-list', { method: 'POST', body: JSON.stringify({ link }) });
    if (!result.files.length) {
      list.innerHTML = '<div class="empty">Tidak ada file di folder ini</div>';
      return;
    }
    list.innerHTML = result.files.map((f, i) => {
      const isVideo = /\.(mp4|mov|webm|mkv)$/i.test(f.name);
      return `<div class="drive-file">
        <div class="drive-file-meta">
          <span class="drive-file-name">${i + 1}. ${esc(f.name)}</span>
          <span class="drive-file-info">${isVideo ? '🎬 video' : '⏭ bukan video'} ${f.sizeText ? '• ' + f.sizeText : ''}</span>
        </div>
        ${isVideo ? `<button class="drive-file-btn" data-id="${esc(f.id)}" data-name="${esc(f.name)}">⬇ Download</button>` : '<span class="muted">skip</span>'}
      </div>`;
    }).join('');
    $$('#publicFilesList .drive-file-btn').forEach(btn => {
      btn.onclick = () => downloadPublicFile(btn.dataset.id, btn.dataset.name);
    });
    toast(`${result.files.length} file ditemukan`, 'ok');
  } catch (e) {
    list.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
  }
}

async function downloadPublicFile(fileId, fileName) {
  try {
    await api('/api/drive/public-download', { method: 'POST', body: JSON.stringify({ fileId, fileName }) });
    driveDownloads[fileId] = { fileName, status: 'downloading', percent: 0, downloaded: 0, fileSize: 0 };
    renderDriveProgress();
    pollDriveProgress(fileId);
  } catch (e) { toast('Gagal download: ' + e.message, 'err'); }
}

$('#btnPublicLoad')?.addEventListener('click', loadPublicFolder);
$('#publicFolderLink')?.addEventListener('keydown', e => { if (e.key === 'Enter') loadPublicFolder(); });

// ---------- Google Drive (OAuth) ----------
let driveDownloads = {};
let driveCreds = null;

function getDriveCredentials() {
  const credType = document.querySelector('input[name="driveCredType"]:checked')?.value || 'youtube';
  if (credType === 'youtube') {
    const yt = lastAccounts?.youtube?.find(a => a.enabled !== false && a.clientId && a.clientSecret && a.refreshToken);
    if (yt) return { clientId: yt.clientId, clientSecret: yt.clientSecret, refreshToken: yt.refreshToken };
    return null;
  } else {
    const cid = $('#driveClientId')?.value || '';
    const cs = $('#driveClientSecret')?.value || '';
    const rt = $('#driveRefresh')?.value || '';
    return (cid && cs && rt) ? { clientId: cid, clientSecret: cs, refreshToken: rt } : null;
  }
}

async function loadDriveFiles() {
  try {
    const creds = getDriveCredentials();
    if (!creds) { toast('Belum ada credentials Google', 'err'); return; }
    const folderId = $('#driveFolderSel')?.value || null;
    const result = await api('/api/drive/files', { method: 'POST', body: JSON.stringify({ ...creds, folderId }) });
    const list = $('#driveFilesList');
    if (!result.files || result.files.length === 0) {
      list.innerHTML = '<div class="empty">Tidak ada video ditemukan</div>';
      return;
    }
    list.innerHTML = result.files.map(f => `
      <div class="drive-file">
        <div class="drive-file-meta">
          <span class="drive-file-name">${esc(f.name)}</span>
          <span class="drive-file-info">${f.sizeMB}MB • ${new Date(f.modifiedTime).toLocaleDateString('id-ID')}</span>
        </div>
        <button class="drive-file-btn" data-file-id="${esc(f.id)}" data-file-name="${esc(f.name)}">Download</button>
      </div>
    `).join('');
    $$('.drive-file-btn').forEach(btn => {
      btn.onclick = () => downloadDriveFile(btn.dataset.fileId, btn.dataset.fileName);
    });
  } catch (e) { toast('Gagal load file Drive: ' + e.message, 'err'); }
}

async function loadDriveFolders() {
  try {
    const creds = getDriveCredentials();
    if (!creds) { toast('Belum ada credentials Google', 'err'); return; }
    const result = await api('/api/drive/folders', { method: 'POST', body: JSON.stringify(creds) });
    const sel = $('#driveFolderSel');
    sel.innerHTML = '<option value="">Semua folder</option>' +
      (result.folders || []).map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
  } catch (e) { toast('Gagal load folder: ' + e.message, 'err'); }
}

async function downloadDriveFile(fileId, fileName) {
  try {
    const creds = getDriveCredentials();
    if (!creds) { toast('Belum ada credentials Google', 'err'); return; }
    toast('Download dimulai: ' + fileName);
    await api('/api/drive/download', { method: 'POST', body: JSON.stringify({ ...creds, fileId }) });
    driveDownloads[fileId] = { fileName, status: 'downloading', percent: 0 };
    pollDriveProgress(fileId);
  } catch (e) { toast('Gagal download: ' + e.message, 'err'); }
}

async function pollDriveProgress(fileId) {
  const maxTries = 300;
  let tries = 0;
  const poll = async () => {
    tries++;
    try {
      const prog = await api(`/api/drive/progress?fileId=${encodeURIComponent(fileId)}`);
      driveDownloads[fileId] = prog;
      renderDriveProgress();
      if (prog.status === 'done') {
        toast('Download selesai: ' + prog.fileName, 'ok');
        await new Promise(r => setTimeout(r, 1000));
        refresh();
      } else if (prog.status === 'error') {
        toast('Download gagal: ' + prog.error, 'err');
      } else if (prog.status === 'downloading' && tries < maxTries) {
        setTimeout(poll, 500);
      }
    } catch (e) {
      if (tries < maxTries) setTimeout(poll, 1000);
    }
  };
  poll();
}

function renderDriveProgress() {
  const box = $('#driveDownloadProgress');
  if (Object.keys(driveDownloads).length === 0) {
    box.innerHTML = '<p class="muted">Tidak ada download aktif</p>';
    return;
  }
  box.innerHTML = Object.entries(driveDownloads).map(([fid, prog]) => `
    <div class="drive-progress">
      <div class="drive-progress-text">
        <span>${esc(prog.fileName)}</span>
        <span>${prog.percent}%</span>
      </div>
      <div class="drive-progress-bar">
        <div class="drive-progress-fill" style="width:${prog.percent}%"></div>
      </div>
      <div class="drive-progress-text">
        <span>${prog.status}</span>
        <span>${prog.downloaded ? (prog.downloaded / 1024 / 1024).toFixed(1) : 0}MB / ${prog.fileSize ? (prog.fileSize / 1024 / 1024).toFixed(1) : '?'}MB</span>
      </div>
    </div>
  `).join('');
}

$$('input[name="driveCredType"]').forEach(r => {
  r.onchange = () => {
    const custom = document.querySelector('input[name="driveCredType"]:checked').value === 'custom';
    $('#driveCustomWrap').style.display = custom ? 'block' : 'none';
    if (custom) loadDriveFolders();
  };
});

$('#btnDriveAuth')?.addEventListener('click', async () => {
  const cid = $('#driveClientId')?.value || '';
  const cs = $('#driveClientSecret')?.value || '';
  if (!cid || !cs) { toast('Isi Client ID & Secret dulu', 'err'); return; }
  try {
    const result = await api('/api/drive/auth-url', { method: 'POST', body: JSON.stringify({ clientId: cid, clientSecret: cs }) });
    window.open(result.authUrl, '_blank');
  } catch (e) { toast('Gagal buat auth URL: ' + e.message, 'err'); }
});

$('#btnDriveExchange')?.addEventListener('click', async () => {
  const cid = $('#driveClientId')?.value || '';
  const cs = $('#driveClientSecret')?.value || '';
  const code = $('#driveCode')?.value || '';
  if (!cid || !cs || !code) { toast('Isi semua field dulu', 'err'); return; }
  try {
    const result = await api('/api/drive/exchange', { method: 'POST', body: JSON.stringify({ clientId: cid, clientSecret: cs, code }) });
    $('#driveRefresh').value = result.refreshToken;
    toast('Token berhasil ditukar', 'ok');
    loadDriveFolders();
  } catch (e) { toast('Gagal tukar kode: ' + e.message, 'err'); }
});

$('#btnRefreshFolders')?.addEventListener('click', loadDriveFolders);
$('#driveFolderSel')?.addEventListener('change', loadDriveFiles);

// ---------- Status bar footer: render, auto-post, jadwal, download ----------
let sbTz = 'Asia/Jakarta';
function fmtDur(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}j ${m}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}d`;
  return `${sec}d`;
}
function fmtClock(iso) {
  try { return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: sbTz }); }
  catch { return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); }
}

async function updateStatusBar() {
  // --- kompilasi & render ---
  let cs = null;
  try { cs = await api('/api/compile/status'); } catch {}
  const elC = $('#sbCompile'), elR = $('#sbRender');
  if (cs) {
    // Jadwal berjalan di server; buka panel animasi otomatis di browser.
    if (cs.running && !compilePolling) {
      showCompileLoading('Sedang membuat video dari jadwal');
      pollCompile();
    }
    if (cs.running) {
      const logs = (cs.logs || []).join('\n');
      const pm = [...logs.matchAll(/render (\d+)%/g)];
      const pct = pm.length ? pm[pm.length - 1][1] : null;
      const step = (cs.logs || []).filter(l => !l.startsWith('  render')).slice(-1)[0] || '';
      elC.innerHTML = `<span class="sb-dot run"></span> Kompilasi berjalan`;
      if (elR) elR.innerHTML = pct !== null
        ? `🎬 Render <b>${pct}%</b>`
        : `⏳ ${esc(step.slice(0, 42))}`;
    } else if (cs.error) {
      elC.innerHTML = `<span class="sb-dot err"></span> Kompilasi gagal`;
      if (elR) elR.textContent = '';
    } else if (cs.result && cs.result.outName) {
      elC.innerHTML = `<span class="sb-dot ok"></span> Selesai: <b>${esc(cs.result.count)}</b> video`;
      if (elR) elR.textContent = `🎬 ${cs.result.duration ? cs.result.duration.toFixed(0) + 's' : ''}`;
    } else {
      elC.innerHTML = `<span class="sb-dot"></span> Siaga`;
      if (elR) elR.textContent = '';
    }
    // --- log terakhir ---
    const last = (cs.logs || []).slice(-1)[0] || '';
    $('#sbLog').textContent = last;
  }

  // --- jadwal: hitungan mundur ---
  try {
    const r = await api('/api/schedules');
    const list = (r.schedules || []).filter(s => s.enabled);
    const elS = $('#sbSchedule');
    if (!list.length) {
      elS.innerHTML = `<span class="sb-dot"></span> Jadwal: tidak ada`;
    } else {
      const next = list
        .filter(s => s.nextRunAt)
        .sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt))[0];
      if (next) {
        const ms = Math.max(0, new Date(next.nextRunAt).getTime() - Date.now());
        const endMs = new Date(next.nextRunAt).getTime();
        const startMs = next.lastRun ? new Date(next.lastRun).getTime() : new Date(next.createdAt || Date.now()).getTime();
        const span = Math.max(1, endMs - startMs);
        const frac = Math.min(1, Math.max(0, (Date.now() - startMs) / span));
        const pct = Math.round(frac * 100);
        elS.innerHTML = `<span class="sb-dot wait"></span><div class="sb-sched"><span class="sb-sched-text">🗓 <b>${esc(next.name)}</b> ${fmtClock(next.nextRunAt)} • <b>${fmtDur(ms)}</b> lagi</span><div class="sb-progress"><div class="sb-progress-fill" style="width:${pct}%"></div></div></div>`;
      } else {
        elS.innerHTML = `<span class="sb-dot"></span> 🗓 ${list.length} jadwal aktif`;
      }
    }
  } catch {}

  // --- download Drive (bila ada) ---
  const dls = Object.entries(driveDownloads || {}).filter(([, d]) => d.status === 'downloading');
  const elD = $('#sbDownload');
  elD.innerHTML = dls.length
    ? `<span class="sb-dot run"></span> ⬇ ${esc(dls[0][1].fileName.slice(0, 18))} <b>${dls[0][1].percent}%</b>${dls.length > 1 ? ` (+${dls.length - 1})` : ''}`
    : '';
}

// timezone untuk tampilan jam jadwal
fetch('/api/status').then(r => r.json()).then(s => { if (s.timezone) sbTz = s.timezone; }).catch(() => {});

refresh();
setInterval(refresh, 10000);
loadOutputs();
setInterval(loadOutputs, 15000);
loadSchedules();
setInterval(loadSchedules, 30000);
loadSavedLinks();
applySourceUI();
loadDriveFolderFiles();
setInterval(updateStatusBar, 1000);
updateStatusBar();
// hitung video bila link sudah terisi (mis. dari pilihan sebelumnya)
setTimeout(() => { if ($('#compileFolderLink')?.value) checkFolderCount(); }, 800);
