#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "./config.js";
import {
  listNotes,
  getNote,
  searchNotes,
  listFolders,
  createNote,
  updateNote,
  deleteNote,
  findNotesByTitle,
} from "./notes-service.js";
import {
  createConfirmation,
  consumeConfirmation,
  type UpdateConfirmationPayload,
} from "./confirmation.js";

const server = new Server(
  {
    name: "notes-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
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
              description:
                "The title of the note, or a substring of it, to search for.",
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
              description:
                "Keyword or phrase to search for inside note bodies.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "create_note",
        description:
          "Create a new note in the macOS Notes app. Requires title and body. Optionally specify a folder name (must be accessible per config.json). This action executes immediately — no confirmation required.",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Title for the new note.",
            },
            body: {
              type: "string",
              description: "Full body content for the new note.",
            },
            folder: {
              type: "string",
              description:
                "Optional. Exact folder name to create the note in. If omitted, Notes uses its default folder.",
            },
          },
          required: ["title", "body"],
        },
      },
      {
        name: "update_note",
        description:
          "Update an existing note's title and/or body. STRICT TWO-STEP FLOW: (1) First call WITHOUT confirmationToken to preview the change and receive a confirmationToken. (2) Ask the user explicitly whether they approve the update. (3) Only if the user clearly confirms, call again WITH confirmationToken AND userConfirmed=true. Never set userConfirmed=true without explicit user approval. Requires exact note title when confirming.",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description:
                "Title of the note to update. Use exact title when confirming. Partial match is only used during the preview step to locate the note.",
            },
            newTitle: {
              type: "string",
              description:
                "Optional new title. Omit to keep the current title.",
            },
            newBody: {
              type: "string",
              description:
                "Optional new body content. Omit to keep the current body.",
            },
            confirmationToken: {
              type: "string",
              description:
                "Token returned from the preview step. Required to execute the update.",
            },
            userConfirmed: {
              type: "boolean",
              description:
                "Must be true to execute. Only set after the user explicitly confirms the update in chat.",
            },
          },
          required: ["title"],
        },
      },
      {
        name: "delete_note",
        description:
          "Permanently delete a note from the macOS Notes app. STRICT TWO-STEP FLOW: (1) First call WITHOUT confirmationToken to preview which note will be deleted and receive a confirmationToken. (2) Ask the user explicitly whether they approve deletion. (3) Only if the user clearly confirms, call again WITH confirmationToken AND userConfirmed=true. Never set userConfirmed=true without explicit user approval. Deletion is irreversible.",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description:
                "Title of the note to delete. Use exact title when confirming. Partial match is only used during the preview step to locate the note.",
            },
            confirmationToken: {
              type: "string",
              description:
                "Token returned from the preview step. Required to execute the deletion.",
            },
            userConfirmed: {
              type: "boolean",
              description:
                "Must be true to execute. Only set after the user explicitly confirms deletion in chat.",
            },
          },
          required: ["title"],
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
          .map(
            (n) =>
              `- "${n.title}" | Folder: ${n.folder} | Modified: ${n.modifiedDate}`,
          )
          .join("\n");

        return { content: [{ type: "text", text }] };
      }

      case "get_note": {
        const title = args?.title as string;
        if (!title) {
          return {
            content: [
              { type: "text", text: "Error: 'title' argument is required." },
            ],
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
            content: [
              { type: "text", text: "Error: 'query' argument is required." },
            ],
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

      case "create_note": {
        const title = args?.title as string;
        const body = args?.body as string;
        const folder = args?.folder as string | undefined;

        if (!title || body === undefined) {
          return {
            content: [
              {
                type: "text",
                text: "Error: 'title' and 'body' arguments are required.",
              },
            ],
            isError: true,
          };
        }

        const created = await createNote(config, { title, body, folder });
        return {
          content: [
            {
              type: "text",
              text: `Note created successfully.\nTitle: ${created.title}\nFolder: ${created.folder}`,
            },
          ],
        };
      }

      case "update_note": {
        const title = args?.title as string;
        const newTitle = args?.newTitle as string | undefined;
        const newBody = args?.newBody as string | undefined;
        const confirmationToken = args?.confirmationToken as string | undefined;
        const userConfirmed = args?.userConfirmed as boolean | undefined;

        if (!title) {
          return {
            content: [
              { type: "text", text: "Error: 'title' argument is required." },
            ],
            isError: true,
          };
        }

        if (!confirmationToken) {
          if (newTitle === undefined && newBody === undefined) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: Provide at least one of 'newTitle' or 'newBody' for the preview step.",
                },
              ],
              isError: true,
            };
          }

          const matches = await findNotesByTitle(config, title);
          if (matches.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No accessible note found matching title "${title}".`,
                },
              ],
            };
          }

          if (matches.length > 1) {
            const list = matches
              .map((n) => `- "${n.title}" | Folder: ${n.folder}`)
              .join("\n");
            return {
              content: [
                {
                  type: "text",
                  text: `Multiple notes match "${title}". Provide the exact title and call again:\n${list}`,
                },
              ],
              isError: true,
            };
          }

          const note = matches[0];
          const token = createConfirmation({
            action: "update",
            exactTitle: note.title,
            folder: note.folder,
            newTitle,
            newBody,
          });

          const changes: string[] = [];
          if (newTitle !== undefined) {
            changes.push(`New title: "${newTitle}"`);
          }
          if (newBody !== undefined) {
            const preview =
              newBody.length > 300 ? newBody.slice(0, 300) + "..." : newBody;
            changes.push(`New body preview:\n${preview}`);
          }

          return {
            content: [
              {
                type: "text",
                text:
                  `UPDATE PREVIEW — no changes made yet.\n\n` +
                  `Current note:\n` +
                  `- Title: "${note.title}"\n` +
                  `- Folder: ${note.folder}\n` +
                  `- Last modified: ${note.modifiedDate}\n\n` +
                  `Proposed changes:\n${changes.join("\n\n")}\n\n` +
                  `Ask the user to confirm this update. If they approve, call update_note again with:\n` +
                  `- title: "${note.title}" (exact)\n` +
                  `- confirmationToken: "${token}"\n` +
                  `- userConfirmed: true`,
              },
            ],
          };
        }

        if (!userConfirmed) {
          return {
            content: [
              {
                type: "text",
                text: "Update blocked: userConfirmed must be true. Ask the user explicitly, then retry only after they clearly approve.",
              },
            ],
            isError: true,
          };
        }

        const payload = consumeConfirmation(
          confirmationToken,
          "update",
        ) as UpdateConfirmationPayload;

        if (title !== payload.exactTitle) {
          return {
            content: [
              {
                type: "text",
                text: `Error: title must exactly match "${payload.exactTitle}" when confirming.`,
              },
            ],
            isError: true,
          };
        }

        const updated = await updateNote(config, {
          exactTitle: payload.exactTitle,
          newTitle: payload.newTitle,
          newBody: payload.newBody,
        });

        return {
          content: [
            {
              type: "text",
              text: `Note updated successfully.\nTitle: ${updated.title}\nFolder: ${updated.folder}\nLast Modified: ${updated.modifiedDate}\n\n---\n\n${updated.body}`,
            },
          ],
        };
      }

      case "delete_note": {
        const title = args?.title as string;
        const confirmationToken = args?.confirmationToken as string | undefined;
        const userConfirmed = args?.userConfirmed as boolean | undefined;

        if (!title) {
          return {
            content: [
              { type: "text", text: "Error: 'title' argument is required." },
            ],
            isError: true,
          };
        }

        if (!confirmationToken) {
          const matches = await findNotesByTitle(config, title);
          if (matches.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No accessible note found matching title "${title}".`,
                },
              ],
            };
          }

          if (matches.length > 1) {
            const list = matches
              .map((n) => `- "${n.title}" | Folder: ${n.folder}`)
              .join("\n");
            return {
              content: [
                {
                  type: "text",
                  text: `Multiple notes match "${title}". Provide the exact title and call again:\n${list}`,
                },
              ],
              isError: true,
            };
          }

          const note = matches[0];
          const token = createConfirmation({
            action: "delete",
            exactTitle: note.title,
            folder: note.folder,
          });

          const bodyPreview =
            note.body.length > 300
              ? note.body.slice(0, 300) + "..."
              : note.body;

          return {
            content: [
              {
                type: "text",
                text:
                  `DELETE PREVIEW — note NOT deleted yet.\n\n` +
                  `Note to delete:\n` +
                  `- Title: "${note.title}"\n` +
                  `- Folder: ${note.folder}\n` +
                  `- Last modified: ${note.modifiedDate}\n` +
                  `- Body preview:\n${bodyPreview}\n\n` +
                  `WARNING: Deletion is permanent and cannot be undone.\n\n` +
                  `Ask the user to confirm deletion. If they approve, call delete_note again with:\n` +
                  `- title: "${note.title}" (exact)\n` +
                  `- confirmationToken: "${token}"\n` +
                  `- userConfirmed: true`,
              },
            ],
          };
        }

        if (!userConfirmed) {
          return {
            content: [
              {
                type: "text",
                text: "Deletion blocked: userConfirmed must be true. Ask the user explicitly, then retry only after they clearly approve.",
              },
            ],
            isError: true,
          };
        }

        const payload = consumeConfirmation(confirmationToken, "delete");

        if (title !== payload.exactTitle) {
          return {
            content: [
              {
                type: "text",
                text: `Error: title must exactly match "${payload.exactTitle}" when confirming.`,
              },
            ],
            isError: true,
          };
        }

        const deleted = await deleteNote(config, payload.exactTitle);

        return {
          content: [
            {
              type: "text",
              text: `Note deleted permanently.\nTitle: "${deleted.title}"\nFolder: ${deleted.folder}`,
            },
          ],
        };
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
