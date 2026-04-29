"""VPN client auto-detection module for FormFlow Desktop Pro.

Detects installed VPN clients by scanning:
- Program Files directories
- PATH environment variables
- Windows Registry entries

Supported clients: NordVPN, Surfshark, ExpressVPN
"""

import os
import platform
import subprocess
from typing import Dict, List, Optional


class VPNClientInfo:
    """Information about a detected VPN client."""

    def __init__(
        self,
        name: str,
        installed: bool = False,
        exe_path: Optional[str] = None,
        cli_path: Optional[str] = None,
        version: Optional[str] = None,
        detection_method: Optional[str] = None,
    ):
        self.name = name
        self.installed = installed
        self.exe_path = exe_path
        self.cli_path = cli_path
        self.version = version
        self.detection_method = detection_method

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "installed": self.installed,
            "exe_path": self.exe_path,
            "cli_path": self.cli_path,
            "version": self.version,
            "detection_method": self.detection_method,
        }


VPN_DEFINITIONS = {
    "NordVPN": {
        "program_files_paths": [
            r"NordVPN\NordVPN.exe",
            r"NordVPN\nordvpn.exe",
        ],
        "cli_names": ["nordvpn"],
        "cli_paths_win": [
            r"C:\Program Files\NordVPN\nordvpn.exe",
            r"C:\Program Files (x86)\NordVPN\nordvpn.exe",
        ],
        "cli_paths_linux": ["/usr/bin/nordvpn", "/usr/sbin/nordvpn"],
        "registry_keys": [
            r"SOFTWARE\NordVPN",
            r"SOFTWARE\WOW6432Node\NordVPN",
        ],
    },
    "Surfshark": {
        "program_files_paths": [
            r"Surfshark\Surfshark.exe",
        ],
        "cli_names": ["surfshark"],
        "cli_paths_win": [
            r"C:\Program Files\Surfshark\Surfshark.exe",
            r"C:\Program Files (x86)\Surfshark\Surfshark.exe",
        ],
        "cli_paths_linux": ["/usr/bin/surfshark"],
        "registry_keys": [
            r"SOFTWARE\Surfshark",
        ],
    },
    "ExpressVPN": {
        "program_files_paths": [
            r"ExpressVPN\expressvpn.exe",
            r"ExpressVPN\ExpressVPN.exe",
        ],
        "cli_names": ["expressvpn"],
        "cli_paths_win": [
            r"C:\Program Files\ExpressVPN\expressvpn.exe",
            r"C:\Program Files (x86)\ExpressVPN\expressvpn.exe",
        ],
        "cli_paths_linux": ["/usr/bin/expressvpn", "/usr/sbin/expressvpn"],
        "registry_keys": [
            r"SOFTWARE\ExpressVPN",
            r"SOFTWARE\WOW6432Node\ExpressVPN",
        ],
    },
}


class VPNDetector:
    """Detects installed VPN clients on the system."""

    def __init__(self) -> None:
        self._is_windows = platform.system() == "Windows"
        self._detected_clients: Dict[str, VPNClientInfo] = {}

    def scan_all(self) -> Dict[str, VPNClientInfo]:
        """Scan for all supported VPN clients.

        Returns:
            Dictionary mapping VPN name to VPNClientInfo.
        """
        for vpn_name, definition in VPN_DEFINITIONS.items():
            info = self._detect_client(vpn_name, definition)
            self._detected_clients[vpn_name] = info
        return self._detected_clients

    def get_installed_clients(self) -> List[VPNClientInfo]:
        """Return list of VPN clients that are installed."""
        if not self._detected_clients:
            self.scan_all()
        return [c for c in self._detected_clients.values() if c.installed]

    def get_client(self, name: str) -> Optional[VPNClientInfo]:
        """Get info about a specific VPN client."""
        if not self._detected_clients:
            self.scan_all()
        return self._detected_clients.get(name)

    def _detect_client(self, name: str, definition: dict) -> VPNClientInfo:
        """Attempt to detect a single VPN client using multiple methods."""
        result = self._check_path_variable(name, definition)
        if result and result.installed:
            return result

        result = self._check_program_files(name, definition)
        if result and result.installed:
            return result

        result = self._check_known_paths(name, definition)
        if result and result.installed:
            return result

        if self._is_windows:
            result = self._check_registry(name, definition)
            if result and result.installed:
                return result

        return VPNClientInfo(name=name, installed=False)

    def _check_path_variable(self, name: str, definition: dict) -> Optional[VPNClientInfo]:
        """Check if the VPN CLI is available in PATH."""
        for cli_name in definition.get("cli_names", []):
            try:
                cmd = "where" if self._is_windows else "which"
                result = subprocess.run(
                    [cmd, cli_name],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                if result.returncode == 0:
                    cli_path = result.stdout.strip().split("\n")[0]
                    return VPNClientInfo(
                        name=name,
                        installed=True,
                        cli_path=cli_path,
                        detection_method="PATH",
                    )
            except (subprocess.SubprocessError, FileNotFoundError):
                continue
        return None

    def _check_program_files(self, name: str, definition: dict) -> Optional[VPNClientInfo]:
        """Check Program Files directories for VPN executables."""
        if not self._is_windows:
            return None

        program_dirs = [
            os.environ.get("ProgramFiles", r"C:\Program Files"),
            os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
        ]

        for base_dir in program_dirs:
            for rel_path in definition.get("program_files_paths", []):
                full_path = os.path.join(base_dir, rel_path)
                if os.path.isfile(full_path):
                    return VPNClientInfo(
                        name=name,
                        installed=True,
                        exe_path=full_path,
                        detection_method="Program Files",
                    )
        return None

    def _check_known_paths(self, name: str, definition: dict) -> Optional[VPNClientInfo]:
        """Check known installation paths."""
        key = "cli_paths_win" if self._is_windows else "cli_paths_linux"
        for path in definition.get(key, []):
            if os.path.isfile(path):
                return VPNClientInfo(
                    name=name,
                    installed=True,
                    cli_path=path,
                    detection_method="known_path",
                )
        return None

    def _check_registry(self, name: str, definition: dict) -> Optional[VPNClientInfo]:
        """Check Windows registry for VPN installation entries."""
        if not self._is_windows:
            return None
        try:
            import winreg

            for reg_key in definition.get("registry_keys", []):
                try:
                    key = winreg.OpenKey(
                        winreg.HKEY_LOCAL_MACHINE, reg_key, 0, winreg.KEY_READ
                    )
                    winreg.CloseKey(key)
                    return VPNClientInfo(
                        name=name,
                        installed=True,
                        detection_method="registry",
                    )
                except FileNotFoundError:
                    continue
        except ImportError:
            pass
        return None
