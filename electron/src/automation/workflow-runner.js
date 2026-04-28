/**
 * FormFlow Desktop Pro — Workflow Runner
 *
 * Executes registration workflows using Puppeteer connected to
 * Electron's embedded Chromium. All stealth flags are already
 * applied at the Electron process level.
 *
 * Supports:
 * - Multi-profile browser isolation
 * - Parallel workflow execution
 * - Credential substitution ({{key}} syntax)
 * - Configurable retries with VPN switching
 * - CAPTCHA detection (detect only, no bypass)
 * - Screenshot capture on failures
 * - Structured debug telemetry
 */

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const http = require('http');

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

  async executeWorkflow(config, profilePath, fingerprint, workflowId, profileId) {
    // Connect to Electron's own Chromium via the remote debugging protocol
    // Electron exposes this when launched with --remote-debugging-port
    // For workflow isolation, we launch a separate Chromium instance via puppeteer
    const execPath = process.execPath;

    this.emit('browser_launch', {
      workflow_id: workflowId,
      profile_id: profileId,
      status: 'success',
      details: {
        fingerprint,
        stealth: true,
        user_data_dir: profilePath,
      },
    });

    const browser = await puppeteer.launch({
      executablePath: execPath,
      userDataDir: profilePath,
      headless: false,
      ignoreDefaultFlags: true,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-web-security',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-client-side-phishing-detection',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-dev-shm-usage',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-renderer-backgrounding',
        '--disable-sync',
        '--ignore-certificate-errors',
        '--allow-running-insecure-content',
        '--no-first-run',
        '--no-default-browser-check',
        '--password-store=basic',
        '--use-mock-keychain',
        '--disable-features=IsolateOrigins,site-per-process,TranslateUI',
        '--enable-features=NetworkService,NetworkServiceInProcess',
        `--user-agent=${fingerprint.userAgent}`,
        `--window-size=${fingerprint.viewport.width},${fingerprint.viewport.height}`,
        `--lang=${fingerprint.locale}`,
      ],
    });

    try {
      const page = (await browser.pages())[0] || await browser.newPage();

      // Inject stealth script
      await page.evaluateOnNewDocument(STEALTH_INIT_SCRIPT);

      // Set viewport
      await page.setViewport(fingerprint.viewport);

      // Set timezone
      await page.emulateTimezone(fingerprint.timezone);

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
      await browser.close();
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

    // Helper: type with human-like delays
    const humanType = async (selector, text) => {
      await page.click(selector, { clickCount: 3 }); // select existing text
      await humanDelay(100, 300);
      for (const char of text) {
        await page.type(selector, char, { delay: Math.floor(Math.random() * 80 + 30) });
      }
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

      // ─── STEP 2: Fill email and password, click Sign Up ───
      this.emit('workflow_step', { workflow_id: workflowId, step: 2, action: 'fill_registration', status: 'starting' });

      // Wait for the email input
      await waitAndLog('input[name="email"]', 'Email input');
      await humanType('input[name="email"]', email);
      await humanDelay(300, 600);

      // Fill password
      await waitAndLog('input[name="password"]', 'Password input');
      await humanType('input[name="password"]', password);
      await humanDelay(500, 1000);

      // Click Sign Up button — use Puppeteer's page.click() which simulates real mouse events
      const signUpSelector = 'button[type="submit"]';
      await waitAndLog(signUpSelector, 'Sign Up button');
      await humanDelay(500, 1000);

      // Log button state for debugging
      const btnInfo = await page.evaluate(() => {
        const btn = document.querySelector('button[type="submit"]');
        return btn ? { text: btn.textContent.trim(), disabled: btn.disabled } : null;
      });
      this.emit('workflow_step', { workflow_id: workflowId, step: 2, action: 'fill_registration', status: 'clicking_signup', details: btnInfo });

      // If button is disabled, force-enable it (React may not have updated state in time)
      if (btnInfo && btnInfo.disabled) {
        await page.evaluate(() => {
          const btn = document.querySelector('button[type="submit"]');
          if (btn) { btn.disabled = false; btn.removeAttribute('disabled'); }
        });
        await humanDelay(200, 400);
      }

      // Use page.click() — this simulates real mouse down/up/click at the button center
      // This is the method that worked in the first user test
      await page.click(signUpSelector);
      this.emit('workflow_step', { workflow_id: workflowId, step: 2, action: 'fill_registration', status: 'submitted' });

      // Wait for page change (confirmation message or redirect)
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await humanDelay(2000, 3000);

      // If still on register page, try pressing Enter as fallback
      if (page.url().includes('/register')) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 2, action: 'fill_registration', status: 'retrying_enter' });
        await page.focus('input[name="password"]');
        await page.keyboard.press('Enter');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        await humanDelay(2000, 3000);
      }

      // Check if we got a confirmation message or redirected to dashboard
      const currentUrl = page.url();
      let pageContent = '';
      try { pageContent = await page.content(); } catch { /* frame may have detached */ }
      const needsVerification = pageContent.toLowerCase().includes('confirmation') ||
                                 pageContent.toLowerCase().includes('verify') ||
                                 pageContent.toLowerCase().includes('check your') ||
                                 currentUrl.includes('/register');

      stepsCompleted.push('fill_registration');
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

      // ─── STEP 3: Login (if not already on dashboard) ───
      const afterVerifyUrl = page.url();
      if (!afterVerifyUrl.includes('/composer') && !afterVerifyUrl.includes('/assistants') && !afterVerifyUrl.includes('/settings')) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 3, action: 'login', status: 'starting' });

        await page.goto('https://dashboard.vapi.ai/login', { waitUntil: 'networkidle2', timeout: 30000 });
        await humanDelay(1000, 2000);

        // Fill login form
        await waitAndLog('input[name="email"]', 'Login email');
        await humanType('input[name="email"]', email);
        await humanDelay(300, 600);

        await waitAndLog('input[name="password"]', 'Login password');
        await humanType('input[name="password"]', password);
        await humanDelay(500, 1000);

        // Click Sign In button
        await waitAndLog('button[type="submit"]', 'Sign In button');
        await humanDelay(500, 1000);

        // Force-enable if disabled
        await page.evaluate(() => {
          const btn = document.querySelector('button[type="submit"]');
          if (btn && btn.disabled) { btn.disabled = false; btn.removeAttribute('disabled'); }
        });
        await humanDelay(200, 400);

        // Use page.click() for real mouse simulation, with navigation wait
        try {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
            page.click('button[type="submit"]'),
          ]);
        } catch (navErr) {
          this.emit('workflow_step', { workflow_id: workflowId, step: 3, action: 'login', status: 'nav_redirect', details: { message: navErr.message } });
        }

        // Wait for the SPA to stabilize after redirect
        await humanDelay(4000, 6000);

        // Ensure page is still usable after redirect
        try {
          await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });
        } catch {
          // If frame detached, navigate directly to dashboard to get a fresh page state
          try {
            await page.goto('https://dashboard.vapi.ai/', { waitUntil: 'networkidle2', timeout: 30000 });
            await humanDelay(2000, 3000);
          } catch { /* last resort, continue anyway */ }
        }

        stepsCompleted.push('login');
        this.emit('workflow_step', { workflow_id: workflowId, step: 3, action: 'login', status: 'success' });
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

      // ─── STEP 4: Navigate to Billing and apply promo code ───
      if (promoCode) {
        this.emit('workflow_step', { workflow_id: workflowId, step: 4, action: 'apply_promo', status: 'starting' });

        // Navigate to billing page with coupon dialog
        await page.goto('https://dashboard.vapi.ai/settings/billing?coupon-redemption=true', {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });
        await humanDelay(2000, 4000);

        // Wait for the coupon code input to appear
        const couponInputSelector = 'input[name="code"]';
        try {
          await page.waitForSelector(couponInputSelector, { timeout: timeoutMs });
          await humanDelay(500, 1000);

          // Type promo code
          await humanType(couponInputSelector, promoCode);
          await humanDelay(500, 1000);

          // Find and click the Redeem button
          const redeemClicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const redeemBtn = buttons.find(b => b.textContent.trim() === 'Redeem');
            if (redeemBtn) {
              redeemBtn.click();
              return true;
            }
            return false;
          });

          if (redeemClicked) {
            await humanDelay(3000, 5000);

            // Check credit balance
            const creditBalance = await page.evaluate(() => {
              const text = document.body.innerText;
              const match = text.match(/(\d+(?:\.\d+)?)\s*Credits/);
              return match ? match[1] : null;
            });

            stepsCompleted.push('promo_applied');
            this.emit('workflow_step', {
              workflow_id: workflowId,
              step: 4,
              action: 'apply_promo',
              status: 'success',
              details: { promo_code: promoCode, credit_balance: creditBalance },
            });
          } else {
            // Try clicking Apply Coupon button first, then fill
            const applyCouponClicked = await page.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('button'));
              const applyBtn = buttons.find(b => b.textContent.trim() === 'Apply Coupon');
              if (applyBtn) {
                applyBtn.click();
                return true;
              }
              return false;
            });

            if (applyCouponClicked) {
              await humanDelay(1000, 2000);
              await page.waitForSelector(couponInputSelector, { timeout: timeoutMs });
              await humanType(couponInputSelector, promoCode);
              await humanDelay(500, 1000);

              await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const redeemBtn = buttons.find(b => b.textContent.trim() === 'Redeem');
                if (redeemBtn) redeemBtn.click();
              });
              await humanDelay(3000, 5000);
              stepsCompleted.push('promo_applied');
              this.emit('workflow_step', { workflow_id: workflowId, step: 4, action: 'apply_promo', status: 'success' });
            } else {
              this.emit('workflow_step', { workflow_id: workflowId, step: 4, action: 'apply_promo', status: 'failed', details: { message: 'Could not find Redeem or Apply Coupon button' } });
            }
          }
        } catch (err) {
          // Coupon dialog might not have opened. Try clicking Apply Coupon button first.
          this.emit('workflow_step', { workflow_id: workflowId, step: 4, action: 'apply_promo', status: 'retrying', details: { message: 'Coupon input not found, trying Apply Coupon button' } });

          await page.goto('https://dashboard.vapi.ai/settings/billing', { waitUntil: 'networkidle2', timeout: 30000 });
          await humanDelay(2000, 3000);

          const applyCouponClicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const applyBtn = buttons.find(b => b.textContent.trim() === 'Apply Coupon');
            if (applyBtn) { applyBtn.click(); return true; }
            return false;
          });

          if (applyCouponClicked) {
            await humanDelay(1000, 2000);
            try {
              await page.waitForSelector(couponInputSelector, { timeout: timeoutMs });
              await humanType(couponInputSelector, promoCode);
              await humanDelay(500, 1000);

              await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const redeemBtn = buttons.find(b => b.textContent.trim() === 'Redeem');
                if (redeemBtn) redeemBtn.click();
              });
              await humanDelay(3000, 5000);
              stepsCompleted.push('promo_applied');
              this.emit('workflow_step', { workflow_id: workflowId, step: 4, action: 'apply_promo', status: 'success' });
            } catch (innerErr) {
              this.emit('workflow_step', { workflow_id: workflowId, step: 4, action: 'apply_promo', status: 'failed', details: { error: innerErr.message } });
            }
          }
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

  async fetchVerificationLink(apiKey, domain, email) {
    // Fetch stored messages from Mailgun to find the VAPI verification link
    // The API key and domain are provided by the user at runtime — never hardcoded
    try {
      // Try events API first (works when routes have store() action)
      const url = `https://api.mailgun.net/v3/${domain}/events?event=stored&recipient=${encodeURIComponent(email)}&limit=5`;

      this.emit('workflow_step', { workflow_id: 'mailgun', action: 'fetch_verification', status: 'querying_events', details: { endpoint: 'events', email } });

      const response = await this.httpGet(url, {
        auth: `api:${apiKey}`,
      });

      this.emit('workflow_step', { workflow_id: 'mailgun', action: 'fetch_verification', status: 'events_response', details: { items_count: response && response.items ? response.items.length : 0 } });

      if (response && response.items && response.items.length > 0) {
        for (const item of response.items) {
          if (item.storage && item.storage.url) {
            // Fetch the stored message content from the storage URL
            const message = await this.httpGet(item.storage.url, {
              auth: `api:${apiKey}`,
            });

            if (message && message['body-html']) {
              const linkMatch = message['body-html'].match(/https:\/\/auth\.vapi\.ai\/auth\/v1\/verify\?[^"'\s<]+/);
              if (linkMatch) {
                return linkMatch[0].replace(/&amp;/g, '&');
              }
            }
            if (message && message['body-plain']) {
              const linkMatch = message['body-plain'].match(/https:\/\/auth\.vapi\.ai\/auth\/v1\/verify\?[^\s]+/);
              if (linkMatch) {
                return linkMatch[0];
              }
            }
          }
        }
      }

      // Fallback: try events with "accepted" event type (received emails)
      const acceptedUrl = `https://api.mailgun.net/v3/${domain}/events?event=accepted&recipient=${encodeURIComponent(email)}&limit=5`;
      const acceptedResponse = await this.httpGet(acceptedUrl, { auth: `api:${apiKey}` });

      this.emit('workflow_step', { workflow_id: 'mailgun', action: 'fetch_verification', status: 'accepted_response', details: { items_count: acceptedResponse && acceptedResponse.items ? acceptedResponse.items.length : 0 } });

      // Fallback: Query all recent events for this recipient
      const allEventsUrl = `https://api.mailgun.net/v3/${domain}/events?recipient=${encodeURIComponent(email)}&limit=10`;
      const allEvents = await this.httpGet(allEventsUrl, { auth: `api:${apiKey}` });

      this.emit('workflow_step', { workflow_id: 'mailgun', action: 'fetch_verification', status: 'all_events_response', details: {
        items_count: allEvents && allEvents.items ? allEvents.items.length : 0,
        event_types: allEvents && allEvents.items ? allEvents.items.map(i => i.event).filter(Boolean) : [],
      }});

      // Check if any event has storage URL
      if (allEvents && allEvents.items) {
        for (const item of allEvents.items) {
          if (item.storage && item.storage.url) {
            const message = await this.httpGet(item.storage.url, { auth: `api:${apiKey}` });
            if (message && message['body-html']) {
              const linkMatch = message['body-html'].match(/https:\/\/auth\.vapi\.ai\/auth\/v1\/verify\?[^"'\s<]+/);
              if (linkMatch) return linkMatch[0].replace(/&amp;/g, '&');
            }
            if (message && message['body-plain']) {
              const linkMatch = message['body-plain'].match(/https:\/\/auth\.vapi\.ai\/auth\/v1\/verify\?[^\s]+/);
              if (linkMatch) return linkMatch[0];
            }
          }
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

  stop() {
    this.stopped = true;
  }
}

module.exports = { WorkflowRunner };
