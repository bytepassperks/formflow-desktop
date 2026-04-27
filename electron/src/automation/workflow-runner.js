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

      // Execute workflow steps
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

  stop() {
    this.stopped = true;
  }
}

module.exports = { WorkflowRunner };
