require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const FINESA_URL = process.env.FINESA_BASE_URL || 'https://pagos.finesa.com.co';

const CAPSOLVER_KEY = process.env.CAPSOLVER_KEY || '';
const RECAPTCHA_SITEKEY = '6LddR80oAAAAADtO0X7hLL55sKnYVNvODdu_xVst';
const TURNSTILE_SITEKEY = '0x4AAAAAAFAMEbzOhnNsw4Vz';

const GEONODE_HOST = process.env.GEONODE_HOST || '92.204.171.83';
const GEONODE_PORT = process.env.GEONODE_PORT || '10000';
const GEONODE_USER = process.env.GEONODE_USER || '';
const GEONODE_PASS = process.env.GEONODE_PASS || '';
const useProxy = !!GEONODE_USER;

const STICKY_FORMAT = process.env.STICKY_FORMAT || 'lifetime-5';

const JWT_TTL_MS = 10 * 60 * 1000;
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
const TOKEN_PREFETCH_TTL_MS = 100 * 1000;
const DELAY_BETWEEN_REQUESTS_MS = 1000;
const SESSION_TTL_MS = 15 * 60 * 1000;

let GLOBAL_HARVEST = null;
const HARVEST_TTL_MS = 15 * 60 * 1000;
const HARVEST_REFRESH_MS = 10 * 60 * 1000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const DOCUMENT_TYPES = {
  '1': 'Cédula de ciudadanía',
  '2': 'Cédula de extranjería',
  '3': 'NIT',
};

// ============================================================
// SESIONES
// ============================================================
const sessions = new Map();
const userIndex = new Map();
const priceCache = new Map();

function newSessionId(identification) {
  const ts = Date.now().toString(36);
  const rnd = crypto.randomBytes(4).toString('hex');
  return `${identification}-${ts}-${rnd}`;
}

function getSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (Date.now() > s.createdAt + SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }
  return s;
}

function setSession(sessionId, data) {
  sessions.set(sessionId, { ...data, createdAt: Date.now() });
}

// ============================================================
// PROXY
// ============================================================
function proxyUsername(sessionId) {
  if (!useProxy) return '';
  switch (STICKY_FORMAT) {
    case 'lifetime-5':  return `${GEONODE_USER}-lifetime-5`;
    case 'lifetime-10': return `${GEONODE_USER}-lifetime-10`;
    case 'lifetime-3':  return `${GEONODE_USER}-lifetime-3`;
    case 'session':     return `${GEONODE_USER}-session-${sessionId || 'fixed'}`;
    case 'sess':        return `${GEONODE_USER}-sess-${sessionId || 'fixed'}`;
    case 'none':        return GEONODE_USER;
    default:            return `${GEONODE_USER}-lifetime-5`;
  }
}

function proxyCurlArgs(sessionId) {
  if (!useProxy) return [];
  const sid = sessionId || 'fixed';
  return ['-x', `http://${proxyUsername(sid)}:${GEONODE_PASS}@${GEONODE_HOST}:${GEONODE_PORT}`];
}

// ============================================================
// HARVEST GLOBAL
// ============================================================
async function getGlobalHarvest() {
  if (GLOBAL_HARVEST && GLOBAL_HARVEST.expireAt > Date.now() && GLOBAL_HARVEST.cookies) {
    return GLOBAL_HARVEST;
  }

  if (GLOBAL_HARVEST && GLOBAL_HARVEST.promise) {
    return GLOBAL_HARVEST.promise;
  }

  GLOBAL_HARVEST = { promise: (async () => {
    console.log('[HARVEST-GLOBAL] Abriendo browser (esto se hace 1 vez cada 10 min)...');
    const start = Date.now();
    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());

    const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'];
    if (useProxy) args.push(`--proxy-server=http://${GEONODE_HOST}:${GEONODE_PORT}`);

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        args,
        executablePath: puppeteer.executablePath(),
      });
      const page = await browser.newPage();
      if (useProxy) await page.authenticate({ username: proxyUsername('global'), password: GEONODE_PASS });
      await page.setViewport({ width: 1366, height: 768 });
      await page.goto(`${FINESA_URL}/autenticacion`, { waitUntil: 'domcontentloaded', timeout: 30000 });

      const delay = ms => new Promise(r => setTimeout(r, ms));
      let ok = false;
      for (let i = 0; i < 15; i++) {
        const cookies = await page.cookies();
        if (cookies.some(c => c.name === 'XSRF-TOKEN')) { ok = true; break; }
        await delay(500);
      }
      if (!ok) { await browser.close(); throw new Error('harvest: sin XSRF-TOKEN'); }

      const cookies = await page.cookies();
      const parts = [];
      let xsrf = '';
      for (const c of cookies) {
        parts.push(`${c.name}=${c.value}`);
        if (c.name === 'XSRF-TOKEN') { try { xsrf = decodeURIComponent(c.value); } catch { xsrf = c.value; } }
      }
      if (!xsrf) { await browser.close(); throw new Error('harvest: XSRF vacío'); }

      const result = {
        cookies: parts.join('; '),
        xsrf,
        expireAt: Date.now() + HARVEST_TTL_MS,
        promise: null,
      };
      console.log(`[HARVEST-GLOBAL] ✓ ${cookies.length} cookies en ${((Date.now() - start) / 1000).toFixed(1)}s`);
      await browser.close();
      return result;
    } catch (e) {
      console.error('[HARVEST-GLOBAL] Error:', e.message);
      if (browser) try { await browser.close(); } catch {}
      throw e;
    }
  })() };

  try {
    const result = await GLOBAL_HARVEST.promise;
    GLOBAL_HARVEST = result;
    return result;
  } catch (e) {
    GLOBAL_HARVEST = null;
    throw e;
  }
}

