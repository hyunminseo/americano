import json

import pytest

from config import ConfigError, load_config


def test_load_config_resolves_image_path(tmp_path):
    image = tmp_path / "target.png"
    image.write_bytes(b"placeholder")
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({
        "version": 1,
        "monitor": 1,
        "scan_interval_ms": 100,
        "targets": [{
            "id": "ok",
            "image": "target.png",
            "region": {"x": 0, "y": 0, "width": 100, "height": 50},
            "threshold": 0.9,
            "actions": [{"key": "enter"}],
        }],
    }), encoding="utf-8")

    config = load_config(config_path)

    assert config.targets[0].image == image.resolve()


def test_rejects_invalid_scan_interval(tmp_path):
    image = tmp_path / "target.png"
    image.write_bytes(b"placeholder")
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({
        "version": 1, "scan_interval_ms": 10, "targets": [],
    }), encoding="utf-8")

    with pytest.raises(ConfigError, match="scan_interval_ms"):
        load_config(config_path)
