from __future__ import annotations

from collections.abc import Callable

from pynput.keyboard import Controller, GlobalHotKeys, Key


SPECIAL_KEYS = {name: getattr(Key, name) for name in (
    "alt", "backspace", "delete", "down", "end", "esc", "home", "left",
    "page_down", "page_up", "right", "shift", "space", "tab", "up", "cmd",
)}


class WindowsKeyboard:
    def __init__(self) -> None:
        self._keyboard = Controller()

    def press(self, key: str) -> None:
        parts = key.lower().split("+")
        pressed: list[object] = []
        try:
            for part in parts[:-1]:
                resolved = SPECIAL_KEYS.get(part, part)
                self._keyboard.press(resolved)
                pressed.append(resolved)
            final = SPECIAL_KEYS.get(parts[-1], parts[-1])
            self._keyboard.press(final)
            self._keyboard.release(final)
        finally:
            for modifier in reversed(pressed):
                self._keyboard.release(modifier)

    def close(self) -> None:
        pass


class WindowsHotkeys:
    def __init__(self, on_pause: Callable[[], None], on_emergency_stop: Callable[[], None]) -> None:
        self._listener = GlobalHotKeys({
            "<f8>": on_pause,
            "<f9>": on_emergency_stop,
        })

    def start(self) -> None:
        self._listener.start()

    def stop(self) -> None:
        self._listener.stop()
