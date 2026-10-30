"""Analiza temperatur: dom vs. zewnątrz i charakterystyka cieplna budynku.

Model: prawo stygnięcia Newtona

    dT_wew/dt = -k · (T_wew - T_zew)

Gdy dom stygnie, tempo spadku temperatury w środku jest proporcjonalne do
różnicy temperatur dom–zewnątrz. Współczynnik k [1/h] liczymy z okresów,
w których temperatura w domu spadała:

    k = Σ spadek_temperatury / Σ ∫(T_wew - T_zew) dt

(postać całkowa – odporna na zmiany temperatury zewnętrznej w trakcie
okresu). τ = 1/k [h] to stała czasowa budynku: po czasie τ bez ogrzewania
różnica temperatur dom–zewnątrz maleje do ok. 37 %.
"""

import math
from datetime import datetime
from typing import Iterable, List, Optional


# Pełne okno, z którego liczymy charakterystykę (tyle trzymamy w bazie)
ANALYSIS_HOURS = 168

# Siatka czasu, na którą sprowadzamy pomiary z obu czujników
BUCKET_SECONDS = 600

# Dziury do 1 h uzupełniamy liniowo (czujniki publikują z różną częstotliwością)
MAX_FILL_BUCKETS = 6

MAX_CHART_POINTS = 300

# Kryteria okresu stygnięcia
MIN_COOLING_DELTA = 3.0          # °C – przy mniejszej różnicy pomiar tonie w szumie
MIN_EPISODE_SECONDS = 90 * 60
MIN_EPISODE_DROP = 0.3           # °C
RISE_TOLERANCE = 0.1             # °C – szum czujnika, który nie przerywa stygnięcia

FORECAST_HOURS = 6


def parse_ts(ts: str) -> float:
    return datetime.fromisoformat(ts).timestamp()


def topic_candidates(names: Iterable[str], topics: Iterable[str]) -> List[str]:
    """Topici pasujące do nazw czujnika (po ostatnim członie), wg priorytetu nazw."""
    topics = list(topics)

    for name in names:
        matches = sorted(t for t in topics if t == name or t.endswith("/" + name))

        if matches:
            return matches

    return []


