"""Shared test setup.

Some Windows antivirus suites (Avast/AVG web shield) set SSLKEYLOGFILE system-wide to a device path. Python's
ssl module then asks OpenSSL to write TLS keys there and the process aborts with «no OPENSSL_Applink» as soon
as a TLS context is built. The server starts the core with a cleared environment, so this only reaches tests
and manual runs; the tests drop it so they behave as the core does in the app.
"""

import os

import pytest

os.environ.pop("SSLKEYLOGFILE", None)

# Imported only after dropping SSLKEYLOGFILE, in case importing it builds a TLS context.
from agora_core import addons, engines


@pytest.fixture(autouse=True)
def no_real_costguard(tmp_path, monkeypatch):
    """CostGuard's default points at the user's real data, which the connectors list reads: tests never touch it."""
    manifest = addons.MANIFESTS["costguard"]
    fake = addons.Manifest(manifest.id, manifest.name, manifest.description, {"dataPath": str(tmp_path / "sin-costguard.sqlite")})
    monkeypatch.setitem(addons.MANIFESTS, "costguard", fake)


@pytest.fixture(autouse=True)
def no_hidden_tools_left():
    """Turning a module off hides Watson's tools process-wide; every test starts with all of them visible and leaves
    them so, whatever modules an earlier test switched off."""
    engines.HIDDEN_TOOLS.clear()
    yield
    engines.HIDDEN_TOOLS.clear()
