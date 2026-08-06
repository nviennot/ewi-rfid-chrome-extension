/**
 * Offscreen document: the only context that holds the serial port.
 *
 * It lives for as long as the extension is enabled, so the reader stays
 * connected even when no tab is open. Tag reads are forwarded to the service
 * worker, which performs the Elation navigation. The reader UI page talks to
 * this document over chrome.runtime messages.
 */
"use strict";

const RECONNECT_INTERVAL_MS = 5000;
const SAME_TAG_COOLDOWN_MS = 3000;

const reader = new RfidReader();

let lastStatus = { message: "Not connected", state: "offline" };
let lastTag = { id: null, at: 0 };
let lastAssociation = null;

/* -------------------------------------------------------------------- *
 * Messaging helpers
 * -------------------------------------------------------------------- */

/**
 * The popup and the device page both listen, and either may disappear at any
 * moment, so each one holds a port and is dropped when the port closes.
 */
const uiPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ui") {
    return;
  }
  uiPorts.add(port);
  port.onDisconnect.addListener(() => uiPorts.delete(port));
});

function sendToUi(payload) {
  for (const port of uiPorts) {
    try {
      port.postMessage(payload);
    } catch {
      uiPorts.delete(port);
    }
  }
}

function snapshot() {
  return {
    connected: reader.connected,
    busy: reader.busy,
    supported: RfidReader.isSupported(),
    status: lastStatus,
    block: reader.block,
    waitingMessage: reader.waitingMessage,
    lastAssociation,
  };
}

/* -------------------------------------------------------------------- *
 * Reader events
 * -------------------------------------------------------------------- */

reader.on("status", ({ message, state }) => {
  lastStatus = { message, state };
  sendToUi({ event: "status", message, state });
});

reader.on("log", ({ direction, message }) => {
  sendToUi({ event: "log", direction, message });
});

reader.on("busy", (state) => {
  sendToUi({ event: "busy", state });
});

reader.on("prompt", (message) => sendToUi({ event: "result", message }));
reader.on("text", (message) => sendToUi({ event: "result", message }));

reader.onInteger((decimal) => {
  sendToUi({ event: "result", message: decimal });
  handleTag(decimal);
});

/**
 * A tag holds the patient id as an unsigned 128-bit integer. Blank tags read
 * back as zero and must not navigate anywhere.
 */
function handleTag(decimal) {
  const id = String(decimal).replace(/^0+(?=\d)/, "");

  if (!/^[1-9][0-9]*$/.test(id)) {
    sendToUi({ event: "result", message: `Tag holds no patient id (${decimal}).` });
    return;
  }

  const now = Date.now();
  if (id === lastTag.id && now - lastTag.at < SAME_TAG_COOLDOWN_MS) {
    // The reader repeats while a tag is held near the antenna.
    lastTag.at = now;
    return;
  }
  lastTag = { id, at: now };

  chrome.runtime.sendMessage({ to: "sw", event: "tag", id }).catch(() => {
    sendToUi({ event: "result", message: `Could not open patient ${id}.` });
  });
}

/* -------------------------------------------------------------------- *
 * Commands from the reader UI
 * -------------------------------------------------------------------- */

async function writeTag({ value, key }) {
  let outcome;

  await reader.writeInteger(value, {
    key,
    onSuccess: (decimal, info) => {
      outcome = {
        ok: true,
        message: `Block ${reader.block} write completed successfully: ${decimal}`
          + resumeSuffix(info),
      };
    },
    onFailure: (error, info) => {
      outcome = { ok: false, message: error.message + resumeSuffix(info) };
    },
  });

  return outcome ?? { ok: false, message: "The write did not report a result." };
}

function resumeSuffix({ automaticReadsResumed, resumeAttempted }) {
  if (!resumeAttempted) {
    return "";
  }
  return automaticReadsResumed
    ? ` ${reader.waitingMessage}`
    : " Automatic reads could not be restarted.";
}

/**
 * Link the bracelet on the antenna to a patient by writing the id from an
 * Elation chart URL into block 4.
 */
async function associate({ id }) {
  const patientId = String(id ?? "").replace(/^0+(?=\d)/, "");

  if (!/^[1-9][0-9]*$/.test(patientId)) {
    return { ok: false, message: "That page is not a patient chart." };
  }
  if (!reader.connected) {
    return { ok: false, message: "Connect the reader first." };
  }
  if (reader.busy) {
    return { ok: false, message: "The reader is busy. Try again in a moment." };
  }

  const outcome = await writeTag({ value: patientId });
  const result = outcome.ok
    ? { ok: true, id: patientId, message: `Bracelet linked to patient ${patientId}.` }
    : { ok: false, id: patientId, message: outcome.message };

  if (result.ok) {
    // Automatic reads resume with the bracelet still on the antenna. Without
    // this the reader would immediately reload the chart we are already on.
    lastTag = { id: patientId, at: Date.now() };
  }

  lastAssociation = { ...result, at: Date.now() };
  sendToUi({ event: "associate", ...result });
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.to !== "offscreen") {
    return undefined;
  }

  switch (message.cmd) {
    case "state":
      sendResponse(snapshot());
      return undefined;

    case "connect":
      reader.connect({ force: true }).then((connected) => {
        sendResponse({ connected, status: lastStatus });
      });
      return true;

    case "disconnect":
      reader.disconnect().then(() => sendResponse({ connected: reader.connected }));
      return true;

    case "write":
      writeTag(message).then(sendResponse);
      return true;

    case "associate":
      associate(message).then(sendResponse);
      return true;

    default:
      return undefined;
  }
});

/* -------------------------------------------------------------------- *
 * Startup
 * -------------------------------------------------------------------- */

if (!RfidReader.isSupported()) {
  lastStatus = { message: "Web Serial unavailable", state: "offline" };
} else {
  reader.connect();

  // Recover from a reader that was unplugged, busy, or not yet authorized.
  setInterval(() => {
    if (!reader.connected && !reader.busy) {
      reader.connect();
    }
  }, RECONNECT_INTERVAL_MS);
}
