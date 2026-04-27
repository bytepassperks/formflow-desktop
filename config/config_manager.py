"""Configuration manager for FormFlow Desktop Pro."""

import json
import os
from typing import Any, Dict, Optional


class ConfigManager:
    """Loads and manages application configuration."""

    DEFAULT_CONFIG_PATH = os.path.join(
        os.path.dirname(__file__), "default_config.json"
    )
    SESSION_CONFIG_PATH = os.path.join(
        os.path.dirname(os.path.dirname(__file__)), "config", "session_config.json"
    )

    def __init__(self, config_path: Optional[str] = None):
        self._config: Dict[str, Any] = {}
        self._config_path = config_path or self.DEFAULT_CONFIG_PATH
        self.load()

    def load(self) -> None:
        """Load configuration from file."""
        with open(self._config_path, "r", encoding="utf-8") as f:
            self._config = json.load(f)

    def get(self, key: str, default: Any = None) -> Any:
        """Get a configuration value by key, supporting dot notation."""
        keys = key.split(".")
        value = self._config
        for k in keys:
            if isinstance(value, dict) and k in value:
                value = value[k]
            else:
                return default
        return value

    def set(self, key: str, value: Any) -> None:
        """Set a configuration value by key, supporting dot notation."""
        keys = key.split(".")
        config = self._config
        for k in keys[:-1]:
            if k not in config:
                config[k] = {}
            config = config[k]
        config[keys[-1]] = value

    def save_session_config(self, path: Optional[str] = None) -> str:
        """Save current configuration as session config."""
        save_path = path or self.SESSION_CONFIG_PATH
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        with open(save_path, "w", encoding="utf-8") as f:
            json.dump(self._config, f, indent=4)
        return save_path

    def to_dict(self) -> Dict[str, Any]:
        """Return configuration as dictionary."""
        return dict(self._config)

    def update(self, overrides: Dict[str, Any]) -> None:
        """Update configuration with overrides."""
        self._deep_update(self._config, overrides)

    @staticmethod
    def _deep_update(base: Dict, updates: Dict) -> Dict:
        for key, value in updates.items():
            if isinstance(value, dict) and isinstance(base.get(key), dict):
                ConfigManager._deep_update(base[key], value)
            else:
                base[key] = value
        return base
