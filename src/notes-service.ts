import {
  runAppleScript,
  escapeForAppleScript,
  appleScriptReadBodyFromTempFile,
  runAppleScriptWithCleanup,
} from "./applescript.js";
import { AppConfig, isFolderAllowed, isNoteAllowed } from "./config.js";

// A delimiter unlikely to appear naturally in note titles/folder names,
// used to safely split AppleScript output back into structured fields.
const FIELD_SEP = "<<<FIELD>>>";
const RECORD_SEP = "<<<RECORD>>>";

export interface NoteSummary {
  title: string;
  folder: string;
  modifiedDate: string;
}

export interface NoteDetail {
  title: string;
  folder: string;
  modifiedDate: string;
  body: string;
}

export interface SearchResult {
  title: string;
  folder: string;
  snippet: string | null;
}

/**
 * Lists notes, optionally restricted to a single folder name.
 * Always applies config-based access control before returning results.
 */
export async function listNotes(
  config: AppConfig,
  options: { folder?: string; limit?: number },
): Promise<NoteSummary[]> {
  const limit = Math.min(
    options.limit ?? config.limits.maxNotesPerListing,
    config.limits.maxNotesPerListing,
  );

  const folderFilter = options.folder
    ? `folder "${escapeForAppleScript(options.folder)}"`
    : null;

  const script = folderFilter
    ? `
      tell application "Notes"
        set output to ""
        set targetFolder to ${folderFilter}
        set noteList to notes of targetFolder
        set noteCount to count of noteList
        set upperBound to noteCount
        if upperBound > ${limit} then set upperBound to ${limit}
        repeat with i from 1 to upperBound
          set theNote to item i of noteList
          set theTitle to name of theNote
          set theFolder to name of targetFolder
          set theDate to (modification date of theNote) as string
          set output to output & theTitle & "${FIELD_SEP}" & theFolder & "${FIELD_SEP}" & theDate & "${RECORD_SEP}"
        end repeat
        return output
      end tell`
    : `
      tell application "Notes"
        set output to ""
        set noteList to notes
        set noteCount to count of noteList
        set upperBound to noteCount
        if upperBound > ${limit} then set upperBound to ${limit}
        repeat with i from 1 to upperBound
          set theNote to item i of noteList
          set theTitle to name of theNote
          try
            set theFolder to name of container of theNote
          on error
            set theFolder to "Unknown"
          end try
          set theDate to (modification date of theNote) as string
          set output to output & theTitle & "${FIELD_SEP}" & theFolder & "${FIELD_SEP}" & theDate & "${RECORD_SEP}"
        end repeat
        return output
      end tell`;

  const raw = await runAppleScript(script);
  if (!raw) return [];

  const records = raw
    .split(RECORD_SEP)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  const results: NoteSummary[] = [];
  for (const record of records) {
    const [title, folder, modifiedDate] = record.split(FIELD_SEP);
    if (!title) continue;
    if (!isNoteAllowed(title, folder ?? null, config)) continue;
    results.push({
      title,
      folder: folder ?? "Unknown",
      modifiedDate: modifiedDate ?? "",
    });
  }

  return results;
}

/**
 * Fetches the full content of a single note by title (partial match allowed).
 * Returns null if no matching note is found, or if access is denied by config.
 */
export async function getNote(
  config: AppConfig,
  titleQuery: string,
): Promise<NoteDetail | null> {
  const escapedQuery = escapeForAppleScript(titleQuery);

  const script = `
    tell application "Notes"
      set matchingNotes to (every note whose name contains "${escapedQuery}")
      if (count of matchingNotes) = 0 then
        return ""
      end if
      set theNote to item 1 of matchingNotes
      set theTitle to name of theNote
      try
        set theFolder to name of container of theNote
      on error
        set theFolder to "Unknown"
      end try
      set theDate to (modification date of theNote) as string
      set theBody to body of theNote
      return theTitle & "${FIELD_SEP}" & theFolder & "${FIELD_SEP}" & theDate & "${FIELD_SEP}" & theBody
    end tell`;

  const raw = await runAppleScript(script);
  if (!raw) return null;

  const [title, folder, modifiedDate, ...bodyParts] = raw.split(FIELD_SEP);
  const body = bodyParts.join(FIELD_SEP); // body might theoretically contain the separator text

  if (!title) return null;
  if (!isNoteAllowed(title, folder ?? null, config)) return null;

  const maxLen = config.limits.maxNoteBodyLength;
  const truncated =
    maxLen > 0 && body.length > maxLen
      ? body.slice(0, maxLen) +
        `\n\n[... truncated, note body exceeds ${maxLen} characters ...]`
      : body;

  return {
    title,
    folder: folder ?? "Unknown",
    modifiedDate: modifiedDate ?? "",
    body: truncated,
  };
}

/**
 * Searches all accessible notes for a keyword in their body text.
 * Optionally includes a short snippet of surrounding context per match.
 */
