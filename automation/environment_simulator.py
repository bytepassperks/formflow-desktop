"""Browser environment simulation layer for FormFlow Desktop Pro.

Randomizes timezone, locale, viewport, user agent, color scheme,
and language header for each workflow profile execution.
"""

import json
import os
import random
from typing import Any, Dict, List, Optional, Tuple


DEFAULT_TIMEZONES = [
    "Asia/Kolkata",
    "Europe/Berlin",
    "America/New_York",
    "America/Los_Angeles",
    "Europe/London",
    "Asia/Tokyo",
    "Australia/Sydney",
    "America/Chicago",
    "Europe/Paris",
    "Asia/Singapore",
]

DEFAULT_LOCALES = [
    "en-US", "en-GB", "de-DE", "fr-FR", "es-ES",
    "ja-JP", "hi-IN", "pt-BR", "zh-CN", "ko-KR",
]

DEFAULT_VIEWPORTS: List[Tuple[int, int]] = [
    (1920, 1080),
    (1366, 768),
    (1440, 900),
    (1536, 864),
    (1280, 720),
    (1600, 900),
    (1280, 1024),
    (1024, 768),
]

DEFAULT_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
]

DEFAULT_COLOR_SCHEMES = ["light", "dark", "no-preference"]

LOCALE_LANGUAGE_MAP = {
    "en-US": "en-US,en;q=0.9",
    "en-GB": "en-GB,en;q=0.9",
    "de-DE": "de-DE,de;q=0.9,en;q=0.5",
    "fr-FR": "fr-FR,fr;q=0.9,en;q=0.5",
    "es-ES": "es-ES,es;q=0.9,en;q=0.5",
    "ja-JP": "ja-JP,ja;q=0.9,en;q=0.5",
    "hi-IN": "hi-IN,hi;q=0.9,en;q=0.5",
    "pt-BR": "pt-BR,pt;q=0.9,en;q=0.5",
    "zh-CN": "zh-CN,zh;q=0.9,en;q=0.5",
    "ko-KR": "ko-KR,ko;q=0.9,en;q=0.5",
}


class EnvironmentSimulator:
    """Generates randomized browser environment configurations.

    Each workflow profile can optionally get a unique combination of
    timezone, locale, viewport, user agent, color scheme, and language header.
    """

    def __init__(
        self,
        timezones: Optional[List[str]] = None,
        locales: Optional[List[str]] = None,
        viewports: Optional[List[Tuple[int, int]]] = None,
        user_agents: Optional[List[str]] = None,
        color_schemes: Optional[List[str]] = None,
    ):
        self._timezones = timezones or DEFAULT_TIMEZONES
        self._locales = locales or DEFAULT_LOCALES
        self._viewports = viewports or DEFAULT_VIEWPORTS
        self._user_agents = user_agents or DEFAULT_USER_AGENTS
        self._color_schemes = color_schemes or DEFAULT_COLOR_SCHEMES

    def generate_fingerprint(self) -> Dict[str, Any]:
        """Generate a randomized browser environment fingerprint.

        Returns:
            Dictionary with timezone, locale, viewport, user_agent,
            color_scheme, and language_header.
        """
        locale = random.choice(self._locales)
        viewport = random.choice(self._viewports)

        return {
            "timezone": random.choice(self._timezones),
            "locale": locale,
            "viewport": list(viewport),
            "user_agent": random.choice(self._user_agents),
            "color_scheme": random.choice(self._color_schemes),
            "language_header": LOCALE_LANGUAGE_MAP.get(locale, f"{locale};q=0.9,en;q=0.5"),
        }

    def generate_fingerprints(self, count: int) -> List[Dict[str, Any]]:
        """Generate multiple unique fingerprints.

        Args:
            count: Number of fingerprints to generate.

        Returns:
            List of fingerprint dictionaries.
        """
        return [self.generate_fingerprint() for _ in range(count)]

    def apply_to_playwright_context(
        self, fingerprint: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Convert a fingerprint to Playwright browser context options.

        Args:
            fingerprint: Generated fingerprint dictionary.

        Returns:
            Dictionary of Playwright context options.
        """
        viewport = fingerprint.get("viewport", [1920, 1080])
        locale = fingerprint.get("locale", "en-US")

        context_options: Dict[str, Any] = {
            "viewport": {"width": viewport[0], "height": viewport[1]},
            "locale": locale,
            "timezone_id": fingerprint.get("timezone", "America/New_York"),
            "user_agent": fingerprint.get("user_agent", DEFAULT_USER_AGENTS[0]),
            "color_scheme": fingerprint.get("color_scheme", "light"),
            "extra_http_headers": {
                "Accept-Language": fingerprint.get(
                    "language_header",
                    LOCALE_LANGUAGE_MAP.get(locale, "en-US,en;q=0.9"),
                )
            },
        }

        return context_options

    def save_fingerprint_to_profile(
        self, fingerprint: Dict[str, Any], profile_path: str
    ) -> str:
        """Save a fingerprint seed to a profile directory.

        Args:
            fingerprint: Fingerprint dictionary to save.
            profile_path: Path to the profile directory.

        Returns:
            Path to the saved fingerprint_seed.json file.
        """
        seed_path = os.path.join(profile_path, "fingerprint_seed.json")
        with open(seed_path, "w", encoding="utf-8") as f:
            json.dump(fingerprint, f, indent=2)
        return seed_path

    def load_fingerprint_from_profile(
        self, profile_path: str
    ) -> Optional[Dict[str, Any]]:
        """Load a fingerprint seed from a profile directory.

        Returns:
            Fingerprint dictionary, or None if not found.
        """
        seed_path = os.path.join(profile_path, "fingerprint_seed.json")
        if not os.path.exists(seed_path):
            return None
        try:
            with open(seed_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return None
