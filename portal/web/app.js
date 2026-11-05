"use strict";

const $ = id => document.getElementById(id);

const REFRESH_MS = 10000;
const CHART_REFRESH_MS = 60000;

const TILES = {
    power_w: ["m-power", 0],
    kwh: ["m-kwh", 3]
};

const WATER_TILES = {
    temperatura: ["m-temp", 1]
};

// Dane z firmware (patrz licznik_gazu_esp32: Configuration.hpp)
const SETUP_AP_SSID = "ESP32Config";
const SETUP_AP_PASS = "22446688";
const SETUP_ADDRESS = "192.168.4.1";

let devices = [];
let selectedId = null;
let rangeHours = { prad: 24, woda: 24 };
let listSignature = "";
let authMode = "login";
let currentUserKey = "anonymous";
let statusTimer = null;
let chartTimer = null;
let toastTimer = null;

const charts = {};
// id urządzenia -> otwarty panel na liście: "wizard" | "edit"
const openPanels = new Map();
const openQr = new Set();
// id urządzenia -> ostatnie podsumowanie z /summary
const summaries = new Map();


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

    if (value === undefined || value === null || value === "" || !isFinite(n)) {
        return "--";
    }

    return n.toLocaleString("pl-PL", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function isNumber(value) {
    return value !== undefined && value !== null && value !== "" && isFinite(Number(value));
}

function money(value) {
    return isNumber(value) ? `≈ ${fmt(value, 2)} zł` : "";
}


function timeAgo(epochSeconds) {
    const seconds = Math.max(0, Date.now() / 1000 - epochSeconds);

    if (seconds < 60) {
        return "przed chwilą";
    }

    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)} min temu`;
    }

    if (seconds < 86400) {
        return `${Math.floor(seconds / 3600)} godz. temu`;
    }

    const days = Math.floor(seconds / 86400);

    return days === 1 ? "wczoraj" : `${days} dni temu`;
}


function statusInfo(device) {
    if (device.online) {
        return { state: "on", text: "Online" };
    }

    if (device.last_seen) {
        return { state: "off", text: `Offline · ${timeAgo(device.last_seen)}` };
    }

    return { state: "never", text: "Nie podłączono" };
}


const ICONS = {
    prad: "M13 2 4 14h7l-1 8 9-12h-7l1-8z",
    woda: "M12 2.5S6 9.1 6 13.5a6 6 0 0 0 12 0c0-4.4-6-11-6-11z"
};

function icon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    const path = document.createElementNS(ns, "path");

    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    path.setAttribute("d", ICONS[name] || ICONS.prad);
    svg.append(path);

    return svg;
}


async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (error) {
            // próbujemy starszej metody poniżej
        }
    }

    const area = el("textarea");

    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, text.length);

    let ok = false;

    try {
        ok = document.execCommand("copy");
    } catch (error) {
        ok = false;
    }

    area.remove();

    return ok;
}


function selectText(node) {
    const range = document.createRange();
    const selection = window.getSelection();

    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
}

function storageKey(name) {
    return `warcgr-portal:${currentUserKey}:${name}`;
}

function readStored(name, fallback) {
    try {
        const value = window.localStorage.getItem(storageKey(name));

        return value === null ? fallback : JSON.parse(value);
    } catch (error) {
        return fallback;
    }
}

function writeStored(name, value) {
    try {
        window.localStorage.setItem(storageKey(name), JSON.stringify(value));
    } catch (error) {
        // localStorage może być niedostępny w bardzo ograniczonych środowiskach
    }
}


/* ---------- Widoki: logowanie / panel ---------- */

function showAuth() {
    clearInterval(statusTimer);
    clearInterval(chartTimer);

    devices = [];
    selectedId = null;
    listSignature = "";
    openPanels.clear();
    openQr.clear();
    summaries.clear();

    $("auth-view").hidden = false;
    $("app-view").hidden = true;
    $("user-box").hidden = true;
}


function showApp(email) {
    currentUserKey = String(email || "anonymous").trim().toLowerCase();

    $("auth-view").hidden = true;
    $("app-view").hidden = false;
    $("user-box").hidden = false;
    $("user-email").textContent = email;

    rangeHours.prad = Number(readStored("range-prad", 24));
    rangeHours.woda = Number(readStored("range-woda", 24));

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


// Otwiera kreator podłączania albo edycję urządzenia w zakładce „Urządzenia”
function openDevicePanel(deviceId, panel) {
    openPanels.set(deviceId, panel);
    setView("devices");
    renderDeviceList();

    const card = document.querySelector(`[data-device-card="${deviceId}"]`);

    if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "start" });
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

    const signature = devices.map(d => `${d.id}:${d.name}:${d.price_per_kwh}`).join("|");

    if (signature !== listSignature) {
        listSignature = signature;
        renderDeviceList();
        renderDeviceSelect();
    }

    updateStatuses();
    renderMeasurements();
}


function currentDevice() {
    return devices.find(d => d.id === selectedId) || null;
}


function renderDeviceSelect() {
    const select = $("device-select");

    const storedSelected = Number(readStored("selected-device-id", 0) || 0);

    if (!devices.some(d => d.id === selectedId)) {
        selectedId = devices.some(d => d.id === storedSelected)
            ? storedSelected
            : (devices.length ? devices[0].id : null);
    }

    select.replaceChildren();

    for (const device of devices) {
        const option = el("option", "", `${device.name} — ${device.type_label}`);

        option.value = String(device.id);
        select.append(option);
    }

    // Przy jednym urządzeniu wybór jest zbędny – pokazujemy samą nazwę
    const single = devices.length === 1;

    select.hidden = single;
    $("device-title").hidden = !single;
    $("device-title").textContent = single ? devices[0].name : "";

    if (selectedId !== null) {
        select.value = String(selectedId);
        writeStored("selected-device-id", selectedId);
        loadCharts();
    }
}


function setStatus(node, device) {
    const info = statusInfo(device);

    node.dataset.state = info.state;
    node.querySelector(".status-text").textContent = info.text;
}


function updateStatuses() {
    document.querySelectorAll("[data-status-for]").forEach(node => {
        const device = devices.find(d => String(d.id) === node.dataset.statusFor);

        if (device) {
            setStatus(node, device);
        }
    });

    document.querySelectorAll("[data-wizard-status-for]").forEach(node => {
        const device = devices.find(d => String(d.id) === node.dataset.wizardStatusFor);

        if (!device) {
            return;
        }

        node.classList.toggle("done", device.online);
        node.querySelector(".status-text").textContent = device.online
            ? "Urządzenie połączone – dane już spływają!"
            : "Czekam na pierwsze dane z urządzenia…";
    });
}


function statusNode(device) {
    const node = el("span", "status");

    node.append(el("span", "dot"), el("span", "status-text", "--"));
    node.dataset.statusFor = String(device.id);
    setStatus(node, device);

    return node;
}


function renderDeviceList() {
    const list = $("device-list");

    list.replaceChildren();

    for (const device of devices) {
        const panel = el("div", "panel device-card");
        const openPanel = openPanels.get(device.id);

        panel.dataset.deviceCard = String(device.id);

        const head = el("div", "device-head");
        const typeIcon = el("span", `type-icon ${device.device_type === "woda" ? "water" : "energy"}`);
        const nameBox = el("div", "device-head-text");

        typeIcon.append(icon(device.device_type));
        nameBox.append(el("div", "device-name", device.name), el("div", "muted small", device.type_label));
        head.append(typeIcon, nameBox, statusNode(device));

        const actions = el("div", "device-actions");
        const connectBtn = el("button", "btn " + (openPanel === "wizard" ? "btn-primary" : "btn-secondary"), "Podłącz");
        const editBtn = el("button", "btn " + (openPanel === "edit" ? "btn-primary" : "btn-secondary"), "Edytuj");
        const delBtn = el("button", "btn btn-danger", "Usuń");

        connectBtn.type = editBtn.type = delBtn.type = "button";
        actions.append(connectBtn, editBtn, delBtn);

        const togglePanel = name => {
            if (openPanels.get(device.id) === name) {
                openPanels.delete(device.id);
            } else {
                openPanels.set(device.id, name);
            }

            renderDeviceList();
        };

        connectBtn.addEventListener("click", () => togglePanel("wizard"));
        editBtn.addEventListener("click", () => togglePanel("edit"));
        delBtn.addEventListener("click", () => removeDevice(device));

        panel.append(head, actions);

        if (openPanel === "wizard") {
            panel.append(buildWizard(device));
        } else if (openPanel === "edit") {
            panel.append(buildEditor(device));
        }

        list.append(panel);
    }

    updateStatuses();
}


function wizardStep(number, title, ...content) {
    const step = el("li", "step");
    const body = el("div", "step-body");

    body.append(el("div", "step-title", title), ...content);
    step.append(el("span", "step-number", String(number)), body);

    return step;
}


function textWithStrong(parts) {
    // parts: ["zwykły tekst", ["pogrubiony"], ...] – bez innerHTML
    const p = el("p");

    for (const part of parts) {
        p.append(Array.isArray(part) ? el("strong", "", part[0]) : document.createTextNode(part));
    }

    return p;
}


function buildWizard(device) {
    const box = el("div", "wizard");

    box.append(el("h3", "", "Podłączanie urządzenia"));

    const steps = el("ol", "steps");

    // 1. Token – koniecznie przed przejściem na sieć urządzenia (tam nie ma internetu)
    const token = el("code", "token-box", device.token);
    const copyBtn = el("button", "btn btn-primary btn-copy", "Kopiuj token");
    const step1 = wizardStep(
        1,
        "Skopiuj token",
        el("p", "", "Zrób to teraz – po połączeniu z siecią urządzenia telefon straci dostęp do internetu i tej strony."),
        token,
        copyBtn
    );

    copyBtn.type = "button";
    copyBtn.addEventListener("click", async () => {
        if (await copyText(device.token)) {
            copyBtn.textContent = "Skopiowano ✓";
            step1.classList.add("done");
            toast("Token skopiowany");
        } else {
            selectText(token);
            toast("Token zaznaczony – skopiuj go ręcznie", true);
        }
    });

    const meterHint = device.device_type === "prad"
        ? " Możesz też wpisać aktualny stan licznika."
        : "";

    steps.append(
        step1,
        wizardStep(
            2,
            "Włącz tryb konfiguracji",
            el("p", "", "Przytrzymaj przycisk na urządzeniu i – nie puszczając go – podłącz urządzenie do prądu. "
                + "Puść przycisk po 2–3 sekundach.")
        ),
        wizardStep(
            3,
            "Połącz się z urządzeniem",
            textWithStrong(["Otwórz ustawienia Wi-Fi w telefonie i wybierz sieć ", [SETUP_AP_SSID],
                ". Hasło: ", [SETUP_AP_PASS], "."]),
            el("p", "muted small", "Jeśli telefon ostrzeże o braku internetu, wybierz „Pozostań połączony”.")
        ),
        wizardStep(
            4,
            "Wklej token i wybierz swoje Wi-Fi",
            textWithStrong(["Strona konfiguracji otworzy się sama (jeśli nie – wpisz w przeglądarce ",
                [SETUP_ADDRESS], "). Wybierz swoją sieć Wi-Fi, wpisz jej hasło, wklej token i zapisz." + meterHint])
        ),
        wizardStep(
            5,
            "Gotowe",
            el("p", "", "Urządzenie uruchomi się ponownie i połączy z Twoim Wi-Fi. "
                + "Wróć do domowej sieci – status poniżej zmieni się sam.")
        )
    );

    const waiting = el("div", "wizard-status");

    waiting.append(el("span", "dot"), el("span", "status-text", "--"));
    waiting.dataset.wizardStatusFor = String(device.id);

    const note = el("p", "note", "Tryb konfiguracji trwa ok. 3 minuty. Jeśli nie zdążysz, "
        + "odłącz zasilanie i zacznij od kroku 2.");

    // Kod QR: telefon po kroku 3 skanuje ekran komputera, token wpisuje się sam
    const qrPanel = el("div", "qr-panel");
    const qrBtn = el("button", "link-btn", openQr.has(device.id) ? "Ukryj kod QR" : "Pokaż kod QR");
    const qrBox = el("div");

    qrBtn.type = "button";
    qrPanel.append(
        el("p", "muted small", "Masz portal otwarty na komputerze? Po kroku 3 zeskanuj telefonem kod QR – "
            + "otworzy stronę urządzenia z już wpisanym tokenem."),
        qrBtn,
        qrBox
    );

    if (openQr.has(device.id)) {
        renderQr(qrBox, device.token);
    }

    qrBtn.addEventListener("click", () => {
        if (openQr.has(device.id)) {
            openQr.delete(device.id);
            qrBox.replaceChildren();
            qrBtn.textContent = "Pokaż kod QR";
            return;
        }

        openQr.add(device.id);
        renderQr(qrBox, device.token);
        qrBtn.textContent = "Ukryj kod QR";
    });

    box.append(steps, waiting, note, qrPanel);

    return box;
}


function parsePrice(text) {
    const value = String(text).trim().replace(",", ".");

    if (value === "") {
        return null;
    }

    const n = Number(value);

    return isFinite(n) && n >= 0 && n <= 100 ? n : NaN;
}


function buildEditor(device) {
    const form = el("form", "editor");
    const nameId = `edit-name-${device.id}`;
    const priceId = `edit-price-${device.id}`;

    const nameLabel = el("label", "control-label", "Nazwa");
    const nameInput = el("input", "text-input");

    nameLabel.htmlFor = nameId;
    nameInput.id = nameId;
    nameInput.maxLength = 40;
    nameInput.value = device.name;
    nameInput.autocomplete = "off";

    form.append(nameLabel, nameInput);

    let priceInput = null;

    if (device.device_type === "prad") {
        const priceLabel = el("label", "control-label", "Cena 1 kWh (zł, razem z opłatami)");

        priceInput = el("input", "text-input");
        priceLabel.htmlFor = priceId;
        priceInput.id = priceId;
        priceInput.inputMode = "decimal";
        priceInput.placeholder = "np. 1,10";
        priceInput.autocomplete = "off";
        priceInput.value = isNumber(device.price_per_kwh) ? String(device.price_per_kwh).replace(".", ",") : "";

        form.append(
            priceLabel,
            priceInput,
            el("p", "muted small", "Służy do szacowania kosztów. Zostaw puste, aby ją usunąć.")
        );
    }

    const error = el("p", "error-text");
    const save = el("button", "btn btn-primary", "Zapisz");

    error.hidden = true;
    save.type = "submit";
    form.append(error, save);

    form.addEventListener("submit", async event => {
        event.preventDefault();
        error.hidden = true;

        const body = { name: nameInput.value.trim() };

        if (!body.name) {
            error.textContent = "Podaj nazwę urządzenia";
            error.hidden = false;
            return;
        }

        if (priceInput) {
            const price = parsePrice(priceInput.value);

            if (Number.isNaN(price)) {
                error.textContent = "Cena musi być liczbą od 0 do 100 zł";
                error.hidden = false;
                return;
            }

            body.price_per_kwh = price;
        }

        save.disabled = true;

        try {
            await api(`/api/devices/${device.id}`, { method: "PATCH", body: JSON.stringify(body) });
            openPanels.delete(device.id);
            listSignature = "";
            toast("Zapisano");
            await refreshDevices();
            loadCharts();

        } catch (saveError) {
            error.textContent = saveError.message;
            error.hidden = false;
            save.disabled = false;
        }
    });

    return form;
}


function renderQr(box, token) {
    box.replaceChildren();

    if (typeof qrcode === "undefined") {
        box.append(el("p", "muted small", "Kod QR niedostępny – użyj tokenu."));
        return;
    }

    const qr = qrcode(0, "M");

    // Strona konfiguracyjna urządzenia przyjmuje ?token=... i sama wpisuje token
    qr.addData(`http://${SETUP_ADDRESS}/?token=${encodeURIComponent(token)}`);
    qr.make();

    const img = el("img", "qr");

    img.alt = "Kod QR otwierający konfigurację urządzenia z tokenem";
    img.src = qr.createDataURL(6, 4);
    box.append(img);
}


