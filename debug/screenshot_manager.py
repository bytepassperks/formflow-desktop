"""Screenshot capture engine for FormFlow Desktop Pro.

Automatically captures screenshots on workflow failure, selector missing,
captcha detected, and timeout events.
"""

import os
from typing import Optional

from utils.helpers import ensure_dir, get_app_root, timestamp_str


class ScreenshotManager:
    """Manages automatic screenshot capture for debug purposes."""

    def __init__(self, screenshot_dir: Optional[str] = None):
        self._screenshot_dir = screenshot_dir or os.path.join(
            get_app_root(), "logs", "screenshots"
        )
        ensure_dir(self._screenshot_dir)

    async def capture(
        self,
        page: object,
        reason: str = "failure",
        workflow_id: Optional[str] = None,
    ) -> Optional[str]:
        """Capture a screenshot from a Playwright page.

        Args:
            page: Playwright page object.
            reason: Reason for capture (failure, selector_missing, captcha, timeout).
            workflow_id: Optional workflow identifier for the filename.

        Returns:
            Path to the saved screenshot, or None on failure.
        """
        prefix = reason.lower().replace(" ", "_")
        wf_suffix = f"_{workflow_id}" if workflow_id else ""
        filename = f"{prefix}{wf_suffix}_{timestamp_str()}.png"
        filepath = os.path.join(self._screenshot_dir, filename)

        try:
            await page.screenshot(path=filepath, full_page=True)
            return filepath
        except Exception:
            return None

    async def capture_failure(
        self, page: object, workflow_id: Optional[str] = None
    ) -> Optional[str]:
        """Capture screenshot on workflow failure."""
        return await self.capture(page, reason="failure", workflow_id=workflow_id)

    async def capture_selector_missing(
        self, page: object, selector: str, workflow_id: Optional[str] = None
    ) -> Optional[str]:
        """Capture screenshot when a selector is not found."""
        return await self.capture(
            page, reason="selector_missing", workflow_id=workflow_id
        )

    async def capture_captcha(
        self, page: object, workflow_id: Optional[str] = None
    ) -> Optional[str]:
        """Capture screenshot when CAPTCHA is detected."""
        return await self.capture(page, reason="captcha", workflow_id=workflow_id)

    async def capture_timeout(
        self, page: object, workflow_id: Optional[str] = None
    ) -> Optional[str]:
        """Capture screenshot on navigation/action timeout."""
        return await self.capture(page, reason="timeout", workflow_id=workflow_id)

    def get_screenshot_dir(self) -> str:
        """Return the screenshot directory path."""
        return self._screenshot_dir

    def list_screenshots(self) -> list:
        """List all captured screenshot files."""
        if not os.path.exists(self._screenshot_dir):
            return []
        return sorted(
            [
                os.path.join(self._screenshot_dir, f)
                for f in os.listdir(self._screenshot_dir)
                if f.endswith(".png")
            ]
        )
