/**
 * Content script for Elation patient charts.
 *
 * Puts an "Associate Bracelet" button in the left column, after the patient
 * name cell and before the tags cell, so a bracelet can be linked without
 * opening the toolbar popup. The click runs the same `associate` command the
 * popup uses, so the write happens in the offscreen document that owns the
 * serial port.
 *
 * Elation renders the chart client side and replaces the left column on
 * navigation, so the button is re-anchored whenever the DOM or the URL change.
 */
"use strict";

const PATIENT_PATH = /^\/patient\/(\d+)(?:[/?#]|$)/;
const RECENT_ASSOCIATION_MS = 60000;
const RESYNC_DEBOUNCE_MS = 250;
const STATE_POLL_MS = 4000;
// How much taller than its text a tags cell may be and still count as one row.
const ROW_PADDING = 40;
// Used only when no neighbouring cell offers a hairline to copy.
const DEFAULT_DIVIDER = "1px solid #e0e0e0";

let patientId = null;
let connected = false;
let writing = false;
// True while this page owns an association, so a polled state cannot clear the
// busy flag before the offscreen document reports it.
let pending = false;
let anchor = null;

/* -------------------------------------------------------------------- *
 * The injected cell
 * -------------------------------------------------------------------- */

const container = document.createElement("div");
container.className = "rfid-associate";

const button = document.createElement("button");
button.type = "button";
button.className = "rfid-associate-button";
button.textContent = "Associate RFID Bracelet";

const status = document.createElement("p");
status.className = "rfid-associate-status";
status.hidden = true;

container.append(button, status);

function showStatus(text, tone = "neutral") {
  status.textContent = text;
  status.dataset.tone = tone;
  status.hidden = false;
}

function clearStatus() {
  status.textContent = "";
  status.hidden = true;
}

function updateControls() {
  button.disabled = !connected || writing;

  if (writing) {
    button.title = "Keep the bracelet on the reader until this finishes.";
  } else if (connected) {
    button.title = "Hold one bracelet on the reader."
      + " Its block 4 is overwritten with this patient id.";
  } else {
    button.title = "The reader is not connected."
      + " Open the extension's device page to authorize it.";
  }
}

/* -------------------------------------------------------------------- *
 * Anchoring
 *
 * Elation's markup is not ours to rely on, so the cells are located by what
 * they say rather than by class names, with looser fallbacks behind that.
 * -------------------------------------------------------------------- */

function tagsCell() {
  let deepest = null;

  // Ancestors come first in document order, so the last match is the cell
  // itself rather than a wrapper around half the column.
  for (const element of document.querySelectorAll("body *")) {
    if (element.childElementCount > 3 || container.contains(element)) {
      continue;
    }
    if (/^no tags$/i.test(element.textContent.trim())) {
      deepest = element;
    }
  }
  if (deepest) {
    return deepest;
  }

  // A patient with tags does not say "No tags", so fall back to the first
  // visible tag-ish cell near the top of the column.
  for (const element of document.querySelectorAll("[class*='tag' i], [id*='tag' i]")) {
    if (container.contains(element)) {
      continue;
    }
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && box.top + window.scrollY < 600) {
      return element;
    }
  }

  return null;
}

/**
 * A name candidate only counts when it sits entirely above the tags cell.
 * Without that test a heading inside the tags row itself could pass for the
 * patient name, and the button would end up sharing the tags cell.
 */
function nameCell(tags) {
  const target = tags?.getBoundingClientRect();

  const candidates = document.querySelectorAll(
    "[class*='patient-name' i], [class*='patientname' i], [class*='patient_name' i],"
    + " [id*='patient-name' i], [id*='patientname' i], [id*='patient_name' i], h1, h2, h3");

  for (const candidate of candidates) {
    if (container.contains(candidate) || !candidate.textContent.trim()) {
      continue;
    }
    if (!target) {
      return candidate;
    }
    const box = candidate.getBoundingClientRect();
    if (box.height > 0 && box.bottom <= target.top) {
      return candidate;
    }
  }

  return null;
}

/**
 * The cell that holds the tags: the outermost ancestor of the tags text that
 * still covers only that text's own line, give or take the cell's padding.
 * Anything taller is a wrapper around several cells and must not be crossed,
 * or the button would land above the patient name.
 */
function tagsRow(tags, name) {
  const text = tags.getBoundingClientRect();
  let cell = tags;

  while (cell.parentElement
    && cell.parentElement !== document.body
    && cell.parentElement !== document.documentElement
    && !(name && cell.parentElement.contains(name))) {
    const box = cell.parentElement.getBoundingClientRect();
    if (box.top < text.top - ROW_PADDING || box.bottom > text.bottom + ROW_PADDING) {
      break;
    }
    cell = cell.parentElement;
  }

  return cell;
}

/**
 * The button must occupy a cell of its own rather than squeeze into the tags
 * cell, so the placement is measured rather than assumed. It is accepted once
 * the button renders entirely above the tags text and spans its container the
 * way a cell does. A row laid out with flexbox puts an inserted child beside
 * its siblings, and a deeply padded row leaves it visibly inset; both are
 * corrected by moving one level out.
 */
function ownsRow(tags) {
  const box = container.getBoundingClientRect();
  const target = tags.getBoundingClientRect();
  const available = container.parentElement?.clientWidth ?? 0;

  return box.height > 0
    && box.bottom <= target.top + 1
    && box.width >= available * 0.8;
}

/**
 * The column separates its cells with hairlines, so the new cell needs one of
 * its own. Which edge carries it differs per page, hence the copy from a
 * neighbour instead of a hard-coded rule: a divider is only drawn when the
 * tags cell does not already draw one above itself.
 */
function edge(style, side) {
  return style[`border${side}Style`] !== "none"
    && parseFloat(style[`border${side}Width`]) > 0
    && style[`border${side}Color`] !== "transparent"
    && style[`border${side}Color`] !== "rgba(0, 0, 0, 0)";
}

function rule(style, side) {
  return `${style[`border${side}Width`]} ${style[`border${side}Style`]} `
    + `${style[`border${side}Color`]}`;
}

function applyDivider(cell) {
  container.style.borderBottom = "";

  const tagsStyle = getComputedStyle(cell);
  if (edge(tagsStyle, "Top")) {
    return;
  }

  const above = container.previousElementSibling;
  const aboveStyle = above && getComputedStyle(above);

  if (aboveStyle && edge(aboveStyle, "Bottom")) {
    container.style.borderBottom = rule(aboveStyle, "Bottom");
  } else if (edge(tagsStyle, "Bottom")) {
    container.style.borderBottom = rule(tagsStyle, "Bottom");
  } else {
    container.style.borderBottom = DEFAULT_DIVIDER;
  }
}

function mount() {
  const tags = tagsCell();
  const name = nameCell(tags);

  if (!tags) {
    if (name?.parentElement) {
      name.parentElement.insertBefore(container, name.nextSibling);
      anchor = container.nextSibling instanceof Element ? container.nextSibling : null;
    }
    return;
  }

  let cell = tagsRow(tags, name);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!cell.parentElement
      || (name && cell.contains(name))
      || cell.getBoundingClientRect().height > window.innerHeight * 0.6) {
      break;
    }
    cell.parentElement.insertBefore(container, cell);
    if (ownsRow(tags)) {
      anchor = cell;
      applyDivider(cell);
      return;
    }
    cell = cell.parentElement;
  }

  // Nothing measured well; leave the page as it was rather than wedge the
  // button into a row it does not fit.
  container.remove();
  anchor = null;
}

