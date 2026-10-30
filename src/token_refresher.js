const axios = require('axios');
const { loadAccounts, saveAccounts, updateAccount } = require('./accounts');

async function perpanjangToken(tokenLama) {
  const APP_ID = process.env.APP_ID;
  const APP_SECRET = process.env.APP_SECRET;
  if (!APP_ID || !APP_SECRET) throw new Error('APP_ID atau APP_SECRET tidak dikonfigurasi di .env');
  
  const url = `https://graph.facebook.com/v19.0/oauth/access_token`;
  const res = await axios.get(url, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: APP_ID,
      client_secret: APP_SECRET,
      fb_exchange_token: tokenLama,
    },
  });
  return res.data;
}

async function dapatkanPageToken(userAccessToken, pageId, pageName) {
  try {
    const res = await axios.get(`https://graph.facebook.com/v19.0/me/accounts`, {
      params: { access_token: userAccessToken, fields: 'id,name,access_token' },
    });
    const pages = res.data.data || [];
    let matched = pages.find(p => p.id === pageId);
    if (!matched && pageName) matched = pages.find(p => p.name === pageName);
    if (!matched && pages.length === 1) matched = pages[0];
    if (matched) return { pageId: matched.id, pageName: matched.name, accessToken: matched.access_token };
    return null;
  } catch (e) {
    console.error(`[FB] Gagal ambil page token: ${e.message}`);
    return null;
  }
}

async function refreshAllTokens(force = false) {
  const data = loadAccounts();
  const results = { sukses: [], gagal: [] };
  
  for (const acc of data.facebook || []) {
    if (!acc.token) continue;
    
    const expiredAt = acc.expired_at || acc.expiredAt;
    const now = Date.now();
    const daysLeft = expiredAt ? Math.ceil((new Date(expiredAt).getTime() - now) / 86400000) : null;
    
    const needsRefresh = force || (daysLeft !== null && daysLeft < 7);
    if (!needsRefresh) continue;
    
    try {
      const refreshed = await perpanjangToken(acc.token);
      const newExpiredAt = new Date(now + refreshed.expires_in * 1000).toISOString();
      
      let pageToken = acc.token;
      let pageId = acc.pageId;
      let pageName = acc.pageName;
      
      if (acc.pageId) {
        const pageData = await dapatkanPageToken(refreshed.access_token, acc.pageId, acc.pageName);
        if (pageData) {
          pageToken = pageData.accessToken;
          pageId = pageData.pageId;
          pageName = pageData.pageName;
        }
      } else if (acc.pageName) {
        const pageData = await dapatkanPageToken(refreshed.access_token, null, acc.pageName);
        if (pageData) {
          pageToken = pageData.accessToken;
          pageId = pageData.pageId;
          pageName = pageData.pageName;
        }
      }
      
      updateAccount('facebook', acc.name, {
        user_access_token: refreshed.access_token,
        expired_at: newExpiredAt,
        token: pageToken,
        pageId,
        pageName,
        expired: false,
      });
      
      const sisa = Math.ceil(refreshed.expires_in / 86400);
      const msg = `[AUTO REFRESH] Sukses perpanjang token ${acc.pageName || acc.name}, sisa ${sisa} hari`;
      console.log(msg);
      results.sukses.push(acc.name);
    } catch (e) {
      const msg = `[AUTO REFRESH][GAGAL] ${acc.pageName || acc.name}: ${e.message}`;
      console.error(msg);
      results.gagal.push({ name: acc.name, error: e.message });
    }
  }
  
  return results;
}

module.exports = { perpanjangToken, refreshAllTokens, dapatkanPageToken };
