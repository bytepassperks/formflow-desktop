"""Troubleshooting bundle generator for FormFlow Desktop Pro.

Exports debug logs, error logs, network snapshots, screenshots,
and session config into a single debug_bundle.zip file.
"""

import os
import shutil
import zipfile
from typing import Optional

from utils.helpers import ensure_dir, get_app_root, timestamp_str


class BundleExporter:
    """Creates exportable debug bundles for issue diagnosis."""

    def __init__(
        self,
        bundle_dir: Optional[str] = None,
        log_dir: Optional[str] = None,
        config_dir: Optional[str] = None,
    ):
        app_root = get_app_root()
        self._bundle_dir = bundle_dir or os.path.join(app_root, "bundles")
        self._log_dir = log_dir or os.path.join(app_root, "logs")
        self._config_dir = config_dir or os.path.join(app_root, "config")
        ensure_dir(self._bundle_dir)

    def export(self, bundle_name: Optional[str] = None) -> str:
        """Generate a troubleshooting bundle zip file.

        Includes:
            - logs/debug_session.json
            - logs/errors.log
            - logs/network_snapshot.json
            - logs/screenshots/*
            - config/session_config.json

        Args:
            bundle_name: Optional custom name for the bundle file.

        Returns:
            Path to the created zip file.
        """
        name = bundle_name or f"debug_bundle_{timestamp_str()}"
        zip_path = os.path.join(self._bundle_dir, f"{name}.zip")

        files_to_include = [
            (os.path.join(self._log_dir, "debug_session.json"), "logs/debug_session.json"),
            (os.path.join(self._log_dir, "errors.log"), "logs/errors.log"),
            (os.path.join(self._log_dir, "network_snapshot.json"), "logs/network_snapshot.json"),
            (os.path.join(self._config_dir, "session_config.json"), "config/session_config.json"),
        ]

        screenshots_dir = os.path.join(self._log_dir, "screenshots")

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for src_path, arc_name in files_to_include:
                if os.path.exists(src_path):
                    zf.write(src_path, arc_name)

            if os.path.isdir(screenshots_dir):
                for filename in os.listdir(screenshots_dir):
                    filepath = os.path.join(screenshots_dir, filename)
                    if os.path.isfile(filepath):
                        zf.write(filepath, f"logs/screenshots/{filename}")

        return zip_path

    def get_bundle_dir(self) -> str:
        """Return the bundle output directory."""
        return self._bundle_dir

    def list_bundles(self) -> list:
        """List all previously exported bundle files."""
        if not os.path.isdir(self._bundle_dir):
            return []
        return sorted(
            [
                os.path.join(self._bundle_dir, f)
                for f in os.listdir(self._bundle_dir)
                if f.endswith(".zip")
            ]
        )

    def clean_bundles(self, keep_latest: int = 5) -> int:
        """Remove old bundles, keeping the latest N."""
        bundles = self.list_bundles()
        to_remove = bundles[:-keep_latest] if len(bundles) > keep_latest else []
        for path in to_remove:
            try:
                os.remove(path)
            except OSError:
                pass
        return len(to_remove)
