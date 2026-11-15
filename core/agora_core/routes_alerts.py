"""HTTP routes of the reminders: what deserves attention now, their settings, the Contacts permission, and
the notifications due now with their confirmation once shown (by the app as macOS notifications, or by the
interface while it is in front), so none is lost and none is shown twice."""

import re
from contextlib import contextmanager
from typing import Annotated, Literal

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, StrictBool, field_validator

from . import alerts, calls
from .db import DB_NAME, connect
from .settings import Settings


class AlertSettings(BaseModel):
    morning: str | None = None
    quietFrom: str | None = None
    quietTo: str | None = None
    missedCalls: StrictBool | None = None
    meetings: StrictBool | None = None
    commitments: StrictBool | None = None
    summary: StrictBool | None = None
    callsLevel: Literal["normal", "local_only", "private"] | None = None

    @field_validator("morning", "quietFrom", "quietTo")
    @classmethod
    def hour(cls, value: str | None) -> str | None:
        if value is not None and not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", value):
            raise ValueError("hora HH:MM")
        return value


class AckIn(BaseModel):
    keys: list[Annotated[str, Field(min_length=1, max_length=300)]] = Field(max_length=100)


def alerts_router(settings: Settings, call_reader=calls.read_calls) -> APIRouter:
    router = APIRouter()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    def sources() -> dict:
        return {"call_reader": call_reader, "contacts": calls.shared_contacts()}

    @router.get("/alerts")
    async def current():
        def work():
            with database() as connection:
                found = alerts.collect(connection, **sources())
                return {"alerts": found["alerts"], "morning": found["morning"], "problems": found["problems"], "callsProblem": found["callsProblem"],
                        "settings": alerts.settings(connection), "contacts": calls.shared_contacts().status()}
        return await run_in_threadpool(work)

    @router.put("/alerts/settings")
    async def change(body: AlertSettings):
        def work():
            with database() as connection:
                return alerts.save_settings(connection, body.model_dump(exclude_none=True))
        return await run_in_threadpool(work)

    @router.post("/alerts/contacts")
    async def contacts_access():
        return {"contacts": await run_in_threadpool(calls.shared_contacts().request)}

    @router.post("/alerts/full-disk-access")
    async def open_full_disk_access():
        """Opens System Settings at «Full Disk Access» (it cannot be asked for: the user adds AgoraOne there).
        A fixed address; nothing from the request reaches the command."""
        import subprocess

        def run():
            subprocess.run(["/usr/bin/open", "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"], timeout=10, check=False)
        await run_in_threadpool(run)
        return {"ok": True}

    @router.get("/alerts/due")
    async def due():
        def work():
            with database() as connection:
                return alerts.due(connection, **sources())
        return {"notifications": await run_in_threadpool(work)}

    @router.post("/alerts/ack")
    async def ack(body: AckIn):
        def work():
            with database() as connection:
                alerts.ack(connection, body.keys)
        await run_in_threadpool(work)
        return {"ok": True}

    return router
