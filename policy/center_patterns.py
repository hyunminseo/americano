from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from matching.template import find_template, load_template


# This manifest is compiled into the application. It is not configurable via
# config.json and every listed image is bundled into the release build.
ALLOWED_CENTER_PATTERNS: tuple[str, ...] = (
    "니플레티",
    "카시우스",
)
PATTERN_THRESHOLD = 0.92


class CenterPatternGuard:
    def __init__(self, pattern_dir: str | Path) -> None:
        self._pattern_dir = Path(pattern_dir)
        self._patterns = self._load_patterns()

    def _load_patterns(self) -> dict[str, np.ndarray]:
        patterns: dict[str, np.ndarray] = {}
        for name in ALLOWED_CENTER_PATTERNS:
            path = self._pattern_dir / f"{name}.png"
            if not path.is_file():
                raise FileNotFoundError(f"missing bundled center pattern: {path}")
            patterns[name] = load_template(str(path))
        return patterns

    def is_allowed(self, frame: np.ndarray) -> bool:
        return any(
            find_template(frame, pattern, PATTERN_THRESHOLD) is not None
            for pattern in self._patterns.values()
        )