export async function searchNotes(
  config: AppConfig,
  query: string,
): Promise<SearchResult[]> {
  const escapedQuery = escapeForAppleScript(query);

  const script = `
    tell application "Notes"
      set output to ""
      set matchingNotes to (every note whose body contains "${escapedQuery}")
      repeat with theNote in matchingNotes
        set theTitle to name of theNote
        try
          set theFolder to name of container of theNote
        on error
          set theFolder to "Unknown"
        end try
        set theBody to body of theNote
        set output to output & theTitle & "${FIELD_SEP}" & theFolder & "${FIELD_SEP}" & theBody & "${RECORD_SEP}"
      end repeat
      return output
    end tell`;

  const raw = await runAppleScript(script);
  if (!raw) return [];

  const records = raw
    .split(RECORD_SEP)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  const results: SearchResult[] = [];
  const maxResults = config.limits.maxSearchResults;

  for (const record of records) {
    if (results.length >= maxResults) break;

    const [title, folder, ...bodyParts] = record.split(FIELD_SEP);
    const body = bodyParts.join(FIELD_SEP);
    if (!title) continue;
    if (!isNoteAllowed(title, folder ?? null, config)) continue;

    let snippet: string | null = null;
    if (config.behavior.includeSnippetsInSearch) {
      snippet = buildSnippet(
        body,
        query,
        config.behavior.snippetLength,
        config.behavior.caseSensitiveSearch,
      );
    }

    results.push({ title, folder: folder ?? "Unknown", snippet });
  }

  return results;
}

/**
 * Extracts a short text snippet centered around the first occurrence of
 * `query` inside `text`, for use as a search-result preview.
 */
function buildSnippet(
  text: string,
  query: string,
  snippetLength: number,
  caseSensitive: boolean,
): string {
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();

  const matchIndex = haystack.indexOf(needle);
  if (matchIndex === -1) {
    // Fallback: just return the start of the note
    return (
      text.slice(0, snippetLength).trim() +
      (text.length > snippetLength ? "..." : "")
    );
  }

  const halfWindow = Math.floor(snippetLength / 2);
  const start = Math.max(0, matchIndex - halfWindow);
  const end = Math.min(text.length, matchIndex + needle.length + halfWindow);

  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";

  return prefix + text.slice(start, end).trim() + suffix;
}

/**
 * Lists all folder names available in Notes, filtered by access control.
 */
export async function listFolders(config: AppConfig): Promise<string[]> {
  const script = `
    tell application "Notes"
      set output to ""
      repeat with theFolder in folders
        set output to output & (name of theFolder) & "${RECORD_SEP}"
      end repeat
      return output
    end tell`;

  const raw = await runAppleScript(script);
  if (!raw) return [];

  const folderNames = raw
    .split(RECORD_SEP)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  return folderNames.filter((f) => isFolderAllowed(f, config));
}

/**
 * Finds all notes whose title contains `titleQuery` (partial match).
 * Used before destructive operations to detect ambiguous matches.
 */
export async function findNotesByTitle(
  config: AppConfig,
  titleQuery: string,
): Promise<NoteDetail[]> {
  const escapedQuery = escapeForAppleScript(titleQuery);

  const script = `
    tell application "Notes"
      set output to ""
      set matchingNotes to (every note whose name contains "${escapedQuery}")
      repeat with theNote in matchingNotes
        set theTitle to name of theNote
        try
          set theFolder to name of container of theNote
        on error
          set theFolder to "Unknown"
        end try
        set theDate to (modification date of theNote) as string
        set theBody to body of theNote
        set output to output & theTitle & "${FIELD_SEP}" & theFolder & "${FIELD_SEP}" & theDate & "${FIELD_SEP}" & theBody & "${RECORD_SEP}"
      end repeat
      return output
    end tell`;

  const raw = await runAppleScript(script);
  if (!raw) return [];

  const records = raw
    .split(RECORD_SEP)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  const results: NoteDetail[] = [];
  for (const record of records) {
    const [title, folder, modifiedDate, ...bodyParts] = record.split(FIELD_SEP);
    const body = bodyParts.join(FIELD_SEP);
    if (!title) continue;
    if (!isNoteAllowed(title, folder ?? null, config)) continue;

    const maxLen = config.limits.maxNoteBodyLength;
    const truncated =
      maxLen > 0 && body.length > maxLen
        ? body.slice(0, maxLen) +
          `\n\n[... truncated, note body exceeds ${maxLen} characters ...]`
        : body;

    results.push({
      title,
      folder: folder ?? "Unknown",
      modifiedDate: modifiedDate ?? "",
      body: truncated,
    });
  }

  return results;
}

export interface CreateNoteResult {
  title: string;
  folder: string;
}

/**
 * Creates a new note in the specified folder (or the default Notes folder).
 */
