import { createHash } from "crypto";
import { constants } from "fs";
import { open, realpath } from "fs/promises";
import { homedir } from "os";
import { basename, isAbsolute, join, relative, resolve } from "path";

/**
 * Optional support for uploading local files by path (e.g. receipts on disk).
 *
 * When FORTNOX_UPLOAD_ROOT is set, tools may read files from that directory
 * tree instead of receiving the content base64-encoded in the tool call.
 * Paths are resolved through symlinks and anything outside the root is
 * rejected.
 */

export interface LocalUploadFile {
  /** Real (symlink-resolved) absolute path of the file that was read */
  path: string;
  /** Basename of the requested path */
  filename: string;
  data: Buffer;
  sha256: string;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/**
 * Resolve the configured upload root, or undefined when the feature is not
 * enabled. A leading "~" is expanded to the home directory.
 *
 * Ignored in AUTH_MODE=remote: a shared server must not read files from its
 * own disk on behalf of remote users.
 */
export function getUploadRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.AUTH_MODE === "remote") return undefined;

  const configured = env.FORTNOX_UPLOAD_ROOT?.trim();
  if (!configured) return undefined;

  return resolve(expandHome(configured));
}

/** True if `path` is strictly inside `root` (both absolute, normalized). */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Read a file for upload, allowing only regular files inside `root`.
 *
 * `filePath` may be absolute, start with "~", or be relative to `root`.
 * Both the requested path and its symlink-resolved real path must lie inside
 * the root, so a symlink inside the root cannot point outside it.
 */
export async function readUploadFile(
  root: string,
  filePath: string,
  maxBytes: number
): Promise<LocalUploadFile> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new Error(`Upload root does not exist: ${root}`);
  }

  const requested = resolve(root, expandHome(filePath));
  // Check the path as given before touching the filesystem, so the error
  // for paths outside the root does not reveal whether such files exist.
  if (!isInside(root, requested) && !isInside(realRoot, requested)) {
    throw new Error(`File path is outside the allowed upload root (${root}): ${filePath}`);
  }

  let realFile: string;
  try {
    realFile = await realpath(requested);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`File not found: ${filePath}`);
    }
    throw error;
  }

  if (!isInside(realRoot, realFile)) {
    throw new Error(`File path resolves outside the allowed upload root (${root}): ${filePath}`);
  }

  // O_NOFOLLOW: realFile is already fully resolved, so a symlink appearing
  // there now means the file was swapped after the check above.
  const handle = await open(realFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`Not a regular file: ${filePath}`);
    }
    if (stats.size === 0) {
      throw new Error(`File is empty: ${filePath}`);
    }
    if (stats.size > maxBytes) {
      throw new Error(
        `File is too large (${stats.size} bytes, limit ${maxBytes} bytes): ${filePath}`
      );
    }

    const data = await handle.readFile();
    if (data.length > maxBytes) {
      throw new Error(`File is too large (limit ${maxBytes} bytes): ${filePath}`);
    }

    return { path: realFile, filename: basename(requested), data, sha256: sha256Hex(data) };
  } finally {
    await handle.close();
  }
}
