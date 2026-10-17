"use strict";

const $ = id => document.getElementById(id);

const REFRESH_MS = 10000;
const CHART_REFRESH_MS = 60000;

const TILES = {
    power_w: ["m-power", 0],
    kwh: ["m-kwh", 3],
    kwh_last_1h: ["m-1h", 3],
    kwh_last_3h: ["m-3h", 3],
    kwh_last_24h: ["m-24h", 3]
};

const WATER_TILES = {
    temperatura: ["m-temp", 1]
};

let devices = [];
let selectedId = null;
let rangeHours = { prad: 24, woda: 24 };
let listSignature = "";
let authMode = "login";
let statusTimer = null;
let chartTimer = null;
let toastTimer = null;

const charts = {};
const openQr = new Set();


/* ---------- Pomocnicze ---------- */

function el(tag, className, text) {
    const node = document.createElement(tag);

    if (className) {
        node.className = className;
    }

    if (text !== undefined) {
        node.textContent = text;
    }

    return node;
}


function toast(message, isError = false) {
    const node = $("toast");

    node.textContent = message;
    node.className = "toast" + (isError ? " error" : "");
    node.hidden = false;

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3000);
}


async function api(path, options = {}) {
    const response = await fetch(path, {
        credentials: "same-origin",
        ...options,
        headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "warcgr-portal",
            ...(options.headers || {})
        }
    });

    let data = null;

    try {
        data = await response.json();
    } catch (error) {
        data = null;
    }

    if (!response.ok) {
        const message = typeof data?.detail === "string" ? data.detail : "Nieprawidłowe dane";
        const err = new Error(message);

        err.status = response.status;
        throw err;
    }

    return data;
}


function parseTime(ts) {
    // Safari nie parsuje mikrosekund – obcinamy do milisekund
    return Date.parse(String(ts).replace(/(\.\d{3})\d+/, "$1"));
}


function fmt(value, digits) {
    const n = Number(value);

    return value === undefined || value === null || isNaN(n) ? "--" : n.toFixed(digits);
}


/* ---------- Widoki: logowanie / panel ---------- */

function showAuth() {
    clearInterval(statusTimer);
    clearInterval(chartTimer);

    devices = [];
    selectedId = null;
    listSignature = "";

    $("auth-view").hidden = false;
    $("app-view").hidden = true;
    $("user-box").hidden = true;
}


function showApp(email) {
    $("auth-view").hidden = true;
    $("app-view").hidden = false;
    $("user-box").hidden = false;
    $("user-email").textContent = email;

    refreshDevices();
    clearInterval(statusTimer);
    clearInterval(chartTimer);
    statusTimer = setInterval(refreshDevices, REFRESH_MS);
    chartTimer = setInterval(() => {
        if (!document.hidden) {
            loadCharts();
        }
    }, CHART_REFRESH_MS);
}


function setView(view) {
    document.querySelectorAll("#view-switch button").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.view === view);
    });

    $("measure-view").hidden = view !== "measure";
    $("devices-view").hidden = view !== "devices";

    if (view === "measure") {
        Object.values(charts).forEach(chart => chart.resize());
        loadCharts();
    }
}


function setAuthMode(mode) {
    authMode = mode;

    document.querySelectorAll("#auth-mode button").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.mode === mode);
    });

    $("auth-submit").textContent = mode === "login" ? "Zaloguj" : "Utwórz konto";
    $("auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
    $("auth-hint").hidden = mode !== "register";
    $("auth-error").hidden = true;
}


async function submitAuth(event) {
    event.preventDefault();

    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;

    if (!email || !password) {
        return;
    }

    $("auth-submit").disabled = true;
    $("auth-error").hidden = true;

    try {
        const result = await api(`/api/${authMode}`, {
            method: "POST",
            body: JSON.stringify({ email, password })
        });

        $("auth-password").value = "";
        showApp(result.email);

    } catch (error) {
        $("auth-error").textContent = error.message;
        $("auth-error").hidden = false;

    } finally {
        $("auth-submit").disabled = false;
    }
}


async function logout() {
    try {
        await api("/api/logout", { method: "POST" });
    } catch (error) {
        // wylogowanie lokalne i tak się odbywa
    }

    showAuth();
}


/* ---------- Urządzenia ---------- */

async function refreshDevices() {
    try {
        devices = await api("/api/devices");
    } catch (error) {
        if (error.status === 401) {
            showAuth();
        }

        return;
    }

    const signature = devices.map(d => `${d.id}:${d.name}`).join("|");

    if (signature !== listSignature) {
        listSignature = signature;
        renderDeviceList();
        renderDeviceSelect();
    }

    updateOnlineBadges();
    renderMeasurements();
}


