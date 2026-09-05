from __future__ import annotations

from typing import Protocol

import numpy as np

from config import Region


class ScreenCapture(Protocol):
    def capture(self, region: Region) -> np.ndarray:
        ...

    def capture_center(self) -> np.ndarray:
        ...
