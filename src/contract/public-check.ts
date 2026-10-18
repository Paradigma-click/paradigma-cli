import { z } from "zod";

/**
 * The fields of the public scan answer (`GET /api/tools/v1/<pillar>/<domain>`, JSON schema at
 * `/api/tools/v1/schema`) that `paradigma check` prints. Loose on purpose: the CLI shows what it
 * knows and passes the full JSON through with `--json`. The server's own schema
 * (src/lib/public-tools/report.ts) is tested against this one.
 */

export const CHECK_PILLARS = ["seo", "aeo", "geo", "agents"] as const;
export type CheckPillar = (typeof CHECK_PILLARS)[number];

const fixSchema = z.object({ copy: z.string(), prompt: z.string() }).loose();

export const publicCheckSchema = z
  .object({
    scoreContractVersion: z.string(),
    target: z.object({ host: z.string() }).loose(),
    pillars: z
      .array(
        z
          .object({
            pillar: z.enum(CHECK_PILLARS),
            score: z.number().nullable(),
            label: z.string().nullable(),
            pools: z
              .object({
                essential: z
                  .object({ earned: z.number(), max: z.number() })
                  .loose(),
                recommended: z
                  .object({ earned: z.number(), max: z.number() })
                  .loose(),
                bonus: z
                  .object({ earned: z.number(), cap: z.number() })
                  .loose(),
              })
              .loose(),
            cap: z
              .object({ at: z.number(), label: z.string() })
              .loose()
              .nullable(),
            counts: z
              .object({
                checks: z.number(),
                pass: z.number(),
                fail: z.number(),
                partial: z.number(),
                na: z.number(),
                suggestions: z.number(),
              })
              .loose(),
            fixFirst: z.array(
              z
                .object({
                  checkId: z.string(),
                  title: z.string(),
                  status: z.enum(["fail", "partial"]),
                  summary: z.string(),
                  fix: fixSchema.optional(),
                })
                .loose(),
            ),
            suggestions: z.array(
              z.object({ id: z.string(), status: z.string() }).loose(),
            ),
          })
          .loose(),
      )
      .min(1),
    teaser: z.array(
      z.object({ pillar: z.enum(CHECK_PILLARS), issues: z.number() }).loose(),
    ),
    tool: z.object({ name: z.string(), resultUrl: z.string() }).loose(),
    snapshot: z.object({ scannedAt: z.string(), cached: z.boolean() }).loose(),
  })
  .loose();
export type PublicCheck = z.infer<typeof publicCheckSchema>;

/**
 * The penalty risk checker's answer (`GET /api/tools/v1/risk/<domain>`): a private result for the
 * caller, never cached. Loose like the report above; the server's schema
 * (src/lib/public-tools/risk-result.ts) is tested against this one.
 */
export const RISK_LEVELS = ["none", "low", "elevated", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const publicRiskCheckSchema = z
  .object({
    kind: z.literal("penalty-risk"),
    target: z.object({ host: z.string() }).loose(),
    scannedAt: z.string(),
    level: z.enum(RISK_LEVELS),
    found: z.array(
      z
        .object({
          label: z.string(),
          level: z.enum(["low", "elevated", "high"]),
          channels: z.array(z.string()),
          documented: z.boolean(),
          policyUrl: z.string(),
          findings: z.array(
            z
              .object({
                evidence: z.string(),
                fix: z.string().nullable(),
                pages: z.array(z.string()),
              })
              .loose(),
          ),
        })
        .loose(),
    ),
    clean: z.array(z.object({ label: z.string() }).loose()),
    notChecked: z.array(z.object({ label: z.string() }).loose()),
    tool: z
      .object({
        signUpUrl: z.string(),
        manualActionsUrl: z.string(),
      })
      .loose(),
  })
  .loose();
export type PublicRiskCheck = z.infer<typeof publicRiskCheckSchema>;

export const publicCheckErrorSchema = z
  .object({
    ok: z.literal(false),
    error: z.string(),
    message: z.string(),
    retryAfterSeconds: z.number().optional(),
  })
  .loose();
