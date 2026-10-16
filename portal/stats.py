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