function unmount() {
  container.remove();
  anchor = null;
}

function mounted() {
  return container.isConnected
    && (anchor === null || (anchor.isConnected && container.nextSibling === anchor));
}

/**
 * A re-render that runs the column through innerHTML copies the cell as plain
 * markup, leaving a dead button behind once the live one is re-anchored.
 */
function dropCopies() {
  for (const copy of document.querySelectorAll(".rfid-associate")) {
    if (copy !== container) {
      copy.remove();
    }
  }
}

/* -------------------------------------------------------------------- *
 * Talking to the offscreen reader
 * -------------------------------------------------------------------- */

function command(cmd, extra = {}) {
  try {
    return chrome.runtime.sendMessage({ to: "offscreen", cmd, ...extra })
      .catch(() => undefined);
  } catch {
    // The extension was reloaded or disabled while this page stayed open.
    return Promise.resolve(undefined);
  }
}

function applyState(state) {
  connected = state.connected;
  if (!pending) {
    writing = state.busy;
  }
  updateControls();
}

async function loadState() {
  const state = await command("state");
  if (!state) {
    return;
  }

  applyState(state);

  const recent = state.lastAssociation
    && state.lastAssociation.id === patientId
    && Date.now() - state.lastAssociation.at < RECENT_ASSOCIATION_MS;
  if (recent && status.hidden) {
    showStatus(state.lastAssociation.message, state.lastAssociation.ok ? "success" : "error");
  }
}

