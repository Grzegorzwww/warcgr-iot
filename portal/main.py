import asyncio
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from portal import db, ingest
from portal.device_types import DEFAULT_DEVICE_TYPE, DEVICE_TYPES
from portal.security import (
    DUMMY_HASH,
    MAX_PASSWORD_LENGTH,
    MIN_PASSWORD_LENGTH,
    Throttle,
    hash_password,
    hash_session_token,
    new_device_token,
    new_session_token,
    normalize_email,
    verify_password,
)
from portal.stats import downsample, hourly_consumption


load_dotenv()

# Za Cloudflare Tunnel (HTTPS) ciasteczko ma być Secure.
# Do testów lokalnych po http ustaw PORTAL_COOKIE_SECURE=0.
COOKIE_SECURE = os.getenv("PORTAL_COOKIE_SECURE", "1") != "0"
COOKIE_NAME = "portal_session"
CSRF_HEADER_VALUE = "warcgr-portal"

MAX_DEVICES_PER_USER = 10

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"

login_ip_throttle = Throttle(limit=20, window_seconds=300)
login_email_throttle = Throttle(limit=8, window_seconds=300)
register_throttle = Throttle(limit=5, window_seconds=3600)


async def cleanup_loop():
    while True:
        await asyncio.sleep(3600)

        try:
            await db.cleanup()
        except Exception as error:
            print("Portal cleanup error:", error)

        for throttle in (login_ip_throttle, login_email_throttle, register_throttle):
            throttle.prune()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db()
    await db.cleanup()

    ingest.set_known_tokens(await db.load_all_tokens())
    ingest.start_mqtt_thread(asyncio.get_running_loop())

    task = asyncio.create_task(cleanup_loop())

    yield

    task.cancel()


# Serwis publiczny – bez /docs i /openapi.json
app = FastAPI(
    title="warcgr-portal",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)

    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "frame-ancestors 'none'; "
        "base-uri 'none'; "
        "form-action 'self'"
    )

    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"

    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"

    return response


app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.get("/")
async def root():
    version = int(max(p.stat().st_mtime for p in WEB_DIR.iterdir()))
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")

    return HTMLResponse(html.replace("__V__", str(version)))


# ---------- Pomocnicze ----------

def client_ip(request: Request) -> str:
    # Serwis stoi za Cloudflare Tunnel, który ustawia ten nagłówek
    return (
        request.headers.get("cf-connecting-ip")
        or (request.client.host if request.client else "unknown")
    )


def require_csrf(x_requested_with: str = Header(default="")):
    # Dodatkowa ochrona przed CSRF obok SameSite=Lax: żądania zmieniające stan
    # muszą mieć własny nagłówek, którego nie wyślą formularze z obcych stron.
    if x_requested_with != CSRF_HEADER_VALUE:
        raise HTTPException(status_code=403, detail="Brak nagłówka zabezpieczającego")


async def current_user(
    session: Optional[str] = Cookie(default=None, alias=COOKIE_NAME),
):
    if not session:
        raise HTTPException(status_code=401, detail="Wymagane logowanie")

    user = await db.get_session_user(hash_session_token(session))

    if user is None:
        raise HTTPException(status_code=401, detail="Sesja wygasła")

    return user


async def start_session(response: Response, user_id: int):
    token = new_session_token()

    await db.create_session(user_id, hash_session_token(token))

    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=db.SESSION_DAYS * 86400,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def device_view(device: dict) -> dict:
    token = device["token"]
    type_config = DEVICE_TYPES.get(device["device_type"], {})

    return {
        **device,
        "online": ingest.is_online(token),
        "latest": ingest.latest.get(token, {}),
        "type_label": type_config.get("label", device["device_type"]),
    }


# ---------- Konta ----------

class Credentials(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=MAX_PASSWORD_LENGTH)


@app.post("/api/register", dependencies=[Depends(require_csrf)])
async def register(creds: Credentials, request: Request, response: Response):
    if not register_throttle.allow(client_ip(request)):
        raise HTTPException(status_code=429, detail="Zbyt wiele prób, spróbuj później")

    email = normalize_email(creds.email)

    if email is None:
        raise HTTPException(status_code=400, detail="Nieprawidłowy adres e-mail")

    if len(creds.password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Hasło musi mieć co najmniej {MIN_PASSWORD_LENGTH} znaków",
        )

    password_hash = await asyncio.to_thread(hash_password, creds.password)
    user_id = await db.create_user(email, password_hash)

    if user_id is None:
        raise HTTPException(status_code=409, detail="Konto z tym adresem już istnieje")

    await start_session(response, user_id)

    return {"email": email}


