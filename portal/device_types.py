"""Konfiguracja obsługiwanych typów czujników portalu.

Dodanie nowego typu czujnika = dopisanie wpisu tutaj: temat MQTT, dozwolone
metryki, które z nich zapisujemy do historii i jakie zakresy czasu pokazujemy
na wykresach. Reszta modułów (`ingest.py`, `main.py`, frontend) czyta te dane
stąd, więc nic więcej nie trzeba synchronizować ręcznie.
"""

DEFAULT_DEVICE_TYPE = "prad"

DEVICE_TYPES = {
    "prad": {
        "label": "Zużycie prądu",
        # Topic: <token>/zurzycie_pradu[/<metryka>]
        "topic": "zurzycie_pradu",
        "default_metric": "kwh",
        "metrics": {
            "kwh",
            "power_w",
            "kwh_last_1h",
            "kwh_last_3h",
            "kwh_last_24h",
            "cost_last_24h",
            "pulses",
            "history_hours",
            "pulse_width_ms",
            "rejected_flashes",
        },
        # Do historii zapisujemy tylko to, z czego rysujemy wykresy
        "stored_metrics": {"kwh", "power_w"},
        "history_metrics": {"kwh", "power_w"},
        # Licznik narastający w kWh -> zużycie godzinowe liczone z różnic
        "hourly_metric": "kwh",
        "ranges_hours": [6, 24, 72, 168],
    },
    "woda": {
        "label": "Temperatura wody",
        # Topic: <token>/temperatura_wody[/<metryka>]  (bez metryki = "temperatura")
        "topic": "temperatura_wody",
        "default_metric": "temperatura",
        "metrics": {"temperatura"},
        "stored_metrics": {"temperatura"},
        "history_metrics": {"temperatura"},
        "hourly_metric": None,
        "ranges_hours": [1, 3, 24, 72],
    },
}
