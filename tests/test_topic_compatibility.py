import unittest


class TopicCompatibilityTests(unittest.TestCase):
    def test_command_topic_uses_current_prefix(self):
        from app.main import build_command_topic

        self.assertEqual(
            build_command_topic("tryb"),
            "wesola88/piec_gazowy/tryb/set",
        )
        self.assertEqual(
            build_command_topic("przeplyw"),
            "wesola88/piec_gazowy/przeplyw/set",
        )
        self.assertEqual(
            build_command_topic("ruszta_tryb"),
            "wesola88/piec_weglowy/ruszta_tryb/set",
        )
        self.assertEqual(
            build_command_topic("zurzycie_gazu_m3"),
            "wesola88/zurzycie_gazu/set",
        )

    def test_mqtt_subscriptions_cover_new_and_legacy_prefixes(self):
        from app.mqtt import MQTT_TOPICS

        self.assertIn(("wesola88/#", 0), MQTT_TOPICS)
        self.assertIn(("piec_gazowy/#", 0), MQTT_TOPICS)
        self.assertIn(("piec_weglowy/#", 0), MQTT_TOPICS)


if __name__ == "__main__":
    unittest.main()
