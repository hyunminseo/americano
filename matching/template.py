from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass(frozen=True)
class MatchResult:
    score: float
    x: int
    y: int
    width: int
    height: int

    @property
    def matched(self) -> bool:
        return self.score >= 0


def load_template(path: str) -> np.ndarray:
    template = cv2.imread(path, cv2.IMREAD_COLOR)
    if template is None:
        raise ValueError(f"unable to read template image: {path}")
    return template


def _to_gray(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        return image
    if image.ndim == 3 and image.shape[2] in (3, 4):
        conversion = cv2.COLOR_BGR2GRAY if image.shape[2] == 3 else cv2.COLOR_BGRA2GRAY
        return cv2.cvtColor(image, conversion)
    raise ValueError("image must be grayscale, BGR, or BGRA")


def _match_grayscale(screen: np.ndarray, template: np.ndarray) -> tuple[float, tuple[int, int]]:
    result = cv2.matchTemplate(screen, template, cv2.TM_CCOEFF_NORMED)
    _, score, _, location = cv2.minMaxLoc(result)
    return float(score), location


def _match_gray(screen: np.ndarray, template: np.ndarray) -> tuple[float, tuple[int, int]]:
    if float(np.std(template)) == 0:
        result = cv2.matchTemplate(screen, template, cv2.TM_SQDIFF_NORMED)
        error, _, location, _ = cv2.minMaxLoc(result)
        return 1.0 - float(error), location
    return _match_grayscale(screen, template)


def _binarize(image: np.ndarray) -> np.ndarray:
    _, binary = cv2.threshold(image, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return binary


def find_template(screen: np.ndarray, template: np.ndarray, threshold: float) -> MatchResult | None:
    screen_gray = _to_gray(screen)
    template_gray = _to_gray(template)
    screen_height, screen_width = screen_gray.shape[:2]
    template_height, template_width = template_gray.shape[:2]
    if template_height > screen_height or template_width > screen_width:
        return None

    # Grayscale is cheaper than BGR and is stable for normal color changes.
    score, location = _match_gray(screen_gray, template_gray)
    # Only pay for binarization when the fast path did not meet the threshold.
    if score < threshold:
        binary_score, binary_location = _match_gray(_binarize(screen_gray), _binarize(template_gray))
        if binary_score > score:
            score, location = binary_score, binary_location
    if score < threshold:
        return None
    return MatchResult(
        score=float(score), x=location[0], y=location[1],
        width=template_width, height=template_height,
    )
