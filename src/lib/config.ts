import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".config", "caliber");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

interface Config {
  libraryPath: string;
  dbName: string;
}

const DEFAULTS: Config = {
  libraryPath: join(homedir(), "Calibre Library"),
  dbName: "metadata.db",
};

function loadConfig(): Config {
  mkdirSync(CONFIG_DIR, { recursive: true });

  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + "\n");
    return { ...DEFAULTS };
  }

  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return {
      libraryPath: raw.libraryPath || DEFAULTS.libraryPath,
      dbName: raw.dbName || DEFAULTS.dbName,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// Env vars override config file
const config = loadConfig();

export const LIBRARY_PATH = process.env.CALIBRE_LIBRARY_PATH || config.libraryPath;
export const DB_NAME = process.env.CALIBRE_DB_NAME || config.dbName;
export const CONFIG_DIR_PATH = CONFIG_DIR;
export const CONFIG_FILE_PATH = CONFIG_PATH;
