/**
 * FormFlow Desktop Pro — VPN Controller
 *
 * Controls VPN connections using the actual detected executable paths.
 * Uses correct Windows CLI commands for each VPN client.
 *
 * Supported VPNs with working CLI:
 *   NordVPN:    `nordvpn.exe -c -g "United States"` (full country names)
 *   ExpressVPN: `ExpressVPN.CLI.exe connect "USA"` (in services/ subdirectory)
 *   Windscribe: `windscribe-cli.exe connect "United States"` (free tier available)
 *
 * NOT supported via CLI:
 *   Surfshark:  GUI-only app, no CLI interface. Detected but cannot connect programmatically.
 */

const { exec } = require('child_process');
const https = require('https');
const http = require('http');
const path = require('path');

const MAX_CONNECT_RETRIES = 2;
const IP_POLL_INTERVAL_MS = 2000;
const IP_POLL_MAX_WAIT_MS = 20000;
const POST_COMMAND_WAIT_MS = 5000;

class VPNController {
  constructor(clientName, clientPath = null, installDir = null) {
    this.clientName = clientName;
    this.clientPath = clientPath;
    this.installDir = installDir;
    this.connected = false;
    this.currentLocation = null;
    this.locationQueue = [];
    this.locationIndex = 0;
    this.debugLog = [];
  }

  setLocations(locations) {
    this.locationQueue = [...locations];
    this.locationIndex = 0;
  }

  log(message) {
    const entry = { time: new Date().toISOString(), message };
    this.debugLog.push(entry);
    if (this.debugLog.length > 100) this.debugLog.shift();
  }

  async connect(location = null) {
    if (!this.clientName) {
      return { success: false, error: 'No VPN client specified' };
    }

    if (this.clientName === 'Surfshark') {
      return {
        success: false,
        error: 'Surfshark has no CLI on Windows — it is a GUI-only app. Please use ExpressVPN, NordVPN, or Windscribe instead.',
        guiOnly: true,
      };
    }

    const targetLocation = location || this.getNextLocation();
    if (!targetLocation) {
      return { success: false, error: 'No VPN location available in queue' };
    }

    const cmd = this.buildConnectCommand(targetLocation);
    if (!cmd) {
      return {
        success: false,
        error: `Cannot build connect command for ${this.clientName}. Path: ${this.clientPath || 'not found'}`,
      };
    }

    this.log(`Capturing IP before connection...`);
    const ipBefore = await this.checkPublicIp();
    this.log(`IP before: ${ipBefore || 'unknown'}`);

    let lastError = null;
    for (let attempt = 0; attempt <= MAX_CONNECT_RETRIES; attempt++) {
      try {
        this.log(`Attempt ${attempt + 1}/${MAX_CONNECT_RETRIES + 1}: Running command: ${cmd}`);
        const cmdOutput = await this.runCommand(cmd, 45000);
        this.log(`Command output: ${cmdOutput || '(empty)'}`);

        this.log(`Waiting ${POST_COMMAND_WAIT_MS}ms for VPN to establish...`);
        await new Promise(r => setTimeout(r, POST_COMMAND_WAIT_MS));

        this.log(`Polling for IP change (max ${IP_POLL_MAX_WAIT_MS}ms)...`);
        const newIp = await this.pollForIpChange(ipBefore, IP_POLL_MAX_WAIT_MS);

        if (newIp && ipBefore && newIp === ipBefore) {
          const errMsg = `VPN command ran but IP did not change (still ${ipBefore}). The VPN may not have connected. Command: ${cmd}`;
          this.log(errMsg);
          lastError = errMsg;
          if (attempt < MAX_CONNECT_RETRIES) {
            await new Promise(r => setTimeout(r, 3000));
          }
          continue;
        }

        this.connected = true;
        this.currentLocation = targetLocation;
        this.log(`Connected! IP changed: ${ipBefore} → ${newIp}`);

        return {
          success: true,
          location: targetLocation,
          ip: newIp || 'unknown',
          previousIp: ipBefore || 'unknown',
          debug: this.debugLog.slice(-10),
        };
      } catch (err) {
        lastError = err.message;
        this.log(`Attempt ${attempt + 1} failed: ${lastError}`);
        if (attempt < MAX_CONNECT_RETRIES) {
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    return {
      success: false,
      error: `Failed after ${MAX_CONNECT_RETRIES + 1} attempts: ${lastError}`,
      location: targetLocation,
      currentIp: ipBefore || 'unknown',
      debug: this.debugLog.slice(-15),
    };
  }

  async pollForIpChange(originalIp, maxWaitMs) {
    const startTime = Date.now();
    let lastIp = null;

    while (Date.now() - startTime < maxWaitMs) {
      lastIp = await this.checkPublicIp();
      this.log(`IP poll: ${lastIp}`);

      if (lastIp && originalIp && lastIp !== originalIp) {
        return lastIp;
      }

      if (!originalIp && lastIp) {
        return lastIp;
      }

      await new Promise(r => setTimeout(r, IP_POLL_INTERVAL_MS));
    }

    return lastIp;
  }

  async disconnect() {
    const cmd = this.buildDisconnectCommand();
    if (!cmd) {
      this.connected = false;
      this.currentLocation = null;
      return { success: true };
    }

    try {
      this.log(`Disconnecting: ${cmd}`);
      await this.runCommand(cmd, 15000);
      this.connected = false;
      this.currentLocation = null;
      return { success: true };
    } catch (err) {
      this.connected = false;
      this.currentLocation = null;
      return { success: false, error: err.message };
    }
  }

  async switchNextLocation() {
    if (this.connected) {
      await this.disconnect();
      await new Promise(r => setTimeout(r, 2000));
    }

    const nextLocation = this.getNextLocation();
    if (!nextLocation) {
      return { success: false, error: 'No more locations in queue' };
    }
    return this.connect(nextLocation);
  }

  getNextLocation(strategy = 'round_robin') {
    if (this.locationQueue.length === 0) return null;

    switch (strategy) {
      case 'random':
        return this.locationQueue[Math.floor(Math.random() * this.locationQueue.length)];

      case 'sequential':
        return this.locationQueue[0];

      case 'round_robin':
      default: {
        const location = this.locationQueue[this.locationIndex % this.locationQueue.length];
        this.locationIndex++;
        return location;
      }
    }
  }

  buildConnectCommand(location) {
    const exePath = this.clientPath;

    switch (this.clientName) {
      case 'NordVPN': {
        // NordVPN Windows CLI: nordvpn.exe -c -g "United States"
        // Docs: https://support.nordvpn.com/hc/en-us/articles/19919384880145
        if (exePath) {
          return `"${exePath}" -c -g "${location}"`;
        }
        return `nordvpn -c -g "${location}"`;
      }

      case 'ExpressVPN': {
        // ExpressVPN Windows CLI: ExpressVPN.CLI.exe connect "location"
        // CLI is at: C:\Program Files (x86)\ExpressVPN\services\ExpressVPN.CLI.exe
        // Docs: https://expressvpn.com/support/vpn-setup/how-to-use-expressvpn-cli-windows/
        // App runs as admin (requestedExecutionLevel: requireAdministrator in package.json)
        // so VPN CLI commands inherit admin privileges — no UAC popup per command.
        const cliExe = this.findExpressVpnCli();
        if (cliExe) {
          return `"${cliExe}" connect "${location}"`;
        }
        return null;
      }

      case 'Windscribe': {
        // Windscribe Windows CLI: windscribe-cli.exe connect "location"
        // Docs: https://github.com/Windscribe/Desktop-App
        // Location: city name, country name, or ISO code (case-insensitive)
        if (exePath) {
          return `"${exePath}" connect "${location}"`;
        }
        return `windscribe-cli connect "${location}"`;
      }

      case 'Surfshark':
        return null;

      default:
        return null;
    }
  }

  findExpressVpnCli() {
    const fs = require('fs');

    // ExpressVPN CLI is in the services/ subdirectory, named ExpressVPN.CLI.exe
    const candidates = [];

    if (this.installDir) {
      candidates.push(
        path.join(this.installDir, 'services', 'ExpressVPN.CLI.exe'),
        path.join(this.installDir, 'ExpressVPN.CLI.exe'),
      );
    }

    if (this.clientPath) {
      const dir = path.dirname(this.clientPath);
      candidates.push(
        path.join(dir, 'services', 'ExpressVPN.CLI.exe'),
        path.join(dir, 'ExpressVPN.CLI.exe'),
      );
      // If clientPath is already in services/
      if (dir.toLowerCase().endsWith('services')) {
        candidates.push(path.join(dir, 'ExpressVPN.CLI.exe'));
      }
    }

    // Hardcoded known paths
    candidates.push(
      'C:\\Program Files (x86)\\ExpressVPN\\services\\ExpressVPN.CLI.exe',
      'C:\\Program Files\\ExpressVPN\\services\\ExpressVPN.CLI.exe',
    );

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          this.log(`Found ExpressVPN CLI: ${candidate}`);
          return candidate;
        }
      } catch {
        // skip
      }
    }

    this.log('ExpressVPN.CLI.exe not found in any expected location');
    return null;
  }

