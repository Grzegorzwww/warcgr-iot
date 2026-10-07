import os
import asyncio
import threading

import paho.mqtt.client as mqtt
from dotenv import load_dotenv

from app.database import save_measurement


load_dotenv()


MQTT_HOST = os.getenv("MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USER = os.getenv("MQTT_USER")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD")


# Topics, które chcemy odbierać
MQTT_TOPICS = [
    ("piec_gazowy/#", 0),
    ("piec_weglowy/#", 0),
]


# Aktualne wartości
state = {}


# Event loop FastAPI/asyncio
_loop = None


def set_event_loop(loop):
    global _loop
    _loop = loop


def on_connect(client, userdata, flags, reason_code, properties):
    print("MQTT connected:", reason_code)

    for topic, qos in MQTT_TOPICS:
        client.subscribe(topic, qos)
        print("Subscribed:", topic)


def on_message(client, userdata, msg):
    topic = msg.topic
    payload = msg.payload.decode().strip()

    print(f"MQTT: {topic} = {payload}")

    # Status tekstowy
    state[topic] = payload

    # Próba potraktowania wartości jako liczby
    try:
        value = float(payload)
    except ValueError:
        return

    # Zapis do bazy musi zostać wykonany w asyncio
    if _loop is not None:
        asyncio.run_coroutine_threadsafe(
            save_measurement(topic, value),
            _loop
        )


def create_client():
    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2
    )

    if MQTT_USER:
        client.username_pw_set(
            MQTT_USER,
            MQTT_PASSWORD
        )

    client.on_connect = on_connect
    client.on_message = on_message

    return client


def start_mqtt(loop):
    set_event_loop(loop)

    client = create_client()

    client.connect(
        MQTT_HOST,
        MQTT_PORT,
        60
    )

    client.loop_forever()


def start_mqtt_thread(loop):
    thread = threading.Thread(
        target=start_mqtt,
        args=(loop,),
        daemon=True
    )

    thread.start()

    return thread