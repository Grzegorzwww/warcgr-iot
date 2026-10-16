import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from portal import db, ingest
from portal.security import (
    Throttle,
    hash_password,
    hash_session_token,
    new_device_token,
    normalize_email,
    verify_password,
)
from portal.stats import downsample, hourly_consumption


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


class IngestTests(unittest.TestCase):
    def setUp(self):
        ingest.set_known_tokens({"tok123": 7})
        ingest.latest.clear()
        ingest.last_seen.clear()

    def test_parse_topic(self):
        self.assertEqual(ingest.parse_topic("tok123/zurzycie_pradu"), ("tok123", "kwh"))
        self.assertEqual(ingest.parse_topic("tok123/zurzycie_pradu/kwh"), ("tok123", "kwh"))
        self.assertEqual(ingest.parse_topic("tok123/zurzycie_pradu/power_w"), ("tok123", "power_w"))
        self.assertIsNone(ingest.parse_topic("tok123/zurzycie_pradu/set"))
        self.assertIsNone(ingest.parse_topic("tok123/zurzycie_pradu/nieznana"))
        self.assertIsNone(ingest.parse_topic("tok123/inny/kwh"))
        self.assertIsNone(ingest.parse_topic("zurzycie_pradu"))
        self.assertIsNone(ingest.parse_topic("/zurzycie_pradu/kwh"))
        self.assertIsNone(ingest.parse_topic("a/b/zurzycie_pradu/kwh"))

    def test_known_token_updates_state(self):
        result = ingest.process_message("tok123/zurzycie_pradu/power_w", " 250.5 ")

        self.assertEqual(result, (7, "power_w", 250.5))
        self.assertEqual(ingest.latest["tok123"]["power_w"], "250.5")
        self.assertTrue(ingest.is_online("tok123"))

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
        device = await db.create_device(alice, "Garaż", "tok-alice")

        self.assertIsNotNone(await db.get_device(alice, device["id"]))
        self.assertIsNone(await db.get_device(bob, device["id"]))
        self.assertIsNone(await db.delete_device(bob, device["id"]))
        self.assertEqual(await db.list_devices(bob), [])
        self.assertEqual(await db.count_devices(alice), 1)

    async def test_delete_device_removes_readings(self):
        user = await db.create_user("a@b.pl", "h")
        device = await db.create_device(user, "Licznik", "tok1")

        await db.save_reading(device["id"], "kwh", 12.5)
        since = datetime.now(timezone.utc) - timedelta(hours=1)
        self.assertEqual(len(await db.get_readings(device["id"], "kwh", since)), 1)

        self.assertEqual(await db.delete_device(user, device["id"]), "tok1")
        self.assertEqual(await db.get_readings(device["id"], "kwh", since), [])
        self.assertEqual(await db.load_all_tokens(), {})

    async def test_cleanup_removes_old_readings(self):
        user = await db.create_user("a@b.pl", "h")
        device = await db.create_device(user, "Licznik", "tok1")

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


if __name__ == "__main__":
    unittest.main()
