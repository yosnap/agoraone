"""Import only the selected inference connection into the project's private .env.

Run explicitly from project root. No profiles, history, tools or memories are copied.
"""
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlparse
import yaml


def main():
    if len(sys.argv) != 3:
        raise ValueError("Uso: configure-provider.py NOMBRE_PROVEEDOR MODELO")
    provider_name, model = sys.argv[1:]
    root = Path(__file__).resolve().parent.parent
    target = root / ".env"
    if target.exists():
        raise ValueError("Ya existe .env; no se sobrescribe.")
    source = Path.home() / ".hermes" / "config.yaml"
    config = yaml.safe_load(source.read_text())
    provider = next(p for p in config.get("custom_providers", []) if p.get("name") == provider_name)
    if model not in provider.get("models", {}):
        raise ValueError("Modelo no listado por el proveedor.")
    url, key = provider.get("base_url", ""), provider.get("api_key", "")
    parsed = urlparse(url)
    if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("URL de proveedor no válida.")
    if not key or key.startswith(("$", "env:")):
        raise ValueError("La credencial requiere resolución manual; no se ha copiado.")
    settings = {"AGORA_MODEL": model, "AGORA_BASE_URL": url, "AGORA_API_KEY": key}
    with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        for name, value in settings.items():
            stream.write(f"{name}={json.dumps(value)}\n")
    print("Configuración de inferencia guardada en .env (0600). No se han modificado perfiles.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("No se pudo importar la configuración; revisa proveedor, modelo o .env existente.")
        sys.exit(1)