function currentDevice() {
    return devices.find(d => d.id === selectedId) || null;
}


function renderDeviceSelect() {
    const select = $("device-select");

    if (!devices.some(d => d.id === selectedId)) {
        selectedId = devices.length ? devices[0].id : null;
    }

    select.replaceChildren();

    for (const device of devices) {
        const option = el("option", "", `${device.name} — ${device.type_label}`);

        option.value = String(device.id);
        select.append(option);
    }

    if (selectedId !== null) {
        select.value = String(selectedId);
        loadCharts();
    }
}


function setOnlineBadge(node, online) {
    node.textContent = online ? "ONLINE" : "OFFLINE";
    node.classList.toggle("on", online);
    node.classList.toggle("off", !online);
}


function updateOnlineBadges() {
    document.querySelectorAll("[data-online-for]").forEach(node => {
        const device = devices.find(d => String(d.id) === node.dataset.onlineFor);

        if (device) {
            setOnlineBadge(node, device.online);
        }
    });
}


function renderDeviceList() {
    const list = $("device-list");

    list.replaceChildren();

    for (const device of devices) {
        const panel = el("div", "panel");

        const head = el("div", "device-head");
        const nameBox = el("div");
        const name = el("span", "device-name", device.name);
        const typeLabel = el("div", "muted small", device.type_label);
        const badge = el("span", "badge", "--");

        nameBox.append(name, typeLabel);
        badge.dataset.onlineFor = String(device.id);
        head.append(nameBox, badge);

        const token = el("code", "token-box", device.token);

        const actions = el("div", "device-actions");
        const copyBtn = el("button", "btn btn-secondary", "Kopiuj token");
        const qrBtn = el("button", "btn btn-secondary", "Kod QR");
        const delBtn = el("button", "btn btn-danger", "Usuń");

        copyBtn.type = qrBtn.type = delBtn.type = "button";
        actions.append(copyBtn, qrBtn, delBtn);

        const qrBox = el("div");
        qrBox.hidden = !openQr.has(device.id);

        if (!qrBox.hidden) {
            renderQr(qrBox, device.token);
        }

        copyBtn.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(device.token);
                toast("Token skopiowany");
            } catch (error) {
                toast("Zaznacz token i skopiuj ręcznie", true);
            }
        });

        qrBtn.addEventListener("click", () => {
            if (openQr.has(device.id)) {
                openQr.delete(device.id);
                qrBox.hidden = true;
                qrBox.replaceChildren();
                return;
            }

            openQr.add(device.id);
            renderQr(qrBox, device.token);
            qrBox.hidden = false;
        });

        delBtn.addEventListener("click", () => removeDevice(device));

        panel.append(head, token, actions, qrBox);
        list.append(panel);
    }
}


function renderQr(box, token) {
    box.replaceChildren();

    if (typeof qrcode === "undefined") {
        box.append(el("p", "muted small", "Kod QR niedostępny – użyj tokenu."));
        return;
    }

    const qr = qrcode(0, "M");

    qr.addData(token);
    qr.make();

    const img = el("img", "qr");

    img.alt = "Kod QR z tokenem urządzenia";
    img.src = qr.createDataURL(6, 4);
    box.append(img);
}


async function addDevice(event) {
    event.preventDefault();

    const name = $("device-name").value.trim();
    const deviceType = $("device-type").value;

    $("device-error").hidden = true;

    if (!name) {
        $("device-error").textContent = "Podaj nazwę urządzenia";
        $("device-error").hidden = false;
        return;
    }

    try {
        const device = await api("/api/devices", {
            method: "POST",
            body: JSON.stringify({ name, device_type: deviceType })
        });

        $("device-name").value = "";
        openQr.add(device.id);
        toast("Urządzenie dodane");
        await refreshDevices();

    } catch (error) {
        $("device-error").textContent = error.message;
        $("device-error").hidden = false;
    }
}


async function removeDevice(device) {
    if (!confirm(`Usunąć urządzenie „${device.name}”? Historia pomiarów zostanie skasowana.`)) {
        return;
    }

    try {
        await api(`/api/devices/${device.id}`, { method: "DELETE" });
        openQr.delete(device.id);
        toast("Urządzenie usunięte");
        await refreshDevices();

    } catch (error) {
        toast(error.message, true);
    }
}


/* ---------- Pomiary ---------- */

