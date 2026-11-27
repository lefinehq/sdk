/**
 * Which local files the MCP server may read for the model.
 *
 * The model chooses the path, and the model reads text from web pages, tickets and files: a path is
 * untrusted input. A file is read only when its real path (links followed) is inside the folder the
 * server was started in, or inside a folder the person named with --allow-dir. Checked here, not by the
 * caller, so no tool can forget it.
 *
 * Stated limits: the check and the read are two steps. The read opens the real path with O_NOFOLLOW and
 * measures the open file, so a link swapped in after the check is refused, but a folder renamed between
 * the two steps could still redirect the open. Someone who can do that already has this account's files.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type PathErrorCode = "NOT_FOUND" | "OUTSIDE" | "SYMLINK" | "DENIED" | "NOT_FILE" | "TOO_BIG" | "BAD_TYPE" | "BAD_PATH";

export class PathError extends Error {
  constructor(
    readonly code: PathErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PathError";
  }
}

/** Folders that hold keys and history, never content. Refused even inside an allowed folder. Compared in lower case. */
const DENIED_SEGMENTS = new Set([".git", ".ssh", ".aws", ".gnupg", ".lefine", ".config", ".kube", ".docker", "node_modules"]);
/** Files that hold secrets, by name, any case: .env*, key and certificate files, credential stores, shell history. */
const DENIED_NAME =
  /^(\.env.*|\.git-credentials|\.pgpass|\.netrc|\.npmrc|\.pypirc|\.htpasswd|id_(rsa|ed25519|ecdsa|dsa).*|credentials(\.json)?|\.[a-z0-9]*_history|.*\.(pem|key|p12|pfx))$/i;

/** The real path with the case the disk has (realpath.native): `.SSH` on a case-insensitive disk is `.ssh`. */
const onDisk = (p: string): string => realpathSync.native(p);

/** True when `child` is `root` or below it. Compares path segments, so /a/bc is not inside /a/b. */
export function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const lower = (p: string) => p.toLowerCase();

export interface RootOptions {
  /** The home directory (test seam). Default: the account's. */
  home?: string;
  /** Called with one line when a root is left out. */
  warn?: (line: string) => void;
}

/** Folders in the home directory that are never a root, nor above one. */
const homeDenied = (home: string): string[] => [".ssh", ".aws", ".gnupg", ".lefine", ".config", ".kube", ".docker", ".git-credentials", ".netrc", ".npmrc", ".pgpass", ".pypirc"].map((n) => join(home, n));

/**
 * Why `root` may not be served, or null. It is judged as a whole, not only the part below it: `/`, the home
 * directory and its parents (/Users, /home) hold everything, and a denied folder (~/.ssh) or one inside it is no
 * place for a root either.
 */
export function rootProblem(root: string, home: string): string | null {
  const r = lower(root);
  const h = lower(home);
  if (r === lower(resolve("/")) || isInside(r, h)) return r === h ? "it is your home directory" : "it holds your home directory";
  if (homeDenied(h).some((d) => isInside(d, r) || isInside(r, d))) return "it is or contains a folder of keys or settings (~/.ssh, ~/.aws, ...)";
  const parts = r.split(sep).filter(Boolean);
  if (parts.some((p) => DENIED_SEGMENTS.has(p) && p !== ".config" && p !== "node_modules")) return "it is inside a folder of keys or history";
  if (DENIED_NAME.test(parts[parts.length - 1] ?? "")) return "it is named like a secrets file";
  return null;
}

/**
 * The folders files may be read from, as real paths: the working folder first, then each --allow-dir.
 * The working folder is left out (with a warning) when it is /, the home directory or a parent of it; an
 * --allow-dir that broad, or a denied folder, throws. With no root left, local file tools read nothing.
 */
export function allowedRoots(cwd: string, allowDirs: string[] = [], opts: RootOptions = {}): string[] {
  const home = (() => {
    try {
      return onDisk(opts.home ?? homedir());
    } catch {
      return opts.home ?? homedir();
    }
  })();
  const roots: string[] = [];
  const add = (dir: string, explicit: boolean) => {
    let real: string;
    try {
      real = onDisk(resolve(cwd, dir));
    } catch {
      throw new PathError("NOT_FOUND", `--allow-dir ${dir} does not exist.`);
    }
    const bad = rootProblem(real, home);
    if (bad) {
      if (explicit) throw new PathError("DENIED", `--allow-dir ${dir} is refused: ${bad}. Name a project folder.`);
      opts.warn?.(`lefine-mcp: local file tools are off: the folder this server runs in (${real}) is refused, ${bad}. Start it in a project folder, or pass --allow-dir <project folder>.`);
      return;
    }
    if (!roots.includes(real)) roots.push(real);
  };
  add(cwd, false);
  for (const dir of allowDirs) add(dir, true);
  return roots;
}

