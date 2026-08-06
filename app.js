/**
 * Reader UI. The port itself lives in the offscreen document, so this page only
 * grants device permission (which needs a user gesture) and sends commands.
 */
"use strict";

const connectButton = document.querySelector("#connectButton");
const disconnectButton = document.querySelector("#disconnectButton");
const writeForm = document.querySelector("#writeForm");
const writeData = document.querySelector("#writeData");
const writeKey = document.querySelector("#writeKey");
const writeButton = document.querySelector("#writeButton");
const connectionState = document.querySelector("#connectionState");
const statusText = document.querySelector("#statusText");
const latestResult = document.querySelector("#latestResult");
const serialLog = document.querySelector("#serialLog");
const clearButton = document.querySelector("#clearButton");

let readerState = { connected: false, commandBusy: false, connectionBusy: false };

function updateControls() {
  connectButton.disabled = readerState.connected
    || readerState.commandBusy
    || readerState.connectionBusy;
  disconnectButton.disabled = !readerState.connected;
  writeButton.disabled = !readerState.connected || readerState.commandBusy;
}

function showResult(message) {
  latestResult.textContent = message;
  latestResult.classList.add("has-data");
}

function showStatus(message, state = "offline") {
  statusText.textContent = message;
  connectionState.dataset.state = state;
}

function appendLog(direction, message) {
  const timestamp = new Date().toLocaleTimeString();
  serialLog.textContent += `[${timestamp}] ${direction} ${message}\n`;
  serialLog.scrollTop = serialLog.scrollHeight;
}

/* -------------------------------------------------------------------- *
 * Talking to the offscreen reader
 * -------------------------------------------------------------------- */

function command(cmd, extra = {}) {
  return chrome.runtime.sendMessage({ to: "offscreen", cmd, ...extra })
    .catch(() => undefined);
}

async function loadState({ retry = true } = {}) {
  const state = await command("state");

  if (!state) {
    if (!retry) {
      showStatus("Reader service unavailable");
      showResult("The background reader did not start. Reload the extension.");
      return;
    }
    // The service worker may not have created the offscreen document yet.
    await chrome.runtime.sendMessage({ to: "sw", cmd: "ensure-reader" }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await loadState({ retry: false });
    return;
  }

  readerState = { ...readerState, connected: state.connected };
  showStatus(state.status.message, state.status.state);
  updateControls();

  if (!state.supported) {
    connectButton.disabled = true;
    showResult("Use a current desktop version of Google Chrome.");
  } else if (state.connected) {
    showResult(state.waitingMessage);
  }
}

// A port lets the offscreen document drop this page the moment it closes.
const events = chrome.runtime.connect({ name: "ui" });

events.onMessage.addListener((message) => {
  switch (message.event) {
    case "status":
      showStatus(message.message, message.state);
      break;
    case "log":
      appendLog(message.direction, message.message);
      break;
    case "busy":
      readerState = message.state;
      updateControls();
      break;
    case "associate":
    case "result":
      showResult(message.message);
      break;
    default:
      break;
  }
});

/* -------------------------------------------------------------------- *
 * Controls
 * -------------------------------------------------------------------- */

connectButton.addEventListener("click", async () => {
  try {
    // Chrome's picker needs a user gesture, which an offscreen document never
    // has. Permission is stored per extension origin, so the offscreen document
    // can open the port afterwards.
    await RfidReader.requestPermission();
  } catch (error) {
    if (error.name !== "NotFoundError") {
      showResult(error.message);
    }
    return;
  }

  showStatus("Connecting to reader...");
  const result = await command("connect");
  if (result && !result.connected) {
    showResult("The reader was authorized but could not be opened. Retrying in the background.");
  }
});

disconnectButton.addEventListener("click", () => command("disconnect"));

writeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const outcome = await command("write", { value: writeData.value, key: writeKey.value });
  showResult(outcome ? outcome.message : "The reader service is not running.");
});

clearButton.addEventListener("click", () => {
  serialLog.textContent = "";
  latestResult.textContent = "Waiting for a tag";
  latestResult.classList.remove("has-data");
});

updateControls();
loadState();
