/**
 * FormFlow Desktop Pro — Preload Script
 *
 * Bridges the Electron main process and renderer process.
 * Exposes a safe API via contextBridge while maintaining
 * context isolation for security.
 *
 * Also injects stealth patches to remove WebDriver detection
 * from navigator and chrome objects.
 */

const { contextBridge, ipcRenderer } = require('electron');

// ═══════════════════════════════════════════════════
// Expose safe API to renderer process
// ═══════════════════════════════════════════════════
contextBridge.exposeInMainWorld('formflow', {
  // App info
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  getChromiumPath: () => ipcRenderer.invoke('app:getChromiumPath'),

  // Workflow operations
  runWorkflow: (params) => ipcRenderer.invoke('workflow:run', params),
  stopWorkflow: () => ipcRenderer.invoke('workflow:stop'),

  // VPN operations
  scanVPN: () => ipcRenderer.invoke('vpn:scan'),
  connectVPN: (client, location) => ipcRenderer.invoke('vpn:connect', { client, location }),
  disconnectVPN: () => ipcRenderer.invoke('vpn:disconnect'),
  rotateVPN: (client) => ipcRenderer.invoke('vpn:rotate', { client }),

  // Debug operations
  exportLogs: () => ipcRenderer.invoke('debug:exportLogs'),
  openScreenshots: () => ipcRenderer.invoke('debug:openScreenshots'),
  generateBundle: () => ipcRenderer.invoke('debug:generateBundle'),

  // Dialog operations
  saveDialog: (options) => ipcRenderer.invoke('dialog:save', options),
  openDialog: (options) => ipcRenderer.invoke('dialog:open', options),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Event listeners
  onWorkflowEvent: (callback) => {
    ipcRenderer.on('workflow:event', (event, data) => callback(data));
  },
  onWorkflowProgress: (callback) => {
    ipcRenderer.on('workflow:progress', (event, data) => callback(data));
  },

  // Remove event listeners
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});

// ═══════════════════════════════════════════════════
// Stealth patches — Remove WebDriver detection
// These run in the preload context BEFORE any page JS
// ═══════════════════════════════════════════════════
const STEALTH_SCRIPT = `
  // Remove navigator.webdriver
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
  });

  // Spoof navigator.plugins (empty in automation = detection signal)
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ];
      plugins.length = 3;
      return plugins;
    },
    configurable: true,
  });

  // Spoof navigator.languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
    configurable: true,
  });

  // Patch chrome.runtime to prevent detection
  if (!window.chrome) window.chrome = {};
  window.chrome.runtime = window.chrome.runtime || {};
  window.chrome.loadTimes = window.chrome.loadTimes || function() { return {}; };
  window.chrome.csi = window.chrome.csi || function() { return {}; };
  window.chrome.app = window.chrome.app || { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };

  // Fix permissions query
  const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
  window.navigator.permissions.query = (params) => {
    if (params.name === 'notifications') {
      return Promise.resolve({ state: Notification.permission });
    }
    return originalQuery(params);
  };

  // Remove Headless Chrome indicators
  Object.defineProperty(navigator, 'platform', {
    get: () => 'Win32',
    configurable: true,
  });

  // Spoof WebGL vendor and renderer
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.call(this, parameter);
  };
`;

// Inject stealth script into the page
window.addEventListener('DOMContentLoaded', () => {
  const script = document.createElement('script');
  script.textContent = STEALTH_SCRIPT;
  document.documentElement.prepend(script);
});
