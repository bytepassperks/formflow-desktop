"""Debug console panel for FormFlow Desktop Pro UI.

Displays live event stream, current selector activity, VPN status,
retry counter, and IP detection status. Provides export and utility buttons.
"""

import os
import subprocess
import sys
from typing import Any, Dict, Optional

from PyQt5.QtCore import Qt, QTimer, pyqtSlot
from PyQt5.QtGui import QColor, QFont, QTextCharFormat
from PyQt5.QtWidgets import (
    QApplication,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from ui.styles import STATUS_COLORS, TIMELINE_EVENT_COLORS


class StatusIndicator(QWidget):
    """A labeled status indicator with colored text."""

    def __init__(self, label: str, parent: Optional[QWidget] = None):
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        self._label = QLabel(f"{label}:")
        self._label.setStyleSheet("color: #8888aa; font-weight: bold;")

        self._value = QLabel("--")
        self._value.setStyleSheet("color: #e0e0e0;")

        layout.addWidget(self._label)
        layout.addWidget(self._value)
        layout.addStretch()

    def set_value(self, text: str, color: str = "#e0e0e0") -> None:
        self._value.setText(text)
        self._value.setStyleSheet(f"color: {color}; font-weight: bold;")


class DebugPanel(QWidget):
    """Debug console panel with live event stream and status indicators."""

    def __init__(self, parent: Optional[QWidget] = None):
        super().__init__(parent)
        self._event_count = 0
        self._init_ui()

    def _init_ui(self) -> None:
        main_layout = QVBoxLayout(self)
        main_layout.setSpacing(10)

        # Status Indicators
        status_group = QGroupBox("Live Status")
        status_layout = QVBoxLayout()

        row1 = QHBoxLayout()
        self._vpn_status = StatusIndicator("VPN")
        self._ip_status = StatusIndicator("IP Address")
        row1.addWidget(self._vpn_status, 1)
        row1.addWidget(self._ip_status, 1)
        status_layout.addLayout(row1)

        row2 = QHBoxLayout()
        self._selector_status = StatusIndicator("Current Selector")
        self._retry_status = StatusIndicator("Retry Count")
        row2.addWidget(self._selector_status, 1)
        row2.addWidget(self._retry_status, 1)
        status_layout.addLayout(row2)

        row3 = QHBoxLayout()
        self._workflow_status = StatusIndicator("Workflow")
        self._profile_status = StatusIndicator("Profile")
        row3.addWidget(self._workflow_status, 1)
        row3.addWidget(self._profile_status, 1)
        status_layout.addLayout(row3)

        status_group.setLayout(status_layout)
        main_layout.addWidget(status_group)

        # Event Counter
        counter_layout = QHBoxLayout()
        self._event_counter_label = QLabel("Events: 0")
        self._event_counter_label.setStyleSheet(
            "color: #00d4ff; font-size: 12px; font-weight: bold;"
        )
        counter_layout.addWidget(self._event_counter_label)
        counter_layout.addStretch()

        self._auto_scroll_label = QLabel("Auto-scroll enabled")
        self._auto_scroll_label.setStyleSheet("color: #8888aa; font-size: 11px;")
        counter_layout.addWidget(self._auto_scroll_label)
        main_layout.addLayout(counter_layout)

        # Live Event Stream
        event_group = QGroupBox("Debug Console")
        event_layout = QVBoxLayout()

        self._event_stream = QPlainTextEdit()
        self._event_stream.setReadOnly(True)
        self._event_stream.setMaximumBlockCount(5000)
        self._event_stream.setFont(QFont("Consolas", 10))
        self._event_stream.setStyleSheet(
            "background-color: #0a0a1a; color: #00ff88; border: 1px solid #1a1a2e;"
        )
        event_layout.addWidget(self._event_stream)

        event_group.setLayout(event_layout)
        main_layout.addWidget(event_group)

        # Action Buttons
        buttons_layout = QHBoxLayout()

        self._export_btn = QPushButton("Export Debug Logs")
        self._export_btn.clicked.connect(self._on_export_logs)
        buttons_layout.addWidget(self._export_btn)

        self._screenshots_btn = QPushButton("Open Screenshots")
        self._screenshots_btn.clicked.connect(self._on_open_screenshots)
        buttons_layout.addWidget(self._screenshots_btn)

        self._copy_errors_btn = QPushButton("Copy Error Summary")
        self._copy_errors_btn.clicked.connect(self._on_copy_errors)
        buttons_layout.addWidget(self._copy_errors_btn)

        self._bundle_btn = QPushButton("Generate Bundle")
        self._bundle_btn.clicked.connect(self._on_generate_bundle)
        buttons_layout.addWidget(self._bundle_btn)

        clear_btn = QPushButton("Clear Console")
        clear_btn.clicked.connect(self._clear_console)
        buttons_layout.addWidget(clear_btn)

        main_layout.addLayout(buttons_layout)

        # Store callback references for main window to connect
        self.export_logs_callback = None
        self.open_screenshots_callback = None
        self.copy_errors_callback = None
        self.generate_bundle_callback = None

    @pyqtSlot(dict)
    def on_event(self, event: Dict[str, Any]) -> None:
        """Handle a new debug event from the logger.

        Args:
            event: Debug event dictionary from DebugLogger.
        """
        self._event_count += 1
        self._event_counter_label.setText(f"Events: {self._event_count}")

        category = event.get("category", "app_lifecycle")
        event_type = event.get("event", "unknown")
        status = event.get("status", "info")
        timestamp = event.get("timestamp", "")

        color = TIMELINE_EVENT_COLORS.get(category, "#e0e0e0")
        status_color = STATUS_COLORS.get(status, "#8888aa")

        line_parts = [f"[{timestamp}]"]
        line_parts.append(f"[{event_type}]")
        line_parts.append(f"({status})")

        if event.get("selector"):
            line_parts.append(f"selector={event['selector']}")
        if event.get("url"):
            line_parts.append(f"url={event['url']}")
        if event.get("vpn_location"):
            line_parts.append(f"vpn={event['vpn_location']}")
        if event.get("ip_address"):
            line_parts.append(f"ip={event['ip_address']}")
        if event.get("error_message"):
            line_parts.append(f"error={event['error_message']}")
        if event.get("retry_number") is not None:
            line_parts.append(f"retry={event['retry_number']}")

        self._event_stream.appendPlainText(" ".join(line_parts))

        scrollbar = self._event_stream.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

        self._update_status_indicators(event)

    def _update_status_indicators(self, event: Dict[str, Any]) -> None:
        """Update status indicators based on event data."""
        event_type = event.get("event", "")

        if event.get("selector"):
            self._selector_status.set_value(
                event["selector"],
                STATUS_COLORS.get(event.get("status", "info"), "#e0e0e0"),
            )

        if "vpn" in event_type:
            location = event.get("vpn_location", "--")
            if "connected" in event_type:
                self._vpn_status.set_value(f"Connected: {location}", "#00d4ff")
            elif "failed" in event_type:
                self._vpn_status.set_value(f"Failed: {location}", "#e74c3c")
            elif "disconnect" in event_type:
                self._vpn_status.set_value("Disconnected", "#ffa502")
            elif "switched" in event_type:
                self._vpn_status.set_value(f"Switching: {location}", "#a29bfe")

        if event.get("ip_address"):
            self._ip_status.set_value(event["ip_address"], "#00d4ff")

        if event.get("retry_number") is not None:
            self._retry_status.set_value(
                str(event["retry_number"]), "#ffa502"
            )

        if event.get("workflow_id"):
            status = event.get("status", "info")
            color = STATUS_COLORS.get(status, "#e0e0e0")
            if "started" in event_type:
                self._workflow_status.set_value("Running", "#2ed573")
            elif "finished" in event_type:
                self._workflow_status.set_value("Completed", "#00d4ff")
            elif "failed" in event_type:
                self._workflow_status.set_value("Failed", "#e74c3c")

        if event.get("profile_id"):
            self._profile_status.set_value(event["profile_id"], "#a29bfe")

    def _clear_console(self) -> None:
        self._event_stream.clear()
        self._event_count = 0
        self._event_counter_label.setText("Events: 0")

    def _on_export_logs(self) -> None:
        if self.export_logs_callback:
            self.export_logs_callback()

    def _on_open_screenshots(self) -> None:
        if self.open_screenshots_callback:
            self.open_screenshots_callback()

    def _on_copy_errors(self) -> None:
        if self.copy_errors_callback:
            self.copy_errors_callback()

    def _on_generate_bundle(self) -> None:
        if self.generate_bundle_callback:
            self.generate_bundle_callback()
