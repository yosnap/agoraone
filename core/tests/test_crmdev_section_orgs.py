"""The «CRMDev» section by organization: each read and each change goes to the organization chosen, with its own key,
never to another one; an organization AgoraOne does not know is refused before CRMDev is asked."""

import pytest

from test_central_api import HEADERS
from test_crmdev_orgs_assign import KEY2, TwoOrgs, no_pause, setup, two  # noqa: F401 - pytest fixtures
from test_crmdev_write import confirm, empty_cache, preview  # noqa: F401 - pytest fixtures


@pytest.fixture
def section(setup):
    client, _ = setup
    return client


def names(client, view, org=None):
    query = f"?org={org}" if org else ""
    answer = client.get(f"/crmdev/views/{view}{query}", headers=HEADERS)
    assert answer.status_code == 200, answer.text
    return [row.get("name") or row.get("title") for row in answer.json()["items"]]


def test_each_organization_is_read_with_its_own_key(section, two):
    two.second.rows["list_clients"] = [{"id": "z1", "name": "Zeta", "status": "CUSTOMER"}]
    first = names(section, "clientes")
    assert "Zeta" not in first and first == names(section, "clientes", "o1")
    assert names(section, "clientes", "o2") == ["Zeta"]
    assert names(section, "proyectos", "o2") == []


def test_an_unknown_or_odd_organization_is_refused(section, two):
    before = len(two.first.tools()) + len(two.second.tools())
    assert section.get("/crmdev/views/clientes?org=o9", headers=HEADERS).status_code == 409
    assert section.get("/crmdev/views/clientes?org=../x", headers=HEADERS).status_code == 422
    assert section.get("/crmdev/views/clientes?org=o2&org=o1", headers=HEADERS).status_code == 422
    assert section.get("/crmdev/proyectos/p1/horas?org=o9", headers=HEADERS).status_code == 409
    assert len(two.first.tools()) + len(two.second.tools()) == before  # CRMDev was not asked


def test_a_change_goes_only_to_the_organization_chosen(section, two):
    shown = preview(section, {"kind": "tarea-nueva", "org": "o2", "values": {"title": "Revisar SEO"}})
    assert shown.status_code == 200, shown.text
    assert confirm(section, shown.json()["token"]).status_code == 200
    assert [w["tool"] for w in two.second.writes()] == ["create_task"] and two.first.writes() == []
    assert preview(section, {"kind": "tarea-nueva", "org": "o9", "values": {"title": "x"}}).status_code == 409
    assert preview(section, {"kind": "tarea-nueva", "org": 3, "values": {"title": "x"}}).status_code == 422


def test_without_organization_a_change_goes_to_the_first_one(section, two):
    shown = preview(section, {"kind": "tarea-nueva", "values": {"title": "Revisar SEO"}})
    assert confirm(section, shown.json()["token"]).status_code == 200
    assert [w["tool"] for w in two.first.writes()] == ["create_task"] and two.second.writes() == []
