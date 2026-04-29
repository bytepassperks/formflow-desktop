/**
 * Speechify Integration Test — FormFlow Desktop Pro
 *
 * Standalone test script that exercises the Speechify onboarding + payment
 * workflow using Puppeteer, following the same pattern as test_vapi_final.js.
 *
 * Flow:
 * 1. Navigate to speechify.com/l/wondertools (promo landing)
 * 2. Answer onboarding questions
 * 3. Create account with email + password
 * 4. Verify payment page shows $0.00 (100% discount)
 * 5. Fill Stripe payment form via CDP (cross-origin iframe)
 * 6. Submit payment
 * 7. Verify dashboard access
 *
 * Usage:
 *   MAILGUN_API_KEY=xxx node test_speechify_final.js
 */

const puppeteer = require('./electron/node_modules/puppeteer');
const http = require('http');
const https = require('https');

const MAILGUN_DOMAIN = 'btedu.tech';

(async () => {
  const testEmail = 'speechify.' + Math.floor(Date.now() / 1000) + '@' + MAILGUN_DOMAIN;
  const testPassword = '007JamesBond@@';
  const cardNumber = '5598880369500915';
  const cardExpiry = '0927';
  const cardCvc = '801';
  const mailgunApiKey = process.env.MAILGUN_API_KEY || '';

  console.log('=== Speechify Integration Test ===');
  console.log('Email:', testEmail);
  console.log('Mailgun:', mailgunApiKey ? 'configured' : 'NOT SET');
  console.log('');

  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  try {
    // ─── STEP 1: Navigate to Speechify promo landing ───
    console.log('[Step 1] Navigating to speechify.com/l/wondertools...');
    await page.goto('https://speechify.com/l/wondertools', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    console.log('[Step 1] ✓ Landed on:', page.url());
    await new Promise(r => setTimeout(r, 3000));

    // ─── STEP 2: Handle onboarding questions ───
    console.log('[Step 2] Handling onboarding questions...');
    let onboardingDone = false;
    for (let step = 0; step < 10; step++) {
      const state = await page.evaluate(() => {
        const text = document.body.innerText;
        return {
          hasSignup: !!(document.querySelector('input[type="email"]') || text.includes('Create your account')),
          hasPayment: text.includes('$0.00') || text.includes('Payment'),
          buttonTexts: Array.from(document.querySelectorAll('button'))
            .map(b => b.textContent.trim())
            .filter(t => t.length > 0 && t.length < 80),
        };
      });

      if (state.hasSignup || state.hasPayment) {
        console.log('[Step 2] ✓ Onboarding complete — reached:', state.hasSignup ? 'signup' : 'payment');
        onboardingDone = true;
        break;
      }

      // Click first option button
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const optionBtns = buttons.filter(b => {
          const text = b.textContent.trim();
          if (text.length === 0 || text.length > 80) return false;
          if (['Next', 'Back', 'Skip', 'Close', 'X'].includes(text)) return false;
          const rect = b.getBoundingClientRect();
          return rect.width > 50 && rect.height > 20 && rect.top > 100;
        });
        if (optionBtns.length > 0) {
          optionBtns[0].click();
          return optionBtns[0].textContent.trim();
        }
        return null;
      });

      if (clicked) {
        console.log(`  Selected: "${clicked}"`);
        await new Promise(r => setTimeout(r, 1500));

        // Click Next/Continue
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const nextBtn = btns.find(b => b.textContent.trim() === 'Next' || b.textContent.trim() === 'Continue');
          if (nextBtn && !nextBtn.disabled) nextBtn.click();
        });
        await new Promise(r => setTimeout(r, 2000));
      } else {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // ─── STEP 3: Create account ───
    console.log('[Step 3] Filling signup form...');
    const emailInput = await page.$('input[type="email"], input[name="email"]');
    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await page.keyboard.type(testEmail, { delay: 25 });
      console.log('  Email filled');
    }

    const passwordInput = await page.$('input[type="password"]');
    if (passwordInput) {
      await passwordInput.click({ clickCount: 3 });
      await page.keyboard.type(testPassword, { delay: 25 });
      console.log('  Password filled');
    }

    // Submit
    const submitBtn = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const btn = buttons.find(b => {
        const t = b.textContent.trim().toLowerCase();
        return t.includes('sign up') || t.includes('create account') || t.includes('continue') || b.type === 'submit';
      });
      if (btn) { btn.click(); return btn.textContent.trim(); }
      return null;
    });
    console.log('  Submitted via:', submitBtn);
    await new Promise(r => setTimeout(r, 5000));
    console.log('[Step 3] ✓ Post-signup URL:', page.url());

    // ─── STEP 4: Verify $0.00 payment page ───
    console.log('[Step 4] Verifying payment page pricing...');

    // Navigate to promo paywall if not already there
    if (!page.url().includes('promo') && !page.url().includes('paywall')) {
      await page.goto('https://speechify.com/onboarding/nc/promo/paywall-p/?promo=JDKSN292NDKWON&priceId=price_1QpTYsBtf7hakIXChv4GUhEG', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      await new Promise(r => setTimeout(r, 3000));
    }

    const pricing = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        hasDiscount: text.includes('-100%') || text.includes('100% off'),
        hasFreePrice: text.includes('$0.00'),
        hasPromo: text.includes('JDKSN292NDKWON'),
      };
    });
    console.log('[Step 4] Pricing:', JSON.stringify(pricing));

    if (!pricing.hasFreePrice) {
      throw new Error('SAFETY: Payment page does NOT show $0.00 — aborting');
    }
    console.log('[Step 4] ✓ Confirmed $0.00 with 100% discount');

    // ─── STEP 5: Open payment modal + fill Stripe ───
    console.log('[Step 5] Opening payment modal...');

    // Click "Claim 100% Discount"
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const claimBtn = btns.find(b => b.textContent.includes('Claim 100% Discount'));
      if (claimBtn) claimBtn.click();
    });
    await new Promise(r => setTimeout(r, 4000));

    console.log('[Step 5] Filling Stripe payment form via CDP...');

    // Get CDP port from browser WebSocket URL
    const wsEndpoint = browser.wsEndpoint();
    const cdpPort = new URL(wsEndpoint).port;

    // Find Stripe iframe target
    const targets = await httpGetJson(`http://127.0.0.1:${cdpPort}/json`);
    const stripeTargets = targets.filter(t =>
      t.type === 'iframe' && t.url && t.url.includes('stripe.com') && t.url.includes('elements-inner')
    );

    let stripeWsUrl = null;
    for (const target of stripeTargets) {
      if (!target.webSocketDebuggerUrl) continue;
      // Check if this frame has card inputs
      const hasInputs = await checkStripeFrameInputs(target.webSocketDebuggerUrl);
      if (hasInputs) {
        stripeWsUrl = target.webSocketDebuggerUrl;
        break;
      }
    }

    if (stripeWsUrl) {
      await fillStripeFields(stripeWsUrl, cardNumber, cardExpiry, cardCvc);
      console.log('[Step 5] ✓ Stripe fields filled via CDP');
    } else {
      console.log('[Step 5] ✗ Could not find Stripe iframe with card inputs');
      console.log('  Available iframe targets:', stripeTargets.length);
    }

    // ─── STEP 6: Submit payment (with reCAPTCHA handling) ───
    console.log('[Step 6] Clicking Buy Now...');
    const clickBuyNow = async () => {
      return page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const buyBtn = btns.find(b => b.textContent.includes('Buy Now'));
        if (buyBtn) { buyBtn.click(); return true; }
        return false;
      });
    };

    const buyClicked = await clickBuyNow();

    if (buyClicked) {
      console.log('  Waiting to check for reCAPTCHA...');
      await new Promise(r => setTimeout(r, 4000));

      // Check if reCAPTCHA appeared
      const hasRecaptcha = await page.evaluate(() => {
        const iframes = document.querySelectorAll('iframe[src*="recaptcha"]');
        for (const iframe of iframes) {
          const rect = iframe.getBoundingClientRect();
          if (rect.width > 50 && rect.height > 50) return true;
        }
        return false;
      });

      if (hasRecaptcha) {
        console.log('  reCAPTCHA detected! Solving via audio challenge...');
        const cdpPort = new URL(browser.wsEndpoint()).port;
        const solved = await solveRecaptchaAudio(cdpPort);
        if (solved) {
          console.log('  reCAPTCHA solved! Clicking Buy Now again...');
          await new Promise(r => setTimeout(r, 1000));
          await clickBuyNow();
        } else {
          console.log('  Audio solve failed — waiting 120s for manual solve...');
          // Poll for manual solve
          const start = Date.now();
          while (Date.now() - start < 120000) {
            await new Promise(r => setTimeout(r, 3000));
            const still = await page.evaluate(() => {
              const iframes = document.querySelectorAll('iframe[src*="recaptcha"]');
              for (const iframe of iframes) {
                const rect = iframe.getBoundingClientRect();
                if (rect.width > 50 && rect.height > 50) return true;
              }
              return false;
            });
            if (!still) { console.log('  Manually solved!'); await clickBuyNow(); break; }
          }
        }
      }

      console.log('  Waiting for payment processing...');
      await new Promise(r => setTimeout(r, 10000));

      const postPayment = await page.evaluate(() => {
        return {
          url: window.location.href,
          text: document.body.innerText.substring(0, 500),
        };
      });
      console.log('[Step 6] Post-payment URL:', postPayment.url);
    }

    // ─── STEP 7: Verify dashboard ───
    console.log('[Step 7] Checking dashboard access...');
    await page.goto('https://speechify.com/dashboard', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const dashboard = await page.evaluate(() => {
      return {
        url: window.location.href,
        isLoggedIn: !document.body.innerText.toLowerCase().includes('sign in'),
        title: document.title,
      };
    });
    console.log('[Step 7] Dashboard:', JSON.stringify(dashboard));

    console.log('\n=== RESULTS ===');
    console.log('Email:', testEmail);
    console.log('Password:', testPassword);
    console.log('Card last 4:', cardNumber.slice(-4));
    console.log('Final URL:', page.url());

  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    await page.screenshot({ path: '/home/ubuntu/formflow-desktop/test_speechify_error.png' });
  }

  await browser.close();
  console.log('Done!');
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

