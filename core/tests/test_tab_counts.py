"""The tabs' counters come from what AgoraOne keeps (the directory and the snapshots), never from a new request to
Central or CRMDev; only numbers, and «more» when CRMDev may have more than it gives."""

import pytest

from agora_core import central, client_births, clients, crmdev_pending, crmdev_sync, tab_counts
from agora_core.db import connect, migrate


@pytest.fixture
def connection(tmp_path, monkeypatch):
    found = connect(tmp_path / "agora.db")
    migrate(found)
    monkeypatch.setattr(central, "snapshot", lambda _c: {"clients": [{"name": "Uno", "websites": [{"url": "a"}, {"url": "b"}]}, {"name": "Dos"}],
                                                         "projects": [{"id": "p1"}], "servers": [{"name": "s"}]})
    first = {"clients": [{"id": "c1"}], "projects": [], "truncated": False, "counts": {"tareas": {"n": 100, "more": True}, "tickets": None}}
    second = {"clients": [{"id": "c2"}, {"id": "c3"}], "projects": [{"id": "r1"}], "truncated": False, "counts": {"tareas": {"n": 4}}}
    monkeypatch.setattr(crmdev_sync, "snapshot", lambda _c: first)
    monkeypatch.setattr(crmdev_sync, "snapshots", lambda _c: {"o1": first, "o2": second})
    monkeypatch.setattr(clients, "directory", lambda _c: [{"centralId": "c1"}, {"localId": 4}, {"crmdevId": "r9"}])
    monkeypatch.setattr(client_births, "build", lambda _c: {"items": [{}], "dismissed": 0})
    items = [{"org": "o1", "dismissed": False}] * 3 + [{"org": "o2", "dismissed": False}] * 2 + [{"org": None, "dismissed": False}] * 2
    monkeypatch.setattr(crmdev_pending, "build", lambda _c: {"active": True, "items": items + [{"org": "o1", "dismissed": True}],
                                                             "counts": {"client_missing": 2, "project_missing": 5}})
    yield found
    found.close()


def test_counts_from_what_is_kept(connection):
    found = tab_counts.build(connection)
    assert found["clientes"] == 3
    assert found["central"] == {"clientes": 2, "proyectos": 1, "webs": 2, "servidores": 1, "por-crear": 3}  # a client kept here, one of CRMDev, a proposal
    assert found["crmdev"]["central"] == 7  # «Desde Central»: what is pending in CRMDev
    assert found["crmdev"]["clientes"] == 1 and found["crmdev"]["tareas"] == 100 and found["crmdev"]["tareasMore"] is True
    assert found["crmdev"]["tickets"] is None  # not known: the tab shows no number


def test_each_organization_has_its_counters(connection):
    found = tab_counts.build(connection)["crmdevOrgs"]
    assert found["o1"]["clientes"] == 1 and found["o2"]["clientes"] == 2 and found["o2"]["proyectos"] == 1 and found["o2"]["tareas"] == 4
    assert (found["o1"]["central"], found["o2"]["central"]) == (5, 4)  # its own and what has no organization, never the dismissed


def test_without_snapshots_only_the_directory(connection, monkeypatch):
    monkeypatch.setattr(central, "snapshot", lambda _c: None)
    monkeypatch.setattr(crmdev_sync, "snapshot", lambda _c: None)
    monkeypatch.setattr(crmdev_sync, "snapshots", lambda _c: {})
    assert tab_counts.build(connection) == {"clientes": 3, "central": None, "crmdev": None, "crmdevOrgs": {}}