function syncRangeButtons(deviceType) {
    const selector = deviceType === "woda" ? "#range-buttons-woda button" : "#range-buttons button";
    const hours = rangeHours[deviceType];

    document.querySelectorAll(selector).forEach(btn => {
        btn.classList.toggle("active", Number(btn.dataset.hours) === hours);
    });
}


function renderMeasurements() {
    const device = currentDevice();

    $("no-devices").hidden = devices.length > 0;
    $("measure-content").hidden = !device;

    if (!device) {
        return;
    }

    setOnlineBadge($("device-status"), device.online);

    const isWater = device.device_type === "woda";

    $("measure-prad").hidden = isWater;
    $("measure-woda").hidden = !isWater;

    syncRangeButtons(device.device_type);

    const latest = device.latest || {};

    if (isWater) {
        for (const [metric, [id, digits]] of Object.entries(WATER_TILES)) {
            $(id).textContent = fmt(latest[metric], digits);
        }

        return;
    }

    for (const [metric, [id, digits]] of Object.entries(TILES)) {
        $(id).textContent = fmt(latest[metric], digits);
    }

    // Koszt doby tylko wtedy, gdy urządzenie go publikuje (cena podana w urządzeniu)
    $("m-cost-card").hidden = latest.cost_last_24h === undefined;
    $("m-cost").textContent = fmt(latest.cost_last_24h, 2);

    const historyHours = Number(latest.history_hours);

    $("history-warning").hidden = isNaN(historyHours) || historyHours >= 24;

    $("d-width").textContent = latest.pulse_width_ms === undefined ? "--" : `${fmt(latest.pulse_width_ms, 0)} ms`;
    $("d-rejected").textContent = fmt(latest.rejected_flashes, 0);
    $("d-history").textContent = latest.history_hours === undefined ? "--" : `${fmt(latest.history_hours, 0)} h`;

    $("d-pulses-row").hidden = latest.pulses === undefined;
    $("d-pulses").textContent = fmt(latest.pulses, 0);
}


/* ---------- Wykresy ---------- */

function formatTick(ms, hours) {
    const d = new Date(ms);

    if (hours <= 24) {
        return d.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
    }

    return d.toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit" });
}


function initCharts() {
    if (typeof Chart === "undefined") {
        console.error("Chart.js nie został załadowany");
        return;
    }

    const muted = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim();
    const grid = "rgba(148, 163, 184, 0.15)";
    const ticks = { color: muted };

    charts.power = new Chart($("chart-power"), {
        type: "line",
        data: {
            datasets: [{
                label: "Moc",
                data: [],
                borderColor: "#f97316",
                backgroundColor: "#f9731633",
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.25,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            parsing: false,
            interaction: { mode: "nearest", axis: "x", intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: items => new Date(items[0].parsed.x).toLocaleString("pl-PL"),
                        label: item => ` ${item.parsed.y.toFixed(0)} W`
                    }
                }
            },
            scales: {
                x: {
                    type: "linear",
                    ticks: { ...ticks, maxTicksLimit: 5, maxRotation: 0, callback: v => formatTick(v) },
                    grid: { color: grid }
                },
                y: { beginAtZero: true, grace: "5%", ticks, grid: { color: grid } }
            }
        }
    });

    charts.hourly = new Chart($("chart-hourly"), {
        type: "bar",
        data: {
            labels: [],
            datasets: [{
                label: "kWh",
                data: [],
                backgroundColor: "#38bdf8",
                borderRadius: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: item => ` ${item.parsed.y.toFixed(3)} kWh` } }
            },
            scales: {
                x: { ticks: { ...ticks, maxTicksLimit: 8, maxRotation: 0 }, grid: { display: false } },
                y: { beginAtZero: true, ticks, grid: { color: grid } }
            }
        }
    });

    charts.temperature = new Chart($("chart-temperature"), {
        type: "line",
        data: {
            datasets: [{
                label: "Temperatura",
                data: [],
                borderColor: "#38bdf8",
                backgroundColor: "#38bdf833",
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.25,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            parsing: false,
            interaction: { mode: "nearest", axis: "x", intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: items => new Date(items[0].parsed.x).toLocaleString("pl-PL"),
                        label: item => ` ${item.parsed.y.toFixed(1)} \u00b0C`
                    }
                }
            },
            scales: {
                x: {
                    type: "linear",
                    ticks: { ...ticks, maxTicksLimit: 5, maxRotation: 0, callback: v => formatTick(v, rangeHours.woda) },
                    grid: { color: grid }
                },
                y: { grace: "10%", ticks, grid: { color: grid } }
            }
        }
    });
}


