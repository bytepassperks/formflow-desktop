# FormFlow Desktop Pro

**Network & Environment-Aware Registration Workflow Testing Studio (Windows)**

A Windows desktop application that automates configurable registration workflow testing across websites while allowing controlled browser environment variation, VPN switching via installed clients, and exporting structured debug telemetry logs for troubleshooting automation behavior.

## Intended Use

- QA testing
- Onboarding pipeline simulation
- Browser workflow testing
- Network condition testing
- Automation research

> **NOT intended to bypass protections.**

## Features

### 1. Multi-Profile Browser Isolation Engine
Each workflow runs in an isolated Playwright browser profile with its own cookies, localStorage, sessionStorage, cache, and fingerprint seed.

### 2. Parallel Workflow Execution Engine
Configurable concurrency (1–5 simultaneous workflows) using an asyncio task pool with round-robin scheduling across credential, workflow, and VPN location queues.

### 3. Browser Environment Simulation Layer
Each profile optionally randomizes: timezone, locale, viewport size, user agent, color scheme, and language header.

### 4. VPN Rotation Scheduler with Auto-Connect & Auto-Rotate
Auto-detects installed VPN clients (NordVPN, Surfshark, ExpressVPN) by scanning Program Files, PATH variables, and registry entries. Executes connect → verify IP → run workflow → switch location → repeat pipeline with 20-second IP change timeout.

**New:** Fully automatic VPN management:
- **Auto-Connect**: VPN connects automatically before workflow execution starts — no manual click needed
- **Auto-Rotate**: VPN location rotates automatically between workflow runs
- **Rotation Strategies**: Round Robin, Random, Sequential
- **Configurable Frequency**: Rotate every N workflows

### 5. Smart Workflow Retry Engine
Retry on timeout, selector failure, navigation failure, form validation rejection, or network error. Configurable max retries (default: 2) with VPN location switch between attempts.

### 6. CAPTCHA Detection Monitor
Detects reCAPTCHA, hCaptcha, and Cloudflare Turnstile iframes/class patterns. On detection: pauses workflow, captures screenshot, logs event, and notifies UI. Does NOT bypass CAPTCHA.

### 7. Structured Debug Logger
JSON-structured telemetry to `logs/debug_session.json`. Captures 30+ event types across 8 categories:
- App Lifecycle, Browser, Selector, VPN, Network, CAPTCHA, Retry, Workflow

### 8. Screenshot Debug Capture Engine
Automatically captures screenshots on: workflow failure, selector missing, captcha detected, timeout. Saved to `logs/screenshots/`.

### 9. Network Snapshot Debugging
Captures public IP, timezone, user agent, locale, viewport and stores in `logs/network_snapshot.json`.

### 10. UI Debug Panel
Live event stream, current selector activity, VPN status, retry counter, IP detection status. Buttons: export logs, open screenshots, copy error summary, generate bundle.

### 11. Troubleshooting Bundle Generator
Exports `debug_session.json`, `errors.log`, `network_snapshot.json`, screenshots, and session config as `debug_bundle.zip`.

### 12. Execution Timeline Viewer
Vertical timeline log stream showing: VPN connected → IP verified → browser launched → selectors filled → form submitted → result received. With category color-coding and filtering.

### 13. Bundled Custom Chromium Browser (**NEW**)
Ships a fully custom Chromium browser bundled with the application. Critical automation-detection flags are disabled:
- `navigator.webdriver` removed
- Automation info bar disabled
- `--disable-blink-features=AutomationControlled`
- Sandbox, web security, CORS restrictions disabled for testing
- Certificate errors ignored
- Background networking/updates disabled
- Anti-detection JavaScript injected on every page load
- No external browser installation required

Chromium can be downloaded from the **Browser** tab in the UI and is automatically bundled into the `.exe` via PyInstaller.

## Project Structure

