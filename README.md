# Warcgr IoT

System IoT do monitorowania i sterowania instalacją grzewczą.

## Technologie

- Python
- FastAPI
- MQTT / Mosquitto
- SQLite
- HTML / CSS / JavaScript
- ESP32

## MQTT

Broker:
`mqtt.warcgr.pl`

Panel:
`iot.warcgr.pl`



Jak to działa
Całość wygląda obecnie tak:
                    ┌──────────────────┐
                    │      ESP32       │
                    │                  │
                    │ temp. wody       │
                    │ temp. otoczenia  │
                    │ wilgotność       │
                    │ stan pieca       │
                    │ tryb             │
                    │ status ESP32     │
                    │ ruszta           │
                    └────────┬─────────┘
                             │
                             │ MQTT
                             ▼
                    ┌──────────────────┐
                    │    Mosquitto     │
                    │   MQTT Broker    │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │     FastAPI      │
                    │                  │
                    │ odbiera MQTT     │
                    │ aktualny stan    │
                    │ REST API         │
                    │ zapis do SQLite  │
                    └───────┬──────────┘
                            │
                 ┌──────────┴──────────┐
                 ▼                     ▼
          ┌─────────────┐       ┌─────────────┐
          │   SQLite    │       │    WWW      │
          │  historia   │       │   panel     │
          └─────────────┘       └─────────────┘

1. ESP32
ESP32 jest urządzeniem wykonawczym/sensorowym.
Publikuje przez MQTT między innymi:
piec_gazowy/temperatura_wody
piec_gazowy/temperatura_powrotu
piec_gazowy/temperatura_otoczenia
piec_gazowy/wilgotnosc
piec_gazowy/stan
piec_gazowy/tryb
piec_gazowy/status_esp32

piec_weglowy/ruszta

Czyli przykładowo:
piec_gazowy/temperatura_wody    → 21.31
piec_gazowy/temperatura_powrotu → 18.94
piec_gazowy/wilgotnosc          → 64.82
piec_gazowy/stan                → OFF
piec_gazowy/status_esp32        → online

ESP32 odpowiada również za lokalną logikę sterowania. To ważne, bo serwer/internet nie powinien być elementem wymaganym do bezpiecznego działania kotła.
2. MQTT / Mosquitto
Mosquitto jest naszym pośrednikiem komunikacyjnym.
ESP32 nie rozmawia bezpośrednio z FastAPI.
Jest:
ESP32 → MQTT → FastAPI

Dzięki temu możemy później dodawać kolejne urządzenia i czujniki bez przebudowy całego backendu.
Mamy też komunikację w drugą stronę:
FastAPI → MQTT → ESP32

dla sterowania (kontrakt, który musi obsłużyć ESP32):

| Komenda z panelu (FastAPI → ESP32)        | Potwierdzenie (ESP32 → FastAPI, retained) | Wartości        |
|-------------------------------------------|-------------------------------------------|-----------------|
| piec_gazowy/tryb/set                      | piec_gazowy/tryb                          | ON / OFF / AUTO |
| piec_gazowy/temperatura_zadana/set        | piec_gazowy/temperatura_zadana            | 5–30 °C         |
| piec_gazowy/histereza/set                 | piec_gazowy/histereza                     | 0.1–5 °C        |
| piec_gazowy/min_czas_pracy/set            | piec_gazowy/min_czas_pracy                | 0–60 min        |
| piec_gazowy/min_czas_postoju/set          | piec_gazowy/min_czas_postoju              | 0–60 min        |
| piec_gazowy/max_temperatura_wody/set      | piec_gazowy/max_temperatura_wody          | 40–90 °C        |
| piec_gazowy/predkosc_przeplywu/set        | piec_gazowy/predkosc_przeplywu            | 0–100 %         |

`piec_gazowy/temperatura_powrotu` to czysty odczyt czujnika (bez `/set`) – ESP32
publikuje go tak samo jak `temperatura_wody` / `temperatura_otoczenia`.

ESP32 po odebraniu `…/set` zapisuje wartość (np. w NVS) i publikuje ją na topicu bez `/set`.
Panel pokazuje „oczekuje na ESP32…”, dopóki nie przyjdzie potwierdzenie.
Komendy są wysyłane bez flagi retained, więc ESP32 offline ich nie dostanie.
Lista parametrów i zakresów jest w `SETTINGS` w `app/main.py`.
Sterowanie wymaga `CONTROL_TOKEN` w `.env`.

3. Cloudflare
Cloudflare jest używany głównie do udostępnienia systemu poza domową siecią.
Dla panelu:
https://iot.warcgr.pl
        ↓
Cloudflare Tunnel
        ↓
127.0.0.1:8004
        ↓
FastAPI

