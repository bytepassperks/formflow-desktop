"""VPN management panel for FormFlow Desktop Pro UI.

Displays detected VPN clients, connection status, and location controls.
"""

from typing import Any, Dict, List, Optional

from PyQt5.QtCore import Qt, pyqtSignal
from PyQt5.QtWidgets import (
    QComboBox,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QVBoxLayout,
    QWidget,
)


class VPNPanel(QWidget):
    """VPN management panel with client detection and location controls."""

    scan_requested = pyqtSignal()
    connect_requested = pyqtSignal(str, str)  # client_name, location
    disconnect_requested = pyqtSignal()
    rotate_requested = pyqtSignal()

    def __init__(self, parent: Optional[QWidget] = None):
        super().__init__(parent)
        self._init_ui()

    def _init_ui(self) -> None:
        main_layout = QVBoxLayout(self)
        main_layout.setSpacing(12)

        # Detected Clients
        clients_group = QGroupBox("Detected VPN Clients")
        clients_layout = QVBoxLayout()

        self._clients_list = QListWidget()
        self._clients_list.setMaximumHeight(120)
        clients_layout.addWidget(self._clients_list)

        scan_btn = QPushButton("Scan for VPN Clients")
        scan_btn.clicked.connect(self.scan_requested.emit)
        clients_layout.addWidget(scan_btn)

        clients_group.setLayout(clients_layout)
        main_layout.addWidget(clients_group)

        # Connection Control
        connect_group = QGroupBox("Connection Control")
        connect_layout = QVBoxLayout()

        client_row = QHBoxLayout()
        client_row.addWidget(QLabel("Client:"))
        self._client_combo = QComboBox()
        client_row.addWidget(self._client_combo, 1)
        connect_layout.addLayout(client_row)

        location_row = QHBoxLayout()
        location_row.addWidget(QLabel("Location:"))
        self._location_combo = QComboBox()
        self._location_combo.setEditable(True)
        location_row.addWidget(self._location_combo, 1)
        connect_layout.addLayout(location_row)

        btn_row = QHBoxLayout()
        self._connect_btn = QPushButton("Connect")
        self._connect_btn.setObjectName("startButton")
        self._connect_btn.clicked.connect(self._on_connect)
        btn_row.addWidget(self._connect_btn)

        self._disconnect_btn = QPushButton("Disconnect")
        self._disconnect_btn.setObjectName("stopButton")
        self._disconnect_btn.clicked.connect(self.disconnect_requested.emit)
        btn_row.addWidget(self._disconnect_btn)

        self._rotate_btn = QPushButton("Rotate Location")
        self._rotate_btn.clicked.connect(self.rotate_requested.emit)
        btn_row.addWidget(self._rotate_btn)

        connect_layout.addLayout(btn_row)

        # Status
        self._connection_status = QLabel("Status: Not connected")
        self._connection_status.setStyleSheet(
            "color: #8888aa; font-weight: bold; padding: 8px;"
        )
        connect_layout.addWidget(self._connection_status)

        connect_group.setLayout(connect_layout)
        main_layout.addWidget(connect_group)

        # Location Queue
        queue_group = QGroupBox("Location Rotation Queue")
        queue_layout = QVBoxLayout()

        self._queue_list = QListWidget()
        self._queue_list.setMaximumHeight(150)
        queue_layout.addWidget(self._queue_list)

        queue_group.setLayout(queue_layout)
        main_layout.addWidget(queue_group)

        main_layout.addStretch()

    def update_clients(self, clients: List[Dict[str, Any]]) -> None:
        """Update the detected VPN clients list."""
        self._clients_list.clear()
        self._client_combo.clear()

        for client in clients:
            name = client.get("name", "Unknown")
            installed = client.get("installed", False)
            method = client.get("detection_method", "N/A")

            status_text = f"{name} — {'Installed' if installed else 'Not Found'}"
            if installed and method:
                status_text += f" (via {method})"

            item = QListWidgetItem(status_text)
            if installed:
                item.setForeground(Qt.green)
                self._client_combo.addItem(name)
            else:
                item.setForeground(Qt.gray)

            self._clients_list.addItem(item)

    def update_locations(self, locations: List[str]) -> None:
        """Update the location dropdown and queue list."""
        self._location_combo.clear()
        self._queue_list.clear()

        for loc in locations:
            self._location_combo.addItem(loc)
            self._queue_list.addItem(loc)

    def set_connection_status(self, status: str, color: str = "#8888aa") -> None:
        """Update the connection status display."""
        self._connection_status.setText(f"Status: {status}")
        self._connection_status.setStyleSheet(
            f"color: {color}; font-weight: bold; padding: 8px;"
        )

    def _on_connect(self) -> None:
        client = self._client_combo.currentText()
        location = self._location_combo.currentText()
        if client:
            self.connect_requested.emit(client, location)
