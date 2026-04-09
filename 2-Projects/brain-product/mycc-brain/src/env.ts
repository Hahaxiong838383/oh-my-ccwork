import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

const projectRoot = resolve(import.meta.dirname, "..");

let loaded = false;

export function loadProjectEnv(): void {
  if (loaded) return;
  dotenvConfig({ path: resolve(projectRoot, ".env.local"), override: false });
  dotenvConfig({ path: resolve(projectRoot, ".env"), override: false });
  loaded = true;
}

loadProjectEnv();

export const DEFAULT_BRAIN_MODEL = process.env.BRAIN_DEFAULT_MODEL ?? "cc-gemini-2.5-flash";
export const DEFAULT_RAW_MODEL = DEFAULT_BRAIN_MODEL.replace(/^cc-/, "raw-");
export const DEFAULT_DATA_DIR = process.env.DATA_DIR ?? resolve(projectRoot, "../../../0-System");
