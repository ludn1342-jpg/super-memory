require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const FINESA_URL = 'https://pagos.finesa.com.co';

// 2Captcha
const CAPTCHA_KEY = process.env.CAPTCHA_KEY || '';
const RECAPTCHA_SITEKEY = '6LddR80oAAAAADtO0X7hLL55sKnYVNvODdu_xVst';
const TURNSTILE_SITEKEY = '0x4AAAAAAFAMEbzOhnNsw4Vz';

// Proxy Geonode
const GEONODE_USER = process.env.GEONODE_USER || '';
const GEONODE_PASS = process.env.GEONODE_PASS || '';
const GEONODE_HOST = process.env.GEONODE_HOST || '92.204.171.83';
const GEONODE_PORT = process.env.GEONODE_PORT || '9000';
const useProxy = !!GEONODE_USER;

const isWin = os.platform() === 'win32';
const devNull = isWin ? 'NUL' : '/dev/null';

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const DOCUMENT_TYPES = {
  '1': 'Cédula de ciudadanía',
  '2': 'Cédula de extranjería',
  '3': 'NIT',
};

// ============================================================
// 2CAPTCHA — resolver reCAPTCHA v3 y Turnstile
// ============================================================

async function solve2Captcha(type, sitekey, pageUrl) {
  // type: 'recaptchav3' o 'turnstile'
  const startTime = Date.now();

  let submitUrl;
  if (type === 'recaptchav3') {
    submitUrl = `http://2captcha.com/in.php?key=${CAPTCHA_KEY}&method=userrecaptcha&googlekey=${sitekey}&pageurl=${encodeURIComponent(pageUrl)}&version=v3&action=verify&min_score=0.5&json=1`;
  } else {
    // Turnstile
    submitUrl = `http://2captcha.com/in.php?key=${CAPTCHA_KEY}&method=turnstile&sitekey=${sitekey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`;
  }

  console.log(`[2CAPTCHA] Enviando ${type}...`);

  // Enviar tarea
  const submitArgs = ['-s', submitUrl];
  const submitRes = JSON.parse(execFileSync('curl', submitArgs, { encoding: 'utf8', timeout: 30000 }));

  if (submitRes.status !== 1) {
    throw new Error(`2Captcha submit error: ${submitRes.request || JSON.stringify(submitRes)}`);
  }

  const taskId = submitRes.request;
  console.log(`[2CAPTCHA] ${type} taskId: ${taskId}`);

  // Polling hasta que esté listo (máx 120 seg)
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000)); // esperar 3 seg entre polls

    const pollUrl = `http://2captcha.com/res.php?key=${CAPTCHA_KEY}&action=get&id=${taskId}&json=1`;
    const pollArgs = ['-s', pollUrl];

    try {
      const pollRes = JSON.parse(execFileSync('curl', pollArgs, { encoding: 'utf8', timeout: 15000 }));

      if (pollRes.status === 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[2CAPTCHA] ✓ ${type} resuelto en ${elapsed}s`);
        return pollRes.request; // el token
      }

      if (pollRes.request !== 'CAPCHA_NOT_READY') {
        throw new Error(`2Captcha error: ${pollRes.request}`);
      }
    } catch (e) {
      if (e.message.includes('2Captcha error')) throw e;
      // Error de red, reintentar
    }
  }

  throw new Error(`2Captcha timeout para ${type}`);
}

// ============================================================
// OBTENER CSRF TOKEN (cookies de Laravel)
// ============================================================

function getCsrfToken() {
  const cookieJar = path.join(__dirname, `cookies_${Date.now()}.txt`);

  const args = [
    '-s', '-o', devNull,
    '-c', cookieJar,
    '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-H', 'Accept: text/html,application/xhtml+xml',
  ];

  if (useProxy) {
    args.push('-x', `http://${GEONODE_USER}:${GEONODE_PASS}@${GEONODE_HOST}:${GEONODE_PORT}`);
  }

  args.push(`${FINESA_URL}/autenticacion`);

  try {
    execFileSync('curl', args, { encoding: 'utf8', timeout: 30000 });
  } catch (e) {
    console.error('[CSRF] Error en GET:', e.message);
  }

  // Leer cookies
  let xsrfToken = '';
  let allCookies = '';

  if (fs.existsSync(cookieJar)) {
    const content = fs.readFileSync(cookieJar, 'utf8');
    const lines = content.split('\n');

    const cookies = [];
    for (const line of lines) {
      if (line.startsWith('#') || !line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length >= 7) {
        cookies.push(`${parts[5]}=${parts[6]}`);
        if (parts[5] === 'XSRF-TOKEN') {
          xsrfToken = decodeURIComponent(parts[6]);
        }
      }
    }
    allCookies = cookies.join('; ');

    // Limpiar
    try { fs.unlinkSync(cookieJar); } catch {}
  }

  console.log(`[CSRF] XSRF-TOKEN: ${xsrfToken ? xsrfToken.substring(0, 20) + '...' : 'NO ENCONTRADO'}`);
  console.log(`[CSRF] Cookies: ${allCookies ? allCookies.substring(0, 60) + '...' : 'NINGUNA'}`);

  return { xsrfToken, cookies: allCookies };
}

