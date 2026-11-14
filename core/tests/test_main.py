import os
import socket
import subprocess
import sys

from agora_core.__main__ import alive, backend_pid, port_free


def test_puerto_ocupado_por_un_servidor_que_escucha():
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        server.listen()
        assert not port_free("127.0.0.1", server.getsockname()[1])


def test_puerto_libre_aunque_queden_conexiones_en_time_wait():
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    port = server.getsockname()[1]
    server.listen()
    client = socket.create_connection(("127.0.0.1", port))
    accepted, _ = server.accept()
    accepted.close()  # quien cierra primero deja la conexión en TIME_WAIT
    client.close()
    server.close()
    assert port_free("127.0.0.1", port)


def test_vigila_el_pid_del_backend_y_no_al_padre_intermedio():
    assert backend_pid({"AGORA_BACKEND_PID": "4242"}) == 4242
    assert backend_pid({}) == os.getppid()
    assert backend_pid({"AGORA_BACKEND_PID": "x"}) == os.getppid()


def test_detecta_un_proceso_terminado():
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    assert alive(os.getpid())
    assert not alive(child.pid)
