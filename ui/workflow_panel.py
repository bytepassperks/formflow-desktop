"""Workflow configuration panel for FormFlow Desktop Pro UI.

Provides the interface for configuring registration workflows,
managing credentials, adding workflow steps, and controlling execution.
"""

import json
from typing import Any, Dict, List, Optional

from PyQt5.QtCore import Qt, pyqtSignal
from PyQt5.QtWidgets import (
    QComboBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from automation.workflow_engine import WorkflowConfig, WorkflowStep


class CredentialRow(QWidget):
    """A single credential key-value input row."""

    removed = pyqtSignal(object)

    def __init__(self, key: str = "", value: str = "", parent: Optional[QWidget] = None):
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        self.key_input = QLineEdit(key)
        self.key_input.setPlaceholderText("Key (e.g. email)")
        self.value_input = QLineEdit(value)
        self.value_input.setPlaceholderText("Value")

        self.remove_btn = QPushButton("X")
        self.remove_btn.setFixedWidth(30)
        self.remove_btn.clicked.connect(lambda: self.removed.emit(self))

        layout.addWidget(self.key_input, 2)
        layout.addWidget(self.value_input, 3)
        layout.addWidget(self.remove_btn)


class WorkflowPanel(QWidget):
    """Main workflow configuration panel."""

    workflow_ready = pyqtSignal(dict)
    start_requested = pyqtSignal()
    stop_requested = pyqtSignal()

    def __init__(self, parent: Optional[QWidget] = None):
        super().__init__(parent)
        self._credential_rows: List[CredentialRow] = []
        self._init_ui()

    def _init_ui(self) -> None:
        main_layout = QVBoxLayout(self)
        main_layout.setSpacing(12)

        # Target URL
        url_group = QGroupBox("Target Configuration")
        url_layout = QFormLayout()

        self._url_input = QLineEdit()
        self._url_input.setPlaceholderText("https://example.com/register")
        url_layout.addRow("Target URL:", self._url_input)

        self._workflow_name = QLineEdit()
        self._workflow_name.setPlaceholderText("My Registration Workflow")
        url_layout.addRow("Workflow Name:", self._workflow_name)

        url_group.setLayout(url_layout)
        main_layout.addWidget(url_group)

        # Credentials
        creds_group = QGroupBox("Credentials")
        creds_layout = QVBoxLayout()

        self._creds_container = QVBoxLayout()
        creds_layout.addLayout(self._creds_container)

        add_cred_btn = QPushButton("+ Add Credential")
        add_cred_btn.clicked.connect(self._add_credential_row)
        creds_layout.addWidget(add_cred_btn)

        creds_group.setLayout(creds_layout)
        main_layout.addWidget(creds_group)

        # Workflow Steps
        steps_group = QGroupBox("Workflow Steps")
        steps_layout = QVBoxLayout()

        self._steps_table = QTableWidget(0, 5)
        self._steps_table.setHorizontalHeaderLabels(
            ["Action", "Selector", "Value", "Wait (ms)", "Optional"]
        )
        header = self._steps_table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(1, QHeaderView.Stretch)
        header.setSectionResizeMode(2, QHeaderView.Stretch)
        header.setSectionResizeMode(3, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(4, QHeaderView.ResizeToContents)
        steps_layout.addWidget(self._steps_table)

        step_buttons = QHBoxLayout()
        add_step_btn = QPushButton("+ Add Step")
        add_step_btn.clicked.connect(self._add_step_row)
        remove_step_btn = QPushButton("- Remove Selected")
        remove_step_btn.clicked.connect(self._remove_selected_step)
        move_up_btn = QPushButton("Move Up")
        move_up_btn.clicked.connect(self._move_step_up)
        move_down_btn = QPushButton("Move Down")
        move_down_btn.clicked.connect(self._move_step_down)

        step_buttons.addWidget(add_step_btn)
        step_buttons.addWidget(remove_step_btn)
        step_buttons.addWidget(move_up_btn)
        step_buttons.addWidget(move_down_btn)
        steps_layout.addLayout(step_buttons)

        steps_group.setLayout(steps_layout)
        main_layout.addWidget(steps_group)

        # Execution Settings
        exec_group = QGroupBox("Execution Settings")
        exec_layout = QFormLayout()

        self._parallel_spin = QSpinBox()
        self._parallel_spin.setRange(1, 5)
        self._parallel_spin.setValue(3)
        exec_layout.addRow("Parallel Runs:", self._parallel_spin)

        self._retry_spin = QSpinBox()
        self._retry_spin.setRange(0, 10)
        self._retry_spin.setValue(2)
        exec_layout.addRow("Max Retries:", self._retry_spin)

        self._nav_timeout_spin = QSpinBox()
        self._nav_timeout_spin.setRange(5000, 120000)
        self._nav_timeout_spin.setValue(30000)
        self._nav_timeout_spin.setSingleStep(5000)
        self._nav_timeout_spin.setSuffix(" ms")
        exec_layout.addRow("Nav Timeout:", self._nav_timeout_spin)

        self._selector_timeout_spin = QSpinBox()
        self._selector_timeout_spin.setRange(1000, 60000)
        self._selector_timeout_spin.setValue(10000)
        self._selector_timeout_spin.setSingleStep(1000)
        self._selector_timeout_spin.setSuffix(" ms")
        exec_layout.addRow("Selector Timeout:", self._selector_timeout_spin)

        self._delay_spin = QSpinBox()
        self._delay_spin.setRange(0, 10000)
        self._delay_spin.setValue(500)
        self._delay_spin.setSingleStep(100)
        self._delay_spin.setSuffix(" ms")
        exec_layout.addRow("Action Delay:", self._delay_spin)

        self._profiles_spin = QSpinBox()
        self._profiles_spin.setRange(1, 20)
        self._profiles_spin.setValue(1)
        exec_layout.addRow("Number of Profiles:", self._profiles_spin)

        exec_group.setLayout(exec_layout)
        main_layout.addWidget(exec_group)

        # Control Buttons
        controls = QHBoxLayout()

        self._start_btn = QPushButton("Start Workflow")
        self._start_btn.setObjectName("startButton")
        self._start_btn.clicked.connect(self._on_start)

        self._stop_btn = QPushButton("Stop")
        self._stop_btn.setObjectName("stopButton")
        self._stop_btn.setEnabled(False)
        self._stop_btn.clicked.connect(self._on_stop)

        import_btn = QPushButton("Import Config")
        import_btn.clicked.connect(self._import_config)

        export_btn = QPushButton("Export Config")
        export_btn.clicked.connect(self._export_config)

        controls.addWidget(self._start_btn)
        controls.addWidget(self._stop_btn)
        controls.addStretch()
        controls.addWidget(import_btn)
        controls.addWidget(export_btn)

        main_layout.addLayout(controls)
        main_layout.addStretch()

        self._add_credential_row("email", "")
        self._add_credential_row("password", "")

    def _add_credential_row(self, key: str = "", value: str = "") -> None:
        row = CredentialRow(key if isinstance(key, str) else "", value)
        row.removed.connect(self._remove_credential_row)
        self._credential_rows.append(row)
        self._creds_container.addWidget(row)

    def _remove_credential_row(self, row: CredentialRow) -> None:
        if row in self._credential_rows:
            self._credential_rows.remove(row)
            self._creds_container.removeWidget(row)
            row.deleteLater()

    def _add_step_row(self) -> None:
        row = self._steps_table.rowCount()
        self._steps_table.insertRow(row)

        action_combo = QComboBox()
        action_combo.addItems(["navigate", "fill", "click", "select", "wait", "submit", "check"])
        self._steps_table.setCellWidget(row, 0, action_combo)

        self._steps_table.setItem(row, 1, QTableWidgetItem(""))
        self._steps_table.setItem(row, 2, QTableWidgetItem(""))
        self._steps_table.setItem(row, 3, QTableWidgetItem("500"))

        optional_combo = QComboBox()
        optional_combo.addItems(["No", "Yes"])
        self._steps_table.setCellWidget(row, 4, optional_combo)

    def _remove_selected_step(self) -> None:
        row = self._steps_table.currentRow()
        if row >= 0:
            self._steps_table.removeRow(row)

    def _move_step_up(self) -> None:
        row = self._steps_table.currentRow()
        if row > 0:
            self._swap_rows(row, row - 1)
            self._steps_table.setCurrentCell(row - 1, 0)

    def _move_step_down(self) -> None:
        row = self._steps_table.currentRow()
        if row < self._steps_table.rowCount() - 1:
            self._swap_rows(row, row + 1)
            self._steps_table.setCurrentCell(row + 1, 0)

    def _swap_rows(self, row1: int, row2: int) -> None:
        for col in range(self._steps_table.columnCount()):
            widget1 = self._steps_table.cellWidget(row1, col)
            widget2 = self._steps_table.cellWidget(row2, col)
            if widget1 and widget2 and isinstance(widget1, QComboBox):
                idx1 = widget1.currentIndex()
                idx2 = widget2.currentIndex()
                widget1.setCurrentIndex(idx2)
                widget2.setCurrentIndex(idx1)
            else:
                item1 = self._steps_table.item(row1, col)
                item2 = self._steps_table.item(row2, col)
                if item1 and item2:
                    text1 = item1.text()
                    text2 = item2.text()
                    item1.setText(text2)
                    item2.setText(text1)

    def get_workflow_config(self) -> Optional[WorkflowConfig]:
        """Build a WorkflowConfig from the current UI state."""
        url = self._url_input.text().strip()
        name = self._workflow_name.text().strip() or "Unnamed Workflow"

        if not url:
            QMessageBox.warning(self, "Validation", "Please enter a target URL.")
            return None

        credentials: Dict[str, str] = {}
        for row in self._credential_rows:
            key = row.key_input.text().strip()
            value = row.value_input.text().strip()
            if key:
                credentials[key] = value

        steps: List[WorkflowStep] = []
        for row_idx in range(self._steps_table.rowCount()):
            action_widget = self._steps_table.cellWidget(row_idx, 0)
            action = action_widget.currentText() if action_widget else "fill"

            selector_item = self._steps_table.item(row_idx, 1)
            selector = selector_item.text().strip() if selector_item else ""

            value_item = self._steps_table.item(row_idx, 2)
            value = value_item.text().strip() if value_item else ""

            wait_item = self._steps_table.item(row_idx, 3)
            try:
                wait_ms = int(wait_item.text()) if wait_item else 500
            except ValueError:
                wait_ms = 500

            optional_widget = self._steps_table.cellWidget(row_idx, 4)
            optional = optional_widget.currentText() == "Yes" if optional_widget else False

            step = WorkflowStep(
                action=action,
                selector=selector or None,
                value=value or None,
                url=url if action == "navigate" else None,
                wait_ms=wait_ms,
                optional=optional,
            )
            steps.append(step)

        return WorkflowConfig(
            name=name,
            target_url=url,
            steps=steps,
            credentials=credentials,
            navigation_timeout_ms=self._nav_timeout_spin.value(),
            selector_timeout_ms=self._selector_timeout_spin.value(),
            action_delay_ms=self._delay_spin.value(),
        )

    def get_execution_settings(self) -> Dict[str, Any]:
        """Return execution settings from the UI."""
        return {
            "max_parallel_runs": self._parallel_spin.value(),
            "max_retries": self._retry_spin.value(),
            "num_profiles": self._profiles_spin.value(),
        }

    def set_running(self, running: bool) -> None:
        """Toggle UI state between running and idle."""
        self._start_btn.setEnabled(not running)
        self._stop_btn.setEnabled(running)

    def _on_start(self) -> None:
        config = self.get_workflow_config()
        if config:
            self.start_requested.emit()

    def _on_stop(self) -> None:
        self.stop_requested.emit()

    def _import_config(self) -> None:
        from PyQt5.QtWidgets import QFileDialog

        path, _ = QFileDialog.getOpenFileName(
            self, "Import Workflow Config", "", "JSON Files (*.json)"
        )
        if path:
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self._load_config_data(data)
            except Exception as e:
                QMessageBox.critical(self, "Import Error", str(e))

    def _export_config(self) -> None:
        config = self.get_workflow_config()
        if not config:
            return

        from PyQt5.QtWidgets import QFileDialog

        path, _ = QFileDialog.getSaveFileName(
            self, "Export Workflow Config", "workflow_config.json", "JSON Files (*.json)"
        )
        if path:
            try:
                data = config.to_dict()
                data["execution_settings"] = self.get_execution_settings()
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2)
            except Exception as e:
                QMessageBox.critical(self, "Export Error", str(e))

    def _load_config_data(self, data: dict) -> None:
        """Populate the UI from a config dictionary."""
        self._url_input.setText(data.get("target_url", ""))
        self._workflow_name.setText(data.get("name", ""))

        for row in list(self._credential_rows):
            self._remove_credential_row(row)
        for key, value in data.get("credentials", {}).items():
            self._add_credential_row(key, value)

        self._steps_table.setRowCount(0)
        for step_data in data.get("steps", []):
            self._add_step_row()
            row = self._steps_table.rowCount() - 1

            action_widget = self._steps_table.cellWidget(row, 0)
            if action_widget:
                idx = action_widget.findText(step_data.get("action", "fill"))
                if idx >= 0:
                    action_widget.setCurrentIndex(idx)

            self._steps_table.item(row, 1).setText(step_data.get("selector", ""))
            self._steps_table.item(row, 2).setText(step_data.get("value", ""))
            self._steps_table.item(row, 3).setText(str(step_data.get("wait_ms", 500)))

            optional_widget = self._steps_table.cellWidget(row, 4)
            if optional_widget and step_data.get("optional"):
                optional_widget.setCurrentIndex(1)

        settings = data.get("execution_settings", {})
        if "max_parallel_runs" in settings:
            self._parallel_spin.setValue(settings["max_parallel_runs"])
        if "max_retries" in settings:
            self._retry_spin.setValue(settings["max_retries"])
        if "num_profiles" in settings:
            self._profiles_spin.setValue(settings["num_profiles"])
