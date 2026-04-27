"""Bundled Chromium manager for FormFlow Desktop Pro.

Downloads, embeds, and launches a custom Chromium build with critical
automation-detection flags disabled. The bundled browser ships with the
app so no external browser installation is required.

Custom launch flags disable:
- Automation detection (navigator.webdriver)
- AutomationControlled info bar
- Security sandbox (for testing environments)
- Background networking/updates
- Extension safety checks
- CORS restrictions (for testing)
"""

import json
import os
import platform
import shutil
import stat
import sys
import zipfile
from typing import Any, Dict, List, Optional

import aiohttp

from utils.helpers import ensure_dir, get_app_root


CHROMIUM_DOWNLOAD_URLS = {
    "win64": (
        "https://storage.googleapis.com/chromium-browser-snapshots/"
        "Win_x64/{revision}/chrome-win.zip"
    ),
    "win32": (
        "https://storage.googleapis.com/chromium-browser-snapshots/"
        "Win/{revision}/chrome-win.zip"
    ),
    "linux64": (
        "https://storage.googleapis.com/chromium-browser-snapshots/"
        "Linux_x64/{revision}/chrome-linux.zip"
    ),
    "mac": (
        "https://storage.googleapis.com/chromium-browser-snapshots/"
        "Mac/{revision}/chrome-mac.zip"
    ),
    "mac_arm": (
        "https://storage.googleapis.com/chromium-browser-snapshots/"
        "Mac_Arm/{revision}/chrome-mac.zip"
    ),
}

LAST_KNOWN_GOOD_URL = (
    "https://chromiumdash.appspot.com/fetch/milestones"
)

DEFAULT_REVISION = "1300313"

STEALTH_LAUNCH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-extensions-except=",
    "--disable-features=TranslateUI",
    "--disable-hang-monitor",
    "--disable-ipc-flooding-protection",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--disable-web-security",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--password-store=basic",
    "--use-mock-keychain",
    "--ignore-certificate-errors",
    "--allow-running-insecure-content",
    "--disable-features=IsolateOrigins,site-per-process",
    "--flag-switches-begin",
    "--flag-switches-end",
    "--enable-features=NetworkService,NetworkServiceInProcess",
]

STEALTH_JS_INIT = """
// Remove webdriver flag
Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
});

// Override navigator.plugins
Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5],
});

// Override navigator.languages
Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
});

// Override chrome.runtime to prevent detection
window.chrome = {
    runtime: {},
    loadTimes: function() {},
    csi: function() {},
    app: {},
};

// Override permissions query
const originalQuery = window.navigator.permissions.query;
window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
);
"""


