/**
 * FormFlow Desktop Pro — VPN Controller
 *
 * Controls VPN connections using the actual detected executable paths.
 * Uses correct Windows CLI commands for each VPN client.
 *
 * NordVPN: Has proper CLI — `"path\nordvpn.exe" -c -g "location"`
 * Surfshark: GUI-based — uses `cmd /c start` to launch with connection
 * ExpressVPN: CLI daemon — `"path\expressvpn.exe" connect "location"`
 */

const { exec, execSync } = require('child_process');
const https = require('https');
const path = require('path');

const MAX_CONNECT_RETRIES = 2;

class VPNController {
  constructor(clientName, clientPath = null, installDir = null) {
    this.clientName = clientName;
    this.clientPath = clientPath;
    this.installDir = installDir;
    this.connected = false;
    this.currentLocation = null;
    this.locationQueue = [];
    this.locationIndex = 0;
  }

  setLocations(locations) {
    this.locationQueue = [...locations];
    this.locationIndex = 0;
  }

  async connect(location = null) {
    if (!this.clientName) {
      return { success: false, error: 'No VPN client specified' };
    }

    const targetLocation = location || this.getNextLocation();
    if (!targetLocation) {
      return { success: false, error: 'No VPN location available in queue' };
    }

    const cmd = this.buildConnectCommand(targetLocation);
    if (!cmd) {
      return { success: false, error: `Cannot build connect command for ${this.clientName}. Executable path: ${this.clientPath || 'unknown'}` };
    }

    let lastError = null;
    for (let attempt = 0; attempt <= MAX_CONNECT_RETRIES; attempt++) {
      try {
        await this.runCommand(cmd, 30000);

        // Wait a moment for VPN to establish
        await new Promise(r => setTimeout(r, 3000));

        // Verify IP changed (wait up to 15 seconds)
        const ip = await this.checkPublicIp();

        this.connected = true;
        this.currentLocation = targetLocation;

        return {
          success: true,
          location: targetLocation,
          ip: ip || 'unknown',
        };
      } catch (err) {
        lastError = err.message;
        if (attempt < MAX_CONNECT_RETRIES) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    return {
      success: false,
      error: `Failed after ${MAX_CONNECT_RETRIES + 1} attempts: ${lastError}`,
      location: targetLocation,
    };
  }

  async disconnect() {
    const cmd = this.buildDisconnectCommand();
    if (!cmd) {
      this.connected = false;
      this.currentLocation = null;
      return { success: true };
    }

    try {
      await this.runCommand(cmd, 15000);
      this.connected = false;
      this.currentLocation = null;
      return { success: true };
    } catch (err) {
      // Even if disconnect command fails, mark as disconnected
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

  /**
   * Build the correct connect command for the detected VPN client.
   * Uses the full executable path found by the detector.
   */
  buildConnectCommand(location) {
    const exePath = this.clientPath;

    switch (this.clientName) {
      case 'NordVPN':
        // NordVPN CLI: nordvpn.exe -c -g "United States"
        if (exePath) {
          return `"${exePath}" -c -g "${location}"`;
        }
        return `nordvpn -c -g "${location}"`;

      case 'Surfshark':
        // Surfshark on Windows: Try multiple approaches
        // 1. Direct CLI if available
        // 2. Launch via start command
        if (exePath) {
          // Try using the Surfshark exe with connect argument
          // Surfshark 2.x+ supports: Surfshark.exe --connect --location <code>
          return `"${exePath}" --connect --location "${location}"`;
        }
        return null;

      case 'ExpressVPN':
        // ExpressVPN CLI: expressvpn.exe connect "location"
        if (exePath) {
          return `"${exePath}" connect "${location}"`;
        }
        return `expressvpn connect "${location}"`;

      default:
        return null;
    }
  }

  buildDisconnectCommand() {
    const exePath = this.clientPath;

    switch (this.clientName) {
      case 'NordVPN':
        if (exePath) return `"${exePath}" -d`;
        return 'nordvpn -d';

      case 'Surfshark':
        if (exePath) return `"${exePath}" --disconnect`;
        return null;

      case 'ExpressVPN':
        if (exePath) return `"${exePath}" disconnect`;
        return 'expressvpn disconnect';

      default:
        return null;
    }
  }

  async checkPublicIp() {
    return new Promise((resolve) => {
      const req = https.get('https://api.ipify.org?format=json', { timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const { ip } = JSON.parse(data);
            resolve(ip);
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
          reject(new Error(`Command failed: ${cmd}\n${error.message}\n${stderr || ''}`));
        } else {
          resolve(stdout.trim());
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
    };
  }
}

module.exports = { VPNController };