async function addDevice(event) {
    event.preventDefault();

    const name = $("device-name").value.trim();
    const checked = document.querySelector('input[name="device-type"]:checked');
    const deviceType = checked ? checked.value : "";

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
        openPanels.set(device.id, "wizard");
        toast("Urządzenie dodane – teraz je podłącz");
        await refreshDevices();

        const card = document.querySelector(`[data-device-card="${device.id}"]`);

        if (card) {
            card.scrollIntoView({ behavior: "smooth", block: "start" });
        }

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
        openPanels.delete(device.id);
        openQr.delete(device.id);
        summaries.delete(device.id);
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

    setStatus($("device-status"), device);
    $("not-connected").hidden = Boolean(device.online || device.last_seen);

    const isWater = device.device_type === "woda";

    $("measure-prad").hidden = isWater;
    $("measure-woda").hidden = !isWater;

    syncRangeButtons(device.device_type);

    const latest = device.latest || {};

    if (isWater) {
        for (const [metric, [id, digits]] of Object.entries(WATER_TILES)) {
            $(id).textContent = fmt(latest[metric], digits);
        }

        renderWaterSummary(device);
        return;
    }

    for (const [metric, [id, digits]] of Object.entries(TILES)) {
        $(id).textContent = fmt(latest[metric], digits);
    }

    const price = isNumber(device.price_per_kwh) ? Number(device.price_per_kwh) : null;

    // 24 h liczy samo urządzenie; koszt z ceny z portalu, a bez niej – z urządzenia (jeśli ją zna)
    $("m-24h").textContent = fmt(latest.kwh_last_24h, 2);
    $("m-24h-sub").textContent = price !== null && isNumber(latest.kwh_last_24h)
        ? money(Number(latest.kwh_last_24h) * price)
        : money(latest.cost_last_24h);

    $("price-text").textContent = price !== null
        ? `Cena prądu: ${fmt(price, 2)} zł/kWh`
        : "Ustaw cenę prądu, aby widzieć koszty";
    $("price-btn").textContent = price !== null ? "Zmień" : "Ustaw";

    const historyHours = Number(latest.history_hours);

    $("history-warning").hidden = isNaN(historyHours) || historyHours >= 24;

    $("d-width").textContent = latest.pulse_width_ms === undefined ? "--" : `${fmt(latest.pulse_width_ms, 0)} ms`;
    $("d-rejected").textContent = fmt(latest.rejected_flashes, 0);
    $("d-history").textContent = latest.history_hours === undefined ? "--" : `${fmt(latest.history_hours, 0)} h`;

    $("d-pulses-row").hidden = latest.pulses === undefined;
    $("d-pulses").textContent = fmt(latest.pulses, 0);

    renderEnergySummary(device);
}


