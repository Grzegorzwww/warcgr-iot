import math
import unittest
from datetime import datetime, timezone

from app.analysis import (
    ANALYSIS_HOURS,
    BUCKET_SECONDS,
    build_analysis,
    fill_gaps,
    find_cooling_episodes,
    thermal_characteristic,
    topic_candidates,
)


NOW = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc).timestamp()


def rows(points):
    return [
        {"timestamp": datetime.fromtimestamp(t, timezone.utc).isoformat(), "value": v}
        for t, v in points
    ]


def simulate(tau_hours, outside_fn, heat_on_below=20.0, heat_off_above=21.0,
             heat_rate=1.5, step_s=60):
    """Dom z termostatem: grzeje do 21 °C, potem stygnie zgodnie z prawem Newtona."""
    k = 1 / tau_hours
    start = NOW - ANALYSIS_HOURS * 3600
    t_in = 20.5
    heating = False
    inside, outside = [], []

    for i in range(ANALYSIS_HOURS * 3600 // step_s):
        t = start + i * step_s
        t_out = outside_fn(t)

        if t_in <= heat_on_below:
            heating = True
        elif t_in >= heat_off_above:
            heating = False

        dt_h = step_s / 3600
        t_in += (-k * (t_in - t_out) + (heat_rate if heating else 0)) * dt_h

        inside.append((t, round(t_in, 1)))   # rozdzielczo\u015b\u0107 czujnika 0,1 \u00b0C
        outside.append((t, round(t_out, 1)))

    return rows(inside), rows(outside)


class TopicTests(unittest.TestCase):
    def test_matches_by_last_segment_with_priority(self):
        topics = ["wesola88/dom/temperature", "wesola88/dom/temperatura_domu", "x/temperature_outside"]

        self.assertEqual(
            topic_candidates(["temperatura_domu", "temperature"], topics),
            ["wesola88/dom/temperatura_domu"],
        )
        self.assertEqual(topic_candidates(["temperature_outside"], topics), ["x/temperature_outside"])

    def test_does_not_match_partial_names(self):
        # "temperature" nie mo\u017ce z\u0142apa\u0107 "temperature_outside"
        self.assertEqual(topic_candidates(["temperature"], ["a/temperature_outside"]), [])


class HelperTests(unittest.TestCase):
    def test_fill_gaps_interpolates_short_gaps_only(self):
        self.assertEqual(fill_gaps([1.0, None, 3.0]), [1.0, 2.0, 3.0])
        self.assertEqual(fill_gaps([1.0] + [None] * 10 + [3.0]), [1.0] + [None] * 10 + [3.0])

    def test_episode_requires_drop_and_duration(self):
        flat = [20.0] * 30
        self.assertEqual(find_cooling_episodes(flat, [0.0] * 30), [])

        cooling = [20.0 - 0.05 * i for i in range(30)]
        self.assertEqual(find_cooling_episodes(cooling, [0.0] * 30), [(0, 29)])

    def test_episode_ignores_small_delta(self):
        cooling = [20.0 - 0.05 * i for i in range(30)]
        self.assertEqual(find_cooling_episodes(cooling, [18.0] * 30), [])


class ThermalTests(unittest.TestCase):
    def assert_tau(self, result, expected, tolerance=0.2):
        self.assertEqual(result["thermal"]["status"], "ok", result["thermal"].get("message"))
        tau = result["thermal"]["tau_hours"]
        self.assertLess(abs(tau - expected) / expected, tolerance, f"\u03c4={tau}, oczekiwane {expected}")

    def test_recovers_time_constant_constant_outside(self):
        inside, outside = simulate(60, lambda t: 0.0)
        result = build_analysis(inside, outside, NOW, 24)

        self.assert_tau(result, 60)
        self.assertEqual(result["thermal"]["confidence"], "wysoka")

    def test_recovers_time_constant_with_daily_outside_swing(self):
        inside, outside = simulate(
            35,
            lambda t: 2 + 5 * math.sin(2 * math.pi * t / 86400),
        )

        self.assert_tau(build_analysis(inside, outside, NOW, 168), 35)

    def test_summer_reports_insufficient_delta(self):
        inside, outside = simulate(60, lambda t: 20.0, heat_on_below=-100)
        thermal = build_analysis(inside, outside, NOW, 24)["thermal"]

        self.assertEqual(thermal["status"], "insufficient")
        self.assertIn("za ma\u0142a", thermal["message"])

    def test_missing_sensor(self):
        inside, _ = simulate(60, lambda t: 0.0)
        result = build_analysis(inside, [], NOW, 24)

        self.assertEqual(result["thermal"]["status"], "no_data")
        self.assertIsNone(result["stats"]["outside"])
        self.assertIsNotNone(result["stats"]["inside"])

    def test_forecast_and_rate(self):
        inside = [20.0 - 0.05 * i for i in range(30)]
        outside = [0.0] * 30
        times = [NOW + i * BUCKET_SECONDS for i in range(30)]

        thermal = thermal_characteristic(inside, outside, times, 20.0, 0.0)
        k = thermal["k_per_hour"]

        self.assertAlmostEqual(thermal["rate_now"], round(k * 20, 3), places=3)
        self.assertAlmostEqual(thermal["forecast"], round(20 * math.exp(-6 * k), 2), places=2)


class SeriesTests(unittest.TestCase):
    def test_series_window_and_delta(self):
        inside, outside = simulate(60, lambda t: 0.0)

        for hours, expected_points in [(24, 144), (72, 216), (168, 252)]:
            result = build_analysis(inside, outside, NOW, hours)
            series = result["series"]

            self.assertEqual(len(series["t"]), expected_points)
            self.assertTrue(all(len(series[key]) == expected_points for key in series))
            self.assertGreaterEqual(series["t"][0], (NOW - hours * 3600) * 1000)

        last = result["series"]
        self.assertAlmostEqual(last["delta"][-1], last["inside"][-1] - last["outside"][-1], places=1)

    def test_current_falls_back_to_recent_db_values(self):
        inside, outside = simulate(60, lambda t: 0.0)
        result = build_analysis(inside, outside, NOW, 24)

        self.assertIsNotNone(result["current"]["inside"])
        self.assertAlmostEqual(result["current"]["outside"], 0.0)

        # Dane sprzed kilku godzin nie mog\u0105 udawa\u0107 bie\u017c\u0105cego odczytu
        old = [r for r in inside if r["timestamp"] < datetime.fromtimestamp(NOW - 3 * 3600, timezone.utc).isoformat()]
        self.assertIsNone(build_analysis(old, outside, NOW, 24)["current"]["inside"])


if __name__ == "__main__":
    unittest.main()
