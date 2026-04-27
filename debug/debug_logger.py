"""Structured debug logger for FormFlow Desktop Pro.

Captures ALL telemetry events as structured JSON for troubleshooting.
This is the most critical module for Devin troubleshooting.
"""

import json
import logging
import os
import threading
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Dict, List, Optional

from utils.helpers import ensure_dir, get_app_root, iso_timestamp


class EventCategory(str, Enum):
    """Categories for debug events."""

    APP_LIFECYCLE = "app_lifecycle"
    BROWSER = "browser"
    SELECTOR = "selector"
    VPN = "vpn"
    NETWORK = "network"
    CAPTCHA = "captcha"
    RETRY = "retry"
    WORKFLOW = "workflow"


class EventType(str, Enum):
    """All captured debug event types."""

    # App Lifecycle Events
    APP_START = "app_start"
    CONFIG_LOADED = "config_loaded"
    WORKFLOW_STARTED = "workflow_started"
    WORKFLOW_FINISHED = "workflow_finished"
    WORKFLOW_FAILED = "workflow_failed"

    # Browser Events
    BROWSER_LAUNCH = "browser_launch"
    PAGE_OPEN = "page_open"
    NAVIGATION_SUCCESS = "navigation_success"
    NAVIGATION_TIMEOUT = "navigation_timeout"
    PAGE_CLOSED = "page_closed"

    # Selector Events
    SELECTOR_DETECTED = "selector_detected"
    SELECTOR_MISSING = "selector_missing"
    SELECTOR_FILL_ATTEMPT = "selector_fill_attempt"
    SELECTOR_FILL_SUCCESS = "selector_fill_success"
    SELECTOR_FILL_FAILED = "selector_fill_failed"

    # VPN Events
    VPN_DETECTED = "vpn_detected"
    VPN_CONNECT_ATTEMPT = "vpn_connect_attempt"
    VPN_CONNECTED = "vpn_connected"
    VPN_CONNECTION_FAILED = "vpn_connection_failed"
    VPN_LOCATION_SWITCHED = "vpn_location_switched"
    VPN_DISCONNECT = "vpn_disconnect"

    # Network Events
    IP_CHECK_STARTED = "ip_check_started"
    IP_CHECK_SUCCESS = "ip_check_success"
    IP_CHANGE_DETECTED = "ip_change_detected"
    IP_CHANGE_FAILED = "ip_change_failed"

    # CAPTCHA Events
    CAPTCHA_DETECTED = "captcha_detected"
    CAPTCHA_SCREENSHOT_SAVED = "captcha_screenshot_saved"
    WORKFLOW_PAUSED = "workflow_paused"

    # Retry Events
    RETRY_STARTED = "retry_started"
    RETRY_ATTEMPT_NUMBER = "retry_attempt_number"
    RETRY_SUCCESS = "retry_success"
    RETRY_FAILED = "retry_failed"


EVENT_CATEGORY_MAP: Dict[EventType, EventCategory] = {
    EventType.APP_START: EventCategory.APP_LIFECYCLE,
    EventType.CONFIG_LOADED: EventCategory.APP_LIFECYCLE,
    EventType.WORKFLOW_STARTED: EventCategory.WORKFLOW,
    EventType.WORKFLOW_FINISHED: EventCategory.WORKFLOW,
    EventType.WORKFLOW_FAILED: EventCategory.WORKFLOW,
    EventType.BROWSER_LAUNCH: EventCategory.BROWSER,
    EventType.PAGE_OPEN: EventCategory.BROWSER,
    EventType.NAVIGATION_SUCCESS: EventCategory.BROWSER,
    EventType.NAVIGATION_TIMEOUT: EventCategory.BROWSER,
    EventType.PAGE_CLOSED: EventCategory.BROWSER,
    EventType.SELECTOR_DETECTED: EventCategory.SELECTOR,
    EventType.SELECTOR_MISSING: EventCategory.SELECTOR,
    EventType.SELECTOR_FILL_ATTEMPT: EventCategory.SELECTOR,
    EventType.SELECTOR_FILL_SUCCESS: EventCategory.SELECTOR,
    EventType.SELECTOR_FILL_FAILED: EventCategory.SELECTOR,
    EventType.VPN_DETECTED: EventCategory.VPN,
    EventType.VPN_CONNECT_ATTEMPT: EventCategory.VPN,
    EventType.VPN_CONNECTED: EventCategory.VPN,
    EventType.VPN_CONNECTION_FAILED: EventCategory.VPN,
    EventType.VPN_LOCATION_SWITCHED: EventCategory.VPN,
    EventType.VPN_DISCONNECT: EventCategory.VPN,
    EventType.IP_CHECK_STARTED: EventCategory.NETWORK,
    EventType.IP_CHECK_SUCCESS: EventCategory.NETWORK,
    EventType.IP_CHANGE_DETECTED: EventCategory.NETWORK,
    EventType.IP_CHANGE_FAILED: EventCategory.NETWORK,
    EventType.CAPTCHA_DETECTED: EventCategory.CAPTCHA,
    EventType.CAPTCHA_SCREENSHOT_SAVED: EventCategory.CAPTCHA,
    EventType.WORKFLOW_PAUSED: EventCategory.CAPTCHA,
    EventType.RETRY_STARTED: EventCategory.RETRY,
    EventType.RETRY_ATTEMPT_NUMBER: EventCategory.RETRY,
    EventType.RETRY_SUCCESS: EventCategory.RETRY,
    EventType.RETRY_FAILED: EventCategory.RETRY,
}


