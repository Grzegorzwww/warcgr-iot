const TOPICS = {
    waterTemp: "piec_gazowy/temperatura_wody",
    ambientTemp: "piec_gazowy/temperatura_otoczenia",
    humidity: "piec_gazowy/wilgotnosc",
    boilerState: "piec_gazowy/stan",
    boilerMode: "piec_gazowy/tryb",
    espStatus: "piec_gazowy/status_esp32",
    grateState: "piec_weglowy/ruszta"
};


function setText(id, value) {
    document.getElementById(id).textContent = value;
}


function updateStatus(data) {

    const espStatus = data[TOPICS.espStatus];

    const statusElement = document.getElementById("esp-status");
    const statusText = document.getElementById("esp-status-text");

    if (espStatus === "online") {
        statusElement.classList.remove("offline");
        statusElement.classList.add("online");
        statusText.textContent = "ONLINE";
    } else {
        statusElement.classList.remove("online");
        statusElement.classList.add("offline");
        statusText.textContent = "OFFLINE";
    }
}


function updateDashboard(data) {

    const waterTemp = data[TOPICS.waterTemp];
    const ambientTemp = data[TOPICS.ambientTemp];
    const humidity = data[TOPICS.humidity];

    setText(
        "water-temp",
        waterTemp !== undefined ? Number(waterTemp).toFixed(1) : "--"
    );

    setText(
        "ambient-temp",
        ambientTemp !== undefined ? Number(ambientTemp).toFixed(1) : "--"
    );

    setText(
        "humidity",
        humidity !== undefined ? Number(humidity).toFixed(1) : "--"
    );

    setText(
        "boiler-state",
        data[TOPICS.boilerState] ?? "--"
    );

    setText(
        "boiler-mode",
        data[TOPICS.boilerMode] ?? "--"
    );

    setText(
        "grate-state",
        data[TOPICS.grateState] ?? "--"
    );

    updateStatus(data);

    setText(
        "last-update",
        new Date().toLocaleTimeString("pl-PL")
    );
}


async function loadStatus() {

    try {

        const response = await fetch("/api/status");

        if (!response.ok) {
            throw new Error("HTTP " + response.status);
        }

        const data = await response.json();

        updateDashboard(data);

    } catch (error) {

        console.error("Błąd pobierania danych:", error);

    }
}


loadStatus();

setInterval(loadStatus, 5000);