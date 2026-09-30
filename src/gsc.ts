/// <reference types="@cloudflare/workers-types" />

import { getAccessToken } from "./google-auth.js";

const WEBMASTERS_BASE = "https://searchconsole.googleapis.com/webmasters/v3";
const INSPECTION_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

export const CACHE_TTL_SECONDS = 300;

export class SearchConsoleError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Search Console API error ${status}`);
    this.name = "SearchConsoleError";
  }

  userMessage(): string {
    let detail = this.body.slice(0, 300);
    try {
      const parsed = JSON.parse(this.body);
      if (parsed?.error?.message) detail = String(parsed.error.message).slice(0, 300);
    } catch {
      // keep the raw snippet
    }

    switch (this.status) {
      case 403:
        return (
          "Google denied access (403). The usual cause is that the service account has not been added " +
          "as a user on this property. In Search Console, open the property, then Settings, Users and " +
          `permissions, Add user, and paste the service account email. Detail: ${detail}`
        );
      case 404:
        return (
          "Google could not find that property (404). site_url must match Search Console exactly. " +
          "Domain properties look like sc-domain:example.com, URL-prefix properties look like " +
          `https://example.com/ with the trailing slash. Run list_sites to see the exact strings. Detail: ${detail}`
        );
      case 429:
        return `Google rate limited this request (429). Wait before retrying. Detail: ${detail}`;
      default:
        return `Search Console API error ${this.status}. Detail: ${detail}`;
    }
  }
}

/**
 * Search Console identifies properties two ways, and is unforgiving about both:
 * "sc-domain:example.com" for a Domain property, or a URL prefix such as
 * "https://example.com/" including the trailing slash. A bare domain matches
 * nothing, so nudge it into the right shape rather than returning a bare 404.
 */
export function normaliseProperty(siteUrl: string): string {
  const trimmed = siteUrl.trim();
  if (trimmed.startsWith("sc-domain:")) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  }
  return trimmed;
}

export function propertyHint(siteUrl: string): string | null {
  const trimmed = siteUrl.trim();
  if (trimmed.startsWith("sc-domain:")) return null;
  if (/^https?:\/\//i.test(trimmed)) return null;
  return (
    `site_url "${trimmed}" is not a Search Console property identifier. Use ` +
    `"sc-domain:${trimmed}" for a Domain property, or "https://${trimmed}/" for a ` +
    "URL-prefix property. Run list_sites to see which you have."
  );
}

async function cacheKey(clientEmail: string, parts: unknown): Promise<string> {
  const material = new TextEncoder().encode(`${clientEmail}::${JSON.stringify(parts)}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class SearchConsoleClient {
  constructor(
    private readonly clientEmail: string,
    private readonly privateKey: string,
    private readonly scope: string,
  ) {}

  private async token(): Promise<string> {
    return getAccessToken(this.clientEmail, this.privateKey, this.scope);
  }

  private async request(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<unknown> {
    const token = await this.token();
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    if (!response.ok) throw new SearchConsoleError(response.status, text);
    return text ? JSON.parse(text) : { ok: true };
  }

  /** Cached read. Search Console data only updates daily, so caching is safe. */
  private async cachedRequest(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<unknown> {
    const key = await cacheKey(this.clientEmail, [method, url, body]);
    const cacheUrl = `https://gsc-mcp.invalid/q/${key}`;
    const cache = caches.default;

    const hit = await cache.match(cacheUrl);
    if (hit) return await hit.json();

    const data = await this.request(method, url, body);

    await cache.put(
      cacheUrl,
      new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${CACHE_TTL_SECONDS}`,
        },
      }),
    );

    return data;
  }

  listSites(): Promise<unknown> {
    return this.cachedRequest("GET", `${WEBMASTERS_BASE}/sites`);
  }

  getSite(siteUrl: string): Promise<unknown> {
    const property = encodeURIComponent(normaliseProperty(siteUrl));
    return this.cachedRequest("GET", `${WEBMASTERS_BASE}/sites/${property}`);
  }

  searchAnalytics(siteUrl: string, body: Record<string, unknown>): Promise<unknown> {
    const property = encodeURIComponent(normaliseProperty(siteUrl));
    return this.cachedRequest(
      "POST",
      `${WEBMASTERS_BASE}/sites/${property}/searchAnalytics/query`,
      body,
    );
  }

  listSitemaps(siteUrl: string, sitemapIndex?: string): Promise<unknown> {
    const property = encodeURIComponent(normaliseProperty(siteUrl));
    const url = new URL(`${WEBMASTERS_BASE}/sites/${property}/sitemaps`);
    if (sitemapIndex) url.searchParams.set("sitemapIndex", sitemapIndex);
    return this.cachedRequest("GET", url.toString());
  }

  getSitemap(siteUrl: string, feedpath: string): Promise<unknown> {
    const property = encodeURIComponent(normaliseProperty(siteUrl));
    return this.cachedRequest(
      "GET",
      `${WEBMASTERS_BASE}/sites/${property}/sitemaps/${encodeURIComponent(feedpath)}`,
    );
  }

  submitSitemap(siteUrl: string, feedpath: string): Promise<unknown> {
    const property = encodeURIComponent(normaliseProperty(siteUrl));
    return this.request(
      "PUT",
      `${WEBMASTERS_BASE}/sites/${property}/sitemaps/${encodeURIComponent(feedpath)}`,
    );
  }

  deleteSitemap(siteUrl: string, feedpath: string): Promise<unknown> {
    const property = encodeURIComponent(normaliseProperty(siteUrl));
    return this.request(
      "DELETE",
      `${WEBMASTERS_BASE}/sites/${property}/sitemaps/${encodeURIComponent(feedpath)}`,
    );
  }

  inspectUrl(siteUrl: string, inspectionUrl: string, languageCode?: string): Promise<unknown> {
    return this.request("POST", INSPECTION_URL, {
      siteUrl: normaliseProperty(siteUrl),
      inspectionUrl,
      ...(languageCode ? { languageCode } : {}),
    });
  }
}
