from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Region:
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class Action:
    key: str
    delay_ms: int = 0


@dataclass(frozen=True)
class Target:
    target_id: str
    image: Path
    region: Region
    threshold: float
    trigger: str
    cooldown_ms: int
    actions: tuple[Action, ...]
    enabled: bool = True


@dataclass(frozen=True)
class AppConfig:
    monitor: int
    scan_interval_ms: int
    targets: tuple[Target, ...]


ALLOWED_KEYS = {
    "backspace", "delete", "down", "end", "enter", "esc", "home", "left",
    "page_down", "page_up", "right", "space", "tab", "up",
    "alt", "ctrl", "shift", "win",
}


def _require(mapping: dict[str, Any], name: str, expected_type: type) -> Any:
    value = mapping.get(name)
    if not isinstance(value, expected_type):
        raise ConfigError(f"'{name}' must be {expected_type.__name__}")
    return value


def _parse_region(value: Any) -> Region:
    if not isinstance(value, dict):
        raise ConfigError("'region' must be an object")
    values = {name: _require(value, name, int) for name in ("x", "y", "width", "height")}
    if values["x"] < 0 or values["y"] < 0 or values["width"] <= 0 or values["height"] <= 0:
        raise ConfigError("region must have non-negative coordinates and positive dimensions")
    return Region(**values)


def _parse_actions(value: Any) -> tuple[Action, ...]:
    if not isinstance(value, list) or not value:
        raise ConfigError("'actions' must be a non-empty array")
    actions: list[Action] = []
    for item in value:
        if not isinstance(item, dict):
            raise ConfigError("each action must be an object")
        key = _require(item, "key", str).lower()
        if len(key) != 1 and key not in ALLOWED_KEYS and "+" not in key:
            raise ConfigError(f"unsupported key: {key}")
        delay_ms = item.get("delay_ms", 0)
        if not isinstance(delay_ms, int) or delay_ms < 0:
            raise ConfigError("action delay_ms must be a non-negative integer")
        actions.append(Action(key=key, delay_ms=delay_ms))
    return tuple(actions)


def load_config(path: str | Path) -> AppConfig:
    config_path = Path(path).resolve()
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ConfigError(f"configuration file not found: {config_path}") from error
    except json.JSONDecodeError as error:
        raise ConfigError(f"invalid JSON at line {error.lineno}, column {error.colno}") from error
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise ConfigError("configuration version must be 1")
    monitor = raw.get("monitor", 1)
    scan_interval_ms = raw.get("scan_interval_ms", 100)
    if not isinstance(monitor, int) or monitor < 1:
        raise ConfigError("monitor must be a positive integer")
    if not isinstance(scan_interval_ms, int) or scan_interval_ms < 30:
        raise ConfigError("scan_interval_ms must be at least 30")
    raw_targets = raw.get("targets")
    if not isinstance(raw_targets, list) or not raw_targets:
        raise ConfigError("'targets' must be a non-empty array")

    targets: list[Target] = []
    ids: set[str] = set()
    for raw_target in raw_targets:
        if not isinstance(raw_target, dict):
            raise ConfigError("each target must be an object")
        target_id = _require(raw_target, "id", str)
        if not target_id or target_id in ids:
            raise ConfigError(f"target id must be unique: {target_id!r}")
        ids.add(target_id)
        image_name = _require(raw_target, "image", str)
        image_path = (config_path.parent / image_name).resolve()
        if not image_path.is_file():
            raise ConfigError(f"target image not found: {image_path}")
        threshold = raw_target.get("threshold", 0.9)
        if not isinstance(threshold, (int, float)) or not 0 <= threshold <= 1:
            raise ConfigError("threshold must be between 0.0 and 1.0")
        trigger = raw_target.get("trigger", "on_appear")
        if trigger != "on_appear":
            raise ConfigError("only the 'on_appear' trigger is supported")
        cooldown_ms = raw_target.get("cooldown_ms", 1000)
        if not isinstance(cooldown_ms, int) or cooldown_ms < 0:
            raise ConfigError("cooldown_ms must be a non-negative integer")
        targets.append(Target(
            target_id=target_id,
            image=image_path,
            region=_parse_region(raw_target.get("region")),
            threshold=float(threshold),
            trigger=trigger,
            cooldown_ms=cooldown_ms,
            actions=_parse_actions(raw_target.get("actions")),
            enabled=_parse_enabled(raw_target.get("enabled", True)),
        ))
    return AppConfig(monitor=monitor, scan_interval_ms=scan_interval_ms, targets=tuple(targets))


def _parse_enabled(value: Any) -> bool:
    if not isinstance(value, bool):
        raise ConfigError("enabled must be a boolean")
    return value
