const TOPICS = {
    waterTemp: "piec_gazowy/temperatura_wody",
    ambientTemp: "piec_gazowy/temperatura_otoczenia",
    humidity: "piec_gazowy/wilgotnosc",
    boilerState: "piec_gazowy/stan",
    boilerMode: "piec_gazowy/tryb",
    espStatus: "piec_gazowy/status_esp32",
    grateState: "piec_weglowy/ruszta"
};

const TOKEN_KEY = "control_token";
const STATUS_INTERVAL_MS = 5000;
const CHART_INTERVAL_MS = 60000;

let selectedHours = 24;
let waterChart = null;
let ambientChart = null;


function $(id) {
    return document.getElementById(id);
}


function setText(id, value) {
    $(id).textContent = value;
}


function formatNumber(value) {
    return value !== undefined && !isNaN(Number(value))
        ? Number(value).toFixed(1)
        : "--";
}


function toast(message, isError = false) {
    const el = $("toast");

    el.textContent = message;
    el.classList.toggle("error", isError);
    el.classList.add("show");

    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), 3000);
}


/* ---------- Status ---------- */

function setBadge(id, value) {
    const el = $(id);
    const text = value ?? "--";

    el.textContent = text;
    el.classList.toggle("on", /^(on|1|true)$/i.test(text));
    el.classList.toggle("off", /^(off|0|false)$/i.test(text));
}


function updateStatus(data) {
    const online = data[TOPICS.espStatus] === "online";

    $("esp-status").classList.toggle("online", online);
    $("esp-status").classList.toggle("offline", !online);
    setText("esp-status-text", online ? "ONLINE" : "OFFLINE");
}


function updateModeButtons(mode) {
    document.querySelectorAll("#mode-buttons button").forEach(btn => {
        btn.classList.toggle(
            "active",
            btn.dataset.command === String(mode).toUpperCase()
        );
    });
}


function updateDashboard(data) {
    setText("water-temp", formatNumber(data[TOPICS.waterTemp]));
    setText("ambient-temp", formatNumber(data[TOPICS.ambientTemp]));
    setText("humidity", formatNumber(data[TOPICS.humidity]));

    setBadge("boiler-state", data[TOPICS.boilerState]);
    setBadge("boiler-mode", data[TOPICS.boilerMode]);
    setBadge("grate-state", data[TOPICS.grateState]);

    updateModeButtons(data[TOPICS.boilerMode]);
    updateStatus(data);

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
        updateStatus({});
    }
}


/* ---------- Wykresy ---------- */

function formatTick(ms) {
    const d = new Date(ms);
    const time = d.toLocaleTimeString("pl-PL", {
        hour: "2-digit",
        minute: "2-digit"
    });

    if (selectedHours <= 24) {
        return time;
    }

    return d.toLocaleDateString("pl-PL", {
        day: "2-digit",
        month: "2-digit"
    }) + " " + time;
}


function makeDataset(label, color, yAxisID) {
    return {
        label,
        data: [],
        borderColor: color,
        backgroundColor: color + "33",
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.25,
        fill: yAxisID === undefined,
        yAxisID
    };
}


function makeChart(canvasId, datasets, yAxes) {
    const muted = getComputedStyle(document.documentElement)
        .getPropertyValue("--muted").trim();

    const grid = "rgba(148, 163, 184, 0.15)";

    const scales = {
        x: {
            type: "linear",
            ticks: {
                color: muted,
                maxTicksLimit: 5,
                maxRotation: 0,
                callback: value => formatTick(value)
            },
            grid: { color: grid }
        }
    };

    for (const [id, opts] of Object.entries(yAxes)) {
        scales[id] = {
            position: opts.position,
            ticks: { color: muted },
            grid: { color: grid, drawOnChartArea: opts.drawGrid }
        };
    }

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
                        title: items => new Date(items[0].parsed.x)
                            .toLocaleString("pl-PL")
                    }
                }
            },
            scales
        }
    });
}


