const DEFAULT_DEVICE = "wesola88/piec_gazowy";
const DEVICE_ALIASES = [
    DEFAULT_DEVICE,
    "wesola88/instalacja",
    "piec_gazowy",
    "piec_weglowy"
];
let DEVICE = DEFAULT_DEVICE;

const TOPIC_ALIASES = {
    waterTemp: [
        "wesola88/piec_gazowy/temperatura_wody",
        "wesola88/instalacja/temperatura_wody",
        "piec_gazowy/temperatura_wody"
    ],
    returnTemp: [
        "wesola88/piec_gazowy/temperatura_powrotu",
        "wesola88/instalacja/temperatura_powrotu",
        "piec_gazowy/temperatura_powrotu"
    ],
    ambientTemp: [
        "wesola88/piec_gazowy/temperatura_otoczenia",
        "wesola88/instalacja/temperatura_otoczenia",
        "piec_gazowy/temperatura_otoczenia"
    ],
    humidity: [
        "wesola88/piec_gazowy/wilgotnosc",
        "wesola88/instalacja/wilgotnosc",
        "piec_gazowy/wilgotnosc"
    ],
    boilerState: [
        "wesola88/piec_gazowy/stan",
        "wesola88/instalacja/stan",
        "piec_gazowy/stan"
    ],
    setpoint: [
        "wesola88/piec_gazowy/temperatura_zadana",
        "wesola88/instalacja/temperatura_zadana",
        "piec_gazowy/temperatura_zadana"
    ],
    espStatus: [
        "wesola88/piec_gazowy/status_esp32",
        "wesola88/instalacja/status_esp32",
        "piec_gazowy/status_esp32"
    ],
    grateState: [
        "piec_weglowy/ruszta",
        "wesola88/piec_gazowy/ruszta",
        "wesola88/instalacja/ruszta"
    ],
    diffTemp: [
        "wesola88/instalacja/roznica_temperatur",
        "wesola88/piec_gazowy/roznica_temperatur",
        "piec_gazowy/roznica_temperatur"
    ],
    thermalPower: [
        "wesola88/instalacja/moc_cieplna",
        "wesola88/piec_gazowy/moc_cieplna",
        "piec_gazowy/moc_cieplna"
    ],
    energy: [
        "wesola88/instalacja/energia",
        "wesola88/piec_gazowy/energia",
        "piec_gazowy/energia"
    ],
    heatRate: [
        "wesola88/instalacja/tempo_nagrzewania",
        "wesola88/piec_gazowy/tempo_nagrzewania",
        "piec_gazowy/tempo_nagrzewania"
    ]
};

const TOPICS = Object.fromEntries(
    Object.entries(TOPIC_ALIASES).map(([key, aliases]) => [key, aliases[0]])
);

const TABS = ["pulpit", "wykresy", "ustawienia"];
const TOKEN_KEY = "control_token";
const STATUS_INTERVAL_MS = 5000;
const CHART_INTERVAL_MS = 60000;
const PENDING_TIMEOUT_MS = 20000;

let config = { control_enabled: false, modes: [], settings: {} };
let lastState = {};     // ostatnie wartości z MQTT (to, co raportuje ESP32)
let desired = {};       // ostatnio ustawione z panelu (zapisane na serwerze)
let selectedHours = 24;
let currentTab = "pulpit";

const pending = {};     // klucz -> termin (ms) oczekiwania na potwierdzenie
const charts = {};
const steppers = {};


/* ---------- Pomocnicze ---------- */

function $(id) {
    return document.getElementById(id);
}


function setText(id, value) {
    $(id).textContent = value;
}


function parseNum(value) {
    if (value === undefined || value === null || value === "") {
        return NaN;
    }

    return Number(String(value).replace(",", ".").trim());
}


function formatNumber(value) {
    const n = parseNum(value);

    return isNaN(n) ? "--" : n.toFixed(1);
}


function decimals(step) {
    const s = String(step);

    return s.includes(".") ? s.split(".")[1].length : 0;
}


function toast(message, isError = false) {
    const el = $("toast");

    el.textContent = message;
    el.classList.toggle("error", isError);
    el.classList.add("show");

    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), 3000);
}


