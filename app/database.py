import aiosqlite
from pathlib import Path
from datetime import datetime, timezone, timedelta


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "iot.db"


async def init_db():
    DATA_DIR.mkdir(exist_ok=True)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS measurements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                topic TEXT NOT NULL,
                value REAL NOT NULL
            )
        """)

        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_measurements_topic_timestamp
            ON measurements(topic, timestamp)
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)

        await db.commit()


async def save_setting(key: str, value: str):
    updated_at = datetime.now(timezone.utc).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO settings (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            """,
            (key, value, updated_at)
        )

        await db.commit()


async def get_settings():
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT key, value, updated_at FROM settings"
        )

        rows = await cursor.fetchall()
        await cursor.close()

    return {
        key: {"value": value, "updated_at": updated_at}
        for key, value, updated_at in rows
    }


async def save_measurement(topic: str, value: float):
    timestamp = datetime.now(timezone.utc).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO measurements (timestamp, topic, value)
            VALUES (?, ?, ?)
            """,
            (timestamp, topic, value)
        )

        await db.commit()


async def get_history(topic: str, since: datetime):
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            """
            SELECT timestamp, value
            FROM measurements
            WHERE topic = ?
              AND timestamp >= ?
            ORDER BY timestamp ASC
            """,
            (topic, since.isoformat())
        )

        rows = await cursor.fetchall()
        await cursor.close()

    return [
        {
            "timestamp": timestamp,
            "value": value
        }
        for timestamp, value in rows
    ]

async def delete_old_measurements(days: int = 7):
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            DELETE FROM measurements
            WHERE timestamp < ?
            """,
            (cutoff.isoformat(),)
        )
        await db.commit()