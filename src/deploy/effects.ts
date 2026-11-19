import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export interface CommandResult { code: number; stdout: string; stderr: string }
export interface CommandOptions { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number }

/** Everything deploy and doctor do outside this process and its files. Tests replace it. */
export interface Effects {
  /** Runs a program without a shell or a terminal. A program that cannot be started answers code 127. */
  run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  sleep(ms: number): Promise<void>;
}

/** Where a run happens: its effects, environment, home directory, the source checkout and where progress lines go. */
export interface Runtime {
  effects: Effects;
  env: Record<string, string | undefined>;
  home: string;
  /** The Mau checkout this code was built from. */
  root: string;
  nodeVersion: string;
  /** One line per finished step. */
  progress(line: string): void;
}

export const systemEffects: Effects = {
  run: (command, args, options = {}) => new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"],
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}) });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolve({ code: 127, stdout, stderr: stderr + String(error) }));
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  }),
  fetch: (url, init) => fetch(url, { signal: AbortSignal.timeout(60_000), ...init }),
  sleep: (ms) => delay(ms).then(() => undefined),
};

export const systemRuntime = (): Runtime => ({
  effects: systemEffects, env: process.env, home: homedir(), root: fileURLToPath(new URL("../../", import.meta.url)),
  nodeVersion: process.versions.node, progress: (line) => { process.stderr.write(line + "\n"); },
});
