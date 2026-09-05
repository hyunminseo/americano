"""DearPyGUI-based UI for Americano automation manager."""

from __future__ import annotations

import json
import requests
import dearpygui.dearpygui as dpg
from pathlib import Path

API_URL = "http://app-service:5000/api"
CONFIG_FILE = Path("config.json")


def load_config_data() -> dict:
    """Load configuration from API."""
    try:
        response = requests.get(f"{API_URL}/config", timeout=5)
        if response.status_code == 200:
            return response.json()
    except Exception as e:
        print(f"Error loading config: {e}")
    return {}


def get_targets() -> list[dict]:
    """Get list of targets from API."""
    try:
        response = requests.get(f"{API_URL}/targets", timeout=5)
        if response.status_code == 200:
            return response.json()
    except Exception as e:
        print(f"Error loading targets: {e}")
    return []


def toggle_target_enabled(target_id: str):
    """Toggle target enabled state."""
    try:
        response = requests.post(f"{API_URL}/targets/{target_id}/toggle", timeout=5)
        if response.status_code == 200:
            print(f"Target {target_id} toggled")
            refresh_ui()
    except Exception as e:
        print(f"Error toggling target: {e}")


def refresh_ui():
    """Refresh UI with latest data."""
    config = load_config_data()
    targets = get_targets()
    
    # Update config info
    if config:
        dpg.set_value("monitor_value", f"Monitor: {config.get('monitor', 'N/A')}")
        dpg.set_value("interval_value", f"Scan Interval: {config.get('scan_interval_ms', 'N/A')}ms")
    
    # Update targets list
    dpg.delete_item("targets_table", children_only=True)
    for target in targets:
        with dpg.table_row(parent="targets_table"):
            dpg.add_text(target.get("id", "N/A"))
            dpg.add_text(target.get("trigger", "N/A"))
            dpg.add_text(str(target.get("actions_count", 0)))
            dpg.add_button(
                label="Toggle",
                width=80,
                callback=lambda s, a, u: toggle_target_enabled(u),
                user_data=target.get("id")
            )


def main():
    """Main UI entry point."""
    dpg.create_context()
    dpg.create_viewport(title="Americano - Screen Automation Manager", width=900, height=600)
    
    # File menu
    with dpg.file_dialog(directory_selector=False, show=False, callback=lambda s, a: print(a), id="file_dialog"):
        dpg.add_file_filter("JSON files (*.json){.json}")
    
    # Main window
    with dpg.drawlayer(width=900, height=600):
        # Title
        dpg.add_text("Americano - Automation Manager", pos=(20, 20), size=16, color=(255, 255, 0))
        
        # Config info section
        dpg.add_text("Configuration", pos=(20, 60), size=12, color=(200, 200, 200))
        dpg.add_text("Monitor: N/A", pos=(30, 85), tag="monitor_value")
        dpg.add_text("Scan Interval: N/A", pos=(30, 105), tag="interval_value")
        
        # Targets section
        dpg.add_text("Automation Targets", pos=(20, 145), size=12, color=(200, 200, 200))
        
        with dpg.drawlayer(width=860, height=350, pos=(20, 170)):
            with dpg.table(
                header_row=True,
                row_background=True,
                tag="targets_table",
                borders_innerH=True,
                borders_outerH=True,
                borders_innerV=True,
                borders_outerV=True,
            ):
                dpg.add_table_column(label="Target ID", width=200)
                dpg.add_table_column(label="Trigger", width=150)
                dpg.add_table_column(label="Actions", width=80)
                dpg.add_table_column(label="Control", width=100)
    
    # Control buttons at the bottom
    with dpg.drawlayer(width=900, height=80, pos=(0, 520)):
        dpg.add_button(label="Refresh", pos=(20, 20), width=100, callback=lambda: refresh_ui())
        dpg.add_button(label="Save Config", pos=(130, 20), width=100)
        dpg.add_button(label="Exit", pos=(240, 20), width=100, callback=lambda: dpg.stop_dearpygui())
        
        dpg.add_text("Status: Ready", pos=(20, 60), tag="status_text")
    
    dpg.setup_dearpygui()
    dpg.show_viewport()
    dpg.set_primary_window("primary_window", True)
    
    # Initial load
    refresh_ui()
    
    # Event loop
    while dpg.is_dearpygui_running():
        dpg.render_dearpygui_frame()
    
    dpg.destroy_context()


if __name__ == "__main__":
    main()
