import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from portal import db, ingest
from portal.main import DeviceCreate
from pydantic import ValidationError
from portal.device_types import DEVICE_TYPES
from portal.security import (
    Throttle,
    hash_password,
    hash_session_token,
    new_device_token,
    normalize_email,
    verify_password,
)
from portal.stats import (
    daily_consumption,
    downsample,
    hourly_consumption,
    power_stats,
    temperature_trend,
    usage_pattern,
)


class SecurityTests(unittest.TestCase):
    def test_password_roundtrip(self):
        stored = hash_password("tajne-haslo-123")

        self.assertTrue(verify_password("tajne-haslo-123", stored))
        self.assertFalse(verify_password("inne-haslo", stored))
        self.assertNotIn("tajne-haslo-123", stored)

    def test_password_hashes_are_salted(self):
        self.assertNotEqual(hash_password("abc12345"), hash_password("abc12345"))

    def test_verify_rejects_malformed_hash(self):
        self.assertFalse(verify_password("x", "nie-hash"))
        self.assertFalse(verify_password("x", "bcrypt$1$2$3$aa$bb"))
        self.assertFalse(verify_password("x", "scrypt$a$b$c$zz$yy"))

    def test_normalize_email(self):
        self.assertEqual(normalize_email("  Jan.Kowalski@Gmail.com "), "jan.kowalski@gmail.com")
        self.assertIsNone(normalize_email("bez-malpy"))
        self.assertIsNone(normalize_email("a@b"))
        self.assertIsNone(normalize_email("a b@c.pl"))
        self.assertIsNone(normalize_email("a@" + "b" * 300 + ".pl"))

    def test_device_token_is_long_unique_and_mqtt_safe(self):
        tokens = {new_device_token() for _ in range(200)}

        self.assertEqual(len(tokens), 200)

        for token in tokens:
            self.assertGreaterEqual(len(token), 32)
            self.assertTrue(set(token) <= set(
                "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
            ))

    def test_session_token_hash_is_stable_and_hides_token(self):
        self.assertEqual(hash_session_token("abc"), hash_session_token("abc"))
        self.assertNotIn("abc", hash_session_token("abc"))

    def test_throttle_blocks_after_limit(self):
        throttle = Throttle(limit=3, window_seconds=60)

        self.assertTrue(all(throttle.allow("k") for _ in range(3)))
        self.assertFalse(throttle.allow("k"))
        self.assertTrue(throttle.allow("inny"))


class DeviceCreateTests(unittest.TestCase):
    def test_device_type_is_required(self):
        # Brak typu nie może po cichu dać "prad" (tak powstały błędne urządzenia)
        with self.assertRaises(ValidationError):
            DeviceCreate(name="temp")

    def test_device_type_is_kept(self):
        self.assertEqual(DeviceCreate(name="temp", device_type="woda").device_type, "woda")