function renderEnergySummary(device) {
    const summary = summaries.get(device.id);
    const price = isNumber(device.price_per_kwh) ? Number(device.price_per_kwh) : null;
    const cost = kwh => (price !== null && isNumber(kwh) ? money(Number(kwh) * price) : "");

    if (!summary || summary.device_type !== "prad") {
        ["m-today", "m-yesterday", "m-month", "m-base", "m-peak"].forEach(id => { $(id).textContent = "--"; });
        ["m-today-sub", "m-yesterday-sub", "m-month-sub", "m-peak-sub"].forEach(id => { $(id).textContent = ""; });
        $("insights-panel").hidden = true;
        return;
    }

    $("m-today").textContent = fmt(summary.today_kwh, 2);
    $("m-today-sub").textContent = cost(summary.today_kwh);

    $("m-yesterday").textContent = fmt(summary.yesterday_kwh, 2);
    $("m-yesterday-sub").textContent = cost(summary.yesterday_kwh);

    $("m-month").textContent = fmt(summary.month_forecast_kwh, 0);
    $("m-month-sub").textContent = isNumber(summary.month_forecast_kwh)
        ? cost(summary.month_forecast_kwh) || `średnio ${fmt(summary.avg_daily_kwh, 2)} kWh/dzień`
        : "potrzeba 1 pełnej doby danych";

    $("m-base").textContent = fmt(summary.base_load_w, 0);
    $("m-base-sub").textContent = isNumber(summary.base_load_w)
        ? "najspokojniejsza godzina doby"
        : "potrzeba kilku godzin danych";

    $("m-peak").textContent = fmt(summary.power_max_24h, 0);

    const peakParts = [];

    if (isNumber(summary.power_max_24h) && summary.power_max_at) {
        const at = new Date(parseTime(summary.power_max_at));

        peakParts.push(`o ${at.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`);
    }

    if (isNumber(summary.power_avg_24h)) {
        peakParts.push(`średnio ${fmt(summary.power_avg_24h, 0)} W`);
    }

    $("m-peak-sub").textContent = peakParts.join(" · ");

    renderInsights(summary, price);
}


