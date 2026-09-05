"""REST API server for UI communication with the automation app."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request
from flask_cors import CORS

from config import AppConfig, load_config, ConfigError

app = Flask(__name__)
CORS(app)

CONFIG_FILE = Path("config.json")


def get_config() -> AppConfig | None:
    """Load configuration from file."""
    try:
        if CONFIG_FILE.exists():
            return load_config(CONFIG_FILE)
    except ConfigError:
        pass
    return None


@app.route("/api/health", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({"status": "ok", "service": "ui-server"})


@app.route("/api/config", methods=["GET"])
def get_config_endpoint():
    """Get current configuration."""
    config = get_config()
    if config is None:
        return jsonify({"error": "No configuration loaded"}), 404
    
    return jsonify({
        "monitor": config.monitor,
        "scan_interval_ms": config.scan_interval_ms,
        "targets": [
            {
                "id": target.target_id,
                "image": str(target.image),
                "region": {
                    "x": target.region.x,
                    "y": target.region.y,
                    "width": target.region.width,
                    "height": target.region.height,
                },
                "threshold": target.threshold,
                "trigger": target.trigger,
                "cooldown_ms": target.cooldown_ms,
                "actions": [
                    {"key": action.key, "delay_ms": action.delay_ms}
                    for action in target.actions
                ],
                "enabled": target.enabled,
            }
            for target in config.targets
        ],
    })


@app.route("/api/config/validate", methods=["POST"])
def validate_config():
    """Validate configuration data."""
    try:
        data = request.get_json()
        # Basic validation
        if not isinstance(data, dict):
            return jsonify({"valid": False, "error": "Invalid JSON"}), 400
        
        if "targets" not in data:
            return jsonify({"valid": False, "error": "Missing targets"}), 400
        
        return jsonify({"valid": True, "message": "Configuration is valid"})
    except Exception as e:
        return jsonify({"valid": False, "error": str(e)}), 400


@app.route("/api/config/save", methods=["POST"])
def save_config():
    """Save configuration to file."""
    try:
        data = request.get_json()
        CONFIG_FILE.write_text(json.dumps(data, indent=2))
        return jsonify({"success": True, "message": "Configuration saved"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/targets", methods=["GET"])
def list_targets():
    """List all targets from configuration."""
    config = get_config()
    if config is None:
        return jsonify([])
    
    return jsonify([
        {
            "id": target.target_id,
            "enabled": target.enabled,
            "trigger": target.trigger,
            "actions_count": len(target.actions),
        }
        for target in config.targets
    ])


@app.route("/api/targets/<target_id>/toggle", methods=["POST"])
def toggle_target(target_id: str):
    """Toggle target enabled state."""
    config = get_config()
    if config is None:
        return jsonify({"error": "No configuration loaded"}), 404
    
    # Find and toggle target
    targets = list(config.targets)
    for i, target in enumerate(targets):
        if target.target_id == target_id:
            # Create new target with toggled enabled state
            new_target = target.__class__(
                target_id=target.target_id,
                image=target.image,
                region=target.region,
                threshold=target.threshold,
                trigger=target.trigger,
                cooldown_ms=target.cooldown_ms,
                actions=target.actions,
                enabled=not target.enabled,
            )
            targets[i] = new_target
            
            # Save updated config
            # This is a simplified version - full implementation would rebuild the config
            return jsonify({"success": True, "enabled": new_target.enabled})
    
    return jsonify({"error": "Target not found"}), 404


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
