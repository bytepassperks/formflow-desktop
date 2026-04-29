/**
 * FormFlow Desktop Pro — Debug Bundle Exporter
 *
 * Exports a troubleshooting bundle containing:
 * - debug_session.json
 * - network_snapshot.json
 * - screenshots/*
 * - config
 *
 * Packaged as debug_bundle.zip
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class BundleExporter {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.logsDir = path.join(appRoot, 'logs');
    this.bundlesDir = path.join(appRoot, 'bundles');

    if (!fs.existsSync(this.bundlesDir)) {
      fs.mkdirSync(this.bundlesDir, { recursive: true });
    }
  }

  async export() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bundleName = `debug_bundle_${timestamp}`;
    const bundlePath = path.join(this.bundlesDir, bundleName);

    // Create temp directory
    if (!fs.existsSync(bundlePath)) {
      fs.mkdirSync(bundlePath, { recursive: true });
    }

    // Copy logs
    const filesToCopy = [
      { src: path.join(this.logsDir, 'debug_session.json'), dest: 'debug_session.json' },
      { src: path.join(this.logsDir, 'network_snapshot.json'), dest: 'network_snapshot.json' },
    ];

    for (const { src, dest } of filesToCopy) {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(bundlePath, dest));
      }
    }

    // Copy screenshots
    const screenshotsDir = path.join(this.logsDir, 'screenshots');
    if (fs.existsSync(screenshotsDir)) {
      const bundleScreenshots = path.join(bundlePath, 'screenshots');
      fs.mkdirSync(bundleScreenshots, { recursive: true });

      const files = fs.readdirSync(screenshotsDir);
      for (const file of files) {
        fs.copyFileSync(
          path.join(screenshotsDir, file),
          path.join(bundleScreenshots, file)
        );
      }
    }

    // Add app info
    const info = {
      exported_at: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      electron_version: process.versions.electron,
      chromium_version: process.versions.chrome,
      node_version: process.versions.node,
    };
    fs.writeFileSync(
      path.join(bundlePath, 'app_info.json'),
      JSON.stringify(info, null, 2)
    );

    // Create zip (Windows)
    const zipPath = `${bundlePath}.zip`;
    try {
      if (process.platform === 'win32') {
        execSync(
          `powershell -Command "Compress-Archive -Path '${bundlePath}\\*' -DestinationPath '${zipPath}' -Force"`,
          { timeout: 30000 }
        );
      } else {
        execSync(`cd "${bundlePath}" && zip -r "${zipPath}" .`, { timeout: 30000 });
      }
    } catch {
      // Zip creation failed — just return the directory
      return { path: bundlePath, zipped: false };
    }

    return { path: zipPath, zipped: true };
  }
}

module.exports = { BundleExporter };