class ChromiumManager:
    """Manages the bundled custom Chromium browser.

    Handles downloading, extracting, and launching Chromium with
    stealth flags that disable automation detection features.
    """

    def __init__(
        self,
        browser_dir: Optional[str] = None,
        revision: Optional[str] = None,
        debug_logger: Optional[object] = None,
    ):
        self._browser_dir = browser_dir or os.path.join(
            get_app_root(), "browser"
        )
        self._revision = revision or DEFAULT_REVISION
        self._logger = debug_logger
        self._executable_path: Optional[str] = None

    @property
    def executable_path(self) -> Optional[str]:
        """Return the path to the Chromium executable, if available."""
        if self._executable_path and os.path.isfile(self._executable_path):
            return self._executable_path

        exe = self._find_executable()
        if exe:
            self._executable_path = exe
        return self._executable_path

    @property
    def is_installed(self) -> bool:
        """Check whether the bundled Chromium is already downloaded."""
        return self.executable_path is not None

    @staticmethod
    def get_stealth_args() -> List[str]:
        """Return the full list of stealth launch arguments."""
        return list(STEALTH_LAUNCH_ARGS)

    @staticmethod
    def get_stealth_init_script() -> str:
        """Return the JavaScript init script for stealth mode."""
        return STEALTH_JS_INIT

    def get_playwright_launch_options(
        self,
        extra_args: Optional[List[str]] = None,
        headless: bool = False,
    ) -> Dict[str, Any]:
        """Build Playwright-compatible launch options using the bundled browser.

        Args:
            extra_args: Additional CLI flags to append.
            headless: Whether to run headless.

        Returns:
            Dictionary of launch options for Playwright.
        """
        args = self.get_stealth_args()
        if extra_args:
            args.extend(extra_args)

        options: Dict[str, Any] = {
            "headless": headless,
            "args": args,
            "ignore_default_args": [
                "--enable-automation",
                "--enable-blink-features=IdleDetection",
            ],
        }

        if self.executable_path:
            options["executable_path"] = self.executable_path

        return options

    def get_persistent_context_options(
        self,
        profile_path: str,
        context_overrides: Optional[Dict[str, Any]] = None,
        extra_args: Optional[List[str]] = None,
        headless: bool = False,
    ) -> Dict[str, Any]:
        """Build Playwright persistent context options with stealth flags.

        Args:
            profile_path: Path to the browser profile directory.
            context_overrides: Playwright context options (viewport, locale, etc).
            extra_args: Additional CLI flags.
            headless: Whether to run headless.

        Returns:
            Merged options dict for launch_persistent_context().
        """
        launch = self.get_playwright_launch_options(extra_args, headless)
        options: Dict[str, Any] = {
            "headless": launch["headless"],
            "args": launch["args"],
            "ignore_default_args": launch["ignore_default_args"],
        }

        if "executable_path" in launch:
            options["executable_path"] = launch["executable_path"]

        if context_overrides:
            options.update(context_overrides)

        return options

    async def download(
        self,
        progress_callback: Optional[callable] = None,
    ) -> str:
        """Download Chromium to the bundled browser directory.

        Args:
            progress_callback: Optional callable(downloaded_bytes, total_bytes).

        Returns:
            Path to the Chromium executable.
        """
        ensure_dir(self._browser_dir)
        platform_key = self._detect_platform()
        url_template = CHROMIUM_DOWNLOAD_URLS.get(platform_key)

        if not url_template:
            raise RuntimeError(
                f"Unsupported platform: {platform_key}. "
                f"Supported: {list(CHROMIUM_DOWNLOAD_URLS.keys())}"
            )

        url = url_template.format(revision=self._revision)
        zip_path = os.path.join(self._browser_dir, "chromium.zip")

        self._log("browser_download_started", details={"url": url})

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url) as resp:
                    if resp.status != 200:
                        raise RuntimeError(
                            f"Download failed: HTTP {resp.status} from {url}"
                        )

                    total = int(resp.headers.get("Content-Length", 0))
                    downloaded = 0

                    with open(zip_path, "wb") as f:
                        async for chunk in resp.content.iter_chunked(1024 * 256):
                            f.write(chunk)
                            downloaded += len(chunk)
                            if progress_callback:
                                progress_callback(downloaded, total)

            self._log("browser_download_complete", details={"size_bytes": downloaded})

            exe_path = self._extract(zip_path)
            self._executable_path = exe_path

            try:
                os.remove(zip_path)
            except OSError:
                pass

            return exe_path

        except Exception as e:
            self._log("browser_download_failed", error_message=str(e))
            raise

    def _extract(self, zip_path: str) -> str:
        """Extract the downloaded Chromium zip and return the exe path."""
        extract_dir = os.path.join(self._browser_dir, "chromium")

        if os.path.isdir(extract_dir):
            shutil.rmtree(extract_dir, ignore_errors=True)

        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(extract_dir)

        exe = self._find_executable_in(extract_dir)
        if not exe:
            raise RuntimeError(f"Chromium executable not found in {extract_dir}")

        if platform.system() != "Windows":
            os.chmod(exe, os.stat(exe).st_mode | stat.S_IEXEC)

        self._log("browser_extracted", details={"path": exe})
        return exe

    def _find_executable(self) -> Optional[str]:
        """Search for the Chromium executable in the browser directory."""
        chromium_dir = os.path.join(self._browser_dir, "chromium")
        if os.path.isdir(chromium_dir):
            return self._find_executable_in(chromium_dir)
        return None

    @staticmethod
    def _find_executable_in(directory: str) -> Optional[str]:
        """Recursively find a Chromium/Chrome executable in a directory."""
        exe_names = {
            "Windows": ["chrome.exe", "chromium.exe"],
            "Linux": ["chrome", "chromium", "chromium-browser"],
            "Darwin": [
                "Chromium.app/Contents/MacOS/Chromium",
                "Google Chrome.app/Contents/MacOS/Google Chrome",
                "chrome",
            ],
        }

        system = platform.system()
        names = exe_names.get(system, ["chrome", "chromium"])

        for root, dirs, files in os.walk(directory):
            for name in names:
                candidate = os.path.join(root, name)
                if os.path.isfile(candidate):
                    return candidate

        return None

    @staticmethod
    def _detect_platform() -> str:
        """Detect the current platform for download URL selection."""
        system = platform.system()
        machine = platform.machine().lower()

        if system == "Windows":
            return "win64" if "64" in machine or "amd64" in machine else "win32"
        elif system == "Linux":
            return "linux64"
        elif system == "Darwin":
            return "mac_arm" if "arm" in machine else "mac"
        else:
            return "linux64"

    def get_browser_info(self) -> Dict[str, Any]:
        """Return information about the bundled browser."""
        return {
            "installed": self.is_installed,
            "executable_path": self.executable_path,
            "browser_dir": self._browser_dir,
            "revision": self._revision,
            "platform": self._detect_platform(),
            "stealth_args_count": len(STEALTH_LAUNCH_ARGS),
        }

    def _log(self, event: str, **kwargs: Any) -> None:
        """Log a browser management event."""
        if self._logger:
            from debug.debug_logger import EventType
            event_map = {
                "browser_download_started": EventType.BROWSER_LAUNCH,
                "browser_download_complete": EventType.BROWSER_LAUNCH,
                "browser_download_failed": EventType.BROWSER_LAUNCH,
                "browser_extracted": EventType.BROWSER_LAUNCH,
            }
            event_type = event_map.get(event, EventType.BROWSER_LAUNCH)
            status = "failed" if "failed" in event else "success"
            self._logger.log(event_type, status=status, **kwargs)
