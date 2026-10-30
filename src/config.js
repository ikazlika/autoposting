require('dotenv').config();
const path = require('path');

function getBool(v, def = false) {
  if (v === undefined) return def;
  return String(v).toLowerCase() === 'true';
}

const config = {
  videosDir: path.resolve(process.env.VIDEOS_DIR || './videos'),
  postedDb: path.resolve(process.env.POSTED_DB || './data/posted.json'),
  accountsFile: path.resolve(process.env.ACCOUNTS_FILE || './data/accounts.json'),
  groupsFile: path.resolve(process.env.GROUPS_FILE || './data/groups.json'),
  // Strategi multi-akun: "all" = 1 video diposting ke SEMUA akun sekaligus,
  // "rotate" = tiap jadwal giliran 1 akun (hemat kuota YouTube).
  postStrategy: (process.env.POST_STRATEGY || 'all').toLowerCase(),
  // Grup tujuan scheduler: "" = semua akun, "rotate" = giliran grup, atau nama/id grup.
  postGroup: (process.env.POST_GROUP || '').trim(),
  supportedExt: (process.env.SUPPORTED_EXT || 'mp4,mov,webm,mkv').split(',').map(s => s.trim().toLowerCase()),
  deleteAfterPost: getBool(process.env.DELETE_AFTER_POST, false),
  port: parseInt(process.env.PORT || '3000', 10),

  schedule: process.env.POST_SCHEDULE || '0 10,18 * * *',
  timezone: process.env.TIMEZONE || 'Asia/Jakarta',

  enableYouTube: getBool(process.env.ENABLE_YOUTUBE, true),
  enableFacebook: getBool(process.env.ENABLE_FACEBOOK, true),

  youtube: {
    clientId: process.env.YT_CLIENT_ID || '',
    clientSecret: process.env.YT_CLIENT_SECRET || '',
    refreshToken: process.env.YT_REFRESH_TOKEN || '',
    privacyStatus: process.env.YT_PRIVACY_STATUS || 'public', // public | unlisted | private
    categoryId: process.env.YT_CATEGORY_ID || '22',
    defaultTags: (process.env.YT_DEFAULT_TAGS || 'shorts').split(',').map(s => s.trim()).filter(Boolean),
    defaultDesc: process.env.YT_DEFAULT_DESC || '#Shorts',
  },

  facebook: {
    pageId: process.env.FB_PAGE_ID || '',
    token: process.env.FB_PAGE_ACCESS_TOKEN || '',
    apiVersion: process.env.FB_API_VERSION || 'v21.0',
    useReels: getBool(process.env.FB_USE_REELS, true),
    defaultDesc: process.env.FB_DEFAULT_DESC || '#Reels',
  },
};

module.exports = config;
