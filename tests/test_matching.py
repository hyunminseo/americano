import cv2
import numpy as np

from matching.template import find_template


def test_finds_template_and_reports_position():
    template = np.zeros((4, 5, 3), dtype=np.uint8)
    template[:, :, 1] = 255
    screen = np.zeros((20, 20, 3), dtype=np.uint8)
    screen[7:11, 9:14] = template

    match = find_template(screen, template, 0.99)

    assert match is not None
    assert (match.x, match.y) == (9, 7)


def test_returns_none_when_template_is_larger():
    screen = np.zeros((4, 4, 3), dtype=np.uint8)
    template = np.zeros((5, 5, 3), dtype=np.uint8)

    assert find_template(screen, template, 0.9) is None
