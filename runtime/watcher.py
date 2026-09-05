from __future__ import annotations

import logging
import time
from collections.abc import Callable

from capture.base import ScreenCapture
from config import AppConfig
from input.base import KeyboardAdapter
from matching.template import find_template, load_template
from runtime.actions import execute_actions

logger = logging.getLogger(__name__)


class Watcher:
    def __init__(self, config: AppConfig, capture: ScreenCapture,
                 keyboard: KeyboardAdapter, should_stop: Callable[[], bool] = lambda: False,
                 can_execute: Callable[[], bool] = lambda: True,
                 pattern_guard: object | None = None) -> None:
        self._config = config
        self._capture = capture
        self._keyboard = keyboard
        self._should_stop = should_stop
        self._can_execute = can_execute
        self._pattern_guard = pattern_guard
        self._templates = {target.target_id: load_template(str(target.image)) for target in config.targets}
        self._visible = {target.target_id: False for target in config.targets}
        self._last_trigger = {target.target_id: 0.0 for target in config.targets}

    def run(self) -> None:
        logger.info("watcher started with %d target(s)", len(self._config.targets))
        while not self._should_stop():
            self.scan_once()
            time.sleep(self._config.scan_interval_ms / 1000)
        logger.info("watcher stopped")

    def scan_once(self) -> None:
        now = time.monotonic()
        if self._pattern_guard is not None and not self._pattern_guard.is_allowed(self._capture.capture_center()):
            for target in self._config.targets:
                self._visible[target.target_id] = False
            logger.info("center pattern is not allowed; actions blocked")
            return
        for target in self._config.targets:
            if not target.enabled:
                continue
            if not self._can_execute():
                self._visible[target.target_id] = False
                continue
            match = find_template(
                self._capture.capture(target.region),
                self._templates[target.target_id],
                target.threshold,
            )
            is_visible = match is not None
            was_visible = self._visible[target.target_id]
            self._visible[target.target_id] = is_visible
            if not is_visible or was_visible or now - self._last_trigger[target.target_id] < target.cooldown_ms / 1000:
                continue
            logger.info("target detected: id=%s score=%.4f x=%d y=%d", target.target_id, match.score, match.x, match.y)
            if execute_actions(target.actions, self._keyboard, self._should_stop):
                self._last_trigger[target.target_id] = now
                logger.info("actions executed: id=%s", target.target_id)
            else:
                logger.warning("actions interrupted: id=%s", target.target_id)