export async function createNote(
  config: AppConfig,
  options: { title: string; body: string; folder?: string },
): Promise<CreateNoteResult> {
  const { title, body, folder } = options;

  if (!title.trim()) {
    throw new Error("Note title cannot be empty.");
  }

  if (folder && !isFolderAllowed(folder, config)) {
    throw new Error(
      `Folder "${folder}" is not accessible according to config.json access rules.`,
    );
  }

  if (!isNoteAllowed(title, folder ?? null, config)) {
    throw new Error(
      `Creating a note titled "${title}" is not allowed by config.json access rules.`,
    );
  }

  const escapedTitle = escapeForAppleScript(title);
  const { setupLines, bodyVar, cleanupPaths } =
    appleScriptReadBodyFromTempFile(body);

  const script = folder
    ? `
      ${setupLines}
      tell application "Notes"
        tell folder "${escapeForAppleScript(folder)}"
          make new note with properties {name:"${escapedTitle}", body:${bodyVar}}
        end tell
        return "${escapedTitle}${FIELD_SEP}${escapeForAppleScript(folder)}"
      end tell`
    : `
      ${setupLines}
      tell application "Notes"
        set newNote to make new note with properties {name:"${escapedTitle}", body:${bodyVar}}
        try
          set noteFolder to name of container of newNote
        on error
          set noteFolder to "Notes"
        end try
        return "${escapedTitle}${FIELD_SEP}" & noteFolder
      end tell`;

  const raw = await runAppleScriptWithCleanup(script, cleanupPaths);
  const [createdTitle, createdFolder] = raw.split(FIELD_SEP);

  return {
    title: createdTitle || title,
    folder: createdFolder || folder || "Notes",
  };
}

/**
 * Updates an existing note identified by exact title.
 */
export async function updateNote(
  config: AppConfig,
  options: { exactTitle: string; newTitle?: string; newBody?: string },
): Promise<NoteDetail> {
  const { exactTitle, newTitle, newBody } = options;

  if (!newTitle && newBody === undefined) {
    throw new Error("At least one of newTitle or newBody must be provided.");
  }

  const existing = await findNotesByTitle(config, exactTitle);
  const match = existing.find((n) => n.title === exactTitle);

  if (!match) {
    throw new Error(
      `No accessible note found with exact title "${exactTitle}".`,
    );
  }

  if (newTitle && !isNoteAllowed(newTitle, match.folder, config)) {
    throw new Error(
      `Renaming to "${newTitle}" is not allowed by config.json access rules.`,
    );
  }

  const escapedExactTitle = escapeForAppleScript(exactTitle);
  const cleanupPaths: string[] = [];
  let bodySetup = "";
  let titleAssignment = "";
  let bodyAssignment = "";

  if (newTitle) {
    titleAssignment = `set name of theNote to "${escapeForAppleScript(newTitle)}"`;
  }

  if (newBody !== undefined) {
    const {
      setupLines,
      bodyVar,
      cleanupPaths: bodyPaths,
    } = appleScriptReadBodyFromTempFile(newBody);
    bodySetup = setupLines;
    bodyAssignment = `set body of theNote to ${bodyVar}`;
    cleanupPaths.push(...bodyPaths);
  }

  const script = `
    ${bodySetup}
    tell application "Notes"
      set matchingNotes to (every note whose name is "${escapedExactTitle}")
      if (count of matchingNotes) = 0 then
        return ""
      end if
      set theNote to item 1 of matchingNotes
      ${titleAssignment}
      ${bodyAssignment}
      set theTitle to name of theNote
      try
        set theFolder to name of container of theNote
      on error
        set theFolder to "Unknown"
      end try
      set theDate to (modification date of theNote) as string
      set theBody to body of theNote
      return theTitle & "${FIELD_SEP}" & theFolder & "${FIELD_SEP}" & theDate & "${FIELD_SEP}" & theBody
    end tell`;

  const raw = await runAppleScriptWithCleanup(script, cleanupPaths);
  if (!raw) {
    throw new Error(`Failed to update note "${exactTitle}".`);
  }

  const [title, folder, modifiedDate, ...bodyParts] = raw.split(FIELD_SEP);
  const noteBody = bodyParts.join(FIELD_SEP);

  return {
    title,
    folder: folder ?? "Unknown",
    modifiedDate: modifiedDate ?? "",
    body: noteBody,
  };
}

/**
 * Permanently deletes a note identified by exact title.
 */
export async function deleteNote(
  config: AppConfig,
  exactTitle: string,
): Promise<{ title: string; folder: string }> {
  const existing = await findNotesByTitle(config, exactTitle);
  const match = existing.find((n) => n.title === exactTitle);

  if (!match) {
    throw new Error(
      `No accessible note found with exact title "${exactTitle}".`,
    );
  }

  const escapedExactTitle = escapeForAppleScript(exactTitle);

  const script = `
    tell application "Notes"
      set matchingNotes to (every note whose name is "${escapedExactTitle}")
      if (count of matchingNotes) = 0 then
        return ""
      end if
      set theNote to item 1 of matchingNotes
      try
        set theFolder to name of container of theNote
      on error
        set theFolder to "Unknown"
      end try
      set theTitle to name of theNote
      delete theNote
      return theTitle & "${FIELD_SEP}" & theFolder
    end tell`;

  const raw = await runAppleScript(script);
  if (!raw) {
    throw new Error(`Failed to delete note "${exactTitle}".`);
  }

  const [title, folder] = raw.split(FIELD_SEP);
  return { title: title || exactTitle, folder: folder ?? match.folder };
}
