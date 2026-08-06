/**
 * JADAK Flexpoint HS-1R reader library.
 *
 * Public API:
 *   const reader = new RfidReader();
 *   await reader.authorize();                     // Chrome device picker, then connect
 *   reader.onInteger((decimalString) => { ... }); // block reads, as a decimal string
 *   await reader.writeInteger(value, { onSuccess, onFailure });
 *
 * The library never touches the DOM. Everything a UI needs is reported through
 * events: "integer", "text", "log", "status", "busy" and "prompt".
 */
(function initRfidReaderLibrary(global) {
  "use strict";

  const JADAK_FILTER = {
    usbVendorId: 0x1a76,
    usbProductId: 0x0039,
  };
  const DEFAULT_BLOCK = 4;
  const DEFAULT_KEY_A = "FFFFFFFFFFFF";
  const DEFAULT_WRITE_TIMEOUT = 10000;
  const MAX_BLOCK_VALUE = (1n << 128n) - 1n;
  const BLOCK_READ_PATTERN = /^\(R\)([0-9A-F]{32})$/i;
  const SERIAL_OPTIONS = {
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    flowControl: "none",
  };
  const EVENT_NAMES = ["integer", "text", "log", "status", "busy", "prompt"];

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function isJadakPort(candidate) {
    const info = candidate.getInfo();
    return info.usbVendorId === JADAK_FILTER.usbVendorId
      && info.usbProductId === JADAK_FILTER.usbProductId;
  }

  class RfidReader {
    #block;
    #defaultKey;
    #port;
    #reader;
    #readLoopPromise;
    #keepReading = false;
    #receiveBuffer = "";
    #receiveFlushTimer;
    #commandBusy = false;
    #connectionBusy = false;
    #allowAutoConnect = true;
    #automaticReadEnabled = false;
    #lineWaiters = new Set();
    #listeners = new Map();

    constructor({ block = DEFAULT_BLOCK, key = DEFAULT_KEY_A, autoConnect = true } = {}) {
      this.#block = block;
      this.#defaultKey = key;

      for (const name of EVENT_NAMES) {
        this.#listeners.set(name, new Set());
      }

      if (autoConnect && RfidReader.isSupported()) {
        navigator.serial.addEventListener("connect", () => {
          this.#allowAutoConnect = true;
          this.connect();
        });
        navigator.serial.addEventListener("disconnect", (event) => {
          if (event.target === this.#port) {
            this.#keepReading = false;
            this.#rejectLineWaiters("Reader unplugged.");
            this.#readLoopPromise = undefined;
            this.#resetConnection("Reader disconnected", "USB reader disconnected");
          }
        });
      }
    }

    static isSupported() {
      return typeof navigator !== "undefined" && "serial" in navigator;
    }

    /**
     * Show Chrome's device picker so the current origin gains permission for the
     * reader, without opening the port. Must be called from a user gesture, so a
     * visible page has to do this on behalf of headless contexts such as an
     * offscreen document. Throws NotFoundError when the picker is dismissed.
     */
    static async requestPermission() {
      if (!RfidReader.isSupported()) {
        throw new Error("Web Serial is unavailable in this browser.");
      }
      await navigator.serial.requestPort({ filters: [JADAK_FILTER] });
      return true;
    }

    static get MAX_BLOCK_VALUE() {
      return MAX_BLOCK_VALUE;
    }

    get block() {
      return this.#block;
    }

    get connected() {
      return Boolean(this.#port);
    }

    get busy() {
      return this.#commandBusy || this.#connectionBusy;
    }

    /* ------------------------------------------------------------------ *
     * Public API
     * ------------------------------------------------------------------ */

    /** Ask Chrome for permission to use the reader, then connect to it. */
    async authorize() {
      this.#allowAutoConnect = true;
      return this.#openSelectedPort({ prompt: true });
    }

    /**
     * Connect to an already authorized reader without showing the picker.
     * Pass `{ force: true }` to re-enable automatic connections after a manual
     * disconnect().
     */
    async connect({ force = false } = {}) {
      if (force) {
        this.#allowAutoConnect = true;
      }
      return this.#openSelectedPort({ prompt: false });
    }

    /** Subscribe to block reads. The callback receives the value as a decimal string. */
    onInteger(callback) {
      return this.on("integer", callback);
    }

    /**
     * Write an integer to the configured block.
     *
     * @param {string|number|bigint} value Non-negative integer, up to 128 bits.
     * @param {object} [options]
     * @param {string} [options.key] Sector Key A, 12 hexadecimal characters.
     * @param {number} [options.timeout] Milliseconds to wait for a tag.
     * @param {(decimal: string, info: object) => void} [options.onSuccess]
     * @param {(error: Error, info: object) => void} [options.onFailure]
     * @returns {Promise<boolean>} Whether the write succeeded.
     */
    async writeInteger(value, options = {}) {
      const {
        key = this.#defaultKey,
        timeout = DEFAULT_WRITE_TIMEOUT,
        onSuccess,
        onFailure,
      } = options;

      let request;
      try {
        request = this.#buildWriteCommand(value, key);
        if (!this.#port) {
          throw new Error("Connect the reader first.");
        }
      } catch (error) {
        onFailure?.(error, { automaticReadsResumed: false, resumeAttempted: false });
        return false;
      }

      const resumeAutomaticReads = this.#automaticReadEnabled;
      this.#automaticReadEnabled = false;
      this.#setCommandBusy(true);

      let failure;
      try {
        await this.#sendSetting("#RFIDMOD 1!");
        await this.#sendSetting("#RFIDTXT 0!");
        await this.#sendSetting(`#RFIDTMO ${timeout}!`);
        this.#emit("prompt", `Present and hold one tag near the reader. Waiting up to ${Math.round(timeout / 1000)} seconds...`);

        const response = await this.#sendCommandAndWait(
          request.command,
          (line) => line === "#+"
            || line === "#-"
            || /error|fail|timeout/i.test(line),
          timeout + 1500,
        );
        if (/^#Write MifareClassic timeout$/i.test(response)) {
          throw new Error(`Block ${this.#block} write timed out. No tag was written.`);
        }
        if (response === "#-") {
          throw new Error(`Block ${this.#block} write was rejected. Check the sector 1 Key A and tag access conditions.`);
        }
        if (response !== "#+") {
          throw new Error(`Block ${this.#block} write failed: ${response}`);
        }

        await this.#sendCommand("#BEPSOND 0");
        await delay(150);
      } catch (error) {
        this.#emit("log", { direction: "ERR", message: error.message });
        failure = error;
      } finally {
        this.#setCommandBusy(false);
      }

      if (resumeAutomaticReads && this.#port) {
        await this.startAutomaticReads({ quiet: true });
      }

      const info = {
        automaticReadsResumed: this.#automaticReadEnabled,
        resumeAttempted: resumeAutomaticReads,
      };
      if (failure) {
        onFailure?.(failure, info);
        return false;
      }

      onSuccess?.(request.decimal, info);
      return true;
    }

    /** Close the port and stop reconnecting until the next authorize()/connect(). */
    async disconnect() {
      this.#allowAutoConnect = false;
      this.#keepReading = false;
      this.#rejectLineWaiters("Reader disconnected.");

      if (this.#reader) {
        try {
          await this.#reader.cancel();
        } catch {
          // A physical USB disconnect may already have cancelled the stream.
        }
      }

      if (this.#readLoopPromise) {
        await this.#readLoopPromise;
        this.#readLoopPromise = undefined;
      }

      if (this.#port) {
        try {
          await this.#port.close();
        } catch {
          // The OS may have already closed a physically disconnected port.
        }
      }

      this.#resetConnection("Not connected", "Disconnected");
    }

    /** Put the reader in continuous block-read mode. */
    async startAutomaticReads({ quiet = false } = {}) {
      if (!this.#port || this.#automaticReadEnabled) {
        return this.#automaticReadEnabled;
      }

      this.#setCommandBusy(true);
      if (!quiet) {
        this.#emit("prompt", `Starting automatic block ${this.#block} detection...`);
      }

      try {
        for (const command of this.#automaticReadCommands()) {
          await this.#sendSetting(command);
        }
        this.#automaticReadEnabled = true;
        if (!quiet) {
          this.#emit("prompt", this.waitingMessage);
        }
      } catch (error) {
        this.#emit("log", { direction: "ERR", message: error.message });
        if (!quiet) {
          this.#emit("prompt", error.message);
        }
        this.#automaticReadEnabled = false;
      } finally {
        this.#setCommandBusy(false);
      }

      return this.#automaticReadEnabled;
    }

    get waitingMessage() {
      return `Waiting for a tag. The reader will capture block ${this.#block} before beeping.`;
    }

    /** Subscribe to any event. Returns an unsubscribe function. */
    on(eventName, handler) {
      const handlers = this.#listeners.get(eventName);
      if (!handlers) {
        throw new Error(`Unknown event: ${eventName}`);
      }
      handlers.add(handler);
      return () => handlers.delete(handler);
    }

    off(eventName, handler) {
      this.#listeners.get(eventName)?.delete(handler);
    }

    /* ------------------------------------------------------------------ *
     * Internals
     * ------------------------------------------------------------------ */

    #emit(eventName, ...args) {
      for (const handler of this.#listeners.get(eventName) ?? []) {
        handler(...args);
      }
    }

    #automaticReadCommands() {
      return [
        "#RFIDMOD 1!",
        "#RFIDUID 0!",
        "#RFIDTXT 0!",
        "#RFIDDLY 1000!",
        `#RFIDMIN ${this.#block}!`,
        `#RFIDMAX ${this.#block}!`,
        "#UIDONLY 0!",
      ];
    }

    #setStatus(message, state = "offline") {
      this.#emit("status", { message, state });
    }

    #setCommandBusy(isBusy) {
      this.#commandBusy = isBusy;
      this.#emitBusy();
    }

    #setConnectionBusy(isBusy) {
      this.#connectionBusy = isBusy;
      this.#emitBusy();
    }

    #emitBusy() {
      this.#emit("busy", {
        commandBusy: this.#commandBusy,
        connectionBusy: this.#connectionBusy,
        connected: this.connected,
      });
    }

    #buildWriteCommand(value, key) {
      const decimal = String(value).trim();
      const keyA = String(key).trim().toUpperCase();

      if (!/^[0-9]+$/.test(decimal)) {
        throw new Error(`Block ${this.#block} data must be a non-negative decimal number.`);
      }
      if (!/^[0-9A-F]{12}$/.test(keyA)) {
        throw new Error("Key A must contain exactly 12 hexadecimal characters.");
      }

      const number = BigInt(decimal);
      if (number > MAX_BLOCK_VALUE) {
        throw new Error(`Block ${this.#block} data cannot exceed ${MAX_BLOCK_VALUE}.`);
      }

      const data = number.toString(16).padStart(32, "0").toUpperCase();

      return {
        command: `#RFIDWBK 3 ${this.#block} ${data} ${keyA} 0`,
        decimal: number.toString(10),
      };
    }

    #removeWaiter(waiter) {
      this.#lineWaiters.delete(waiter);
      clearTimeout(waiter.timeoutId);
    }

    #rejectLineWaiters(message) {
      for (const waiter of this.#lineWaiters) {
        this.#removeWaiter(waiter);
        waiter.reject(new Error(message));
      }
    }

    #processResponse(response) {
      if (!response) {
        return;
      }

      this.#emit("log", { direction: "RX", message: response });
      if (!response.startsWith("#")) {
        const blockRead = response.match(BLOCK_READ_PATTERN);
        if (blockRead) {
          this.#emit("integer", BigInt(`0x${blockRead[1]}`).toString(10), { hex: blockRead[1] });
        } else {
          this.#emit("text", response);
        }
      }

      for (const waiter of this.#lineWaiters) {
        if (waiter.matches(response)) {
          this.#removeWaiter(waiter);
          waiter.resolve(response);
          break;
        }
      }
    }

    #flushReceiveBuffer() {
      const response = this.#receiveBuffer.trim();
      this.#receiveBuffer = "";
      this.#processResponse(response);
    }

    #handleIncomingText(text) {
      clearTimeout(this.#receiveFlushTimer);
      this.#receiveBuffer += text;
      const lines = this.#receiveBuffer.split(/[\r\n]+/);
      this.#receiveBuffer = lines.pop() ?? "";

      for (const line of lines) {
        this.#processResponse(line.trim());
      }

      if (this.#receiveBuffer) {
        // This firmware has RFID suffixes disabled, so tag packets have no CR/LF.
        this.#receiveFlushTimer = setTimeout(() => this.#flushReceiveBuffer(), 120);
      }
    }

    async #readLoop() {
      const decoder = new TextDecoder();

      while (this.#port?.readable && this.#keepReading) {
        this.#reader = this.#port.readable.getReader();

        try {
          while (this.#keepReading) {
            const { value, done } = await this.#reader.read();
            if (done) {
              break;
            }
            if (value) {
              this.#handleIncomingText(decoder.decode(value, { stream: true }));
            }
          }
        } catch (error) {
          if (this.#keepReading) {
            this.#emit("log", { direction: "ERR", message: error.message });
            this.#setStatus("Connection error");
          }
        } finally {
          this.#reader.releaseLock();
          this.#reader = undefined;
        }
      }
    }

    async #sendCommand(command) {
      if (!this.#port?.writable) {
        throw new Error("Connect the reader first.");
      }

      const writer = this.#port.writable.getWriter();
      try {
        await writer.write(new TextEncoder().encode(`${command}\r`));
        this.#emit("log", { direction: "TX", message: command });
      } finally {
        writer.releaseLock();
      }
    }

    #sendCommandAndWait(command, matches, timeoutMilliseconds) {
      return new Promise((resolve, reject) => {
        const waiter = { matches, resolve, reject };
        waiter.timeoutId = setTimeout(() => {
          this.#lineWaiters.delete(waiter);
          reject(new Error("Reader did not acknowledge the command."));
        }, timeoutMilliseconds);
        this.#lineWaiters.add(waiter);

        this.#sendCommand(command).catch((error) => {
          this.#removeWaiter(waiter);
          reject(error);
        });
      });
    }

    async #sendSetting(command) {
      const response = await this.#sendCommandAndWait(
        command,
        (line) => line === "#+" || line === "#-",
        1200,
      );
      if (response === "#-") {
        throw new Error(`Reader rejected ${command}.`);
      }

      await delay(100);
    }

    async #openSelectedPort({ prompt }) {
      if (!RfidReader.isSupported() || this.#port || this.#connectionBusy) {
        return this.connected;
      }
      if (!prompt && !this.#allowAutoConnect) {
        return false;
      }

      this.#setConnectionBusy(true);

      try {
        let selectedPort;

        if (prompt) {
          this.#setStatus("Choose the JADAK reader");
          selectedPort = await navigator.serial.requestPort({
            filters: [JADAK_FILTER],
          });
        } else {
          selectedPort = (await navigator.serial.getPorts()).find(isJadakPort);
          if (!selectedPort) {
            this.#setStatus("Reader authorization required");
            return false;
          }
        }

        this.#setStatus("Connecting to reader...");
        await this.#openPort(selectedPort);
        return true;
      } catch (error) {
        if (error.name !== "NotFoundError") {
          // NotFoundError means the user dismissed Chrome's device picker.
          this.#emit("log", { direction: "ERR", message: error.message });
          this.#setStatus(prompt ? "Could not connect" : "Reader unavailable");
        }
        return false;
      } finally {
        this.#setConnectionBusy(false);
      }
    }

    async #openPort(selectedPort) {
      await selectedPort.open(SERIAL_OPTIONS);

      this.#port = selectedPort;
      this.#keepReading = true;
      this.#emitBusy();
      this.#setStatus("Reader connected", "online");
      this.#emit("log", { direction: "SYS", message: "Connected to JADAK HS-1R at 9600 baud" });
      this.#readLoopPromise = this.#readLoop();
      this.startAutomaticReads();
    }

    #resetConnection(statusMessage, logMessage) {
      this.#port = undefined;
      clearTimeout(this.#receiveFlushTimer);
      this.#receiveBuffer = "";
      this.#automaticReadEnabled = false;
      this.#emitBusy();
      this.#setStatus(statusMessage);
      this.#emit("log", { direction: "SYS", message: logMessage });
    }
  }

  global.RfidReader = RfidReader;

  if (typeof module === "object" && module.exports) {
    module.exports = RfidReader;
  }
})(typeof globalThis === "undefined" ? self : globalThis);
