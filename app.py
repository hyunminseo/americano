from __future__ import annotations

import argparse
import logging
import sys
import threading
from pathlib import Path

from config import ConfigError, load_config


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="americano screen automation manager")
    parser.add_argument("--config", default="config.json", help="path to a JSON configuration file")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("validate", help="validate configuration without accessing the screen")
    subparsers.add_parser("run", help="start screen watching and keyboard actions")
    return parser


def run(config_path: str) -> int:
    config = load_config(config_path)
    if sys.platform != "win32":
        raise RuntimeError("the run command currently supports Windows only")
    from capture.windows import WindowsScreenCapture
    from input.windows import WindowsHotkeys, WindowsKeyboard
    from policy.center_patterns import CenterPatternGuard
    from runtime.watcher import Watcher

    stop_event = threading.Event()
    paused_event = threading.Event()

    def toggle_pause() -> None:
        if paused_event.is_set():
            paused_event.clear()
            logging.info("watcher resumed")
        else:
            paused_event.set()
            logging.info("watcher paused")

    capture = WindowsScreenCapture(config.monitor)
    keyboard = WindowsKeyboard()
    pattern_guard = CenterPatternGuard(Path(__file__).parent / "policy" / "center_patterns")
    hotkeys = WindowsHotkeys(toggle_pause, stop_event.set)
    hotkeys.start()
    try:
        Watcher(
            config,
            capture,
            keyboard,
            stop_event.is_set,
            lambda: not paused_event.is_set(),
            pattern_guard,
        ).run()
    except KeyboardInterrupt:
        logging.info("stopping by user request")
    finally:
        stop_event.set()
        hotkeys.stop()
        capture.close()
        keyboard.close()
    return 0


def main() -> int:
    args = build_parser().parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        config = load_config(args.config)
        if args.command == "validate":
            logging.info("configuration is valid: %d target(s)", len(config.targets))
            return 0
        return run(args.config)
    except (ConfigError, RuntimeError, ValueError) as error:
        logging.error("%s", error)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
