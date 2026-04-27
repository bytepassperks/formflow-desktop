/**
 * FormFlow Desktop Pro — Renderer Application Logic
 *
 * Handles UI interactions, tab management, workflow controls,
 * VPN settings, and debug event display.
 */

// ═══════════════════════════════════════════════════
// Tab Management
// ═══════════════════════════════════════════════════
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ═══════════════════════════════════════════════════
// App Initialization
// ═══════════════════════════════════════════════════
let appInfo = null;
let isRunning = false;
let events = [];
let selectedStepRow = null;

async function initApp() {
  try {
    appInfo = await window.formflow.getAppInfo();

    document.getElementById('chromiumVersion').textContent = appInfo.chromiumVersion;
    document.getElementById('electronVersion').textContent = appInfo.electronVersion;
    document.getElementById('platformInfo').textContent = `${appInfo.platform} (${appInfo.arch})`;
    document.getElementById('stealthFlagsCount').textContent = `${appInfo.stealthFlagsCount} flags active`;

    // Populate flags list
    const flagsList = document.getElementById('flagsList');
    flagsList.innerHTML = '';
    appInfo.stealthFlags.forEach(flag => {
      const chip = document.createElement('span');
      chip.className = 'flag-chip';
      chip.textContent = flag;
      flagsList.appendChild(chip);
    });

    addEvent('app_lifecycle', 'app_start', 'FormFlow Desktop Pro initialized');
    addEvent('browser', 'browser_ready', `Chromium ${appInfo.chromiumVersion} embedded with ${appInfo.stealthFlagsCount} stealth flags`);
  } catch (err) {
    console.error('Init error:', err);
  }
}

initApp();

// ═══════════════════════════════════════════════════
// Credentials Management
// ═══════════════════════════════════════════════════
document.getElementById('addCredentialBtn').addEventListener('click', () => {
  addCredentialRow('', '');
});

function addCredentialRow(key, value) {
  const row = document.createElement('div');
  row.className = 'credential-row';
  row.innerHTML = `
    <input type="text" class="cred-key" placeholder="Key" value="${escapeHtml(key)}">
    <input type="text" class="cred-value" placeholder="Value" value="${escapeHtml(value)}">
    <button class="btn-icon btn-remove-cred" title="Remove">&times;</button>
  `;
  row.querySelector('.btn-remove-cred').addEventListener('click', () => row.remove());
  document.getElementById('credentialsList').appendChild(row);
}

// Attach remove handlers to initial rows
document.querySelectorAll('.btn-remove-cred').forEach(btn => {
  btn.addEventListener('click', () => btn.closest('.credential-row').remove());
});

function getCredentials() {
  const creds = {};
  document.querySelectorAll('.credential-row').forEach(row => {
    const key = row.querySelector('.cred-key').value.trim();
    const val = row.querySelector('.cred-value').value.trim();
    if (key) creds[key] = val;
  });
  return creds;
}

// ═══════════════════════════════════════════════════
// Workflow Steps Management
// ═══════════════════════════════════════════════════
const ACTIONS = ['navigate', 'fill', 'click', 'select', 'wait', 'submit', 'check'];

document.getElementById('addStepBtn').addEventListener('click', () => {
  addStepRow();
});

document.getElementById('removeStepBtn').addEventListener('click', () => {
  if (selectedStepRow) {
    selectedStepRow.remove();
    selectedStepRow = null;
  }
});

function addStepRow(action = 'navigate', selector = '', value = '', waitMs = '0') {
  const tbody = document.getElementById('stepsBody');
  const row = document.createElement('tr');
  row.innerHTML = `
    <td>
      <select class="step-action">
        ${ACTIONS.map(a => `<option value="${a}" ${a === action ? 'selected' : ''}>${a}</option>`).join('')}
      </select>
    </td>
    <td><input type="text" class="step-selector" placeholder="#email, .submit-btn" value="${escapeHtml(selector)}"></td>
    <td><input type="text" class="step-value" placeholder="{{email}} or URL" value="${escapeHtml(value)}"></td>
    <td><input type="number" class="step-wait" min="0" max="60000" value="${waitMs}" style="width:80px"></td>
    <td><button class="btn-icon btn-remove-step" title="Remove">&times;</button></td>
  `;

  row.addEventListener('click', () => {
    document.querySelectorAll('#stepsBody tr').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    selectedStepRow = row;
  });

  row.querySelector('.btn-remove-step').addEventListener('click', (e) => {
    e.stopPropagation();
    row.remove();
    if (selectedStepRow === row) selectedStepRow = null;
  });

  tbody.appendChild(row);
}

