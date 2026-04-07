import { createHash } from "crypto";
import { readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const SEARCH_TIMEOUT_MS = 5_000;
const SEARCH_TOP_K = 5;

async function detectMemsearchCmd(): Promise<string[] | null> {
  const whichMs = Bun.spawn(["which", "memsearch"], { stdout: "pipe", stderr: "pipe" });
  const msPath = (await new Response(whichMs.stdout).text()).trim();
  await whichMs.exited;
  if (whichMs.exitCode === 0 && msPath) return ["memsearch"];

  const whichUvx = Bun.spawn(["which", "uvx"], { stdout: "pipe", stderr: "pipe" });
  await whichUvx.exited;
  if (whichUvx.exitCode === 0) return ["uvx", "--from", "memsearch[onnx]", "memsearch"];

  return null;
}

async function resolveProjectDir(): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return proc.exitCode === 0 && out ? out : process.cwd();
}

function deriveCollectionName(projectDir: string): string {
  const basename = projectDir.split("/").pop() ?? "project";
  const sanitized = basename.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 8);
  return `ms_${sanitized}_${hash}`;
}

/**
 * Query memsearch for context relevant to the given prompt.
 * Returns a formatted string to inject into the system prompt, or null if
 * memsearch is unavailable, the collection has no results, or any error occurs.
 */
export async function queryMemsearch(prompt: string): Promise<string | null> {
  const cmd = await detectMemsearchCmd();
  if (!cmd) return null;

  const projectDir = await resolveProjectDir();
  const collection = deriveCollectionName(projectDir);

  // Truncate very long prompts — the search query just needs the semantic gist
  const query = prompt.slice(0, 500);

  const args = [...cmd, "search", query, "--top-k", String(SEARCH_TOP_K), "--collection", collection];

  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const env: Record<string, string> = {
    ...(cleanEnv as Record<string, string>),
    MEMSEARCH_NO_WATCH: "1",
  };

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env });

  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), SEARCH_TIMEOUT_MS));
  const output = await Promise.race([new Response(proc.stdout).text(), timeout]);

  if (output === null) {
    try { proc.kill(); } catch {}
    return null;
  }

  await proc.exited;

  const text = output.trim();
  if (proc.exitCode !== 0 || !text) return null;

  const MAX_MEMSEARCH_CHARS = 3000;
  const truncated = text.length > MAX_MEMSEARCH_CHARS
    ? text.slice(0, MAX_MEMSEARCH_CHARS) + "\n...[truncated]"
    : text;
  return `[memsearch] Relevant memories:\n${truncated}`;
}

const STOP_HOOK_TIMEOUT_MS = 120_000;

async function findMemsearchStopHook(): Promise<string | null> {
  const pluginDir = join(homedir(), ".claude/plugins/cache/memsearch-plugins/memsearch");
  try {
    const versions = await readdir(pluginDir);
    for (const v of versions.sort().reverse()) {
      const hookPath = join(pluginDir, v, "hooks", "stop.sh");
      if (existsSync(hookPath)) return hookPath;
    }
  } catch {}
  return null;
}

/**
 * Invoke the memsearch stop hook for a completed session so it can extract,
 * summarize, and index the conversation into memsearch memory.
 * Designed to be called fire-and-forget after a Discord response is sent.
 */
export async function invokeMemsearchStopHook(sessionId: string): Promise<void> {
  const hookPath = await findMemsearchStopHook();
  if (!hookPath) return;

  const transcriptPath = join(
    homedir(),
    ".claude/projects",
    process.cwd().replace(/[/.]/g, "-"),
    `${sessionId}.jsonl`
  );

  if (!existsSync(transcriptPath)) return;

  const input = JSON.stringify({ transcript_path: transcriptPath, stop_hook_active: false });

  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const proc = Bun.spawn(["bash", hookPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: cleanEnv as Record<string, string>,
  });

  proc.stdin.write(input);
  proc.stdin.end();

  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), STOP_HOOK_TIMEOUT_MS));
  const done = await Promise.race([proc.exited, timeout]);

  if (done === null) {
    try { proc.kill(); } catch {}
    console.warn("[memsearch] stop hook timed out");
  }
}