def bucketize(rows, start: float, count: int, bucket_s: int = BUCKET_SECONDS):
    sums = [0.0] * count
    counts = [0] * count

    for row in rows:
        try:
            t = parse_ts(row["timestamp"])
            value = float(row["value"])
        except (KeyError, TypeError, ValueError):
            continue

        i = int((t - start) // bucket_s)

        if 0 <= i < count and math.isfinite(value):
            sums[i] += value
            counts[i] += 1

    return [s / n if n else None for s, n in zip(sums, counts)]


def fill_gaps(values, max_gap: int = MAX_FILL_BUCKETS):
    result = list(values)
    last = None

    for i, value in enumerate(values):
        if value is None:
            continue

        if last is not None and 1 < i - last <= max_gap + 1:
            a = values[last]

            for j in range(last + 1, i):
                result[j] = a + (value - a) * (j - last) / (i - last)

        last = i

    return result


def summarize(values) -> Optional[dict]:
    present = [v for v in values if v is not None]

    if not present:
        return None

    return {
        "min": round(min(present), 2),
        "avg": round(sum(present) / len(present), 2),
        "max": round(max(present), 2),
    }


def find_cooling_episodes(inside, outside, bucket_s: int = BUCKET_SECONDS):
    """Zwraca listę (start, koniec) indeksów okresów, w których dom stygnie."""
    episodes = []

    def close(start, end):
        segment = inside[start:end + 1]
        top = max(segment)
        bottom = min(segment)

        # Od ostatniego maksimum do ostatniego minimum – bez płaskich końcówek
        s = start + max(i for i, v in enumerate(segment) if v == top)
        e = start + max(i for i, v in enumerate(segment) if v == bottom)

        if e > s and (e - s) * bucket_s >= MIN_EPISODE_SECONDS \
                and inside[s] - inside[e] >= MIN_EPISODE_DROP:
            episodes.append((s, e))

    start = None
    low = None

    for i, (t_in, t_out) in enumerate(zip(inside, outside)):
        valid = t_in is not None and t_out is not None and t_in - t_out >= MIN_COOLING_DELTA

        if start is not None and valid and t_in <= low + RISE_TOLERANCE:
            low = min(low, t_in)
            continue

        if start is not None:
            close(start, i - 1)

        start, low = (i, t_in) if valid else (None, None)

    if start is not None:
        close(start, len(inside) - 1)

    return episodes


def rate_building(tau_hours: float) -> str:
    # Progi orientacyjne – na wynik wpływa też słońce, wentylacja i bytowanie
    if tau_hours < 30:
        return "szybko traci ciepło"

    if tau_hours < 80:
        return "przeciętnie"

    return "dobrze trzyma ciepło"


def thermal_characteristic(inside, outside, times, current_inside=None,
                           current_outside=None, bucket_s: int = BUCKET_SECONDS):
    if all(v is None for v in inside):
        return {"status": "no_data", "message": "Brak danych z czujnika temperatury w domu."}

    if all(v is None for v in outside):
        return {"status": "no_data", "message": "Brak danych z czujnika temperatury na zewnątrz."}

    episodes = find_cooling_episodes(inside, outside, bucket_s)

    if not episodes:
        deltas = [i - o for i, o in zip(inside, outside) if i is not None and o is not None]

        if not deltas or max(deltas) < MIN_COOLING_DELTA:
            message = (
                f"Różnica temperatur dom–zewnątrz jest za mała (potrzeba min. "
                f"{MIN_COOLING_DELTA:g} °C). Charakterystyka pojawi się w chłodniejsze dni."
            )
        else:
            message = (
                "Nie znaleziono jeszcze okresów stygnięcia domu (min. 1,5 h spadku "
                "temperatury w środku). Poczekaj na więcej danych."
            )

        return {"status": "insufficient", "message": message}

    step_h = bucket_s / 3600
    total_drop = 0.0
    total_integral = 0.0
    result_episodes = []

    for s, e in episodes:
        drop = inside[s] - inside[e]
        integral = sum(
            ((inside[i] - outside[i]) + (inside[i + 1] - outside[i + 1])) / 2 * step_h
            for i in range(s, e)
        )

        total_drop += drop
        total_integral += integral

        result_episodes.append({
            "start": int(times[s] * 1000),
            "end": int(times[e] * 1000),
            "hours": round((e - s) * step_h, 2),
            "drop": round(drop, 2),
        })

    k = total_drop / total_integral
    tau = 1 / k
    analysed_hours = sum(ep["hours"] for ep in result_episodes)

    if len(episodes) < 2 or analysed_hours < 3:
        confidence = "niska"
    elif analysed_hours < 12:
        confidence = "średnia"
    else:
        confidence = "wysoka"

    result = {
        "status": "ok",
        "k_per_hour": round(k, 5),
        "tau_hours": round(tau, 1),
        "rating": rate_building(tau),
        "loss_per_10c": round(k * 10, 3),
        "episodes_count": len(episodes),
        "analysed_hours": round(analysed_hours, 1),
        "confidence": confidence,
        "episodes": result_episodes,
        "rate_now": None,
        "forecast_hours": FORECAST_HOURS,
        "forecast": None,
    }

    if current_inside is not None and current_outside is not None:
        delta = current_inside - current_outside

        if delta > 0:
            result["rate_now"] = round(k * delta, 3)
            result["forecast"] = round(
                current_outside + delta * math.exp(-k * FORECAST_HOURS), 2
            )

    return result


def _last(values):
    for value in reversed(values):
        if value is not None:
            return value

    return None


def _round(value):
    return None if value is None else round(value, 2)


def _avg(values):
    present = [v for v in values if v is not None]

    return sum(present) / len(present) if present else None


def build_analysis(inside_rows, outside_rows, now: float, hours: int,
                   current_inside=None, current_outside=None):
    count = ANALYSIS_HOURS * 3600 // BUCKET_SECONDS
    start = now - count * BUCKET_SECONDS
    times = [start + (i + 0.5) * BUCKET_SECONDS for i in range(count)]

    inside = fill_gaps(bucketize(inside_rows, start, count))
    outside = fill_gaps(bucketize(outside_rows, start, count))

    # Brak odczytu w MQTT (np. tuż po restarcie) – bierzemy ostatnią godzinę z bazy
    if current_inside is None:
        current_inside = _last(inside[-MAX_FILL_BUCKETS:])

    if current_outside is None:
        current_outside = _last(outside[-MAX_FILL_BUCKETS:])

    thermal = thermal_characteristic(inside, outside, times, current_inside, current_outside)

    in_episode = [False] * count

    for ep in thermal.get("episodes", []):
        s = int((ep["start"] / 1000 - start) // BUCKET_SECONDS)
        e = int((ep["end"] / 1000 - start) // BUCKET_SECONDS)

        for i in range(s, e + 1):
            in_episode[i] = True

    first = count - min(hours, ANALYSIS_HOURS) * 3600 // BUCKET_SECONDS
    window = range(first, count)
    delta = [
        i - o if i is not None and o is not None else None
        for i, o in zip(inside, outside)
    ]

    group = max(1, math.ceil(len(window) / MAX_CHART_POINTS))
    series = {"t": [], "inside": [], "outside": [], "delta": [], "cooling": []}

    for g in range(first, count, group):
        idx = range(g, min(g + group, count))

        series["t"].append(int(sum(times[i] for i in idx) / len(idx) * 1000))
        series["inside"].append(_round(_avg([inside[i] for i in idx])))
        series["outside"].append(_round(_avg([outside[i] for i in idx])))
        series["delta"].append(_round(_avg([delta[i] for i in idx])))
        series["cooling"].append(_round(_avg([inside[i] for i in idx if in_episode[i]])))

    current_delta = None

    if current_inside is not None and current_outside is not None:
        current_delta = current_inside - current_outside

    return {
        "hours": hours,
        "analysis_hours": ANALYSIS_HOURS,
        "current": {
            "inside": _round(current_inside),
            "outside": _round(current_outside),
            "delta": _round(current_delta),
        },
        "stats": {
            "inside": summarize([inside[i] for i in window]),
            "outside": summarize([outside[i] for i in window]),
            "delta": summarize([delta[i] for i in window]),
        },
        "series": series,
        "thermal": thermal,
    }
