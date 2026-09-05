from __future__ import annotations

import time
from collections.abc import Callable, Iterable

from config import Action
from input.base import KeyboardAdapter


def execute_actions(actions: Iterable[Action], keyboard: KeyboardAdapter,
                    should_stop: Callable[[], bool] = lambda: False) -> bool:
    for action in actions:
        if should_stop():
            return False
        keyboard.press(action.key)
        if action.delay_ms:
            time.sleep(action.delay_ms / 1000)
    return True
