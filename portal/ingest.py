import asyncio
import math
import os
import threading
import time
from typing import Optional

import paho.mqtt.client as mqtt
from dotenv import load_dotenv

from portal import db


load_dotenv()


# Portal może używać własnych danych logowania do brokera; domyślnie te same co iot.
MQTT_HOST = os.getenv("PORTAL_MQTT_HOST", os.getenv("MQTT_HOST", "127.0.0.1"))
MQTT_PORT = int(os.getenv("PORTAL_MQTT_PORT", os.getenv("MQTT_PORT", "1883")))
MQTT_USER = os.getenv("PORTAL_MQTT_USER", os.getenv("MQTT_USER"))
MQTT_PASSWORD = os.getenv("PORTAL_MQTT_PASSWORD", os.getenv("MQTT_PASSWORD"))

# Topic urządzenia:  <token>/zurzycie_pradu/<metryka>
# (oraz <token>/zurzycie_pradu  = stan licznika w kWh)
SUBSCRIPTIONS = [
    ("+/zurzycie_pradu", 0),
    ("+/zurzycie_pradu/#", 0),
]

METRICS = {
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
}

# Do historii zapisujemy tylko to, z czego rysujemy wykresy
STORED_METRICS = {"kwh", "power_w"}

# Urządzenie raportuje co 60 s – po 3 minutach ciszy uznajemy je za offline
ONLINE_TIMEOUT_S = 180

MAX_PAYLOAD_LENGTH = 32


# token -> id urządzenia (tylko zarejestrowane; reszta jest ignorowana)
known_tokens = {}

# token -> {metryka: ostatnia wartość (tekst)}
latest = {}

# token -> czas ostatniej wiadomości (time.time())
last_seen = {}

_loop = None
_client = None


def set_known_tokens(tokens: dict):
    known_tokens.clear()
    known_tokens.update(tokens)


def register_token(token: str, device_id: int):
    known_tokens[token] = device_id


def forget_token(token: str):
    known_tokens.pop(token, None)
    latest.pop(token, None)
    last_seen.pop(token, None)


def is_online(token: str) -> bool:
    seen = last_seen.get(token)

    return seen is not None and time.time() - seen <= ONLINE_TIMEOUT_S


def parse_topic(topic: str) -> Optional[tuple]:
    """`<token>/zurzycie_pradu[/<metryka>]` -> (token, metryka) albo None."""
    parts = topic.split("/")

    if len(parts) not in (2, 3) or parts[1] != "zurzycie_pradu":
        return None

    token = parts[0]

    if not token:
        return None

    if len(parts) == 2:
        return token, "kwh"

    if parts[2] not in METRICS:
        return None

    return token, parts[2]


def process_message(topic: str, payload: str) -> Optional[tuple]:
    """Aktualizuje stan w pamięci. Zwraca (device_id, metryka, wartość) lub None."""
    parsed = parse_topic(topic)

    if parsed is None:
        return None

    token, metric = parsed
    device_id = known_tokens.get(token)

    if device_id is None:
        return None

    payload = payload.strip()

    if not payload or len(payload) > MAX_PAYLOAD_LENGTH:
        return None

    try:
        value = float(payload)
    except ValueError:
        return None

    if not math.isfinite(value):
        return None

    latest.setdefault(token, {})[metric] = payload
    last_seen[token] = time.time()

    return device_id, metric, value


def on_connect(client, userdata, flags, reason_code, properties):
    print("Portal MQTT connected:", reason_code)

    for topic, qos in SUBSCRIPTIONS:
        client.subscribe(topic, qos)


def on_message(client, userdata, msg):
    try:
        payload = msg.payload.decode()
    except UnicodeDecodeError:
        return

    result = process_message(msg.topic, payload)

    if result is None or _loop is None:
        return

    device_id, metric, value = result

    if metric in STORED_METRICS:
        asyncio.run_coroutine_threadsafe(
            db.save_reading(device_id, metric, value),
            _loop,
        )


def start_mqtt(loop):
    global _loop, _client

    _loop = loop

    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id="warcgr-portal",
    )

    if MQTT_USER:
        client.username_pw_set(MQTT_USER, MQTT_PASSWORD)

    client.on_connect = on_connect
    client.on_message = on_message

    _client = client

    client.connect_async(MQTT_HOST, MQTT_PORT, 60)
    client.loop_forever(retry_first_connection=True)


def start_mqtt_thread(loop):
    thread = threading.Thread(target=start_mqtt, args=(loop,), daemon=True)
    thread.start()

    return thread