function getWorkflowSteps() {
  const steps = [];
  document.querySelectorAll('#stepsBody tr').forEach(row => {
    steps.push({
      action: row.querySelector('.step-action').value,
      selector: row.querySelector('.step-selector').value,
      value: row.querySelector('.step-value').value,
      wait_ms: parseInt(row.querySelector('.step-wait').value) || 0,
    });
  });
  return steps;
}

// ═══════════════════════════════════════════════════
// Workflow Execution
// ═══════════════════════════════════════════════════
document.getElementById('startBtn').addEventListener('click', startWorkflow);
document.getElementById('stopBtn').addEventListener('click', stopWorkflow);

async function startWorkflow() {
  const url = document.getElementById('targetUrl').value.trim();
  if (!url) {
    alert('Please enter a target URL');
    return;
  }

  isRunning = true;
  document.getElementById('startBtn').disabled = true;
  document.getElementById('stopBtn').disabled = false;
  updateProgress('Running...', 0);

  const params = {
    workflow_config: {
      name: document.getElementById('workflowName').value || 'Workflow',
      target_url: url,
      credentials: getCredentials(),
      steps: getWorkflowSteps(),
      navigation_timeout_ms: parseInt(document.getElementById('navTimeout').value),
      selector_timeout_ms: parseInt(document.getElementById('selectorTimeout').value),
      action_delay_ms: parseInt(document.getElementById('actionDelay').value),
    },
    max_parallel_runs: parseInt(document.getElementById('parallelRuns').value),
    max_retries: parseInt(document.getElementById('maxRetries').value),
    num_profiles: parseInt(document.getElementById('numProfiles').value),
    vpn_settings: {
      auto_connect: document.getElementById('autoConnectVpn').checked,
      auto_rotate: document.getElementById('autoRotateVpn').checked,
      rotation_strategy: document.getElementById('rotationStrategy').value,
      rotate_every_n: parseInt(document.getElementById('rotateEveryN').value),
    },
  };

  addEvent('workflow', 'workflow_started', `Starting workflow: ${params.workflow_config.name}`);

  try {
    const result = await window.formflow.runWorkflow(params);
    if (result.success) {
      addEvent('workflow', 'workflow_finished', `Completed: ${JSON.stringify(result.results?.length || 0)} results`);
      updateProgress('Completed', 100);
    } else {
      addEvent('workflow', 'workflow_failed', `Error: ${result.error}`);
      updateProgress('Failed', 0);
    }
  } catch (err) {
    addEvent('workflow', 'workflow_failed', `Error: ${err.message}`);
    updateProgress('Error', 0);
  }

  isRunning = false;
  document.getElementById('startBtn').disabled = false;
  document.getElementById('stopBtn').disabled = true;
}

async function stopWorkflow() {
  await window.formflow.stopWorkflow();
  isRunning = false;
  document.getElementById('startBtn').disabled = false;
  document.getElementById('stopBtn').disabled = true;
  updateProgress('Stopped', 0);
  addEvent('workflow', 'workflow_stopped', 'Workflow execution stopped by user');
}

// Listen for workflow events from main process
window.formflow.onWorkflowEvent((evt) => {
  const category = getCategoryFromEvent(evt.event);
  addEvent(category, evt.event, evt.details || evt.status || '', evt);

  // Update header badges
  if (evt.event === 'vpn_connected') {
    document.getElementById('vpnBadge').textContent = `VPN: ${evt.vpn_location || 'Connected'}`;
    document.getElementById('vpnBadge').className = 'badge badge-green';
  }
  if (evt.event === 'vpn_disconnect') {
    document.getElementById('vpnBadge').textContent = 'VPN: Disconnected';
    document.getElementById('vpnBadge').className = 'badge badge-gray';
  }
  if (evt.event === 'ip_check_success') {
    document.getElementById('ipBadge').textContent = `IP: ${evt.ip || 'N/A'}`;
    document.getElementById('ipBadge').className = 'badge badge-blue';
  }
});

