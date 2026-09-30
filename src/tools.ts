import {
  SearchConsoleClient,
  normaliseProperty,
  propertyHint,
} from "./gsc.js";

export interface ToolContext {
  client: SearchConsoleClient;
  allowedSites: string[];
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export const DIMENSIONS = ["query", "page", "country", "device", "date", "searchAppearance"];
const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"];

/**
 * Search Console data lags roughly two to three days. Defaulting the end of a
 * range to today produces empty or partial rows and looks like a broken tool, so
 * ranges end three days back unless the caller says otherwise.
 */
const DATA_LAG_DAYS = 3;
const DEFAULT_ROW_LIMIT = 50;
const MAX_ROW_LIMIT = 5000;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return isoDate(date);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function resolveRange(args: {
  start_date?: unknown;
  end_date?: unknown;
  days?: unknown;
}): { start: string; end: string } | string {
  const { start_date, end_date, days } = args;

  if (typeof start_date === "string" || typeof end_date === "string") {
    if (typeof start_date !== "string" || typeof end_date !== "string") {
      return "start_date and end_date must be given together, both as YYYY-MM-DD.";
    }
    for (const value of [start_date, end_date]) {
      if (!ISO.test(value)) return `Date "${value}" must be in YYYY-MM-DD format.`;
      const parsed = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || isoDate(parsed) !== value) {
        return `Date "${value}" is not a real date.`;
      }
    }
    if (start_date > end_date) return "start_date is after end_date.";
    return { start: start_date, end: end_date };
  }

  const window = typeof days === "number" && days > 0 ? Math.floor(days) : 28;
  return { start: daysAgo(window + DATA_LAG_DAYS), end: daysAgo(DATA_LAG_DAYS) };
}

export function checkSite(siteUrl: unknown, ctx: ToolContext): string | null {
  if (typeof siteUrl !== "string" || !siteUrl) {
    return "site_url is required. Run list_sites to see the exact property identifiers available.";
  }
  const hint = propertyHint(siteUrl);
  if (hint) return hint;

  if (ctx.allowedSites.length) {
    const normalised = normaliseProperty(siteUrl);
    const allowed = ctx.allowedSites.map(normaliseProperty);
    if (!allowed.includes(normalised)) {
      return `site_url "${siteUrl}" is not in this server's allowlist. Allowed: ${ctx.allowedSites.join(", ")}.`;
    }
  }
  return null;
}

/**
 * Search Console returns rows with a positional "keys" array matching the
 * requested dimensions. Zip them into named fields so nothing has to track
 * column order, and round the awkward floats.
 */
function shapeRows(response: any, dimensions: string[]): Record<string, unknown>[] {
  return (response?.rows ?? []).map((row: any) => {
    const out: Record<string, unknown> = {};
    dimensions.forEach((dimension, i) => {
      out[dimension] = row.keys?.[i];
    });
    out.clicks = row.clicks;
    out.impressions = row.impressions;
    out.ctr = row.ctr === undefined ? undefined : Number((row.ctr * 100).toFixed(2));
    out.position = row.position === undefined ? undefined : Number(row.position.toFixed(1));
    return out;
  });
}

const siteProperty = {
  type: "string",
  description:
    'Search Console property. Domain properties are "sc-domain:example.com", URL-prefix properties are "https://example.com/" with the trailing slash. Run list_sites if unsure.',
};

const dateProperties = {
  start_date: { type: "string", description: "Start date, YYYY-MM-DD. Use with end_date." },
  end_date: { type: "string", description: "End date, YYYY-MM-DD. Use with start_date." },
  days: {
    type: "integer",
    description:
      "Alternative to explicit dates: the last N days, ending 3 days ago to allow for Search Console's reporting lag. Defaults to 28.",
  },
};

