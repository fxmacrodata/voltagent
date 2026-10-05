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
 * Calls a read-only FXMacroData REST endpoint and returns a tool-friendly result.
 *
 * FXMACRODATA_API_KEY is optional: USD releases, the USD calendar and the data
 * catalogue answer without a key. Other currencies and FX rates need one.
 */
export async function callFXMacroData(
  path: string,
  params: FXMacroDataQueryParams = {},
): Promise<FXMacroDataResult> {
  const url = new URL(`${FXMACRODATA_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = { accept: "application/json" };
  const apiKey = process.env.FXMACRODATA_API_KEY;
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FXMACRODATA_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { headers, method: "GET", signal: controller.signal });

    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      return {
        success: false,
        status: response.status,
        error: `FXMacroData API returned HTTP ${response.status}: ${body || response.statusText}`,
      };
    }

    return {
      success: true,
      data: await response.json(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "FXMacroData request failed.",
    };
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
