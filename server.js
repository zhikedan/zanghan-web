'use strict';
/**
 * 藏汉翻译通 · 网页版 —— 本地服务
 *
 * 职责：
 *   1) 提供静态页面
 *   2) 翻译代理（优先 Bing 免 Key，可选微软 Key 提升额度）
 *   3) 内置词典查询（本地词库）
 *
 * 零依赖，只需 Node.js 18+
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

let bing = null;
try { bing = require('./bing.js'); } catch (e) { console.log('[bing] 模块加载失败:', e.message); }

const APP_DIR = __dirname;
const PORT = Number(process.env.PORT || 5300);

/* ---------------------------------------------------------------- 配置 */
let CFG = { ms_key: '', ms_region: '', port: PORT };
try {
  const raw = fs.readFileSync(path.join(APP_DIR, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
  Object.assign(CFG, JSON.parse(raw));
} catch (e) { /* 没有配置就用默认 */ }
const LISTEN_PORT = Number(CFG.port) || PORT;

/* ---------------------------------------------------------------- 词库 */
let DICT = { words: [], big: [], terms: [] };
try {
  const raw = fs.readFileSync(path.join(APP_DIR, 'dict.json'), 'utf8').replace(/^\uFEFF/, '');
  DICT = JSON.parse(raw);
} catch (e) { console.log('[dict] 未找到 dict.json，词典功能将为空'); }

/* ---------------------------------------------------------------- 工具 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function send(res, code, body, type) {
  const headers = { 'Content-Type': type || 'text/plain; charset=utf-8' };
  res.writeHead(code, headers);
  res.end(body);
}

function sendJson(res, obj) {
  send(res, 200, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** POST 到微软 Translator */
function msTranslate(text, from, to) {
  return new Promise((resolve, reject) => {
    if (!CFG.ms_key) {
      return reject(new Error('NO_KEY'));
    }
    const payload = JSON.stringify([{ Text: text }]);
    const headers = {
      'Ocp-Apim-Subscription-Key': CFG.ms_key,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (CFG.ms_region) headers['Ocp-Apim-Subscription-Region'] = CFG.ms_region;

    const p = `/translate?api-version=3.0&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const req = https.request({
      hostname: 'api.cognitive.microsofttranslator.com',
      port: 443, path: p, method: 'POST', headers, timeout: 20000,
    }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        const body = Buffer.concat(c).toString('utf8');
        if (res.statusCode !== 200) {
          return reject(new Error(`MS_${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try {
          const j = JSON.parse(body);
          resolve(j[0] && j[0].translations && j[0].translations[0] && j[0].translations[0].text || '');
        } catch (e) { reject(new Error('MS_PARSE: ' + body.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('MS_TIMEOUT')); });
    req.write(payload);
    req.end();
  });
}

/* ---------------------------------------------------------------- 词典检索 */
function norm(s) {
  return String(s || '').trim().toLowerCase();}

/** 在本地词库中查找：完全匹配 > 前缀 > 包含 */
function lookupDict(q) {
  const key = norm(q);
  if (!key) return [];
  const out = [];
  const seen = new Set();

  const push = (item, kind) => {
    const id = kind + '|' + item.bo + '|' + item.zh;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(Object.assign({ source: kind }, item));
  };

  for (const src of ['big', 'words', 'terms']) {
    const list = DICT[src] || [];
    for (const it of list) {
      const bo = norm(it.bo), zh = norm(it.zh), py = norm(it.py);
      if (zh === key || bo === key || py === key) push(it, src);
    }
  }
  if (out.length) return out.slice(0, 50);

  // 前缀 / 包含
  for (const src of ['big', 'words', 'terms']) {
    const list = DICT[src] || [];
    for (const it of list) {
      const bo = norm(it.bo), zh = norm(it.zh), py = norm(it.py);
      if (zh.startsWith(key) || bo.startsWith(key) || py.startsWith(key)) push(it, src);
    }
  }
  if (out.length) return out.slice(0, 50);

  for (const src of ['big', 'words', 'terms']) {
    const list = DICT[src] || [];
    for (const it of list) {
      const bo = norm(it.bo), zh = norm(it.zh);
      if (zh.includes(key) || bo.includes(key)) push(it, src);
    }
  }
  return out.slice(0, 50);
}

/* ---------------------------------------------------------------- 路由 */
const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    /* ---------- API ---------- */
    if (p === '/api/status') {
      return sendJson(res, {
        ok: true,
        hasKey: true,                        // Bing 免 Key，翻译始终可用
        engine: CFG.ms_key ? 'microsoft' : 'bing',
        msConfigured: !!CFG.ms_key,
        region: CFG.ms_region || '',
        dict: {
          words: (DICT.words || []).length,
          big: (DICT.big || []).length,
          terms: (DICT.terms || []).length,
        },
        version: '1.1.0',
      });
    }

    if (p === '/api/dict') {
      const q = u.query.q || '';
      return sendJson(res, { ok: true, q, items: lookupDict(q) });
    }

    if (p === '/api/translate' && req.method === 'POST') {
      const buf = await readBody(req);
      let data = {};
      try { data = JSON.parse(buf.toString('utf8')); } catch (e) {}
      const text = String(data.text || '').trim();
      const from = String(data.from || 'zh-Hans');
      const to = String(data.to || 'bo');
      if (!text) return sendJson(res, { ok: false, error: 'EMPTY_TEXT' });
      if (text.length > 5000) return sendJson(res, { ok: false, error: 'TOO_LONG' });

      // 1) 优先微软（若配置了 Key，额度更稳）
      if (CFG.ms_key) {
        try {
          const out = await msTranslate(text, from, to);
          return sendJson(res, { ok: true, text: out, from, to, engine: 'microsoft' });
        } catch (e) {
          // 微软失败则回落到 Bing
        }
      }

      // 2) Bing 免费通道
      if (bing) {
        try {
          const r = await bing.translate(text, from, to);
          return sendJson(res, { ok: true, text: r.text, from, to, engine: 'bing', detected: r.detected });
        } catch (e) {
          return sendJson(res, { ok: false, error: e.message, hint: 'Bing 翻译暂时不可用，请稍后重试' });
        }
      }

      return sendJson(res, { ok: false, error: 'NO_ENGINE', hint: '翻译引擎未就绪' });
    }

    /* ---------- 静态 ---------- */
    let file = p === '/' ? '/index.html' : p;
    const fp = path.join(APP_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!fp.startsWith(APP_DIR)) return send(res, 403, '403');
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      return send(res, 404, '404 Not Found');
    }
    const ext = path.extname(fp).toLowerCase();
    const body = fs.readFileSync(fp);
    return send(res, 200, body, MIME[ext] || 'application/octet-stream');

  } catch (e) {
    return sendJson(res, { ok: false, error: e.message });
  }
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  const line = '='.repeat(52);
  console.log('\n' + line);
  console.log('  藏汉翻译通 · 网页版');
  console.log(line);
  console.log('  地址   http://127.0.0.1:' + LISTEN_PORT);
  console.log('  翻译源 ' + (CFG.ms_key ? '微软 Translator（已配置 Key）' : 'Bing 免费通道（无需 Key）'));
  console.log('  词库   藏汉 ' + (DICT.words || []).length +
              ' · 大辞典 ' + (DICT.big || []).length +
              ' · 新术语 ' + (DICT.terms || []).length);
  console.log(line + '\n');
  console.log('  关闭本窗口即停止服务\n');
});
