"""FormFlow Desktop Pro — Main Entry Point.

Network & Environment-Aware Registration Workflow Testing Studio.

Launch the desktop application with the full UI including:
- Workflow configuration panel
- VPN management panel
- Debug console with live event stream
- Execution timeline viewer
- Troubleshooting bundle generator
"""

import os
import sys

# Ensure the application root is in the Python path
APP_ROOT = os.path.dirname(os.path.abspath(__file__))
if APP_ROOT not in sys.path:
    sys.path.insert(0, APP_ROOT)

from utils.helpers import ensure_dir, get_app_root


def setup_directories() -> None:
    """Create required application directories."""
    root = get_app_root()
    dirs = [
        os.path.join(root, "logs"),
        os.path.join(root, "logs", "screenshots"),
        os.path.join(root, "profiles"),
        os.path.join(root, "bundles"),
        os.path.join(root, "config"),
    ]
    for d in dirs:
        ensure_dir(d)


def main() -> None:
    """Launch FormFlow Desktop Pro."""
    setup_directories()

    from PyQt5.QtWidgets import QApplication
    from PyQt5.QtCore import Qt

    # High DPI support
    QApplication.setAttribute(Qt.AA_EnableHighDpiScaling, True)
    QApplication.setAttribute(Qt.AA_UseHighDpiPixmaps, True)

    app = QApplication(sys.argv)
    app.setApplicationName("FormFlow Desktop Pro")
    app.setOrganizationName("FormFlow")
    app.setApplicationVersion("1.0.0")

    from ui.main_window import MainWindow

    window = MainWindow()
    window.show()

    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