async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });

    if (!response.ok) {
        throw new Error(`${url}: HTTP ${response.status}`);
    }

    return response.json();
}


function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}


function resolveValueByAlias(key) {
    const aliases = TOPIC_ALIASES[key] ?? [];

    for (const topic of aliases) {
        if (lastState[topic] !== undefined) {
            return lastState[topic];
        }
    }

    return undefined;
}

function resolveDeviceValue(key) {
    for (const prefix of DEVICE_ALIASES) {
        const topic = `${prefix}/${key}`;
        if (lastState[topic] !== undefined) {
            return lastState[topic];
        }
    }

    return undefined;
}

function isEspOnline() {
    return String(resolveValueByAlias("espStatus") ?? "").trim().toLowerCase() === "online";
}


/* ---------- Ustawione vs. potwierdzone ---------- */

function normalize(key, value) {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }

    if (key === "tryb") {
        return String(value).trim().toUpperCase();
    }

    const n = parseNum(value);

    return isNaN(n) ? undefined : n;
}


// Zwraca { value, reported, state }:
//   confirmed   – ESP32 raportuje to samo, co ustawiono
//   pending     – wysłano, czekamy na potwierdzenie
//   unconfirmed – ustawiono, ale ESP32 raportuje coś innego / nic
//   reported    – nic nie ustawiano z panelu, jest tylko odczyt z ESP32
//   none        – brak danych
function keyStatus(key) {
    const want = normalize(key, desired[key]?.value);
    const have = normalize(key, resolveDeviceValue(key));

    const same = want !== undefined && have !== undefined && (
        key === "tryb" ? want === have : Math.abs(want - have) < 1e-3
    );

    if (same || (pending[key] && Date.now() > pending[key])) {
        delete pending[key];
    }

    let state;

    if (want === undefined) {
        state = have === undefined ? "none" : "reported";
    } else if (same) {
        state = "confirmed";
    } else if (pending[key]) {
        state = "pending";
    } else {
        state = "unconfirmed";
    }

    return { value: want ?? have, reported: have, state };
}


const STATE_TEXT = {
    confirmed: "Potwierdzone przez ESP32",
    pending: "Wysłano – czekam na ESP32…",
    unconfirmed: "ESP32 nie potwierdził",
    reported: "Odczyt z ESP32",
    none: ""
};


function renderStatusLine(el, info, format) {
    let text = STATE_TEXT[info.state];

    if (info.state === "unconfirmed") {
        text += info.reported !== undefined
            ? ` (raportuje ${format(info.reported)})`
            : " (brak odpowiedzi)";
    }

    el.className = "status-line " + info.state;
    el.textContent = text;
}


/* ---------- Zakładki ---------- */

function showTab() {
    const hash = location.hash.slice(1);

    currentTab = TABS.includes(hash) ? hash : "pulpit";

    document.querySelectorAll(".tab").forEach(section => {
        section.hidden = section.dataset.tab !== currentTab;
    });

    document.querySelectorAll(".tabbar a").forEach(a => {
        a.classList.toggle("active", a.getAttribute("href") === "#" + currentTab);
    });

    window.scrollTo(0, 0);

    if (currentTab === "wykresy") {
        Object.values(charts).forEach(chart => chart.resize());
        loadCharts();
    }
}


/* ---------- Stepper  [−] wartość [+] ---------- */

