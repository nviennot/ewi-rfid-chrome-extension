# EWI RFID Chrome Extension

Chrome Manifest V3 extension for the JADAK Flexpoint HS-1R (`VID 1A76`, `PID 0039`). It uses the Web Serial API to read MIFARE Classic block 4, treats that block as an Elation patient id, and opens `https://app.elationemr.com/patient/<id>` when a tag is scanned. It can also write application data to block 4.

## Install

1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `rfid-reader-extension` directory.
5. Click the extension toolbar icon, then **Open device page**.

## Use

1. Click **Authorize reader** and select `FW-HS1R-04-A3` from Chrome's device picker.
2. Close the page. The reader keeps running in the background.
3. Scan a bracelet. Chrome opens that patient's chart.

Authorization is needed once per Chrome profile. After that the extension connects on its own at browser startup, retries every 5 seconds while the reader is unavailable, and reconnects when the reader is plugged back in.

## Chart button

On a patient chart the extension inserts an **Associate Bracelet** button into the left column, in a cell of its own between the patient name and the tags row. It does the same thing as the popup action: hold a bracelet on the reader, click, and that patient id is written to block 4. The result appears under the button, and the button is disabled with an explanatory tooltip while the reader is offline or busy with another write.

Elation re-renders the left column client side, so the button is re-anchored whenever the column changes or the URL moves to another chart, and it is removed on pages that are not charts. The cells are found by their text rather than by Elation's class names, so a markup change moves the button rather than breaking it. If the tags row cannot be found at all, the button is placed directly after the patient name.

The placement is then measured rather than assumed: the button is only kept where it renders as a full-width cell above the tags text. A tags row laid out with flexbox would otherwise take the button in as another item on the same line, which is corrected by moving one level out.

## Toolbar popup

The toolbar button opens a small popup that adapts to the current tab.

On a `https://app.elationemr.com/patient/<id>` page (including sub-paths such as `/patient/4242/reports`) it offers **Associate bracelet with patient**, which writes that patient id to the bracelet held on the antenna. The button is disabled with an explanation while the reader is not connected. The bracelet is read again as soon as the write finishes, so that id is suppressed for the usual 3 seconds to keep the chart from reloading.

Anywhere else the popup shows the reader status and explains that a chart must be open. Both variants offer **Open device page** for authorizing, writing arbitrary values, and reading the serial log.

Association overwrites block 4, so keep a single bracelet on the reader. The popup closes if it loses focus, but the write continues in the background and its result is shown the next time the popup is opened within a minute.

## Where a scan navigates

Block 4 holds the patient id as an unsigned 128-bit integer, so a tag containing `12345` opens `https://app.elationemr.com/patient/12345`. The target tab is chosen in this order:

1. The active tab, if it is already on `app.elationemr.com`.
2. Otherwise the most recently used Elation tab, which is then focused. An active non-Elation tab is never hijacked.
3. Otherwise a new tab.

Blank tags read back as zero and are ignored. Holding a tag near the antenna repeats the read roughly once per second, so the same id is ignored for 3 seconds to avoid reloading the chart.

## Architecture

`navigator.serial` is `undefined` in Manifest V3 service workers, so `background.js` cannot hold the reader. The port lives in an **offscreen document** (`offscreen.html`) instead:

| Context | Role |
| --- | --- |
| `offscreen.js` | Owns the serial port for as long as the extension is enabled, converts block reads to patient ids, applies the repeat-scan cooldown, and performs writes. |
| `background.js` | Creates and re-creates the offscreen document, and navigates tabs when a tag is read. |
| `popup.js` | Toolbar popup: associates the bracelet with the patient in the current tab. |
| `content.js` | Chart button: injects **Associate Bracelet** into the Elation left column. |
| `reader.html` / `app.js` | Device page for authorizing the reader, writing tags, and watching the serial log. |

Neither UI opens the port. Both send commands to the offscreen document with `chrome.runtime.sendMessage` and hold a `chrome.runtime.connect` port for events, so the offscreen document drops a page the moment it closes without affecting the other. The content script uses the same two channels, plus a slow poll of the reader state as a backstop, so a chart left open overnight cannot show a stale disabled button.

Only `AUDIO_PLAYBACK` offscreen documents have a lifetime limit, so the reader stays connected with no tab open. Chrome's device picker needs a user gesture, which an offscreen document never has, so the device page calls `RfidReader.requestPermission()` on its behalf. The grant is stored per extension origin, so the offscreen document then finds the reader through `navigator.serial.getPorts()`. The picker also dismisses the popup, which is why authorization lives on the device page.

## Write Block 4

