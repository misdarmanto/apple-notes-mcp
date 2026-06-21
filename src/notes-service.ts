import { runAppleScript, escapeForAppleScript } from "./applescript.js";
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
  options: { folder?: string; limit?: number }
): Promise<NoteSummary[]> {
  const limit = Math.min(
    options.limit ?? config.limits.maxNotesPerListing,
    config.limits.maxNotesPerListing
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
          set theFolder to name of container of theNote
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
    results.push({ title, folder: folder ?? "Unknown", modifiedDate: modifiedDate ?? "" });
  }

  return results;
}

/**
 * Fetches the full content of a single note by title (partial match allowed).
 * Returns null if no matching note is found, or if access is denied by config.
 */
export async function getNote(
  config: AppConfig,
  titleQuery: string
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
      set theFolder to name of container of theNote
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
      ? body.slice(0, maxLen) + `\n\n[... truncated, note body exceeds ${maxLen} characters ...]`
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
  query: string
): Promise<SearchResult[]> {
  const escapedQuery = escapeForAppleScript(query);

  const script = `
    tell application "Notes"
      set output to ""
      set matchingNotes to (every note whose body contains "${escapedQuery}")
      repeat with theNote in matchingNotes
        set theTitle to name of theNote
        set theFolder to name of container of theNote
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
      snippet = buildSnippet(body, query, config.behavior.snippetLength, config.behavior.caseSensitiveSearch);
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
  caseSensitive: boolean
): string {
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();

  const matchIndex = haystack.indexOf(needle);
  if (matchIndex === -1) {
    // Fallback: just return the start of the note
    return text.slice(0, snippetLength).trim() + (text.length > snippetLength ? "..." : "");
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
