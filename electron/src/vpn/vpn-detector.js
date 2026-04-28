/**
 * FormFlow Desktop Pro — VPN Client Auto-Detector
 *
 * Scans for installed VPN clients on Windows:
 * - NordVPN     (has proper CLI: nordvpn.exe -c -g "location")
 * - ExpressVPN  (CLI at services/ExpressVPN.CLI.exe)
 * - Windscribe  (CLI: windscribe-cli.exe connect "location", free tier available)
 * - Surfshark   (GUI-only — detected but marked as non-automatable)
 *
 * Detection via: Program Files, PATH, registry, known install paths.
 * Returns the actual executable path so the controller can use it directly.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const VPN_CLIENTS = [
  {
    name: 'ExpressVPN',
    // ExpressVPN CLI: ExpressVPN.CLI.exe in services/ subdirectory
    // Confirmed path: C:\Program Files (x86)\ExpressVPN\services\ExpressVPN.CLI.exe
    // Commands: connect "location name", disconnect, status, list
    // Location names must match EXACTLY what "list" command outputs
    cliExeName: 'ExpressVPN.CLI.exe',
    exeNames: ['ExpressVPN.CLI.exe', 'ExpressVPN.exe'],
    winPaths: [
      'C:\\Program Files (x86)\\ExpressVPN\\services',
      'C:\\Program Files\\ExpressVPN\\services',
      'C:\\Program Files (x86)\\ExpressVPN',
      'C:\\Program Files\\ExpressVPN',
      'C:\\Program Files (x86)\\ExpressVPN\\expressvpn-ui',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ExpressVPN'),
    ],
    registryKeys: [
      'HKLM\\SOFTWARE\\ExpressVPN',
      'HKCU\\SOFTWARE\\ExpressVPN',
      'HKLM\\SOFTWARE\\WOW6432Node\\ExpressVPN',
    ],
    hasCli: true,
    // Exact location names from ExpressVPN CLI "list" command
    // Can also use numeric IDs (e.g., "1" for USA - San Francisco)
    locations: [
      'USA - New York', 'USA - Los Angeles - 1', 'USA - San Francisco',
      'USA - Washington DC', 'USA - Chicago', 'USA - Dallas',
      'USA - Miami', 'USA - Atlanta', 'USA - Seattle', 'USA - Denver',
      'USA - Brooklyn', 'USA - New Jersey - 1', 'USA - Houston',
      'UK - London', 'UK - Docklands', 'UK - East London', 'UK - Wembley',
      'Canada - Toronto', 'Canada - Montreal', 'Canada - Vancouver',
      'Germany - Frankfurt - 1', 'Germany - Berlin', 'Germany - Nuremberg',
      'Netherlands - Amsterdam', 'Netherlands - Rotterdam',
      'France - Paris - 1', 'France - Marseille', 'France - Strasbourg',
      'Australia - Sydney', 'Australia - Melbourne',
      'Japan - Tokyo', 'Japan - Shibuya', 'Japan - Yokohama',
      'Hong Kong - 1', 'Hong Kong - 2',
      'Singapore - Marina Bay', 'Singapore - CBD',
      'Switzerland', 'Switzerland - 2',
      'Italy - Milan', 'Italy - Naples',
      'Sweden', 'India (via Singapore)', 'India (via UK)',
      'Brazil', 'South Korea - 2', 'Spain - Madrid', 'Spain - Barcelona',
      'Norway', 'Mexico', 'Ireland', 'Poland',
    ],
    locationLabels: {
      'USA - New York': 'USA - New York',
      'USA - Los Angeles - 1': 'USA - Los Angeles',
      'USA - San Francisco': 'USA - San Francisco',
      'USA - Washington DC': 'USA - Washington DC',
      'USA - Chicago': 'USA - Chicago',
      'USA - Dallas': 'USA - Dallas',
      'USA - Miami': 'USA - Miami',
      'USA - Atlanta': 'USA - Atlanta',
      'USA - Seattle': 'USA - Seattle',
      'USA - Denver': 'USA - Denver',
      'USA - Brooklyn': 'USA - Brooklyn',
      'USA - New Jersey - 1': 'USA - New Jersey',
      'USA - Houston': 'USA - Houston',
      'UK - London': 'UK - London',
      'UK - Docklands': 'UK - Docklands',
      'UK - East London': 'UK - East London',
      'UK - Wembley': 'UK - Wembley',
      'Canada - Toronto': 'Canada - Toronto',
      'Canada - Montreal': 'Canada - Montreal',
      'Canada - Vancouver': 'Canada - Vancouver',
      'Germany - Frankfurt - 1': 'Germany - Frankfurt',
      'Germany - Berlin': 'Germany - Berlin',
      'Germany - Nuremberg': 'Germany - Nuremberg',
      'Netherlands - Amsterdam': 'Netherlands - Amsterdam',
      'Netherlands - Rotterdam': 'Netherlands - Rotterdam',
      'France - Paris - 1': 'France - Paris',
      'France - Marseille': 'France - Marseille',
      'France - Strasbourg': 'France - Strasbourg',
      'Australia - Sydney': 'Australia - Sydney',
      'Australia - Melbourne': 'Australia - Melbourne',
      'Japan - Tokyo': 'Japan - Tokyo',
      'Japan - Shibuya': 'Japan - Shibuya',
      'Japan - Yokohama': 'Japan - Yokohama',
      'Hong Kong - 1': 'Hong Kong - 1',
      'Hong Kong - 2': 'Hong Kong - 2',
      'Singapore - Marina Bay': 'Singapore - Marina Bay',
      'Singapore - CBD': 'Singapore - CBD',
      'Switzerland': 'Switzerland',
      'Switzerland - 2': 'Switzerland - 2',
      'Italy - Milan': 'Italy - Milan',
      'Italy - Naples': 'Italy - Naples',
      'Sweden': 'Sweden',
      'India (via Singapore)': 'India (via Singapore)',
      'India (via UK)': 'India (via UK)',
      'Brazil': 'Brazil',
      'South Korea - 2': 'South Korea',
      'Spain - Madrid': 'Spain - Madrid',
      'Spain - Barcelona': 'Spain - Barcelona',
      'Norway': 'Norway',
      'Mexico': 'Mexico',
      'Ireland': 'Ireland',
      'Poland': 'Poland',
    },
  },
  {
    name: 'NordVPN',
    // NordVPN CLI: nordvpn.exe -c -g "United States"
    // Docs: https://support.nordvpn.com/hc/en-us/articles/19919384880145
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
    hasCli: true,
    locations: [
      'United States', 'United Kingdom', 'Canada', 'Germany', 'Netherlands',
      'France', 'Switzerland', 'Japan', 'Australia', 'Singapore',
      'Sweden', 'Italy', 'Spain', 'Norway', 'Denmark',
    ],
  },
  {
    name: 'Windscribe',
    // Windscribe CLI: windscribe-cli.exe connect "location"
    // Free tier: 10GB/month, 11 countries
    // Docs: https://github.com/Windscribe/Desktop-App
    exeNames: ['windscribe-cli.exe', 'Windscribe.exe'],
    winPaths: [
      'C:\\Program Files\\Windscribe',
      'C:\\Program Files (x86)\\Windscribe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Windscribe'),
      path.join(process.env.LOCALAPPDATA || '', 'Windscribe'),
    ],
    registryKeys: [
      'HKLM\\SOFTWARE\\Windscribe',
      'HKCU\\SOFTWARE\\Windscribe',
    ],
    hasCli: true,
    locations: [
      'US East', 'US West', 'US Central', 'United Kingdom', 'Canada East', 'Canada West',
      'Hong Kong', 'France', 'Germany', 'Luxembourg', 'Netherlands',
      'Switzerland', 'Norway', 'Romania',
    ],
    locationLabels: {
      'US East': 'US East', 'US West': 'US West', 'US Central': 'US Central',
      'United Kingdom': 'United Kingdom', 'Canada East': 'Canada East', 'Canada West': 'Canada West',
      'Hong Kong': 'Hong Kong', 'France': 'France', 'Germany': 'Germany',
      'Luxembourg': 'Luxembourg', 'Netherlands': 'Netherlands', 'Switzerland': 'Switzerland',
      'Norway': 'Norway', 'Romania': 'Romania',
    },
    freeLocations: [
      'US East', 'US West', 'US Central', 'United Kingdom', 'Canada East', 'Canada West',
      'Hong Kong', 'France', 'Germany', 'Luxembourg', 'Netherlands',
      'Switzerland', 'Norway', 'Romania',
    ],
  },
  {
    name: 'Surfshark',
    // Surfshark — GUI-only, NO CLI on Windows.
    // Detected for display purposes but cannot connect programmatically.
    exeNames: ['Surfshark.exe', 'surfshark.exe'],
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
    hasCli: false,
    guiOnly: true,
    locations: [],
    locationLabels: {},
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
    // For ExpressVPN, prioritize finding the CLI exe specifically
    if (clientDef.cliExeName) {
      const cliResult = this.findCliExe(clientDef);
      if (cliResult) return cliResult;
    }

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

  findCliExe(clientDef) {
    const cliName = clientDef.cliExeName;
    for (const basePath of clientDef.winPaths) {
      const cliPath = path.join(basePath, cliName);
      if (fs.existsSync(cliPath)) {
        return this.buildResult(clientDef, cliPath, basePath);
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
      hasCli: clientDef.hasCli !== false,
      guiOnly: clientDef.guiOnly || false,
      freeLocations: clientDef.freeLocations || null,
    };
  }
}

module.exports = { VPNDetector };
