/**
 * FormFlow Desktop Pro — Workflow Runner
 *
 * Executes registration workflows using Puppeteer connected to
 * real Chrome (auto-detected) or Electron's Chromium as fallback.
 *
 * VAPI registration uses a hybrid approach:
 * 1. Browser navigates to register page → Cloudflare Turnstile solves
 * 2. Turnstile token extracted from page
 * 3. Supabase signup API called directly with the token
 *    (bypasses React form entirely — no need to fight controlled inputs)
 * 4. Login also uses Turnstile token + Supabase token API
 *
 * Supports:
 * - Real Chrome detection (preferred — Turnstile solves reliably)
 * - Turnstile CAPTCHA handling (wait + extract + API bypass)
 * - Multi-profile browser isolation
 * - Parallel workflow execution
 * - Credential substitution ({{key}} syntax)
 * - Configurable retries with VPN switching
 * - Screenshot capture on failures
 * - Structured debug telemetry
 */

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

// Supabase anon key — embedded in VAPI's frontend JS, not a secret
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0dXlwcmpqZ3hiZ210aml5a29hIiwicm9sZSI6ImFub24iLCJpYXQiOjE2OTQ2NDQ5OTAsImV4cCI6MjAxMDIyMDk5MH0.TByTGnMGMHB3jT9jLCX51PUune9BuOS-PsdI4FYAJRs';

// Stealth JS injection — runs on every new page
const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      { name: 'Native Client', filename: 'internal-nacl-plugin' },
    ]
  });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  if (!window.chrome) window.chrome = {};
  window.chrome.runtime = {};
  window.chrome.loadTimes = function() { return {}; };
  window.chrome.csi = function() { return {}; };
  window.chrome.app = { isInstalled: false };
  const origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
  window.navigator.permissions.query = (p) =>
    p.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : origQuery(p);
