import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, HTTPException

from app.database import (
    init_db,
    get_history,
    delete_old_measurements,
)

from app.mqtt import state, start_mqtt_thread

from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path


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
async def history(topic: str, hours: int = 24):
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
        "data": data,
    }

async def cleanup_loop():
    while True:
        try:
            await delete_old_measurements(7)
            print("Database cleanup completed")
        except Exception as e:
            print("Database cleanup error:", e)

        await asyncio.sleep(3600)