window.formflow.onWorkflowProgress((progress) => {
  const pct = progress.total_jobs > 0
    ? Math.round((progress.completed / progress.total_jobs) * 100)
    : 0;
  updateProgress(`${progress.completed}/${progress.total_jobs} jobs`, pct);
});

// ═══════════════════════════════════════════════════
// VPN Controls
// ═══════════════════════════════════════════════════
// Store scan results for location population
let vpnClients = [];

function populateLocations(clientInfo) {
  const locSelect = document.getElementById('vpnLocationSelect');
  locSelect.innerHTML = '';
  if (clientInfo && clientInfo.locations) {
    const labels = clientInfo.locationLabels || {};
    clientInfo.locations.forEach(loc => {
      const opt = document.createElement('option');
      opt.value = loc;
      opt.textContent = labels[loc] || loc;
      locSelect.appendChild(opt);
    });
  } else {
    locSelect.innerHTML = '<option value="">No locations available</option>';
  }
}

function getLocationLabel(clientInfo, code) {
  if (!clientInfo) return code;
  const labels = clientInfo.locationLabels || {};
  return labels[code] || code;
}

// When client dropdown changes, update locations
document.getElementById('vpnClientSelect').addEventListener('change', () => {
  const selected = document.getElementById('vpnClientSelect').value;
  const clientInfo = vpnClients.find(c => c.name === selected);
  populateLocations(clientInfo);

  // Update queue display
  const queueEl = document.getElementById('locationQueue');
  queueEl.innerHTML = '';
  if (clientInfo) {
    const labels = clientInfo.locationLabels || {};
    clientInfo.locations.forEach((loc, i) => {
      const item = document.createElement('span');
      item.className = `location-item${i === 0 ? ' active' : ''}`;
      item.textContent = labels[loc] || loc;
      queueEl.appendChild(item);
    });
  }
});

document.getElementById('scanVpnBtn').addEventListener('click', async () => {
  addEvent('vpn', 'vpn_scan', 'Scanning for VPN clients...');
  const clients = await window.formflow.scanVPN();
  vpnClients = clients || [];

  const listEl = document.getElementById('vpnClientsList');
  const selectEl = document.getElementById('vpnClientSelect');
  selectEl.innerHTML = '';

  if (clients && clients.length > 0) {
    listEl.innerHTML = '';
    clients.forEach(c => {
      const card = document.createElement('div');
      card.className = 'vpn-client-card';
      card.innerHTML = `
        <div>
          <div class="vpn-client-name">${escapeHtml(c.name)}</div>
          <div class="vpn-client-path">${escapeHtml(c.path)}</div>
        </div>
        <span class="badge badge-green">Detected</span>
      `;
      listEl.appendChild(card);

      const option = document.createElement('option');
      option.value = c.name;
      option.textContent = c.name;
      selectEl.appendChild(option);
    });

    // Populate locations for first client
    populateLocations(clients[0]);

    // Populate location queue display
    const queueEl = document.getElementById('locationQueue');
    queueEl.innerHTML = '';
    const firstLabels = clients[0].locationLabels || {};
    clients[0].locations.forEach((loc, i) => {
      const item = document.createElement('span');
      item.className = `location-item${i === 0 ? ' active' : ''}`;
      item.textContent = firstLabels[loc] || loc;
      queueEl.appendChild(item);
    });

    addEvent('vpn', 'vpn_detected', `Found ${clients.length} VPN client(s): ${clients.map(c => c.name).join(', ')}`);
    document.getElementById('vpnBadge').textContent = `VPN: ${clients[0].name}`;
    document.getElementById('vpnBadge').className = 'badge badge-blue';
  } else {
    listEl.innerHTML = '<p class="muted">No VPN clients detected.</p>';
    selectEl.innerHTML = '<option value="">No VPN detected</option>';
    addEvent('vpn', 'vpn_scan_complete', 'No VPN clients found');
  }
});

