# Python services

Placeholder for Python-based services. Nothing runs here yet.

## Getting started (when you add code)

```bash
cd services/python

# Windows (PowerShell)
python -m venv .venv
.venv\Scripts\Activate.ps1

# Linux / macOS
python3 -m venv .venv
source .venv/bin/activate

# Both platforms
pip install -r requirements.txt
```

Add dependencies to `requirements.txt` (or migrate to `pyproject.toml`).
Remember to record the service's port in the root `.env.example` and add a
proxy rule in `apps/web/vite.config.ts` — see [../README.md](../README.md).
