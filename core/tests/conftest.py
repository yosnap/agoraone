import pytest

from agora_core import addons


@pytest.fixture(autouse=True)
def no_real_costguard(tmp_path, monkeypatch):
    """CostGuard's default points at the user's real data, which the connectors list reads: tests never touch it."""
    manifest = addons.MANIFESTS["costguard"]
    fake = addons.Manifest(manifest.id, manifest.name, manifest.description, {"dataPath": str(tmp_path / "sin-costguard.sqlite")})
    monkeypatch.setitem(addons.MANIFESTS, "costguard", fake)
