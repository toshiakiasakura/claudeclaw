import { createHash } from "crypto";

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

  return `[memsearch] Relevant memories:\n${text}`;
}
