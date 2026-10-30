const fs = require('fs');
const path = require('path');

const ENV_PATH = path.resolve(__dirname, '..', '.env');

function parseEnv(content) {
  const out = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1);
    out[k] = v;
  }
  return out;
}

function getSettings() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  const env = parseEnv(raw);
  return {
    POST_SCHEDULE: env.POST_SCHEDULE || '0 10,18 * * *',
    TIMEZONE: env.TIMEZONE || 'Asia/Jakarta',
    POST_STRATEGY: (env.POST_STRATEGY || 'all').toLowerCase(),
    POST_GROUP: (env.POST_GROUP || '').trim(),
    YT_PRIVACY_STATUS: env.YT_PRIVACY_STATUS || 'private',
    YT_CATEGORY_ID: env.YT_CATEGORY_ID || '22',
    YT_DEFAULT_TAGS: env.YT_DEFAULT_TAGS || 'shorts,reels,viral',
    YT_DEFAULT_DESC: env.YT_DEFAULT_DESC || '#Shorts',
    FB_USE_REELS: env.FB_USE_REELS || 'true',
    FB_DEFAULT_DESC: env.FB_DEFAULT_DESC || '#Reels',
    ENABLE_YOUTUBE: env.ENABLE_YOUTUBE || 'true',
    ENABLE_FACEBOOK: env.ENABLE_FACEBOOK || 'true',
    PORT: env.PORT || '8787',
  };
}

function saveSettings(patch) {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  for (const [k, v] of Object.entries(patch)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, `${k}=${v}`);
    } else {
      content = content.trimEnd() + `\n${k}=${v}\n`;
    }
  }
  fs.writeFileSync(ENV_PATH, content);
  // refresh process.env agar langsung kepakai tanpa restart (untuk schedule dll perlu restart scheduler)
  for (const [k, v] of Object.entries(patch)) process.env[k] = v;
}

module.exports = { getSettings, saveSettings, ENV_PATH };
