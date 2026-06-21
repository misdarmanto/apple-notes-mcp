import { exec } from "child_process";
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
export async function runAppleScript(script: string): Promise<string> {
  // Write the script to a temp-safe single -e argument by escaping for the shell.
  // We wrap the whole script in double quotes for the shell command itself.
  const shellEscaped = script.replace(/"/g, '\\"');

  try {
    const { stdout } = await execAsync(`osascript -e "${shellEscaped}"`, {
      maxBuffer: MAX_BUFFER,
    });
    return stdout.trim();
  } catch (err: any) {
    const stderr = err?.stderr ? String(err.stderr).trim() : "";
    const message = stderr || (err instanceof Error ? err.message : String(err));

    if (message.includes("Not authorized") || message.includes("-1743")) {
      throw new Error(
        "macOS denied automation access to Notes. Grant permission in " +
          "System Settings > Privacy & Security > Automation, then try again."
      );
    }

    throw new Error(`AppleScript execution failed: ${message}`);
  }
}
