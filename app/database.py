import aiosqlite
from pathlib import Path
from datetime import datetime, timezone


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

        await db.commit()


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