async function warmupHarvest() {
  try {
    await getGlobalHarvest();
    console.log('[WARMUP] ✓ Harvest listo');
  } catch (e) {
    console.error('[WARMUP] Error:', e.message);
  }
}

setInterval(() => {
  if (!GLOBAL_HARVEST || !GLOBAL_HARVEST.expireAt || GLOBAL_HARVEST.expireAt < Date.now() + 5 * 60 * 1000) {
    console.log('[HARVEST-GLOBAL] Refrescando...');
    getGlobalHarvest().catch(e => console.error('[HARVEST-GLOBAL] Refresh error:', e.message));
  }
}, HARVEST_REFRESH_MS);

// ============================================================
// CAPSOLVER
// ============================================================
async function capsolverPost(endpoint, body) {
  const args = ['-s', '-X', 'POST', `https://api.capsolver.com/${endpoint}`, '-H', 'Content-Type: application/json', '--data-raw', JSON.stringify(body)];
  const { stdout } = await execFileAsync('curl', args, { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(stdout);
}

async function solveCaptcha(type, sitekey, pageUrl) {
  const startTime = Date.now();
  let taskType, extra = {};
  if (type === 'recaptchav3' || type === 'recaptcha') {
    taskType = 'ReCaptchaV3TaskProxyLess';
    extra = { pageAction: 'verify', minScore: 0.7 };
  } else {
    taskType = 'AntiTurnstileTaskProxyLess';
  }
  console.log(`[CAPSOLVER] Creando ${type}...`);
  const createRes = await capsolverPost('createTask', { clientKey: CAPSOLVER_KEY, task: { type: taskType, websiteURL: pageUrl, websiteKey: sitekey, ...extra } });
  if (createRes.errorId && createRes.errorId !== 0) throw new Error(`CapSolver: ${createRes.errorDescription || createRes.errorCode}`);
  if (createRes.solution) {
    const t = createRes.solution.gRecaptchaResponse || createRes.solution.token;
    console.log(`[CAPSOLVER] ✓ ${type} (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
    return t;
  }
  const taskId = createRes.taskId;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const poll = await capsolverPost('getTaskResult', { clientKey: CAPSOLVER_KEY, taskId });
    if (poll.status === 'ready') {
      const t = poll.solution.gRecaptchaResponse || poll.solution.token;
      console.log(`[CAPSOLVER] ✓ ${type} (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
      return t;
    }
    if (poll.errorId && poll.errorId !== 0) throw new Error(`CapSolver: ${poll.errorDescription}`);
  }
  throw new Error(`CapSolver timeout ${type}`);
}

// ============================================================
// PREFETCH turnstile paso 2 (por sesión)
// ============================================================
function prefetchStep2Tokens(sessionId) {
  solveCaptcha('turnstile', TURNSTILE_SITEKEY, `${FINESA_URL}/autenticacion`)
    .then(token => {
      const s = sessions.get(sessionId);
      if (s) {
        s.turnstilePrefetch = { token, at: Date.now() };
        console.log(`[PREFETCH] ✓ Turnstile listo para ${sessionId}`);
      }
    })
    .catch(e => console.error(`[PREFETCH] Error:`, e.message));
}

async function getStep2Turnstile(sessionId) {
  const s = sessions.get(sessionId);
  if (s && s.turnstilePrefetch && Date.now() - s.turnstilePrefetch.at < TOKEN_PREFETCH_TTL_MS && s.turnstilePrefetch.token) {
    console.log(`[PREFETCH] ♻ Usando turnstile prefetched (${((Date.now() - s.turnstilePrefetch.at) / 1000).toFixed(1)}s)`);
    const tok = s.turnstilePrefetch.token;
    s.turnstilePrefetch = null;
    return tok;
  }
  return solveCaptcha('turnstile', TURNSTILE_SITEKEY, `${FINESA_URL}/autenticacion`);
}

// ============================================================
// COOKIES
// ============================================================
function parseSetCookies(headerBlock) {
  const cookieMap = {};
  for (const line of headerBlock.split(/\r?\n/)) {
    const m = line.match(/^set-cookie:\s*([^=]+)=([^;]*)/i);
    if (m) cookieMap[m[1].trim()] = m[2].trim();
  }
  let xsrf = null;
  if (cookieMap['XSRF-TOKEN'] !== undefined) {
    try { xsrf = decodeURIComponent(cookieMap['XSRF-TOKEN']); } catch { xsrf = cookieMap['XSRF-TOKEN']; }
  }
  return { cookieMap, xsrf };
}

function buildCookieStringForSession(sessionId) {
  const s = sessions.get(sessionId);
  const cookieParts = {};

  if (GLOBAL_HARVEST && GLOBAL_HARVEST.cookies) {
    for (const pair of GLOBAL_HARVEST.cookies.split(';').map(x => x.trim()).filter(Boolean)) {
      const eq = pair.indexOf('=');
      if (eq >= 0) cookieParts[pair.substring(0, eq)] = pair.substring(eq + 1);
    }
  }

  let source = GLOBAL_HARVEST && GLOBAL_HARVEST.cookies ? 'harvest' : 'none';

  if (s && s.cookies && Object.keys(s.cookies).length > 0) {
    Object.assign(cookieParts, s.cookies);
    source = GLOBAL_HARVEST && GLOBAL_HARVEST.cookies ? 'harvest+session' : 'session';
  }

  return {
    cookieStr: Object.entries(cookieParts).map(([k, v]) => `${k}=${v}`).join('; '),
    cookieParts,
    source,
  };
}

function resolveXsrfForSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s && s.xsrf) return s.xsrf;
  if (GLOBAL_HARVEST && GLOBAL_HARVEST.xsrf) return GLOBAL_HARVEST.xsrf;
  return '';
}

function hasValidJwt(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || !s.cookies || !s.cookies['fastpay_jwt']) return false;
  if (!s.jwtAt) return true;
  return Date.now() - s.jwtAt < JWT_TTL_MS;
}

