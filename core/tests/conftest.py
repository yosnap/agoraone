"""Shared test setup.

Some Windows antivirus suites (Avast/AVG web shield) set SSLKEYLOGFILE system-wide to a device path. Python's
ssl module then asks OpenSSL to write TLS keys there and the process aborts with «no OPENSSL_Applink» as soon
as a TLS context is built. The server starts the core with a cleared environment, so this only reaches tests
and manual runs; the tests drop it so they behave as the core does in the app.
"""

import os

os.environ.pop("SSLKEYLOGFILE", None)