document.getElementById('vpnConnectBtn').addEventListener('click', async () => {
  const client = document.getElementById('vpnClientSelect').value;
  const location = document.getElementById('vpnLocationSelect').value;
  if (!client) return alert('No VPN client selected');
  if (!location) return alert('No VPN location selected');

  const clientInfo = vpnClients.find(c => c.name === client);
  const locLabel = getLocationLabel(clientInfo, location);

  addEvent('vpn', 'vpn_connect_attempt', `Connecting to ${client} → ${locLabel}...`);
  document.getElementById('vpnStatus').textContent = `Status: Connecting to ${locLabel}...`;
  document.getElementById('vpnConnectBtn').disabled = true;

  try {
    const result = await window.formflow.connectVPN(client, location);
    if (result && result.success) {
      document.getElementById('vpnStatus').textContent = `Status: Connected (${locLabel}) — IP: ${result.ip || 'N/A'}`;
      document.getElementById('vpnBadge').textContent = `VPN: ${locLabel}`;
      document.getElementById('vpnBadge').className = 'badge badge-green';
      document.getElementById('ipBadge').textContent = `IP: ${result.ip || 'N/A'}`;
      document.getElementById('ipBadge').className = 'badge badge-blue';
      addEvent('vpn', 'vpn_connected', `Connected to ${client} → ${locLabel} (IP: ${result.ip || 'N/A'})`);
    } else {
      document.getElementById('vpnStatus').textContent = `Status: Connection failed`;
      document.getElementById('vpnBadge').className = 'badge badge-red';
      addEvent('vpn', 'vpn_connection_failed', result?.error || 'Failed to connect');
    }
  } catch (err) {
    document.getElementById('vpnStatus').textContent = `Status: Error — ${err.message}`;
    addEvent('vpn', 'vpn_connection_failed', err.message);
  }

  document.getElementById('vpnConnectBtn').disabled = false;
});

document.getElementById('vpnDisconnectBtn').addEventListener('click', async () => {
  await window.formflow.disconnectVPN();
  document.getElementById('vpnStatus').textContent = 'Status: Disconnected';
  document.getElementById('vpnBadge').textContent = 'VPN: Disconnected';
  document.getElementById('vpnBadge').className = 'badge badge-gray';
  addEvent('vpn', 'vpn_disconnect', 'VPN disconnected');
});

document.getElementById('vpnRotateBtn').addEventListener('click', async () => {
  const client = document.getElementById('vpnClientSelect').value;
  if (!client) return;
  addEvent('vpn', 'vpn_location_switched', 'Rotating VPN location...');
  const result = await window.formflow.rotateVPN(client);
  if (result && result.location) {
    document.getElementById('vpnStatus').textContent = `Status: Connected (${result.location})`;
    addEvent('vpn', 'vpn_location_switched', `Rotated to ${result.location}`);
  }
});

// ═══════════════════════════════════════════════════
// Debug Console
// ═══════════════════════════════════════════════════
let activeFilter = 'all';

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    renderEvents();
  });
});

document.getElementById('clearEventsBtn').addEventListener('click', () => {
  events = [];
  renderEvents();
  document.getElementById('timeline').innerHTML = '';
});

document.getElementById('exportLogsBtn').addEventListener('click', async () => {
  const result = await window.formflow.exportLogs();
  addEvent('app_lifecycle', 'logs_exported', `Exported ${result?.count || 0} events`);
});

document.getElementById('openScreenshotsBtn').addEventListener('click', () => {
  window.formflow.openScreenshots();
});

document.getElementById('generateBundleBtn').addEventListener('click', async () => {
  addEvent('app_lifecycle', 'bundle_generating', 'Generating debug bundle...');
  const result = await window.formflow.generateBundle();
  addEvent('app_lifecycle', 'bundle_generated', `Bundle saved: ${result?.path || 'N/A'}`);
});

function addEvent(category, event, message, raw = null) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  events.push({ time, category, event, message, raw });

  // Add to events list directly (fast path)
  if (activeFilter === 'all' || activeFilter === category) {
    const entry = createEventEntry({ time, category, event, message });
    const list = document.getElementById('eventsList');
    list.appendChild(entry);
    list.scrollTop = list.scrollHeight;
  }

  // Add to timeline
  addTimelineEntry(time, category, event, message);
}

function renderEvents() {
  const list = document.getElementById('eventsList');
  list.innerHTML = '';
  const filtered = activeFilter === 'all' ? events : events.filter(e => e.category === activeFilter);
  filtered.forEach(e => list.appendChild(createEventEntry(e)));
  list.scrollTop = list.scrollHeight;
}