Dla MQTT urządzenie może korzystać z:
mqtt.warcgr.pl

przez WebSocket/WSS.
Dzięki temu nie otwieramy publicznie portu 8003/8004 ani MQTT na routerze.
4. FastAPI
To jest serce naszego backendu.
FastAPI robi obecnie kilka rzeczy.
Odbiera MQTT
Subskrybuje:
piec_gazowy/#
piec_weglowy/#

czyli praktycznie wszystkie nasze obecne tematy.
Dzięki temu backend nie musi mieć osobnego kodu typu:
if topic == "temperatura_wody":    ...elif topic == "wilgotnosc":    ...


dla każdego nowego czujnika.
Odczytuje:
topic + wartość

i przechowuje aktualny stan.
5. Aktualny stan
Backend trzyma ostatnią wartość każdego topicu w pamięci.
Czyli /api/status może zwrócić:
{
    "piec_gazowy/status_esp32": "online",
    "piec_gazowy/stan": "OFF",
    "piec_gazowy/temperatura_wody": "21.312000",
    "piec_gazowy/temperatura_otoczenia": "19.632639",
    "piec_gazowy/wilgotnosc": "64.818802"
}

Panel WWW pobiera właśnie ten endpoint.
6. SQLite
SQLite służy jako historia pomiarów.
Tabela:
measurements

ma:
id
timestamp
topic
value

Przykład:
48 | 2026-10-07... | piec_gazowy/wilgotnosc            | 64.818802
47 | 2026-10-07... | piec_gazowy/temperatura_otoczenia | 19.688717
46 | 2026-10-07... | piec_gazowy/temperatura_wody     | 21.09

Dzięki temu aktualna wartość to jedno, a historia to drugie.
Możemy więc później powiedzieć:
pokaż mi temperaturę wody z ostatnich 24 godzin

i backend pobierze ją z SQLite.
7. Retencja
Ustaliliśmy, że nie chcemy budować wieloletniego archiwum.
Obecnie przechowujemy maksymalnie:
7 dni danych.
Backend automatycznie usuwa starsze rekordy.
Czyli baza działa mniej więcej jako:
TERAZ
 │
 ├── 1 godzina temu
 ├── 6 godzin temu
 ├── 24 godziny temu
 ├── 3 dni temu
 ├── 6 dni temu
 └── 7 dni temu
       ↓
    usuwamy

Na potrzeby panelu możemy dzięki temu zaoferować np.:
1 h
6 h
24 h
3 dni
7 dni

8. Panel WWW
To jest to, co właśnie zaczęliśmy budować.
Panel jest napisany zwykłym:
HTML
CSS
JavaScript

bez Reacta/Vue itd.
Obecnie pokazuje:
ESP32
● ONLINE

Piec gazowy
Temperatura wody       21.3 °C
Temperatura otoczenia  19.6 °C
Wilgotność             64.8 %
Stan                   OFF
Tryb                   --

Piec węglowy
Ruszt                  --

Dane są pobierane z API i panel odświeża je co kilka sekund.
Co będziemy robić dalej
Teraz mamy już działającą podstawę, więc możemy ją rozwijać bez przebudowy architektury.
Najbliższy krok:
📈 Wykresy
Na przykład:
Temperatura wody — 24 h

80°C ┤
70°C ┤
60°C ┤
50°C ┤
40°C ┤
30°C ┤          ╭────╮
20°C ┼──────────╯    ╰────────
10°C ┤
     └────────────────────────
       00   04   08   12   16   20

Potem:
temperatura otoczenia + wilgotność.
🔥 Następnie sterowanie
Możemy dodać np.:
Piec gazowy

[ AUTO ] [ MANUAL ]

Stan:
● OFF

       [ WŁĄCZ ]
       [ WYŁĄCZ ]

ale komendy będą szły:
Panel
 ↓
FastAPI
 ↓
MQTT
 ↓
ESP32
 ↓
sterowanie

a nie bezpośrednio z przeglądarki do ESP32.
🌡️ A później Twoja część dotycząca energii
To będzie już ciekawszy element:
przepływomierz
      +
temperatura zasilania
      +
temperatura powrotu
      ↓
FastAPI / ESP32
      ↓
moc cieplna [kW]
      ↓
energia [kWh]
      ↓
historia + wykres

Czyli finalnie panel może pokazywać nie tylko:
„woda ma 55°C”

ale:
piec aktualnie oddaje 8.4 kW
dzisiaj wyprodukował 42.7 kWh ciepła

I właśnie dlatego obecna architektura MQTT → FastAPI → SQLite → WWW jest dobrym fundamentem — kolejne czujniki możemy po prostu dodawać jako kolejne MQTT topics, zamiast przebudowywać cały system.