// A port carries live status, and it also lets the offscreen document drop
// this page the moment it goes away. Polling is the backstop if the port never
// comes up, so a stale disabled button cannot outlive a reconnect.
function listen() {
  let events;
  try {
    events = chrome.runtime.connect({ name: "ui" });
  } catch {
    return;
  }

  events.onMessage.addListener((message) => {
    if (message.event === "busy") {
      applyState({ connected: message.state.connected, busy: message.state.commandBusy });
    } else if (message.event === "status") {
      connected = message.state === "online";
      updateControls();
    } else if (message.event === "associate" && message.id === patientId) {
      pending = false;
      writing = false;
      showStatus(message.message, message.ok ? "success" : "error");
      updateControls();
    }
  });

  events.onDisconnect.addListener(() => undefined);
}

/* -------------------------------------------------------------------- *
 * Actions
 * -------------------------------------------------------------------- */

button.addEventListener("click", async () => {
  if (!patientId) {
    return;
  }

  const target = patientId;
  pending = true;
  writing = true;
  updateControls();
  showStatus("Present and hold the bracelet on the reader...");

  const outcome = await command("associate", { id: target });

  pending = false;
  writing = false;
  updateControls();

  // The chart may have moved on while the reader waited for a bracelet.
  if (target !== patientId) {
    return;
  }
  if (outcome) {
    showStatus(outcome.message, outcome.ok ? "success" : "error");
  } else {
    showStatus("The reader service is not running.", "error");
  }
});

/* -------------------------------------------------------------------- *
 * Keeping up with the page
 * -------------------------------------------------------------------- */

function sync() {
  const id = location.pathname.match(PATIENT_PATH)?.[1] ?? null;

  if (id !== patientId) {
    patientId = id;
    pending = false;
    clearStatus();
    if (patientId) {
      loadState();
    }
  }

  if (!patientId) {
    unmount();
    dropCopies();
    return;
  }

  dropCopies();

  if (!mounted()) {
    mount();
    updateControls();
  }
}

let resync = null;
const observer = new MutationObserver(() => {
  if (resync) {
    return;
  }
  resync = setTimeout(() => {
    resync = null;
    sync();
  }, RESYNC_DEBOUNCE_MS);
});

/* -------------------------------------------------------------------- *
 * Startup
 * -------------------------------------------------------------------- */

updateControls();
sync();
listen();

observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("popstate", sync);

// pushState navigations fire no event, and the offscreen document may connect
// after this page loaded.
let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    sync();
  }
  if (patientId) {
    loadState();
  }
}, STATE_POLL_MS);
