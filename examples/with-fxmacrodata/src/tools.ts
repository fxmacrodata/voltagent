import { createTool } from "@voltagent/core";
import { z } from "zod";

const FXMACRODATA_BASE_URL = "https://api.fxmacrodata.com/v1";
const FXMACRODATA_REQUEST_TIMEOUT_MS = 20_000;

type FXMacroDataQueryParams = Record<string, number | string | undefined>;

type FXMacroDataResult = {
  data?: unknown;
  error?: string;
  status?: number;
  success: boolean;
};

const currencySchema = z.string().regex(/^[A-Za-z]{3}$/, "Use a three-letter ISO currency code.");

/**
 * Lower-cases a currency code for use in a URL path segment.
 */
function code(value: string): string {
  return value.trim().toLowerCase();
}

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .optional();

/**
 * Reads FXMACRODATA_API_KEY. The key is optional: USD releases from the last 90 days, the USD
 * calendar and the data catalogue answer without one. Other currencies, older history and FX
 * rates need one. Returns an error string (never containing the key) for a malformed value.
 */
function readApiKey(): { key?: string; error?: string } {
  const key = process.env.FXMACRODATA_API_KEY?.trim();
  if (!key) {
    return {};
  }
  if (!/^[!-~]+$/.test(key)) {
    return {
      error:
        "FXMACRODATA_API_KEY contains whitespace or non-printable characters; check the value.",
    };
  }
  return { key };
}

/**
 * Removes the API key from text that is returned to the model.
 */
function redact(text: string, key?: string): string {
  return key ? text.split(key).join("[redacted]") : text;
}

/**
 * Returns an error message when a 200 response is not the shape the endpoint documents.
 */
function shapeError(path: string, data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return "Unexpected response shape: expected a JSON object.";
  }
  const body = data as Record<string, unknown>;
  if (("detail" in body || "error" in body) && !("data" in body)) {
    return `FXMacroData API error: ${String(body.detail ?? body.error)}`;
  }
  if (path.startsWith("/data_catalogue/")) {
    return undefined;
  }
  if (!Array.isArray(body.data)) {
    return "Unexpected response shape: expected an object with a 'data' list.";
  }
  if (!body.data.every((row) => typeof row === "object" && row !== null && !Array.isArray(row))) {
    return "Unexpected response shape: 'data' rows must be objects.";
  }
  return undefined;
}

/**
 * Calls a read-only FXMacroData REST endpoint and returns a tool-friendly result.
 *
 * Redirects are rejected rather than followed, so the key header is never sent to another
 * host, and the key is removed from any error text.
 */
export async function callFXMacroData(
  path: string,
  params: FXMacroDataQueryParams = {},
): Promise<FXMacroDataResult> {
  const { key: apiKey, error: keyError } = readApiKey();
  if (keyError) {
    return { success: false, error: keyError };
  }

  const url = new URL(`${FXMACRODATA_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FXMACRODATA_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers,
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      return {
        success: false,
        status: response.status,
        error: redact(
          `FXMacroData API returned HTTP ${response.status}: ${body || response.statusText}`,
          apiKey,
        ),
      };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { success: false, status: response.status, error: "FXMacroData returned non-JSON." };
    }

    const problem = shapeError(path, data);
    if (problem) {
      return { success: false, status: response.status, error: redact(problem, apiKey) };
    }

    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : "FXMacroData request failed.";
    return { success: false, error: redact(message, apiKey) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Lists the indicator slugs available for a currency.
 */
export const listIndicatorsTool = createTool({
  name: "listIndicators",
  description:
    "List the macroeconomic indicators available for a currency, with names, units and sources. Call this first when you do not know an indicator slug.",
  parameters: z.object({
    currency: currencySchema.describe('Three-letter currency code, such as "usd" or "eur".'),
  }),
  execute: async ({ currency }) => callFXMacroData(`/data_catalogue/${code(currency)}`),
});

/**
 * Fetches released values for one indicator, with release timestamps and source links.
 */
export const getIndicatorHistoryTool = createTool({
  name: "getIndicatorHistory",
  description:
    "Fetch released values for one indicator (for example inflation, policy_rate, gdp, unemployment) with the date each value refers to, when it was published, and the official source link.",
  parameters: z.object({
    currency: currencySchema.describe('Three-letter currency code, such as "usd".'),
    indicator: z
      .string()
      .min(1)
      .describe('Indicator slug from listIndicators, such as "inflation" or "policy_rate".'),
    startDate: dateSchema.describe("Optional start date, YYYY-MM-DD."),
    endDate: dateSchema.describe("Optional end date, YYYY-MM-DD."),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum rows to return."),
  }),
  execute: async ({ currency, indicator, startDate, endDate, limit = 12 }) =>
    callFXMacroData(
      `/announcements/${code(currency)}/${encodeURIComponent(indicator.trim().toLowerCase())}`,
      { start_date: startDate, end_date: endDate, limit },
    ),
});

/**
 * Fetches the upcoming release calendar for a currency.
 */
export const getReleaseCalendarTool = createTool({
  name: "getReleaseCalendar",
  description:
    "Fetch scheduled economic releases for a currency, with release times in UTC and the publisher's local time. Optionally filter to one indicator.",
  parameters: z.object({
    currency: currencySchema.describe('Three-letter currency code, such as "usd".'),
    indicator: z.string().optional().describe('Optional indicator slug, such as "inflation".'),
    startDate: dateSchema.describe("Optional start date, YYYY-MM-DD."),
    endDate: dateSchema.describe("Optional end date, YYYY-MM-DD."),
  }),
  execute: async ({ currency, indicator, startDate, endDate }) =>
    callFXMacroData(`/calendar/${code(currency)}`, {
      indicator: indicator?.trim().toLowerCase(),
      start_date: startDate,
      end_date: endDate,
    }),
});

/**
 * Fetches daily FX rates for a currency pair.
 */
export const getFxRatesTool = createTool({
  name: "getFxRates",
  description:
    "Fetch daily FX rates for a currency pair, such as EUR/USD. Requires an FXMacroData API key.",
  parameters: z.object({
    base: currencySchema.describe('Base currency, such as "eur".'),
    quote: currencySchema.describe('Quote currency, such as "usd".'),
    startDate: dateSchema.describe("Optional start date, YYYY-MM-DD."),
    endDate: dateSchema.describe("Optional end date, YYYY-MM-DD."),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum rows to return."),
  }),
  execute: async ({ base, quote, startDate, endDate, limit = 20 }) =>
    callFXMacroData(`/forex/${code(base)}/${code(quote)}`, {
      start_date: startDate,
      end_date: endDate,
      limit,
    }),
});

export const fxmacrodataTools = [
  listIndicatorsTool,
  getIndicatorHistoryTool,
  getReleaseCalendarTool,
  getFxRatesTool,
];
