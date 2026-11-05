import math
from datetime import datetime, timedelta


def downsample(data, max_points: int):
    """Zmniejsza liczbę punktów, zachowując szczyty i doliny.

    Z każdego fragmentu zostają punkty minimum i maksimum (w kolejności czasu).
    Uśrednianie fragmentów spłaszczało krótkie skoki mocy – wykres pokazywał
    wyraźnie mniej niż rzeczywisty szczyt.
    """
    if len(data) <= max_points:
        return data

    chunk = math.ceil(len(data) / max(1, max_points // 2))
    result = []

    for i in range(0, len(data), chunk):
        part = data[i:i + chunk]
        low = min(range(len(part)), key=lambda k: part[k]["value"])
        high = max(range(len(part)), key=lambda k: part[k]["value"])

        for k in sorted({low, high}):
            result.append(part[k])

    return result


# Przerwa w danych dłuższa niż to nie jest doliczana do średniej mocy
POWER_GAP_LIMIT_S = 600

# Próg „dużych odbiorników" (czajnik, piekarnik, pralka...)
HIGH_POWER_W = 1000.0

# Przedziały mocy do rozkładu czasu pracy: (od W włącznie, do W wyłącznie, etykieta)
POWER_BANDS = [
    (0, 100, "< 100 W"),
    (100, 500, "100–500 W"),
    (500, 1000, "0,5–1 kW"),
    (1000, 2000, "1–2 kW"),
    (2000, float("inf"), "> 2 kW"),
]


def power_stats(rows, now: datetime):
    """Statystyki mocy chwilowej z odczytów rosnących w czasie.

    Średnia jest ważona czasem (każdy odczyt „trwa" do następnego), bo
    urządzenie wysyła próbki nierównomiernie – zwykła średnia z próbek
    zawyżałaby ją, gdy przy dużym poborze raportuje częściej.
    """
    if not rows:
        return {"count": 0, "max": None, "max_at": None, "avg": None, "hours_above": None, "bands": None}

    peak = max(rows, key=lambda r: r["value"])

    weighted = 0.0
    total = 0.0
    above = 0.0
    band_seconds = [0.0] * len(POWER_BANDS)

    for index, row in enumerate(rows):
        start = datetime.fromisoformat(row["timestamp"])
        end = datetime.fromisoformat(rows[index + 1]["timestamp"]) if index + 1 < len(rows) else now
        seconds = min((end - start).total_seconds(), POWER_GAP_LIMIT_S)

        if seconds <= 0:
            continue

        weighted += row["value"] * seconds
        total += seconds

        if row["value"] >= HIGH_POWER_W:
            above += seconds

        for index_band, (low, high, _) in enumerate(POWER_BANDS):
            if low <= row["value"] < high:
                band_seconds[index_band] += seconds
                break

    avg = weighted / total if total > 0 else sum(r["value"] for r in rows) / len(rows)

    return {
        "count": len(rows),
        "max": peak["value"],
        "max_at": peak["timestamp"],
        "avg": avg,
        "hours_above": above / 3600,
        "bands": [
            {"label": label, "hours": round(band_seconds[i] / 3600, 2)}
            for i, (_, _, label) in enumerate(POWER_BANDS)
        ],
    }


# Noc: godziny lokalne [22:00, 06:00)
NIGHT_HOURS = {22, 23, 0, 1, 2, 3, 4, 5}


def usage_pattern(hourly, tz):
    """Typowy rozkład zużycia w ciągu doby z godzinowych przyrostów (`hourly_consumption`).

    Zwraca godzinę o najwyższym średnim zużyciu, udział nocy w całym zużyciu
    i profil dobowy (średnia moc w W dla każdej godziny lokalnej 0–23).
    Przy zbyt małej ilości danych – wartości None.
    """
    if len(hourly) < 24:
        return {"peak_hour": None, "peak_hour_w": None, "night_share_pct": None, "profile_w": None}

    by_hour = {}
    night = 0.0
    total = 0.0

    for item in hourly:
        local = datetime.fromisoformat(item["hour"]).astimezone(tz)

        by_hour.setdefault(local.hour, []).append(item["kwh"])
        total += item["kwh"]

        if local.hour in NIGHT_HOURS:
            night += item["kwh"]

    peak_hour = max(by_hour, key=lambda h: sum(by_hour[h]) / len(by_hour[h]))
    peak_w = sum(by_hour[peak_hour]) / len(by_hour[peak_hour]) * 1000

    return {
        "peak_hour": peak_hour,
        "peak_hour_w": round(peak_w, 0),
        "night_share_pct": round(night / total * 100, 0) if total > 0 else None,
        "profile_w": [
            round(sum(by_hour[h]) / len(by_hour[h]) * 1000, 0) if h in by_hour else None
            for h in range(24)
        ],
    }


# Ostatni odczyt godziny musi paść po tej minucie, żeby uznać godzinę za pełną
COMPLETE_HOUR_MINUTE = 50


def hourly_consumption(rows, hours: int, complete_only: bool = False):
    """Zużycie w kolejnych godzinach z różnic stanu licznika (kWh).

    Dla każdej godziny bierzemy ostatni odczyt i odejmujemy ostatni odczyt
    z poprzedniej godziny. Godziny po przerwie w danych są pomijane, żeby
    zużycie z kilku godzin nie wylądowało w jednym słupku.

    Z `complete_only` zostają tylko godziny, w których oba odczyty graniczne
    leżą blisko pełnej godziny. Bez tego bieżąca (jeszcze trwająca) godzina
    i godziny z dziurą w danych wyglądałyby na znacznie mniejsze zużycie.
    """
    buckets = {}
    ends = {}

    for row in rows:
        ts = datetime.fromisoformat(row["timestamp"])
        hour = ts.replace(minute=0, second=0, microsecond=0)
        buckets[hour] = row["value"]
        ends[hour] = ts

    result = []
    previous_hour = None
    previous_value = None

    for hour in sorted(buckets):
        value = buckets[hour]

        if (
            previous_hour is not None
            and hour - previous_hour == timedelta(hours=1)
            and (
                not complete_only
                or (
                    ends[hour].minute >= COMPLETE_HOUR_MINUTE
                    and ends[previous_hour].minute >= COMPLETE_HOUR_MINUTE
                )
            )
        ):
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
