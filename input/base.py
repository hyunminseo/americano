from __future__ import annotations

from typing import Protocol


class KeyboardAdapter(Protocol):
    def press(self, key: str) -> None:
        ...

    def close(self) -> None:
        ...
