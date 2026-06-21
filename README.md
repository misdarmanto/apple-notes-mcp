# Notes MCP Server

An MCP (Model Context Protocol) server that lets Claude read and analyze notes
from the macOS Notes app, with fully configurable access control.

## Features

- `list_folders` — list all accessible folder names
- `list_notes` — list notes (title, folder, modified date) with optional folder filter
- `get_note` — fetch the full content of a specific note by title (partial match)
- `search_notes` — search note bodies for a keyword and get matching titles + snippets

All access is controlled from a single file: **`config.json`**. No code changes
are needed to change which folders or notes Claude can see.

## Requirements

- macOS (this server relies on AppleScript, which only works on macOS)
- Node.js 18 or later
- The Notes app, with at least one note in it

## Setup

1. **Install dependencies and build:**

   ```bash
   cd notes-mcp-server
   npm install
   npm run build
   ```

2. **Configure access** by editing `config.json` (see "Configuration" below).
   You do not need to rebuild after editing `config.json` — it is read at runtime.

3. **Find the absolute path to the built server.** From inside the project folder, run:

   ```bash
   pwd
   ```

   You'll use `<that path>/build/index.js` in the next step.

4. **Register the server with Claude Desktop.** Open (or create) this file:

   ```
   ~/Library/Application Support/Claude/claude_desktop_config.json
   ```

   Add an entry like this (replace the path with your actual path from step 3):

   ```json
   {
     "mcpServers": {
       "notes": {
         "command": "node",
         "args": ["/Users/yourname/notes-mcp-server/build/index.js"]
       }
     }
   }
   ```

5. **Restart Claude Desktop completely** (Cmd+Q, then reopen). You should see a
   tools icon in the chat input indicating the server connected successfully.

6. **Grant automation permission.** The first time a tool runs, macOS will ask
   for permission to let the server control the Notes app. Approve it. If the
   prompt doesn't appear, go to **System Settings → Privacy & Security → Automation**
   and enable access manually.

## Configuration (`config.json`)

### Access modes

The `access.mode` field controls how restrictions are applied:

| Mode        | Behavior                                                                 |
|-------------|---------------------------------------------------------------------------|
| `all`       | No restrictions — every folder and note is accessible.                   |
| `allowlist` | ONLY folders/notes listed in `allowedFolders` / `allowedNotes` are visible. |
| `denylist`  | Everything is visible EXCEPT folders/notes listed in `blockedFolders` / `blockedNotes`. |

### Example: only allow two folders

```json
"access": {
  "mode": "allowlist",
  "allowedFolders": ["Work", "Journal"],
  "allowedNotes": [],
  "blockedFolders": [],
  "blockedNotes": []
}
```

### Example: allow everything except sensitive folders

```json
"access": {
  "mode": "denylist",
  "allowedFolders": [],
  "allowedNotes": [],
  "blockedFolders": ["Private", "Passwords"],
  "blockedNotes": ["Bank Details", "Secret"]
}
```

Note title matching for `allowedNotes` / `blockedNotes` is **partial and
case-insensitive by default** (controlled by `behavior.caseSensitiveSearch`).
For example, `"Secret"` in `blockedNotes` will block any note whose title
contains the word "Secret".

### Other settings

- `limits.maxNotesPerListing` — safety cap for `list_notes` results
- `limits.maxSearchResults` — safety cap for `search_notes` results
- `limits.maxNoteBodyLength` — truncates very long notes (0 = no limit)
- `behavior.includeSnippetsInSearch` — show text previews in search results
- `behavior.snippetLength` — how many characters of context to show per snippet
- `behavior.caseSensitiveSearch` — whether keyword/title matching is case-sensitive

After editing `config.json`, just restart Claude Desktop (or reconnect the
server) for changes to take effect — no rebuild required.

## Troubleshooting

- **"AppleScript execution failed" / "Not authorized"** — grant Automation
  permission in System Settings as described in step 6 above.
- **Notes app must be running** (or macOS will launch it automatically the
  first time a tool is called — this is normal and may cause a short delay).
- **Tool returns "No accessible note found"** — check that the note isn't
  blocked by your `config.json` rules, and that the title spelling is close enough
  for a partial match.

## Project Structure

```
notes-mcp-server/
├── config.json          ← Edit this to control access (folders/notes)
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts          ← MCP server entry point, tool definitions
    ├── config.ts         ← Loads & validates config.json, access-control logic
    ├── applescript.ts    ← Safe AppleScript execution helper
    └── notes-service.ts  ← Builds AppleScript queries, parses Notes data
```
