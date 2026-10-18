import { z } from "zod";
import { taskBriefSchema } from "./contract/harness";

/**
 * Project tasks over `/api/cli/v1` (`paradigma tasks`): the shapes the
 * CLI reads, decoded tolerantly. Unknown fields are kept (so `--json` passes them through),
 * malformed optional fields become null and a task that cannot be read is dropped instead of
 * failing the whole list. The server's own zod schemas live in the shared contract once they land.
 */

export const TASK_STATUSES = [
  "queued",
  "needs_you",
  "running",
  "pr_opened",
  "merged",
  "live",
  "failed",
  "skipped",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses an agent can finish a started task with. */
export const FINISH_STATUSES = [
  "pr_opened",
  "done",
  "skipped",
  "failed",
] as const;
export type FinishStatus = (typeof FINISH_STATUSES)[number];

/** An optional string; anything malformed reads as null. */
export const text = z.string().nullish().catch(null);
const count = z.number().int().nonnegative().catch(0);

/** An array whose unreadable items are dropped. */
export function tolerantArray<T extends z.ZodType>(item: T) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((values) =>
      values.flatMap((value) => {
        const parsed = item.safeParse(value);
        return parsed.success ? [parsed.data as z.output<T>] : [];
      }),
    );
}

/** `owner/name`, or `{ owner, name }` / `{ fullName }` from servers that send an object. */
export const repoRef = z
  .union([
    z.string(),
    z.looseObject({
      owner: z.string().optional(),
      name: z.string().optional(),
      fullName: z.string().optional(),
    }),
  ])
  .nullish()
  .catch(null);
export type RepoRef = z.infer<typeof repoRef>;

/** `owner/name` of a repository reference, else null. */
export function repoLabel(repo: RepoRef): string | null {
  if (!repo) return null;
  if (typeof repo === "string") return repo || null;
  if (repo.fullName) return repo.fullName;
  return repo.owner && repo.name ? `${repo.owner}/${repo.name}` : null;
}

/** A setup step's extra fields (category `setup`); absent on other tasks and from older servers. */
export const taskSetupSchema = z
  .looseObject({
    key: z.string().catch(""),
    why: text,
    /** `agent` (a coding agent can do it) or `you` (needs the person). */
    who: text,
    command: text,
    /** Installs something a connection created: done first. */
    install: z.boolean().catch(false),
    done: z.boolean().catch(false),
    /** Another way the person can finish it (e.g. a one-click import in the provider's UI). */
    alternative: z
      .object({ text: z.string(), url: z.string() })
      .nullish()
      .catch(null),
  })
  .nullish()
  .catch(null);
export type TaskSetup = NonNullable<z.infer<typeof taskSetupSchema>>;

export const taskSummarySchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().catch("Untitled task"),
  category: text,
  risk: text,
  /** One of TASK_STATUSES; unknown statuses from newer servers are shown as they are. */
  status: z.string().catch("queued"),
  mode: text,
  plannedFor: text,
  prUrl: text,
  prNumber: z.number().int().positive().nullish().catch(null),
  findingUrl: text,
  startedBy: text,
  updatedAt: text,
  setup: taskSetupSchema,
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const taskProjectSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().catch(""),
  url: text,
  repo: repoRef,
  verified: z.boolean().nullish().catch(null),
  autopilot: z
    .looseObject({
      enabled: z.boolean().catch(false),
      level: z.number().int().nullish().catch(null),
    })
    .nullish()
    .catch(null),
});
export type TaskProject = z.infer<typeof taskProjectSchema>;

export const projectTasksSchema = z.looseObject({
  project: taskProjectSchema,
  counts: z
    .looseObject({
      queued: count,
      needsYou: count,
      running: count,
      open: count,
      done: count,
    })
    .catch({ queued: 0, needsYou: 0, running: 0, open: 0, done: 0 }),
  tasks: tolerantArray(taskSummarySchema),
});
export type ProjectTasks = z.infer<typeof projectTasksSchema>;

/** `GET /api/cli/v1/tasks?project=&status=open|all`. */
export const tasksResponseSchema = z.looseObject({
  projects: tolerantArray(projectTasksSchema),
});
export type TasksResponse = z.infer<typeof tasksResponseSchema>;

export const startedTaskSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string(),
  instructions: z.string().catch(""),
  acceptance: z.array(z.string()).catch([]),
  allowedPaths: z.array(z.string()).catch([]),
  diffBudget: z
    .looseObject({
      maxFiles: z.number().int().positive(),
      maxLines: z.number().int().positive(),
    })
    .nullish()
    .catch(null),
  category: text,
  risk: text,
  repo: z
    .looseObject({
      owner: z.string(),
      name: z.string(),
      defaultBranch: z.string().catch("main"),
      appRoot: z.string().catch(""),
    })
    .nullish()
    .catch(null),
  project: z
    .looseObject({ id: z.string(), name: z.string().catch(""), url: text })
    .nullish()
    .catch(null),
  findingUrl: text,
  branch: z.string().min(1),
  leaseExpiresAt: text,
  /** The task brief (playbook, acceptance ids, evidence); absent from older servers. */
  brief: taskBriefSchema.nullish().catch(null),
});
export type StartedTask = z.infer<typeof startedTaskSchema>;

/** `POST /api/cli/v1/tasks/<id>/start`. */
export const startTaskResponseSchema = z.looseObject({
  task: startedTaskSchema,
});
export type StartTaskResponse = z.infer<typeof startTaskResponseSchema>;

export type FinishTaskBody = {
  status: FinishStatus;
  prUrl?: string;
  reason?: string;
};

/** `POST /tasks/<id>/finish` and `/release`: whatever the server says, kept as it is. */
export const taskWriteResponseSchema = z.looseObject({});

/** `GET /api/cli/v1/projects/<id>/tasks/prompt`. */
export const tasksPromptResponseSchema = z.looseObject({
  prompt: z.string(),
});
