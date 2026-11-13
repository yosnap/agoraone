"""Terminal commands for the user: `uv run python -m agora_core.cli <command>` from the core folder.

recovery-key  shows the backup recovery key once, to copy it to paper or a password manager.
backup        takes a backup now.
list          lists the backups.
restore FILE  replaces the database with a backup (AgoraOne must be stopped).
"""

import argparse
import getpass
import sys
from pathlib import Path

from .__main__ import port_free
from .backup import BackupError, create_backup, list_backups, prune, restore
from .db import private_dir
from .keystore import KeychainStore, KeyStoreError, ensure_key, key_from_recovery, recovery_code
from .settings import HOST, PORT, data_dir

SHOWN_FLAG = "recovery-key-shown"


def show_recovery_key(folder: Path, store, again: bool) -> int:
    flag = private_dir(folder) / SHOWN_FLAG
    if flag.exists() and not again:
        print("La clave de recuperación ya se mostró. Si la perdiste y este Mac sigue funcionando, usa --again.")
        return 1
    key, _ = ensure_key(store)
    print("Clave de recuperación de las copias de AgoraOne. Guárdala fuera de este Mac:")
    print()
    print(f"    {recovery_code(key)}")
    print()
    print("Sin ella, si pierdes este Mac o su Llavero, las copias no se podrán abrir.")
    flag.touch(mode=0o600)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agora_core.cli", description="Copias de seguridad del núcleo de AgoraOne.")
    commands = parser.add_subparsers(dest="command", required=True)
    shown = commands.add_parser("recovery-key", help="muestra la clave de recuperación (una vez)")
    shown.add_argument("--again", action="store_true", help="mostrarla otra vez")
    commands.add_parser("backup", help="hace una copia ahora")
    commands.add_parser("list", help="lista las copias")
    restoring = commands.add_parser("restore", help="restaura una copia (con AgoraOne parado)")
    restoring.add_argument("file", type=Path)
    restoring.add_argument("--recovery", action="store_true", help="pedir la clave de recuperación en vez de usar el Llavero")
    args = parser.parse_args(argv)
    folder, store = data_dir(), KeychainStore()
    try:
        if args.command == "recovery-key":
            return show_recovery_key(folder, store, args.again)
        if args.command == "backup":
            made = create_backup(folder, store, "manual")
            prune(folder)
            print(f"Copia hecha: {made.name}")
            return 0
        if args.command == "list":
            for backup in list_backups(folder):
                print(f"{backup.created:%Y-%m-%d %H:%M} UTC  {backup.kind:<12}  {backup.name}")
            return 0
        if not port_free(HOST, PORT):
            print("Detén AgoraOne antes de restaurar: el núcleo está en marcha.", file=sys.stderr)
            return 3
        if args.recovery:
            key = key_from_recovery(getpass.getpass("Clave de recuperación: "))
        else:
            key, _ = ensure_key(store)
        aside = restore(folder, args.file.resolve(), key)
        print(f"Base de datos restaurada. La anterior se conserva en {aside.name}.")
        return 0
    except (BackupError, KeyStoreError, OSError) as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
