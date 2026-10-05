import { Agent, VoltAgent } from "@voltagent/core";
import { createPinoLogger } from "@voltagent/logger";
import { honoServer } from "@voltagent/server-hono";
import { fxmacrodataTools } from "./tools";

const logger = createPinoLogger({
  name: "fxmacrodata-agent",
  level: "info",
});

const macroResearchAgent = new Agent({
  name: "macro-research-agent",
  instructions: `You answer macroeconomic and FX questions with FXMacroData tools.

Use listIndicators when you need an indicator slug, getIndicatorHistory for released values,
getReleaseCalendar for what is scheduled next, and getFxRates for exchange rates.
Quote each value with the period it refers to and when it was published, and cite the source link.
If a tool returns HTTP 401 or 403, say that the currency or dataset needs an FXMacroData API key
rather than guessing a number.`,
  model: "openai/gpt-4o-mini",
  tools: fxmacrodataTools,
});

new VoltAgent({
  agents: {
    macroResearchAgent,
  },
  logger,
  server: honoServer(),
});
