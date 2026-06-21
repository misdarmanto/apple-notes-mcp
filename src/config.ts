import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// config.json lives at the project root, one level above src/build
const CONFIG_PATH = join(__dirname, "..", "config.json");

export type AccessMode = "all" | "allowlist" | "denylist";

export interface AppConfig {
  access: {
    mode: AccessMode;
    allowedFolders: string[];
    allowedNotes: string[];
    blockedFolders: string[];
    blockedNotes: string[];
  };
  limits: {
    maxNotesPerListing: number;
    maxSearchResults: number;
    maxNoteBodyLength: number;
  };
  behavior: {
    includeSnippetsInSearch: boolean;
    snippetLength: number;
    caseSensitiveSearch: boolean;
  };
}

// Strips the documentation-only keys (prefixed with "//") that live in config.json
function stripCommentKeys(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(stripCommentKeys);
  }
  if (obj !== null && typeof obj === "object") {
    const cleaned: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith("//")) continue;
      cleaned[key] = stripCommentKeys(value);
    }
    return cleaned;
  }
  return obj;
}

let cachedConfig: AppConfig | null = null;

export function loadConfig(forceReload = false): AppConfig {
  if (cachedConfig && !forceReload) {
    return cachedConfig;
  }

  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch (err) {
    throw new Error(
      `Could not read config file at ${CONFIG_PATH}. Make sure config.json exists in the project root. Original error: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `config.json contains invalid JSON. Please check for syntax errors (missing commas, brackets, etc). Original error: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const cleaned = stripCommentKeys(parsed);

  // Apply defaults for any missing fields so the server never crashes on a partial config
  const config: AppConfig = {
    access: {
      mode: cleaned?.access?.mode ?? "all",
      allowedFolders: cleaned?.access?.allowedFolders ?? [],
      allowedNotes: cleaned?.access?.allowedNotes ?? [],
      blockedFolders: cleaned?.access?.blockedFolders ?? [],
      blockedNotes: cleaned?.access?.blockedNotes ?? [],
    },
    limits: {
      maxNotesPerListing: cleaned?.limits?.maxNotesPerListing ?? 100,
      maxSearchResults: cleaned?.limits?.maxSearchResults ?? 50,
      maxNoteBodyLength: cleaned?.limits?.maxNoteBodyLength ?? 20000,
    },
    behavior: {
      includeSnippetsInSearch: cleaned?.behavior?.includeSnippetsInSearch ?? true,
      snippetLength: cleaned?.behavior?.snippetLength ?? 200,
      caseSensitiveSearch: cleaned?.behavior?.caseSensitiveSearch ?? false,
    },
  };

  if (!["all", "allowlist", "denylist"].includes(config.access.mode)) {
    throw new Error(
      `Invalid access.mode "${config.access.mode}" in config.json. Must be one of: "all", "allowlist", "denylist".`
    );
  }

  cachedConfig = config;
  return config;
}

// --- Access control helpers -------------------------------------------------

function normalize(text: string, caseSensitive: boolean): string {
  return caseSensitive ? text : text.toLowerCase();
}

export function isFolderAllowed(folderName: string, config: AppConfig): boolean {
  const { mode, allowedFolders, blockedFolders } = config.access;
  const caseSensitive = config.behavior.caseSensitiveSearch;
  const target = normalize(folderName, caseSensitive);

  if (mode === "all") return true;

  if (mode === "allowlist") {
    return allowedFolders.some((f) => normalize(f, caseSensitive) === target);
  }

  // denylist
  return !blockedFolders.some((f) => normalize(f, caseSensitive) === target);
}

export function isNoteAllowed(
  noteTitle: string,
  folderName: string | null,
  config: AppConfig
): boolean {
  const { mode, allowedNotes, blockedNotes } = config.access;
  const caseSensitive = config.behavior.caseSensitiveSearch;
  const title = normalize(noteTitle, caseSensitive);

  // Folder-level restriction always applies first, if a folder is known
  if (folderName !== null && !isFolderAllowed(folderName, config)) {
    return false;
  }

  if (mode === "all") return true;

  if (mode === "allowlist") {
    // If allowedNotes is empty, rely purely on folder allowlist (already checked above)
    if (allowedNotes.length === 0) return true;
    return allowedNotes.some((n) => title.includes(normalize(n, caseSensitive)));
  }

  // denylist
  return !blockedNotes.some((n) => title.includes(normalize(n, caseSensitive)));
}