// ─── Helper functions ───

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve([]); } });
    }).on('error', reject);
  });
}

function checkStripeFrameInputs(wsUrl) {
  const WebSocket = require('./electron/node_modules/ws');
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 1;
    const timeout = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 5000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.enable' }));
      ws.send(JSON.stringify({
        id: msgId++,
        method: 'Runtime.evaluate',
        params: {
          expression: `(() => {
            const inputs = document.querySelectorAll('input');
            return Array.from(inputs).some(i => i.autocomplete === 'cc-number' || i.name === 'number');
          })()`,
          returnByValue: true,
        },
      }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.id === 2 && msg.result && msg.result.result) {
        clearTimeout(timeout);
        ws.close();
        resolve(!!msg.result.result.value);
      }
    });

    ws.on('error', () => { clearTimeout(timeout); resolve(false); });
  });
}

function fillStripeFields(wsUrl, cardNumber, cardExpiry, cardCvc) {
  const WebSocket = require('./electron/node_modules/ws');
  const expMonth = cardExpiry.substring(0, 2);
  const expYear = cardExpiry.substring(2, 4);
  const formattedExpiry = `${expMonth} / ${expYear}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 1;
    const pending = {};
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Stripe fill timeout')); }, 30000);

    const sendCmd = (method, params) => {
      const id = msgId++;
      return new Promise((res, rej) => {
        pending[id] = res;
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => { delete pending[id]; rej(new Error('cmd timeout')); }, 10000);
      });
    };

    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.id && pending[msg.id]) {
        pending[msg.id](msg);
        delete pending[msg.id];
      }
    });

    ws.on('open', async () => {
      try {
        await sendCmd('Runtime.enable');

        // Fill using native setter + input events
        await sendCmd('Runtime.evaluate', {
          expression: `(() => {
            function fillField(selector, value) {
              const input = document.querySelector(selector);
              if (!input) return 'not_found';
              input.focus();
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              setter.call(input, value);
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return 'filled: ' + input.value;
            }
            return JSON.stringify({
              card: fillField('input[name="number"]', '${cardNumber}'),
              exp: fillField('input[name="expiry"]', '${formattedExpiry}'),
              cvc: fillField('input[name="cvc"]', '${cardCvc}'),
            });
          })()`,
          returnByValue: true,
        });

        // Also try execCommand for trusted events
        await sendCmd('Runtime.evaluate', {
          expression: `(() => {
            function fillCmd(sel, val) {
              const input = document.querySelector(sel);
              if (!input) return;
              input.focus();
              input.select();
              document.execCommand('delete');
              document.execCommand('insertText', false, val);
            }
            fillCmd('input[name="number"]', '${cardNumber}');
            fillCmd('input[name="expiry"]', '${formattedExpiry}');
            fillCmd('input[name="cvc"]', '${cardCvc}');
          })()`,
          returnByValue: true,
        });

        clearTimeout(timeout);
        ws.close();
        resolve();
      } catch (err) {
        clearTimeout(timeout);
        ws.close();
        reject(err);
      }
    });

    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function solveRecaptchaAudio(cdpPort) {
  const WebSocket = require('./electron/node_modules/ws');
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');

  const cdpEval = (wsUrl, expression) => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let msgId = 1;
      const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 15000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.enable' }));
        ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      });
      ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.id === 2 && msg.result) { clearTimeout(timeout); ws.close(); resolve(msg.result.result ? msg.result.result.value : null); }
      });
      ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
  };

  try {
    // Find reCAPTCHA targets
    const targets = await httpGetJson(`http://127.0.0.1:${cdpPort}/json`);
    const anchors = targets.filter(t => t.type === 'iframe' && t.url && t.url.includes('recaptcha') && t.url.includes('anchor') && t.webSocketDebuggerUrl);
    const bframes = targets.filter(t => t.type === 'iframe' && t.url && t.url.includes('recaptcha') && t.url.includes('bframe') && t.webSocketDebuggerUrl);

    // Click checkbox
    for (const a of anchors) {
      try {
        const r = await cdpEval(a.webSocketDebuggerUrl, `(() => { const cb = document.querySelector('.recaptcha-checkbox-border'); if (cb) { cb.click(); return 'clicked'; } return 'not_found'; })()`);
        if (r === 'clicked') break;
      } catch {}
    }

    await new Promise(r => setTimeout(r, 3000));

    // Re-fetch bframe targets
    const t2 = await httpGetJson(`http://127.0.0.1:${cdpPort}/json`);
    const bf = t2.filter(t => t.type === 'iframe' && t.url && t.url.includes('recaptcha') && t.url.includes('bframe') && t.webSocketDebuggerUrl);
    if (bf.length === 0) return true; // auto-solved

    const bfWs = bf[0].webSocketDebuggerUrl;

    // Switch to audio
    await cdpEval(bfWs, `(() => { const btn = document.querySelector('#recaptcha-audio-button'); if (btn) { btn.click(); return 'ok'; } return 'no'; })()`);
    await new Promise(r => setTimeout(r, 2000));

    // Get audio URL
    const audioUrl = await cdpEval(bfWs, `(() => { const l = document.querySelector('.rc-audiochallenge-tdownload-link'); if (l) return l.href; const s = document.querySelector('#audio-source'); if (s) return s.src; return null; })()`);
    if (!audioUrl) { console.log('  No audio URL found'); return false; }

    // Download audio
    const tmpMp3 = path.join('/tmp', `recaptcha_${Date.now()}.mp3`);
    const tmpWav = path.join('/tmp', `recaptcha_${Date.now()}.wav`);

    await new Promise((resolve, reject) => {
      const proto = audioUrl.startsWith('https') ? https : http;
      proto.get(audioUrl, (res) => {
        const f = fs.createWriteStream(tmpMp3);
        res.pipe(f);
        f.on('finish', () => { f.close(); resolve(); });
      }).on('error', reject);
    });

    // Convert to WAV
    await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', ['-i', tmpMp3, '-ar', '16000', '-ac', '1', '-y', tmpWav]);
      p.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg failed')));
      p.on('error', () => reject(new Error('ffmpeg not found')));
    });

    // Transcribe via Google Speech API
    const audioData = fs.readFileSync(tmpWav);
    const postData = JSON.stringify({
      config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'en-US' },
      audio: { content: audioData.toString('base64') },
    });

    const transcription = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'speech.googleapis.com',
        path: '/v1/speech:recognize?key=AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const r = JSON.parse(d);
            resolve(r.results && r.results.length > 0 ? r.results[0].alternatives[0].transcript : null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.write(postData);
      req.end();
    });

    try { fs.unlinkSync(tmpMp3); } catch {}
    try { fs.unlinkSync(tmpWav); } catch {}

    if (!transcription) { console.log('  Transcription failed'); return false; }
    console.log('  Transcription:', transcription);

    // Enter answer and verify
    await cdpEval(bfWs, `(() => { const i = document.querySelector('#audio-response'); if (!i) return; i.focus(); i.value = ''; document.execCommand('insertText', false, ${JSON.stringify(transcription)}); })()`);
    await new Promise(r => setTimeout(r, 500));
    await cdpEval(bfWs, `(() => { const b = document.querySelector('#recaptcha-verify-button'); if (b) b.click(); })()`);
    await new Promise(r => setTimeout(r, 3000));

    // Check if solved
    for (const a of anchors) {
      try {
        const c = await cdpEval(a.webSocketDebuggerUrl, `(() => { const cb = document.querySelector('.recaptcha-checkbox-checked'); return cb ? 'solved' : 'not'; })()`);
        if (c === 'solved') return true;
      } catch {}
    }

    return false;
  } catch (err) {
    console.log('  reCAPTCHA audio solve error:', err.message);
    return false;
  }
}
