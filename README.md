# Auto-Posting YouTube Shorts + Facebook Reels 🎬

Upload otomatis video vertikal dari folder lokal ke **YouTube (sebagai Shorts)** dan **Facebook Page (sebagai Reels)**, dengan mode **manual + terjadwal (cron)**.

## 1. Cara kerja

```
videos/
  ├── video1.mp4          <- taruh video vertikal (9:16, <=60 dtk untuk Shorts)
  ├── video1.json         <- (opsional) judul/deskripsi/tags khusus video ini
  ├── video2.mp4
  └── ...

npm run post   -> posting 1 video berikutnya SEKARANG
npm start      -> jalan terjadwal sesuai POST_SCHEDULE di .env
```

- Urutan posting = urutan abjad file. Video yang sudah sukses dicatat di `data/posted.json` agar tidak diposting ulang.
- Metadata per video: buat file JSON dengan nama sama seperti videonya.
  Contoh `videos/video1.json`:
  ```json
  {
    "title": "Momen lucu kucing #Shorts",
    "description": "Follow untuk video lucu tiap hari! #kucing #lucu",
    "tags": ["kucing", "lucu", "shorts"]
  }
  ```
  Jika tidak ada file JSON, judul diambil dari nama file.

## 2. Install & Cara Jalankan Cepat (Windows)

Double-klik file BAT — tidak perlu buka terminal manual:

| File | Fungsi |
|------|--------|
| `INSTALL.bat` | Install dependencies (sekali saja) |
| `BUKA-UI.bat` | Buka **dashboard web** di http://localhost:3000 |
| `SETUP-AKUN.bat` | Input credential banyak akun (CLI) |
| `POST-NOW.bat` | Posting 1 video sekarang (semua akun) |
| `JALANKAN-SCHEDULER.bat` | Jalan terjadwal sesuai `POST_SCHEDULE` |
| `AUTH-YOUTUBE.bat` | Dapatkan Refresh Token YouTube |

> Atau via terminal: `npm install` → `npm run ui` (dashboard), `npm run post`, `npm start`.

## 3. Dashboard Web (antarmuka)

Jalankan `BUKA-UI.bat` atau `npm run ui` → buka http://localhost:3000 (port diatur di `.env` `PORT=...`).

Fitur dashboard:
- **Antrean video**: lihat video di `videos/`, edit judul/deskripsi/tags per file, tombol posting per file
- **Akun**: tambah/hapus/aktifkan YouTube & Facebook langsung tanpa edit file
- **Posting**: pilih platform / akun / strategi (`all` vs `rotate`) → Posting sekarang
- **Riwayat & Log**: lihat `data/posted.json` & log posting live (auto-refresh tiap 8 dtk)

## 4. Grup Multi Upload

Kelompokkan akun agar **1 video langsung diunggah ke beberapa akun sekaligus**.

- Buka **Channel → Grup Multi Upload → + Grup**.
- Pilih anggota grup (mis. Grup 1 = FB1 + YT1, Grup 2 = YT2 + FB2).
- Di sidebar kanan, pilih **Tujuan multi upload → Grup 1 / Grup 2**, lalu klik **Posting**.
- Pilihan **Manual (1 akun)** tetap tersedia untuk upload ke satu akun saja.
- Scheduler: **Pengaturan → Grup untuk scheduler**:
  - `Semua akun` = perilaku lama (semua akun aktif).
  - `Rotasi grup` = tiap jadwal bergiliran Grup 1 → Grup 2.
  - Grup tertentu = selalu upload ke grup itu.
- Anggota grup yang nonaktif/token expired otomatis dilewati dan ditandai ⚠ di dashboard.

Data grup tersimpan di `data/groups.json` (diatur lewat `GROUPS_FILE`).

## 5. Input Credential Banyak Akun (CLI)

Jalankan menu interaktif — tidak perlu edit file manual:

```bash
npm run setup
```

Menu: tambah / lihat / hapus / aktif-nonaktif akun YouTube & Facebook.
Data tersimpan di `data/accounts.json` (jangan dishare, sudah di-gitignore).
Contoh format: lihat `data/accounts.example.json`.

- **YouTube per akun:** `nama + Client ID + Client Secret + Refresh Token`.
  1 OAuth Client bisa dipakai banyak channel — yang beda tiap akun adalah
  Refresh Token-nya (dapat via `npm run auth:youtube` sambil login channel berbeda).
