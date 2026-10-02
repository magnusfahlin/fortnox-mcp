import { createHash } from "crypto";
import { mkdir, open, readFile } from "fs/promises";
import { homedir } from "os";
import { basename, extname, join, resolve, sep } from "path";

/**
 * Optional on-disk download support for binary files (e.g. Inbox files).
 *
 * When FORTNOX_DOWNLOAD_DIR is set, tools save downloaded files there and
 * return the local path instead of the file content, which keeps large
 * base64 payloads out of the MCP response / model context.
 */

const MAX_FILENAME_LENGTH = 200;
const MAX_COLLISION_SUFFIX = 100;

export type SaveStatus = "saved" | "saved_renamed" | "already_exists";

export interface SavedFile {
  /** Absolute path of the file on disk */
  path: string;
  /** Filename actually used inside the download directory */
  filename: string;
  status: SaveStatus;
}

/**
 * Resolve the configured download directory, or undefined when the feature
 * is not enabled. A leading "~" is expanded to the home directory.
 *
 * Ignored in AUTH_MODE=remote: a shared server must not write files to its
 * own disk on behalf of remote users.
 */
export function getDownloadDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.AUTH_MODE === "remote") return undefined;

  const configured = env.FORTNOX_DOWNLOAD_DIR?.trim();
  if (!configured) return undefined;

  const expanded =
    configured === "~" || configured.startsWith("~/")
      ? join(homedir(), configured.slice(1))
      : configured;
  return resolve(expanded);
}

/**
 * Turn a remote-supplied filename into a safe single path component.
 * Strips any directory part (both / and \), control characters and
 * characters that are reserved on common filesystems, and never returns
 * "", "." or "..". Falls back to `fallback` when nothing usable remains.
 */
export function sanitizeFilename(name: string | undefined, fallback: string): string {
  const lastComponent = basename((name ?? "").replace(/\\/g, "/"));
  const cleaned = lastComponent
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();

  const limited = limitLength(cleaned);
  return limited.length > 0 ? limited : sanitizeFallback(fallback);
}

function sanitizeFallback(fallback: string): string {
  const cleaned = fallback.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return limitLength(cleaned) || "fortnox-file";
}

/** Shorten an over-long name but keep the extension. */
function limitLength(name: string): string {
  if (name.length <= MAX_FILENAME_LENGTH) return name;
  const ext = extname(name).slice(0, 20);
  return name.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
}

function withSuffix(filename: string, n: number): string {
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  return `${stem} (${n})${ext}`;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Write `data` as a new file in `dir`. Never overwrites: if a file with the
 * same name already exists and has identical content it is reused; if the
 * content differs, a numbered name ("name (1).pdf") is used instead.
 */
export async function saveDownloadedFile(
  dir: string,
  filename: string,
  data: Buffer
): Promise<SavedFile> {
  const root = resolve(dir);
  await mkdir(root, { recursive: true, mode: 0o700 });

  for (let n = 0; n <= MAX_COLLISION_SUFFIX; n++) {
    const candidate = n === 0 ? filename : withSuffix(filename, n);
    const target = resolve(root, candidate);
    if (!target.startsWith(root + sep)) {
      throw new Error(`Refusing to write outside the download directory: ${candidate}`);
    }

    try {
      // "wx" fails if the path exists (including as a symlink), so an
      // existing file is never overwritten or followed.
      const handle = await open(target, "wx", 0o600);
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
      return { path: target, filename: candidate, status: n === 0 ? "saved" : "saved_renamed" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await hasSameContent(target, data)) {
        return { path: target, filename: candidate, status: "already_exists" };
      }
    }
  }

  throw new Error(`Could not find a free filename for "${filename}" in ${root}`);
}

async function hasSameContent(path: string, data: Buffer): Promise<boolean> {
  try {
    const existing = await readFile(path);
    return existing.length === data.length && sha256(existing) === sha256(data);
  } catch {
    return false;
  }
}
