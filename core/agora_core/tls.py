"""TLS for HTTPS clients that run behind an antivirus or a proxy inspecting HTTPS.

The context trusts the system certificate store (Windows, the macOS Keychain and Linux).
It accepts only what the system trusts and always verifies the peer certificate and hostname.
"""

import ssl

import truststore


def client_context() -> truststore.SSLContext:
    return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