/** Judged on the part below the allowed folder: a project that lives under ~/.config is still a project. */
function denied(below: string): string | null {
  const parts = below.split(sep).filter(Boolean);
  const hit = parts.find((p) => DENIED_SEGMENTS.has(lower(p)));
  if (hit) return hit;
  const last = parts[parts.length - 1] ?? "";
  return DENIED_NAME.test(last) ? last : null;
}

/** The real path of `input`, or a PathError that says why not. A relative path means relative to `cwd`. */
export function resolveInside(input: string, roots: string[], cwd: string): string {
  if (typeof input !== "string" || input.trim() === "" || input.includes("\0")) throw new PathError("BAD_PATH", "The path is empty or not a path.");
  const abs = resolve(cwd, input);
  if (roots.length === 0) throw new PathError("OUTSIDE", "Local file tools are off: no folder is allowed. Start the server in a project folder, or pass --allow-dir <project folder>.");
  let real: string;
  try {
    lstatSync(abs);
    real = onDisk(abs);
  } catch {
    throw new PathError("NOT_FOUND", `Not found: ${input}.`);
  }
  const root = roots.find((r) => isInside(r, real));
  if (!root) {
    // Inside by name but outside by its real path: a link leads out of the folder.
    const byName = roots.some((r) => isInside(r, abs));
    throw byName
      ? new PathError("SYMLINK", `${input} is a link that leads outside the allowed folders. Linked files are refused.`)
      : new PathError("OUTSIDE", `${input} is outside the folder this server runs in. Start it there, or pass --allow-dir <folder>.`);
  }
  const bad = denied(relative(root, real));
  if (bad) throw new PathError("DENIED", `${input} is in or named "${bad}", which holds keys or history. It is never read.`);
  return real;
}

/** A file's bytes. Refuses a folder, a link at the last step, and anything over `maxBytes` before it reads. */
export function readInside(input: string, roots: string[], cwd: string, maxBytes: number): { real: string; bytes: Buffer } {
  const real = resolveInside(input, roots, cwd);
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new PathError("SYMLINK", `${input} could not be opened as a plain file.`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new PathError("NOT_FILE", `${input} is not a file.`);
    if (st.size > maxBytes) throw new PathError("TOO_BIG", `${input} is ${(st.size / 1_048_576).toFixed(1)} MB; the limit is ${(maxBytes / 1_048_576).toFixed(0)} MB.`);
    const bytes = Buffer.alloc(st.size);
    let at = 0;
    while (at < st.size) {
      const n = readSync(fd, bytes, at, st.size - at, at);
      if (n === 0) break;
      at += n;
    }
    return { real, bytes: at === st.size ? bytes : bytes.subarray(0, at) };
  } finally {
    closeSync(fd);
  }
}

/** The kind of file for the media library, from the name; the bytes must agree (sniffMatches). */
export const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
};

export function mediaTypeOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : (MEDIA_TYPES[name.slice(dot).toLowerCase()] ?? null);
}

const startsWith = (bytes: Buffer, ...sig: number[]) => sig.every((b, i) => bytes[i] === b);

/** Do the first bytes say what the name says? A renamed .env must not pass as a picture. */
export function sniffMatches(contentType: string, bytes: Buffer): boolean {
  switch (contentType) {
    case "image/png":
      return startsWith(bytes, 0x89, 0x50, 0x4e, 0x47);
    case "image/jpeg":
      return startsWith(bytes, 0xff, 0xd8, 0xff);
    case "image/gif":
      return startsWith(bytes, 0x47, 0x49, 0x46, 0x38);
    case "image/webp":
      return startsWith(bytes, 0x52, 0x49, 0x46, 0x46) && bytes.subarray(8, 12).toString("latin1") === "WEBP";
    case "image/avif":
      return bytes.subarray(4, 8).toString("latin1") === "ftyp" && /avif|avis/.test(bytes.subarray(8, 16).toString("latin1"));
    case "video/mp4":
      return bytes.subarray(4, 8).toString("latin1") === "ftyp";
    case "application/pdf":
      return bytes.subarray(0, 1024).toString("latin1").includes("%PDF-");
    default:
      return false;
  }
}