function isThrottled(data) {
  if (!data) return false;
  if (data.throttled === true) return true;
  if (typeof data.message === 'string' && data.message.includes('máximo de intentos')) return true;
  return false;
}

function isCsrfError(data) {
  return data && typeof data.error === 'string' && data.error.includes('No se pudo verificar la solicitud');
}

function isCloudflare1015(data) {
  if (!data) return false;
  if (typeof data._raw === 'string' && data._raw.includes('1015')) return true;
  if (typeof data.error === 'string' && data.error.includes('1015')) return true;
  if (typeof data.message === 'string' && data.message.includes('1015')) return true;
  return false;
}

function isServerError(data) {
  if (!data || typeof data._raw !== 'string') return false;
  return /error code: (5\d\d)/.test(data._raw);
}

// ============================================================
// LLAMADA FINESA
// ============================================================
async function callFinesaApiGeneric(endpoint, body, sessionId, method = 'POST') {
  const tmpDir = os.tmpdir();
  const { cookieStr, cookieParts, source } = buildCookieStringForSession(sessionId);
  const xsrfToken = resolveXsrfForSession(sessionId);

  console.log(`[SESSION] ${sessionId} → ${method} ${endpoint} (cookies: ${source})`);
  console.log(`[SESSION]   cf_clearance: ${cookieParts['cf_clearance'] ? 'YES' : 'NONE'}`);
  console.log(`[SESSION]   fastpay_session: ${cookieParts['fastpay_session'] ? cookieParts['fastpay_session'].substring(0, 25) + '...' : 'NONE'}`);
  console.log(`[SESSION]   XSRF: ${xsrfToken ? xsrfToken.substring(0, 25) + '...' : 'NONE'}`);

  const headerFile = path.join(tmpDir, `fh_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  const args = [
    '-s', '-X', method, '-D', headerFile,
    `${FINESA_URL}${endpoint}`,
    '-H', 'Accept: application/json, text/plain, */*',
    '-H', 'Accept-Language: es-CO,es;q=0.9,en;q=0.8',
    '-H', `X-XSRF-TOKEN: ${xsrfToken || ''}`,
    '-H', `Cookie: ${cookieStr}`,
    '-H', `Referer: ${FINESA_URL}/autenticacion`,
    '-H', `Origin: ${FINESA_URL}`,
    '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    '-H', 'X-Requested-With: XMLHttpRequest',
  ];

  let bodyFile = null;
  if (method !== 'GET' && body !== undefined) {
    bodyFile = path.join(tmpDir, `fb_${Date.now()}.txt`);
    fs.writeFileSync(bodyFile, JSON.stringify(body), 'utf8');
    args.push('-H', 'Content-Type: application/json');
    args.push('--data-binary', `@${bodyFile}`);
  }

  args.push(...proxyCurlArgs(sessionId));

  let bodyStr = '';
  try {
    const { stdout } = await execFileAsync('curl', args, { encoding: 'utf8', timeout: 30000 });
    bodyStr = stdout;
  } finally { if (bodyFile) try { fs.unlinkSync(bodyFile); } catch {} }

  try {
    const headerBlock = fs.readFileSync(headerFile, 'utf8');
    const { cookieMap, xsrf } = parseSetCookies(headerBlock);
    if (Object.keys(cookieMap).length > 0) {
      const s = sessions.get(sessionId) || { cookies: {}, xsrf: null, jwtAt: 0 };
      s.cookies = s.cookies || {};
      Object.assign(s.cookies, cookieMap);
      if (xsrf) s.xsrf = xsrf;
      if (cookieMap['fastpay_jwt']) s.jwtAt = Date.now();
      sessions.set(sessionId, s);
      console.log(`[SESSION] Cookies recibidas: ${Object.keys(cookieMap).join(', ')}`);
    }
  } catch (e) {}
  try { fs.unlinkSync(headerFile); } catch {}

  try { return JSON.parse(bodyStr); }
  catch { console.log(`[API] Raw: ${bodyStr.substring(0, 150)}`); return { _raw: bodyStr.substring(0, 500) }; }
}

// ============================================================
// ENDPOINTS
// ============================================================
app.use((req, res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`); next(); });

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', capsolver: !!CAPSOLVER_KEY, proxy: useProxy,
    stickyFormat: STICKY_FORMAT,
    proxyHost: useProxy ? `${GEONODE_HOST}:${GEONODE_PORT}` : null,
    harvestReady: !!(GLOBAL_HARVEST && GLOBAL_HARVEST.cookies),
    harvestExpiresInSec: GLOBAL_HARVEST && GLOBAL_HARVEST.expireAt ? Math.max(0, Math.ceil((GLOBAL_HARVEST.expireAt - Date.now()) / 1000)) : 0,
    sessionsActive: sessions.size,
    usersIndexed: userIndex.size,
    cacheEntries: priceCache.size,
  });
});

