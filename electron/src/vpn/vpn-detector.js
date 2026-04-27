/**
 * FormFlow Desktop Pro — VPN Client Auto-Detector
 *
 * Scans for installed VPN clients on Windows:
 * - NordVPN
 * - Surfshark
 * - ExpressVPN
 *
 * Detection via: Program Files, PATH, registry, known install paths.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const VPN_CLIENTS = [
  {
    name: 'NordVPN',
    exeName: 'nordvpn.exe',
    winPaths: [
      'C:\\Program Files\\NordVPN',
      'C:\\Program Files (x86)\\NordVPN',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'NordVPN'),
    ],
    cliName: 'nordvpn',
    registryKey: 'HKLM\\SOFTWARE\\NordVPN',
    locations: [
      'United States', 'United Kingdom', 'Canada', 'Germany', 'Netherlands',
      'France', 'Switzerland', 'Japan', 'Australia', 'Singapore',
      'Sweden', 'Italy', 'Spain', 'Norway', 'Denmark',
    ],
  },
  {
    name: 'Surfshark',
    exeName: 'surfshark.exe',
    winPaths: [
      'C:\\Program Files\\Surfshark',
      'C:\\Program Files (x86)\\Surfshark',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Surfshark'),
    ],
    cliName: 'surfshark',
    registryKey: 'HKLM\\SOFTWARE\\Surfshark',
    locations: [
      'United States', 'United Kingdom', 'Canada', 'Germany', 'Netherlands',
      'France', 'Australia', 'Japan', 'India', 'Singapore',
      'Brazil', 'Italy', 'Spain', 'Norway', 'Poland',
    ],
  },
  {
    name: 'ExpressVPN',
    exeName: 'expressvpn.exe',
    winPaths: [
      'C:\\Program Files\\ExpressVPN',
      'C:\\Program Files (x86)\\ExpressVPN',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ExpressVPN'),
    ],
    cliName: 'expressvpn',
    registryKey: 'HKLM\\SOFTWARE\\ExpressVPN',
    locations: [
      'United States', 'United Kingdom', 'Canada', 'Germany', 'Netherlands',
      'France', 'Australia', 'Japan', 'Hong Kong', 'Singapore',
      'Switzerland', 'Italy', 'Sweden', 'India', 'Brazil',
    ],
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
    // Check known install paths
    for (const basePath of clientDef.winPaths) {
      const exePath = path.join(basePath, clientDef.exeName);
      if (fs.existsSync(exePath)) {
        return {
          name: clientDef.name,
          path: exePath,
          cli: clientDef.cliName,
          locations: clientDef.locations,
        };
      }

      // Check subdirectories
      if (fs.existsSync(basePath)) {
        try {
          const entries = fs.readdirSync(basePath, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const subExe = path.join(basePath, entry.name, clientDef.exeName);
              if (fs.existsSync(subExe)) {
                return {
                  name: clientDef.name,
                  path: subExe,
                  cli: clientDef.cliName,
                  locations: clientDef.locations,
                };
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }

    // Check PATH
    try {
      const whereResult = execSync(`where ${clientDef.cliName} 2>nul`, {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      if (whereResult) {
        return {
          name: clientDef.name,
          path: whereResult.split('\n')[0].trim(),
          cli: clientDef.cliName,
          locations: clientDef.locations,
        };
      }
    } catch {
      // Not in PATH
    }

    // Check registry (Windows only)
    if (process.platform === 'win32') {
      try {
        const regResult = execSync(
          `reg query "${clientDef.registryKey}" /v InstallLocation 2>nul`,
          { encoding: 'utf-8', timeout: 5000 }
        ).trim();

        const match = regResult.match(/InstallLocation\s+REG_SZ\s+(.+)/);
        if (match) {
          const installPath = match[1].trim();
          const exePath = path.join(installPath, clientDef.exeName);
          if (fs.existsSync(exePath)) {
            return {
              name: clientDef.name,
              path: exePath,
              cli: clientDef.cliName,
              locations: clientDef.locations,
            };
          }
        }
      } catch {
        // Registry key not found
      }
    }

    return null;
  }
}

module.exports = { VPNDetector };