1. Enter a non-negative decimal number up to `340282366920938463463374607431768211455`.
2. Confirm the sector 1 Key A. The bracelet currently uses `FFFFFFFFFFFF`.
3. Click **Write block 4** and present one tag within 10 seconds.

The number is stored as an unsigned 128-bit big-endian integer. For example, decimal `12345` is written as `00000000000000000000000000003039`. Automatic block 4 reads convert the 16 stored bytes back to decimal before displaying them; the raw hexadecimal response remains available in the serial log.

The reader returns `#+` when the write succeeds. The extension then sends `#BEPSOND 0<CR>` so the reader emits a confirmation tone. The firmware response `#Write MifareClassic timeout` is reported as a timeout where no tag was written. `#-` is reported as a rejected write with guidance to check Key A and the sector access conditions. Failed and timed-out writes do not trigger the confirmation beep.

The extension sends this immediate operation without a RAM/ROM persistence suffix:

```text
#RFIDWBK 3 4 <128-bit integer as 32 hex characters> FFFFFFFFFFFF 0<CR>
```

Only block 4 is writable from the UI. Blocks 0 and 3 are not exposed because they contain manufacturer data and the sector 0 trailer. Block 7, the sector 1 trailer, is also not exposed.

Chrome requires the device picker once. After authorization, the extension automatically reconnects when the reader is available or plugged back in.

`reader.js` is loaded by the offscreen document and the device page, so a write issued from either UI is executed by the offscreen document that owns the port. The popup uses the same path through the `associate` command.

## Library API

`reader.js` is a standalone, DOM-free library that can be dropped into another app; `app.js` is only the UI for this extension. Loading `reader.js` defines the global `RfidReader` class (it also assigns `module.exports` when a CommonJS bundler is present).

```js
const reader = new RfidReader({ block: 4, key: "FFFFFFFFFFFF", autoConnect: true });

// 1. Authorize the device (shows Chrome's device picker, then connects).
await reader.authorize();

// 2. Receive block reads as a decimal string.
reader.onInteger((decimal) => console.log(decimal));

// 3. Write an integer to the block.
await reader.writeInteger("12345", {
  key: "FFFFFFFFFFFF",              // optional, defaults to the constructor key
  timeout: 10000,                   // optional, milliseconds to wait for a tag
  onSuccess: (decimal, info) => {},
  onFailure: (error, info) => {},
});
```

`writeInteger` also resolves to `true`/`false`. The `info` argument reports `automaticReadsResumed` and `resumeAttempted` so a UI can tell whether continuous reading restarted after the write.

Supporting members: `connect()` (reconnect silently to an already authorized reader, `connect({ force: true })` also cancels a previous manual disconnect), `disconnect()`, `startAutomaticReads()`, `waitingMessage`, `block`, `connected`, `busy`, `RfidReader.isSupported()`, `RfidReader.requestPermission()` (shows the device picker without opening the port; needs a user gesture) and `RfidReader.MAX_BLOCK_VALUE`.

Optional events via `reader.on(name, handler)`, which returns an unsubscribe function:

| Event | Payload | Meaning |
| --- | --- | --- |
| `integer` | `(decimal, { hex })` | Block read, same as `onInteger` |
| `text` | `(line)` | Tag data that is not a block read |
| `log` | `({ direction, message })` | `TX`, `RX`, `SYS` and `ERR` serial traffic |
| `status` | `({ message, state })` | Connection status, `state` is `offline` or `online` |
| `busy` | `({ commandBusy, connectionBusy, connected })` | Control enablement |
| `prompt` | `(message)` | Instructions such as "present a tag" |

Pass `autoConnect: false` to stop the library from registering `navigator.serial` connect/disconnect listeners.

This firmware ships with RFID suffixes disabled, so RFID packets do not include a line ending. The extension detects the end of those packets from a short serial idle period.

The read block is fixed to block 4. The native automatic read range is configured in RAM with:

```text
#RFIDMIN 4!<CR>
#RFIDMAX 4!<CR>
#UIDONLY 0!<CR>
```

UID output is configured with `RFIDUID 0`, so it matches the UID byte order in `bracelet.json`: `0440567A2E2091`.

All configuration commands use the `!` specifier and modify RAM only. Power cycling restores the reader's persisted settings.

Block reads use `RFIDTXT 0`, which makes the HS-1R return all 16 bytes as hexadecimal instead of dropping non-printable bytes. The extension converts those bytes from an unsigned big-endian integer to decimal for display. A zeroed block 4 is received as:

```text
(R)00000000000000000000000000000000
```

This avoids a host-side UID-to-block round trip: the tag does not need to remain present after an initial UID beep because the beep occurs after the automatic data capture.
