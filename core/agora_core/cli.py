"""Terminal commands for the user: `uv run python -m agora_core.cli <command>` from the core folder.

Run them in your own terminal, never through an assistant's chat: `recovery-key` prints a secret.

recovery-key  shows the backup recovery key, to copy it to paper or a password manager.
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
from .keystore import (
    KeychainStore, KeyStore, KeyStoreError, adopt_key, ensure_key, key_from_recovery, mark_shown,
    recovery_code, recovery_pending,
)
from .settings import HOST, PORT, data_dir


def show_recovery_key(folder: Path, store: KeyStore, again: bool) -> int:
    private_dir(folder)
    if not recovery_pending(store, folder) and store.get() is not None and not again:
        print("Ya guardaste la clave de recuperación de la clave actual. Si la perdiste, usa --again.")
        return 1
    key, _ = ensure_key(store, folder, allow_create=not list_backups(folder))
    print("Clave de recuperación de las copias de AgoraOne. Guárdala fuera de este Mac:")
    print()
    print(f"    {recovery_code(key)}")
    print()
    print("Sin ella, si pierdes este Mac o su Llavero, las copias no se podrán abrir.")
    print("No la pegues en chats ni en asistentes: quien la tenga puede abrir tus copias.")
    mark_shown(folder, key)
    return 0


def main(argv: list[str] | None = None, store: KeyStore | None = None, folder: Path | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agora_core.cli", description="Copias de seguridad del núcleo de AgoraOne.")
    commands = parser.add_subparsers(dest="command", required=True)
    shown = commands.add_parser("recovery-key", help="muestra la clave de recuperación")
    shown.add_argument("--again", action="store_true", help="mostrarla otra vez")
    commands.add_parser("backup", help="hace una copia ahora")
    commands.add_parser("list", help="lista las copias")
    restoring = commands.add_parser("restore", help="restaura una copia (con AgoraOne parado)")
    restoring.add_argument("file", type=Path)
    restoring.add_argument("--recovery", action="store_true", help="pedir la clave de recuperación en vez de usar el Llavero")
    args = parser.parse_args(argv)
    folder = folder or data_dir()
    store = store or KeychainStore()
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
            if recovery_pending(store, folder):
                print("Aviso: aún no has guardado la clave de recuperación de la clave actual (recovery-key).")
            return 0
        if not port_free(HOST, PORT):
            print("Detén AgoraOne antes de restaurar: el núcleo está en marcha.", file=sys.stderr)
            return 3
        if args.recovery:
            key = key_from_recovery(getpass.getpass("Clave de recuperación: "))
        else:
            key, _ = ensure_key(store, folder, allow_create=False)
        aside = restore(folder, args.file.resolve(), key)
        print("Base de datos restaurada." + (f" La anterior se conserva en {aside.name}." if aside else ""))
        if args.recovery:
            if adopt_key(store, folder, key):
                mark_shown(folder, key)
                print("La clave de esa copia queda guardada en el Llavero para las copias siguientes.")
            elif store.get() != key:
                print("Aviso: el Llavero ya tenía otra clave; las copias siguientes usarán esa, no la de recuperación.")
        return 0
    except (BackupError, KeyStoreError, OSError) as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
