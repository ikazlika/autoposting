// Entry point: tanpa argumen = mode scheduler, dengan --now = posting sekali langsung
//   npm start            -> scheduler (jadwal dari .env POST_SCHEDULE)
//   npm run post         -> posting 1 video berikutnya sekarang
//   node src/post.js --now --platform=youtube  -> hanya ke YouTube
//   node src/post.js --now --file=videos/xxx.mp4 -> file spesifik

if (process.argv.includes('--now') || process.argv.includes('--file=')) {
  require('./post');
} else {
  require('./scheduler');
}
