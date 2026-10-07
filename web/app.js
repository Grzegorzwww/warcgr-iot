const DEVICE = "piec_gazowy";

const TOPICS = {
    waterTemp: "piec_gazowy/temperatura_wody",
    ambientTemp: "piec_gazowy/temperatura_otoczenia",
    humidity: "piec_gazowy/wilgotnosc",
    boilerState: "piec_gazowy/stan",
    boilerMode: "piec_gazowy/tryb",
    setpoint: "piec_gazowy/temperatura_zadana",
    espStatus: "piec_gazowy/status_esp32",
    grateState: "piec_weglowy/ruszta"
};

const TABS = ["pulpit", "wykresy", "ustawienia"];
const TOKEN_KEY = "control_token";
const STATUS_INTERVAL_MS = 5000;
const CHART_INTERVAL_MS = 60000;
const PENDING_TIMEOUT_MS = 20000;

let config = { control_enabled: false, modes: [], settings: {} };
let lastState = {};
let selectedHours = 24;
let currentTab = "pulpit";

const charts = {};
const steppers = {};
const pending = {};


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


function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}


function isEspOnline() {
    return lastState[TOPICS.espStatus] === "online";
}


function canControl() {
    return config.control_enabled && Boolean(getToken()) && isEspOnline();
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
            v = parseNum(lastState[`${DEVICE}/${key}`]);
        }

        if (isNaN(v)) {
            v = schema.min;
        } else {
            v = clamp(v + direction * schema.step);
        }

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
    const raw = parseNum(lastState[`${DEVICE}/${key}`]);
    const p = pending[key];

    if (p) {
        if (!isNaN(raw) && Math.abs(raw - p.value) < 1e-3) {
            delete pending[key];
        } else if (Date.now() > p.until) {
            delete pending[key];
            toast(`ESP32 nie potwierdził: ${s.schema.label}`, true);
        }
    }

    const currentText = pending[key]
        ? "oczekuje na ESP32…"
        : `aktualnie: ${isNaN(raw) ? "--" : s.fmt(raw) + " " + s.schema.unit}`;

    document.querySelectorAll(`[data-current="${key}"]`).forEach(el => {
        el.textContent = currentText;
    });

    if (pending[key] || s.dirty || document.activeElement === s.input) {
        return;
    }

    s.input.value = isNaN(raw) ? "" : s.fmt(raw);
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
        current.className = "setting-current";
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
    const enabled = canControl();
    const reason = controlBlockReason();

    document.querySelectorAll(".needs-control").forEach(el => {
        el.disabled = !enabled;
    });

    for (const id of ["control-note", "settings-note"]) {
        $(id).textContent = reason;
        $(id).hidden = !reason;
    }

    const setpoint = steppers.temperatura_zadana;
    $("setpoint-apply").hidden = !(setpoint && setpoint.dirty);

    $("settings-save").disabled = !enabled
        || !advancedKeys().some(key => steppers[key]?.dirty);
}


function renderAccess() {
    const unlocked = Boolean(getToken());

    $("access-disabled").hidden = config.control_enabled;
    $("access-locked").hidden = !config.control_enabled || unlocked;
    $("access-unlocked").hidden = !config.control_enabled || !unlocked;

    updateControls();
}


/* ---------- Tryb pracy ---------- */

function displayedMode() {
    return pending.tryb
        ? pending.tryb.value
        : String(lastState[TOPICS.boilerMode] ?? "").toUpperCase();
}


function syncMode() {
    const reported = String(lastState[TOPICS.boilerMode] ?? "").toUpperCase();
    const p = pending.tryb;

    if (p && reported === p.value) {
        delete pending.tryb;
    } else if (p && Date.now() > p.until) {
        delete pending.tryb;
        toast("ESP32 nie potwierdził zmiany trybu", true);
    }

    const mode = displayedMode();

    document.querySelectorAll("#mode-buttons button").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.mode === mode);
        btn.classList.toggle("pending", Boolean(pending.tryb) && btn.dataset.mode === mode);
    });

    $("setpoint-box").hidden = mode !== "AUTO";

    const setpoint = lastState[TOPICS.setpoint];
    $("ambient-sub").textContent = mode === "AUTO" && setpoint !== undefined
        ? `zadana ${formatNumber(setpoint)} °C`
        : "";
}


/* ---------- Wysyłanie komend ---------- */

async function sendSetting(key, value) {
    const token = getToken();

    if (!token) {
        toast("Najpierw odblokuj sterowanie w Ustawieniach", true);
        return false;
    }

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
            localStorage.removeItem(TOKEN_KEY);
            renderAccess();
            toast("Token nieprawidłowy – odblokuj ponownie", true);
            return false;
        }

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            toast(typeof err.detail === "string" ? err.detail : "Błąd wysyłania", true);
            return false;
        }

        pending[key] = { value, until: Date.now() + PENDING_TIMEOUT_MS };

        setTimeout(loadStatus, 1500);

        return true;

    } catch (error) {
        toast("Brak połączenia z serwerem", true);
        return false;
    }
}