function createStepper(key, schema) {
    const wrap = document.createElement("div");
    wrap.className = "stepper";

    const minus = document.createElement("button");
    minus.type = "button";
    minus.className = "needs-control";
    minus.textContent = "−";
    minus.setAttribute("aria-label", "Zmniejsz");

    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "needs-control";
    plus.textContent = "+";
    plus.setAttribute("aria-label", "Zwiększ");

    const field = document.createElement("div");
    field.className = "stepper-field";

    const input = document.createElement("input");
    input.id = "input-" + key;
    input.type = "text";
    input.inputMode = "decimal";
    input.autocomplete = "off";
    input.className = "needs-control";
    input.placeholder = schema.default ?? "";

    const unit = document.createElement("span");
    unit.className = "unit";
    unit.textContent = schema.unit;

    field.append(input, unit);
    wrap.append(minus, field, plus);

    const fmt = v => Number(v).toFixed(decimals(schema.step));
    const clamp = v => Math.min(schema.max, Math.max(schema.min, v));

    const stepper = {
        key,
        schema,
        input,
        fmt,
        dirty: false,
        setDirty(value) {
            this.dirty = value;
            wrap.classList.toggle("dirty", value);
            updateControls();
        }
    };

    function bump(direction) {
        let v = parseNum(input.value);

        if (isNaN(v)) {
            v = keyStatus(key).value;
        }

        v = v === undefined || isNaN(v)
            ? clamp(schema.default ?? schema.min)
            : clamp(Math.round((v + direction * schema.step) / schema.step) * schema.step);

        input.value = fmt(v);
        stepper.setDirty(true);
    }

    minus.addEventListener("click", () => bump(-1));
    plus.addEventListener("click", () => bump(1));

    input.addEventListener("input", () => stepper.setDirty(true));

    input.addEventListener("blur", () => {
        const v = parseNum(input.value);

        if (!isNaN(v)) {
            input.value = fmt(clamp(v));
        }
    });

    input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            input.blur();
        }
    });

    steppers[key] = stepper;

    return wrap;
}


function readStepper(key) {
    const { input, schema } = steppers[key];
    const v = parseNum(input.value);

    if (isNaN(v) || v < schema.min || v > schema.max) {
        toast(`${schema.label}: zakres ${schema.min}–${schema.max} ${schema.unit}`, true);
        input.focus();
        return null;
    }

    return v;
}


function syncStepper(key) {
    const s = steppers[key];
    const info = keyStatus(key);
    const format = v => `${s.fmt(v)} ${s.schema.unit}`;

    document.querySelectorAll(`[data-current="${key}"]`).forEach(el => {
        renderStatusLine(el, info, format);
    });

    if (s.dirty || document.activeElement === s.input) {
        return;
    }

    s.input.value = info.value === undefined ? "" : s.fmt(info.value);
}


function buildSettings() {
    const list = $("settings-list");
    list.replaceChildren();

    for (const [key, schema] of Object.entries(config.settings)) {

        if (schema.group === "main") {
            $("setpoint-stepper").replaceChildren(createStepper(key, schema));
            continue;
        }

        const row = document.createElement("div");
        row.className = "setting";

        const head = document.createElement("div");
        head.className = "setting-head";

        const label = document.createElement("label");
        label.htmlFor = "input-" + key;
        label.textContent = schema.label;

        const current = document.createElement("span");
        current.className = "status-line";
        current.dataset.current = key;

        head.append(label, current);

        const desc = document.createElement("p");
        desc.className = "setting-desc";
        desc.textContent = schema.description || "";

        row.append(head, desc, createStepper(key, schema));
        list.append(row);
    }
}


function advancedKeys() {
    return Object.keys(config.settings)
        .filter(key => config.settings[key].group !== "main");
}


/* ---------- Stan sterowania ---------- */

function controlBlockReason() {
    if (!config.control_enabled) {
        return "Sterowanie wyłączone na serwerze (brak CONTROL_TOKEN).";
    }

    if (!getToken()) {
        return "Sterowanie zablokowane – odblokuj je w zakładce Ustawienia.";
    }

    if (!isEspOnline()) {
        return "ESP32 jest offline – komendy nie zostaną dostarczone.";
    }

    return "";
}


function updateControls() {
    const reason = controlBlockReason();

    document.querySelectorAll(".needs-control").forEach(el => {
        el.disabled = Boolean(reason);
    });

    for (const id of ["control-note", "settings-note"]) {
        $(id).textContent = reason;
        $(id).hidden = !reason;
    }

    const setpoint = steppers.temperatura_zadana;
    $("setpoint-apply").hidden = !(setpoint && setpoint.dirty);

    $("settings-save").disabled = Boolean(reason)
        || !advancedKeys().some(key => steppers[key]?.dirty);
}


function renderAccess() {
    const unlocked = Boolean(getToken());

    $("access-disabled").hidden = config.control_enabled;
    $("access-locked").hidden = !config.control_enabled || unlocked;
    $("access-unlocked").hidden = !config.control_enabled || !unlocked;

    updateControls();
}


