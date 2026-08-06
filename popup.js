/**
 * Toolbar popup. On an Elation chart it offers to link the bracelet on the
 * antenna to that patient; everywhere else it is a status readout with a way
 * into the device page. All device work happens in the offscreen document.
 */
"use strict";

const PATIENT_URL = /^https:\/\/app\.elationemr\.com\/patient\/(\d+)(?:[/?#]|$)/;
const RECENT_ASSOCIATION_MS = 60000;

const connectionState = document.querySelector("#connectionState");
const statusText = document.querySelector("#statusText");
const patientSection = document.querySelector("#patientSection");
const noPatientSection = document.querySelector("#noPatientSection");
const patientIdText = document.querySelector("#patientId");
const associateButton = document.querySelector("#associateButton");
const associateHint = document.querySelector("#associateHint");
const messageBox = document.querySelector("#message");
const deviceButton = document.querySelector("#deviceButton");

let patientId = null;
let connected = false;
let writing = false;

/* -------------------------------------------------------------------- *
 * Rendering
 * -------------------------------------------------------------------- */

function showStatus(message, state = "offline") {
  statusText.textContent = message;
  connectionState.dataset.state = state;
}

function showMessage(text, tone = "neutral") {
  messageBox.textContent = text;
  messageBox.dataset.tone = tone;
  messageBox.hidden = false;
}

function updateControls() {
  associateButton.disabled = !connected || writing;

  if (writing) {
    associateHint.textContent = "Keep the bracelet on the reader until this finishes.";
  } else if (connected) {
    associateHint.textContent =
      "Hold one bracelet on the reader. Its block 4 is overwritten with this patient id.";
  } else {
    associateHint.textContent =
      "The reader is not connected. Open the device page to authorize it.";
  }
}

/* -------------------------------------------------------------------- *
 * Talking to the offscreen reader
 * -------------------------------------------------------------------- */

function command(cmd, extra = {}) {
  return chrome.runtime.sendMessage({ to: "offscreen", cmd, ...extra })
    .catch(() => undefined);
}

// A port lets the offscreen document drop this popup as soon as it closes.
const events = chrome.runtime.connect({ name: "ui" });

events.onMessage.addListener((message) => {
  if (message.event === "status") {
    showStatus(message.message, message.state);
    updateControls();
  } else if (message.event === "busy") {
    // A write can be started from the device page, or by an earlier popup.
    connected = message.state.connected;
    writing = message.state.commandBusy;
    updateControls();
  } else if (message.event === "associate") {
    writing = false;
    showMessage(message.message, message.ok ? "success" : "error");
    updateControls();
  }
});

async function loadState({ retry = true } = {}) {
  const state = await command("state");

  if (!state) {
    if (!retry) {
      showStatus("Reader service unavailable");
      showMessage("The background reader did not start. Reload the extension.", "error");
      return;
    }
    await chrome.runtime.sendMessage({ to: "sw", cmd: "ensure-reader" }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await loadState({ retry: false });
    return;
  }

  connected = state.connected;
  writing = state.busy;
  showStatus(state.status.message, state.status.state);
  updateControls();

  if (writing) {
    showMessage("A bracelet is being written. Keep it on the reader.");
    return;
  }

  const recent = state.lastAssociation
    && Date.now() - state.lastAssociation.at < RECENT_ASSOCIATION_MS;
  if (recent) {
    showMessage(state.lastAssociation.message, state.lastAssociation.ok ? "success" : "error");
  }
}

/* -------------------------------------------------------------------- *
 * Actions
 * -------------------------------------------------------------------- */

associateButton.addEventListener("click", async () => {
  writing = true;
  updateControls();
  showMessage("Present and hold the bracelet on the reader...");

  const outcome = await command("associate", { id: patientId });

  writing = false;
  updateControls();
  if (outcome) {
    showMessage(outcome.message, outcome.ok ? "success" : "error");
  } else {
    showMessage("The reader service is not running.", "error");
  }
});

deviceButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

/* -------------------------------------------------------------------- *
 * Startup
 * -------------------------------------------------------------------- */

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  patientId = tab?.url?.match(PATIENT_URL)?.[1] ?? null;

  if (patientId) {
    patientIdText.textContent = patientId;
    patientSection.hidden = false;
  } else {
    noPatientSection.hidden = false;
  }

  updateControls();
  await loadState();
}

start();