class DebugLogger:
    """Structured JSON telemetry logger.

    Captures all debug events and writes them to logs/debug_session.json.
    Also maintains an in-memory event buffer for the UI debug panel.
    """

    def __init__(self, log_dir: Optional[str] = None):
        self._log_dir = log_dir or os.path.join(get_app_root(), "logs")
        ensure_dir(self._log_dir)

        self._session_log_path = os.path.join(self._log_dir, "debug_session.json")
        self._error_log_path = os.path.join(self._log_dir, "errors.log")

        self._events: List[Dict[str, Any]] = []
        self._lock = threading.Lock()
        self._listeners: List[Callable[[Dict[str, Any]], None]] = []

        self._file_logger = logging.getLogger("formflow.errors")
        handler = logging.FileHandler(self._error_log_path, encoding="utf-8")
        handler.setFormatter(
            logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
        )
        self._file_logger.addHandler(handler)
        self._file_logger.setLevel(logging.DEBUG)

    def log(
        self,
        event: EventType,
        status: str = "info",
        selector: Optional[str] = None,
        url: Optional[str] = None,
        profile_id: Optional[str] = None,
        workflow_id: Optional[str] = None,
        vpn_location: Optional[str] = None,
        ip_address: Optional[str] = None,
        retry_number: Optional[int] = None,
        screenshot_path: Optional[str] = None,
        error_message: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Log a structured debug event.

        Args:
            event: The event type to log.
            status: Event status (success, failed, info, warning, error).
            selector: CSS/XPath selector involved.
            url: URL being accessed.
            profile_id: Browser profile identifier.
            workflow_id: Current workflow identifier.
            vpn_location: VPN server location.
            ip_address: Detected IP address.
            retry_number: Current retry attempt number.
            screenshot_path: Path to captured screenshot.
            error_message: Error description if applicable.
            details: Additional key-value details.

        Returns:
            The logged event entry dictionary.
        """
        entry: Dict[str, Any] = {
            "timestamp": iso_timestamp(),
            "event": event.value,
            "category": EVENT_CATEGORY_MAP.get(event, EventCategory.APP_LIFECYCLE).value,
            "status": status,
        }

        if selector:
            entry["selector"] = selector
        if url:
            entry["url"] = url
        if profile_id:
            entry["profile_id"] = profile_id
        if workflow_id:
            entry["workflow_id"] = workflow_id
        if vpn_location:
            entry["vpn_location"] = vpn_location
        if ip_address:
            entry["ip_address"] = ip_address
        if retry_number is not None:
            entry["retry_number"] = retry_number
        if screenshot_path:
            entry["screenshot_path"] = screenshot_path
        if error_message:
            entry["error_message"] = error_message
        if details:
            entry["details"] = details

        with self._lock:
            self._events.append(entry)
            self._write_to_file(entry)

        if status in ("error", "failed"):
            self._file_logger.error(json.dumps(entry))

        self._notify_listeners(entry)
        return entry

    def add_listener(self, callback: Callable[[Dict[str, Any]], None]) -> None:
        """Register a callback for live event streaming (UI debug panel)."""
        self._listeners.append(callback)

    def remove_listener(self, callback: Callable[[Dict[str, Any]], None]) -> None:
        """Remove a registered event listener."""
        self._listeners = [cb for cb in self._listeners if cb is not callback]

    def get_events(
        self,
        category: Optional[EventCategory] = None,
        event_type: Optional[EventType] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """Retrieve logged events, optionally filtered."""
        with self._lock:
            events = list(self._events)
        if category:
            events = [e for e in events if e.get("category") == category.value]
        if event_type:
            events = [e for e in events if e.get("event") == event_type.value]
        return events[-limit:]

    def get_error_summary(self) -> str:
        """Generate a summary of all error events for clipboard/export."""
        with self._lock:
            errors = [
                e for e in self._events if e.get("status") in ("error", "failed")
            ]
        if not errors:
            return "No errors recorded in this session."

        lines = [f"Error Summary — {len(errors)} error(s)\n"]
        for err in errors:
            lines.append(
                f"[{err['timestamp']}] {err['event']}: "
                f"{err.get('error_message', 'No message')}"
            )
        return "\n".join(lines)

    def get_session_log_path(self) -> str:
        """Return the path to the session log file."""
        return self._session_log_path

    def get_error_log_path(self) -> str:
        """Return the path to the error log file."""
        return self._error_log_path

    def export_events(self) -> str:
        """Export all events to the session log file and return its path."""
        with self._lock:
            with open(self._session_log_path, "w", encoding="utf-8") as f:
                json.dump(self._events, f, indent=2)
        return self._session_log_path

    def clear(self) -> None:
        """Clear the in-memory event buffer."""
        with self._lock:
            self._events.clear()

    def _write_to_file(self, entry: Dict[str, Any]) -> None:
        """Append a single event to the session log file."""
        try:
            existing = []
            if os.path.exists(self._session_log_path):
                with open(self._session_log_path, "r", encoding="utf-8") as f:
                    content = f.read().strip()
                    if content:
                        existing = json.loads(content)
            existing.append(entry)
            with open(self._session_log_path, "w", encoding="utf-8") as f:
                json.dump(existing, f, indent=2)
        except (json.JSONDecodeError, OSError):
            with open(self._session_log_path, "w", encoding="utf-8") as f:
                json.dump([entry], f, indent=2)

    def _notify_listeners(self, entry: Dict[str, Any]) -> None:
        """Notify all registered listeners of a new event."""
        for callback in self._listeners:
            try:
                callback(entry)
            except Exception:
                pass