function initCharts() {
    if (typeof Chart === "undefined") {
        console.error("Chart.js nie został załadowany");
        return false;
    }

    waterChart = makeChart(
        "chart-water",
        [makeDataset("Woda °C", "#f97316")],
        { y: { position: "left", drawGrid: true } }
    );

    ambientChart = makeChart(
        "chart-ambient",
        [
            makeDataset("Otoczenie °C", "#38bdf8", "y"),
            makeDataset("Wilgotność %", "#a78bfa", "y1")
        ],
        {
            y: { position: "left", drawGrid: true },
            y1: { position: "right", drawGrid: false }
        }
    );

    return true;
}


async function fetchHistory(topic) {
    const url = `/api/history?topic=${encodeURIComponent(topic)}`
        + `&hours=${selectedHours}&max_points=300`;

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error("HTTP " + response.status);
    }

    const json = await response.json();

    return json.data.map(p => ({
        x: Date.parse(p.timestamp),
        y: p.value
    }));
}


async function loadCharts() {
    if (!waterChart) {
        return;
    }

    try {
        const [water, ambient, humidity] = await Promise.all([
            fetchHistory(TOPICS.waterTemp),
            fetchHistory(TOPICS.ambientTemp),
            fetchHistory(TOPICS.humidity)
        ]);

        const now = Date.now();
        const min = now - selectedHours * 3600 * 1000;

        waterChart.data.datasets[0].data = water;
        ambientChart.data.datasets[0].data = ambient;
        ambientChart.data.datasets[1].data = humidity;

        for (const chart of [waterChart, ambientChart]) {
            chart.options.scales.x.min = min;
            chart.options.scales.x.max = now;
            chart.update();
        }
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


/* ---------- Sterowanie ---------- */

const COMMAND_LABELS = {
    ON: "włączyć piec",
    OFF: "wyłączyć piec",
    AUTO: "przełączyć na tryb AUTO",
    MANUAL: "przełączyć na tryb MANUAL"
};


async function sendCommand(command) {
    let token = localStorage.getItem(TOKEN_KEY);

    if (!token) {
        token = prompt("Podaj token sterowania:");

        if (!token) {
            return;
        }
    }

    if (!confirm(`Czy na pewno ${COMMAND_LABELS[command]}?`)) {
        return;
    }

    const buttons = document.querySelectorAll("#control-section button");
    buttons.forEach(b => b.disabled = true);

    try {
        const response = await fetch("/api/control", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Control-Token": token
            },
            body: JSON.stringify({ device: "piec_gazowy", command })
        });

        if (response.status === 401) {
            localStorage.removeItem(TOKEN_KEY);
            toast("Nieprawidłowy token", true);
            return;
        }

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            toast(err.detail || "Błąd wysyłania komendy", true);
            return;
        }

        localStorage.setItem(TOKEN_KEY, token);
        toast("Wysłano: " + command);

        setTimeout(loadStatus, 1500);
    } catch (error) {
        toast("Brak połączenia z serwerem", true);
    } finally {
        buttons.forEach(b => b.disabled = false);
    }
}


async function initControl() {
    try {
        const response = await fetch("/api/config");
        const config = await response.json();

        if (!config.control_enabled) {
            return;
        }
    } catch (error) {
        return;
    }

    $("control-section").hidden = false;

    document.querySelectorAll("#control-section [data-command]")
        .forEach(btn => {
            btn.addEventListener("click", () => sendCommand(btn.dataset.command));
        });

    $("logout-btn").addEventListener("click", () => {
        localStorage.removeItem(TOKEN_KEY);
        toast("Wylogowano ze sterowania");
    });
}


/* ---------- Start ---------- */

window.addEventListener("DOMContentLoaded", () => {
    initCharts();
    initRangeButtons();
    initControl();

    loadStatus();
    loadCharts();

    setInterval(loadStatus, STATUS_INTERVAL_MS);
    setInterval(loadCharts, CHART_INTERVAL_MS);
});
