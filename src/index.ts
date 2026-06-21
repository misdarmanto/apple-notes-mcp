#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "./config.js";
import { listNotes, getNote, searchNotes, listFolders } from "./notes-service.js";

const server = new Server(
  {
    name: "notes-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_folders",
        description:
          "List all folder names available in the Notes app, filtered by the access rules defined in config.json. Use this first if you don't know which folders exist.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_notes",
        description:
          "List notes from the Notes app (title, folder, and last modified date). Does not return full note content, useful for browsing before fetching a specific note. Results are filtered according to the access rules in config.json.",
        inputSchema: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description:
                "Optional. Exact folder name to list notes from. If omitted, lists notes from all accessible folders.",
            },
            limit: {
              type: "number",
              description:
                "Optional. Maximum number of notes to return. Capped by maxNotesPerListing in config.json.",
            },
          },
        },
      },
      {
        name: "get_note",
        description:
          "Retrieve the full content of a single note by its title. Supports partial, case-insensitive title matching (the first matching note is returned). Returns an error if the note does not exist or is blocked by config.json access rules.",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "The title of the note, or a substring of it, to search for.",
            },
          },
          required: ["title"],
        },
      },
      {
        name: "search_notes",
        description:
          "Search the body text of all accessible notes for a keyword or phrase. Returns matching note titles, their folder, and an optional text snippet showing the context around the match. Useful for finding notes related to a topic without knowing the exact title.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Keyword or phrase to search for inside note bodies.",
            },
          },
          required: ["query"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const config = loadConfig();

    switch (name) {
      case "list_folders": {
        const folders = await listFolders(config);
        const text =
          folders.length > 0
            ? folders.map((f) => `- ${f}`).join("\n")
            : "No accessible folders found (check config.json access rules).";
        return { content: [{ type: "text", text }] };
      }

      case "list_notes": {
        const folder = args?.folder as string | undefined;
        const limit = args?.limit as number | undefined;

        const notes = await listNotes(config, { folder, limit });

        if (notes.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No notes found matching the given criteria, or access is restricted by config.json.",
              },
            ],
          };
        }

        const text = notes
          .map((n) => `- "${n.title}" | Folder: ${n.folder} | Modified: ${n.modifiedDate}`)
          .join("\n");

        return { content: [{ type: "text", text }] };
      }

      case "get_note": {
        const title = args?.title as string;
        if (!title) {
          return {
            content: [{ type: "text", text: "Error: 'title' argument is required." }],
            isError: true,
          };
        }

        const note = await getNote(config, title);

        if (!note) {
          return {
            content: [
              {
                type: "text",
                text: `No accessible note found matching title "${title}". It may not exist, or it may be blocked by config.json access rules.`,
              },
            ],
          };
        }

        const text = `Title: ${note.title}\nFolder: ${note.folder}\nLast Modified: ${note.modifiedDate}\n\n---\n\n${note.body}`;
        return { content: [{ type: "text", text }] };
      }

      case "search_notes": {
        const query = args?.query as string;
        if (!query) {
          return {
            content: [{ type: "text", text: "Error: 'query' argument is required." }],
            isError: true,
          };
        }

        const results = await searchNotes(config, query);

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No accessible notes found containing "${query}".`,
              },
            ],
          };
        }

        const text = results
          .map((r) => {
            const base = `- "${r.title}" | Folder: ${r.folder}`;
            return r.snippet ? `${base}\n  Snippet: ${r.snippet}` : base;
          })
          .join("\n");

        return { content: [{ type: "text", text }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Error: Unknown tool "${name}".` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Notes MCP server running on stdio.");
}

main().catch((err) => {
  console.error("Fatal error starting Notes MCP server:", err);
  process.exit(1);
});
