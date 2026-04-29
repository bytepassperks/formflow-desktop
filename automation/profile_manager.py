"""Multi-profile browser isolation engine for FormFlow Desktop Pro.

Each workflow execution runs inside an isolated Playwright browser profile
with its own cookies, localStorage, sessionStorage, cache, and fingerprint seed.
"""

import json
import os
import shutil
from typing import Any, Dict, List, Optional

from utils.helpers import ensure_dir, get_app_root


class ProfileManager:
    """Manages isolated browser profiles for workflow execution."""

    def __init__(self, profiles_dir: Optional[str] = None):
        self._profiles_dir = profiles_dir or os.path.join(
            get_app_root(), "profiles"
        )
        ensure_dir(self._profiles_dir)

    def create_profile(
        self,
        profile_id: str,
        fingerprint_seed: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Create a new isolated browser profile directory.

        Args:
            profile_id: Unique identifier for the profile (e.g., 'profile_001').
            fingerprint_seed: Optional environment configuration for the profile.

        Returns:
            Path to the created profile directory.
        """
        profile_path = os.path.join(self._profiles_dir, profile_id)
        ensure_dir(profile_path)

        if fingerprint_seed:
            self._save_fingerprint_seed(profile_path, fingerprint_seed)

        return profile_path

    def get_profile_path(self, profile_id: str) -> str:
        """Get the filesystem path for a profile."""
        return os.path.join(self._profiles_dir, profile_id)

    def profile_exists(self, profile_id: str) -> bool:
        """Check if a profile directory already exists."""
        return os.path.isdir(self.get_profile_path(profile_id))

    def get_fingerprint_seed(self, profile_id: str) -> Optional[Dict[str, Any]]:
        """Read the fingerprint seed configuration for a profile.

        Returns:
            Fingerprint seed dict, or None if not set.
        """
        seed_path = os.path.join(
            self.get_profile_path(profile_id), "fingerprint_seed.json"
        )
        if not os.path.exists(seed_path):
            return None
        try:
            with open(seed_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return None

    def update_fingerprint_seed(
        self, profile_id: str, fingerprint_seed: Dict[str, Any]
    ) -> None:
        """Update the fingerprint seed for an existing profile."""
        profile_path = self.get_profile_path(profile_id)
        if not os.path.isdir(profile_path):
            raise FileNotFoundError(f"Profile not found: {profile_id}")
        self._save_fingerprint_seed(profile_path, fingerprint_seed)

    def list_profiles(self) -> List[str]:
        """List all available profile IDs."""
        if not os.path.isdir(self._profiles_dir):
            return []
        return sorted(
            [
                d
                for d in os.listdir(self._profiles_dir)
                if os.path.isdir(os.path.join(self._profiles_dir, d))
            ]
        )

    def delete_profile(self, profile_id: str) -> bool:
        """Delete a browser profile and all its data.

        Returns:
            True if deleted, False if not found.
        """
        profile_path = self.get_profile_path(profile_id)
        if os.path.isdir(profile_path):
            shutil.rmtree(profile_path, ignore_errors=True)
            return True
        return False

    def clean_all_profiles(self) -> int:
        """Delete all profiles. Returns the number of profiles removed."""
        profiles = self.list_profiles()
        for pid in profiles:
            self.delete_profile(pid)
        return len(profiles)

    def get_or_create_profile(
        self,
        profile_id: str,
        fingerprint_seed: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Get an existing profile path or create a new one.

        Args:
            profile_id: Unique identifier for the profile.
            fingerprint_seed: Optional environment config (only applied on creation).

        Returns:
            Path to the profile directory.
        """
        if self.profile_exists(profile_id):
            return self.get_profile_path(profile_id)
        return self.create_profile(profile_id, fingerprint_seed)

    def get_profile_count(self) -> int:
        """Return the total number of profiles."""
        return len(self.list_profiles())

    @staticmethod
    def generate_profile_id(index: int) -> str:
        """Generate a standard profile ID from an index.

        Example: generate_profile_id(1) -> 'profile_001'
        """
        return f"profile_{index:03d}"

    @staticmethod
    def _save_fingerprint_seed(profile_path: str, seed: Dict[str, Any]) -> None:
        """Write fingerprint seed to a profile directory."""
        seed_path = os.path.join(profile_path, "fingerprint_seed.json")
        with open(seed_path, "w", encoding="utf-8") as f:
            json.dump(seed, f, indent=2)
