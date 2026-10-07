import asyncio
import hmac
import math
import os
from datetime import datetime, timedelta, timezone
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from app.database import (
    init_db,
    get_history,
    delete_old_measurements,
)

from app.mqtt import state, start_mqtt_thread, publish_command

from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path


load_dotenv()

# Sterowanie jest wyłączone, dopóki nie ustawisz CONTROL_TOKEN w .env
CONTROL_TOKEN = os.getenv("CONTROL_TOKEN")

# Dozwolone urządzenia -> topic MQTT z komendami
CONTROL_TOPICS = {
    "piec_gazowy": "piec_gazowy/sterowanie",
}


app = FastAPI(title="warcgr")


BASE_DIR = Path(__file__).resolve().parent.parent

app.mount(
    "/web",
    StaticFiles(directory=BASE_DIR / "web"),
    name="web",
)


@app.on_event("startup")
async def startup():
    await init_db()

    await delete_old_measurements(7)

    loop = asyncio.get_running_loop()

    start_mqtt_thread(loop)

    asyncio.create_task(cleanup_loop())


@app.get("/")
async def root():
    return FileResponse(BASE_DIR / "web" / "index.html")


@app.get("/api/status")
async def status():
    return state


@app.get("/api/history")
async def history(topic: str, hours: int = 24, max_points: int = 300):
    if max_points < 10 or max_points > 2000:
        raise HTTPException(
            status_code=400,
            detail="max_points must be between 10 and 2000"
        )

    if hours < 1 or hours > 168:
        raise HTTPException(
            status_code=400,
            detail="hours must be between 1 and 168"
        )

    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    data = await get_history(topic, since)

    return {
        "topic": topic,
        "hours": hours,
        "data": downsample(data, max_points),
    }


def downsample(data, max_points: int):
    if len(data) <= max_points:
        return data

    chunk = math.ceil(len(data) / max_points)
    result = []

    for i in range(0, len(data), chunk):
        part = data[i:i + chunk]
        result.append({
            "timestamp": part[-1]["timestamp"],
            "value": sum(p["value"] for p in part) / len(part),
        })

    return result


class ControlRequest(BaseModel):
    device: Literal["piec_gazowy"]
    command: Literal["ON", "OFF", "AUTO", "MANUAL"]


@app.get("/api/config")
async def config():
    return {"control_enabled": bool(CONTROL_TOKEN)}


@app.post("/api/control")
async def control(
    request: ControlRequest,
    x_control_token: str = Header(default=""),
):
    if not CONTROL_TOKEN:
        raise HTTPException(status_code=503, detail="Sterowanie wyłączone")

    if not hmac.compare_digest(
        x_control_token.encode(), CONTROL_TOKEN.encode()
    ):
        raise HTTPException(status_code=401, detail="Nieprawidłowy token")

    if not publish_command(CONTROL_TOPICS[request.device], request.command):
        raise HTTPException(status_code=503, detail="Brak połączenia z MQTT")

    return {"ok": True}

async def cleanup_loop():
    while True:
        try:
            await delete_old_measurements(7)
            print("Database cleanup completed")
        except Exception as e:
            print("Database cleanup error:", e)

        await asyncio.sleep(3600)