@app.post("/api/login", dependencies=[Depends(require_csrf)])
async def login(creds: Credentials, request: Request, response: Response):
    email = normalize_email(creds.email)

    if (
        not login_ip_throttle.allow(client_ip(request))
        or not login_email_throttle.allow(email or creds.email.strip().lower())
    ):
        raise HTTPException(status_code=429, detail="Zbyt wiele prób, spróbuj później")

    user = await db.get_user_by_email(email) if email else None

    # Weryfikujemy zawsze (także dla nieistniejącego konta), żeby czas odpowiedzi
    # nie zdradzał, czy taki e-mail jest zarejestrowany
    stored = user["password_hash"] if user else DUMMY_HASH
    valid = await asyncio.to_thread(verify_password, creds.password, stored)

    if user is None or not valid:
        raise HTTPException(status_code=401, detail="Nieprawidłowy e-mail lub hasło")

    await start_session(response, user["id"])

    return {"email": user["email"]}


@app.post("/api/logout", dependencies=[Depends(require_csrf)])
async def logout(
    response: Response,
    session: Optional[str] = Cookie(default=None, alias=COOKIE_NAME),
):
    if session:
        await db.delete_session(hash_session_token(session))

    response.delete_cookie(COOKIE_NAME, path="/")

    return {"ok": True}


@app.get("/api/me")
async def me(user: dict = Depends(current_user)):
    return {"email": user["email"]}


# ---------- Urządzenia ----------

class DeviceCreate(BaseModel):
    name: str = Field(max_length=40)
    device_type: str = Field(default=DEFAULT_DEVICE_TYPE, max_length=20)


@app.get("/api/devices")
async def list_devices(user: dict = Depends(current_user)):
    devices = await db.list_devices(user["id"])

    return [device_view(d) for d in devices]


@app.post("/api/devices", dependencies=[Depends(require_csrf)])
async def add_device(body: DeviceCreate, user: dict = Depends(current_user)):
    name = body.name.strip()

    if not name:
        raise HTTPException(status_code=400, detail="Podaj nazwę urządzenia")

    if body.device_type not in DEVICE_TYPES:
        raise HTTPException(status_code=400, detail="Nieznany typ czujnika")

    if await db.count_devices(user["id"]) >= MAX_DEVICES_PER_USER:
        raise HTTPException(
            status_code=400,
            detail=f"Maksymalna liczba urządzeń: {MAX_DEVICES_PER_USER}",
        )

    device = await db.create_device(user["id"], name, new_device_token(), body.device_type)
    ingest.register_token(device["token"], device["id"], device["device_type"])

    return device_view(device)


@app.delete("/api/devices/{device_id}", dependencies=[Depends(require_csrf)])
async def remove_device(device_id: int, user: dict = Depends(current_user)):
    token = await db.delete_device(user["id"], device_id)

    if token is None:
        raise HTTPException(status_code=404, detail="Nie znaleziono urządzenia")

    ingest.forget_token(token)

    return {"ok": True}


async def owned_device(device_id: int, user: dict) -> dict:
    device = await db.get_device(user["id"], device_id)

    if device is None:
        raise HTTPException(status_code=404, detail="Nie znaleziono urządzenia")

    return device


@app.get("/api/devices/{device_id}/history")
async def history(
    device_id: int,
    metric: str,
    hours: int = 24,
    max_points: int = 300,
    user: dict = Depends(current_user),
):
    device = await owned_device(device_id, user)
    type_config = DEVICE_TYPES.get(device["device_type"])

    if type_config is None or metric not in type_config["history_metrics"]:
        raise HTTPException(status_code=400, detail="Nieznana metryka")

    if hours < 1 or hours > 168:
        raise HTTPException(status_code=400, detail="hours must be between 1 and 168")

    if max_points < 10 or max_points > 2000:
        raise HTTPException(status_code=400, detail="max_points must be between 10 and 2000")

    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    data = await db.get_readings(device_id, metric, since)

    return {"metric": metric, "hours": hours, "data": downsample(data, max_points)}


@app.get("/api/devices/{device_id}/hourly")
async def hourly(
    device_id: int,
    hours: int = 24,
    user: dict = Depends(current_user),
):
    device = await owned_device(device_id, user)
    type_config = DEVICE_TYPES.get(device["device_type"])
    hourly_metric = type_config.get("hourly_metric") if type_config else None

    if hourly_metric is None:
        raise HTTPException(status_code=400, detail="Niedostępne dla tego typu czujnika")

    if hours < 1 or hours > 168:
        raise HTTPException(status_code=400, detail="hours must be between 1 and 168")

    # +2h zapasu: potrzebny ostatni odczyt sprzed pierwszej godziny okna
    since = datetime.now(timezone.utc) - timedelta(hours=hours + 2)
    rows = await db.get_readings(device_id, hourly_metric, since)

    return {"hours": hours, "data": hourly_consumption(rows, hours)}
