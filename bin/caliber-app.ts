#!/usr/bin/env bun

import "../src/index.ts";

const DEFAULT_PORT = "3003";
const NO_OPEN_FLAGS = new Set(["--no-open"]);

function getBrowserHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  if (host === "::1") return "[::1]";
  return host;
}

function getAppUrl(): string {
  const host = getBrowserHost(process.env.CALIBER_HOST || "127.0.0.1");
  const port = process.env.PORT || process.env.CALIBER_PORT || DEFAULT_PORT;
  return `http://${host}:${port}/`;
}

async function waitForHealth(url: string): Promise<void> {
  const healthUrl = new URL("api/health", url);
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // The server may still be binding its port.
    }
    await Bun.sleep(100);
  }

  throw new Error(`Caliber did not become ready at ${url}`);
}

async function hasReadyLibrary(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("api/config/library", url));
    if (!response.ok) return false;
    const status = (await response.json()) as { ready?: boolean };
    return status.ready === true;
  } catch {
    return false;
  }
}

function openDefaultBrowser(url: string): void {
  const command = (() => {
    switch (process.platform) {
      case "darwin":
        return ["open", url];
      case "win32":
        return ["cmd.exe", "/c", "start", "", url];
      case "linux":
        return ["xdg-open", url];
      default:
        return null;
    }
  })();

  if (!command) {
    console.log(`🌐 Open Caliber in your browser: ${url}`);
    return;
  }

  try {
    Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    console.log(`🌐 Opened Caliber in your default browser: ${url}`);
  } catch {
    console.log(`🌐 Open Caliber in your browser: ${url}`);
  }
}

const url = getAppUrl();
await waitForHealth(url);
const libraryReady = await hasReadyLibrary(url);

const openDisabled =
  process.env.CALIBER_OPEN_BROWSER?.toLowerCase() === "false" ||
  process.argv.slice(2).some((arg) => NO_OPEN_FLAGS.has(arg));

if (openDisabled || !libraryReady) {
  console.log(`🌐 Caliber is ready at ${url}`);
  if (!libraryReady && !openDisabled) {
    console.log("📚 No usable Calibre library found; configure one in the app or set CALIBRE_LIBRARY_PATH.");
  }
} else {
  openDefaultBrowser(url);
}