class IngestTests(unittest.TestCase):
    def setUp(self):
        ingest.set_known_tokens({
            "tok123": {"device_id": 7, "device_type": "prad"},
            "tokw1": {"device_id": 9, "device_type": "woda"},
        })
        ingest.latest.clear()
        ingest.last_seen.clear()

    def test_parse_topic(self):
        self.assertEqual(ingest.parse_topic("tok123/zurzycie_pradu", "prad"), "kwh")
        self.assertEqual(ingest.parse_topic("tok123/zurzycie_pradu/kwh", "prad"), "kwh")
        self.assertEqual(ingest.parse_topic("tok123/zurzycie_pradu/power_w", "prad"), "power_w")
        self.assertIsNone(ingest.parse_topic("tok123/zurzycie_pradu/set", "prad"))
        self.assertIsNone(ingest.parse_topic("tok123/zurzycie_pradu/nieznana", "prad"))
        self.assertIsNone(ingest.parse_topic("tok123/inny/kwh", "prad"))
        self.assertIsNone(ingest.parse_topic("zurzycie_pradu", "prad"))
        self.assertIsNone(ingest.parse_topic("/zurzycie_pradu/kwh", "prad"))
        self.assertIsNone(ingest.parse_topic("a/b/zurzycie_pradu/kwh", "prad"))

        # topic należący do innego typu czujnika -> ignorowany
        self.assertIsNone(ingest.parse_topic("tokw1/zurzycie_pradu/kwh", "woda"))

    def test_parse_topic_water_sensor(self):
        self.assertEqual(ingest.parse_topic("tokw1/temperatura_wody", "woda"), "temperatura")
        self.assertEqual(ingest.parse_topic("tokw1/temperatura_wody/temperatura", "woda"), "temperatura")
        self.assertIsNone(ingest.parse_topic("tokw1/temperatura_wody/inna", "woda"))
        self.assertIsNone(ingest.parse_topic("tokw1/zurzycie_pradu", "woda"))

    def test_known_token_updates_state(self):
        result = ingest.process_message("tok123/zurzycie_pradu/power_w", " 250.5 ")

        self.assertEqual(result, (7, "prad", "power_w", 250.5))
        self.assertEqual(ingest.latest["tok123"]["power_w"], "250.5")
        self.assertTrue(ingest.is_online("tok123"))

    def test_water_sensor_updates_state(self):
        result = ingest.process_message("tokw1/temperatura_wody", "42.3")

        self.assertEqual(result, (9, "woda", "temperatura", 42.3))
        self.assertEqual(ingest.latest["tokw1"]["temperatura"], "42.3")
        self.assertTrue(ingest.is_online("tokw1"))

    def test_topic_mismatched_with_device_type_is_ignored(self):
        # Token zarejestrowany jako czujnik wody, ale publikuje na topicu prądu
        self.assertIsNone(ingest.process_message("tokw1/zurzycie_pradu/kwh", "1"))
        # i odwrotnie
        self.assertIsNone(ingest.process_message("tok123/temperatura_wody", "20"))

    def test_unknown_token_is_ignored(self):
        # W tym także własne urządzenie z iot.warcgr.pl (wesola88/zurzycie_pradu/...)
        self.assertIsNone(ingest.process_message("wesola88/zurzycie_pradu/kwh", "100"))
        self.assertIsNone(ingest.process_message("obcy/zurzycie_pradu/kwh", "100"))
        self.assertEqual(ingest.latest, {})

    def test_invalid_payloads_are_ignored(self):
        for payload in ["", "abc", "nan", "inf", "1" * 40]:
            self.assertIsNone(
                ingest.process_message("tok123/zurzycie_pradu/kwh", payload),
                payload,
            )

    def test_forget_token(self):
        ingest.process_message("tok123/zurzycie_pradu/kwh", "1")
        ingest.forget_token("tok123")

        self.assertIsNone(ingest.process_message("tok123/zurzycie_pradu/kwh", "2"))
        self.assertFalse(ingest.is_online("tok123"))

    def test_stored_metrics_match_declared_history_metrics(self):
        # Spojność konfiguracji: wszystko czego używamy do wykresów musi być zapisywane
        for config in DEVICE_TYPES.values():
            self.assertTrue(config["history_metrics"] <= config["stored_metrics"])


