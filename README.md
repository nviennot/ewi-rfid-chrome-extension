# EWI RFID Chrome Extension

Chrome Manifest V3 extension for the JADAK Flexpoint HS-1R (`VID 1A76`, `PID 0039`). It uses the Web Serial API to read MIFARE Classic block 4, treats that block as an Elation patient id, and opens `https://app.elationemr.com/patient/<id>` when a tag is scanned. It can also write application data to block 4.

## Install

1. Download [ewi-rfid-3.0.1.zip](https://github.com/nviennot/ewi-rfid-chrome-extension/releases/download/3.0.1/ewi-rfid-3.0.1.zip).
2. Open `chrome://extensions` in Google Chrome.
3. Enable **Developer mode**.
4. Drag and drop `ewi-rfid-3.0.1.zip` onto the extensions page.
5. The setup page opens automatically. Click **Authorize device**.

## Use

1. Select `FW-HS1R-04-A3` from Chrome's device picker. You can also authorize later from the extension popup.
2. Close the page. The reader keeps running in the background.
3. Open a patient page and click **Link RFID Bracelet** to associate a bracelet with that patient.
4. Scan a bracelet. Chrome opens that patient's chart.

Authorization is needed once per Chrome profile. After that the extension connects on its own at browser startup, retries every 5 seconds while the reader is unavailable, and reconnects when the reader is plugged back in.

## License

MIT License.
