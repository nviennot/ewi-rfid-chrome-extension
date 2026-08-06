/**
 * Service worker: keeps the offscreen reader alive and turns tag reads into
 * Elation navigations. Web Serial is unavailable here (navigator.serial is
 * undefined in service workers), so all device work happens in offscreen.js.
 */
"use strict";

const OFFSCREEN_PAGE = "offscreen.html";
const KEEPALIVE_ALARM = "ensure-reader";
const ELATION_ORIGIN = "https://app.elationemr.com";
const ELATION_TAB_MATCH = `${ELATION_ORIGIN}/*`;

/* -------------------------------------------------------------------- *
 * Offscreen document lifecycle
 * -------------------------------------------------------------------- */

let creating;

async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PAGE)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await offscreenExists()) {
    return;
  }

  if (creating) {
    await creating;
    return;
  }

  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PAGE,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification:
      "Holds the Web Serial connection to the JADAK RFID reader, which service workers cannot open.",
  });

  try {
    await creating;
  } catch (error) {
    // A parallel call may have won the race.
    if (!/single offscreen document|already exists/i.test(error.message)) {
      console.error("Could not start the RFID reader service:", error);
    }
  } finally {
    creating = undefined;
  }
}

ensureOffscreen();
chrome.runtime.onStartup.addListener(ensureOffscreen);
chrome.runtime.onInstalled.addListener((details) => {
  ensureOffscreen()
    .then(() => {
      if (details.reason === "install") {
        return chrome.tabs.create({ url: chrome.runtime.getURL("install.html") });
      }
      return undefined;
    })
    .catch((error) => console.error("Could not complete RFID extension setup:", error));
});
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    ensureOffscreen();
  }
});

// The toolbar button opens popup.html, which offers the actions that make
// sense for the current tab, so there is no action.onClicked handler.

/* -------------------------------------------------------------------- *
 * Tag reads to patient charts
 * -------------------------------------------------------------------- */

function isElationTab(tab) {
  return typeof tab?.url === "string" && tab.url.startsWith(`${ELATION_ORIGIN}/`);
}

/**
 * Prefer the tab the user is looking at, fall back to the most recently used
 * Elation tab, and open a new tab when Elation is not open at all.
 */
async function openPatient(id) {
  const url = `${ELATION_ORIGIN}/patient/${id}`;

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (isElationTab(activeTab)) {
    await chrome.tabs.update(activeTab.id, { url });
    return;
  }

  const elationTabs = await chrome.tabs.query({ url: ELATION_TAB_MATCH });
  if (elationTabs.length > 0) {
    const target = elationTabs.reduce((newest, tab) =>
      (tab.lastAccessed ?? 0) > (newest.lastAccessed ?? 0) ? tab : newest);
    await chrome.tabs.update(target.id, { url, active: true });
    if (target.windowId !== undefined) {
      await chrome.windows.update(target.windowId, { focused: true });
    }
    return;
  }

  await chrome.tabs.create({ url });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.to !== "sw") {
    return undefined;
  }

  if (message.event === "tag") {
    openPatient(message.id)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.cmd === "ensure-reader") {
    ensureOffscreen().then(() => sendResponse({ ok: true }));
    return true;
  }

  return undefined;
});