```
formflow-desktop/
├── main.py                          # Application entry point
├── formflow.spec                    # PyInstaller build spec
├── requirements.txt                 # Python dependencies
├── browser/                         # Bundled Chromium browser
├── ui/
│   ├── main_window.py               # Main application window
│   ├── workflow_panel.py            # Workflow configuration panel
│   ├── browser_panel.py             # Bundled Chromium management panel
│   ├── debug_panel.py               # Debug console panel
│   ├── timeline_panel.py            # Execution timeline viewer
│   ├── vpn_panel.py                 # VPN management panel (auto-connect/rotate)
│   └── styles.py                    # UI stylesheet definitions
├── automation/
│   ├── chromium_manager.py          # Bundled Chromium download/launch/stealth
│   ├── workflow_engine.py           # Playwright workflow runner
│   ├── workflow_scheduler.py        # Parallel execution scheduler
│   ├── profile_manager.py          # Browser profile isolation
│   ├── environment_simulator.py    # Environment randomization
│   ├── captcha_monitor.py          # CAPTCHA detection
│   └── retry_engine.py             # Smart retry with VPN switching
├── vpn/
│   ├── vpn_detector.py             # VPN client auto-detection
│   ├── vpn_controller.py           # VPN connect/disconnect/switch
│   └── vpn_scheduler.py            # VPN rotation (auto-connect/rotate)
├── debug/
│   ├── debug_logger.py             # Structured JSON telemetry
│   ├── screenshot_manager.py       # Screenshot capture engine
│   ├── network_snapshot.py         # Network environment capture
│   └── bundle_exporter.py          # Debug bundle generator
├── config/
│   ├── config_manager.py           # Configuration loader
│   └── default_config.json         # Default application config
├── utils/
│   └── helpers.py                  # Common utility functions
├── profiles/                        # Browser profile data
├── logs/                           # Debug logs & screenshots
└── bundles/                        # Exported debug bundles
```

## Installation

### Prerequisites
- Python 3.9+
- Windows 10/11 (primary target)

### Setup

```bash
# Clone the repository
git clone https://github.com/bytepassperks/formflow-desktop.git
cd formflow-desktop

# Create virtual environment
python -m venv venv
venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Install Playwright browsers (optional if using bundled Chromium)
playwright install chromium
```

### Download Bundled Chromium

The app can download and bundle its own custom Chromium:
1. Run the app: `python main.py`
2. Go to the **Browser** tab
3. Click **Download Chromium**
4. The browser is extracted to `browser/` and used for all workflows

Alternatively, workflows will fall back to Playwright's default Chromium if no bundled browser is found.

### Run

```bash
python main.py
```

### Build Executable

```bash
# Build with PyInstaller (auto-bundles Chromium if present in browser/)
pyinstaller formflow.spec

# Output: dist/FormFlowDesktopPro.exe
```

## Quick Start

1. **Setup Browser**: Go to Browser tab → Download Chromium (one-time setup)
2. **Configure Workflow**: Enter target URL, add credentials, define workflow steps (navigate, fill, click, etc.)
3. **Set Execution Options**: Parallel runs (1-5), max retries, timeouts
4. **VPN**: Scan for installed clients. Enable auto-connect and auto-rotate in the VPN tab — VPN connects and rotates automatically
5. **Start**: Click "Start Workflow" — VPN auto-connects, browser launches with stealth flags, workflows execute
6. **Debug**: Use debug panel for live events, export logs, or generate troubleshooting bundle

## Workflow Step Types

| Action     | Description                          |
|-----------|--------------------------------------|
| `navigate` | Navigate to a URL                    |
| `fill`     | Fill a form field with a value       |
| `click`    | Click an element                     |
| `select`   | Select dropdown option               |
| `wait`     | Wait for specified milliseconds      |
| `submit`   | Click a submit button                |
| `check`    | Check a checkbox/radio button        |

### Credential Substitution

Use `{{key}}` syntax in step values to reference credentials:
- Step value: `{{email}}` → substituted with the credential value for "email"

## Debug Events Reference

| Category      | Events                                                                 |
|--------------|------------------------------------------------------------------------|
| App Lifecycle | `app_start`, `config_loaded`, `workflow_started/finished/failed`       |
| Browser       | `browser_launch`, `page_open`, `navigation_success/timeout`, `page_closed` |
| Selector      | `selector_detected/missing`, `selector_fill_attempt/success/failed`    |
| VPN           | `vpn_detected`, `vpn_connect_attempt/connected/failed`, `vpn_location_switched/disconnect` |
| Network       | `ip_check_started/success`, `ip_change_detected/failed`               |
| CAPTCHA       | `captcha_detected`, `captcha_screenshot_saved`, `workflow_paused`      |
| Retry         | `retry_started`, `retry_attempt_number`, `retry_success/failed`        |

## License

MIT