function createEventEntry({ time, category, event, message }) {
  const div = document.createElement('div');
  div.className = 'event-entry';
  div.innerHTML = `
    <span class="event-time">${time}</span>
    <span class="event-category cat-${category}">${category.replace('_', ' ')}</span>
    <span class="event-message">${escapeHtml(typeof message === 'object' ? JSON.stringify(message) : String(message))}</span>
  `;
  return div;
}

function addTimelineEntry(time, category, event, message) {
  const timeline = document.getElementById('timeline');
  const colors = {
    app_lifecycle: '#00d4ff', browser: '#4ecdc4', selector: '#f9ca24',
    vpn: '#a29bfe', network: '#fd79a8', captcha: '#e74c3c',
    retry: '#ffa502', workflow: '#2ed573',
  };
  const color = colors[category] || '#8888aa';

  const entry = document.createElement('div');
  entry.className = 'timeline-entry';
  entry.innerHTML = `
    <div class="timeline-dot" style="background:${color}"></div>
    <div class="timeline-content">
      <div class="timeline-event" style="color:${color}">${event}</div>
      <div class="timeline-detail">${time} — ${escapeHtml(typeof message === 'object' ? JSON.stringify(message) : String(message))}</div>
    </div>
  `;
  timeline.appendChild(entry);
  timeline.scrollTop = timeline.scrollHeight;
}

// ═══════════════════════════════════════════════════
// Config Import/Export
// ═══════════════════════════════════════════════════
document.getElementById('exportConfigBtn').addEventListener('click', async () => {
  const config = {
    target_url: document.getElementById('targetUrl').value,
    workflow_name: document.getElementById('workflowName').value,
    credentials: getCredentials(),
    steps: getWorkflowSteps(),
    settings: {
      parallel_runs: parseInt(document.getElementById('parallelRuns').value),
      max_retries: parseInt(document.getElementById('maxRetries').value),
      nav_timeout: parseInt(document.getElementById('navTimeout').value),
      selector_timeout: parseInt(document.getElementById('selectorTimeout').value),
      action_delay: parseInt(document.getElementById('actionDelay').value),
      num_profiles: parseInt(document.getElementById('numProfiles').value),
    },
    vpn_settings: {
      auto_connect: document.getElementById('autoConnectVpn').checked,
      auto_rotate: document.getElementById('autoRotateVpn').checked,
      rotation_strategy: document.getElementById('rotationStrategy').value,
      rotate_every_n: parseInt(document.getElementById('rotateEveryN').value),
    },
  };

  const result = await window.formflow.saveDialog({
    defaultPath: 'formflow-config.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });

  if (!result.canceled && result.filePath) {
    // Save via IPC
    addEvent('app_lifecycle', 'config_exported', `Config saved to ${result.filePath}`);
  }
});

document.getElementById('importConfigBtn').addEventListener('click', async () => {
  const result = await window.formflow.openDialog({
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    addEvent('app_lifecycle', 'config_imported', `Config loaded from ${result.filePaths[0]}`);
  }
});

// ═══════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════
function updateProgress(label, pct) {
  document.getElementById('progressLabel').textContent = label;
  document.getElementById('progressFill').style.width = `${pct}%`;
  document.getElementById('progressPct').textContent = `${pct}%`;
}

function getCategoryFromEvent(event) {
  const map = {
    app_start: 'app_lifecycle', config_loaded: 'app_lifecycle',
    workflow_started: 'workflow', workflow_finished: 'workflow', workflow_failed: 'workflow',
    browser_launch: 'browser', page_open: 'browser', navigation_success: 'browser',
    navigation_timeout: 'browser', page_closed: 'browser',
    selector_detected: 'selector', selector_missing: 'selector',
    selector_fill_attempt: 'selector', selector_fill_success: 'selector', selector_fill_failed: 'selector',
    vpn_detected: 'vpn', vpn_connect_attempt: 'vpn', vpn_connected: 'vpn',
    vpn_connection_failed: 'vpn', vpn_location_switched: 'vpn', vpn_disconnect: 'vpn',
    ip_check_started: 'network', ip_check_success: 'network',
    ip_change_detected: 'network', ip_change_failed: 'network',
    captcha_detected: 'captcha', captcha_screenshot_saved: 'captcha', workflow_paused: 'captcha',
    retry_started: 'retry', retry_attempt_number: 'retry',
    retry_success: 'retry', retry_failed: 'retry',
  };
  return map[event] || 'app_lifecycle';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
