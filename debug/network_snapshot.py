"""Network snapshot debugging module for FormFlow Desktop Pro.

Captures public IP, timezone, user agent, locale, and viewport
and stores the snapshot in logs/network_snapshot.json.
"""

import json
import os
from typing import Any, Dict, Optional

import aiohttp

from utils.helpers import ensure_dir, get_app_root, iso_timestamp


class NetworkSnapshot:
    """Captures and stores network environment snapshots."""

    IP_CHECK_URLS = [
        "https://api.ipify.org?format=json",
        "https://httpbin.org/ip",
        "https://ifconfig.me/ip",
    ]

    def __init__(self, log_dir: Optional[str] = None):
        self._log_dir = log_dir or os.path.join(get_app_root(), "logs")
        ensure_dir(self._log_dir)
        self._snapshot_path = os.path.join(self._log_dir, "network_snapshot.json")
        self._snapshots: list = []

    async def capture(
        self,
        timezone: Optional[str] = None,
        locale: Optional[str] = None,
        user_agent: Optional[str] = None,
        viewport: Optional[list] = None,
    ) -> Dict[str, Any]:
        """Capture a complete network environment snapshot.

        Args:
            timezone: Current browser timezone.
            locale: Current browser locale.
            user_agent: Current user agent string.
            viewport: Current viewport dimensions [width, height].

        Returns:
            Snapshot dictionary with all captured data.
        """
        ip_address = await self._get_public_ip()

        snapshot: Dict[str, Any] = {
            "timestamp": iso_timestamp(),
            "ip": ip_address or "unknown",
            "timezone": timezone or "unknown",
            "locale": locale or "unknown",
            "user_agent": user_agent or "unknown",
            "viewport": viewport or [0, 0],
        }

        self._snapshots.append(snapshot)
        self._save_to_file()
        return snapshot

    async def get_public_ip(self) -> Optional[str]:
        """Get the current public IP address."""
        return await self._get_public_ip()

    async def _get_public_ip(self) -> Optional[str]:
        """Attempt to get the public IP from multiple services."""
        for url in self.IP_CHECK_URLS:
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                        if resp.status == 200:
                            text = await resp.text()
                            try:
                                data = json.loads(text)
                                return data.get("ip") or data.get("origin", "").split(",")[0].strip()
                            except json.JSONDecodeError:
                                return text.strip()
            except Exception:
                continue
        return None

    def get_latest_snapshot(self) -> Optional[Dict[str, Any]]:
        """Return the most recent network snapshot."""
        return self._snapshots[-1] if self._snapshots else None

    def get_all_snapshots(self) -> list:
        """Return all captured network snapshots."""
        return list(self._snapshots)

    def get_snapshot_path(self) -> str:
        """Return the path to the snapshot file."""
        return self._snapshot_path

    def _save_to_file(self) -> None:
        """Persist snapshots to disk."""
        try:
            with open(self._snapshot_path, "w", encoding="utf-8") as f:
                json.dump(self._snapshots, f, indent=2)
        except OSError:
            pass
