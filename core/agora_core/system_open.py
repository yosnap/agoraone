"""Opens a file or a folder with the system's own program (Preview, Word, Excel, the Finder…), or shows a file
selected in its folder. Always as an argument, never through a shell. Used by Fiscal and by the quotes' documents.

macOS and Windows hand the file over and return at once; on Linux `xdg-open` may stay as long as the viewer it
starts, so it is launched without waiting and without pipes (a viewer that inherits them would hold the call)."""

import subprocess
import sys
from pathlib import Path


def command_for(target: Path, reveal: bool = False, platform: str | None = None) -> list[str]:
    platform = platform or sys.platform
    if platform == "darwin":
        return ["/usr/bin/open", *(["-R"] if reveal else []), "--", str(target)]
    if platform == "win32":  # the Explorer, with the file selected when asked
        return ["explorer", f"/select,{target}"] if reveal else ["explorer", str(target)]
    return ["xdg-open", str(target.parent if reveal else target)]


def open_path(target: Path, reveal: bool = False, runner=None) -> None:
    """Raises OSError or subprocess.SubprocessError when it could not be opened. `runner` replaces subprocess.run
    in tests (then it is called on every system)."""
    command = command_for(target, reveal)
    quiet = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if runner is None and sys.platform not in ("darwin", "win32"):
        subprocess.Popen(command, start_new_session=True, **quiet)
        return
    done = (runner or subprocess.run)(command, timeout=10, **quiet)
    if sys.platform != "win32" and getattr(done, "returncode", 0) not in (0, None):  # explorer returns 1 even when it works
        raise subprocess.CalledProcessError(done.returncode, command)