async function runAnalytics(
  args: any,
  ctx: ToolContext,
  dimensions: string[],
  extra: Record<string, unknown> = {},
): Promise<ToolResult> {
  const problem = checkSite(args.site_url, ctx);
  if (problem) return failure(problem);

  const range = resolveRange(args);
  if (typeof range === "string") return failure(range);

  const bad = dimensions.filter((d) => !DIMENSIONS.includes(d));
  if (bad.length) {
    return failure(`Unknown dimension(s): ${bad.join(", ")}. Valid: ${DIMENSIONS.join(", ")}.`);
  }

  const rowLimit = Math.min(Number(args.limit) || DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT);

  const body: Record<string, unknown> = {
    startDate: range.start,
    endDate: range.end,
    dimensions,
    rowLimit,
    startRow: Number(args.offset) || 0,
    ...extra,
  };
  if (args.search_type) body.type = args.search_type;
  if (args.data_state) body.dataState = args.data_state;
  if (args.filters) body.dimensionFilterGroups = args.filters;

  const response: any = await ctx.client.searchAnalytics(args.site_url, body);
  const rows = shapeRows(response, dimensions);

  const notes: string[] = [];
  if (rows.length === rowLimit) {
    notes.push(`Hit the row limit of ${rowLimit}. Raise limit or page with offset for more.`);
  }
  if (!rows.length) {
    notes.push(
      "No rows returned. Check the date range is not more recent than Search Console's 2 to 3 day reporting lag, and that the property has traffic in this period.",
    );
  }

  return json({
    site: args.site_url,
    range: { start: range.start, end: range.end },
    rows,
    ...(notes.length ? { notes } : {}),
    note: "ctr is a percentage. position is the average position, where lower is better.",
  });
}

/** Google rate limits URL inspection hard, and Workers cap subrequests. */
const MAX_INSPECT_BATCH = 20;
const INSPECT_CONCURRENCY = 4;

interface InspectSummary {
  url: string;
  indexed?: boolean;
  coverage_state?: string;
  last_crawled?: string;
  google_canonical?: string;
  user_canonical?: string;
  robots_state?: string;
  mobile_usable?: boolean;
  error?: string;
}

/**
 * Reduces Google's deeply nested inspection response to the handful of fields
 * anyone actually asks about. The full payload is large and mostly noise when
 * you are looking at twenty of them at once.
 */
function summariseInspection(url: string, response: any): InspectSummary {
  const result = response?.inspectionResult;
  const index = result?.indexStatusResult;
  if (!index) return { url, error: "No index status returned" };

  return {
    url,
    indexed: index.coverageState === "Submitted and indexed" || index.verdict === "PASS",
    coverage_state: index.coverageState,
    last_crawled: index.lastCrawlTime,
    google_canonical: index.googleCanonical,
    user_canonical: index.userCanonical,
    robots_state: index.robotsTxtState,
    mobile_usable: result?.mobileUsabilityResult?.verdict
      ? result.mobileUsabilityResult.verdict === "PASS"
      : undefined,
  };
}

/**
 * Inspects URLs in small parallel batches. Sequential would be slow enough to
 * risk a Worker timeout on twenty URLs; unbounded parallelism would trip
 * Google's per-minute limit.
 */
async function inspectMany(
  siteUrl: string,
  urls: string[],
  ctx: ToolContext,
  languageCode?: string,
): Promise<InspectSummary[]> {
  const results: InspectSummary[] = [];

  for (let i = 0; i < urls.length; i += INSPECT_CONCURRENCY) {
    const slice = urls.slice(i, i + INSPECT_CONCURRENCY);
    const settled = await Promise.all(
      slice.map(async (url) => {
        try {
          const response = await ctx.client.inspectUrl(siteUrl, url, languageCode);
          return summariseInspection(url, response);
        } catch (error: any) {
          const message =
            typeof error?.userMessage === "function" ? error.userMessage() : String(error?.message ?? error);
          return { url, error: message.slice(0, 200) } as InspectSummary;
        }
      }),
    );
    results.push(...settled);
  }

  return results;
}

// ---------------------------------------------------------------------------