function syncMode() {
    const info = keyStatus("tryb");

    document.querySelectorAll("#mode-buttons button").forEach(btn => {
        const selected = btn.dataset.mode === info.value;

        btn.classList.toggle("active", selected);
        btn.classList.toggle("pending", selected && info.state === "pending");
        btn.classList.toggle("unconfirmed", selected && info.state === "unconfirmed");
        btn.setAttribute("aria-pressed", String(selected));
    });

    renderStatusLine($("mode-status"), info, v => v);

    $("setpoint-box").hidden = info.value !== "AUTO";

    const setpoint = keyStatus("temperatura_zadana").value;

    $("ambient-sub").textContent = info.value === "AUTO" && setpoint !== undefined
        ? `zadana ${setpoint.toFixed(1)} °C`
        : "";
}


function renderControls() {
    syncMode();
    Object.keys(steppers).forEach(syncStepper);
    updateControls();
}


/* ---------- Wysyłanie komend ---------- */

async function sendSetting(key, value) {
    const token = getToken();

    if (!token) {
        toast("Najpierw odblokuj sterowanie w Ustawieniach", true);
        return false;
    }

    // Od razu pokazujemy wybór, cofamy przy błędzie
    const previous = desired[key];

    desired[key] = { value: String(value) };
    pending[key] = Date.now() + PENDING_TIMEOUT_MS;
    renderControls();

    const revert = () => {
        if (previous === undefined) {
            delete desired[key];
        } else {
            desired[key] = previous;
        }

        delete pending[key];
        renderControls();
    };

    try {
        const response = await fetch("/api/set", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Control-Token": token
            },
            body: JSON.stringify({ key, value })
        });

        if (response.status === 401) {
            revert();
            localStorage.removeItem(TOKEN_KEY);
            renderAccess();
            toast("Token nieprawidłowy – odblokuj ponownie", true);
            return false;
        }

        if (!response.ok) {
            revert();
            const err = await response.json().catch(() => ({}));
            toast(typeof err.detail === "string" ? err.detail : "Błąd wysyłania", true);
            return false;
        }

        setTimeout(loadStatus, 1500);

        return true;

    } catch (error) {
        revert();
        toast("Brak połączenia z serwerem", true);
        return false;
    }
}


async function onModeClick(mode) {
    const info = keyStatus("tryb");

    if (mode === info.value && info.state !== "unconfirmed") {
        return;
    }

    if (await sendSetting("tryb", mode)) {
        toast(`Tryb ${mode} wysłany`);
    }
}


async function applySetpoint() {
    const value = readStepper("temperatura_zadana");

    if (value === null) {
        return;
    }

    steppers.temperatura_zadana.setDirty(false);

    if (await sendSetting("temperatura_zadana", value)) {
        toast(`Temperatura ${steppers.temperatura_zadana.fmt(value)} °C wysłana`);
    } else {
        steppers.temperatura_zadana.setDirty(true);
    }
}


async function saveSettings() {
    const keys = advancedKeys().filter(key => steppers[key].dirty);
    const values = {};

    for (const key of keys) {
        const value = readStepper(key);

        if (value === null) {
            return;
        }

        values[key] = value;
    }

    $("settings-save").disabled = true;

    let sent = 0;

    for (const key of keys) {
        steppers[key].setDirty(false);

        if (!await sendSetting(key, values[key])) {
            steppers[key].setDirty(true);
            break;
        }

        sent++;
    }

    if (sent > 0) {
        toast(`Wysłano ustawienia (${sent})`);
    }

    updateControls();
}


/* ---------- Dostęp (token) ---------- */

async function unlock(event) {
    event.preventDefault();

    const token = $("token-input").value.trim();

    if (!token) {
        return;
    }

    try {
        const response = await fetch("/api/auth", {
            method: "POST",
            headers: { "X-Control-Token": token }
        });

        if (response.status === 401) {
            toast("Nieprawidłowy token", true);
            return;
        }

        if (!response.ok) {
            toast("Błąd serwera", true);
            return;
        }

        localStorage.setItem(TOKEN_KEY, token);
        $("token-input").value = "";
        $("token-input").blur();
        renderAccess();
        toast("Sterowanie odblokowane");

    } catch (error) {
        toast("Brak połączenia z serwerem", true);
    }
}


