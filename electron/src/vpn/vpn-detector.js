/**
 * FormFlow Desktop Pro — VPN Client Auto-Detector
 *
 * Scans for installed VPN clients on Windows:
 * - NordVPN (has proper CLI)
 * - Surfshark (GUI app, use Windows VPN adapter or service CLI)
 * - ExpressVPN (CLI in expressvpnd subdirectory)
 *
 * Detection via: Program Files, PATH, registry, known install paths.
 * Returns the actual executable path so the controller can use it directly.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const VPN_CLIENTS = [
  {
    name: 'NordVPN',
    // NordVPN has a proper CLI on Windows
    exeNames: ['NordVPN.exe', 'nordvpn.exe'],
    winPaths: [
      'C:\\Program Files\\NordVPN',
      'C:\\Program Files (x86)\\NordVPN',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'NordVPN'),
    ],
    registryKeys: [
      'HKLM\\SOFTWARE\\NordVPN',
      'HKCU\\SOFTWARE\\NordVPN',
    ],
    locations: [
      'United States', 'United Kingdom', 'Canada', 'Germany', 'Netherlands',
      'France', 'Switzerland', 'Japan', 'Australia', 'Singapore',
      'Sweden', 'Italy', 'Spain', 'Norway', 'Denmark',
    ],
  },
  {
    name: 'Surfshark',
    // Surfshark on Windows — main GUI exe, also check for CLI
    exeNames: ['Surfshark.exe', 'surfshark.exe', 'Surfshark.Service.exe'],
    winPaths: [
      'C:\\Program Files\\Surfshark',
      'C:\\Program Files (x86)\\Surfshark',
      path.join(process.env.LOCALAPPDATA || '', 'Surfshark'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Surfshark'),
      path.join(process.env.APPDATA || '', 'Surfshark'),
    ],
    registryKeys: [
      'HKLM\\SOFTWARE\\Surfshark',
      'HKCU\\SOFTWARE\\Surfshark',
    ],
    locations: [
      'us', 'uk', 'ca', 'de', 'nl',
      'fr', 'au', 'jp', 'in', 'sg',
      'br', 'it', 'es', 'no', 'pl',
    ],
    locationLabels: {
      'us': 'United States', 'uk': 'United Kingdom', 'ca': 'Canada',
      'de': 'Germany', 'nl': 'Netherlands', 'fr': 'France',
      'au': 'Australia', 'jp': 'Japan', 'in': 'India',
      'sg': 'Singapore', 'br': 'Brazil', 'it': 'Italy',
      'es': 'Spain', 'no': 'Norway', 'pl': 'Poland',
    },
  },
  {
    name: 'ExpressVPN',
    // ExpressVPN CLI is in expressvpnd subdirectory
    exeNames: ['expressvpn.exe', 'ExpressVPN.exe', 'ExpressVPNBrowser.exe'],
    winPaths: [
      'C:\\Program Files\\ExpressVPN',
      'C:\\Program Files (x86)\\ExpressVPN',
      'C:\\Program Files\\ExpressVPN\\expressvpnd',
      'C:\\Program Files (x86)\\ExpressVPN\\expressvpnd',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ExpressVPN'),
    ],
    registryKeys: [
      'HKLM\\SOFTWARE\\ExpressVPN',
      'HKCU\\SOFTWARE\\ExpressVPN',
      'HKLM\\SOFTWARE\\WOW6432Node\\ExpressVPN',
    ],
    locations: [
      'smart', 'us', 'uk', 'ca', 'de', 'nl',
      'fr', 'au', 'jp', 'hk', 'sg',
      'ch', 'it', 'se', 'in', 'br',
    ],
    locationLabels: {
      'smart': 'Smart Location', 'us': 'United States', 'uk': 'United Kingdom',
      'ca': 'Canada', 'de': 'Germany', 'nl': 'Netherlands',
      'fr': 'France', 'au': 'Australia', 'jp': 'Japan',
      'hk': 'Hong Kong', 'sg': 'Singapore', 'ch': 'Switzerland',
      'it': 'Italy', 'se': 'Sweden', 'in': 'India', 'br': 'Brazil',
    },
  },
];

class VPNDetector {
  scanAll() {
    const detected = [];

    for (const client of VPN_CLIENTS) {
      const result = this.detectClient(client);
      if (result) {
        detected.push(result);
      }
    }

    return detected;
  }

  detectClient(clientDef) {
    // 1. Check known install paths with all exe name variants
    for (const basePath of clientDef.winPaths) {
      for (const exeName of clientDef.exeNames) {
        const exePath = path.join(basePath, exeName);
        if (fs.existsSync(exePath)) {
          return this.buildResult(clientDef, exePath, basePath);
        }
      }

      // Check subdirectories (1 level deep)
      if (fs.existsSync(basePath)) {
        try {
          const entries = fs.readdirSync(basePath, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              for (const exeName of clientDef.exeNames) {
                const subExe = path.join(basePath, entry.name, exeName);
                if (fs.existsSync(subExe)) {
                  return this.buildResult(clientDef, subExe, path.join(basePath, entry.name));
                }
              }
            }
          }
        } catch {
          // ignore read errors
        }
      }
    }

    // 2. Check PATH for any of the exe names
    if (process.platform === 'win32') {
      for (const exeName of clientDef.exeNames) {
        try {
          const whereResult = execSync(`where "${exeName}" 2>nul`, {
            encoding: 'utf-8',
            timeout: 5000,
          }).trim();

          if (whereResult) {
            const foundPath = whereResult.split('\n')[0].trim();
            return this.buildResult(clientDef, foundPath, path.dirname(foundPath));
          }
        } catch {
          // Not in PATH
        }
      }
    }

    // 3. Check registry
    if (process.platform === 'win32') {
      for (const regKey of (clientDef.registryKeys || [])) {
        try {
          const regResult = execSync(
            `reg query "${regKey}" /s 2>nul`,
            { encoding: 'utf-8', timeout: 5000 }
          ).trim();

          // Look for InstallLocation or InstallPath
          const match = regResult.match(/(?:InstallLocation|InstallPath|Path)\s+REG_SZ\s+(.+)/i);
          if (match) {
            const installPath = match[1].trim();
            for (const exeName of clientDef.exeNames) {
              const exePath = path.join(installPath, exeName);
              if (fs.existsSync(exePath)) {
                return this.buildResult(clientDef, exePath, installPath);
              }
            }
          }
        } catch {
          // Registry key not found
        }
      }
    }

    return null;
  }

  buildResult(clientDef, exePath, installDir) {
    return {
      name: clientDef.name,
      path: exePath,
      installDir: installDir,
      locations: clientDef.locations,
      locationLabels: clientDef.locationLabels || null,
    };
  }
}

module.exports = { VPNDetector };