// ============================================================
// LLAMAR API DE FINESA
// ============================================================

function callFinesaApi(documentType, identification, recaptchaToken, turnstileToken, xsrfToken, cookies) {
  const body = JSON.stringify({
    documentType,
    identification,
    recaptchaToken,
    turnstileToken,
  });

  const args = [
    '-s',
    '-X', 'POST',
    `${FINESA_URL}/api/auth/verify-identification`,
    '-H', 'Content-Type: application/json',
    '-H', 'Accept: application/json',
    '-H', `X-XSRF-TOKEN: ${xsrfToken}`,
    '-H', `Cookie: ${cookies}`,
    '-H', `Referer: ${FINESA_URL}/autenticacion`,
    '-H', `Origin: ${FINESA_URL}`,
    '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-H', 'sec-ch-ua: "Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    '-H', 'sec-ch-ua-mobile: ?0',
    '-H', 'sec-ch-ua-platform: "Windows"',
    '-H', 'Sec-Fetch-Dest: empty',
    '-H', 'Sec-Fetch-Mode: cors',
    '-H', 'Sec-Fetch-Site: same-origin',
    '--data-raw', body,
  ];

  if (useProxy) {
    args.push('-x', `http://${GEONODE_USER}:${GEONODE_PASS}@${GEONODE_HOST}:${GEONODE_PORT}`);
  }

  const result = execFileSync('curl', args, { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(result);
}

// ============================================================
// ENDPOINTS
// ============================================================

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', captchaKey: !!CAPTCHA_KEY, proxy: useProxy });
});

app.get('/api/document-types', (req, res) => {
  res.json({
    success: true,
    data: Object.entries(DOCUMENT_TYPES).map(([value, label]) => ({ value, label })),
  });
});

app.post('/api/verify', async (req, res) => {
  const { documentType, identification } = req.body;

  if (!documentType || !identification) {
    return res.status(400).json({ success: false, error: 'Se requiere documentType e identification' });
  }
  if (!DOCUMENT_TYPES[documentType]) {
    return res.status(400).json({ success: false, error: 'Tipo de documento inválido' });
  }
  if (!CAPTCHA_KEY) {
    return res.status(500).json({ success: false, error: 'Falta CAPTCHA_KEY en .env' });
  }

  try {
    const start = Date.now();
    console.log(`\n[VERIFY] === ${identification} (${DOCUMENT_TYPES[documentType]}) ===`);

    // PASO 1: Obtener CSRF cookies
    console.log('[VERIFY] Paso 1: Obteniendo CSRF...');
    const { xsrfToken, cookies } = getCsrfToken();

    if (!xsrfToken) {
      return res.status(502).json({ success: false, error: 'No se pudo obtener XSRF-TOKEN de Finesa' });
    }

    // PASO 2: Resolver captchas EN PARALELO
    console.log('[VERIFY] Paso 2: Resolviendo captchas en paralelo...');
    const [recaptchaToken, turnstileToken] = await Promise.all([
      solve2Captcha('recaptchav3', RECAPTCHA_SITEKEY, `${FINESA_URL}/autenticacion`),
      solve2Captcha('turnstile', TURNSTILE_SITEKEY, `${FINESA_URL}/autenticacion`),
    ]);

    // PASO 3: Llamar API de Finesa
    console.log('[VERIFY] Paso 3: Llamando API de Finesa...');
    const result = callFinesaApi(documentType, identification, recaptchaToken, turnstileToken, xsrfToken, cookies);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[VERIFY] ✓ Respuesta en ${elapsed}s:`, JSON.stringify(result).substring(0, 300));

    res.json({ success: true, data: result });

  } catch (error) {
    console.error(`[VERIFY] Error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════════════════════╗`);
  console.log(`║  Finesa Proxy v9 (2Captcha + curl, sin Puppeteer)      ║`);
  console.log(`║  http://localhost:${PORT}                                  ║`);
  console.log(`║  Proxy: ${useProxy ? `${GEONODE_HOST}:${GEONODE_PORT}` : 'DESACTIVADO'}                          ║`);
  console.log(`║  2Captcha: ${CAPTCHA_KEY ? 'CONFIGURADO' : '⚠ FALTA CAPTCHA_KEY'}                     ║`);
  console.log(`╚════════════════════════════════════════════════════════╝\n`);
});
