import asyncio
import hmac
import math
import os
from datetime import datetime, timedelta, timezone
from typing import Union

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from app.database import (
    init_db,
    get_history,
    delete_old_measurements,
    save_setting,
    get_settings,
)

from app.mqtt import state, start_mqtt_thread, publish_command

from fastapi import Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from pathlib import Path


load_dotenv()

# Sterowanie jest wyłączone, dopóki nie ustawisz CONTROL_TOKEN w .env
CONTROL_TOKEN = os.getenv("CONTROL_TOKEN")

DEVICE = "piec_gazowy"

MODES = ["ON", "OFF", "AUTO"]

# Parametry ustawiane z panelu.
# Komenda idzie na  piec_gazowy/<klucz>/set,
# ESP32 potwierdza publikując  piec_gazowy/<klucz>  (retained).
SETTINGS = {
    "temperatura_zadana": {
        "label": "Temperatura zadana",
        "description": "Temperatura otoczenia utrzymywana w trybie AUTO.",
        "unit": "°C",
        "min": 5,
        "max": 30,
        "step": 0.5,
        "default": 21,
        "group": "main",
    },
    "histereza": {
        "label": "Histereza",
        "description": "Piec włącza się poniżej (zadana − histereza), "
                       "wyłącza po osiągnięciu zadanej.",
        "unit": "°C",
        "min": 0.1,
        "max": 5,
        "step": 0.1,
        "default": 0.5,
        "group": "advanced",
    },
    "min_czas_pracy": {
        "label": "Minimalny czas pracy",
        "description": "Piec nie wyłączy się wcześniej niż po tym czasie.",
        "unit": "min",
        "min": 0,
        "max": 60,
        "step": 1,
        "default": 5,
        "group": "advanced",
    },
    "min_czas_postoju": {
        "label": "Minimalny czas postoju",
        "description": "Ochrona przed zbyt częstym taktowaniem pieca.",
        "unit": "min",
        "min": 0,
        "max": 60,
        "step": 1,
        "default": 5,
        "group": "advanced",
    },
    "max_temperatura_wody": {
        "label": "Maks. temperatura wody",
        "description": "Powyżej tej temperatury ESP32 wyłącza piec "
                       "niezależnie od trybu.",
        "unit": "°C",
        "min": 40,
        "max": 90,
        "step": 1,
        "default": 80,
        "group": "advanced",
    },
}


app = FastAPI(title="warcgr")


BASE_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = BASE_DIR / "web"


# Bez tego Cloudflare/przeglądarka trzymają stare app.js/style.css
@app.middleware("http")
async def no_cache_static(request: Request, call_next):
    response = await call_next(request)

    if request.url.path == "/" or request.url.path.startswith("/web/"):
        response.headers["Cache-Control"] = "no-cache"

    return response


app.mount(
    "/web",
    StaticFiles(directory=WEB_DIR),
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
    # Wersja plików w URL (?v=...) wymusza pobranie nowych po każdej zmianie
    version = int(max(p.stat().st_mtime for p in WEB_DIR.iterdir()))
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")

    return HTMLResponse(html.replace("__V__", str(version)))


@app.get("/api/desired")
async def desired():
    return await get_settings()


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


class SetRequest(BaseModel):
    key: str
    value: Union[float, str]


def check_token(token: str):
    if not CONTROL_TOKEN:
        raise HTTPException(status_code=503, detail="Sterowanie wyłączone")

    if not hmac.compare_digest(token.encode(), CONTROL_TOKEN.encode()):
        raise HTTPException(status_code=401, detail="Nieprawidłowy token")


@app.get("/api/config")
async def config():
    return {
        "control_enabled": bool(CONTROL_TOKEN),
        "device": DEVICE,
        "modes": MODES,
        "settings": SETTINGS,
    }


@app.post("/api/auth")
async def auth(x_control_token: str = Header(default="")):
    check_token(x_control_token)

    return {"ok": True}


@app.post("/api/set")
async def set_value(
    request: SetRequest,
    x_control_token: str = Header(default=""),
):
    check_token(x_control_token)

    if request.key == "tryb":
        if request.value not in MODES:
            raise HTTPException(status_code=400, detail="Nieznany tryb")

        payload = request.value

    elif request.key in SETTINGS:
        spec = SETTINGS[request.key]

        try:
            value = float(request.value)
        except ValueError:
            raise HTTPException(status_code=400, detail="Wartość musi być liczbą")

        if not math.isfinite(value) or not spec["min"] <= value <= spec["max"]:
            raise HTTPException(
                status_code=400,
                detail=f"{spec['label']}: dozwolony zakres "
                       f"{spec['min']}–{spec['max']} {spec['unit']}"
            )

        payload = f"{value:g}"

    else:
        raise HTTPException(status_code=400, detail="Nieznany parametr")

    if not publish_command(f"{DEVICE}/{request.key}/set", payload):
        raise HTTPException(status_code=503, detail="Brak połączenia z MQTT")

    await save_setting(request.key, payload)

    return {"ok": True, "value": payload}


async def cleanup_loop():
    while True:
        try:
            await delete_old_measurements(7)
            print("Database cleanup completed")
        except Exception as e:
            print("Database cleanup error:", e)

        await asyncio.sleep(3600)