function lock() {
    localStorage.removeItem(TOKEN_KEY);
    renderAccess();
    toast("Sterowanie zablokowane");
}


/* ---------- Status ---------- */

function setBadge(id, value) {
    const el = $(id);
    const text = value ?? "--";

    el.textContent = text;
    el.classList.toggle("on", /^(on|1|true)$/i.test(text));
    el.classList.toggle("off", /^(off|0|false)$/i.test(text));
}


function updateEspStatus() {
    const online = isEspOnline();

    $("esp-status").classList.toggle("online", online);
    $("esp-status").classList.toggle("offline", !online);
    setText("esp-status-text", online ? "ONLINE" : "OFFLINE");
}


async function loadStatus() {
    try {
        lastState = await fetchJson("/api/status");
    } catch (error) {
        console.error("Błąd pobierania statusu:", error);
        lastState = {};
    }

    try {
        const serverDesired = await fetchJson("/api/desired");

        // Nie nadpisujemy wyboru, który właśnie jest wysyłany
        for (const key of Object.keys(pending)) {
            if (desired[key]) {
                serverDesired[key] = desired[key];
            }
        }

        desired = serverDesired;
    } catch (error) {
        console.error("Błąd pobierania ustawień:", error);
    }

    setText("water-temp", formatNumber(resolveValueByAlias("waterTemp")));
    setText("return-temp", formatNumber(resolveValueByAlias("returnTemp")));
    setText("ambient-temp", formatNumber(resolveValueByAlias("ambientTemp")));
    setText("humidity", formatNumber(resolveValueByAlias("humidity")));
    setText("delta-temp", formatNumber(resolveValueByAlias("diffTemp")));
    setText("thermal-power", formatNumber(resolveValueByAlias("thermalPower")));
    setText("energy", formatNumber(resolveValueByAlias("energy")));
    setText("heat-rate", formatNumber(resolveValueByAlias("heatRate")));

    setBadge("boiler-state", resolveValueByAlias("boilerState"));
    setBadge("grate-state", resolveValueByAlias("grateState"));

    updateEspStatus();
    renderControls();

    setText("last-update", new Date().toLocaleTimeString("pl-PL"));
}


/* ---------- Wykresy ---------- */

// Safari nie parsuje mikrosekund (…:00.123456+00:00) – obcinamy do milisekund
function parseTime(ts) {
    return Date.parse(String(ts).replace(/(\.\d{3})\d+/, "$1"));
}


function formatTick(ms) {
    const d = new Date(ms);

    if (selectedHours <= 24) {
        return d.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
    }

    return d.toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit" });
}


function makeDataset(label, color, extra = {}) {
    return {
        label,
        data: [],
        borderColor: color,
        backgroundColor: color + "33",
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.25,
        fill: false,
        ...extra
    };
}


function makeChart(canvasId, datasets, unit) {
    const muted = getComputedStyle(document.documentElement)
        .getPropertyValue("--muted").trim();

    const grid = "rgba(148, 163, 184, 0.15)";

    return new Chart($(canvasId), {
        type: "line",
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            parsing: false,
            interaction: { mode: "nearest", axis: "x", intersect: false },
            plugins: {
                legend: {
                    display: datasets.length > 1,
                    labels: { color: muted, boxWidth: 12 }
                },
                tooltip: {
                    callbacks: {
                        title: items => new Date(items[0].parsed.x).toLocaleString("pl-PL"),
                        label: item => ` ${item.dataset.label}: ${item.parsed.y.toFixed(1)} ${unit}`
                    }
                }
            },
            scales: {
                x: {
                    type: "linear",
                    ticks: {
                        color: muted,
                        maxTicksLimit: 5,
                        maxRotation: 0,
                        callback: value => formatTick(value)
                    },
                    grid: { color: grid }
                },
                y: {
                    grace: "5%",
                    ticks: { color: muted },
                    grid: { color: grid }
                }
            }
        }
    });
}


