import { exec } from "child_process";
import { randomBytes } from "crypto";
import { unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

// 10MB buffer to comfortably handle large note bodies or long listings
const MAX_BUFFER = 1024 * 1024 * 10;

/**
 * Escapes a string so it can be safely embedded inside an AppleScript
 * string literal (handles double quotes and backslashes).
 */
export function escapeForAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Runs an AppleScript snippet via osascript and returns its stdout, trimmed.
 * Throws an Error with a clear message if execution fails (e.g. Notes app
 * not running, automation permission not granted, syntax error, etc).
 */
function handleAppleScriptError(err: unknown): never {
  const anyErr = err as { stderr?: string; message?: string };
  const stderr = anyErr?.stderr ? String(anyErr.stderr).trim() : "";
  const message = stderr || (err instanceof Error ? err.message : String(err));

  if (message.includes("Not authorized") || message.includes("-1743")) {
    throw new Error(
      "macOS denied automation access to Notes. Grant permission in " +
        "System Settings > Privacy & Security > Automation, then try again.",
    );
  }

  throw new Error(`AppleScript execution failed: ${message}`);
}

export async function runAppleScript(script: string): Promise<string> {
  const scriptPath = join(
    tmpdir(),
    `notes-mcp-${randomBytes(8).toString("hex")}.applescript`,
  );

  writeFileSync(scriptPath, script, "utf-8");

  try {
    const { stdout } = await execAsync(
      `osascript ${JSON.stringify(scriptPath)}`,
      {
        maxBuffer: MAX_BUFFER,
      },
    );
    return stdout.trim();
  } catch (err) {
    return handleAppleScriptError(err);
  } finally {
    try {
      unlinkSync(scriptPath);
    } catch {
      // temp file may already be gone
    }
  }
}

/**
 * Writes arbitrary note body text to a temp file and returns AppleScript lines
 * that read it into `noteBody`. Avoids escaping issues with long or multiline content.
 */
export function appleScriptReadBodyFromTempFile(body: string): {
  setupLines: string;
  bodyVar: string;
  cleanupPaths: string[];
} {
  const bodyPath = join(
    tmpdir(),
    `notes-mcp-body-${randomBytes(8).toString("hex")}.txt`,
  );
  writeFileSync(bodyPath, body, "utf-8");

  const setupLines = [
    `set bodyFile to POSIX file ${JSON.stringify(bodyPath)}`,
    "set noteBody to read bodyFile as «class utf8»",
  ].join("\n");

  return { setupLines, bodyVar: "noteBody", cleanupPaths: [bodyPath] };
}

export async function runAppleScriptWithCleanup(
  script: string,
  cleanupPaths: string[] = [],
): Promise<string> {
  try {
    return await runAppleScript(script);
  } finally {
    for (const path of cleanupPaths) {
      try {
        unlinkSync(path);
      } catch {
        // ignore cleanup failures
      }
    }
  }
}