app.get('/api/document-types', (req, res) => {
  res.json({ success: true, data: Object.entries(DOCUMENT_TYPES).map(([value, label]) => ({ value, label })) });
});

// ─── PASO 1: verify ────────────────────────────────────────
app.post('/api/verify', async (req, res) => {
  const { documentType, identification } = req.body;
  if (!documentType || !identification) return res.status(400).json({ success: false, error: 'Faltan parámetros' });
  if (!DOCUMENT_TYPES[documentType]) return res.status(400).json({ success: false, error: 'Tipo inválido' });
  if (!CAPSOLVER_KEY) return res.status(500).json({ success: false, error: 'Falta CAPSOLVER_KEY' });

  const idx = userIndex.get(identification);
  if (idx && idx.throttleUntil && Date.now() < idx.throttleUntil) {
    const secs = Math.ceil((idx.throttleUntil - Date.now()) / 1000);
    return res.status(429).json({ success: false, error: `Throttled. Espera ${secs}s.`, retryAfter: secs });
  }

  const sessionId = newSessionId(identification);
  setSession(sessionId, { identification, cookies: {}, xsrf: null, jwtAt: 0, recaptchaToken: null });

  console.log(`\n[VERIFY] ════════════════════════════════════════`);
  console.log(`[VERIFY] sessionId=${sessionId}`);
  const start = Date.now();

  try {
    const [_, recaptchaToken, turnstileToken] = await Promise.all([
      getGlobalHarvest().catch(e => { console.warn('[VERIFY] Harvest falló, siguiendo sin él:', e.message); return null; }),
      solveCaptcha('recaptchav3', RECAPTCHA_SITEKEY, `${FINESA_URL}/autenticacion`),
      solveCaptcha('turnstile', TURNSTILE_SITEKEY, `${FINESA_URL}/autenticacion`),
    ]);

    const data = await callFinesaApiGeneric('/api/auth/verify-identification',
      { documentType, identification, recaptchaToken, turnstileToken }, sessionId);

    console.log(`[VERIFY] ✓ ${((Date.now() - start) / 1000).toFixed(1)}s → ${JSON.stringify(data).substring(0, 200)}`);

    if (isCloudflare1015(data)) throw new Error('Cloudflare 1015. Espera 10 min.');
    if (isThrottled(data)) {
      const wait = (data.retryAfter || 180) + 30;
      userIndex.set(identification, { ...(userIndex.get(identification) || {}), throttleUntil: Date.now() + wait * 1000 });
      throw new Error(`Throttled. Espera ${wait}s.`);
    }
    if (isServerError(data)) throw new Error('Error servidor.');
    if (data.error) throw new Error(data.error);

    const s = sessions.get(sessionId);
    if (s) s.recaptchaToken = recaptchaToken;

    if (data.requiresLastFour === true || data.requiresLastFour === undefined) {
      prefetchStep2Tokens(sessionId);
    }

    res.json({ success: true, sessionId, data });
  } catch (error) {
    console.error(`[VERIFY] Error:`, error.message);
    sessions.delete(sessionId);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── PASO 2: verify-credit ─────────────────────────────────
app.post('/api/verify-credit', async (req, res) => {
  const { sessionId, identification, lastFourDigits } = req.body;
  if (!sessionId || !identification || !lastFourDigits) return res.status(400).json({ success: false, error: 'Faltan parámetros: sessionId, identification, lastFourDigits' });
  if (!/^\d{4}$/.test(lastFourDigits)) return res.status(400).json({ success: false, error: 'lastFourDigits debe ser 4 dígitos' });

  const s = getSession(sessionId);
  if (!s) return res.status(400).json({ success: false, error: 'Sesión no válida o expirada. Ejecuta /api/verify primero.' });
  if (s.identification !== identification) return res.status(400).json({ success: false, error: 'Sesión no coincide con identificación' });

  const idx = userIndex.get(identification);
  if (idx && idx.throttleUntil && Date.now() < idx.throttleUntil) {
    const secs = Math.ceil((idx.throttleUntil - Date.now()) / 1000);
    return res.status(429).json({ success: false, error: `Throttled. Espera ${secs}s.`, retryAfter: secs });
  }

  try {
    const start = Date.now();
    console.log(`\n[CREDIT] ════════════════════════════════════════`);
    console.log(`[CREDIT] sessionId=${sessionId}`);

    const turnstileToken = await getStep2Turnstile(sessionId);
    const savedRecaptcha = s.recaptchaToken || '';

    const body = {
      lastFourDigits,
      recaptchaToken: savedRecaptcha,
      turnstileToken,
    };

    const data = await callFinesaApiGeneric('/api/auth/validate-credit', body, sessionId);

    if (isCloudflare1015(data)) throw new Error('Cloudflare 1015. Espera 10 min.');
    if (isThrottled(data)) {
      const wait = (data.retryAfter || 180) + 30;
      userIndex.set(identification, { ...(userIndex.get(identification) || {}), throttleUntil: Date.now() + wait * 1000 });
      throw new Error(`Throttled. Espera ${wait}s.`);
    }
    if (isCsrfError(data)) throw new Error('CSRF: cookies no válidas. Vuelve a ejecutar /api/verify.');
    if (isServerError(data)) throw new Error('Error servidor.');
    if (data.error) throw new Error(data.error);

    console.log(`[CREDIT] ✓ ${((Date.now() - start) / 1000).toFixed(1)}s → ${JSON.stringify(data).substring(0, 300)}`);
    res.json({ success: true, sessionId, data });
  } catch (error) {
    console.error(`[CREDIT] Error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// FETCH /productos
// ============================================================
async function fetchProductosPage(sessionId) {
  const tmpDir = os.tmpdir();
  const { cookieStr, cookieParts, source } = buildCookieStringForSession(sessionId);

  console.log(`[PRODUCTOS] GET /productos (cookies: ${source})`);
  console.log(`[PRODUCTOS]   cf_clearance: ${cookieParts['cf_clearance'] ? 'YES' : 'NONE'}`);
  console.log(`[PRODUCTOS]   fastpay_jwt: ${cookieParts['fastpay_jwt'] ? 'YES' : 'NONE'}`);

  const headerFile = path.join(tmpDir, `fh_prod_${Date.now()}.txt`);
  const args = [
    '-s', '-L', '-D', headerFile,
    `${FINESA_URL}/productos`,
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '-H', 'Accept-Language: es-CO,es;q=0.9,en;q=0.8',
    '-H', `Cookie: ${cookieStr}`,
    '-H', `Referer: ${FINESA_URL}/autenticacion`,
    '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  ];
  args.push(...proxyCurlArgs(sessionId));

  let html = '';
  try {
    const { stdout } = await execFileAsync('curl', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 * 5 });
    html = stdout;
  } finally {
    try {
      const headerBlock = fs.readFileSync(headerFile, 'utf8');
      const { cookieMap, xsrf } = parseSetCookies(headerBlock);
      if (Object.keys(cookieMap).length > 0) {
        const s = sessions.get(sessionId) || { cookies: {}, xsrf: null, jwtAt: 0 };
        s.cookies = s.cookies || {};
        Object.assign(s.cookies, cookieMap);
        if (xsrf) s.xsrf = xsrf;
        sessions.set(sessionId, s);
      }
    } catch (e) {}
    try { fs.unlinkSync(headerFile); } catch {}
  }

  return html;
}

// ============================================================
// PARSER FastPay
// ============================================================
function extractFastPayFromHtml(html) {
  const fastPay = extractJsObjectAfter(html, 'window.FastPay');
  if (!fastPay) {
    console.error('[FASTPAY] No se encontró window.FastPay');
    return null;
  }
  console.log('[FASTPAY] window.FastPay keys:', Object.keys(fastPay));

  if (fastPay.productConfig && fastPay.productConfig.products) {
    console.log('[FASTPAY] productConfig dentro de FastPay. products:', (fastPay.productConfig.products || []).length);
    return fastPay;
  }

  const pcSeparate = extractJsObjectAfter(html, 'window.FastPay.productConfig');
  if (pcSeparate) {
    console.log('[FASTPAY] productConfig separado. products:', (pcSeparate.products || []).length);
    fastPay.productConfig = pcSeparate;
    return fastPay;
  }

  const pcAny = extractJsObjectAfter(html, 'productConfig');
  if (pcAny && pcAny.products) {
    console.log('[FASTPAY] productConfig por búsqueda directa. products:', (pcAny.products || []).length);
    fastPay.productConfig = pcAny;
    return fastPay;
  }

  console.warn('[FASTPAY] ⚠ No se encontró productConfig');
  return fastPay;
}

function extractJsObjectAfter(html, marker) {
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) return null;
  const eqIdx = html.indexOf('=', startIdx);
  if (eqIdx === -1) return null;
  const braceStart = html.indexOf('{', eqIdx);
  if (braceStart === -1) return null;

  let depth = 0, i = braceStart, inStr = null, escape = false;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === inStr) { inStr = null; continue; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) {
    console.error(`[FASTPAY] Balanceo no cerró para "${marker}". depth=${depth}`);
    return null;
  }

  const raw = html.slice(braceStart, i);
  console.log(`[FASTPAY] "${marker}" → ${raw.length} chars`);

  try { return JSON.parse(raw); } catch (e) {}
  try {
    const vm = require('vm');
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(`__result = ${raw};`, ctx, { timeout: 2000 });
    return ctx.__result;
  } catch (e) {
    console.error(`[FASTPAY] No se pudo parsear "${marker}":`, e.message);
    return null;
  }
}

// ─── PASO 3: credit-info ───────────────────────────────────
app.post('/api/credit-info', async (req, res) => {
  const { sessionId, identification, forceRefresh } = req.body;
  if (!sessionId || !identification) return res.status(400).json({ success: false, error: 'Faltan sessionId e identification' });

  if (!forceRefresh) {
    const cached = priceCache.get(identification);
    if (cached && Date.now() < cached.expireAt) return res.json({ success: true, fromCache: true, ...cached.data });
  }

  const s = getSession(sessionId);
  if (!s) return res.status(400).json({ success: false, error: 'Sesión no válida o expirada. Ejecuta /api/verify primero.' });
  if (s.identification !== identification) return res.status(400).json({ success: false, error: 'Sesión no coincide con identificación' });
  if (!s.cookies || !s.cookies['fastpay_jwt']) return res.status(400).json({ success: false, error: 'No hay fastpay_jwt. Ejecuta /api/verify-credit primero.' });

  console.log(`\n[CREDIT-INFO] ════════════════════════════════════════`);
  console.log(`[CREDIT-INFO] sessionId=${sessionId}`);
  const start = Date.now();

  try {
    const html = await fetchProductosPage(sessionId);

    if (!html || html.length < 100) throw new Error('Respuesta vacía de /productos');
    if (html.includes('1015') || html.includes('ray ID')) throw new Error('Cloudflare bloqueó la solicitud');

    console.log(`[DIAG] HTML length: ${html.length}`);
    console.log(`[DIAG] "window.FastPay": ${html.includes('window.FastPay')}`);
    console.log(`[DIAG] "productConfig": ${html.includes('productConfig')}`);
    console.log(`[DIAG] "numeroCredito": ${html.includes('numeroCredito')}`);

    const fastPayData = extractFastPayFromHtml(html);
    if (!fastPayData) {
      const dbg = path.join(os.tmpdir(), `productos_fail_${Date.now()}.html`);
      fs.writeFileSync(dbg, html);
      console.error(`[CREDIT-INFO] FastPay no parseable. HTML guardado: ${dbg}`);
      throw new Error('No se encontró window.FastPay parseable en el HTML');
    }

    const products = fastPayData.productConfig?.products || [];
    const firstInstallments = fastPayData.productConfig?.firstInstallments || [];
    const canceledProducts = fastPayData.productConfig?.canceledProducts || [];
    const csrfToken = fastPayData.csrfToken || resolveXsrfForSession(sessionId);

    console.log(`[CREDIT-INFO] productConfig: ${!!fastPayData.productConfig}, products: ${products.length}`);

    const today = new Date();
    const formattedDate =
      today.getFullYear() +
      String(today.getMonth() + 1).padStart(2, '0') +
      String(today.getDate()).padStart(2, '0');

    const { cookieStr } = buildCookieStringForSession(sessionId);

    const productsWithBalance = await Promise.all(products.map(async (product) => {
      if (product.valorPendientePago1 !== undefined && product.valorPendientePago1 !== '') {
        return product;
      }
      try {
        const bodyFile = path.join(os.tmpdir(), `fb_bal_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
        fs.writeFileSync(bodyFile, JSON.stringify({ credit: product.numeroCredito, date: formattedDate }), 'utf8');

        const balArgs = [
          '-s', '-X', 'POST',
          `${FINESA_URL}/api/products/balance`,
          '-H', 'Content-Type: application/json',
          '-H', 'Accept: application/json',
          '-H', `X-CSRF-TOKEN: ${csrfToken}`,
          '-H', `X-XSRF-TOKEN: ${csrfToken}`,
          '-H', `Cookie: ${cookieStr}`,
          '-H', `Referer: ${FINESA_URL}/productos`,
          '-H', `Origin: ${FINESA_URL}`,
          '-H', 'X-Requested-With: XMLHttpRequest',
          '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          '--data-binary', `@${bodyFile}`,
          ...proxyCurlArgs(sessionId),
        ];
        const { stdout: balStr } = await execFileAsync('curl', balArgs, { encoding: 'utf8', timeout: 20000 });
        try { fs.unlinkSync(bodyFile); } catch {}

        let balData;
        try { balData = JSON.parse(balStr); }
        catch { return product; }

        const resp = balData.data || balData;
        if (resp && resp.valorCuota !== undefined) {
          const totales = parseInt(String(resp.totales || '0').replace(/,/g, ''), 10);
          product.valorPendientePago1 = String(totales);
          product.valorPendientePago2 = String(totales);
        }
      } catch (e) {
        console.log(`[CREDIT-INFO] balance error ${product.numeroCredito}:`, e.message);
      }
      return product;
    }));

    const userName = html.match(/<span id="userName"[^>]*>(.*?)<\/span>/)?.[1] || fastPayData.userName || 'Cliente';

    const flatCredits = productsWithBalance.map(p => ({
      product: p.producto || 'Finanprimas',
      creditNumber: p.numeroCredito || '****',
      amount: parseFloat(String(p.valorPendientePago1 || '0').replace(/[^\d.-]/g, '')) || 0,
      dueDate: p.fechaFacturacion1 || 'INMEDIATO',
      producto: p.producto,
      numeroCredito: p.numeroCredito,
      valorPendientePago1: p.valorPendientePago1,
      valorPendientePago2: p.valorPendientePago2,
      fechaFacturacion1: p.fechaFacturacion1,
      mora: p.mora,
    }));

    const result = {
      userName,
      products: productsWithBalance.map(p => ({
        producto: p.producto,
        numeroCredito: p.numeroCredito,
        valorPendientePago1: p.valorPendientePago1,
        valorPendientePago2: p.valorPendientePago2,
        fechaFacturacion1: p.fechaFacturacion1,
        mora: p.mora,
      })),
      firstInstallments,
      canceledProducts,
      raw: fastPayData,
    };

    const frontPayload = {
      customerName: userName,
      credits: flatCredits,
      firstInstallments,
      canceledProducts,
    };

    console.log(`[CREDIT-INFO] ✓ ${((Date.now() - start) / 1000).toFixed(1)}s — ${result.products.length} productos`);

    const payload = { parsed: result, ...frontPayload };
    priceCache.set(identification, { data: payload, expireAt: Date.now() + PRICE_CACHE_TTL_MS });
    res.json({ success: true, ...payload });

  } catch (error) {
    console.error(`[CREDIT-INFO] Error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// DEBUG
// ============================================================
app.get('/api/debug/sessions', (req, res) => {
  const out = [];
  for (const [sid, sd] of sessions.entries()) {
    out.push({
      sessionId: sid,
      identification: sd.identification,
      hasJwt: !!(sd.cookies && sd.cookies['fastpay_jwt']),
      hasSession: !!(sd.cookies && sd.cookies['fastpay_session']),
      cookies: sd.cookies ? Object.keys(sd.cookies) : [],
      ageSec: Math.floor((Date.now() - sd.createdAt) / 1000),
    });
  }
  res.json({ sessions: out, priceCache: Array.from(priceCache.keys()), stickyFormat: STICKY_FORMAT });
});

app.get('/api/debug/harvest', async (req, res) => {
  try {
    const h = await getGlobalHarvest();
    res.json({
      ok: true,
      cookieCount: h.cookies.split(';').length,
      xsrf: h.xsrf.substring(0, 25) + '...',
      expireAt: new Date(h.expireAt).toISOString(),
      expiresInSec: Math.ceil((h.expireAt - Date.now()) / 1000),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug/proxy-ip', async (req, res) => {
  try {
    const args = ['-s', '--max-time', '15', 'https://api.ipify.org'];
    args.push(...proxyCurlArgs('debug' + Date.now()));
    const { stdout } = await execFileAsync('curl', args, { encoding: 'utf8', timeout: 20000 });
    res.json({ ok: true, ip: stdout.trim(), format: STICKY_FORMAT });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// LIMPIEZA
// ============================================================
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [sid, s] of sessions.entries()) {
    if (now > s.createdAt + SESSION_TTL_MS) {
      sessions.delete(sid);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`[CLEANUP] ${cleaned} sesiones expiradas eliminadas (${sessions.size} activas)`);
}, 5 * 60 * 1000);

// ============================================================
app.listen(PORT, async () => {
  console.log(`\n╔═══════════════════════════════════════════════════════╗`);
  console.log(`║  Finesa Proxy v30 (optimizado para producción)        ║`);
  console.log(`║  http://localhost:${PORT}                                 ║`);
  console.log(`║  Proxy: ${useProxy ? `${GEONODE_HOST}:${GEONODE_PORT} (${STICKY_FORMAT})` : 'OFF'}`);
  console.log(`╚═══════════════════════════════════════════════════════╝\n`);

  console.log('[WARMUP] Haciendo harvest inicial...');
  await warmupHarvest();
  console.log('[SERVER] ✓ Listo — harvest global activo, requests rápidos');
});
