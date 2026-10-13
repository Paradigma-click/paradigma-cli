import { existsSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { ensurePrivateDir, homePath } from "./config";
import { run, runOk } from "./exec";

export const LAUNCHD_LABEL = "com.paradigma.autopilot";
export const SYSTEMD_UNIT = "paradigma-autopilot";
export const WINDOWS_TASK = "ParadigmaAutopilot";

export type ScheduleSpec = {
  hour: number;
  minute: number;
  /** Absolute program + args, e.g. [node, /path/paradigma.mjs, run, --scheduled]. */
  programArgs: string[];
  logDir: string;
  path: string;
  home: string;
};

function xml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function launchdPlist(spec: ScheduleSpec): string {
  const args = spec.programArgs
    .map((arg) => `    <string>${xml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${spec.hour}</integer>
    <key>Minute</key>
    <integer>${spec.minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(spec.path)}</string>
    <key>HOME</key>
    <string>${xml(spec.home)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(join(spec.logDir, "autopilot.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(spec.logDir, "autopilot.err.log"))}</string>
</dict>
</plist>
`;
}

function systemdQuote(arg: string) {
  return /^[A-Za-z0-9_@+=:,./-]+$/.test(arg)
    ? arg
    : `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

export function systemdService(spec: ScheduleSpec): string {
  return `[Unit]
Description=Paradigma Autopilot daily run

[Service]
Type=oneshot
ExecStart=${spec.programArgs.map(systemdQuote).join(" ")}
Environment=${systemdQuote(`PATH=${spec.path}`)}
StandardOutput=append:${join(spec.logDir, "autopilot.log")}
StandardError=append:${join(spec.logDir, "autopilot.err.log")}
`;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function systemdTimer(spec: ScheduleSpec): string {
  return `[Unit]
Description=Run Paradigma Autopilot daily

[Timer]
OnCalendar=*-*-* ${pad(spec.hour)}:${pad(spec.minute)}:00
Persistent=true
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
`;
}

function windowsQuote(arg: string) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

export function schtasksArgs(spec: ScheduleSpec): string[] {
  return [
    "/Create",
    "/F",
    "/SC",
    "DAILY",
    "/ST",
    `${pad(spec.hour)}:${pad(spec.minute)}`,
    "/TN",
    WINDOWS_TASK,
    "/TR",
    spec.programArgs.map(windowsQuote).join(" "),
  ];
}

/** Spreads runners over the hour so they do not all claim at :00. */
export function minuteFor(runnerId: string | undefined): number {
  if (!runnerId) return 7;
  let hash = 0;
  for (const char of runnerId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 60;
}

/**
 * Whether a scheduled invocation should run now: the last success happened
 * before the most recent scheduled time (covers machines that were off).
 */
export function isRunDue(
  now: Date,
  lastSuccessAt: string | undefined,
  hour: number,
  minute: number,
): boolean {
  const today = new Date(now);
  today.setHours(hour, minute, 0, 0);
  const mostRecent =
    now.getTime() >= today.getTime()
      ? today
      : new Date(today.getTime() - 24 * 3_600_000);
  if (!lastSuccessAt) return true;
  const last = Date.parse(lastSuccessAt);
  return Number.isNaN(last) || last < mostRecent.getTime();
}

export function currentProgramArgs(): string[] {
  const script = process.argv[1] ? realpathSync(process.argv[1]) : "paradigma";
  return [process.execPath, script, "run", "--scheduled"];
}

export function dedupePath(path: string, separator = delimiter): string {
  return [...new Set(path.split(separator).filter(Boolean))].join(separator);
}

export function scheduleSpec(hour: number, minute: number): ScheduleSpec {
  return {
    hour,
    minute,
    programArgs: currentProgramArgs(),
    logDir: homePath("logs"),
    path: dedupePath(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"),
    home: homedir(),
  };
}

export function launchdPath() {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function systemdDir() {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "systemd",
    "user",
  );
}

export function describeSchedule(spec: ScheduleSpec): string {
  switch (process.platform) {
    case "darwin":
      return `# ${launchdPath()}\n${launchdPlist(spec)}`;
    case "win32":
      return `schtasks ${schtasksArgs(spec).map(windowsQuote).join(" ")}`;
    default:
      return `# ${join(systemdDir(), `${SYSTEMD_UNIT}.service`)}\n${systemdService(spec)}\n# ${join(systemdDir(), `${SYSTEMD_UNIT}.timer`)}\n${systemdTimer(spec)}`;
  }
}

export function isScheduleInstalled(): boolean {
  if (process.platform === "darwin") return existsSync(launchdPath());
  if (process.platform === "win32") return false;
  return existsSync(join(systemdDir(), `${SYSTEMD_UNIT}.timer`));
}

export async function installSchedule(spec: ScheduleSpec) {
  ensurePrivateDir(spec.logDir);
  if (process.platform === "darwin") {
    const file = launchdPath();
    await mkdir(join(homedir(), "Library", "LaunchAgents"), {
      recursive: true,
    });
    const uid = process.getuid?.() ?? 0;
    await run("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
    await writeFile(file, launchdPlist(spec), { mode: 0o644 });
    await runOk("launchctl", ["bootstrap", `gui/${uid}`, file]);
    return file;
  }
  if (process.platform === "win32") {
    await runOk("schtasks", schtasksArgs(spec));
    return WINDOWS_TASK;
  }
  const dir = systemdDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${SYSTEMD_UNIT}.service`), systemdService(spec));
  await writeFile(join(dir, `${SYSTEMD_UNIT}.timer`), systemdTimer(spec));
  await runOk("systemctl", ["--user", "daemon-reload"]);
  await runOk("systemctl", [
    "--user",
    "enable",
    "--now",
    `${SYSTEMD_UNIT}.timer`,
  ]);
  return join(dir, `${SYSTEMD_UNIT}.timer`);
}

export async function uninstallSchedule() {
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 0;
    await run("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
    await rm(launchdPath(), { force: true });
    return;
  }
  if (process.platform === "win32") {
    await run("schtasks", ["/Delete", "/F", "/TN", WINDOWS_TASK]);
    return;
  }
  await run("systemctl", [
    "--user",
    "disable",
    "--now",
    `${SYSTEMD_UNIT}.timer`,
  ]);
  await rm(join(systemdDir(), `${SYSTEMD_UNIT}.timer`), { force: true });
  await rm(join(systemdDir(), `${SYSTEMD_UNIT}.service`), { force: true });
  await run("systemctl", ["--user", "daemon-reload"]);
}
