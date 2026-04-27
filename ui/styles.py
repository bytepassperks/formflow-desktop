"""Stylesheet definitions for FormFlow Desktop Pro UI."""

MAIN_STYLESHEET = """
QMainWindow {
    background-color: #1a1a2e;
}

QWidget {
    color: #e0e0e0;
    font-family: "Segoe UI", "Roboto", sans-serif;
    font-size: 13px;
}

QTabWidget::pane {
    border: 1px solid #2d2d4a;
    background-color: #16213e;
    border-radius: 4px;
}

QTabBar::tab {
    background-color: #1a1a2e;
    color: #8888aa;
    padding: 10px 20px;
    margin-right: 2px;
    border-top-left-radius: 4px;
    border-top-right-radius: 4px;
    font-weight: bold;
}

QTabBar::tab:selected {
    background-color: #16213e;
    color: #00d4ff;
    border-bottom: 2px solid #00d4ff;
}

QTabBar::tab:hover {
    color: #ffffff;
}

QGroupBox {
    border: 1px solid #2d2d4a;
    border-radius: 6px;
    margin-top: 12px;
    padding-top: 16px;
    font-weight: bold;
    color: #00d4ff;
}

QGroupBox::title {
    subcontrol-origin: margin;
    left: 12px;
    padding: 0 6px;
}

QPushButton {
    background-color: #0f3460;
    color: #ffffff;
    border: 1px solid #1a5276;
    border-radius: 4px;
    padding: 8px 16px;
    font-weight: bold;
    min-height: 28px;
}

QPushButton:hover {
    background-color: #1a5276;
    border-color: #00d4ff;
}

QPushButton:pressed {
    background-color: #0a2647;
}

QPushButton:disabled {
    background-color: #2d2d4a;
    color: #666680;
    border-color: #2d2d4a;
}

QPushButton#startButton {
    background-color: #00875a;
    border-color: #00a86b;
    font-size: 14px;
}

QPushButton#startButton:hover {
    background-color: #00a86b;
}

QPushButton#stopButton {
    background-color: #c0392b;
    border-color: #e74c3c;
}

QPushButton#stopButton:hover {
    background-color: #e74c3c;
}

QLineEdit, QTextEdit, QPlainTextEdit, QSpinBox, QComboBox {
    background-color: #0f0f23;
    color: #e0e0e0;
    border: 1px solid #2d2d4a;
    border-radius: 4px;
    padding: 6px 10px;
    selection-background-color: #0f3460;
}

QLineEdit:focus, QTextEdit:focus, QPlainTextEdit:focus, QSpinBox:focus, QComboBox:focus {
    border-color: #00d4ff;
}

QComboBox::drop-down {
    border: none;
    width: 24px;
}

QComboBox QAbstractItemView {
    background-color: #0f0f23;
    color: #e0e0e0;
    border: 1px solid #2d2d4a;
    selection-background-color: #0f3460;
}

QTableWidget {
    background-color: #0f0f23;
    border: 1px solid #2d2d4a;
    gridline-color: #1a1a2e;
    selection-background-color: #0f3460;
}

QTableWidget::item {
    padding: 6px;
}

QHeaderView::section {
    background-color: #1a1a2e;
    color: #00d4ff;
    padding: 8px;
    border: 1px solid #2d2d4a;
    font-weight: bold;
}

QScrollBar:vertical {
    background-color: #0f0f23;
    width: 10px;
    border-radius: 5px;
}

QScrollBar::handle:vertical {
    background-color: #2d2d4a;
    border-radius: 5px;
    min-height: 20px;
}

QScrollBar::handle:vertical:hover {
    background-color: #3d3d5a;
}

QScrollBar:horizontal {
    background-color: #0f0f23;
    height: 10px;
    border-radius: 5px;
}

QScrollBar::handle:horizontal {
    background-color: #2d2d4a;
    border-radius: 5px;
    min-width: 20px;
}

QLabel#statusLabel {
    color: #00d4ff;
    font-size: 14px;
    font-weight: bold;
}

QLabel#sectionTitle {
    color: #00d4ff;
    font-size: 15px;
    font-weight: bold;
    padding: 4px 0;
}

QProgressBar {
    border: 1px solid #2d2d4a;
    border-radius: 4px;
    text-align: center;
    background-color: #0f0f23;
    color: #ffffff;
    font-weight: bold;
}

QProgressBar::chunk {
    background-color: #00d4ff;
    border-radius: 3px;
}

QSplitter::handle {
    background-color: #2d2d4a;
}

QStatusBar {
    background-color: #0f0f23;
    color: #8888aa;
    border-top: 1px solid #2d2d4a;
}
"""

TIMELINE_EVENT_COLORS = {
    "app_lifecycle": "#00d4ff",
    "browser": "#4ecdc4",
    "selector": "#f9ca24",
    "vpn": "#a29bfe",
    "network": "#fd79a8",
    "captcha": "#e74c3c",
    "retry": "#ffa502",
    "workflow": "#2ed573",
}

STATUS_COLORS = {
    "success": "#00d4ff",
    "failed": "#e74c3c",
    "error": "#e74c3c",
    "warning": "#ffa502",
    "info": "#8888aa",
}
