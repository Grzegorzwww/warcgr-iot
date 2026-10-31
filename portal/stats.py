import math
from datetime import datetime, timedelta


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


def hourly_consumption(rows, hours: int):
    """Zużycie w kolejnych godzinach z różnic stanu licznika (kWh).

    Dla każdej godziny bierzemy ostatni odczyt i odejmujemy ostatni odczyt
    z poprzedniej godziny. Godziny po przerwie w danych są pomijane, żeby
    zużycie z kilku godzin nie wylądowało w jednym słupku.
    """
    buckets = {}

    for row in rows:
        ts = datetime.fromisoformat(row["timestamp"])
        hour = ts.replace(minute=0, second=0, microsecond=0)
        buckets[hour] = row["value"]

    result = []
    previous_hour = None
    previous_value = None

    for hour in sorted(buckets):
        value = buckets[hour]

        if previous_hour is not None and hour - previous_hour == timedelta(hours=1):
            result.append({
                "hour": hour.isoformat(),
                "kwh": round(max(0.0, value - previous_value), 3),
            })

        previous_hour = hour
        previous_value = value

    return result[-hours:]


# Wi\u0119kszy przyrost oznacza\u0142by \u015brednio ponad 50 kW \u2013 w domu to nie zu\u017cycie,
# tylko r\u0119czna zmiana stanu licznika w konfiguracji urz\u0105dzenia.
MAX_PLAUSIBLE_KW = 50.0

# Doba uznana za pe\u0142n\u0105, gdy dane pokrywaj\u0105 co najmniej tyle godzin
FULL_DAY_HOURS = 22


def daily_consumption(rows, tz, days: int, now: datetime):
    """Zu\u017cycie (kWh) w ostatnich `days` dobach kalendarzowych strefy `tz`.

    `rows` to rosn\u0105ce odczyty stanu licznika (np. ostatni z ka\u017cdej godziny).
    Przyrost mi\u0119dzy kolejnymi odczytami trafia do doby p\u00f3\u017aniejszego z nich;
    przerwy w danych nie gubi\u0105 energii, bo licznik liczy dalej. Spadki stanu
    i nierealne skoki s\u0105 pomijane.
    """
    today = now.astimezone(tz).date()
    first_day = today - timedelta(days=days - 1)

    totals = {}
    coverage = {}
    previous = None

    for row in rows:
        ts = datetime.fromisoformat(row["timestamp"])
        value = row["value"]

        if previous is not None:
            prev_ts, prev_value = previous
            delta = value - prev_value
            hours = (ts - prev_ts).total_seconds() / 3600

            if hours > 0 and delta >= 0 and delta / max(hours, 1 / 60) <= MAX_PLAUSIBLE_KW:
                day = ts.astimezone(tz).date()
                totals[day] = totals.get(day, 0.0) + delta
                coverage[day] = coverage.get(day, 0.0) + hours

        previous = (ts, value)

    result = []

    for offset in range(days):
        day = first_day + timedelta(days=offset)
        kwh = totals.get(day)

        result.append({
            "date": day.isoformat(),
            "kwh": round(kwh, 3) if kwh is not None else None,
            "complete": day != today and coverage.get(day, 0.0) >= FULL_DAY_HOURS,
        })

    return result


def temperature_trend(rows, now: datetime, window_minutes: int = 30):
    """Tempo zmian temperatury (\u00b0C/h) z regresji liniowej ostatnich odczyt\u00f3w."""
    since = now - timedelta(minutes=window_minutes)
    points = []

    for row in rows:
        ts = datetime.fromisoformat(row["timestamp"])

        if ts >= since:
            points.append(((ts - since).total_seconds() / 3600, row["value"]))

    if len(points) < 3 or points[-1][0] - points[0][0] < 5 / 60:
        return None

    n = len(points)
    mean_x = sum(x for x, _ in points) / n
    mean_y = sum(y for _, y in points) / n
    var_x = sum((x - mean_x) ** 2 for x, _ in points)

    if var_x == 0:
        return None

    slope = sum((x - mean_x) * (y - mean_y) for x, y in points) / var_x

    return round(slope, 2)
