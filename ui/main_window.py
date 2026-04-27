"""Main application window for FormFlow Desktop Pro.

Integrates all UI panels: workflow configuration, debug console,
execution timeline, VPN management, and status bar.
"""

import asyncio
import os
import subprocess
import sys
import threading
from typing import Any, Dict, Optional

from PyQt5.QtCore import QObject, Qt, QThread, pyqtSignal, pyqtSlot
from PyQt5.QtGui import QFont, QIcon
from PyQt5.QtWidgets import (
    QAction,
    QApplication,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMenuBar,
    QMessageBox,
    QProgressBar,
    QSplitter,
    QStatusBar,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from ui.debug_panel import DebugPanel
from ui.styles import MAIN_STYLESHEET
from ui.timeline_panel import TimelinePanel
from ui.vpn_panel import VPNPanel
from ui.workflow_panel import WorkflowPanel


class WorkflowWorker(QObject):
    """Background worker for running workflows without blocking the UI."""

    event_emitted = pyqtSignal(dict)
    progress_updated = pyqtSignal(dict)
    finished = pyqtSignal(list)
    error = pyqtSignal(str)

    def __init__(self) -> None:
        super().__init__()
        self._running = False

    def stop(self) -> None:
        self._running = False

    @pyqtSlot(dict)
    def run(self, params: dict) -> None:
        """Execute workflows in a background thread with asyncio."""
        self._running = True
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            results = loop.run_until_complete(self._execute(params))
            self.finished.emit(results)
        except Exception as e:
            self.error.emit(str(e))
        finally:
            self._running = False

    async def _execute(self, params: dict) -> list:
        """Async workflow execution."""
        from automation.captcha_monitor import CaptchaMonitor
        from automation.environment_simulator import EnvironmentSimulator
        from automation.profile_manager import ProfileManager
        from automation.retry_engine import RetryEngine
        from automation.workflow_engine import WorkflowConfig, WorkflowEngine
        from automation.workflow_scheduler import (
            SchedulerConfig,
            WorkflowJob,
            WorkflowScheduler,
        )
        from debug.debug_logger import DebugLogger, EventType
        from debug.network_snapshot import NetworkSnapshot
        from debug.screenshot_manager import ScreenshotManager

        logger = DebugLogger()
        logger.add_listener(lambda e: self.event_emitted.emit(e))

        logger.log(EventType.APP_START, status="success")
        logger.log(EventType.CONFIG_LOADED, status="success")

        profile_mgr = ProfileManager()
        env_sim = EnvironmentSimulator()
        screenshot_mgr = ScreenshotManager()
        network = NetworkSnapshot()
        captcha_mon = CaptchaMonitor()

        max_retries = params.get("max_retries", 2)
        retry_engine = RetryEngine(
            max_retries=max_retries,
            debug_logger=logger,
        )

        engine = WorkflowEngine(
            logger=logger,
            profile_manager=profile_mgr,
            env_simulator=env_sim,
            screenshot_manager=screenshot_mgr,
            network_snapshot=network,
            captcha_monitor=captcha_mon,
            retry_engine=retry_engine,
        )

        scheduler_config = SchedulerConfig(
            max_parallel_runs=params.get("max_parallel_runs", 3),
        )

        scheduler = WorkflowScheduler(
            engine=engine,
            logger=logger,
            scheduler_config=scheduler_config,
        )
        scheduler.set_on_progress_callback(
            lambda p: self.progress_updated.emit(p)
        )

        workflow_config = WorkflowConfig.from_dict(params["workflow_config"])
        num_profiles = params.get("num_profiles", 1)

        for i in range(num_profiles):
            profile_id = ProfileManager.generate_profile_id(i + 1)
            fingerprint = env_sim.generate_fingerprint()

            job = WorkflowJob(
                config=workflow_config,
                profile_id=profile_id,
                fingerprint=fingerprint,
            )
            scheduler.add_job(job)

        results = await scheduler.run_all()
        return [r.to_dict() for r in results]


class MainWindow(QMainWindow):
    """Main application window for FormFlow Desktop Pro."""

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FormFlow Desktop Pro")
        self.setMinimumSize(1200, 800)
        self.resize(1400, 900)

        self._worker_thread: Optional[QThread] = None
        self._worker: Optional[WorkflowWorker] = None

        self._init_ui()
        self._init_menu()
        self._init_status_bar()
        self._connect_signals()

        self.setStyleSheet(MAIN_STYLESHEET)

    def _init_ui(self) -> None:
        """Initialize the main UI layout."""
        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QVBoxLayout(central)
        main_layout.setContentsMargins(8, 8, 8, 8)

        # Main Tab Widget
        self._tabs = QTabWidget()

        # Tab 1: Workflow Configuration
        self._workflow_panel = WorkflowPanel()
        self._tabs.addTab(self._workflow_panel, "Workflow")

        # Tab 2: VPN Management
        self._vpn_panel = VPNPanel()
        self._tabs.addTab(self._vpn_panel, "VPN")

        # Tab 3: Debug Console + Timeline (split)
        debug_tab = QWidget()
        debug_layout = QHBoxLayout(debug_tab)

        splitter = QSplitter(Qt.Horizontal)

        self._debug_panel = DebugPanel()
        splitter.addWidget(self._debug_panel)

        self._timeline_panel = TimelinePanel()
        splitter.addWidget(self._timeline_panel)

        splitter.setSizes([600, 600])
        debug_layout.addWidget(splitter)

        self._tabs.addTab(debug_tab, "Debug Console")

        main_layout.addWidget(self._tabs)

        # Progress Bar
        progress_layout = QHBoxLayout()
        self._progress_label = QLabel("Ready")
        self._progress_label.setStyleSheet("color: #8888aa;")
        progress_layout.addWidget(self._progress_label)

        self._progress_bar = QProgressBar()
        self._progress_bar.setRange(0, 100)
        self._progress_bar.setValue(0)
        self._progress_bar.setFixedHeight(20)
        progress_layout.addWidget(self._progress_bar)

        main_layout.addLayout(progress_layout)

    def _init_menu(self) -> None:
        """Initialize the menu bar."""
        menubar = self.menuBar()

        # File Menu
        file_menu = menubar.addMenu("File")

        import_action = QAction("Import Workflow Config", self)
        import_action.setShortcut("Ctrl+I")
        import_action.triggered.connect(self._import_config)
        file_menu.addAction(import_action)

        export_action = QAction("Export Workflow Config", self)
        export_action.setShortcut("Ctrl+E")
        export_action.triggered.connect(self._export_config)
        file_menu.addAction(export_action)

        file_menu.addSeparator()

        exit_action = QAction("Exit", self)
        exit_action.setShortcut("Ctrl+Q")
        exit_action.triggered.connect(self.close)
        file_menu.addAction(exit_action)

        # Debug Menu
        debug_menu = menubar.addMenu("Debug")

        export_logs_action = QAction("Export Debug Logs", self)
        export_logs_action.triggered.connect(self._export_debug_logs)
        debug_menu.addAction(export_logs_action)

        open_screenshots_action = QAction("Open Screenshots Folder", self)
        open_screenshots_action.triggered.connect(self._open_screenshots_folder)
        debug_menu.addAction(open_screenshots_action)

        generate_bundle_action = QAction("Generate Debug Bundle", self)
        generate_bundle_action.triggered.connect(self._generate_debug_bundle)
        debug_menu.addAction(generate_bundle_action)

        # Help Menu
        help_menu = menubar.addMenu("Help")

        about_action = QAction("About", self)
        about_action.triggered.connect(self._show_about)
        help_menu.addAction(about_action)

    def _init_status_bar(self) -> None:
        """Initialize the status bar."""
        self._status_bar = QStatusBar()
        self.setStatusBar(self._status_bar)

        self._status_vpn = QLabel("VPN: N/A")
        self._status_ip = QLabel("IP: N/A")
        self._status_workflows = QLabel("Workflows: 0/0")

        self._status_bar.addPermanentWidget(self._status_vpn)
        self._status_bar.addPermanentWidget(self._status_ip)
        self._status_bar.addPermanentWidget(self._status_workflows)

        self._status_bar.showMessage("Ready — Configure a workflow to begin")

    def _connect_signals(self) -> None:
        """Connect all panel signals to handlers."""
        self._workflow_panel.start_requested.connect(self._on_start_workflow)
        self._workflow_panel.stop_requested.connect(self._on_stop_workflow)

        self._vpn_panel.scan_requested.connect(self._on_vpn_scan)

        self._debug_panel.export_logs_callback = self._export_debug_logs
        self._debug_panel.open_screenshots_callback = self._open_screenshots_folder
        self._debug_panel.copy_errors_callback = self._copy_error_summary
        self._debug_panel.generate_bundle_callback = self._generate_debug_bundle

    def _on_start_workflow(self) -> None:
        """Start workflow execution in a background thread."""
        config = self._workflow_panel.get_workflow_config()
        if not config:
            return

        settings = self._workflow_panel.get_execution_settings()
        params = {
            "workflow_config": config.to_dict(),
            "max_parallel_runs": settings["max_parallel_runs"],
            "max_retries": settings["max_retries"],
            "num_profiles": settings["num_profiles"],
        }

        self._workflow_panel.set_running(True)
        self._tabs.setCurrentIndex(2)  # Switch to debug tab
        self._progress_label.setText("Running workflows...")
        self._status_bar.showMessage("Executing workflows...")

        self._worker = WorkflowWorker()
        self._worker_thread = QThread()
        self._worker.moveToThread(self._worker_thread)

        self._worker.event_emitted.connect(self._debug_panel.on_event)
        self._worker.event_emitted.connect(self._timeline_panel.on_event)
        self._worker.progress_updated.connect(self._on_progress_update)
        self._worker.finished.connect(self._on_workflow_finished)
        self._worker.error.connect(self._on_workflow_error)

        self._worker_thread.started.connect(lambda: self._worker.run(params))
        self._worker_thread.start()

    def _on_stop_workflow(self) -> None:
        """Stop the current workflow execution."""
        if self._worker:
            self._worker.stop()
        self._workflow_panel.set_running(False)
        self._progress_label.setText("Stopped")
        self._status_bar.showMessage("Workflow execution stopped")

    @pyqtSlot(dict)
    def _on_progress_update(self, progress: dict) -> None:
        """Handle progress updates from the scheduler."""
        total = progress.get("total_jobs", 0)
        completed = progress.get("completed", 0)
        failed = progress.get("failed", 0)

        if total > 0:
            pct = int(((completed + failed) / total) * 100)
            self._progress_bar.setValue(pct)

        self._progress_label.setText(
            f"Progress: {completed} completed, {failed} failed, "
            f"{progress.get('queued', 0)} queued"
        )
        self._status_workflows.setText(f"Workflows: {completed + failed}/{total}")

    @pyqtSlot(list)
    def _on_workflow_finished(self, results: list) -> None:
        """Handle workflow completion."""
        self._workflow_panel.set_running(False)
        self._progress_bar.setValue(100)

        success_count = sum(1 for r in results if r.get("success"))
        fail_count = len(results) - success_count

        msg = f"Completed: {success_count} succeeded, {fail_count} failed"
        self._progress_label.setText(msg)
        self._status_bar.showMessage(msg)

        if self._worker_thread:
            self._worker_thread.quit()
            self._worker_thread.wait()

    @pyqtSlot(str)
    def _on_workflow_error(self, error: str) -> None:
        """Handle workflow execution errors."""
        self._workflow_panel.set_running(False)
        self._progress_label.setText(f"Error: {error}")
        self._status_bar.showMessage(f"Error: {error}")

        QMessageBox.critical(self, "Workflow Error", error)

        if self._worker_thread:
            self._worker_thread.quit()
            self._worker_thread.wait()

    def _on_vpn_scan(self) -> None:
        """Scan for VPN clients."""
        from vpn.vpn_detector import VPNDetector

        detector = VPNDetector()
        clients = detector.scan_all()

        client_list = [info.to_dict() for info in clients.values()]
        self._vpn_panel.update_clients(client_list)

        installed = [c for c in client_list if c["installed"]]
        if installed:
            self._status_vpn.setText(f"VPN: {installed[0]['name']}")
            self._status_bar.showMessage(
                f"Found {len(installed)} VPN client(s)"
            )
        else:
            self._status_vpn.setText("VPN: None found")
            self._status_bar.showMessage("No VPN clients detected")

    def _import_config(self) -> None:
        self._workflow_panel._import_config()

    def _export_config(self) -> None:
        self._workflow_panel._export_config()

    def _export_debug_logs(self) -> None:
        """Export debug session logs."""
        from debug.debug_logger import DebugLogger

        logger = DebugLogger()
        path = logger.export_events()
        self._status_bar.showMessage(f"Logs exported to: {path}")
        QMessageBox.information(self, "Export", f"Debug logs exported to:\n{path}")

    def _open_screenshots_folder(self) -> None:
        """Open the screenshots folder in the file explorer."""
        from debug.screenshot_manager import ScreenshotManager

        mgr = ScreenshotManager()
        folder = mgr.get_screenshot_dir()

        if os.path.isdir(folder):
            if sys.platform == "win32":
                os.startfile(folder)
            elif sys.platform == "darwin":
                subprocess.Popen(["open", folder])
            else:
                subprocess.Popen(["xdg-open", folder])
        else:
            QMessageBox.information(
                self, "Screenshots", "No screenshots directory found."
            )

    def _copy_error_summary(self) -> None:
        """Copy error summary to clipboard."""
        from debug.debug_logger import DebugLogger

        logger = DebugLogger()
        summary = logger.get_error_summary()
        clipboard = QApplication.clipboard()
        clipboard.setText(summary)
        self._status_bar.showMessage("Error summary copied to clipboard")

    def _generate_debug_bundle(self) -> None:
        """Generate a troubleshooting debug bundle."""
        from debug.bundle_exporter import BundleExporter

        exporter = BundleExporter()
        zip_path = exporter.export()
        self._status_bar.showMessage(f"Bundle generated: {zip_path}")
        QMessageBox.information(
            self,
            "Debug Bundle",
            f"Troubleshooting bundle generated:\n{zip_path}\n\n"
            "This file can be shared for issue diagnosis.",
        )

    def _show_about(self) -> None:
        """Show the About dialog."""
        QMessageBox.about(
            self,
            "About FormFlow Desktop Pro",
            "<h2>FormFlow Desktop Pro</h2>"
            "<p>Version 1.0.0</p>"
            "<p>Network & Environment-Aware Registration Workflow "
            "Testing Studio</p>"
            "<hr>"
            "<p><b>Features:</b></p>"
            "<ul>"
            "<li>Multi-profile browser isolation</li>"
            "<li>Parallel workflow execution</li>"
            "<li>Browser environment simulation</li>"
            "<li>VPN rotation scheduling</li>"
            "<li>Smart retry engine</li>"
            "<li>CAPTCHA detection monitoring</li>"
            "<li>Structured debug telemetry</li>"
            "<li>Troubleshooting bundle export</li>"
            "</ul>"
            "<p>For QA testing, onboarding pipeline simulation, "
            "browser workflow testing, and automation research.</p>",
        )

    def closeEvent(self, event: Any) -> None:
        """Handle window close event."""
        if self._worker and self._worker_thread and self._worker_thread.isRunning():
            reply = QMessageBox.question(
                self,
                "Confirm Exit",
                "Workflows are still running. Exit anyway?",
                QMessageBox.Yes | QMessageBox.No,
                QMessageBox.No,
            )
            if reply == QMessageBox.No:
                event.ignore()
                return

            self._worker.stop()
            self._worker_thread.quit()
            self._worker_thread.wait(3000)

        event.accept()
