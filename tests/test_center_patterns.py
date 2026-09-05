import cv2
import numpy as np

from matching.template import find_template


def test_center_pattern_matching_accepts_only_matching_image():
    pattern = np.zeros((4, 5, 3), dtype=np.uint8)
    pattern[:, :, 1] = 255
    frame = np.zeros((20, 20, 3), dtype=np.uint8)
    frame[7:11, 9:14] = pattern

    assert find_template(frame, pattern, 0.92) is not None
    assert find_template(np.zeros_like(frame), pattern, 0.92) is None
