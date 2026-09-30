/// <reference types="@cloudflare/workers-types" />

import { GoogleAuthError, SCOPE_FULL, SCOPE_READONLY } from "./google-auth.js";
import { SearchConsoleClient, SearchConsoleError } from "./gsc.js";
import { buildTools } from "./tools.js";

export interface Env {
  /** Service account email, from client_email in the JSON key. */
  GOOGLE_CLIENT_EMAIL?: string;
  /** Service account private key, from private_key in the JSON key. */
  GOOGLE_PRIVATE_KEY?: string;
  /** Access token for this server. Comma separated list accepted, for rotation. */
  MCP_TOKEN?: string;
  /** Optional comma separated property allowlist. Set as a secret to keep it private. */
  ALLOWED_SITES?: string;
  /** "true" registers the sitemap write tools. Off by default. */
  ENABLE_WRITES?: string;
}

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "google-search-console-mcp";
const SERVER_VERSION = "1.0.0";

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRpc(message: any, env: Env) {
  const { method, id, params } = message ?? {};

  const allowedSites = (env.ALLOWED_SITES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const writesEnabled = env.ENABLE_WRITES === "true";
  const registry: Record<string, any> = buildTools(allowedSites);
  if (!writesEnabled) {
    for (const [name, tool] of Object.entries(registry)) {
      if (tool.write) delete registry[name];
    }
  }

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: [
          "Google Search Console. Property identifiers are either sc-domain:example.com for a",
          "Domain property or https://example.com/ with a trailing slash for a URL-prefix property;",
          "call list_sites rather than guessing. Search Console data lags 2 to 3 days, so date",
          "ranges ending today return little or nothing.",
          writesEnabled ? "Sitemap write tools are enabled." : "This server is read-only.",
        ].join(" "),
      });

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        tools: Object.values(registry).map((tool: any) => tool.definition),
      });

    case "tools/call": {
      const tool = registry[params?.name];
      if (!tool) {
        return rpcResult(id, {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown tool "${params?.name}". Available: ${Object.keys(registry).join(", ")}.${
                !writesEnabled ? " Write tools are disabled on this server." : ""
              }`,
            },
          ],
        });
      }

      if (!env.GOOGLE_CLIENT_EMAIL || !env.GOOGLE_PRIVATE_KEY) {
        // Listing the binding names turns a misspelled secret from an
        // undiagnosable failure into an obvious one.
        const missing = [
          env.GOOGLE_CLIENT_EMAIL ? null : "GOOGLE_CLIENT_EMAIL",
          env.GOOGLE_PRIVATE_KEY ? null : "GOOGLE_PRIVATE_KEY",
        ]
          .filter(Boolean)
          .join(" and ");
        const bindings = Object.keys(env).sort().join(", ") || "none";
        return rpcResult(id, {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Server not configured: ${missing} is not visible to the runtime. ` +
                `Bindings the Worker can currently see: ${bindings}. ` +
                "Take the values from the service account JSON key file, and check the secret names match exactly and are Secrets rather than Text variables.",
            },
          ],
        });
      }

      try {
        // Requesting only the scope actually needed. A read-only deployment
        // cannot modify sitemaps even if a token were somehow misused.
        const client = new SearchConsoleClient(
          env.GOOGLE_CLIENT_EMAIL,
          env.GOOGLE_PRIVATE_KEY,
          writesEnabled ? SCOPE_FULL : SCOPE_READONLY,
        );
        const result = await tool.handler(params?.arguments ?? {}, { client, allowedSites });
        return rpcResult(id, result);
      } catch (error: any) {
        const text =
          error instanceof SearchConsoleError
            ? error.userMessage()
            : error instanceof GoogleAuthError
              ? error.message
              : (error?.message ?? String(error));
        return rpcResult(id, { isError: true, content: [{ type: "text", text }] });
      }
    }

    case "resources/list":
      return rpcResult(id, { resources: [] });

    case "prompts/list":
      return rpcResult(id, { prompts: [] });

    default:
      if (typeof method === "string" && method.startsWith("notifications/")) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * Credential headers, in priority order. Some MCP clients reserve Authorization
 * for their own OAuth bearer and will not let you set it, so alternatives are
 * accepted. x-api-key is the conventional choice.
 */
const CREDENTIAL_HEADERS = [
  "authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "x-apikey",
  "x-api-token",
  "api-token",
  "x-auth-token",
];

function extractCredential(request: Request, pathToken: RegExpMatchArray | null): string {
  for (const name of CREDENTIAL_HEADERS) {
    const raw = request.headers.get(name);
    if (!raw) continue;
    const value = /^Bearer\s+/i.test(raw) ? raw.replace(/^Bearer\s+/i, "").trim() : raw.trim();
    if (value) return value;
  }
  return pathToken ? decodeURIComponent(pathToken[1]) : "";
}

/**
 * Compares against a comma separated list, so a new token can be added and
 * clients migrated one at a time before the old one is dropped. Comparison is
 * constant time with respect to the token contents, and every candidate is
 * checked rather than returning early, so a match position cannot be timed.
 */
function tokenMatches(supplied: string, configured: string): boolean {
  let matched = false;
  for (const candidate of configured.split(",").map((t) => t.trim()).filter(Boolean)) {
    let diff = supplied.length ^ candidate.length;
    for (let i = 0; i < supplied.length; i++) {
      diff |= supplied.charCodeAt(i) ^ candidate.charCodeAt(i % Math.max(candidate.length, 1));
    }
    if (diff === 0) matched = true;
  }
  return matched;
}

function unauthorised(message: string): Response {
  // Deliberately no WWW-Authenticate header. That header advertises OAuth
  // support, and MCP clients use it to auto-detect an OAuth flow this server
  // does not implement. Set the client's authentication mode to None instead.
  return new Response(JSON.stringify(rpcError(null, -32001, message)), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === "/health") return new Response("ok");

    const pathToken = path.match(/^\/mcp\/t\/([^/]+)\/?$/);
    const isMcp = path === "/mcp" || path === "/mcp/" || Boolean(pathToken);
    if (!isMcp) return new Response("Not found", { status: 404 });

    if (request.method !== "POST") {
      return new Response("This server speaks MCP over HTTP POST only.", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    // A service account key is a file rather than something a caller can
    // reasonably pass with each request, so there is no bring-your-own-key
    // mode here and MCP_TOKEN is always required.
    if (!env.MCP_TOKEN) {
      return new Response(
        JSON.stringify(
          rpcError(
            null,
            -32002,
            "Server misconfigured: MCP_TOKEN is not set, which would leave this endpoint open to anyone. Set it as a secret on the Worker.",
          ),
        ),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const supplied = extractCredential(request, pathToken);
    if (!tokenMatches(supplied, env.MCP_TOKEN)) {
      return unauthorised(
        "Invalid or missing access token. Send it in an x-api-key header, or use the /mcp/t/<token> URL form.",
      );
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return new Response(JSON.stringify(rpcError(null, -32700, "Parse error")), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const messages = Array.isArray(payload) ? payload : [payload];
    const responses = [];
    for (const message of messages) {
      const response = await handleRpc(message, env);
      if (response) responses.push(response);
    }

    if (!responses.length) return new Response(null, { status: 202 });

    return new Response(JSON.stringify(Array.isArray(payload) ? responses : responses[0]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
};