  buildDisconnectCommand() {
    switch (this.clientName) {
      case 'NordVPN': {
        const exePath = this.clientPath;
        if (exePath) return `"${exePath}" -d`;
        return 'nordvpn -d';
      }

      case 'ExpressVPN': {
        const cliExe = this.findExpressVpnCli();
        if (cliExe) return `"${cliExe}" disconnect`;
        return null;
      }

      case 'Windscribe': {
        const exePath = this.clientPath;
        if (exePath) return `"${exePath}" disconnect`;
        return 'windscribe-cli disconnect';
      }

      case 'Surfshark':
        return null;

      default:
        return null;
    }
  }

  async checkPublicIp() {
    const services = [
      { url: 'https://api.ipify.org?format=json', parse: (d) => JSON.parse(d).ip },
      { url: 'https://ipinfo.io/json', parse: (d) => JSON.parse(d).ip },
      { url: 'http://ip-api.com/json', parse: (d) => JSON.parse(d).query, useHttp: true },
    ];

    for (const svc of services) {
      try {
        const ip = await this.fetchIp(svc.url, svc.parse, svc.useHttp);
        if (ip) return ip;
      } catch {
        // try next
      }
    }
    return null;
  }

  fetchIp(url, parseFn, useHttp = false) {
    const mod = useHttp ? http : https;
    return new Promise((resolve) => {
      const req = mod.get(url, { timeout: 8000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(parseFn(data));
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  runCommand(cmd, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      exec(cmd, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Command failed: ${cmd}\nError: ${error.message}\nStderr: ${stderr || ''}\nStdout: ${stdout || ''}`));
        } else {
          resolve((stdout || '').trim());
        }
      });
    });
  }

  getStatus() {
    return {
      connected: this.connected,
      client: this.clientName,
      path: this.clientPath,
      location: this.currentLocation,
      queueSize: this.locationQueue.length,
      queueIndex: this.locationIndex,
      recentLog: this.debugLog.slice(-5),
    };
  }
}

module.exports = { VPNController };
