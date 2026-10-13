import type { Io } from "../io";

export type Call = {
  method: string;
  path: string;
  body: unknown;
  rawBody: string;
  authorization: string | null;
};

type Handler = (call: Call) => { status?: number; body: unknown } | undefined;

/** In-process fake of the Paradigma API: routes by "METHOD /path" prefix. */
export function fakeServer(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      body: rawBody ? JSON.parse(rawBody) : undefined,
      rawBody,
      authorization:
        (init?.headers as Record<string, string> | undefined)?.authorization ??
        null,
    };
    calls.push(call);
    const key = `${call.method} ${url.pathname}`;
    const handler = routes[key];
    const result = handler?.(call) ?? {
      status: 404,
      body: { error: "not_found", message: `No fake route for ${key}` },
    };
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

export function fakeIo(
  options: Partial<Io> & { stdin?: string; answers?: string[] } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  let clock = 0;
  const answers = [...(options.answers ?? [])];
  const io: Io = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: options.env ?? { ...process.env },
    cwd: options.cwd ?? process.cwd(),
    interactive: options.interactive ?? false,
    stdinIsTTY: options.stdinIsTTY ?? options.stdin === undefined,
    readStdin: async () => options.stdin ?? "",
    ask: async () => answers.shift() ?? "",
    askHidden: async () => answers.shift() ?? "",
    openUrl: (url) => opened.push(url),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    fetch: options.fetch,
  };
  return {
    io,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    opened,
    events: () =>
      out
        .join("")
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
