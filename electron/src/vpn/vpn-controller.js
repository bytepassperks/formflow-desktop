/**
 * FormFlow Desktop Pro — VPN Controller
 *
 * Controls VPN connections, disconnections, and location switching
 * via CLI commands for NordVPN, Surfshark, and ExpressVPN.
 *
 * Features:
 * - Auto-connect on workflow start
 * - Auto-rotate between workflows
 * - IP verification after connection
 * - Configurable rotation strategies
 */

const { exec } = require('child_process');
const https = require('https');
const http = require('http');

const CONNECT_COMMANDS = {
  NordVPN: {
    connect: (location) => `nordvpn -c -g "${location}"`,
    disconnect: 'nordvpn -d',
    status: 'nordvpn status',
  },
  Surfshark: {
    connect: (location) => `surfshark-vpn attack -l "${location}"`,
    disconnect: 'surfshark-vpn disconnect',
    status: 'surfshark-vpn status',
  },
  ExpressVPN: {
    connect: (location) => `expressvpn connect "${location}"`,
    disconnect: 'expressvpn disconnect',
    status: 'expressvpn status',
  },
};

class VPNController {
  constructor(clientName = null) {
    this.clientName = clientName;
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
    if (!this.clientName || !CONNECT_COMMANDS[this.clientName]) {
      return { success: false, error: `Unsupported VPN client: ${this.clientName}` };
    }

    const targetLocation = location || this.getNextLocation();
    if (!targetLocation) {
      return { success: false, error: 'No location specified' };
    }

    const cmd = CONNECT_COMMANDS[this.clientName].connect(targetLocation);

    try {
      await this.runCommand(cmd, 30000);

      // Verify IP changed (wait up to 20 seconds)
      const ipChanged = await this.verifyIpChange(20000);

      this.connected = true;
      this.currentLocation = targetLocation;

      return {
        success: true,
        location: targetLocation,
        ipVerified: ipChanged,
      };
    } catch (err) {
      return { success: false, error: err.message, location: targetLocation };
    }
  }

  async disconnect() {
    if (!this.clientName || !CONNECT_COMMANDS[this.clientName]) {
      return { success: false, error: 'No VPN client' };
    }

    try {
      await this.runCommand(CONNECT_COMMANDS[this.clientName].disconnect, 15000);
      this.connected = false;
      this.currentLocation = null;
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async switchNextLocation() {
    if (!this.connected) {
      return this.connect();
    }

    // Disconnect then reconnect to next location
    await this.disconnect();
    await new Promise(r => setTimeout(r, 2000));

    const nextLocation = this.getNextLocation();
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
      default:
        const location = this.locationQueue[this.locationIndex % this.locationQueue.length];
        this.locationIndex++;
        return location;
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

  async verifyIpChange(timeoutMs = 20000) {
    const startIp = await this.checkPublicIp();
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      await new Promise(r => setTimeout(r, 3000));
      const currentIp = await this.checkPublicIp();
      if (currentIp && currentIp !== startIp) {
        return true;
      }
    }

    return false;
  }

  runCommand(cmd, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const process = exec(cmd, { timeout: timeoutMs }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Command failed: ${error.message}`));
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
      location: this.currentLocation,
      queueSize: this.locationQueue.length,
      queueIndex: this.locationIndex,
    };
  }
}

module.exports = { VPNController };
