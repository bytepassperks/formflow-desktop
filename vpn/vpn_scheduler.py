"""VPN rotation scheduler for FormFlow Desktop Pro.

Manages VPN location rotation across workflow executions
using round-robin scheduling with configurable location queues.
"""

import asyncio
from collections import deque
from typing import Deque, List, Optional

from vpn.vpn_controller import VPNController
from vpn.vpn_detector import VPNClientInfo, VPNDetector


class VPNScheduler:
    """Schedules VPN connections and rotations for workflow runs.

    Execution pipeline:
        1. Connect VPN
        2. Verify IP change
        3. Start workflow
        4. Switch location
        5. Repeat
    """

    def __init__(
        self,
        timeout_seconds: int = 20,
        debug_logger: Optional[object] = None,
    ):
        self._timeout = timeout_seconds
        self._logger = debug_logger
        self._detector = VPNDetector()
        self._controller: Optional[VPNController] = None
        self._location_queue: Deque[str] = deque()
        self._active_client: Optional[VPNClientInfo] = None

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
                    },
                )
        return clients

    def set_active_client(self, client_name: str) -> bool:
        """Set the active VPN client by name.

        Returns:
            True if client was found and activated.
        """
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

    async def connect_next(self) -> bool:
        """Connect to the next VPN location in the rotation queue.

        Returns:
            True if successfully connected.
        """
        if not self._controller or not self._location_queue:
            return False

        location = self._location_queue[0]
        self._location_queue.rotate(-1)

        return await self._controller.connect(location)

    async def disconnect(self) -> bool:
        """Disconnect the current VPN connection."""
        if not self._controller:
            return False
        return await self._controller.disconnect()

    async def rotate(self) -> Optional[str]:
        """Rotate to the next VPN location.

        Returns:
            New location name, or None on failure.
        """
        if not self._controller:
            return None
        return await self._controller.switch_next_location()

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
