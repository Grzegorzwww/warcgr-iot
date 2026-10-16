from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import aiosqlite


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"

# Osobna baza – nie dotyka data/iot.db używanej przez iot.warcgr.pl
DB_PATH = DATA_DIR / "portal.db"

SESSION_DAYS = 30
READINGS_RETENTION_DAYS = 7


def _now() -> datetime:
    return datetime.now(timezone.utc)


@asynccontextmanager
async def _db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA foreign_keys = ON")
        yield db


async def init_db():
    async with _db() as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token_hash TEXT NOT NULL UNIQUE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS devices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                token TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                timestamp TEXT NOT NULL,
                metric TEXT NOT NULL,
                value REAL NOT NULL
            )
        """)

        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_readings_device_metric_ts
            ON readings(device_id, metric, timestamp)
        """)

        await db.commit()


# ---------- Użytkownicy i sesje ----------

async def create_user(email: str, password_hash: str):
    """Zwraca id nowego użytkownika albo None, gdy e-mail jest już zajęty."""
    try:
        async with _db() as db:
            cursor = await db.execute(
                "INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)",
                (email, password_hash, _now().isoformat()),
            )
            await db.commit()

            return cursor.lastrowid
    except aiosqlite.IntegrityError:
        return None


async def get_user_by_email(email: str):
    async with _db() as db:
        cursor = await db.execute(
            "SELECT id, email, password_hash FROM users WHERE email = ?",
            (email,),
        )
        row = await cursor.fetchone()
        await cursor.close()

    if row is None:
        return None

    return {"id": row[0], "email": row[1], "password_hash": row[2]}


async def create_session(user_id: int, token_hash: str):
    expires = _now() + timedelta(days=SESSION_DAYS)

    async with _db() as db:
        await db.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (token_hash, user_id, expires.isoformat()),
        )
        await db.commit()


async def get_session_user(token_hash: str):
    async with _db() as db:
        cursor = await db.execute(
            """
            SELECT users.id, users.email
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ?
              AND sessions.expires_at > ?
            """,
            (token_hash, _now().isoformat()),
        )
        row = await cursor.fetchone()
        await cursor.close()

    if row is None:
        return None

    return {"id": row[0], "email": row[1]}


async def delete_session(token_hash: str):
    async with _db() as db:
        await db.execute(
            "DELETE FROM sessions WHERE token_hash = ?",
            (token_hash,),
        )
        await db.commit()


# ---------- Urządzenia ----------

async def list_devices(user_id: int):
    async with _db() as db:
        cursor = await db.execute(
            """
            SELECT id, name, token, created_at
            FROM devices
            WHERE user_id = ?
            ORDER BY id
            """,
            (user_id,),
        )
        rows = await cursor.fetchall()
        await cursor.close()

    return [
        {"id": r[0], "name": r[1], "token": r[2], "created_at": r[3]}
        for r in rows
    ]


async def get_device(user_id: int, device_id: int):
    async with _db() as db:
        cursor = await db.execute(
            """
            SELECT id, name, token, created_at
            FROM devices
            WHERE id = ? AND user_id = ?
            """,
            (device_id, user_id),
        )
        row = await cursor.fetchone()
        await cursor.close()

    if row is None:
        return None

    return {"id": row[0], "name": row[1], "token": row[2], "created_at": row[3]}


async def count_devices(user_id: int) -> int:
    async with _db() as db:
        cursor = await db.execute(
            "SELECT COUNT(*) FROM devices WHERE user_id = ?",
            (user_id,),
        )
        row = await cursor.fetchone()
        await cursor.close()

    return row[0]


async def create_device(user_id: int, name: str, token: str):
    created_at = _now().isoformat()

    async with _db() as db:
        cursor = await db.execute(
            "INSERT INTO devices (user_id, name, token, created_at) VALUES (?, ?, ?, ?)",
            (user_id, name, token, created_at),
        )
        await db.commit()

        device_id = cursor.lastrowid

    return {"id": device_id, "name": name, "token": token, "created_at": created_at}


async def delete_device(user_id: int, device_id: int):
    """Zwraca token usuniętego urządzenia albo None, gdy nie należy do użytkownika."""
    device = await get_device(user_id, device_id)

    if device is None:
        return None

    async with _db() as db:
        await db.execute(
            "DELETE FROM devices WHERE id = ? AND user_id = ?",
            (device_id, user_id),
        )
        await db.commit()

    return device["token"]


async def load_all_tokens():
    async with _db() as db:
        cursor = await db.execute("SELECT token, id FROM devices")
        rows = await cursor.fetchall()
        await cursor.close()

    return {token: device_id for token, device_id in rows}


# ---------- Pomiary ----------

async def save_reading(device_id: int, metric: str, value: float):
    async with _db() as db:
        await db.execute(
            "INSERT INTO readings (device_id, timestamp, metric, value) VALUES (?, ?, ?, ?)",
            (device_id, _now().isoformat(), metric, value),
        )
        await db.commit()


async def get_readings(device_id: int, metric: str, since: datetime):
    async with _db() as db:
        cursor = await db.execute(
            """
            SELECT timestamp, value
            FROM readings
            WHERE device_id = ?
              AND metric = ?
              AND timestamp >= ?
            ORDER BY timestamp ASC
            """,
            (device_id, metric, since.isoformat()),
        )
        rows = await cursor.fetchall()
        await cursor.close()

    return [{"timestamp": ts, "value": value} for ts, value in rows]


async def cleanup():
    now = _now()
    cutoff = now - timedelta(days=READINGS_RETENTION_DAYS)

    async with _db() as db:
        await db.execute(
            "DELETE FROM readings WHERE timestamp < ?",
            (cutoff.isoformat(),),
        )
        await db.execute(
            "DELETE FROM sessions WHERE expires_at < ?",
            (now.isoformat(),),
        )
        await db.commit()
