"""VPN rotation scheduler for FormFlow Desktop Pro.

Manages VPN location rotation across workflow executions
using round-robin scheduling with configurable location queues.

Supports:
- Auto-connect on workflow start
- Auto-rotate between workflow runs
- Configurable rotation strategies (round_robin, random, sequential)
"""

import asyncio
import random
from collections import deque
from enum import Enum
from typing import Deque, List, Optional

from vpn.vpn_controller import VPNController
from vpn.vpn_detector import VPNClientInfo, VPNDetector


class RotationStrategy(str, Enum):
    """VPN location rotation strategy."""
    ROUND_ROBIN = "round_robin"
    RANDOM = "random"
    SEQUENTIAL = "sequential"


class VPNScheduler:
    """Schedules VPN connections and rotations for workflow runs.

    Execution pipeline:
        1. Auto-detect VPN client
        2. Auto-connect VPN on workflow start
        3. Verify IP change
        4. Start workflow
        5. Auto-rotate location after workflow
        6. Repeat

    Supports automatic connection and rotation without manual intervention.
    """

    def __init__(
        self,
        timeout_seconds: int = 20,
        debug_logger: Optional[object] = None,
        auto_connect: bool = True,
        auto_rotate: bool = True,
        rotation_strategy: RotationStrategy = RotationStrategy.ROUND_ROBIN,
    ):
        self._timeout = timeout_seconds
        self._logger = debug_logger
        self._auto_connect = auto_connect
        self._auto_rotate = auto_rotate
        self._rotation_strategy = rotation_strategy
        self._detector = VPNDetector()
        self._controller: Optional[VPNController] = None
        self._location_queue: Deque[str] = deque()
        self._active_client: Optional[VPNClientInfo] = None
        self._connected = False
        self._workflows_since_rotate = 0
        self._rotate_every_n = 1  # rotate after every N workflows

    def detect_clients(self) -> List[VPNClientInfo]:
        """Scan for installed VPN clients and return those found."""
        clients = self._detector.get_installed_clients()
        if clients:
            self._active_client = clients[0]
            self._controller = VPNController(
                self._active_client,
                timeout_seconds=self._timeout,
                debug_logger=self._logger,
            )
            self._location_queue = deque(self._controller.get_available_locations())

            if self._logger:
                from debug.debug_logger import EventType
                self._logger.log(
                    EventType.VPN_DETECTED,
                    status="success",
                    details={
                        "client": self._active_client.name,
                        "locations_available": len(self._location_queue),
                        "auto_connect": self._auto_connect,
                        "auto_rotate": self._auto_rotate,
                    },
                )
        return clients

    def set_active_client(self, client_name: str) -> bool:
        """Set the active VPN client by name."""
        client = self._detector.get_client(client_name)
        if client and client.installed:
            self._active_client = client
            self._controller = VPNController(
                client,
                timeout_seconds=self._timeout,
                debug_logger=self._logger,
            )
            self._location_queue = deque(self._controller.get_available_locations())
            return True
        return False

    def set_location_queue(self, locations: List[str]) -> None:
        """Override the location rotation queue."""
        self._location_queue = deque(locations)

    def set_auto_connect(self, enabled: bool) -> None:
        """Enable or disable auto-connect on workflow start."""
        self._auto_connect = enabled

    def set_auto_rotate(self, enabled: bool) -> None:
        """Enable or disable auto-rotate between workflows."""
        self._auto_rotate = enabled

    def set_rotation_strategy(self, strategy: RotationStrategy) -> None:
        """Set the VPN location rotation strategy."""
        self._rotation_strategy = strategy

    def set_rotate_every_n(self, n: int) -> None:
        """Set how often to rotate (every N workflows)."""
        self._rotate_every_n = max(1, n)

    async def auto_connect_if_enabled(self) -> bool:
        """Auto-connect to VPN if auto_connect is enabled.

        Called automatically before workflow execution starts.

        Returns:
            True if connected (or already connected), False on failure.
        """
        if not self._auto_connect:
            return True  # no-op, considered success

        if self._connected:
            return True

        if not self._controller or not self._location_queue:
            return False

        location = self._pick_next_location()
        if not location:
            return False

        success = await self._controller.connect(location)
        self._connected = success
        return success

    async def auto_rotate_if_needed(self) -> Optional[str]:
        """Auto-rotate VPN location if auto_rotate is enabled.

        Called automatically after each workflow completes. Rotates
        based on rotate_every_n setting.

        Returns:
            New location name if rotated, None otherwise.
        """
        if not self._auto_rotate:
            return None

        if not self._controller or not self._location_queue:
            return None

        self._workflows_since_rotate += 1

        if self._workflows_since_rotate < self._rotate_every_n:
            return None

        self._workflows_since_rotate = 0
        return await self.rotate()

    async def connect_next(self) -> bool:
        """Connect to the next VPN location in the rotation queue."""
        if not self._controller or not self._location_queue:
            return False

        location = self._pick_next_location()
        if not location:
            return False

        success = await self._controller.connect(location)
        self._connected = success
        return success

    async def disconnect(self) -> bool:
        """Disconnect the current VPN connection."""
        if not self._controller:
            return False
        success = await self._controller.disconnect()
        if success:
            self._connected = False
        return success

    async def rotate(self) -> Optional[str]:
        """Rotate to the next VPN location.

        Returns:
            New location name, or None on failure.
        """
        if not self._controller:
            return None

        await self.disconnect()

        location = self._pick_next_location()
        if not location:
            return None

        success = await self._controller.connect(location)
        self._connected = success
        return location if success else None

    async def ensure_connected(self) -> bool:
        """Ensure VPN is connected, reconnecting if necessary.

        Returns:
            True if currently connected.
        """
        if self._connected:
            return True
        return await self.auto_connect_if_enabled()

    def _pick_next_location(self) -> Optional[str]:
        """Pick the next location based on the rotation strategy."""
        if not self._location_queue:
            return None

        if self._rotation_strategy == RotationStrategy.ROUND_ROBIN:
            location = self._location_queue[0]
            self._location_queue.rotate(-1)
            return location

        elif self._rotation_strategy == RotationStrategy.RANDOM:
            locations = list(self._location_queue)
            return random.choice(locations) if locations else None

        elif self._rotation_strategy == RotationStrategy.SEQUENTIAL:
            return self._location_queue[0]

        return None

    def get_current_location(self) -> Optional[str]:
        """Return the current VPN location."""
        if not self._controller:
            return None
        return self._controller.get_current_location()

    def get_queue_state(self) -> List[str]:
        """Return the current state of the location rotation queue."""
        return list(self._location_queue)

    def get_active_client_name(self) -> Optional[str]:
        """Return the name of the active VPN client."""
        return self._active_client.name if self._active_client else None

    def has_vpn(self) -> bool:
        """Check if a VPN client is available."""
        return self._controller is not None

    def is_connected(self) -> bool:
        """Check if VPN is currently connected."""
        return self._connected

    def get_settings(self) -> dict:
        """Return current VPN scheduler settings."""
        return {
            "auto_connect": self._auto_connect,
            "auto_rotate": self._auto_rotate,
            "rotation_strategy": self._rotation_strategy.value,
            "rotate_every_n": self._rotate_every_n,
            "connected": self._connected,
            "active_client": self.get_active_client_name(),
            "current_location": self.get_current_location(),
            "queue_size": len(self._location_queue),
        }
