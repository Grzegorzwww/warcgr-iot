import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, HTTPException

from app.database import init_db, get_history
from app.mqtt import state, start_mqtt_thread


app = FastAPI(title="Warcgr IoT")


@app.on_event("startup")
async def startup():
    await init_db()

    loop = asyncio.get_running_loop()
    start_mqtt_thread(loop)


@app.get("/")
async def root():
    return {
        "status": "ok",
        "service": "Warcgr IoT",
    }


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