"""CAPTCHA detection monitor for FormFlow Desktop Pro.

Detects the presence of reCAPTCHA, hCaptcha, and other CAPTCHA patterns.
Does NOT bypass CAPTCHA — only detects, screenshots, logs, and notifies.
"""

import re
from typing import Optional, Tuple


RECAPTCHA_SELECTORS = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="google.com/recaptcha"]',
    ".g-recaptcha",
    "#g-recaptcha",
    '[data-sitekey]',
    'iframe[title*="reCAPTCHA"]',
]

HCAPTCHA_SELECTORS = [
    'iframe[src*="hcaptcha"]',
    ".h-captcha",
    "#h-captcha",
    'iframe[data-hcaptcha-widget-id]',
    'iframe[title*="hCaptcha"]',
]

GENERIC_CAPTCHA_PATTERNS = [
    ".captcha",
    "#captcha",
    '[class*="captcha"]',
    '[id*="captcha"]',
    '[class*="CAPTCHA"]',
    '[id*="CAPTCHA"]',
    'img[alt*="captcha"]',
    'img[alt*="CAPTCHA"]',
    'input[name*="captcha"]',
    '[class*="challenge"]',
    ".cf-turnstile",
    'iframe[src*="turnstile"]',
    'iframe[src*="challenges.cloudflare"]',
]


class CaptchaType:
    """Enum-like class for CAPTCHA types."""

    RECAPTCHA = "recaptcha"
    HCAPTCHA = "hcaptcha"
    TURNSTILE = "turnstile"
    GENERIC = "generic"
    NONE = "none"


class CaptchaDetectionResult:
    """Result of a CAPTCHA detection scan."""

    def __init__(
        self,
        detected: bool,
        captcha_type: str = CaptchaType.NONE,
        selector_matched: Optional[str] = None,
        page_url: Optional[str] = None,
    ):
        self.detected = detected
        self.captcha_type = captcha_type
        self.selector_matched = selector_matched
        self.page_url = page_url

    def to_dict(self) -> dict:
        return {
            "detected": self.detected,
            "captcha_type": self.captcha_type,
            "selector_matched": self.selector_matched,
            "page_url": self.page_url,
        }


class CaptchaMonitor:
    """Monitors pages for CAPTCHA presence during workflow execution."""

    async def detect(self, page: object) -> CaptchaDetectionResult:
        """Scan a Playwright page for CAPTCHA elements.

        Args:
            page: Playwright page object.

        Returns:
            CaptchaDetectionResult with detection status and type.
        """
        page_url = page.url

        for selector in RECAPTCHA_SELECTORS:
            if await self._element_exists(page, selector):
                return CaptchaDetectionResult(
                    detected=True,
                    captcha_type=CaptchaType.RECAPTCHA,
                    selector_matched=selector,
                    page_url=page_url,
                )

        for selector in HCAPTCHA_SELECTORS:
            if await self._element_exists(page, selector):
                return CaptchaDetectionResult(
                    detected=True,
                    captcha_type=CaptchaType.HCAPTCHA,
                    selector_matched=selector,
                    page_url=page_url,
                )

        for selector in GENERIC_CAPTCHA_PATTERNS:
            if await self._element_exists(page, selector):
                captcha_type = CaptchaType.GENERIC
                if "turnstile" in selector or "cloudflare" in selector:
                    captcha_type = CaptchaType.TURNSTILE
                return CaptchaDetectionResult(
                    detected=True,
                    captcha_type=captcha_type,
                    selector_matched=selector,
                    page_url=page_url,
                )

        if await self._check_page_content_for_captcha(page):
            return CaptchaDetectionResult(
                detected=True,
                captcha_type=CaptchaType.GENERIC,
                selector_matched="page_content_match",
                page_url=page_url,
            )

        return CaptchaDetectionResult(detected=False, page_url=page_url)

    @staticmethod
    async def _element_exists(page: object, selector: str) -> bool:
        """Check if an element matching the selector exists on the page."""
        try:
            element = await page.query_selector(selector)
            return element is not None
        except Exception:
            return False

    @staticmethod
    async def _check_page_content_for_captcha(page: object) -> bool:
        """Check page HTML content for CAPTCHA-related keywords."""
        try:
            content = await page.content()
            patterns = [
                r"recaptcha/api",
                r"hcaptcha\.com",
                r"challenges\.cloudflare\.com",
                r"captcha-delivery",
                r"funcaptcha",
                r"arkoselabs",
            ]
            for pattern in patterns:
                if re.search(pattern, content, re.IGNORECASE):
                    return True
            return False
        except Exception:
            return False
