"use strict";

const authorizeButton = document.querySelector("#authorizeButton");
const statusText = document.querySelector("#status");

function showStatus(message, tone = "neutral") {
  statusText.textContent = message;
  statusText.dataset.tone = tone;
}

function command(cmd) {
  return chrome.runtime.sendMessage({ to: "offscreen", cmd })
    .catch(() => undefined);
}

async function loadState() {
  if (!RfidReader.isSupported()) {
    authorizeButton.disabled = true;
    showStatus("Use a current desktop version of Google Chrome.", "error");
    return;
  }

  let state = await command("state");
  if (!state) {
    await chrome.runtime.sendMessage({ to: "sw", cmd: "ensure-reader" }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 400));
    state = await command("state");
  }

  if (state?.connected) {
    authorizeButton.disabled = true;
    authorizeButton.textContent = "Device authorized";
    showStatus("The reader is connected. You can close this page.", "success");
  }
}

authorizeButton.addEventListener("click", async () => {
  authorizeButton.disabled = true;
  authorizeButton.textContent = "Authorizing...";

  try {
    await RfidReader.requestPermission();
  } catch (error) {
    authorizeButton.disabled = false;
    authorizeButton.textContent = "Authorize device";
    if (error.name !== "NotFoundError") {
      showStatus(error.message, "error");
    }
    return;
  }

  showStatus("Connecting to the reader...");
  const result = await command("connect");
  if (result?.connected) {
    authorizeButton.textContent = "Device authorized";
    showStatus("The reader is connected. You can close this page.", "success");
  } else {
    authorizeButton.disabled = false;
    authorizeButton.textContent = "Try again";
    showStatus(
      result
        ? "The device was authorized but could not be opened. Check the USB connection and try again."
        : "The background reader is unavailable. Reload the extension and try again.",
      "error",
    );
  }
});

loadState();