const CO2_KG_PER_KWH = 0.7; // szacunkowy współczynnik emisji dla polskiego miksu energetycznego

function durationText(hours) {
    const totalMinutes = Math.round(hours * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;

    if (h === 0) {
        return `${m} min`;
    }

    return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function buildInsights(summary, price) {
    const facts = [];
    const insights = summary.insights || {};
    const cost = kwh => (price !== null ? ` (${money(kwh * price)})` : "");
    const pad = h => String(h).padStart(2, "0");

    if (isNumber(insights.peak_hour)) {
        const h = Number(insights.peak_hour);

        facts.push(["Godzina szczytu", `Najwięcej prądu zużywasz zwykle między ${pad(h)}:00 a ${pad((h + 1) % 24)}:00 – średnio ${fmt(insights.peak_hour_w, 0)} W.`]);
    }

    if (isNumber(insights.night_share_pct)) {
        facts.push(["Noc", `Na noc (22:00–6:00) przypada ${fmt(insights.night_share_pct, 0)}% Twojego zużycia.`]);
    }

    if (insights.busiest_day && isNumber(insights.busiest_day.kwh)) {
        const [y, m, d] = insights.busiest_day.date.split("-").map(Number);
        const label = new Date(y, m - 1, d).toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "long" });

        facts.push(["Rekordowy dzień", `Najwięcej prądu zużyto: ${label} – ${fmt(insights.busiest_day.kwh, 2)} kWh${cost(insights.busiest_day.kwh)}.`]);
    }

    if (isNumber(insights.hours_above_1kw)) {
        facts.push([
            "Duże odbiorniki",
            insights.hours_above_1kw < 1 / 60
                ? "W ostatniej dobie nic nie pobierało więcej niż 1 kW."
                : `W ostatniej dobie odbiorniki powyżej 1 kW pracowały łącznie ${durationText(insights.hours_above_1kw)}.`
        ]);
    }

    if (isNumber(summary.power_max_24h) && isNumber(summary.power_avg_24h) && Number(summary.power_avg_24h) > 0) {
        facts.push(["Skoki mocy", `Szczyt mocy był ${fmt(summary.power_max_24h / summary.power_avg_24h, 1)}× wyższy niż średni pobór.`]);
    }

    if (isNumber(summary.base_load_w) && Number(summary.base_load_w) > 0) {
        const yearKwh = Number(summary.base_load_w) * 8.76;
        const share = isNumber(summary.avg_daily_kwh) && Number(summary.avg_daily_kwh) > 0
            ? Number(summary.base_load_w) * 24 / 1000 / Number(summary.avg_daily_kwh) * 100
            : null;

        facts.push([
            "Pobór w tle",
            `Urządzenia w gotowości i pracujące non stop biorą ${fmt(summary.base_load_w, 0)} W`
                + (share !== null ? ` – ok. ${fmt(Math.min(share, 100), 0)}% całego zużycia` : "")
                + `, czyli ok. ${fmt(yearKwh, 0)} kWh rocznie${cost(yearKwh)}.`
        ]);
    }

    if (isNumber(summary.avg_daily_kwh)) {
        const yearKwh = Number(summary.avg_daily_kwh) * 365;

        facts.push(["Prognoza roczna", `Przy takim tempie w ciągu roku zużyjesz ok. ${fmt(yearKwh, 0)} kWh${cost(yearKwh)}.`]);
    }

    if (isNumber(summary.month_forecast_kwh)) {
        facts.push(["Ślad węglowy", `Prognozowane zużycie na miesiąc to szacunkowo ${fmt(Number(summary.month_forecast_kwh) * CO2_KG_PER_KWH, 0)} kg CO₂.`]);
    }

    return facts;
}

