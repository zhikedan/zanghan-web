'use strict';
/**
 * Bing 免费翻译（无需 API Key）
 *
 * 原理：Bing 翻译网页版自带匿名 token，从页面提取后调用 ttranslatev3。
 * 支持藏文（bo / བོད་སྐད་），每月无硬性额度。
 *
 * token 有效期约 10 分钟，这里做内存缓存 + 过期重取。
 */

const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HOSTS = ['cn.bing.com', 'www.bing.com'];

/** 极简 https 请求 */
function request(opts, body, timeout = 20000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ s: 'TIMEOUT', b: '' }), timeout);
    const r = https.request(opts, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        clearTimeout(t);
        resolve({ s: res.statusCode, b: Buffer.concat(c).toString('utf8'), h: res.headers });
      });
    });
    r.on('error', (e) => { clearTimeout(t); resolve({ s: 'ERR ' + e.message, b: '' }); });
    r.on('timeout', () => { r.destroy(); resolve({ s: 'TIMEOUT', b: '' }); });
    if (body) r.write(body);
    r.end();
  });
}

/** token 缓存 */
const cache = { host: null, IG: null, IID: null, key: null, time: null, cookie: '', ts: 0 };
const TTL = 8 * 60 * 1000;   // 8 分钟

/** 从页面提取 token */
async function fetchToken(force) {
  if (!force && cache.key && Date.now() - cache.ts < TTL) return cache;

  for (const host of HOSTS) {
    const page = await request({
      hostname: host, path: '/translator', method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
    });
    if (page.s !== 200 || !page.b) continue;

    const html = page.b;
    const pick = (re) => { const m = html.match(re); return m ? m[1] : null; };

    const IG = pick(/IG:"([^"]+)"/) || pick(/IG:'([^']+)'/);
    const IID = pick(/data-iid="([^"]+)"/) || pick(/IID:["']([^"']+)/) || 'translator.5023';
    const key = pick(/params_AbusePreventionHelper\s*=\s*\[[0-9]+\s*,\s*"([^"]+)"/);
    const time = pick(/params_AbusePreventionHelper\s*=\s*\[([0-9]+)/);

    if (!IG || !key) continue;

    const rawCookie = page.h && page.h['set-cookie'] ? page.h['set-cookie'] : [];
    const cookie = rawCookie.map((c) => c.split(';')[0]).join('; ');

    Object.assign(cache, { host, IG, IID, key, time, cookie, ts: Date.now() });
    return cache;
  }
  throw new Error('BING_TOKEN_FAILED');
}

/** 主翻译函数 */
async function translate(text, from, to) {
  let tok = await fetchToken(false);

  const body = new URLSearchParams({
    fromLang: from, to, text,
    token: tok.key, key: tok.time,
  }).toString();

  const doCall = async (t) => request({
    hostname: t.host,
    path: `/ttranslatev3?isVertical=1&IG=${encodeURIComponent(t.IG)}&IID=${encodeURIComponent(t.IID)}`,
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'Referer': `https://${t.host}/translator`,
      'Origin': `https://${t.host}`,
      'Cookie': t.cookie,
    },
  }, body);

  let res = await doCall(tok);

  // token 失效 → 重取一次
  if (res.s !== 200 || !res.b || res.b.trim().startsWith('<')) {
    tok = await fetchToken(true);
    const body2 = new URLSearchParams({
      fromLang: from, to, text, token: tok.key, key: tok.time,
    }).toString();
    res = await request({
      hostname: tok.host,
      path: `/ttranslatev3?isVertical=1&IG=${encodeURIComponent(tok.IG)}&IID=${encodeURIComponent(tok.IID)}`,
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body2),
        'Referer': `https://${tok.host}/translator`,
        'Origin': `https://${tok.host}`,
        'Cookie': tok.cookie,
      },
    }, body2);
  }

  if (res.s !== 200) throw new Error('BING_HTTP_' + res.s);

  let j;
  try { j = JSON.parse(res.b); } catch (e) { throw new Error('BING_PARSE: ' + res.b.slice(0, 100)); }

  if (j && j.statusCode && j.statusCode !== 200) {
    throw new Error('BING_' + (j.statusCode) + ': ' + (j.errorMessage || ''));
  }
  const first = Array.isArray(j) ? j[0] : j;
  if (!first || !first.translations || !first.translations[0]) {
    throw new Error('BING_EMPTY: ' + res.b.slice(0, 150));
  }
  return {
    text: first.translations[0].text,
    detected: (first.detectedLanguage && first.detectedLanguage.language) || from,
  };
}

module.exports = { translate, fetchToken };

// 自测
if (require.main === module) {
  (async () => {
    const text = process.argv[2] || '吉祥如意';
    const from = process.argv[3] || 'zh-Hans';
    const to = process.argv[4] || 'bo';
    console.log(`翻译 "${text}"  ${from} -> ${to}`);
    try {
      const r = await translate(text, from, to);
      console.log('结果:', r.text);
      console.log('检测:', r.detected);
    } catch (e) {
      console.log('失败:', e.message);
    }
  })();
}