`;

// CAPTCHA detection patterns
const CAPTCHA_PATTERNS = {
  recaptcha: ['iframe[src*="recaptcha"]', '.g-recaptcha', '#recaptcha'],
  hcaptcha: ['iframe[src*="hcaptcha"]', '.h-captcha'],
  turnstile: ['iframe[src*="turnstile"]', '.cf-turnstile'],
};

// Environment simulation presets
const TIMEZONES = ['America/New_York', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Asia/Kolkata', 'America/Los_Angeles'];
const LOCALES = ['en-US', 'en-GB', 'de-DE', 'ja-JP', 'hi-IN', 'fr-FR'];
const VIEWPORTS = [
  { width: 1920, height: 1080 }, { width: 1366, height: 768 },
  { width: 1440, height: 900 }, { width: 1536, height: 864 },
  { width: 1280, height: 720 },
];
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
];

class WorkflowRunner {
  constructor(options = {}) {
    this.profilesDir = options.profilesDir || path.join(process.cwd(), 'profiles');
    this.logsDir = options.logsDir || path.join(process.cwd(), 'logs');
    this.screenshotsDir = options.screenshotsDir || path.join(this.logsDir, 'screenshots');
    this.onEvent = options.onEvent || (() => {});
    this.onProgress = options.onProgress || (() => {});
    this.onVpnRotate = options.onVpnRotate || null;
    this.stopped = false;
    this.events = [];

    // Ensure directories
    for (const dir of [this.profilesDir, this.logsDir, this.screenshotsDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }

  emit(event, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      ...details,
    };
    this.events.push(entry);
    this.onEvent(entry);
  }

  async execute(params) {
    this.stopped = false;
    const {
      workflow_config: config,
      max_parallel_runs = 3,
      max_retries = 2,
      num_profiles = 1,
      vpn_settings = {},
    } = params;

    // Bulk registration mode: generate unique emails and run sequentially
    if (config.bulk_mode && config.bulk_count > 0) {
      return this.executeBulkRegistration(params);
    }

    const results = [];
    const concurrency = Math.min(max_parallel_runs, 5);

    this.emit('workflow_started', {
      status: 'started',
      details: {
        name: config.name,
        url: config.target_url,
        profiles: num_profiles,
        concurrency,
      },
    });

    // Build job queue
    const jobs = [];
    for (let i = 0; i < num_profiles; i++) {
      jobs.push({
        profileId: `profile_${String(i + 1).padStart(3, '0')}`,
        profileIndex: i,
        config,
        maxRetries: max_retries,
      });
    }

    // Execute with concurrency control
    let completed = 0;
    let failed = 0;
    const executing = new Set();

    for (const job of jobs) {
      if (this.stopped) break;

      const promise = this.runSingleWorkflow(job)
        .then(result => {
          results.push(result);
          if (result.success) completed++;
          else failed++;
          executing.delete(promise);
          this.onProgress({
            total_jobs: num_profiles,
            completed,
            failed,
            queued: jobs.length - completed - failed,
          });
        })
        .catch(err => {
          failed++;
          executing.delete(promise);
          results.push({ success: false, error: err.message, profileId: job.profileId });
        });

      executing.add(promise);

      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }

    // Wait for remaining
    await Promise.all(executing);

    this.emit('workflow_finished', {
      status: 'finished',
      details: { total: num_profiles, completed, failed },
    });

    // Save events log
    this.saveEventsLog();

    return results;
  }

  async runSingleWorkflow(job) {
    const { profileId, config, maxRetries } = job;
    const profilePath = path.join(this.profilesDir, profileId);

    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true });
    }

    // Generate environment fingerprint
    const fingerprint = this.generateFingerprint();
    this.saveFingerprintSeed(profilePath, fingerprint);

    const workflowId = uuidv4().slice(0, 8);
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.stopped) return { success: false, error: 'Stopped by user', profileId };

      if (attempt > 0) {
        this.emit('retry_started', {
          workflow_id: workflowId,
          profile_id: profileId,
          attempt,
          details: { previous_error: lastError },
        });
      }

      try {
        const result = await this.executeWorkflow(config, profilePath, fingerprint, workflowId, profileId);
        return { success: true, profileId, workflowId, ...result };
      } catch (err) {
        lastError = err.message;
        this.emit('workflow_failed', {
          workflow_id: workflowId,
          profile_id: profileId,
          status: 'error',
          error_message: err.message,
          details: { attempt },
        });

        // Capture failure screenshot
        await this.captureErrorScreenshot(profileId, workflowId, err.message);

        if (attempt >= maxRetries) {
          return { success: false, error: lastError, profileId, workflowId, attempts: attempt + 1 };
        }
      }
    }

    return { success: false, error: lastError, profileId };
  }

  findChromePath() {
    // Detect real Chrome installation on the system
    const possiblePaths = process.platform === 'win32' ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ] : process.platform === 'darwin' ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ] : [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ];

    for (const p of possiblePaths) {
      try {
        if (p && fs.existsSync(p)) return p;
      } catch (_) { /* skip */ }
    }
    return null;
  }

  async launchChromeManually(chromePath, profilePath, fingerprint) {
    // Launch Chrome as a normal process (NOT through Puppeteer) so that
    // Turnstile sees it as a regular browser, not an automated one.
    // Then connect via puppeteer.connect() to the debugging port.
    const port = 9222 + Math.floor(Math.random() * 1000);

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profilePath}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${fingerprint.viewport.width},${fingerprint.viewport.height}`,
      `--lang=${fingerprint.locale}`,
      '--disable-background-networking',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--password-store=basic',
      'about:blank',
    ];

    const chromeProc = spawn(chromePath, args, {
      detached: false,
      stdio: 'ignore',
    });

    // Wait for Chrome's debugging port to become available
    let wsUrl = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const jsonUrl = `http://127.0.0.1:${port}/json/version`;
        const data = await new Promise((resolve, reject) => {
          http.get(jsonUrl, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('bad json')); } });
          }).on('error', reject);
        });
        wsUrl = data.webSocketDebuggerUrl;
        if (wsUrl) break;
      } catch { /* not ready yet */ }
    }

    if (!wsUrl) {
      try { chromeProc.kill(); } catch {}
      throw new Error('Chrome debugging port did not become available');
    }

    return { chromeProc, wsUrl, port };
  }

  async executeWorkflow(config, profilePath, fingerprint, workflowId, profileId) {
    const chromePath = this.findChromePath();
    const usingRealChrome = !!chromePath;

    this.emit('browser_launch', {
      workflow_id: workflowId,
      profile_id: profileId,
      status: 'success',
      details: {
        fingerprint,
        stealth: true,
        user_data_dir: profilePath,
        browser: usingRealChrome ? 'Chrome (manual launch + CDP connect)' : 'Electron Chromium',
        chrome_path: usingRealChrome ? chromePath : 'not found',
      },
    });

    let browser, chromeProc;

    if (usingRealChrome) {
      // Launch Chrome manually and connect via CDP — this is critical for
      // Turnstile to solve. puppeteer.launch() injects automation markers
      // that Turnstile detects; manual launch + connect does not.
      const chromeInfo = await this.launchChromeManually(chromePath, profilePath, fingerprint);
      chromeProc = chromeInfo.chromeProc;
      browser = await puppeteer.connect({ browserWSEndpoint: chromeInfo.wsUrl });
    } else {
      // Fallback: Puppeteer launch with Electron's Chromium
      browser = await puppeteer.launch({
        executablePath: process.execPath,
        userDataDir: profilePath,
        headless: false,
        ignoreDefaultArgs: ['--enable-automation'],
        ignoreHTTPSErrors: true,
        args: [
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          '--no-default-browser-check',
          `--window-size=${fingerprint.viewport.width},${fingerprint.viewport.height}`,
          `--lang=${fingerprint.locale}`,
        ],
      });
    }

    try {
      let page = (await browser.pages())[0] || await browser.newPage();

      // Set viewport
      await page.setViewport(fingerprint.viewport);

      // Navigate to target
      this.emit('page_open', {
        workflow_id: workflowId,
        url: config.target_url,
        details: { stealth_injected: true },
      });

      await page.goto(config.target_url, {
        waitUntil: 'networkidle2',
        timeout: config.navigation_timeout_ms || 30000,
      });

      this.emit('navigation_success', {
        workflow_id: workflowId,
        url: config.target_url,
        status: 'success',
      });

      // Check for CAPTCHA
      const captchaDetected = await this.detectCaptcha(page, workflowId);
      if (captchaDetected) {
        this.emit('workflow_paused', {
          workflow_id: workflowId,
          details: { reason: 'captcha_detected', type: captchaDetected },
        });
      }

      // Check if this is a VAPI workflow (auto-detect or explicit)
      const isVapiWorkflow = config.target_url.includes('dashboard.vapi.ai') ||
                             config.target_url.includes('vapi.ai/register') ||
                             (config.workflow_type && config.workflow_type === 'vapi');

      if (isVapiWorkflow) {
        const vapiResult = await this.executeVapiWorkflow(page, config, workflowId, profileId);
        return { ...vapiResult, networkInfo: { timezone: fingerprint.timezone, locale: fingerprint.locale, userAgent: fingerprint.userAgent, viewport: fingerprint.viewport } };
      }

      // Check if this is a Speechify workflow (auto-detect or explicit)
      const isSpeechifyWorkflow = config.target_url.includes('speechify.com') ||
                                   (config.workflow_type && config.workflow_type === 'speechify');

      if (isSpeechifyWorkflow) {
        const speechifyResult = await this.executeSpeechifyWorkflow(page, config, workflowId, profileId, browser);
        return { ...speechifyResult, networkInfo: { timezone: fingerprint.timezone, locale: fingerprint.locale, userAgent: fingerprint.userAgent, viewport: fingerprint.viewport } };
      }

      // Execute generic workflow steps
      const steps = config.steps || [];
      for (const step of steps) {
        if (this.stopped) break;

        const resolvedValue = this.substituteCredentials(step.value, config.credentials);

        await this.executeStep(page, step, resolvedValue, workflowId, profileId, config);
      }

      // Capture network snapshot
      const networkInfo = {
        timezone: fingerprint.timezone,
        locale: fingerprint.locale,
        userAgent: fingerprint.userAgent,
        viewport: fingerprint.viewport,
      };

      return { networkInfo, steps_executed: steps.length };

    } finally {
      try { await browser.close(); } catch {}
      if (chromeProc) { try { chromeProc.kill(); } catch {} }
      this.emit('page_closed', { workflow_id: workflowId, profile_id: profileId });
    }
  }

  async executeStep(page, step, resolvedValue, workflowId, profileId, config) {
    const { action, selector } = step;
    const waitMs = step.wait_ms || config.action_delay_ms || 500;

    // Wait between actions
    if (waitMs > 0) {
      await new Promise(r => setTimeout(r, waitMs));
    }

    switch (action) {
      case 'navigate':
        await page.goto(resolvedValue || selector, {
          waitUntil: 'networkidle2',
          timeout: config.navigation_timeout_ms || 30000,
        });
        this.emit('navigation_success', { workflow_id: workflowId, url: resolvedValue });
        break;

      case 'fill':
        this.emit('selector_fill_attempt', { workflow_id: workflowId, selector, status: 'attempting' });
        try {
          await page.waitForSelector(selector, { timeout: config.selector_timeout_ms || 10000 });
          await page.type(selector, resolvedValue, { delay: 50 });
          this.emit('selector_fill_success', { workflow_id: workflowId, selector, status: 'success' });
        } catch (err) {
          this.emit('selector_fill_failed', { workflow_id: workflowId, selector, error_message: err.message });
          throw err;
        }
        break;

      case 'click':
        this.emit('selector_detected', { workflow_id: workflowId, selector });
        await page.waitForSelector(selector, { timeout: config.selector_timeout_ms || 10000 });
        await page.click(selector);
        break;

      case 'select':
        await page.waitForSelector(selector, { timeout: config.selector_timeout_ms || 10000 });
        await page.select(selector, resolvedValue);
        break;

      case 'wait':
        await new Promise(r => setTimeout(r, parseInt(resolvedValue) || 1000));
        break;

      case 'submit':
        await page.waitForSelector(selector, { timeout: config.selector_timeout_ms || 10000 });
        await page.click(selector);
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: config.navigation_timeout_ms || 30000 }).catch(() => {});
        break;

      case 'check':
        await page.waitForSelector(selector, { timeout: config.selector_timeout_ms || 10000 });
        await page.click(selector);
        break;

      default:
        this.emit('workflow_failed', { workflow_id: workflowId, error_message: `Unknown action: ${action}` });
    }
  }

  async detectCaptcha(page, workflowId) {
    for (const [type, selectors] of Object.entries(CAPTCHA_PATTERNS)) {
      for (const sel of selectors) {
        try {
          const found = await page.$(sel);
          if (found) {
            this.emit('captcha_detected', {
              workflow_id: workflowId,
              details: { type, selector: sel },
            });

            // Screenshot
            const screenshotPath = path.join(
              this.screenshotsDir,
              `captcha_${type}_${Date.now()}.png`
            );
            await page.screenshot({ path: screenshotPath, fullPage: true });
            this.emit('captcha_screenshot_saved', {
              workflow_id: workflowId,
              details: { path: screenshotPath },
            });

            return type;
          }
        } catch {
          // ignore
        }
      }
    }
    return null;
  }

  substituteCredentials(value, credentials = {}) {
    if (!value) return value;
    return value.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return credentials[key] !== undefined ? credentials[key] : match;
    });
  }

  generateFingerprint() {
    return {
      timezone: TIMEZONES[Math.floor(Math.random() * TIMEZONES.length)],
      locale: LOCALES[Math.floor(Math.random() * LOCALES.length)],
      viewport: VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)],
      userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
      colorScheme: Math.random() > 0.5 ? 'light' : 'dark',
    };
  }

  saveFingerprintSeed(profilePath, fingerprint) {
    const seedPath = path.join(profilePath, 'fingerprint_seed.json');
    fs.writeFileSync(seedPath, JSON.stringify(fingerprint, null, 2));
  }

  async captureErrorScreenshot(profileId, workflowId, error) {
    // Error screenshot is best-effort
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `failure_${profileId}_${timestamp}.png`;
      this.emit('captcha_screenshot_saved', {
        details: { path: path.join(this.screenshotsDir, filename), error },
      });
    } catch {
      // ignore
    }
  }

  saveEventsLog() {
    try {
      const logPath = path.join(this.logsDir, 'debug_session.json');
      fs.writeFileSync(logPath, JSON.stringify(this.events, null, 2));
    } catch {
      // ignore
    }
  }

  // ═══════════════════════════════════════════════════
  // VAPI AI Registration Workflow — Full automation
  // ═══════════════════════════════════════════════════

  async executeVapiWorkflow(page, config, workflowId, profileId) {
    const creds = config.credentials || {};
    const email = creds.email;
    const password = creds.password;
    const promoCode = creds.promo_code || creds.promoCode || '';
    const mailgunApiKey = creds.mailgun_api_key || creds.mailgunApiKey || '';
    const mailgunDomain = creds.mailgun_domain || creds.mailgunDomain || '';

    if (!email || !password) {
      throw new Error('VAPI workflow requires email and password in credentials');
    }

    const stepsCompleted = [];
    const timeoutMs = config.selector_timeout_ms || 15000;

    // Helper: wait for selector with logging
    const waitAndLog = async (selector, label) => {
      this.emit('selector_fill_attempt', { workflow_id: workflowId, details: { selector, label, status: 'waiting' } });
      await page.waitForSelector(selector, { timeout: timeoutMs });
      this.emit('selector_fill_success', { workflow_id: workflowId, details: { selector, label, status: 'found' } });
    };

    // Helper: human-like delay
    const humanDelay = (min = 500, max = 1500) => {
      const ms = Math.floor(Math.random() * (max - min) + min);
      return new Promise(r => setTimeout(r, ms));
    };

    // Helper: fill input using page.type() which sends real CDP keyboard events.
    // This is the only reliable way to fill React controlled inputs — it goes
    // through the browser's native event pipeline (keydown/keypress/input/keyup)
    // which React's synthetic event system picks up naturally.
    // nativeInputValueSetter + _valueTracker only works in DevTools console,
    // not from Puppeteer's page.evaluate() context.
    const humanType = async (selector, text) => {
      await page.click(selector, { clickCount: 3 }); // focus + select all existing text
      await humanDelay(100, 300);

      // Use real CDP keyboard events with a small delay between chars
      // to let React process each keystroke's onChange handler
      await page.type(selector, text, { delay: 20 });

      await humanDelay(200, 500);
    };

    try {
      // ─── STEP 1: Navigate to registration page ───
      this.emit('workflow_step', { workflow_id: workflowId, step: 1, action: 'navigate_register', status: 'starting' });

      const registerUrl = 'https://dashboard.vapi.ai/register';
      if (!page.url().includes('/register')) {
        await page.goto(registerUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      }
      await humanDelay(1000, 2000);
      this.emit('workflow_step', { workflow_id: workflowId, step: 1, action: 'navigate_register', status: 'success' });
      stepsCompleted.push('navigate_register');

      // ─── STEP 2: Wait for Turnstile + call Supabase signup API ───
      // VAPI uses Cloudflare Turnstile (invisible CAPTCHA) which keeps the
      // Sign Up button disabled until it solves. On real Chrome with user
      // data dir, Turnstile solves in ~2-5s. We extract the token and call
      // the Supabase signup API directly, bypassing the React form entirely.
      this.emit('workflow_step', { workflow_id: workflowId, step: 2, action: 'turnstile_wait', status: 'starting' });

      // Wait for Turnstile to solve (poll the hidden cf-turnstile-response input)
      let turnstileToken = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        turnstileToken = await page.evaluate(() => {
          const cf = document.querySelector('input[name="cf-turnstile-response"]');
          return cf && cf.value.length > 100 ? cf.value : null;
        }).catch(() => null);
        if (turnstileToken) break;
      }

      if (!turnstileToken) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 2, action: 'turnstile_wait', status: 'timeout' });
        throw new Error('Turnstile CAPTCHA did not solve within 60s');
      }

      this.emit('workflow_step', { workflow_id: workflowId, step: 2, action: 'turnstile_wait', status: 'solved', details: { token_length: turnstileToken.length } });

      // Call Supabase signup API directly with the Turnstile token
      this.emit('workflow_step', { workflow_id: workflowId, step: 2, action: 'supabase_signup', status: 'starting' });

      const signupResult = await this.httpPostJson('https://auth.vapi.ai/auth/v1/signup', {
        email,
        password,
        gotrue_meta_security: { captcha_token: turnstileToken },
      }, { 'apikey': SUPABASE_ANON_KEY });

      const needsVerification = !!(signupResult && signupResult.id);

      if (needsVerification) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 2, action: 'supabase_signup', status: 'success', details: { user_id: signupResult.id, needs_verification: true } });
      } else {
        const errMsg = signupResult ? (signupResult.msg || signupResult.message || JSON.stringify(signupResult)) : 'No response';
        this.emit('workflow_step', { workflow_id: workflowId, step: 2, action: 'supabase_signup', status: 'failed', details: { error: errMsg } });
        throw new Error(`Signup API failed: ${errMsg}`);
      }

      stepsCompleted.push('signup_api');
      this.emit('workflow_step', { workflow_id: workflowId, step: 2, action: 'fill_registration', status: 'success', details: { needs_verification: needsVerification } });

      if (this.stopped) return { steps_completed: stepsCompleted, steps_executed: stepsCompleted.length, stopped: true };

      // ─── STEP 2.5: Email verification ───
      if (needsVerification && mailgunApiKey && mailgunDomain) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 2.5, action: 'email_verification', status: 'starting' });

        // Poll Mailgun for verification email (up to 60s)
        let verificationLink = null;
        const maxAttempts = 12;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (this.stopped) break;
          this.emit('workflow_step', { workflow_id: workflowId, step: 2.5, action: 'email_verification', status: 'polling', details: { attempt: attempt + 1, max: maxAttempts } });

          verificationLink = await this.fetchVerificationLink(mailgunApiKey, mailgunDomain, email);
          if (verificationLink) break;

          await new Promise(r => setTimeout(r, 5000)); // Wait 5s between polls
        }

        if (verificationLink) {
          this.emit('workflow_step', { workflow_id: workflowId, step: 2.5, action: 'email_verification', status: 'link_found' });

          // Navigate to verification link
          await page.goto(verificationLink, { waitUntil: 'networkidle2', timeout: 30000 });
          await humanDelay(3000, 5000);
          stepsCompleted.push('email_verified');
          this.emit('workflow_step', { workflow_id: workflowId, step: 2.5, action: 'email_verification', status: 'success' });
        } else {
          this.emit('workflow_step', { workflow_id: workflowId, step: 2.5, action: 'email_verification', status: 'no_link_found', details: { message: 'Could not find verification email. Will attempt login anyway.' } });
        }
      } else if (needsVerification) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 2.5, action: 'email_verification', status: 'skipped', details: { message: 'No Mailgun API key provided. Email verification must be done manually.' } });
      }

      // ─── STEP 3: Login via Supabase token API ───
      // Login page also has Turnstile, so we use the same API approach:
      // navigate to login page → wait for Turnstile → call Supabase token API
      // → inject auth session into localStorage → reload dashboard
      const afterVerifyUrl = page.url();
      if (!afterVerifyUrl.includes('/composer') && !afterVerifyUrl.includes('/assistants') && !afterVerifyUrl.includes('/settings')) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 3, action: 'login', status: 'starting' });

        await page.goto('https://dashboard.vapi.ai/login', { waitUntil: 'networkidle2', timeout: 30000 });
        await humanDelay(1000, 2000);

        // Wait for Turnstile to solve on login page
        let loginToken = null;
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000));
          loginToken = await page.evaluate(() => {
            const cf = document.querySelector('input[name="cf-turnstile-response"]');
            return cf && cf.value.length > 100 ? cf.value : null;
          }).catch(() => null);
          if (loginToken) break;
        }

        if (loginToken) {
          // Call Supabase token API for login
          const loginResult = await this.httpPostJson(
            'https://auth.vapi.ai/auth/v1/token?grant_type=password',
            { email, password, gotrue_meta_security: { captcha_token: loginToken } },
            { 'apikey': SUPABASE_ANON_KEY }
          );

          if (loginResult && loginResult.access_token) {
            // Inject auth session into localStorage and reload
            await page.evaluate((authData) => {
              localStorage.setItem('vapi-supabase-auth', JSON.stringify(authData));
            }, loginResult);

            await page.goto('https://dashboard.vapi.ai/', { waitUntil: 'networkidle2', timeout: 30000 });
            await humanDelay(3000, 5000);

            this.emit('workflow_step', { workflow_id: workflowId, step: 3, action: 'login', status: 'success', details: { method: 'supabase_token_api' } });
          } else {
            this.emit('workflow_step', { workflow_id: workflowId, step: 3, action: 'login', status: 'failed', details: { error: loginResult ? (loginResult.msg || loginResult.error_description || JSON.stringify(loginResult)) : 'No response' } });
          }
        } else {
          this.emit('workflow_step', { workflow_id: workflowId, step: 3, action: 'login', status: 'failed', details: { error: 'Turnstile did not solve on login page' } });
        }

        stepsCompleted.push('login');
      } else {
        stepsCompleted.push('login_skipped_already_on_dashboard');
      }

      // ─── STEP 3.5: Handle onboarding survey (if present) ───
      try {
        await this.handleVapiOnboarding(page, workflowId);
      } catch (onboardErr) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 3.5, action: 'onboarding_survey', status: 'error', details: { error: onboardErr.message } });
      }
      stepsCompleted.push('onboarding_handled');

      if (this.stopped) return { steps_completed: stepsCompleted, steps_executed: stepsCompleted.length, stopped: true };

      // ─── STEP 4: Apply promo code via VAPI API ───
      // The coupon dialog is a React controlled component — filling it via
      // Puppeteer doesn't trigger React state. Instead, we call the VAPI API
      // directly: GET /org → POST /subscription/{id}/coupon.
      if (promoCode) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 4, action: 'apply_promo', status: 'starting' });

        try {
          // Extract auth token from browser localStorage
          const authToken = await page.evaluate(() => {
            const data = localStorage.getItem('vapi-supabase-auth');
            if (!data) return null;
            const parsed = JSON.parse(data);
            return parsed.access_token || null;
          }).catch(() => null);

          if (!authToken) {
            this.emit('workflow_step', { workflow_id: workflowId, step: 4, action: 'apply_promo', status: 'failed', details: { message: 'No auth token in localStorage' } });
          } else {
            // Get org data to find subscriptionId
            const orgData = await this.httpGetJson('https://api.vapi.ai/org', { 'Authorization': `Bearer ${authToken}` });
            const org = Array.isArray(orgData) ? orgData[0] : orgData;
            const subId = org ? org.subscriptionId : null;
            const orgId = org ? org.id : null;

            if (subId && orgId) {
              // Apply coupon via API
              const couponResult = await this.httpPostJson(
                `https://api.vapi.ai/subscription/${subId}/coupon`,
                { couponCode: promoCode, orgId },
                { 'Authorization': `Bearer ${authToken}` }
              );

              const newCredits = couponResult ? couponResult.credits : null;
              if (newCredits && parseFloat(newCredits) > 10) {
                stepsCompleted.push('promo_applied');
                this.emit('workflow_step', {
                  workflow_id: workflowId, step: 4, action: 'apply_promo', status: 'success',
                  details: { promo_code: promoCode, credits: newCredits },
                });
              } else {
                const errMsg = couponResult ? (couponResult.message || couponResult.msg || JSON.stringify(couponResult)) : 'No response';
                this.emit('workflow_step', { workflow_id: workflowId, step: 4, action: 'apply_promo', status: 'failed', details: { error: errMsg } });
              }
            } else {
              this.emit('workflow_step', { workflow_id: workflowId, step: 4, action: 'apply_promo', status: 'failed', details: { message: 'No subscription/org found' } });
            }
          }
        } catch (err) {
          this.emit('workflow_step', { workflow_id: workflowId, step: 4, action: 'apply_promo', status: 'failed', details: { error: err.message } });
        }
      } else {
        this.emit('workflow_step', { workflow_id: workflowId, step: 4, action: 'apply_promo', status: 'skipped', details: { message: 'No promo code provided' } });
      }

      // ─── STEP 5: Log out ───
      this.emit('workflow_step', { workflow_id: workflowId, step: 5, action: 'logout', status: 'starting' });

      // Click org menu to reveal Sign out
      const signedOut = await page.evaluate(() => {
        // Try clicking the org menu button
        const menuBtn = document.querySelector('button[name="account-menu-trigger"]');
        if (menuBtn) {
          menuBtn.click();
          return 'menu_opened';
        }
        return 'no_menu_button';
      });

      if (signedOut === 'menu_opened') {
        await humanDelay(500, 1000);

        // Click Sign out
        const loggedOut = await page.evaluate(() => {
          const items = document.querySelectorAll('[aria-label="Sign out"]');
          if (items.length > 0) {
            items[0].click();
            return true;
          }
          // Fallback: find by text
          const allElements = document.querySelectorAll('div[tabindex="0"]');
          for (const el of allElements) {
            if (el.textContent.trim() === 'Sign out') {
              el.click();
              return true;
            }
          }
          return false;
        });

        if (loggedOut) {
          await humanDelay(2000, 4000);
          stepsCompleted.push('logout');
          this.emit('workflow_step', { workflow_id: workflowId, step: 5, action: 'logout', status: 'success' });
        } else {
          this.emit('workflow_step', { workflow_id: workflowId, step: 5, action: 'logout', status: 'failed', details: { message: 'Could not find Sign out button' } });
        }
      }

      return { steps_completed: stepsCompleted, steps_executed: stepsCompleted.length };

    } catch (err) {
      // Capture screenshot on error
      try {
        const screenshotPath = path.join(this.screenshotsDir, `vapi_error_${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        this.emit('workflow_step', { workflow_id: workflowId, action: 'error_screenshot', details: { path: screenshotPath } });
      } catch {}

      throw err;
    }
  }

  async handleVapiOnboarding(page, workflowId) {
    // Handle the multi-step onboarding survey that appears after first login
    try {
      // Check if "Welcome! Where did you hear about us?" is present
      const hasOnboarding = await page.evaluate(() => {
        return document.body.innerText.includes('Where did you hear about us');
      });

      if (!hasOnboarding) {
        // Check for monitoring dialog and close it
        const hasMonitoringDialog = await page.evaluate(() => {
          const closeBtn = document.querySelector('button[aria-label="Close"]');
          if (closeBtn) { closeBtn.click(); return true; }
          return false;
        });
        if (hasMonitoringDialog) {
          await new Promise(r => setTimeout(r, 500));
        }
        return;
      }

      this.emit('workflow_step', { workflow_id: workflowId, step: 3.5, action: 'onboarding_survey', status: 'starting' });

      // Close any monitoring dialog first
      await page.evaluate(() => {
        const closeBtn = document.querySelector('button[aria-label="Close"]');
        if (closeBtn) closeBtn.click();
      });
      await new Promise(r => setTimeout(r, 500));

      // Step 1: Select "Twitter" (or any option) for "Where did you hear about us?"
      const selectedSource = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const twitterBtn = buttons.find(b => b.textContent.includes('Twitter'));
        if (twitterBtn) { twitterBtn.click(); return 'Twitter'; }
        // Fallback: click first option
        const firstOption = buttons.find(b => b.textContent.includes('Blog'));
        if (firstOption) { firstOption.click(); return 'Blog'; }
        return null;
      });

      if (selectedSource) {
        await new Promise(r => setTimeout(r, 1000));

        // Click Next
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const nextBtn = buttons.find(b => b.textContent.trim().startsWith('Next'));
          if (nextBtn && !nextBtn.disabled) nextBtn.click();
        });
        await new Promise(r => setTimeout(r, 1500));

        // Step 2: "What is your role?" — Select Developer
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const devBtn = buttons.find(b => b.textContent.includes('Developer'));
          if (devBtn) devBtn.click();
        });
        await new Promise(r => setTimeout(r, 1000));

        // Click Next
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const nextBtn = buttons.find(b => b.textContent.trim().startsWith('Next'));
          if (nextBtn && !nextBtn.disabled) nextBtn.click();
        });
        await new Promise(r => setTimeout(r, 1500));

        // Step 3: "What are you using Vapi for?" — Select Personal Project
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const personalBtn = buttons.find(b => b.textContent.includes('Personal Project'));
          if (personalBtn) personalBtn.click();
        });
        await new Promise(r => setTimeout(r, 1000));

        // Click "Get Started"
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const getStartedBtn = buttons.find(b => b.textContent.trim() === 'Get Started');
          if (getStartedBtn && !getStartedBtn.disabled) getStartedBtn.click();
        });
        await new Promise(r => setTimeout(r, 2000));

        // Close the "Create an Agent" page if it appears (click X/skip button)
        await page.evaluate(() => {
          const skipBtn = document.querySelector('button[aria-label="Skip to dashboard"]');
          if (skipBtn) skipBtn.click();
        });
        await new Promise(r => setTimeout(r, 1000));

        this.emit('workflow_step', { workflow_id: workflowId, step: 3.5, action: 'onboarding_survey', status: 'success' });
      }
    } catch (err) {
      this.emit('workflow_step', { workflow_id: workflowId, step: 3.5, action: 'onboarding_survey', status: 'skipped', details: { error: err.message } });
    }
  }

  // ═══════════════════════════════════════════════════
  // Speechify Workflow — Full onboarding + payment automation
  // ═══════════════════════════════════════════════════
  //
  // Flow:
  // 1. Navigate to speechify.com/l/wondertools (promo landing)
  // 2. Answer onboarding questions (use case, how you listen)
  // 3. Create account with email + password
  // 4. Reach payment page with 100% discount promo
  // 5. Fill Stripe payment form via CDP (cross-origin iframe)
  // 6. Submit payment ($0.00)
  // 7. Verify dashboard access
  // ═══════════════════════════════════════════════════

  async executeSpeechifyWorkflow(page, config, workflowId, profileId, browser) {
    const creds = config.credentials || {};
    const email = creds.email;
    const password = creds.password;
    const cardNumber = creds.card_number || creds.cardNumber || '5598880369500915';
    const cardExpiry = creds.card_expiry || creds.cardExpiry || '0927';
    const cardCvc = creds.card_cvc || creds.cardCvc || '801';
    const mailgunApiKey = creds.mailgun_api_key || creds.mailgunApiKey || '';
    const mailgunDomain = creds.mailgun_domain || creds.mailgunDomain || '';

    if (!email || !password) {
      throw new Error('Speechify workflow requires email and password in credentials');
    }

    const stepsCompleted = [];
    const timeoutMs = config.selector_timeout_ms || 15000;

    const humanDelay = (min = 500, max = 1500) => {
      const ms = Math.floor(Math.random() * (max - min) + min);
      return new Promise(r => setTimeout(r, ms));
    };

    const humanType = async (selector, text) => {
      await page.click(selector, { clickCount: 3 });
      await humanDelay(100, 300);
      await page.type(selector, text, { delay: 20 });
      await humanDelay(200, 500);
    };

    try {
      // ─── STEP 1: Navigate to Speechify promo landing ───
      this.emit('workflow_step', { workflow_id: workflowId, step: 1, action: 'navigate_speechify', status: 'starting' });

      const landingUrl = config.target_url || 'https://speechify.com/l/wondertools';
      if (!page.url().includes('speechify.com')) {
        await page.goto(landingUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      }
      await humanDelay(2000, 3000);

      this.emit('workflow_step', { workflow_id: workflowId, step: 1, action: 'navigate_speechify', status: 'success', details: { url: page.url() } });
      stepsCompleted.push('navigate_landing');

      if (this.stopped) return { steps_completed: stepsCompleted, steps_executed: stepsCompleted.length, stopped: true };

      // ─── STEP 2: Handle onboarding questions ───
      // Speechify shows multi-step onboarding questions before signup.
      // The questions vary but typically include use case and listening preferences.
      this.emit('workflow_step', { workflow_id: workflowId, step: 2, action: 'onboarding_questions', status: 'starting' });

      await this.handleSpeechifyOnboarding(page, workflowId);
      stepsCompleted.push('onboarding_questions');

      if (this.stopped) return { steps_completed: stepsCompleted, steps_executed: stepsCompleted.length, stopped: true };

      // ─── STEP 3: Create account (email + password) ───
      this.emit('workflow_step', { workflow_id: workflowId, step: 3, action: 'create_account', status: 'starting' });

      await this.handleSpeechifySignup(page, email, password, workflowId);
      stepsCompleted.push('account_created');

      if (this.stopped) return { steps_completed: stepsCompleted, steps_executed: stepsCompleted.length, stopped: true };

      // ─── STEP 3.5: Email verification (only if page requires it) ───
      // Check page content (not URL — signup and payment share same URL on Speechify)
      const pageContent = await page.evaluate(() => {
        const text = document.body.innerText;
        return {
          hasPaymentIndicator: text.includes('$0.00') || text.includes('Discount') || text.includes('100% off') || text.includes('Claim') || text.includes('payment'),
          hasVerifyPrompt: text.includes('verify your email') || text.includes('check your email') || text.includes('confirmation'),
        };
      });
      const alreadyPastVerification = pageContent.hasPaymentIndicator && !pageContent.hasVerifyPrompt;

      if (alreadyPastVerification) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 3.5, action: 'email_verification', status: 'skipped', details: { message: 'Already on payment page — verification not required' } });
      } else if (mailgunApiKey && mailgunDomain) {
        // Quick check only (2 attempts, 5s each = 10s max) — Speechify rarely requires verification
        this.emit('workflow_step', { workflow_id: workflowId, step: 3.5, action: 'email_verification', status: 'starting' });

        let verificationLink = null;
        const maxAttempts = 2;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (this.stopped) break;
          this.emit('workflow_step', { workflow_id: workflowId, step: 3.5, action: 'email_verification', status: 'polling', details: { attempt: attempt + 1, max: maxAttempts } });

          verificationLink = await this.fetchSpeechifyVerificationLink(mailgunApiKey, mailgunDomain, email);
          if (verificationLink) break;

          await new Promise(r => setTimeout(r, 5000));
        }

        if (verificationLink) {
          this.emit('workflow_step', { workflow_id: workflowId, step: 3.5, action: 'email_verification', status: 'link_found' });
          await page.goto(verificationLink, { waitUntil: 'networkidle2', timeout: 60000 });
          await humanDelay(3000, 5000);
          stepsCompleted.push('email_verified');
          this.emit('workflow_step', { workflow_id: workflowId, step: 3.5, action: 'email_verification', status: 'success' });
        } else {
          this.emit('workflow_step', { workflow_id: workflowId, step: 3.5, action: 'email_verification', status: 'skipped', details: { message: 'No verification email needed. Continuing to payment.' } });
        }
      }

      // ─── STEP 4: Navigate to payment page + verify $0 promo ───
      this.emit('workflow_step', { workflow_id: workflowId, step: 4, action: 'payment_page', status: 'starting' });

      // Check if we're already on the promo paywall page
      const currentUrl = page.url();
      if (!currentUrl.includes('/promo/') && !currentUrl.includes('paywall')) {
        // Navigate to the promo paywall URL
        const promoUrl = 'https://speechify.com/onboarding/nc/promo/paywall-p/?promo=JDKSN292NDKWON&priceId=price_1QpTYsBtf7hakIXChv4GUhEG';
        await page.goto(promoUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await humanDelay(2000, 3000);
      }

      // Verify $0.00 pricing is shown (poll up to 30s — page may still be loading)
      let pricingCheck = null;
      for (let priceWait = 0; priceWait < 15; priceWait++) {
        pricingCheck = await page.evaluate(() => {
          const text = document.body.innerText;
          return {
            hasDiscount: text.includes('-100%') || text.includes('100% off') || text.includes('save'),
            hasFreePrice: text.includes('$0.00') || text.includes('$0.00/year'),
            hasPromo: text.includes('JDKSN292NDKWON'),
            hasPaymentForm: !!document.querySelector('iframe[src*="stripe.com"]') || text.includes('Card number') || text.includes('Payment'),
          };
        });

        if (pricingCheck.hasFreePrice || pricingCheck.hasPaymentForm) break;
        await new Promise(r => setTimeout(r, 2000));
      }

      this.emit('workflow_step', { workflow_id: workflowId, step: 4, action: 'payment_page', status: 'price_verified', details: pricingCheck });

      if (!pricingCheck.hasFreePrice && !pricingCheck.hasPaymentForm) {
        // Take screenshot before aborting
        const screenshotPath = path.join(this.screenshotsDir, `no_pricing_${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
        throw new Error('Payment page does NOT show $0.00 — aborting to prevent charges');
      }

      stepsCompleted.push('payment_page_verified');

      if (this.stopped) return { steps_completed: stepsCompleted, steps_executed: stepsCompleted.length, stopped: true };

      // ─── STEP 5: Open payment modal + fill Stripe form via CDP ───
      this.emit('workflow_step', { workflow_id: workflowId, step: 5, action: 'fill_payment', status: 'starting' });

      // Click the payment/claim button to open payment modal
      // Button text varies: "Claim 100% Discount", "Start Free Trial", "Subscribe", "Continue", etc.
      const claimClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, a[role="button"]'));
        const paymentKeywords = ['Claim', 'Discount', 'Subscribe', 'Start', 'Trial', 'Buy', 'Pay', 'Get Premium', 'Continue to payment'];
        // Find the most prominent payment-related button
        let claimBtn = buttons.find(b => b.textContent.includes('Claim 100% Discount'));
        if (!claimBtn) claimBtn = buttons.find(b => b.textContent.includes('Claim'));
        if (!claimBtn) claimBtn = buttons.find(b => b.textContent.includes('Start Free Trial'));
        if (!claimBtn) claimBtn = buttons.find(b => b.textContent.includes('Subscribe'));
        if (!claimBtn) claimBtn = buttons.find(b => {
          const text = b.textContent.trim();
          return paymentKeywords.some(k => text.includes(k)) && text.length < 60;
        });
        if (claimBtn) { claimBtn.click(); return claimBtn.textContent.trim(); }
        return null;
      });

      this.emit('workflow_step', { workflow_id: workflowId, step: 5, action: 'fill_payment', status: 'claim_button', details: { clicked: claimClicked } });

      if (claimClicked) {
        await humanDelay(5000, 8000); // Give Stripe iframe extra time to load
      } else {
        // No specific claim button found — the payment form may already be inline on the page
        await humanDelay(3000, 5000);
      }

      // Fill Stripe payment form via CDP (cross-origin iframe) with retry
      // Stripe iframe can take a few seconds to load after clicking the claim button
      let stripeAttempts = 0;
      const maxStripeAttempts = 3;
      while (stripeAttempts < maxStripeAttempts) {
        try {
          await this.fillStripePaymentForm(page, browser, cardNumber, cardExpiry, cardCvc, workflowId);
          break;
        } catch (err) {
          stripeAttempts++;
          if (stripeAttempts >= maxStripeAttempts) throw err;
          this.emit('workflow_step', { workflow_id: workflowId, step: 5, action: 'fill_payment', status: 'stripe_retry', details: { attempt: stripeAttempts, error: err.message } });
          await new Promise(r => setTimeout(r, 5000)); // Wait 5s and retry
        }
      }
      stepsCompleted.push('payment_form_filled');

      if (this.stopped) return { steps_completed: stepsCompleted, steps_executed: stepsCompleted.length, stopped: true };

      // ─── STEP 6: Submit payment (click Buy Now) ───
      // Clicking "Buy Now" may trigger a reCAPTCHA v2 challenge.
      // Strategy: click Buy Now → detect reCAPTCHA → solve via audio challenge → click Buy Now again.
      this.emit('workflow_step', { workflow_id: workflowId, step: 6, action: 'submit_payment', status: 'starting' });

      const clickBuyNow = async () => {
        return page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const buyBtn = buttons.find(b => b.textContent.includes('Buy Now'));
          if (buyBtn) { buyBtn.click(); return true; }
          return false;
        });
      };

      const submitted = await clickBuyNow();

      if (submitted) {
        await humanDelay(3000, 5000);

        // Check if reCAPTCHA appeared after clicking Buy Now
        const recaptchaDetected = await page.evaluate(() => {
          const iframes = document.querySelectorAll('iframe[src*="recaptcha"]');
          for (const iframe of iframes) {
            const rect = iframe.getBoundingClientRect();
            if (rect.width > 50 && rect.height > 50) return true;
          }
          return false;
        });

        if (recaptchaDetected) {
          this.emit('workflow_step', { workflow_id: workflowId, step: 6, action: 'solve_recaptcha', status: 'detected' });

          // Solve reCAPTCHA via audio challenge using CDP
          const cdpPort = new URL(browser.wsEndpoint()).port;
          const recaptchaSolved = await this.solveRecaptchaViaAudio(cdpPort, workflowId);

          if (recaptchaSolved) {
            this.emit('workflow_step', { workflow_id: workflowId, step: 6, action: 'solve_recaptcha', status: 'solved' });
            await humanDelay(1000, 2000);
            // Click Buy Now again now that reCAPTCHA is solved
            await clickBuyNow();
          } else {
            // Audio solve failed — wait for manual solve (user completes captcha in the app window)
            this.emit('workflow_step', { workflow_id: workflowId, step: 6, action: 'solve_recaptcha', status: 'waiting_manual', details: { message: 'Audio solve failed — please solve the captcha manually in the app window' } });

            // Poll for up to 120 seconds for user to solve manually
            const manualTimeout = 120000;
            const pollInterval = 3000;
            const startTime = Date.now();
            let manuallySolved = false;

            while (Date.now() - startTime < manualTimeout && !this.stopped) {
              await humanDelay(pollInterval, pollInterval + 500);
              const stillVisible = await page.evaluate(() => {
                const iframes = document.querySelectorAll('iframe[src*="recaptcha"]');
                for (const iframe of iframes) {
                  const rect = iframe.getBoundingClientRect();
                  if (rect.width > 50 && rect.height > 50) return true;
                }
                return false;
              });
              if (!stillVisible) { manuallySolved = true; break; }
            }

            if (manuallySolved) {
              this.emit('workflow_step', { workflow_id: workflowId, step: 6, action: 'solve_recaptcha', status: 'solved_manually' });
              await humanDelay(1000, 2000);
              await clickBuyNow();
            } else {
              throw new Error('reCAPTCHA was not solved within 120 seconds');
            }
          }

          await humanDelay(5000, 10000);
        } else {
          // No reCAPTCHA — just wait for payment processing
          await humanDelay(3000, 7000);
        }

        // Check for success indicators
        const postPayment = await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          return {
            url: window.location.href,
            hasWelcome: text.includes('welcome') || text.includes('congratulations') || text.includes('success'),
            hasDashboard: text.includes('library') || text.includes('home') || text.includes('dashboard'),
            hasError: text.includes('error') || text.includes('declined') || text.includes('failed'),
          };
        });

        this.emit('workflow_step', { workflow_id: workflowId, step: 6, action: 'submit_payment', status: postPayment.hasError ? 'error' : 'success', details: postPayment });

        if (postPayment.hasError) {
          throw new Error('Payment submission failed — card may have been declined');
        }

        stepsCompleted.push('payment_submitted');
      } else {
        this.emit('workflow_step', { workflow_id: workflowId, step: 6, action: 'submit_payment', status: 'failed', details: { message: 'Could not find Buy Now button' } });
      }

      // ─── STEP 7: Verify dashboard access ───
      this.emit('workflow_step', { workflow_id: workflowId, step: 7, action: 'verify_dashboard', status: 'starting' });

      // Navigate to Speechify dashboard
      await page.goto('https://speechify.com/dashboard', { waitUntil: 'networkidle2', timeout: 60000 });
      await humanDelay(3000, 5000);

      const dashboardCheck = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return {
          url: window.location.href,
          isLoggedIn: !text.includes('sign in') && !text.includes('log in') && !text.includes('create account'),
          hasDashboard: text.includes('library') || text.includes('home') || text.includes('listen') || text.includes('speechify'),
        };
      });

      this.emit('workflow_step', { workflow_id: workflowId, step: 7, action: 'verify_dashboard', status: dashboardCheck.isLoggedIn ? 'success' : 'failed', details: dashboardCheck });

      if (dashboardCheck.isLoggedIn) {
        stepsCompleted.push('dashboard_verified');
      }

      // ─── STEP 8: Logout ───
      this.emit('workflow_step', { workflow_id: workflowId, step: 8, action: 'logout', status: 'starting' });

      const loggedOut = await page.evaluate(() => {
        // Look for settings/profile menu to find logout
        const avatarBtn = document.querySelector('[data-testid="user-avatar"], [aria-label="Profile"], button[aria-label="Account"]');
        if (avatarBtn) { avatarBtn.click(); return 'menu_opened'; }
        // Try finding any logout link directly
        const logoutLinks = Array.from(document.querySelectorAll('a, button')).filter(el => el.textContent.toLowerCase().includes('log out') || el.textContent.toLowerCase().includes('sign out'));
        if (logoutLinks.length > 0) { logoutLinks[0].click(); return 'logout_clicked'; }
        return 'no_logout_found';
      });

      if (loggedOut === 'menu_opened') {
        await humanDelay(500, 1000);
        await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('a, button, div[role="menuitem"]'));
          const logoutItem = items.find(el => el.textContent.toLowerCase().includes('log out') || el.textContent.toLowerCase().includes('sign out'));
          if (logoutItem) logoutItem.click();
        });
        await humanDelay(2000, 3000);
        stepsCompleted.push('logout');
        this.emit('workflow_step', { workflow_id: workflowId, step: 8, action: 'logout', status: 'success' });
      } else if (loggedOut === 'logout_clicked') {
        await humanDelay(2000, 3000);
        stepsCompleted.push('logout');
        this.emit('workflow_step', { workflow_id: workflowId, step: 8, action: 'logout', status: 'success' });
      } else {
        this.emit('workflow_step', { workflow_id: workflowId, step: 8, action: 'logout', status: 'skipped', details: { message: 'Could not find logout button' } });
      }

      return { steps_completed: stepsCompleted, steps_executed: stepsCompleted.length };

    } catch (err) {
      try {
        const screenshotPath = path.join(this.screenshotsDir, `speechify_error_${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        this.emit('workflow_step', { workflow_id: workflowId, action: 'error_screenshot', details: { path: screenshotPath } });
      } catch {}
      throw err;
    }
  }

  async handleSpeechifyOnboarding(page, workflowId) {
    // Handle multi-step onboarding questions on speechify.com
    // Questions vary but typically ask about use case and listening preferences
    const maxSteps = 10;

    for (let step = 0; step < maxSteps; step++) {
      await new Promise(r => setTimeout(r, 2000));

      const pageState = await page.evaluate(() => {
        const text = document.body.innerText;
        const buttons = Array.from(document.querySelectorAll('button'));
        const buttonTexts = buttons.map(b => b.textContent.trim()).filter(t => t.length > 0 && t.length < 100);
        const hasEmailInput = !!(document.querySelector('input[type="email"]') || document.querySelector('input[name="email"]') || document.querySelector('input[placeholder*="mail"]'));
        const hasPasswordInput = !!(document.querySelector('input[type="password"]') || document.querySelector('input[name="password"]'));
        return {
          url: window.location.href,
          hasOnboarding: text.includes('How do you') || text.includes('What would you') || text.includes('Choose') || text.includes('want to listen'),
          hasSignup: hasEmailInput || text.includes('Create your account') || text.includes('Sign up'),
          hasPayment: text.includes('Payment') || text.includes('$0.00') || text.includes('Discount'),
          buttonTexts,
        };
      });

      this.emit('workflow_step', { workflow_id: workflowId, step: 2, action: 'onboarding_questions', status: 'step_' + step, details: pageState });

      // If we've reached signup or payment page, onboarding is done
      if (pageState.hasSignup || pageState.hasPayment) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 2, action: 'onboarding_questions', status: 'success', details: { steps_taken: step } });
        return;
      }

      if (!pageState.hasOnboarding && step > 0) {
        return;
      }

      // Click the first visible option button (not navigation/social login buttons)
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        // Filter out navigation/close/social login buttons — look for onboarding option buttons
        const skipTexts = ['Next', 'Back', 'Skip', 'Close', 'X', 'Log in', 'Login', 'Sign in'];
        const socialPrefixes = ['Continue with', 'Sign in with', 'Sign up with', 'Log in with'];
        const optionBtns = buttons.filter(b => {
          const text = b.textContent.trim();
          if (text.length === 0 || text.length > 80) return false;
          if (skipTexts.includes(text)) return false;
          if (socialPrefixes.some(p => text.startsWith(p))) return false;
          if (text === 'Continue') return false; // Skip generic Continue — handled separately
          // Likely an option if it's inside the main content area
          const rect = b.getBoundingClientRect();
          return rect.width > 50 && rect.height > 20 && rect.top > 100;
        });

        if (optionBtns.length > 0) {
          // Pick a random option for variety
          const idx = Math.floor(Math.random() * optionBtns.length);
          optionBtns[idx].click();
          return optionBtns[idx].textContent.trim();
        }
        return null;
      });

      if (clicked) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 2, action: 'onboarding_questions', status: 'option_selected', details: { selected: clicked } });
        await new Promise(r => setTimeout(r, 1500));

        // Click "Next" or "Continue" if present
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const nextBtn = buttons.find(b => {
            const text = b.textContent.trim();
            return text === 'Next' || text === 'Continue' || text.startsWith('Next');
          });
          if (nextBtn && !nextBtn.disabled) nextBtn.click();
        });
        await new Promise(r => setTimeout(r, 2000));
      } else {
        // No option buttons found — try clicking any prominent button
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const btn = buttons.find(b => {
            const text = b.textContent.trim();
            return text === 'Get Started' || text === 'Continue' || text === 'Start';
          });
          if (btn) btn.click();
        });
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  async handleSpeechifySignup(page, email, password, workflowId) {
    // Handle the Speechify account creation page
    // Look for email/password fields and fill them
    this.emit('workflow_step', { workflow_id: workflowId, step: 3, action: 'create_account', status: 'filling_form' });

    // Wait for signup form to appear
    let formFound = false;
    for (let i = 0; i < 10; i++) {
      formFound = await page.evaluate(() => {
        return !!(document.querySelector('input[type="email"]') || document.querySelector('input[name="email"]'));
      });
      if (formFound) break;
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!formFound) {
      // Check if we're already past signup (already on payment page)
      const alreadyPastSignup = await page.evaluate(() => {
        const text = document.body.innerText;
        return text.includes('Payment') || text.includes('$0.00') || text.includes('Discount');
      });
      if (alreadyPastSignup) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 3, action: 'create_account', status: 'skipped', details: { message: 'Already past signup — on payment page' } });
        return;
      }
      throw new Error('Could not find signup form within 20 seconds');
    }

    // Fill email
    const emailSelector = await page.evaluate(() => {
      if (document.querySelector('input[type="email"]')) return 'input[type="email"]';
      if (document.querySelector('input[name="email"]')) return 'input[name="email"]';
      if (document.querySelector('input[placeholder*="email" i]')) return 'input[placeholder*="email" i]';
      return null;
    });

    if (emailSelector) {
      await page.click(emailSelector, { clickCount: 3 });
      await new Promise(r => setTimeout(r, 200));
      await page.type(emailSelector, email, { delay: 25 });
      await new Promise(r => setTimeout(r, 500));
    }

    // Fill password
    const passwordSelector = await page.evaluate(() => {
      if (document.querySelector('input[type="password"]')) return 'input[type="password"]';
      if (document.querySelector('input[name="password"]')) return 'input[name="password"]';
      return null;
    });

    if (passwordSelector) {
      await page.click(passwordSelector, { clickCount: 3 });
      await new Promise(r => setTimeout(r, 200));
      await page.type(passwordSelector, password, { delay: 25 });
      await new Promise(r => setTimeout(r, 500));
    }

    // Submit signup form
    const submitted = await page.evaluate(() => {
      // Try submit button
      const buttons = Array.from(document.querySelectorAll('button'));
      const submitBtn = buttons.find(b => {
        const text = b.textContent.trim().toLowerCase();
        return text.includes('sign up') || text.includes('create account') || text.includes('continue') || text.includes('get started') || b.type === 'submit';
      });
      if (submitBtn) { submitBtn.click(); return submitBtn.textContent.trim(); }
      // Try form submit
      const form = document.querySelector('form');
      if (form) { form.submit(); return 'form.submit()'; }
      return null;
    });

    this.emit('workflow_step', { workflow_id: workflowId, step: 3, action: 'create_account', status: 'submitted', details: { button: submitted, email } });

    // Wait for page to transition past signup form (poll up to 60s)
    // The signup API can take 10-30s depending on network/VPN latency
    let signupComplete = false;
    for (let waitStep = 0; waitStep < 30; waitStep++) {
      await new Promise(r => setTimeout(r, 2000));

      const pageCheck = await page.evaluate(() => {
        const text = document.body.innerText;
        const hasEmailInput = !!document.querySelector('input[type="email"]');
        const hasPasswordInput = !!document.querySelector('input[type="password"]');
        const hasSignupForm = hasEmailInput && hasPasswordInput && text.includes('Create Your Account');
        const hasPayment = text.includes('$0.00') || text.includes('Discount') || text.includes('100% off') || text.includes('Claim');
        const hasOnboarding = text.includes('How do you') || text.includes('What would you') || text.includes('want to listen');
        const hasError = text.includes('already exists') || text.includes('invalid email') || text.includes('Something went wrong');
        const hasDashboard = text.includes('Dashboard') || text.includes('Welcome');
        return { hasSignupForm, hasPayment, hasOnboarding, hasError, hasDashboard, url: window.location.href };
      });

      this.emit('workflow_step', { workflow_id: workflowId, step: 3, action: 'create_account', status: 'waiting', details: { wait_step: waitStep + 1, ...pageCheck } });

      if (pageCheck.hasError) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 3, action: 'create_account', status: 'error', details: pageCheck });
        throw new Error('Signup error detected — account may already exist');
      }

      // Success: page moved past signup form
      if (!pageCheck.hasSignupForm || pageCheck.hasPayment || pageCheck.hasOnboarding || pageCheck.hasDashboard) {
        signupComplete = true;
        this.emit('workflow_step', { workflow_id: workflowId, step: 3, action: 'create_account', status: 'success', details: pageCheck });
        break;
      }
    }

    if (!signupComplete) {
      // Take screenshot for debugging
      const screenshotPath = path.join(this.screenshotsDir, `signup_stuck_${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      throw new Error('Signup form still showing after 60s — account creation may have failed');
    }
  }

  async fillStripePaymentForm(page, browser, cardNumber, cardExpiry, cardCvc, workflowId) {
    // Fill Stripe Payment Element form via Chrome DevTools Protocol (CDP).
    // Stripe loads in a cross-origin iframe from js.stripe.com which cannot be
    // accessed via standard Puppeteer frame APIs. We connect directly to the
    // iframe's CDP target to manipulate its DOM.
    this.emit('workflow_step', { workflow_id: workflowId, step: 5, action: 'fill_payment', status: 'connecting_cdp' });

    // Get the CDP port from the browser's WebSocket URL
    const wsUrl = browser.wsEndpoint();
    const cdpPort = new URL(wsUrl).port;

    // Discover Stripe iframe targets via CDP /json endpoint
    const targets = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${cdpPort}/json`, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });

    // Find the Stripe iframe target with card input fields
    // Stripe uses various iframe URLs — match any stripe.com iframe, then verify
    // which one actually has card inputs via CDP check
    // Match any stripe.com iframe — check for card inputs via CDP later
    const stripeTargets = targets.filter(t =>
      t.type === 'iframe' && t.url && t.url.includes('stripe.com')
    );

    this.emit('workflow_step', { workflow_id: workflowId, step: 5, action: 'fill_payment', status: 'cdp_targets', details: { total: targets.length, stripe: stripeTargets.length, stripeUrls: stripeTargets.map(t => t.url.substring(0, 100)) } });

    let stripeWsUrl = null;
    for (const target of stripeTargets) {
      if (!target.webSocketDebuggerUrl) continue;
      stripeWsUrl = target.webSocketDebuggerUrl;

      // Connect and verify this frame has card inputs
      try {
        const hasInputs = await this.checkStripeFrameHasInputs(stripeWsUrl);
        if (hasInputs) break;
        stripeWsUrl = null;
      } catch {
        stripeWsUrl = null;
      }
    }

    if (!stripeWsUrl) {
      this.emit('workflow_step', { workflow_id: workflowId, step: 5, action: 'fill_payment', status: 'error', details: { message: 'Could not find Stripe iframe with card inputs' } });
      throw new Error('Stripe payment iframe not found — cannot fill card details');
    }

    this.emit('workflow_step', { workflow_id: workflowId, step: 5, action: 'fill_payment', status: 'filling_card' });

    // Connect to Stripe iframe and fill card details using DOM manipulation
    await this.fillStripeFieldsViaCDP(stripeWsUrl, cardNumber, cardExpiry, cardCvc);

    this.emit('workflow_step', { workflow_id: workflowId, step: 5, action: 'fill_payment', status: 'success', details: { card_last4: cardNumber.slice(-4) } });
  }

  async checkStripeFrameHasInputs(wsUrl) {
    // Quick check if a Stripe iframe target has card input fields
    const WebSocket = require('ws');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let msgId = 1;
      let timeout;

      ws.on('open', () => {
        // Enable Runtime and check for inputs
        ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.enable' }));
        ws.send(JSON.stringify({
          id: msgId++,
          method: 'Runtime.evaluate',
          params: {
            expression: `(() => {
              const inputs = document.querySelectorAll('input');
              return Array.from(inputs).some(i => i.autocomplete === 'cc-number' || i.name === 'number' || i.name === 'cardnumber');
            })()`,
            returnByValue: true,
          },
        }));
        timeout = setTimeout(() => { ws.close(); resolve(false); }, 5000);
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

  async fillStripeFieldsViaCDP(wsUrl, cardNumber, cardExpiry, cardCvc) {
    // Connect to Stripe iframe via WebSocket and fill card fields using
    // the native input value setter + dispatching input/change events.
    // This updates Stripe's internal state properly.
    const WebSocket = require('ws');

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let msgId = 1;
      let timeout;
      const pendingCallbacks = {};

      const sendCmd = (method, params) => {
        const id = msgId++;
        return new Promise((res, rej) => {
          pendingCallbacks[id] = res;
          ws.send(JSON.stringify({ id, method, params }));
          setTimeout(() => { delete pendingCallbacks[id]; rej(new Error('CDP command timeout')); }, 10000);
        });
      };

      ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.id && pendingCallbacks[msg.id]) {
          pendingCallbacks[msg.id](msg);
          delete pendingCallbacks[msg.id];
        }
      });

      ws.on('open', async () => {
        try {
          await sendCmd('Runtime.enable');
          await sendCmd('DOM.enable');

          // Format expiry as "MM / YY"
          const expMonth = cardExpiry.substring(0, 2);
          const expYear = cardExpiry.substring(2, 4);
          const formattedExpiry = `${expMonth} / ${expYear}`;

          // Fill all three fields using native setter + input events
          const fillResult = await sendCmd('Runtime.evaluate', {
            expression: `(() => {
              function fillField(selector, value) {
                const input = document.querySelector(selector);
                if (!input) return 'not_found: ' + selector;
                input.focus();
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSetter.call(input, value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('blur', { bubbles: true }));
                return 'filled: ' + input.value;
              }

              const results = {};
              results.card = fillField('input[name="number"], input[autocomplete="cc-number"]', '${cardNumber}');
              results.exp = fillField('input[name="expiry"], input[autocomplete="cc-exp"]', '${formattedExpiry}');
              results.cvc = fillField('input[name="cvc"], input[autocomplete="cc-csc"]', '${cardCvc}');
              return JSON.stringify(results);
            })()`,
            returnByValue: true,
          });

          // Also try execCommand('insertText') as an alternative approach
          // This generates "trusted" input events that Stripe's handlers recognize
          await sendCmd('Runtime.evaluate', {
            expression: `(() => {
              function fillWithExecCommand(selector, value) {
                const input = document.querySelector(selector);
                if (!input) return false;
                input.focus();
                input.select();
                document.execCommand('delete');
                document.execCommand('insertText', false, value);
                return true;
              }

              fillWithExecCommand('input[name="number"], input[autocomplete="cc-number"]', '${cardNumber}');
              fillWithExecCommand('input[name="expiry"], input[autocomplete="cc-exp"]', '${formattedExpiry}');
              fillWithExecCommand('input[name="cvc"], input[autocomplete="cc-csc"]', '${cardCvc}');
              return 'done';
            })()`,
            returnByValue: true,
          });

          ws.close();
          resolve();
        } catch (err) {
          ws.close();
          reject(err);
        }
      });

      ws.on('error', (err) => { reject(err); });
      timeout = setTimeout(() => { ws.close(); reject(new Error('Stripe CDP fill timeout')); }, 30000);
    });
  }

  async solveRecaptchaViaAudio(cdpPort, workflowId) {
    // Solve reCAPTCHA v2 via audio challenge:
    // 1. Find the reCAPTCHA bframe (challenge) and anchor (checkbox) CDP targets
    // 2. Click the checkbox to trigger the challenge
    // 3. Switch to audio mode
    // 4. Download the audio MP3
    // 5. Transcribe via Google Speech Recognition API
    // 6. Enter the transcription and verify
    const WebSocket = require('ws');

    const cdpEval = (wsUrl, expression) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let msgId = 1;
        const timeout = setTimeout(() => { ws.close(); reject(new Error('CDP eval timeout')); }, 15000);

        ws.on('open', () => {
          ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.enable' }));
          ws.send(JSON.stringify({ id: msgId++, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
        });

        ws.on('message', (data) => {
          const msg = JSON.parse(data);
          if (msg.id === 2 && msg.result) {
            clearTimeout(timeout);
            ws.close();
            resolve(msg.result.result ? msg.result.result.value : null);
          }
        });

        ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
      });
    };

    try {
      // Discover CDP targets
      const targets = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${cdpPort}/json`, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        }).on('error', reject);
      });

      // Find reCAPTCHA anchor (checkbox) and bframe (challenge) targets
      const anchorTargets = targets.filter(t => t.type === 'iframe' && t.url && t.url.includes('recaptcha') && t.url.includes('anchor') && t.webSocketDebuggerUrl);
      const bframeTargets = targets.filter(t => t.type === 'iframe' && t.url && t.url.includes('recaptcha') && t.url.includes('bframe') && t.webSocketDebuggerUrl);

      if (anchorTargets.length === 0) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 6, action: 'solve_recaptcha', status: 'error', details: { message: 'No reCAPTCHA anchor iframe found' } });
        return false;
      }

      // Click the reCAPTCHA checkbox in the anchor iframe
      for (const anchor of anchorTargets) {
        try {
          const result = await cdpEval(anchor.webSocketDebuggerUrl, `(() => {
            const cb = document.querySelector('.recaptcha-checkbox-border') || document.querySelector('#recaptcha-anchor');
            if (cb) { cb.click(); return 'clicked'; }
            return 'not_found';
          })()`);
          if (result === 'clicked') break;
        } catch { /* try next anchor */ }
      }

      await new Promise(r => setTimeout(r, 3000));

      // Re-fetch targets (bframe may have updated)
      const targets2 = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${cdpPort}/json`, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        }).on('error', reject);
      });

      const bframes = targets2.filter(t => t.type === 'iframe' && t.url && t.url.includes('recaptcha') && t.url.includes('bframe') && t.webSocketDebuggerUrl);
      if (bframes.length === 0) {
        // No bframe means the checkbox auto-solved (no challenge)
        return true;
      }

      const bframeWs = bframes[0].webSocketDebuggerUrl;

      // Switch to audio challenge
      const audioClicked = await cdpEval(bframeWs, `(() => {
        const btn = document.querySelector('#recaptcha-audio-button');
        if (btn) { btn.click(); return 'clicked'; }
        return 'not_found';
      })()`);

      if (audioClicked !== 'clicked') {
        this.emit('workflow_step', { workflow_id: workflowId, step: 6, action: 'solve_recaptcha', status: 'error', details: { message: 'Audio button not found' } });
        return false;
      }

      await new Promise(r => setTimeout(r, 2000));

      // Get the audio download URL
      const audioUrl = await cdpEval(bframeWs, `(() => {
        const link = document.querySelector('.rc-audiochallenge-tdownload-link');
        if (link) return link.href;
        const src = document.querySelector('#audio-source');
        if (src) return src.src;
        return null;
      })()`);

      if (!audioUrl) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 6, action: 'solve_recaptcha', status: 'error', details: { message: 'Audio URL not found' } });
        return false;
      }

      this.emit('workflow_step', { workflow_id: workflowId, step: 6, action: 'solve_recaptcha', status: 'transcribing' });

      // Download the audio MP3 and transcribe via Google Speech Recognition
      const transcription = await this.transcribeRecaptchaAudio(audioUrl);

      if (!transcription) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 6, action: 'solve_recaptcha', status: 'error', details: { message: 'Transcription failed' } });
        return false;
      }

      // Enter the transcription and click Verify
      await cdpEval(bframeWs, `(() => {
        const input = document.querySelector('#audio-response');
        if (!input) return 'input_not_found';
        input.focus();
        input.value = '';
        document.execCommand('insertText', false, ${JSON.stringify(transcription)});
        return 'filled';
      })()`);

      await new Promise(r => setTimeout(r, 500));

      await cdpEval(bframeWs, `(() => {
        const btn = document.querySelector('#recaptcha-verify-button');
        if (btn) { btn.click(); return 'clicked'; }
        return 'not_found';
      })()`);

      await new Promise(r => setTimeout(r, 3000));

      // Check if solved (look for green checkmark in anchor)
      for (const anchor of anchorTargets) {
        try {
          const checked = await cdpEval(anchor.webSocketDebuggerUrl, `(() => {
            const cb = document.querySelector('.recaptcha-checkbox-checked, .recaptcha-checkbox-checkmark');
            return cb ? 'solved' : 'not_solved';
          })()`);
          if (checked === 'solved') return true;
        } catch { /* continue */ }
      }

      // Also re-check bframe for error/new challenge
      try {
        const status = await cdpEval(bframeWs, `(() => {
          const err = document.querySelector('.rc-audiochallenge-error-message');
          if (err && err.offsetHeight > 0) return 'error: ' + err.textContent;
          return 'unknown';
        })()`);
        this.emit('workflow_step', { workflow_id: workflowId, step: 6, action: 'solve_recaptcha', status: 'retry_needed', details: { message: status } });
      } catch { /* bframe may have closed */ }

      return false;
    } catch (err) {
      this.emit('workflow_step', { workflow_id: workflowId, step: 6, action: 'solve_recaptcha', status: 'error', details: { message: err.message } });
      return false;
    }
  }

  async transcribeRecaptchaAudio(audioUrl) {
    // Download reCAPTCHA audio MP3 and convert to WAV, then send to
    // Google Web Speech API for transcription.
    // Uses native Node.js + sox/ffmpeg for conversion.
    const os = require('os');
    const tmpFile = path.join(os.tmpdir(), `recaptcha_audio_${Date.now()}`);
    const mp3Path = tmpFile + '.mp3';
    const wavPath = tmpFile + '.wav';

    try {
      // Download the MP3
      await new Promise((resolve, reject) => {
        const proto = audioUrl.startsWith('https') ? https : http;
        proto.get(audioUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            proto.get(res.headers.location, (res2) => {
              const fileStream = fs.createWriteStream(mp3Path);
              res2.pipe(fileStream);
              fileStream.on('finish', () => { fileStream.close(); resolve(); });
            }).on('error', reject);
          } else {
            const fileStream = fs.createWriteStream(mp3Path);
            res.pipe(fileStream);
            fileStream.on('finish', () => { fileStream.close(); resolve(); });
          }
        }).on('error', reject);
      });

      // Convert MP3 to WAV using ffmpeg (commonly available) or sox
      await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', ['-i', mp3Path, '-ar', '16000', '-ac', '1', '-y', wavPath]);
        ffmpeg.on('close', (code) => {
          if (code === 0) resolve();
          else {
            // Fallback to sox
            const sox = spawn('sox', [mp3Path, '-r', '16000', '-c', '1', wavPath]);
            sox.on('close', (c2) => c2 === 0 ? resolve() : reject(new Error('Audio conversion failed')));
            sox.on('error', () => reject(new Error('Neither ffmpeg nor sox available for audio conversion')));
          }
        });
        ffmpeg.on('error', () => {
          const sox = spawn('sox', [mp3Path, '-r', '16000', '-c', '1', wavPath]);
          sox.on('close', (c2) => c2 === 0 ? resolve() : reject(new Error('Audio conversion failed')));
          sox.on('error', () => reject(new Error('Neither ffmpeg nor sox available for audio conversion')));
        });
      });

      // Read WAV file and send to Google Speech Recognition API
      const audioData = fs.readFileSync(wavPath);
      const base64Audio = audioData.toString('base64');

      const transcription = await new Promise((resolve, reject) => {
        const postData = JSON.stringify({
          config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'en-US' },
          audio: { content: base64Audio },
        });

        const req = https.request({
          hostname: 'speech.googleapis.com',
          path: '/v1/speech:recognize?key=AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.results && result.results.length > 0) {
                resolve(result.results[0].alternatives[0].transcript);
              } else {
                // Fallback: try with free web API
                resolve(null);
              }
            } catch { resolve(null); }
          });
        });

        req.on('error', () => resolve(null));
        req.write(postData);
        req.end();
      });

      // Clean up temp files
      try { fs.unlinkSync(mp3Path); } catch {}
      try { fs.unlinkSync(wavPath); } catch {}

      return transcription;
    } catch (err) {
      try { fs.unlinkSync(mp3Path); } catch {}
      try { fs.unlinkSync(wavPath); } catch {}
      return null;
    }
  }

  async fetchSpeechifyVerificationLink(apiKey, domain, email) {
    // Fetch Speechify verification link from Mailgun
    try {
      const RELAY_URL = 'https://mailgun-relay-gvqahkir.fly.dev';
      const relayResponse = await this.httpGet(`${RELAY_URL}/verify-link/${encodeURIComponent(email)}`);

      if (relayResponse && relayResponse.found && relayResponse.link) {
        return relayResponse.link;
      }

      // Fallback: Mailgun stored messages API
      const url = `https://api.mailgun.net/v3/${domain}/events?event=stored&recipient=${encodeURIComponent(email)}&limit=5`;
      const response = await this.httpGet(url, { auth: `api:${apiKey}` });

      if (response && response.items) {
        for (const item of response.items) {
          if (item.storage && item.storage.url) {
            const message = await this.httpGet(item.storage.url, { auth: `api:${apiKey}` });
            if (message && message['body-html']) {
              // Look for Speechify verification links
              const linkMatch = message['body-html'].match(/https:\/\/[^\s"'<]*speechify[^\s"'<]*(verify|confirm|activate)[^\s"'<]*/i);
              if (linkMatch) return linkMatch[0].replace(/&amp;/g, '&');
            }
            if (message && message['body-plain']) {
              const linkMatch = message['body-plain'].match(/https:\/\/[^\s]*(speechify|verify|confirm)[^\s]*/i);
              if (linkMatch) return linkMatch[0];
            }
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  async fetchVerificationLink(apiKey, domain, email) {
    // Fetch verification link from the email relay service (primary)
    // Falls back to Mailgun stored messages API if relay is unavailable
    try {
      const RELAY_URL = 'https://mailgun-relay-gvqahkir.fly.dev';

      // Primary: query the email relay for the verification link
      this.emit('workflow_step', { workflow_id: 'mailgun', action: 'fetch_verification', status: 'querying_relay', details: { email } });

      const relayResponse = await this.httpGet(`${RELAY_URL}/verify-link/${encodeURIComponent(email)}`);

      if (relayResponse && relayResponse.found && relayResponse.link) {
        this.emit('workflow_step', { workflow_id: 'mailgun', action: 'fetch_verification', status: 'relay_found', details: { link: relayResponse.link.substring(0, 80) } });
        return relayResponse.link;
      }

      this.emit('workflow_step', { workflow_id: 'mailgun', action: 'fetch_verification', status: 'relay_not_found', details: { stored_count: relayResponse ? relayResponse.stored_count : 0 } });

      // Fallback: try Mailgun stored messages API directly
      const url = `https://api.mailgun.net/v3/${domain}/events?event=stored&recipient=${encodeURIComponent(email)}&limit=5`;
      const response = await this.httpGet(url, { auth: `api:${apiKey}` });

      if (response && response.Error === 'unauthorized') {
        this.emit('workflow_step', {
          workflow_id: 'mailgun', action: 'fetch_verification', status: 'unauthorized',
          details: { message: 'Mailgun API key does not have permission to read events. Please use the Private API key (not the domain sending key) from Mailgun Dashboard → API Keys.' },
        });
        return null;
      }

      // Collect storage URLs from events
      const storageUrls = [];
      if (response && response.items) {
        for (const item of response.items) {
          if (item.storage && item.storage.url) {
            storageUrls.push(item.storage.url);
          }
        }
      }

      // Try to fetch stored message content
      for (const storageUrl of storageUrls) {
        const message = await this.httpGet(storageUrl, { auth: `api:${apiKey}` });

        if (message && message.message && message.message.includes('retrieval disabled')) {
          this.emit('workflow_step', { workflow_id: 'mailgun', action: 'fetch_verification', status: 'retrieval_disabled', details: { message: 'Mailgun message retrieval disabled — relay service will be used on next poll.' } });
          return null;
        }

        if (message && message['body-html']) {
          const linkMatch = message['body-html'].match(/https:\/\/auth\.vapi\.ai\/auth\/v1\/verify\?[^"'\s<]+/);
          if (linkMatch) return linkMatch[0].replace(/&amp;/g, '&');
        }
        if (message && message['body-plain']) {
          const linkMatch = message['body-plain'].match(/https:\/\/auth\.vapi\.ai\/auth\/v1\/verify\?[^\s]+/);
          if (linkMatch) return linkMatch[0];
        }
      }

      return null;
    } catch (err) {
      this.emit('workflow_step', { workflow_id: 'mailgun', action: 'fetch_verification', status: 'error', details: { error: err.message } });
      return null;
    }
  }

  httpGet(url, options = {}) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const mod = parsedUrl.protocol === 'https:' ? https : http;

      const reqOptions = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {},
      };

      if (options.auth) {
        reqOptions.headers['Authorization'] = 'Basic ' + Buffer.from(options.auth).toString('base64');
      }

      const req = mod.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });
  }

  // ═══════════════════════════════════════════════════
  // Bulk Registration — Generate N accounts sequentially
  // ═══════════════════════════════════════════════════

  generateRandomEmail(domain) {
    const adjectives = ['swift', 'brave', 'calm', 'keen', 'bold', 'quick', 'wise', 'cool', 'fair', 'pure', 'true', 'warm', 'wild', 'free', 'deep'];
    const nouns = ['falcon', 'phoenix', 'river', 'storm', 'cloud', 'tiger', 'eagle', 'fox', 'wolf', 'bear', 'hawk', 'lion', 'star', 'moon', 'oak'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const num = Math.floor(Math.random() * 9000 + 1000);
    return `${adj}.${noun}${num}@${domain}`;
  }

  async ensureMailgunCatchAllRoute(apiKey, domain) {
    // Create a catch-all route in Mailgun to store all incoming emails
    // This enables verification email retrieval for any generated address
    try {
      // First check if a catch-all route already exists
      const existingRoutes = await this.httpGet(`https://api.mailgun.net/v3/routes`, { auth: `api:${apiKey}` });

      if (existingRoutes && existingRoutes.items) {
        const hasCatchAll = existingRoutes.items.some(r =>
          r.expression && r.expression.includes('catch_all()')
        );
        if (hasCatchAll) {
          this.emit('workflow_step', { action: 'mailgun_route', status: 'exists', details: { message: 'Catch-all route already exists' } });
          return true;
        }
      }

      // Create catch-all route with store() action
      const routeCreated = await this.httpPost(`https://api.mailgun.net/v3/routes`, {
        auth: `api:${apiKey}`,
        form: {
          priority: 10,
          description: 'FormFlow catch-all for email verification',
          expression: 'catch_all()',
          action: ['store(notify="http://localhost")', 'stop()'],
        },
      });

      if (routeCreated && routeCreated.route) {
        this.emit('workflow_step', { action: 'mailgun_route', status: 'created', details: { route_id: routeCreated.route.id } });
        return true;
      }

      return false;
    } catch (err) {
      this.emit('workflow_step', { action: 'mailgun_route', status: 'error', details: { error: err.message } });
      return false;
    }
  }

  async executeBulkRegistration(params) {
    const { workflow_config: config, max_retries = 2 } = params;
    const creds = config.credentials || {};
    const bulkCount = config.bulk_count || 1;
    const defaultPassword = creds.password;
    if (!defaultPassword) {
      throw new Error('Bulk registration requires a password in credentials');
    }
    const mailgunApiKey = creds.mailgun_api_key || creds.mailgunApiKey || '';
    const mailgunDomain = creds.mailgun_domain || creds.mailgunDomain || '';
    const promoCode = creds.promo_code || creds.promoCode || '';

    if (!mailgunDomain) {
      throw new Error('Bulk registration requires mailgun_domain to generate email addresses');
    }

    this.emit('workflow_started', {
      status: 'started',
      details: {
        mode: 'bulk_registration',
        count: bulkCount,
        domain: mailgunDomain,
      },
    });

    // Ensure catch-all route exists for email verification
    if (mailgunApiKey) {
      await this.ensureMailgunCatchAllRoute(mailgunApiKey, mailgunDomain);
    }

    // Generate unique emails
    const accounts = [];
    const usedEmails = new Set();
    for (let i = 0; i < bulkCount; i++) {
      let email;
      do {
        email = this.generateRandomEmail(mailgunDomain);
      } while (usedEmails.has(email));
      usedEmails.add(email);
      accounts.push({ email, password: defaultPassword, index: i + 1 });
    }

    this.emit('workflow_step', {
      action: 'bulk_emails_generated',
      status: 'success',
      details: { count: accounts.length, sample: accounts.slice(0, 3).map(a => a.email) },
    });

    // Execute registrations sequentially
    const results = [];
    let completed = 0;
    let failed = 0;

    for (const account of accounts) {
      if (this.stopped) break;

      this.emit('workflow_step', {
        action: 'bulk_account_start',
        status: 'starting',
        details: { index: account.index, total: bulkCount, email: account.email },
      });

      // Create a config copy with this account's credentials
      const accountConfig = {
        ...config,
        credentials: {
          ...creds,
          email: account.email,
          password: account.password,
        },
        bulk_mode: false, // Prevent recursion
      };

      // Run single workflow for this account
      const job = {
        profileId: `profile_bulk_${String(account.index).padStart(3, '0')}`,
        profileIndex: account.index - 1,
        config: accountConfig,
        maxRetries: max_retries,
      };

      try {
        const result = await this.runSingleWorkflow(job);
        results.push({ ...result, email: account.email });

        if (result.success) {
          completed++;
          this.emit('workflow_step', {
            action: 'bulk_account_done',
            status: 'success',
            details: { index: account.index, email: account.email },
          });
        } else {
          failed++;
          this.emit('workflow_step', {
            action: 'bulk_account_done',
            status: 'failed',
            details: { index: account.index, email: account.email, error: result.error },
          });
        }
      } catch (err) {
        failed++;
        results.push({ success: false, email: account.email, error: err.message });
        this.emit('workflow_step', {
          action: 'bulk_account_done',
          status: 'error',
          details: { index: account.index, email: account.email, error: err.message },
        });
      }

      this.onProgress({
        total_jobs: bulkCount,
        completed,
        failed,
        queued: bulkCount - completed - failed,
      });

      // Rotate VPN between accounts for different IP per registration
      if (account.index < bulkCount && !this.stopped) {
        if (this.onVpnRotate && config.vpn_auto_rotate !== false) {
          this.emit('workflow_step', {
            action: 'vpn_rotating',
            status: 'starting',
            details: { before_account: account.index + 1 },
          });

          const vpnClient = creds.vpn_client || 'ExpressVPN';
          const rotateResult = await this.onVpnRotate(vpnClient);

          if (rotateResult && rotateResult.success) {
            this.emit('workflow_step', {
              action: 'vpn_rotating',
              status: 'success',
              details: { new_location: rotateResult.location, new_ip: rotateResult.ip },
            });
          } else {
            this.emit('workflow_step', {
              action: 'vpn_rotating',
              status: 'failed',
              details: { error: rotateResult ? rotateResult.error : 'VPN rotate returned no result' },
            });
          }

          // Wait for VPN to stabilize after rotation
          await new Promise(r => setTimeout(r, 5000));
        } else {
          // Brief pause between accounts even without VPN rotation
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    // Save generated accounts to a file
    const accountsLog = {
      generated_at: new Date().toISOString(),
      total: bulkCount,
      completed,
      failed,
      accounts: results.map(r => ({
        email: r.email,
        password: defaultPassword,
        success: r.success,
        error: r.error || null,
      })),
    };

    const accountsPath = path.join(this.logsDir, `bulk_accounts_${Date.now()}.json`);
    fs.writeFileSync(accountsPath, JSON.stringify(accountsLog, null, 2));

    this.emit('workflow_finished', {
      status: 'finished',
      details: {
        mode: 'bulk_registration',
        total: bulkCount,
        completed,
        failed,
        accounts_file: accountsPath,
      },
    });

    this.saveEventsLog();
    return results;
  }

  httpPost(url, options = {}) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const mod = parsedUrl.protocol === 'https:' ? https : http;

      // Build form data
      let body = '';
      if (options.form) {
        const parts = [];
        for (const [key, val] of Object.entries(options.form)) {
          if (Array.isArray(val)) {
            val.forEach(v => parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`));
          } else {
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
          }
        }
        body = parts.join('&');
      }

      const reqOptions = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      if (options.auth) {
        reqOptions.headers['Authorization'] = 'Basic ' + Buffer.from(options.auth).toString('base64');
      }

      const req = mod.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(body);
      req.end();
    });
  }

  httpPostJson(url, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const mod = parsedUrl.protocol === 'https:' ? https : http;
      const jsonBody = JSON.stringify(body);

      const reqOptions = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(jsonBody),
          ...extraHeaders,
        },
      };

      const req = mod.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ raw: data, statusCode: res.statusCode }); }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(jsonBody);
      req.end();
    });
  }

  httpGetJson(url, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const mod = parsedUrl.protocol === 'https:' ? https : http;

      const reqOptions = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: { ...extraHeaders },
      };

      const req = mod.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ raw: data, statusCode: res.statusCode }); }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });
  }

  stop() {
    this.stopped = true;
  }
}

module.exports = { WorkflowRunner };
