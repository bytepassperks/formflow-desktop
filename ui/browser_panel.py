"""Bundled Chromium browser setup panel for FormFlow Desktop Pro UI.

Provides the interface for downloading, managing, and configuring
the custom bundled Chromium browser with stealth flags.
"""

import asyncio
from typing import Optional

from PyQt5.QtCore import QObject, Qt, QThread, pyqtSignal, pyqtSlot
from PyQt5.QtWidgets import (
    QCheckBox,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)


class DownloadWorker(QObject):
    """Background worker for downloading Chromium."""

    progress = pyqtSignal(int, int)  # downloaded, total
    finished = pyqtSignal(str)  # exe path
    error = pyqtSignal(str)

    @pyqtSlot()
    def run(self) -> None:
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            exe_path = loop.run_until_complete(self._download())
            self.finished.emit(exe_path)
        except Exception as e:
            self.error.emit(str(e))

    async def _download(self) -> str:
        from automation.chromium_manager import ChromiumManager

        mgr = ChromiumManager()
        return await mgr.download(
            progress_callback=lambda d, t: self.progress.emit(d, t)
        )


class BrowserPanel(QWidget):
    """Bundled Chromium browser management panel."""

    def __init__(self, parent: Optional[QWidget] = None):
        super().__init__(parent)
        self._download_thread: Optional[QThread] = None
        self._download_worker: Optional[DownloadWorker] = None
        self._init_ui()
        self._check_status()

    def _init_ui(self) -> None:
        main_layout = QVBoxLayout(self)
        main_layout.setSpacing(12)

        # Status Group
        status_group = QGroupBox("Bundled Chromium Browser")
        status_layout = QVBoxLayout()

        self._status_label = QLabel("Checking browser status...")
        self._status_label.setStyleSheet(
            "color: #00d4ff; font-size: 14px; font-weight: bold; padding: 8px;"
        )
        status_layout.addWidget(self._status_label)

        self._exe_path_label = QLabel("Path: N/A")
        self._exe_path_label.setStyleSheet("color: #8888aa; padding: 4px 8px;")
        status_layout.addWidget(self._exe_path_label)

        # Download controls
        dl_row = QHBoxLayout()
        self._download_btn = QPushButton("Download Chromium")
        self._download_btn.setObjectName("startButton")
        self._download_btn.clicked.connect(self._start_download)
        dl_row.addWidget(self._download_btn)

        self._progress_bar = QProgressBar()
        self._progress_bar.setRange(0, 100)
        self._progress_bar.setValue(0)
        self._progress_bar.setVisible(False)
        dl_row.addWidget(self._progress_bar)

        status_layout.addLayout(dl_row)

        self._progress_label = QLabel("")
        self._progress_label.setStyleSheet("color: #8888aa; font-size: 11px;")
        status_layout.addWidget(self._progress_label)

        status_group.setLayout(status_layout)
        main_layout.addWidget(status_group)

        # Stealth Flags Info
        flags_group = QGroupBox("Custom Launch Flags (Auto-Applied)")
        flags_layout = QVBoxLayout()

        flags_desc = QLabel(
            "The bundled Chromium launches with critical detection flags disabled.\n"
            "These are applied automatically — no manual configuration needed."
        )
        flags_desc.setWordWrap(True)
        flags_desc.setStyleSheet("color: #e0e0e0; padding: 4px;")
        flags_layout.addWidget(flags_desc)

        self._flags_list = QListWidget()
        self._flags_list.setMaximumHeight(200)
        self._flags_list.setStyleSheet(
            "QListWidget { background-color: #0a0a1a; color: #00ff88; "
            "font-family: Consolas; font-size: 11px; }"
        )

        from automation.chromium_manager import STEALTH_LAUNCH_ARGS
        for flag in STEALTH_LAUNCH_ARGS:
            item = QListWidgetItem(flag)
            self._flags_list.addItem(item)

        flags_layout.addWidget(self._flags_list)

        flags_group.setLayout(flags_layout)
        main_layout.addWidget(flags_group)

        # Stealth Features
        stealth_group = QGroupBox("Anti-Detection Features (Auto-Injected)")
        stealth_layout = QVBoxLayout()

        features = [
            ("navigator.webdriver removed", True),
            ("navigator.plugins spoofed", True),
            ("navigator.languages overridden", True),
            ("chrome.runtime patched", True),
            ("Permissions API normalized", True),
            ("Automation info bar disabled", True),
            ("Automation blink features disabled", True),
            ("Certificate errors ignored", True),
            ("Sandbox disabled (testing mode)", True),
            ("Web security relaxed (testing mode)", True),
        ]

        for label_text, enabled in features:
            cb = QCheckBox(label_text)
            cb.setChecked(enabled)
            cb.setEnabled(False)  # Read-only display
            cb.setStyleSheet(
                "QCheckBox { color: #2ed573; }"
                "QCheckBox::indicator:checked { background-color: #00d4ff; border: 1px solid #00d4ff; }"
            )
            stealth_layout.addWidget(cb)

        stealth_group.setLayout(stealth_layout)
        main_layout.addWidget(stealth_group)

        main_layout.addStretch()

    def _check_status(self) -> None:
        """Check if the bundled Chromium is already installed."""
        from automation.chromium_manager import ChromiumManager

        mgr = ChromiumManager()
        info = mgr.get_browser_info()

        if info["installed"]:
            self._status_label.setText("Bundled Chromium: INSTALLED")
            self._status_label.setStyleSheet(
                "color: #2ed573; font-size: 14px; font-weight: bold; padding: 8px;"
            )
            self._exe_path_label.setText(f"Path: {info['executable_path']}")
            self._download_btn.setText("Re-download Chromium")
        else:
            self._status_label.setText("Bundled Chromium: NOT INSTALLED")
            self._status_label.setStyleSheet(
                "color: #e74c3c; font-size: 14px; font-weight: bold; padding: 8px;"
            )
            self._exe_path_label.setText("Path: N/A — Click Download to install")
            self._download_btn.setText("Download Chromium")

    def _start_download(self) -> None:
        """Start downloading Chromium in background."""
        self._download_btn.setEnabled(False)
        self._progress_bar.setVisible(True)
        self._progress_bar.setValue(0)
        self._progress_label.setText("Starting download...")

        self._download_worker = DownloadWorker()
        self._download_thread = QThread()
        self._download_worker.moveToThread(self._download_thread)

        self._download_worker.progress.connect(self._on_download_progress)
        self._download_worker.finished.connect(self._on_download_finished)
        self._download_worker.error.connect(self._on_download_error)

        self._download_thread.started.connect(self._download_worker.run)
        self._download_thread.start()

    @pyqtSlot(int, int)
    def _on_download_progress(self, downloaded: int, total: int) -> None:
        if total > 0:
            pct = int((downloaded / total) * 100)
            self._progress_bar.setValue(pct)
            mb_dl = downloaded / (1024 * 1024)
            mb_total = total / (1024 * 1024)
            self._progress_label.setText(
                f"Downloading: {mb_dl:.1f} MB / {mb_total:.1f} MB ({pct}%)"
            )
        else:
            mb_dl = downloaded / (1024 * 1024)
            self._progress_label.setText(f"Downloading: {mb_dl:.1f} MB")

    @pyqtSlot(str)
    def _on_download_finished(self, exe_path: str) -> None:
        self._download_btn.setEnabled(True)
        self._progress_bar.setValue(100)
        self._progress_label.setText("Download complete!")
        self._check_status()

        if self._download_thread:
            self._download_thread.quit()
            self._download_thread.wait()

        QMessageBox.information(
            self,
            "Download Complete",
            f"Chromium has been downloaded and extracted.\n\nPath: {exe_path}",
        )

    @pyqtSlot(str)
    def _on_download_error(self, error: str) -> None:
        self._download_btn.setEnabled(True)
        self._progress_bar.setVisible(False)
        self._progress_label.setText(f"Error: {error}")

        if self._download_thread:
            self._download_thread.quit()
            self._download_thread.wait()

        QMessageBox.critical(self, "Download Error", error)