function initCharts() {
    if (typeof Chart === "undefined") {
        console.error("Chart.js nie został załadowany");
        return;
    }

    charts.ambient = makeChart("chart-ambient", [
        makeDataset("Otoczenie", "#38bdf8", { fill: true }),
        makeDataset("Zadana", "#f59e0b", { stepped: "after", borderDash: [6, 4], tension: 0 })
    ], "°C");

    charts.water = makeChart("chart-water", [
        makeDataset("Zasilanie", "#f97316", { fill: true }),
        makeDataset("Powrót", "#fb7185")
    ], "°C");

    charts.humidity = makeChart("chart-humidity", [
        makeDataset("Wilgotność", "#a78bfa", { fill: true })
    ], "%");
}


async function fetchHistory(topic) {
    const json = await fetchJson(
        `/api/history?topic=${encodeURIComponent(topic)}`
        + `&hours=${selectedHours}&max_points=300`
    );

    return json.data
        .map(p => ({ x: parseTime(p.timestamp), y: p.value }))
        .filter(p => !isNaN(p.x));
}


function setChartData(chart, series, min, max) {
    series.forEach((data, i) => {
        const ds = chart.data.datasets[i];

        ds.data = data;
        // Przy małej liczbie punktów pokazujemy kropki, inaczej pojedynczy pomiar byłby niewidoczny
        ds.pointRadius = !ds.stepped && data.length < 30 ? 3 : 0;
    });

    chart.options.scales.x.min = min;
    chart.options.scales.x.max = max;
    chart.update();

    chart.canvas.parentElement.classList.toggle(
        "empty",
        series.every(data => data.length === 0)
    );
}


async function loadCharts() {
    if (!charts.water) {
        return;
    }

    try {
        const [ambient, setpoint, water, returnTemp, humidity] = await Promise.all([
            fetchHistory(TOPICS.ambientTemp),
            fetchHistory(TOPICS.setpoint),
            fetchHistory(TOPICS.waterTemp),
            fetchHistory(TOPICS.returnTemp),
            fetchHistory(TOPICS.humidity)
        ]);

        const now = Date.now();
        const min = now - selectedHours * 3600 * 1000;

        // Zadana jest publikowana tylko przy zmianie – przeciągamy ostatnią wartość do "teraz"
        if (setpoint.length > 0) {
            setpoint.push({ x: now, y: setpoint[setpoint.length - 1].y });
        }

        setChartData(charts.ambient, [ambient, setpoint], min, now);
        setChartData(charts.water, [water, returnTemp], min, now);
        setChartData(charts.humidity, [humidity], min, now);

    } catch (error) {
        console.error("Błąd pobierania historii:", error);
    }
}


function initRangeButtons() {
    const buttons = document.querySelectorAll("#range-buttons button");

    buttons.forEach(btn => {
        btn.addEventListener("click", () => {
            selectedHours = Number(btn.dataset.hours);
            buttons.forEach(b => b.classList.toggle("active", b === btn));
            loadCharts();
        });
    });
}


/* ---------- Start ---------- */

async function loadConfig() {
    try {
        config = await fetchJson("/api/config");
        if (config.device) {
            DEVICE = config.device;
            if (!DEVICE_ALIASES.includes(DEVICE)) {
                DEVICE_ALIASES.unshift(DEVICE);
            }
        }
    } catch (error) {
        console.error("Błąd pobierania konfiguracji:", error);
    }

    buildSettings();
    renderAccess();
}


window.addEventListener("DOMContentLoaded", async () => {
    window.addEventListener("hashchange", showTab);
    showTab();

    initCharts();
    initRangeButtons();

    document.querySelectorAll("#mode-buttons button").forEach(btn => {
        btn.addEventListener("click", () => onModeClick(btn.dataset.mode));
    });

    $("setpoint-apply").addEventListener("click", applySetpoint);
    $("settings-save").addEventListener("click", saveSettings);
    $("access-locked").addEventListener("submit", unlock);
    $("logout-btn").addEventListener("click", lock);

    await loadConfig();
    await loadStatus();

    if (currentTab === "wykresy") {
        loadCharts();
    }

    setInterval(loadStatus, STATUS_INTERVAL_MS);

    setInterval(() => {
        if (currentTab === "wykresy" && !document.hidden) {
            loadCharts();
        }
    }, CHART_INTERVAL_MS);
});
