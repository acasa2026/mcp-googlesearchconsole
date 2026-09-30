/// <reference types="@cloudflare/workers-types" />

/**
 * Google service account authentication, done with WebCrypto so it works in a
 * Worker with no Node dependencies.
 *
 * The flow: build a JWT asserting who we are and what we want, sign it with the
 * service account's private key, then swap it at Google's token endpoint for a
 * short-lived access token. Tokens last an hour, so they are cached.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const SCOPE_READONLY = "https://www.googleapis.com/auth/webmasters.readonly";
export const SCOPE_FULL = "https://www.googleapis.com/auth/webmasters";

/** Refreshed with headroom, so a token never expires mid-request. */
const TOKEN_TTL_SECONDS = 3000;

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

function base64url(input: ArrayBuffer | string): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Turns a PEM private key into a CryptoKey.
 *
 * Secrets pasted into a dashboard often arrive with literal backslash-n rather
 * than real newlines, and sometimes wrapped in quotes, so both are handled.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const cleaned = pem
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\n/g, "\n");

  const match = cleaned.match(
    /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/,
  );
  if (!match) {
    throw new GoogleAuthError(
      "GOOGLE_PRIVATE_KEY does not look like a PEM private key. Copy the whole private_key value from the service account JSON, including the BEGIN and END lines.",
    );
  }

  const body = match[1].replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      bytes.buffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new GoogleAuthError(
      "Could not import GOOGLE_PRIVATE_KEY. Check it was copied complete and unmodified from the service account JSON.",
    );
  }
}

async function signJwt(clientEmail: string, privateKey: string, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: clientEmail,
      scope,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );

  const key = await importPrivateKey(privateKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );

  return `${header}.${claims}.${base64url(signature)}`;
}

async function cacheKeyFor(clientEmail: string, scope: string): Promise<string> {
  const material = new TextEncoder().encode(`${clientEmail}::${scope}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getAccessToken(
  clientEmail: string,
  privateKey: string,
  scope: string,
): Promise<string> {
  const cacheUrl = `https://gsc-mcp.invalid/token/${await cacheKeyFor(clientEmail, scope)}`;
  const cache = caches.default;

  const hit = await cache.match(cacheUrl);
  if (hit) {
    const cached = (await hit.json()) as { access_token?: string };
    if (cached.access_token) return cached.access_token;
  }

  const assertion = await signJwt(clientEmail, privateKey, scope);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    let hint = "";
    if (text.includes("invalid_grant")) {
      hint =
        " This usually means the service account email or private key is wrong, or the server clock is badly out of step.";
    } else if (text.includes("access_denied") || text.includes("unauthorized_client")) {
      hint = " Check the Google Search Console API is enabled on the Cloud project.";
    }
    throw new GoogleAuthError(
      `Google refused the service account credentials (HTTP ${response.status}).${hint} Detail: ${text.slice(0, 300)}`,
    );
  }

  const token = JSON.parse(text) as { access_token?: string };
  if (!token.access_token) {
    throw new GoogleAuthError("Google returned no access token.");
  }

  await cache.put(
    cacheUrl,
    new Response(JSON.stringify({ access_token: token.access_token }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${TOKEN_TTL_SECONDS}`,
      },
    }),
  );

  return token.access_token;
}
