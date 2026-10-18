/**
 * The fix guards live in the shared contract (`contract/guards.ts`) so the server's fix
 * harness enforces the same allowed paths, protected files, diff budget and secret patterns.
 */
export * from "./contract/guards";