async function onModeClick(mode) {
    if (mode === displayedMode()) {
        return;
    }

    if (!confirm(`Zmienić tryb pieca na ${mode}?`)) {
        return;
    }

    if (await sendSetting("tryb", mode)) {
        toast(`Wysłano tryb ${mode}`);
        syncMode();
    }
}


async function applySetpoint() {
    const value = readStepper("temperatura_zadana");

    if (value === null) {
        return;
    }

    if (await sendSetting("temperatura_zadana", value)) {
        steppers.temperatura_zadana.setDirty(false);
        syncStepper("temperatura_zadana");
        toast(`Wysłano temperaturę ${steppers.temperatura_zadana.fmt(value)} °C`);
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
        if (!await sendSetting(key, values[key])) {
            break;
        }

        steppers[key].setDirty(false);
        syncStepper(key);
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


function updateDashboard(data) {
    lastState = data;

    setText("water-temp", formatNumber(data[TOPICS.waterTemp]));
    setText("ambient-temp", formatNumber(data[TOPICS.ambientTemp]));
    setText("humidity", formatNumber(data[TOPICS.humidity]));

    setBadge("boiler-state", data[TOPICS.boilerState]);
    setBadge("grate-state", data[TOPICS.grateState]);

    updateEspStatus();
    syncMode();
    Object.keys(steppers).forEach(syncStepper);
    updateControls();

    setText("last-update", new Date().toLocaleTimeString("pl-PL"));
}


async function loadStatus() {
    try {
        const response = await fetch("/api/status");

        if (!response.ok) {
            throw new Error("HTTP " + response.status);
        }

        updateDashboard(await response.json());

    } catch (error) {
        console.error("Błąd pobierania danych:", error);
        lastState = {};
        updateEspStatus();
        updateControls();
    }
}


/* ---------- Wykresy ---------- */

// Safari nie parsuje mikrosekund (…:00.123456+00:00) – obcinamy do milisekund
function parseTime(ts) {
    return Date.parse(String(ts).replace(/(\.\d{3})\d+/, "$1"));
}


function formatTick(ms) {
    const d = new Date(ms);
    const time = d.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });

    if (selectedHours <= 24) {
        return time;
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
        makeDataset("Woda", "#f97316", { fill: true })
    ], "°C");

    charts.humidity = makeChart("chart-humidity", [
        makeDataset("Wilgotność", "#a78bfa", { fill: true })
    ], "%");
}


async function fetchHistory(topic) {
    const url = `/api/history?topic=${encodeURIComponent(topic)}`
        + `&hours=${selectedHours}&max_points=300`;

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error("HTTP " + response.status);
    }

    const json = await response.json();

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
        const [ambient, setpoint, water, humidity] = await Promise.all([
            fetchHistory(TOPICS.ambientTemp),
            fetchHistory(TOPICS.setpoint),
            fetchHistory(TOPICS.waterTemp),
            fetchHistory(TOPICS.humidity)
        ]);

        const now = Date.now();
        const min = now - selectedHours * 3600 * 1000;

        // Zadana jest publikowana tylko przy zmianie – przeciągamy ostatnią wartość do "teraz"
        if (setpoint.length > 0) {
            setpoint.push({ x: now, y: setpoint[setpoint.length - 1].y });
        }

        setChartData(charts.ambient, [ambient, setpoint], min, now);
        setChartData(charts.water, [water], min, now);
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
        const response = await fetch("/api/config");

        if (response.ok) {
            config = await response.json();
        }
    } catch (error) {
        console.error("Błąd pobierania konfiguracji:", error);
    }

    buildSettings();
    renderAccess();
}


window.addEventListener("DOMContentLoaded", async () => {
    initCharts();
    initRangeButtons();

    document.querySelectorAll("#mode-buttons button").forEach(btn => {
        btn.addEventListener("click", () => onModeClick(btn.dataset.mode));
    });

    $("setpoint-apply").addEventListener("click", applySetpoint);
    $("settings-save").addEventListener("click", saveSettings);
    $("access-locked").addEventListener("submit", unlock);
    $("logout-btn").addEventListener("click", lock);

    window.addEventListener("hashchange", showTab);
    showTab();

    await loadConfig();
    await loadStatus();

    setInterval(loadStatus, STATUS_INTERVAL_MS);

    setInterval(() => {
        if (currentTab === "wykresy" && !document.hidden) {
            loadCharts();
        }
    }, CHART_INTERVAL_MS);
});
