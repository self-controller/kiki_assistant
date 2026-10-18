// Signing in to Google on this computer: the installed-app OAuth flow with PKCE and a loopback redirect.
// The tokens stay here (encrypted with the OS keyring) and never go to the Kiki server.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getGoogleTokens, setGoogleTokens, type GoogleTokens } from "../settings.ts";
import { openExternal } from "../windows.ts";
import { emailFromIdToken, pkcePair } from "./format.ts";

const CLIENT_ID = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET ?? "";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",
  // Drafts and sending; not reading mail.
  "https://www.googleapis.com/auth/gmail.compose",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** Google needs signing in again (the person revoked access, or the token expired). */
export class GoogleAuthError extends Error {}

/** This build has a Google OAuth client, so the connectors can be turned on. */
export function googleAvailable(): boolean {
  return Boolean(CLIENT_ID);
}

export function googleAccount(): { connected: boolean; email?: string } {
  const tokens = getGoogleTokens();
  return tokens ? { connected: true, ...(tokens.email ? { email: tokens.email } : {}) } : { connected: false };
}

const PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Kiki</title>` +
  `<body style="font:16px system-ui;background:#0b0b0c;color:#f5f5f5;display:grid;place-items:center;height:90vh">` +
  `<p>${message}</p></body>`;

let pending: { server: Server; cancel: () => void } | null = null;

/** Opens Google's sign-in page in the browser and waits for the person to finish. */
export async function connectGoogle(): Promise<GoogleTokens> {
  if (!CLIENT_ID) throw new Error("This build of Kiki has no Google client set up.");
  pending?.cancel();

  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("hex");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const code = await new Promise<string>((resolve, reject) => {
    const finish = (error: Error | null, value?: string) => {
      clearTimeout(timer);
      server.close();
      pending = null;
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error("Google sign-in timed out.")), SIGN_IN_TIMEOUT_MS);
    pending = { server, cancel: () => finish(new Error("Google sign-in was cancelled.")) };

    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);
      if (url.pathname !== "/") {
        response.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const received = url.searchParams.get("code");
      const ok = !error && received && url.searchParams.get("state") === state;
      response
        .writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" })
        .end(PAGE(ok ? "Kiki is connected to Google. You can close this tab." : "Kiki couldn't connect to Google."));
      if (ok) finish(null, received);
      else finish(new Error(error === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in failed."));
    });

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      // Always returns a refresh token, even when the person connected before.
      prompt: "consent",
    });
    openExternal(`${AUTH_URL}?${params}`);
  });

  const body = await tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
  if (!body.refresh_token) throw new Error("Google didn't grant offline access. Try connecting again.");
  const tokens: GoogleTokens = {
    refreshToken: body.refresh_token,
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    ...(body.scope ? { scope: body.scope } : {}),
    ...(emailFromIdToken(body.id_token) ? { email: emailFromIdToken(body.id_token) } : {}),
  };
  setGoogleTokens(tokens);
  return tokens;
}

/** Forgets the account here and asks Google to revoke Kiki's access. */
export async function disconnectGoogle(): Promise<void> {
  pending?.cancel();
  const tokens = getGoogleTokens();
  setGoogleTokens(null);
  if (!tokens) return;
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: tokens.refreshToken }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...(CLIENT_SECRET ? { client_secret: CLIENT_SECRET } : {}), ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as TokenResponse;
  if (body.error === "invalid_grant") {
    throw new GoogleAuthError("Kiki's access to Google expired or was revoked. Reconnect Google in Settings.");
  }
  if (!response.ok || !body.access_token) throw new Error(`Google sign-in failed (HTTP ${response.status}).`);
  return body;
}

let refreshing: Promise<string> | null = null;

/** A current access token, refreshed when it's about to expire. */
export async function accessToken(): Promise<string> {
  const tokens = getGoogleTokens();
  if (!tokens) throw new GoogleAuthError("Connect Google in Kiki's Settings first.");
  if (tokens.accessToken && (tokens.expiresAt ?? 0) > Date.now() + 60_000) return tokens.accessToken;
  refreshing ??= tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refreshToken })
    .then((body) => {
      setGoogleTokens({ ...tokens, accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 });
      return body.access_token;
    })
    .catch((error: unknown) => {
      if (error instanceof GoogleAuthError) setGoogleTokens(null);
      throw error;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}