- **Facebook per Page:** `nama + Page ID + Page Access Token`.

> Mode lama (1 akun via `.env`) tetap didukung sebagai fallback bila
> `data/accounts.json` masih kosong.

## 6. Setup YouTube manual (tanpa dashboard)

1. Buka https://console.cloud.google.com
2. Buat project baru → aktifkan **YouTube Data API v3**
3. Menu Credentials → Create Credentials → **OAuth Client ID** → tipe **Desktop App**
4. Copy `Client ID` & `Client Secret` ke `.env` (`YT_CLIENT_ID`, `YT_CLIENT_SECRET`)
5. Jalankan:
   ```bash
   npm run auth:youtube
   ```
   Buka URL-nya, login Google, paste kode → dapat `refresh_token` → masukkan ke `.env` sebagai `YT_REFRESH_TOKEN`

> Kuota gratis YouTube: 10.000 unit/hari, 1 upload ≈ 1600 unit (≈ 6 video/hari).

## 7. Setup Facebook Page manual (tanpa dashboard)

1. Buka https://developers.facebook.com → buat App
2. Tambahkan produk **Facebook Login** / dapatkan **Page Access Token** dengan permission:
   `pages_manage_posts`, `pages_read_engagement`
   Cara cepat: Graph API Explorer → pilih Page Anda → Generate Token.
3. Cari Page ID di https://www.facebook.com → About Page, atau via Graph: `me/accounts`
4. Isi ke `.env`:
   ```
   FB_PAGE_ID=...
   FB_PAGE_ACCESS_TOKEN=...
   ```
5. `FB_USE_REELS=true` = upload sebagai Reels. Jika gagal, otomatis fallback ke `/videos` biasa.

## 8. Penggunaan (terminal)

```bash
# Posting 1 video berikutnya sekarang (ke semua akun + platform aktif)
npm run post

# Hanya ke YouTube / hanya Facebook
node src/post.js --now --platform=youtube
node src/post.js --now --platform=facebook

# Hanya ke 1 akun tertentu
node src/post.js --now --account=akun1
node src/post.js --now --platform=youtube --account=channel-utama

# Strategi rotate (giliran 1 akun per jadwal, hemat kuota YouTube)
node src/post.js --now --strategy=rotate
# Atur default di .env: POST_STRATEGY=all|rotate

# Posting ke grup tertentu (multi upload ke semua anggota grup)
node src/post.js --now --group="Grup 1"

# File spesifik
node src/post.js --now --file=videos/videoku.mp4

# Mode terjadwal (default npm start)
npm start
# Jadwal diatur di .env POST_SCHEDULE, contoh "0 10,18 * * *" = tiap hari jam 10 & 18 WIB
```

Strategi multi-akun (`POST_STRATEGY`):
- `all` (default) = 1 video diposting ke SEMUA akun sekaligus.
- `rotate` = tiap jadwal hanya giliran 1 akun YouTube + 1 akun Facebook
  (disarankan bila banyak akun & kuota YouTube terbatas: 1 upload ≈ 1600 unit).

## 9. Konfigurasi penting (.env)

| Key | Fungsi |
|-----|--------|
| `POST_SCHEDULE` | Jadwal cron. Cek di https://crontab.guru |
| `ENABLE_YOUTUBE` / `ENABLE_FACEBOOK` | Nyalakan/matikan platform |
| `YT_PRIVACY_STATUS` | `public` / `unlisted` / `private` (test pakai `unlisted` dulu) |
| `FB_USE_REELS` | `true` = Reels, `false` = video biasa |
| `DELETE_AFTER_POST` | `true` = hapus file setelah sukses posting |
| `POST_STRATEGY` | `all` = ke semua akun, `rotate` = giliran 1 akun per jadwal |
| `POST_GROUP` | Grup scheduler: kosong = semua akun, `rotate` = giliran grup, atau nama/id grup |
| `ACCOUNTS_FILE` | Lokasi file multi-akun (default `./data/accounts.json`) |
| `GROUPS_FILE` | Lokasi file grup multi upload (default `./data/groups.json`) |

## 10. Syarat video Shorts/Reels

- Rasio **9:16 vertikal** (1080x1920), format MP4 (H.264 + AAC)
- Durasi **<= 60 detik** untuk Shorts, <= 90 detik untuk Reels
- Judul/deskripsi otomatis ditambah `#Shorts` agar terbaca YouTube Shorts