function setEmpty(chart, empty) {
    chart.canvas.parentElement.classList.toggle("empty", empty);
}


async function loadCharts() {
    if (selectedId === null || $("measure-view").hidden) {
        return;
    }

    const device = currentDevice();

    if (!device) {
        return;
    }

    if (device.device_type === "woda") {
        await loadWaterChart(device);
    } else {
        await loadPowerCharts(device);
    }
}


async function loadPowerCharts(device) {
    if (!charts.power) {
        return;
    }

    const id = device.id;
    const hours = rangeHours.prad;

    try {
        const [power, hourlyData] = await Promise.all([
            api(`/api/devices/${id}/history?metric=power_w&hours=${hours}`),
            api(`/api/devices/${id}/hourly?hours=${hours}`)
        ]);

        if (id !== selectedId) {
            return;
        }

        const now = Date.now();
        const points = power.data
            .map(p => ({ x: parseTime(p.timestamp), y: p.value }))
            .filter(p => !isNaN(p.x));

        charts.power.data.datasets[0].data = points;
        charts.power.options.scales.x.min = now - hours * 3600 * 1000;
        charts.power.options.scales.x.max = now;
        charts.power.options.scales.x.ticks.callback = v => formatTick(v, hours);
        charts.power.update();
        setEmpty(charts.power, points.length === 0);

        const dayLabels = hours > 24;

        charts.hourly.data.labels = hourlyData.data.map(h => {
            const d = new Date(parseTime(h.hour));
            const time = d.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });

            return dayLabels
                ? `${d.toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit" })} ${time}`
                : time;
        });
        charts.hourly.data.datasets[0].data = hourlyData.data.map(h => h.kwh);
        charts.hourly.update();
        setEmpty(charts.hourly, hourlyData.data.length === 0);

    } catch (error) {
        if (error.status === 401) {
            showAuth();
        } else {
            console.error("Błąd pobierania wykresów:", error);
        }
    }
}


async function loadWaterChart(device) {
    if (!charts.temperature) {
        return;
    }

    const id = device.id;
    const hours = rangeHours.woda;

    try {
        const temp = await api(`/api/devices/${id}/history?metric=temperatura&hours=${hours}`);

        if (id !== selectedId) {
            return;
        }

        const now = Date.now();
        const points = temp.data
            .map(p => ({ x: parseTime(p.timestamp), y: p.value }))
            .filter(p => !isNaN(p.x));

        charts.temperature.data.datasets[0].data = points;
        charts.temperature.options.scales.x.min = now - hours * 3600 * 1000;
        charts.temperature.options.scales.x.max = now;
        charts.temperature.options.scales.x.ticks.callback = v => formatTick(v, hours);
        charts.temperature.update();
        setEmpty(charts.temperature, points.length === 0);

    } catch (error) {
        if (error.status === 401) {
            showAuth();
        } else {
            console.error("Błąd pobierania wykresu temperatury:", error);
        }
    }
}


/* ---------- Start ---------- */

window.addEventListener("DOMContentLoaded", async () => {
    initCharts();

    document.querySelectorAll("#auth-mode button").forEach(btn => {
        btn.addEventListener("click", () => setAuthMode(btn.dataset.mode));
    });

    document.querySelectorAll("#view-switch button").forEach(btn => {
        btn.addEventListener("click", () => setView(btn.dataset.view));
    });

    const rangeButtons = document.querySelectorAll("#range-buttons button");

    rangeButtons.forEach(btn => {
        btn.addEventListener("click", () => {
            rangeHours.prad = Number(btn.dataset.hours);
            rangeButtons.forEach(b => b.classList.toggle("active", b === btn));
            loadCharts();
        });
    });

    const rangeButtonsWoda = document.querySelectorAll("#range-buttons-woda button");

    rangeButtonsWoda.forEach(btn => {
        btn.addEventListener("click", () => {
            rangeHours.woda = Number(btn.dataset.hours);
            rangeButtonsWoda.forEach(b => b.classList.toggle("active", b === btn));
            loadCharts();
        });
    });

    $("device-select").addEventListener("change", event => {
        selectedId = Number(event.target.value);
        renderMeasurements();
        loadCharts();
    });

    $("auth-form").addEventListener("submit", submitAuth);
    $("device-form").addEventListener("submit", addDevice);
    $("logout-btn").addEventListener("click", logout);

    setAuthMode("login");

    try {
        const me = await api("/api/me");

        showApp(me.email);
    } catch (error) {
        showAuth();
    }
});