class StatsTests(unittest.TestCase):
    def test_hourly_consumption_from_differences(self):
        rows = [
            {"timestamp": "2026-10-16T10:05:00+00:00", "value": 100.0},
            {"timestamp": "2026-10-16T10:55:00+00:00", "value": 100.5},
            {"timestamp": "2026-10-16T11:30:00+00:00", "value": 101.2},
            {"timestamp": "2026-10-16T12:10:00+00:00", "value": 101.7},
        ]

        result = hourly_consumption(rows, 24)

        self.assertEqual([r["kwh"] for r in result], [0.7, 0.5])

    def test_hourly_consumption_skips_gaps_and_resets(self):
        rows = [
            {"timestamp": "2026-10-16T08:00:00+00:00", "value": 100.0},
            {"timestamp": "2026-10-16T11:00:00+00:00", "value": 103.0},
            {"timestamp": "2026-10-16T12:00:00+00:00", "value": 0.0},
        ]

        result = hourly_consumption(rows, 24)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["kwh"], 0.0)

    def test_downsample(self):
        data = [{"timestamp": str(i), "value": float(i)} for i in range(1000)]

        self.assertLessEqual(len(downsample(data, 100)), 100)
        self.assertEqual(downsample(data[:5], 100), data[:5])

    def test_downsample_keeps_peaks(self):
        data = [{"timestamp": str(i), "value": 100.0} for i in range(5000)]
        data[2345]["value"] = 3795.0
        data[4000]["value"] = 5.0

        result = downsample(data, 300)

        self.assertLessEqual(len(result), 300)
        self.assertEqual(max(p["value"] for p in result), 3795.0)
        self.assertEqual(min(p["value"] for p in result), 5.0)
        self.assertEqual([p["timestamp"] for p in result], sorted((p["timestamp"] for p in result), key=int))

    def test_power_stats_time_weighted(self):
        now = datetime(2026, 10, 16, 12, 0, tzinfo=timezone.utc)
        # 1 W przez 9 minut, potem 2000 W przez 1 minutę (z gęstymi próbkami)
        rows = [{"timestamp": "2026-10-16T11:50:00+00:00", "value": 100.0}]
        rows += [
            {"timestamp": (datetime(2026, 10, 16, 11, 59, tzinfo=timezone.utc) + timedelta(seconds=s)).isoformat(),
             "value": 2000.0}
            for s in range(0, 60, 5)
        ]

        stats = power_stats(rows, now)

        self.assertEqual(stats["max"], 2000.0)
        self.assertEqual(stats["max_at"], rows[1]["timestamp"])
        # średnia ważona czasem: (100*540 + 2000*60) / 600 = 290, a nie ~1900 z samych próbek
        self.assertAlmostEqual(stats["avg"], 290.0, delta=1.0)
        self.assertAlmostEqual(stats["hours_above"], 60 / 3600, places=4)
        self.assertEqual(power_stats([], now)["max"], None)

    def test_hourly_consumption_complete_only(self):
        rows = [
            {"timestamp": "2026-10-16T09:58:00+00:00", "value": 10.0},
            {"timestamp": "2026-10-16T10:58:00+00:00", "value": 10.3},
            {"timestamp": "2026-10-16T11:59:00+00:00", "value": 10.6},
            # bieżąca, niepełna godzina
            {"timestamp": "2026-10-16T12:05:00+00:00", "value": 10.62},
        ]

        self.assertEqual(len(hourly_consumption(rows, 24)), 3)

        complete = hourly_consumption(rows, 24, complete_only=True)

        self.assertEqual([h["kwh"] for h in complete], [0.3, 0.3])

    def test_usage_pattern(self):
        tz = ZoneInfo("Europe/Warsaw")
        base = datetime(2026, 10, 14, 0, 0, tzinfo=timezone.utc)
        hourly = []

        for i in range(48):
            hour = base + timedelta(hours=i)
            local_hour = hour.astimezone(tz).hour
            hourly.append({"hour": hour.isoformat(), "kwh": 0.5 if local_hour == 19 else 0.1})

        pattern = usage_pattern(hourly, tz)

        self.assertEqual(pattern["peak_hour"], 19)
        self.assertEqual(pattern["peak_hour_w"], 500.0)
        self.assertIsNotNone(pattern["night_share_pct"])
        self.assertIsNone(usage_pattern(hourly[:5], tz)["peak_hour"])

    def test_daily_consumption_sums_per_local_day(self):
        tz = ZoneInfo("Europe/Warsaw")
        now = datetime(2026, 10, 16, 12, 0, tzinfo=timezone.utc)
        rows = [
            # 14.10 23:30 czasu polskiego (21:30 UTC) – odczyt bazowy
            {"timestamp": "2026-10-14T21:30:00+00:00", "value": 100.0},
            # 15.10 00:30 czasu polskiego – już 15.10
            {"timestamp": "2026-10-14T22:30:00+00:00", "value": 100.5},
            {"timestamp": "2026-10-15T20:00:00+00:00", "value": 104.0},
            # przerwa w danych – energia nie może zginąć
            {"timestamp": "2026-10-16T06:00:00+00:00", "value": 105.0},
            # ręczna zmiana stanu licznika – pomijana
            {"timestamp": "2026-10-16T07:00:00+00:00", "value": 9000.0},
            {"timestamp": "2026-10-16T08:00:00+00:00", "value": 9000.4},
        ]

        days = daily_consumption(rows, tz, 3, now)

        self.assertEqual([d["date"] for d in days], ["2026-10-14", "2026-10-15", "2026-10-16"])
        self.assertIsNone(days[0]["kwh"])
        self.assertEqual(days[1]["kwh"], 4.0)
        self.assertEqual(days[2]["kwh"], 1.4)
        self.assertTrue(days[1]["complete"])
        self.assertFalse(days[2]["complete"])

    def test_daily_consumption_ignores_counter_decrease(self):
        now = datetime(2026, 10, 16, 12, 0, tzinfo=timezone.utc)
        rows = [
            {"timestamp": "2026-10-16T08:00:00+00:00", "value": 50.0},
            {"timestamp": "2026-10-16T09:00:00+00:00", "value": 10.0},
            {"timestamp": "2026-10-16T10:00:00+00:00", "value": 10.5},
        ]

        days = daily_consumption(rows, timezone.utc, 1, now)

        self.assertEqual(days[0]["kwh"], 0.5)

    def test_temperature_trend(self):
        now = datetime(2026, 10, 16, 12, 0, tzinfo=timezone.utc)
        rows = [
            {"timestamp": (now - timedelta(minutes=m)).isoformat(), "value": 50.0 - m / 10}
            for m in (60, 20, 15, 10, 5, 0)
        ]

        # 0,1 °C na minutę = 6 °C/h; odczyt sprzed godziny jest poza oknem
        self.assertEqual(temperature_trend(rows, now), 6.0)
        self.assertIsNone(temperature_trend(rows[:2], now))


class DatabaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.original_path = db.DB_PATH
        db.DB_PATH = Path(self.tmp.name) / "portal.db"

        await db.init_db()

    async def asyncTearDown(self):
        db.DB_PATH = self.original_path
        self.tmp.cleanup()

    async def test_duplicate_email_is_rejected(self):
        self.assertIsNotNone(await db.create_user("a@b.pl", "hash"))
        self.assertIsNone(await db.create_user("a@b.pl", "hash2"))

    async def test_session_lifecycle(self):
        user_id = await db.create_user("a@b.pl", "hash")
        token_hash = hash_session_token("sekret")

        await db.create_session(user_id, token_hash)

        user = await db.get_session_user(token_hash)
        self.assertEqual(user["email"], "a@b.pl")
        self.assertIsNone(await db.get_session_user(hash_session_token("zly")))

        await db.delete_session(token_hash)
        self.assertIsNone(await db.get_session_user(token_hash))

    async def test_users_cannot_access_foreign_devices(self):
        alice = await db.create_user("alice@x.pl", "h")
        bob = await db.create_user("bob@x.pl", "h")
        device = await db.create_device(alice, "Garaż", "tok-alice", "prad")

        self.assertIsNotNone(await db.get_device(alice, device["id"]))
        self.assertIsNone(await db.get_device(bob, device["id"]))
        self.assertIsNone(await db.delete_device(bob, device["id"]))
        self.assertEqual(await db.list_devices(bob), [])
        self.assertEqual(await db.count_devices(alice), 1)

    async def test_delete_device_removes_readings(self):
        user = await db.create_user("a@b.pl", "h")
        device = await db.create_device(user, "Licznik", "tok1", "prad")

        await db.save_reading(device["id"], "kwh", 12.5)
        since = datetime.now(timezone.utc) - timedelta(hours=1)
        self.assertEqual(len(await db.get_readings(device["id"], "kwh", since)), 1)

        self.assertEqual(await db.delete_device(user, device["id"]), "tok1")
        self.assertEqual(await db.get_readings(device["id"], "kwh", since), [])
        self.assertEqual(await db.load_all_tokens(), {})

    async def test_cleanup_removes_old_readings(self):
        user = await db.create_user("a@b.pl", "h")
        device = await db.create_device(user, "Licznik", "tok1", "prad")

        async with db._db() as conn:
            old = datetime.now(timezone.utc) - timedelta(days=30)
            await conn.execute(
                "INSERT INTO readings (device_id, timestamp, metric, value) VALUES (?, ?, 'kwh', 1)",
                (device["id"], old.isoformat()),
            )
            await conn.commit()

        await db.save_reading(device["id"], "kwh", 2.0)
        await db.cleanup()

        since = datetime.now(timezone.utc) - timedelta(days=60)
        rows = await db.get_readings(device["id"], "kwh", since)

        self.assertEqual([r["value"] for r in rows], [2.0])

    async def test_create_device_stores_device_type(self):
        user = await db.create_user("a@b.pl", "h")
        device = await db.create_device(user, "Czujnik wody", "tokw", "woda")

        self.assertEqual(device["device_type"], "woda")

        stored = await db.get_device(user, device["id"])
        self.assertEqual(stored["device_type"], "woda")

        listed = await db.list_devices(user)
        self.assertEqual(listed[0]["device_type"], "woda")

        tokens = await db.load_all_tokens()
        self.assertEqual(tokens["tokw"], {"device_id": device["id"], "device_type": "woda"})

    async def test_init_db_migrates_devices_table_missing_device_type(self):
        # Symulujemy bazę założoną przed wprowadzeniem typów czujników (bez kolumny device_type)
        async with db._db() as conn:
            await conn.execute("DROP TABLE devices")
            await conn.execute("""
                CREATE TABLE devices (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    token TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL
                )
            """)
            await conn.commit()

        await db.init_db()

        user = await db.create_user("stary@x.pl", "h")
        device = await db.create_device(user, "Stare urządzenie", "tok-stary", "prad")

        self.assertEqual(device["device_type"], "prad")

    async def test_update_device_name_and_price(self):
        alice = await db.create_user("alice@x.pl", "h")
        bob = await db.create_user("bob@x.pl", "h")
        device = await db.create_device(alice, "Licznik", "tok1", "prad")

        self.assertIsNone(device["price_per_kwh"])

        updated = await db.update_device(alice, device["id"], {"name": "Dom", "price_per_kwh": 1.1})
        self.assertEqual(updated["name"], "Dom")
        self.assertEqual(updated["price_per_kwh"], 1.1)

        # cudze urządzenie: brak zmian i brak dostępu
        self.assertIsNone(await db.update_device(bob, device["id"], {"name": "Hack"}))
        self.assertEqual((await db.get_device(alice, device["id"]))["name"], "Dom")

        # nieznane pola są ignorowane, cenę można wyczyścić
        updated = await db.update_device(alice, device["id"], {"token": "x", "price_per_kwh": None})
        self.assertEqual(updated["token"], "tok1")
        self.assertIsNone(updated["price_per_kwh"])

    async def test_hourly_last_stats_and_last_seen(self):
        user = await db.create_user("a@b.pl", "h")
        device = await db.create_device(user, "Licznik", "tok1", "prad")
        base = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) - timedelta(hours=3)

        async with db._db() as conn:
            for minutes, value in ((5, 1.0), (40, 2.0), (65, 3.0), (90, 4.0)):
                await conn.execute(
                    "INSERT INTO readings (device_id, timestamp, metric, value) VALUES (?, ?, 'kwh', ?)",
                    (device["id"], (base + timedelta(minutes=minutes)).isoformat(), value),
                )
            await conn.commit()

        rows = await db.get_hourly_last(device["id"], "kwh", base - timedelta(hours=1))
        self.assertEqual([r["value"] for r in rows], [2.0, 4.0])

        stats = await db.get_stats(device["id"], "kwh", base - timedelta(hours=1))
        self.assertEqual((stats["count"], stats["min"], stats["max"]), (4, 1.0, 4.0))
        self.assertEqual(stats["avg"], 2.5)

        last_seen = await db.load_last_seen()
        expected = (base + timedelta(minutes=90)).timestamp()
        self.assertAlmostEqual(last_seen["tok1"], expected, places=3)

    async def test_init_db_adds_price_column_to_old_database(self):
        async with db._db() as conn:
            await conn.execute("DROP TABLE devices")
            await conn.execute("""
                CREATE TABLE devices (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    token TEXT NOT NULL UNIQUE,
                    device_type TEXT NOT NULL DEFAULT 'prad',
                    created_at TEXT NOT NULL
                )
            """)
            await conn.execute(
                "INSERT INTO users (email, password_hash, created_at) VALUES ('s@x.pl', 'h', '2026-01-01')"
            )
            await conn.execute(
                "INSERT INTO devices (user_id, name, token, created_at) VALUES (1, 'Stary', 'tok-old', '2026-01-01')"
            )
            await conn.commit()

        await db.init_db()

        devices = await db.list_devices(1)
        self.assertEqual(devices[0]["name"], "Stary")
        self.assertIsNone(devices[0]["price_per_kwh"])


if __name__ == "__main__":
    unittest.main()
