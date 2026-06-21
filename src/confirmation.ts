import { randomBytes } from "crypto";

const CONFIRMATION_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type ConfirmationAction = "update" | "delete";

export interface UpdateConfirmationPayload {
  action: "update";
  exactTitle: string;
  folder: string;
  newTitle?: string;
  newBody?: string;
}

export interface DeleteConfirmationPayload {
  action: "delete";
  exactTitle: string;
  folder: string;
}

export type ConfirmationPayload =
  | UpdateConfirmationPayload
  | DeleteConfirmationPayload;

interface PendingConfirmation {
  token: string;
  payload: ConfirmationPayload;
  expiresAt: number;
}

const pendingConfirmations = new Map<string, PendingConfirmation>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [token, entry] of pendingConfirmations) {
    if (entry.expiresAt <= now) {
      pendingConfirmations.delete(token);
    }
  }
}

export function createConfirmation(payload: ConfirmationPayload): string {
  purgeExpired();
  const token = randomBytes(16).toString("hex");
  pendingConfirmations.set(token, {
    token,
    payload,
    expiresAt: Date.now() + CONFIRMATION_TTL_MS,
  });
  return token;
}

export function consumeConfirmation(
  token: string,
  expectedAction: ConfirmationAction,
): ConfirmationPayload {
  purgeExpired();

  const entry = pendingConfirmations.get(token);
  if (!entry) {
    throw new Error(
      "Invalid or expired confirmation token. Request a new confirmation by calling the tool again without confirmationToken.",
    );
  }

  if (entry.payload.action !== expectedAction) {
    throw new Error(
      `Confirmation token is for "${entry.payload.action}", not "${expectedAction}".`,
    );
  }

  pendingConfirmations.delete(token);
  return entry.payload;
}