export function buildTools(allowedSites: string[]) {
  const site = allowedSites.length
    ? { ...siteProperty, enum: allowedSites }
    : siteProperty;

  return {
    list_sites: {
      definition: {
        name: "list_sites",
        description:
          "Lists every Search Console property the service account can access, with its permission level. Call this first if unsure of the exact property identifier, since Google is strict about the format.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      async handler(_args: unknown, ctx: ToolContext) {
        const result: any = await ctx.client.listSites();
        const entries = result?.siteEntry ?? [];
        if (!entries.length) {
          return json({
            siteEntry: [],
            note: "The service account can see no properties. Add its email address as a user on each property in Search Console: open the property, Settings, Users and permissions, Add user.",
          });
        }
        return json(result);
      },
    },

    get_search_analytics: {
      definition: {
        name: "get_search_analytics",
        description:
          "Search performance data: clicks, impressions, CTR and average position, grouped by any combination of dimensions. This is the full performance report, use it when the preset tools do not fit.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            site_url: site,
            dimensions: {
              type: "array",
              items: { type: "string", enum: DIMENSIONS },
              description: `Group by. Valid: ${DIMENSIONS.join(", ")}. Defaults to query.`,
            },
            ...dateProperties,
            search_type: {
              type: "string",
              enum: SEARCH_TYPES,
              description: "Search surface. Defaults to web.",
            },
            data_state: {
              type: "string",
              enum: ["final", "all"],
              description:
                '"all" includes fresh but incomplete recent data. Defaults to final, which is complete but lags.',
            },
            filters: {
              type: "array",
              items: {},
              description:
                'Search Console dimensionFilterGroups, passed through. Example: [{"filters":[{"dimension":"page","operator":"contains","expression":"/blog"}]}]. Operators: equals, notEquals, contains, notContains, includingRegex, excludingRegex.',
            },
            limit: { type: "integer", minimum: 1, maximum: MAX_ROW_LIMIT },
            offset: { type: "integer", minimum: 0 },
          },
          required: ["site_url"],
        },
      },
      async handler(args: any, ctx: ToolContext) {
        return runAnalytics(args, ctx, args.dimensions?.length ? args.dimensions : ["query"]);
      },
    },

    get_top_queries: {
      definition: {
        name: "get_top_queries",
        description:
          "The search queries bringing the most clicks to a property. The most common starting question for SEO work.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            site_url: site,
            ...dateProperties,
            page_filter: {
              type: "string",
              description: "Optional. Only count queries for pages whose URL contains this string.",
            },
            limit: { type: "integer", minimum: 1, maximum: MAX_ROW_LIMIT },
          },
          required: ["site_url"],
        },
      },
      async handler(args: any, ctx: ToolContext) {
        const filters = args.page_filter
          ? [{ filters: [{ dimension: "page", operator: "contains", expression: args.page_filter }] }]
          : undefined;
        return runAnalytics({ ...args, filters }, ctx, ["query"]);
      },
    },

    get_top_pages: {
      definition: {
        name: "get_top_pages",
        description: "The pages getting the most clicks and impressions from search.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            site_url: site,
            ...dateProperties,
            limit: { type: "integer", minimum: 1, maximum: MAX_ROW_LIMIT },
          },
          required: ["site_url"],
        },
      },
      async handler(args: any, ctx: ToolContext) {
        return runAnalytics(args, ctx, ["page"]);
      },
    },

    compare_periods: {
      definition: {
        name: "compare_periods",
        description:
          "Compares two date ranges and returns the change in clicks, impressions, CTR and position. Rows that appear in only one period are marked, which is how you spot queries that were won or lost rather than merely moved.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            site_url: site,
            dimension: {
              type: "string",
              enum: DIMENSIONS,
              description: "What to compare by. Defaults to query. Omit grouping with 'none'.",
            },
            current_start: { type: "string", description: "YYYY-MM-DD" },
            current_end: { type: "string", description: "YYYY-MM-DD" },
            previous_start: { type: "string", description: "YYYY-MM-DD" },
            previous_end: { type: "string", description: "YYYY-MM-DD" },
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
          required: [
            "site_url",
            "current_start",
            "current_end",
            "previous_start",
            "previous_end",
          ],
        },
      },
      async handler(args: any, ctx: ToolContext) {
        const problem = checkSite(args.site_url, ctx);
        if (problem) return failure(problem);

        const current = resolveRange({ start_date: args.current_start, end_date: args.current_end });
        if (typeof current === "string") return failure(`Current period: ${current}`);
        const previous = resolveRange({
          start_date: args.previous_start,
          end_date: args.previous_end,
        });
        if (typeof previous === "string") return failure(`Previous period: ${previous}`);

        const dimension = args.dimension && args.dimension !== "none" ? args.dimension : null;
        const dimensions = dimension ? [dimension] : [];
        const rowLimit = Math.min(Number(args.limit) || 25, 500);

        const query = (range: { start: string; end: string }) =>
          ctx.client.searchAnalytics(args.site_url, {
            startDate: range.start,
            endDate: range.end,
            dimensions,
            rowLimit,
          });

        const [currentResponse, previousResponse] = await Promise.all([
          query(current),
          query(previous),
        ]);

        const currentRows = shapeRows(currentResponse, dimensions);
        const previousRows = shapeRows(previousResponse, dimensions);

        const keyOf = (row: Record<string, unknown>) =>
          dimension ? String(row[dimension] ?? "") : "__total__";
        const previousByKey = new Map(previousRows.map((row) => [keyOf(row), row]));
        const seen = new Set<string>();

        const metrics = ["clicks", "impressions", "ctr", "position"] as const;

        const comparison = currentRows.map((row) => {
          const key = keyOf(row);
          seen.add(key);
          const before = previousByKey.get(key);
          const entry: Record<string, unknown> = {};
          if (dimension) entry[dimension] = row[dimension];

          for (const metric of metrics) {
            const now = Number(row[metric] ?? 0);
            const then = before === undefined ? null : Number(before[metric] ?? 0);
            entry[metric] = {
              current: row[metric],
              previous: then,
              change: then === null ? null : Number((now - then).toFixed(2)),
            };
          }
          if (before === undefined && dimension) entry.status = "new in current period";
          return entry;
        });

        const lost = previousRows
          .filter((row) => !seen.has(keyOf(row)))
          .map((row) => {
            const entry: Record<string, unknown> = { status: "absent from current period" };
            if (dimension) entry[dimension] = row[dimension];
            for (const metric of metrics) {
              entry[metric] = { current: null, previous: row[metric] };
            }
            return entry;
          });

        return json({
          site: args.site_url,
          current: current,
          previous: previous,
          comparison,
          ...(lost.length ? { lost_from_current: lost } : {}),
          note: "For position, a negative change is an improvement, since position 1 is best. ctr is a percentage.",
        });
      },
    },

    inspect_url: {
      definition: {
        name: "inspect_url",
        description:
          "Inspects a single URL's index status: whether Google has indexed it, when it was last crawled, the canonical Google chose, mobile usability and any rich result issues. The equivalent of the URL Inspection tool in the Search Console UI. Rate limited by Google, so use it for specific questions rather than bulk checking.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            site_url: site,
            url: { type: "string", description: "The full URL to inspect. Must be within the property." },
            language_code: { type: "string", description: 'Optional BCP-47 code, e.g. "en-GB".' },
          },
          required: ["site_url", "url"],
        },
      },
      async handler(args: any, ctx: ToolContext) {
        const problem = checkSite(args.site_url, ctx);
        if (problem) return failure(problem);
        return json(await ctx.client.inspectUrl(args.site_url, args.url, args.language_code));
      },
    },

    batch_inspect_urls: {
      definition: {
        name: "batch_inspect_urls",
        description:
          "Inspects several URLs at once and returns each one's index status side by side, plus a summary of how many are indexed. Use this to check a set of pages after a release, or to work out whether a section of the site is being indexed at all. Limited to 20 URLs per call, because Google rate limits URL inspection heavily.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            site_url: site,
            urls: {
              type: "array",
              items: { type: "string" },
              maxItems: MAX_INSPECT_BATCH,
              description: `Full URLs to inspect, up to ${MAX_INSPECT_BATCH}. All must be within the property.`,
            },
            language_code: { type: "string", description: 'Optional BCP-47 code, e.g. "en-GB".' },
          },
          required: ["site_url", "urls"],
        },
      },
      async handler(args: any, ctx: ToolContext) {
        const problem = checkSite(args.site_url, ctx);
        if (problem) return failure(problem);

        const urls: string[] = Array.isArray(args.urls) ? args.urls : [];
        if (!urls.length) return failure("urls must contain at least one URL.");
        if (urls.length > MAX_INSPECT_BATCH) {
          return failure(
            `Too many URLs (${urls.length}). Google rate limits URL inspection, so this tool accepts at most ${MAX_INSPECT_BATCH} per call. Split the list and call again.`,
          );
        }

        const results = await inspectMany(args.site_url, urls, ctx, args.language_code);
        const indexed = results.filter((r) => r.indexed === true).length;
        const notIndexed = results.filter((r) => r.indexed === false).length;
        const failed = results.filter((r) => r.error !== undefined).length;

        return json({
          site: args.site_url,
          summary: {
            checked: results.length,
            indexed,
            not_indexed: notIndexed,
            ...(failed ? { errored: failed } : {}),
          },
          results,
        });
      },
    },

    check_indexing_issues: {
      definition: {
        name: "check_indexing_issues",
        description:
          "Inspects a set of URLs and reports only the ones with problems, grouped by cause, with the most common issue first. Use this when the question is 'what is wrong' rather than 'what is the status of this page'. Limited to 20 URLs per call.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            site_url: site,
            urls: {
              type: "array",
              items: { type: "string" },
              maxItems: MAX_INSPECT_BATCH,
              description: `Full URLs to check, up to ${MAX_INSPECT_BATCH}.`,
            },
          },
          required: ["site_url", "urls"],
        },
      },
      async handler(args: any, ctx: ToolContext) {
        const problem = checkSite(args.site_url, ctx);
        if (problem) return failure(problem);

        const urls: string[] = Array.isArray(args.urls) ? args.urls : [];
        if (!urls.length) return failure("urls must contain at least one URL.");
        if (urls.length > MAX_INSPECT_BATCH) {
          return failure(
            `Too many URLs (${urls.length}). This tool accepts at most ${MAX_INSPECT_BATCH} per call.`,
          );
        }

        const results = await inspectMany(args.site_url, urls, ctx);
        const problems = results.filter((r) => r.indexed !== true || r.error !== undefined);

        if (!problems.length) {
          return json({
            site: args.site_url,
            checked: results.length,
            issues: [],
            note: "Every URL checked is indexed with no reported problems.",
          });
        }

        // Group by cause so the answer names the pattern rather than listing
        // twenty near-identical rows.
        const groups = new Map<string, string[]>();
        for (const result of problems) {
          const cause = result.error ?? result.coverage_state ?? "Unknown";
          const list = groups.get(cause) ?? [];
          list.push(result.url);
          groups.set(cause, list);
        }

        const issues = [...groups.entries()]
          .map(([cause, affected]) => ({ cause, count: affected.length, urls: affected }))
          .sort((a, b) => b.count - a.count);

        return json({
          site: args.site_url,
          checked: results.length,
          with_issues: problems.length,
          issues,
        });
      },
    },

    list_sitemaps: {
      definition: {
        name: "list_sitemaps",
        description:
          "Lists the sitemaps Google knows about for a property, with when each was last downloaded, how many URLs it contained and any warnings or errors.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            site_url: site,
            sitemap_index: {
              type: "string",
              description: "Optional. Full URL of a sitemap index, to list the sitemaps within it.",
            },
          },
          required: ["site_url"],
        },
      },
      async handler(args: any, ctx: ToolContext) {
        const problem = checkSite(args.site_url, ctx);
        if (problem) return failure(problem);
        const result: any = await ctx.client.listSitemaps(args.site_url, args.sitemap_index);
        if (!result?.sitemap?.length) {
          return json({
            sitemap: [],
            note: "Google has no sitemaps recorded for this property. Submitting one is usually worthwhile.",
          });
        }
        return json(result);
      },
    },

    get_sitemap: {
      definition: {
        name: "get_sitemap",
        description: "Details for one specific sitemap, including its processing status and contents summary.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            site_url: site,
            sitemap_url: { type: "string", description: "Full URL of the sitemap." },
          },
          required: ["site_url", "sitemap_url"],
        },
      },
      async handler(args: any, ctx: ToolContext) {
        const problem = checkSite(args.site_url, ctx);
        if (problem) return failure(problem);
        return json(await ctx.client.getSitemap(args.site_url, args.sitemap_url));
      },
    },

    submit_sitemap: {
      write: true,
      definition: {
        name: "submit_sitemap",
        description:
          "Submits a sitemap to Google for a property. Idempotent, resubmitting an existing sitemap simply refreshes it. Requires the service account to have Full permission on the property, not Restricted.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            site_url: site,
            sitemap_url: { type: "string", description: "Full URL of the sitemap to submit." },
          },
          required: ["site_url", "sitemap_url"],
        },
      },
      async handler(args: any, ctx: ToolContext) {
        const problem = checkSite(args.site_url, ctx);
        if (problem) return failure(problem);
        await ctx.client.submitSitemap(args.site_url, args.sitemap_url);
        return json({
          submitted: args.sitemap_url,
          note: "Google accepted the submission. Processing takes time, so check list_sitemaps later for status.",
        });
      },
    },

    delete_sitemap: {
      write: true,
      definition: {
        name: "delete_sitemap",
        description:
          "Removes a sitemap from a property in Search Console. This does not remove the pages from Google's index, it only stops Google using this sitemap. Requires Full permission.",
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            site_url: site,
            sitemap_url: { type: "string", description: "Full URL of the sitemap to remove." },
            confirm: {
              type: "boolean",
              description: "Must be true. Only set once the person has explicitly agreed.",
            },
          },
          required: ["site_url", "sitemap_url", "confirm"],
        },
      },
      async handler(args: any, ctx: ToolContext) {
        if (args.confirm !== true) {
          return failure(
            `Not removed. "${args.sitemap_url}" would stop being used by Google for this property. Re-run with confirm set to true only after the person has agreed.`,
          );
        }
        const problem = checkSite(args.site_url, ctx);
        if (problem) return failure(problem);
        await ctx.client.deleteSitemap(args.site_url, args.sitemap_url);
        return json({ deleted: args.sitemap_url });
      },
    },
  };
}
