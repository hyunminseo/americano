import numpy as np

from config import Action, AppConfig, Region, Target
from runtime.watcher import Watcher


class FakeCapture:
    def __init__(self, frames):
        self.frames = iter(frames)

    def capture(self, region):
        return next(self.frames)


class FakeKeyboard:
    def __init__(self):
        self.keys = []

    def press(self, key):
        self.keys.append(key)

    def close(self):
        pass


def test_on_appear_triggers_once_until_image_disappears(tmp_path):
    image = np.zeros((3, 3, 3), dtype=np.uint8)
    image[:, :, 2] = 255
    image_path = tmp_path / "target.png"
    import cv2
    cv2.imwrite(str(image_path), image)
    blank = np.zeros((10, 10, 3), dtype=np.uint8)
    visible = blank.copy()
    visible[2:5, 4:7] = image
    target = Target("red", image_path, Region(0, 0, 10, 10), 0.99, "on_appear", 0, (Action("enter"),))
    keyboard = FakeKeyboard()
    watcher = Watcher(AppConfig(1, 30, (target,)), FakeCapture([visible, visible, blank, visible]), keyboard)

    watcher.scan_once()
    watcher.scan_once()
    watcher.scan_once()
    watcher.scan_once()

    assert keyboard.keys == ["enter", "enter"]
