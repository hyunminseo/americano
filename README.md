# Americano - Screen Automation Manager

A Python-based screen automation manager that monitors screen content and triggers keyboard actions based on configurable patterns.

## Quick Start

### Prerequisites
- Python 3.12+
- Docker (optional)

### Installation

```bash
pip install -r requirements.txt
```

### Configuration

1. Copy the example configuration:
```bash
cp config.example.json config.json
```

2. Edit `config.json` with your automation rules

### Running Locally

```bash
# Validate configuration
python main.py --config config.json validate

# Start automation
python main.py --config config.json run
```

## Docker Usage

### Option 1: Docker Compose (Recommended - with UI)

Start both the automation app and UI server:

```bash
docker-compose up -d
```

Access the UI at `http://localhost:5000`

Stop services:
```bash
docker-compose down
```

View logs:
```bash
docker-compose logs -f ui-server
docker-compose logs -f app-service
```

### Option 2: Individual Docker Commands

Build the image:
```bash
docker build -t americano .
```

Run the automation app:
```bash
docker run -v $(pwd)/config.json:/app/config.json americano
```

Validate configuration:
```bash
docker run -v $(pwd)/config.json:/app/config.json americano validate
```

Run tests:
```bash
docker run americano python -m pytest -q tests
```

## UI Application (DearPyGUI)

The UI consists of two components:
- **UI Server** (Docker) - REST API server that runs in the Docker container
- **DearPyGUI Desktop Client** - Desktop application that runs on your local machine

### Architecture

```
┌─────────────────────────────────────┐
│  Docker Environment                 │
├─────────────────────────────────────┤
│  Automation App  │  UI Server (API) │
│  (Main Service)  │   (Flask)        │
└────────────┬──────────┬─────────────┘
             │          │
             │          └──── :5000 ────┐
             │                          │
             └──────────────────────────┼───────┐
                                        │       │
                         ┌──────────────┘       │
                         │                      │
                    ┌────▼────────────────────┐
                    │  DearPyGUI Desktop UI   │
                    │  (Local Machine)        │
                    │  Connects to API        │
                    └─────────────────────────┘
```

### Running with Docker Compose

Start both the automation app and UI server:

```bash
docker-compose up -d
```

### Running DearPyGUI UI Locally

After the Docker services are running:

```bash
# Install dependencies
pip install dearpygui requests

# Run the UI (on your local machine)
python ui.py
```

The UI will connect to the REST API at `http://localhost:5000`

### UI Features

- **Configuration Viewer** - View current scan settings and monitor configuration
- **Target Management** - List all automation targets and their triggers
- **Target Control** - Enable/disable specific targets without restarting
- **Real-time Status** - Monitor the status of the automation system

### UI API Endpoints

The Docker UI server exposes these endpoints:

- `GET /api/health` - Health check
- `GET /api/config` - Get current configuration
- `GET /api/targets` - List all targets
- `POST /api/targets/<id>/toggle` - Toggle target enabled state
- `POST /api/config/validate` - Validate configuration
- `POST /api/config/save` - Save configuration

## Testing

```bash
# Run all tests locally
pytest tests/

# Run specific test
pytest tests/test_config.py -v
```

## Project Structure

- `app.py` - Main application entry point
- `config.py` - Configuration loader and models
- `capture/` - Screen capture modules
- `input/` - Input handling modules
- `matching/` - Pattern matching modules
- `policy/` - Action policy modules
- `runtime/` - Runtime execution modules
- `tests/` - Test suite

## Documentation

- [DESIGN.md](DESIGN.md) - Architecture and design details
- [PRD.md](PRD.md) - Product requirements
