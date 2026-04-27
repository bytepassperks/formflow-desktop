/**
 * FormFlow Desktop Pro — Structured Debug Logger
 *
 * Captures ALL telemetry events as structured JSON.
 * This is the critical module for troubleshooting.
 */

const fs = require('fs');
const path = require('path');

class DebugLogger {
  constructor(logsDir) {
    this.logsDir = logsDir;
    this.events = [];

    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
  }

  log(event, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      ...details,
    };
    this.events.push(entry);
    return entry;
  }

  exportEvents() {
    const logPath = path.join(this.logsDir, 'debug_session.json');
    fs.writeFileSync(logPath, JSON.stringify(this.events, null, 2));
    return { path: logPath, count: this.events.length };
  }

  getEvents() {
    return [...this.events];
  }

  clear() {
    this.events = [];
  }
}

module.exports = { DebugLogger };
