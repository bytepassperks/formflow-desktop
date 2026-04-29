/**
 * FormFlow Desktop Pro — Electron Main Process
 *
 * Launches Chromium with ALL critical security/detection flags disabled:
 * - No automation banners
 * - No WebDriver detection
 * - No sandbox restrictions
 * - Disabled security features for testing
 *
 * Electron bundles Chromium automatically — no separate browser download needed.
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Global error handlers — show dialog instead of silently crashing
process.on('uncaughtException', (err) => {
  const msg = `Uncaught Exception:\n${err.stack || err.message}`;
  fs.appendFileSync(path.join(app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname, 'crash.log'), `${new Date().toISOString()} ${msg}\n`);
  if (app.isReady()) {
    dialog.showErrorBox('FormFlow Desktop Pro — Error', msg);
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = `Unhandled Rejection:\n${reason && reason.stack ? reason.stack : String(reason)}`;
  fs.appendFileSync(path.join(app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname, 'crash.log'), `${new Date().toISOString()} ${msg}\n`);
});

// ═══════════════════════════════════════════════════
// STEALTH CHROMIUM FLAGS — Applied at process level
// These disable ALL automation detection mechanisms
// ═══════════════════════════════════════════════════
const STEALTH_FLAGS = [
  // Core automation detection bypass
  ['disable-blink-features', 'AutomationControlled'],

  // Disable info bars and prompts
  ['disable-infobars', ''],
  ['disable-notifications', ''],
  ['disable-popup-blocking', ''],
  ['disable-prompt-on-repost', ''],

  // Disable security features (for testing)
  ['no-sandbox', ''],
  ['disable-web-security', ''],
  ['disable-site-isolation-trials', ''],
  ['disable-features', 'IsolateOrigins,site-per-process,TranslateUI'],
  ['allow-running-insecure-content', ''],
  ['ignore-certificate-errors', ''],

  // Disable background services
  ['disable-background-networking', ''],
  ['disable-background-timer-throttling', ''],
  ['disable-backgrounding-occluded-windows', ''],
  ['disable-renderer-backgrounding', ''],
  ['disable-component-update', ''],
  ['disable-sync', ''],
  ['disable-breakpad', ''],

  // Disable detection vectors
  ['disable-client-side-phishing-detection', ''],
  ['disable-default-apps', ''],
  ['disable-dev-shm-usage', ''],
  ['disable-hang-monitor', ''],
  ['disable-ipc-flooding-protection', ''],

  // First run and defaults
  ['no-first-run', ''],
  ['no-default-browser-check', ''],

  // Credential storage
  ['password-store', 'basic'],
  ['use-mock-keychain', ''],

  // Network
  ['enable-features', 'NetworkService,NetworkServiceInProcess'],
];

// Apply ALL stealth flags before app is ready
for (const [flag, value] of STEALTH_FLAGS) {
  if (value) {
    app.commandLine.appendSwitch(flag, value);
  } else {
    app.commandLine.appendSwitch(flag);
  }
}

// Paths
const APP_ROOT = app.isPackaged
  ? path.dirname(app.getPath('exe'))
  : path.join(__dirname, '..', '..');

// When packaged, extraResources go to process.resourcesPath
const RESOURCES_ROOT = app.isPackaged ? process.resourcesPath : APP_ROOT;

const PROFILES_DIR = path.join(RESOURCES_ROOT, 'profiles');
const LOGS_DIR = path.join(APP_ROOT, 'logs');
const SCREENSHOTS_DIR = path.join(LOGS_DIR, 'screenshots');
const CONFIG_DIR = path.join(RESOURCES_ROOT, 'config');

// Ensure directories exist
for (const dir of [PROFILES_DIR, LOGS_DIR, SCREENSHOTS_DIR, CONFIG_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

let mainWindow = null;
let vpnState = {
  detectedClients: [],  // Scan results with name, path, cli, locations
  controller: null,     // Active VPNController instance
  activeClient: null,   // Name of active client
};

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'FormFlow Desktop Pro',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Log startup info for debugging
  const startupLog = [
    `App ready at ${new Date().toISOString()}`,
    `isPackaged: ${app.isPackaged}`,
    `APP_ROOT: ${APP_ROOT}`,
    `RESOURCES_ROOT: ${RESOURCES_ROOT}`,
    `exe path: ${app.getPath('exe')}`,
    `PROFILES_DIR: ${PROFILES_DIR} (exists: ${fs.existsSync(PROFILES_DIR)})`,
    `CONFIG_DIR: ${CONFIG_DIR} (exists: ${fs.existsSync(CONFIG_DIR)})`,
  ].join('\n');
  fs.appendFileSync(path.join(APP_ROOT, 'startup.log'), startupLog + '\n');

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

// ═══════════════════════════════════════════════════
// IPC Handlers — Communication with renderer process
// ═══════════════════════════════════════════════════

// Get app info
ipcMain.handle('app:getInfo', () => {
  return {
    version: app.getVersion(),
    chromiumVersion: process.versions.chrome,
    electronVersion: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    appRoot: APP_ROOT,
    profilesDir: PROFILES_DIR,
    logsDir: LOGS_DIR,
    stealthFlagsCount: STEALTH_FLAGS.length,
    stealthFlags: STEALTH_FLAGS.map(([k, v]) => v ? `--${k}=${v}` : `--${k}`),
  };
});

// Get Chromium executable path (Electron's bundled Chromium)
ipcMain.handle('app:getChromiumPath', () => {
  // In Electron, the browser is the app itself
  return app.getPath('exe');
});

// Active workflow runner reference (for stop support)
let activeRunner = null;

// Run workflow
ipcMain.handle('workflow:run', async (event, params) => {
  const { WorkflowRunner } = require('../automation/workflow-runner');
  const runner = new WorkflowRunner({
    profilesDir: PROFILES_DIR,
    logsDir: LOGS_DIR,
    screenshotsDir: SCREENSHOTS_DIR,
    onEvent: (evt) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('workflow:event', evt);
      }
    },
    onProgress: (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('workflow:progress', progress);
      }
    },
    // VPN rotation callback for bulk registration
    onVpnRotate: async (clientName) => {
      try {
        // Find client from scan results
        const clientInfo = vpnState.detectedClients.find(c => c.name === clientName);

        if (!vpnState.controller || vpnState.activeClient !== clientName) {
          if (clientInfo) {
            vpnState.controller = createVPNController(clientInfo);
          } else {
            const { VPNController } = require('../vpn/vpn-controller');
            vpnState.controller = new VPNController(clientName);
          }
          vpnState.activeClient = clientName;
        }

        const result = await vpnState.controller.switchNextLocation();

        // Send VPN event to renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('workflow:event', {
            timestamp: new Date().toISOString(),
            event: 'vpn_rotated',
            status: result.success ? 'success' : 'failed',
            details: result,
          });

          if (result.success && result.ip) {
            mainWindow.webContents.send('workflow:event', {
              timestamp: new Date().toISOString(),
              event: 'ip_check_success',
              ip: result.ip,
            });
          }
        }

        return result;
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  });

  activeRunner = runner;

  try {
    const results = await runner.execute(params);
    return { success: true, results };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    activeRunner = null;
  }
});

// Stop workflow
ipcMain.handle('workflow:stop', async () => {
  if (activeRunner) {
    activeRunner.stop();
  }
  return { stopped: true };
});

// Helper: create VPN controller from detected client info
function createVPNController(clientInfo) {
  const { VPNController } = require('../vpn/vpn-controller');
  const controller = new VPNController(clientInfo.name, clientInfo.path, clientInfo.installDir);
  controller.setLocations(clientInfo.locations);
  return controller;
}

// VPN operations
ipcMain.handle('vpn:scan', async () => {
  const { VPNDetector } = require('../vpn/vpn-detector');
  const detector = new VPNDetector();
  vpnState.detectedClients = detector.scanAll();

  // Auto-initialize controller with first CLI-capable client
  const cliClients = vpnState.detectedClients.filter(c => c.hasCli !== false && !c.guiOnly);
  if (cliClients.length > 0 && !vpnState.controller) {
    const firstClient = cliClients[0];
    vpnState.controller = createVPNController(firstClient);
    vpnState.activeClient = firstClient.name;
  }

  return vpnState.detectedClients;
});

ipcMain.handle('vpn:connect', async (event, { client, location }) => {
  // Find client info from scan results
  const clientInfo = vpnState.detectedClients.find(c => c.name === client);

  // Create or switch controller for this client (passes detected path)
  if (!vpnState.controller || vpnState.activeClient !== client) {
    if (clientInfo) {
      vpnState.controller = createVPNController(clientInfo);
    } else {
      const { VPNController } = require('../vpn/vpn-controller');
      vpnState.controller = new VPNController(client);
    }
    vpnState.activeClient = client;
  }

  // If no specific location given, use the first from the queue
  const targetLocation = location || (clientInfo ? clientInfo.locations[0] : null);
  return vpnState.controller.connect(targetLocation);
});

ipcMain.handle('vpn:disconnect', async () => {
  if (vpnState.controller) {
    return vpnState.controller.disconnect();
  }
  return { success: true };
});

ipcMain.handle('vpn:rotate', async (event, { client }) => {
  const clientInfo = vpnState.detectedClients.find(c => c.name === client);

  if (!vpnState.controller || vpnState.activeClient !== client) {
    if (clientInfo) {
      vpnState.controller = createVPNController(clientInfo);
    } else {
      const { VPNController } = require('../vpn/vpn-controller');
      vpnState.controller = new VPNController(client);
    }
    vpnState.activeClient = client;
  }

  return vpnState.controller.switchNextLocation();
});

// Get VPN locations for a client (with labels)
ipcMain.handle('vpn:getLocations', async (event, { client }) => {
  const clientInfo = vpnState.detectedClients.find(c => c.name === client);
  if (!clientInfo) return [];
  return {
    locations: clientInfo.locations,
    labels: clientInfo.locationLabels || null,
  };
});

// Debug operations
ipcMain.handle('debug:exportLogs', async () => {
  const { DebugLogger } = require('../debug/debug-logger');
  const logger = new DebugLogger(LOGS_DIR);
  return logger.exportEvents();
});

ipcMain.handle('debug:openScreenshots', () => {
  shell.openPath(SCREENSHOTS_DIR);
});

ipcMain.handle('debug:generateBundle', async () => {
  const { BundleExporter } = require('../debug/bundle-exporter');
  const exporter = new BundleExporter(APP_ROOT);
  return exporter.export();
});

// File dialogs
ipcMain.handle('dialog:save', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result;
});

ipcMain.handle('dialog:open', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options);
  return result;
});

// Open external URL
ipcMain.handle('shell:openExternal', async (event, url) => {
  await shell.openExternal(url);
});
