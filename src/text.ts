const ESC = String.fromCharCode(27);
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${String.fromCharCode(7)}${ESC}]*(?:${String.fromCharCode(7)}|${ESC}\\\\)?`,
  "g",
);

/** One line with terminal escapes and control characters removed, safe to print. Pure. */
export function cleanLine(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(/\t/g, "  ")
    .replace(/\p{Cc}/gu, " ")
    .trimEnd();
}
