"""Common utility functions for FormFlow Desktop Pro."""

import os
import re
import subprocess
import sys
from datetime import datetime
from typing import Optional


def get_app_root() -> str:
    """Get the application root directory."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def ensure_dir(path: str) -> str:
    """Ensure a directory exists, creating it if necessary."""
    os.makedirs(path, exist_ok=True)
    return path


def timestamp_str() -> str:
    """Return a formatted timestamp string for filenames."""
    return datetime.now().strftime("%Y_%m_%d_%H%M%S")


def iso_timestamp() -> str:
    """Return an ISO-format timestamp string."""
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def sanitize_filename(name: str) -> str:
    """Sanitize a string for use as a filename."""
    return re.sub(r'[<>:"/\\|?*]', "_", name)


def is_windows() -> bool:
    """Check if the current platform is Windows."""
    return sys.platform.startswith("win")


def run_command(cmd: str, timeout: int = 30) -> Optional[str]:
    """Run a shell command and return output, or None on failure."""
    try:
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return result.stdout.strip() if result.returncode == 0 else None
    except (subprocess.TimeoutExpired, subprocess.SubprocessError):
        return None


def format_duration(seconds: float) -> str:
    """Format a duration in seconds to a human-readable string."""
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes = int(seconds // 60)
    secs = seconds % 60
    if minutes < 60:
        return f"{minutes}m {secs:.0f}s"
    hours = minutes // 60
    mins = minutes % 60
    return f"{hours}h {mins}m {secs:.0f}s"
