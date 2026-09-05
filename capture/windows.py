from __future__ import annotations

import cv2
import mss
import numpy as np

from config import Region


class WindowsScreenCapture:
    def __init__(self, monitor: int = 1) -> None:
        self._sct = mss.mss()
        monitors = self._sct.monitors
        if monitor >= len(monitors):
            self.close()
            raise ValueError(f"monitor {monitor} is unavailable; found {len(monitors) - 1} monitor(s)")
        self._monitor = monitors[monitor]

    def capture(self, region: Region) -> np.ndarray:
        monitor = {
            "left": self._monitor["left"] + region.x,
            "top": self._monitor["top"] + region.y,
            "width": region.width,
            "height": region.height,
        }
        frame = np.asarray(self._sct.grab(monitor))
        return cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)

    def capture_center(self) -> np.ndarray:
        width = self._monitor["width"]
        height = self._monitor["height"]
        return self.capture(Region(
            x=int(width * 0.25),
            y=int(height * 0.4),
            width=int(width * 0.5),
            height=int(height * 0.2),
        ))

    def close(self) -> None:
        self._sct.close()