function renderInsights(summary, price) {
    const facts = buildInsights(summary, price);

    $("insights-list").replaceChildren(...facts.map(([title, text]) => {
        const item = document.createElement("li");
        const strong = document.createElement("strong");

        strong.textContent = title;
        item.append(strong, ` ${text}`);

        return item;
    }));
    $("insights-panel").hidden = facts.length === 0;
}


function renderWaterSummary(device) {
    const summary = summaries.get(device.id);
    const valid = summary && summary.device_type === "woda";

    $("m-tmin").textContent = valid ? fmt(summary.min, 1) : "--";
    $("m-tavg").textContent = valid ? fmt(summary.avg, 1) : "--";
    $("m-tmax").textContent = valid ? fmt(summary.max, 1) : "--";

    const trendNode = $("m-trend");
    const trend = valid ? summary.trend_per_hour : null;

    trendNode.classList.remove("up", "down");

    if (!isNumber(trend)) {
        trendNode.textContent = "--";
    } else if (Math.abs(trend) < 0.3) {
        trendNode.textContent = "→ stała";
    } else {
        trendNode.textContent = `${trend > 0 ? "↑" : "↓"} ${fmt(Math.abs(trend), 1)} °C/h`;
        trendNode.classList.add(trend > 0 ? "up" : "down");
    }
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

    charts.daily = new Chart($("chart-daily"), {
        type: "bar",
        data: {
            labels: [],
            datasets: [{
                label: "kWh",
                data: [],
                backgroundColor: [],
                borderRadius: 6,
                maxBarThickness: 42
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: item => {
                            const day = dailyInfo.days[item.dataIndex];
                            let text = ` ${fmt(item.parsed.y, 2)} kWh`;

                            if (dailyInfo.price !== null) {
                                text += ` · ${money(item.parsed.y * dailyInfo.price)}`;
                            }

                            if (day && !day.complete) {
                                text += " (niepełna doba)";
                            }

                            return text;
                        }
                    }
                }
            },
            scales: {
                x: { ticks: { ...ticks, maxRotation: 0 }, grid: { display: false } },
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


// Dane do podpowiedzi wykresu dziennego (pełna doba / koszt)
const dailyInfo = { days: [], price: null };

function updateDailyChart(summary, device) {
    if (!charts.daily) {
        return;
    }

    const days = summary.days || [];

    dailyInfo.days = days;
    dailyInfo.price = isNumber(device.price_per_kwh) ? Number(device.price_per_kwh) : null;

    charts.daily.data.labels = days.map((day, index) => {
        if (index === days.length - 1) {
            return "dziś";
        }

        const [y, m, d] = day.date.split("-").map(Number);

        return new Date(y, m - 1, d).toLocaleDateString("pl-PL", { weekday: "short", day: "numeric" });
    });
    charts.daily.data.datasets[0].data = days.map(day => day.kwh);
    charts.daily.data.datasets[0].backgroundColor = days.map(day => (day.complete ? "#818cf8" : "#818cf866"));
    charts.daily.update();
    setEmpty(charts.daily, !days.some(day => day.kwh !== null));
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
        const [power, hourlyData, summary] = await Promise.all([
            api(`/api/devices/${id}/history?metric=power_w&hours=${hours}`),
            api(`/api/devices/${id}/hourly?hours=${hours}`),
            api(`/api/devices/${id}/summary`)
        ]);

        if (id !== selectedId) {
            return;
        }

        const current = currentDevice() || device;

        summaries.set(id, summary);
        renderEnergySummary(current);
        updateDailyChart(summary, current);

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
        const [temp, summary] = await Promise.all([
            api(`/api/devices/${id}/history?metric=temperatura&hours=${hours}`),
            api(`/api/devices/${id}/summary?hours=${hours}`)
        ]);

        if (id !== selectedId) {
            return;
        }

        summaries.set(id, summary);
        renderWaterSummary(currentDevice() || device);

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
            writeStored("range-prad", rangeHours.prad);
            rangeButtons.forEach(b => b.classList.toggle("active", b === btn));
            loadCharts();
        });
    });

    const rangeButtonsWoda = document.querySelectorAll("#range-buttons-woda button");

    rangeButtonsWoda.forEach(btn => {
        btn.addEventListener("click", () => {
            rangeHours.woda = Number(btn.dataset.hours);
            writeStored("range-woda", rangeHours.woda);
            rangeButtonsWoda.forEach(b => b.classList.toggle("active", b === btn));
            loadCharts();
        });
    });

    $("device-select").addEventListener("change", event => {
        selectedId = Number(event.target.value);
        writeStored("selected-device-id", selectedId);
        renderMeasurements();
        loadCharts();
    });

    $("auth-form").addEventListener("submit", submitAuth);
    $("device-form").addEventListener("submit", addDevice);
    $("logout-btn").addEventListener("click", logout);

    $("start-add-btn").addEventListener("click", () => {
        setView("devices");
        $("device-name").focus();
    });

    $("not-connected-btn").addEventListener("click", () => {
        if (selectedId !== null) {
            openDevicePanel(selectedId, "wizard");
        }
    });

    $("price-btn").addEventListener("click", () => {
        if (selectedId !== null) {
            openDevicePanel(selectedId, "edit");
        }
    });

    setAuthMode("login");

    try {
        const me = await api("/api/me");

        showApp(me.email);
    } catch (error) {
        showAuth();
    }
});
