/**
 * AI answer engines Paradigma can sample on the customer's own provider
 * account. Shared by the server and the CLI; keep it dependency-free.
 */
export const GEO_SAMPLE_ENGINES = [
  "gemini",
  "openai",
  "claude",
  "perplexity",
  "google_ai_overview",
  "google_ai_mode",
] as const;
export type GeoSampleEngine = (typeof GEO_SAMPLE_ENGINES)[number];
