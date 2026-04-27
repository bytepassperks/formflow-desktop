"""VPN controller module for FormFlow Desktop Pro.

Controls VPN connection, disconnection, and location switching
via installed VPN client CLIs (NordVPN, Surfshark, ExpressVPN).
"""

import asyncio
import json
from typing import Any, Dict, List, Optional

import aiohttp

from vpn.vpn_detector import VPNClientInfo


VPN_CLI_COMMANDS = {
    "NordVPN": {
        "connect": "nordvpn connect {location}",
        "disconnect": "nordvpn disconnect",
        "status": "nordvpn status",
        "locations": [
            "United_States", "United_Kingdom", "Germany", "France",
            "Netherlands", "Canada", "Australia", "Japan", "Singapore",
            "Switzerland", "Sweden", "Brazil", "India",
        ],
    },
    "Surfshark": {
        "connect": "surfshark-cli attack --location {location}",
        "disconnect": "surfshark-cli down",
        "status": "surfshark-cli status",
        "locations": [
            "us-nyc", "uk-lon", "de-fra", "fr-par",
            "nl-ams", "ca-tor", "au-syd", "jp-tok", "sg-sgp",
            "ch-zur", "se-sto", "br-sao", "in-idr",
        ],
    },
    "ExpressVPN": {
        "connect": "expressvpn connect {location}",
        "disconnect": "expressvpn disconnect",
        "status": "expressvpn status",
        "locations": [
            "usny", "uklo", "defr", "frpa",
            "nlam", "cato", "ausy", "jpto", "sgju",
            "chzu", "sest", "brsp", "inmu",
        ],
    },
}

IP_CHECK_URLS = [
    "https://api.ipify.org?format=json",
    "https://httpbin.org/ip",
]


class VPNController:
    """Controls VPN client operations for workflow execution."""

    def __init__(
        self,
        client_info: VPNClientInfo,
        timeout_seconds: int = 20,
        debug_logger: Optional[object] = None,
    ):
        self._client = client_info
        self._timeout = timeout_seconds
        self._logger = debug_logger
        self._current_location: Optional[str] = None
        self._location_index: int = 0
        self._original_ip: Optional[str] = None
        self._commands = VPN_CLI_COMMANDS.get(client_info.name, {})

    async def connect(self, location: Optional[str] = None) -> bool:
        """Connect to VPN at specified or next available location.

        Args:
            location: Specific location to connect to, or None for next in rotation.

        Returns:
            True if connection succeeded and IP changed.
        """
        self._log("vpn_connect_attempt", vpn_location=location)

        if not self._original_ip:
            self._original_ip = await self._get_public_ip()

        locations = self._commands.get("locations", [])
        if not location and locations:
            location = locations[self._location_index % len(locations)]
            self._location_index += 1

        connect_cmd = self._commands.get("connect", "").format(location=location or "")
        if not connect_cmd:
            self._log("vpn_connection_failed", error_message="No connect command")
            return False

        success = await self._run_cli_command(connect_cmd)
        if not success:
            self._log("vpn_connection_failed", vpn_location=location)
            return False

        ip_changed = await self._verify_ip_change()
        if ip_changed:
            self._current_location = location
            self._log("vpn_connected", vpn_location=location)
            return True
        else:
            self._log("vpn_connection_failed", vpn_location=location,
                       error_message="IP did not change within timeout")
            return False

    async def disconnect(self) -> bool:
        """Disconnect from VPN."""
        disconnect_cmd = self._commands.get("disconnect", "")
        if not disconnect_cmd:
            return False

        success = await self._run_cli_command(disconnect_cmd)
        if success:
            self._current_location = None
            self._log("vpn_disconnect")
        return success

    async def switch_next_location(self) -> Optional[str]:
        """Switch to the next VPN location in rotation.

        Returns:
            Name of the new location, or None on failure.
        """
        locations = self._commands.get("locations", [])
        if not locations:
            return None

        next_location = locations[self._location_index % len(locations)]
        self._location_index += 1

        self._log("vpn_location_switched", vpn_location=next_location)

        await self.disconnect()
        success = await self.connect(next_location)

        return next_location if success else None

    def get_current_location(self) -> Optional[str]:
        """Return the current VPN location."""
        return self._current_location

    def get_available_locations(self) -> List[str]:
        """Return list of available VPN locations for the client."""
        return self._commands.get("locations", [])

    async def _verify_ip_change(self) -> bool:
        """Wait for IP to change, abort if unchanged after timeout."""
        elapsed = 0
        check_interval = 2

        while elapsed < self._timeout:
            current_ip = await self._get_public_ip()
            if current_ip and current_ip != self._original_ip:
                self._log(
                    "ip_change_detected",
                    ip_address=current_ip,
                    details={"original_ip": self._original_ip},
                )
                return True
            await asyncio.sleep(check_interval)
            elapsed += check_interval

        self._log("ip_change_failed")
        return False

    async def _get_public_ip(self) -> Optional[str]:
        """Fetch current public IP address."""
        self._log("ip_check_started")
        for url in IP_CHECK_URLS:
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                        if resp.status == 200:
                            text = await resp.text()
                            try:
                                data = json.loads(text)
                                ip = data.get("ip") or data.get("origin", "").split(",")[0].strip()
                            except json.JSONDecodeError:
                                ip = text.strip()
                            self._log("ip_check_success", ip_address=ip)
                            return ip
            except Exception:
                continue
        return None

    async def _run_cli_command(self, command: str) -> bool:
        """Execute a VPN CLI command."""
        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=self._timeout)
            return proc.returncode == 0
        except (asyncio.TimeoutError, OSError):
            return False

    def _log(self, event: str, **kwargs: Any) -> None:
        """Log a VPN event via the debug logger."""
        if self._logger:
            from debug.debug_logger import EventType

            event_map = {
                "vpn_connect_attempt": EventType.VPN_CONNECT_ATTEMPT,
                "vpn_connected": EventType.VPN_CONNECTED,
                "vpn_connection_failed": EventType.VPN_CONNECTION_FAILED,
                "vpn_location_switched": EventType.VPN_LOCATION_SWITCHED,
                "vpn_disconnect": EventType.VPN_DISCONNECT,
                "ip_check_started": EventType.IP_CHECK_STARTED,
                "ip_check_success": EventType.IP_CHECK_SUCCESS,
                "ip_change_detected": EventType.IP_CHANGE_DETECTED,
                "ip_change_failed": EventType.IP_CHANGE_FAILED,
            }
            event_type = event_map.get(event)
            if event_type:
                status = "failed" if "failed" in event else "success"
                self._logger.log(event_type, status=status, **kwargs)
