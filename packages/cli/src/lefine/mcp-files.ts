/**
 * lefine_upload_file and lefine_upload_folder: the model sends a local picture, video or PDF to a Content
 * project's media library. Only a local process can do this (the remote server cannot see your disk).
 *
 * Every read goes through mcp-paths.ts: inside the working folder (or --allow-dir), no links out, no key
 * folders, 8 MB, and a type from the name that the first bytes must agree with. The bytes then go to the
 * `content.media.upload` action as base64, which re-checks type and size on the server.
 */

import { lstatSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { LefineError } from "./client.js";
import { MEDIA_TYPES, PathError, mediaTypeOf, readInside, resolveInside, sniffMatches } from "./mcp-paths.js";
import { resolveContentProject } from "./mcp-project.js";
import { type LocalCtx, type ToolArgs, type ToolResult, cell, errResult, okResult, strArg } from "./mcp-result.js";
import { safeText } from "./safe-text.js";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_FOLDER_FILES = 50;
const MAX_WALK_ENTRIES = 5000;
const MAX_WALK_DEPTH = 6;
const CONCURRENCY = 4;

interface Uploaded {
  mediaId: string;
  url: string;
  width?: number;
  height?: number;
}

/** What the server answered, checked: a wrong shape is an error, not a half-empty success. */
function checkUploaded(data: unknown): Uploaded {
  const d = data as Partial<Uploaded> | null;
  if (!d || typeof d.mediaId !== "string" || typeof d.url !== "string") throw new Error("Lefine answered without a mediaId and url.");
  return { mediaId: d.mediaId, url: d.url, ...(typeof d.width === "number" ? { width: d.width } : {}), ...(typeof d.height === "number" ? { height: d.height } : {}) };
}

const why = (err: unknown): string => (err instanceof LefineError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err));

/** Reads, checks and uploads one file. Throws a PathError or LefineError with a sentence. */
async function uploadOne(ctx: LocalCtx, projectId: string, path: string, extra: { alt?: string; folder?: string }): Promise<Uploaded & { filename: string }> {
  const filename = basename(path);
  const contentType = mediaTypeOf(filename);
  if (!contentType) throw new PathError("BAD_TYPE", `${filename}: only ${Object.keys(MEDIA_TYPES).join(" ")} files go to the media library.`);
  const { bytes } = readInside(path, ctx.roots, ctx.cwd, MAX_UPLOAD_BYTES);
  if (!sniffMatches(contentType, bytes)) throw new PathError("BAD_TYPE", `${filename}: the content is not ${contentType}, so it is not sent.`);
  const data = await ctx.ops.callOp("content.media.upload", {
    projectId,
    filename,
    contentType,
    bytesBase64: bytes.toString("base64"),
    ...(extra.alt ? { alt: extra.alt } : {}),
    ...(extra.folder ? { folder: extra.folder } : {}),
  });
  return { ...checkUploaded(data), filename };
}

export async function uploadFile(ctx: LocalCtx, args: ToolArgs): Promise<ToolResult> {
  const path = strArg(args, "path");
  if (!path) return errResult("path is needed: the file to upload.");
  try {
    const projectId = await resolveContentProject(ctx.ops, strArg(args, "project"), ctx.cwd);
    const alt = strArg(args, "alt");
    if (alt && alt.length > 2000) return errResult("alt is over 2000 characters.");
    const up = await uploadOne(ctx, projectId, path, { alt, folder: strArg(args, "folder") });
    const size = up.width && up.height ? ` (${up.width}x${up.height})` : "";
    return okResult(`Uploaded ${safeText(up.filename)}${size}. mediaId ${up.mediaId}, url ${up.url}. Nothing uses it until a page points at it.`, { mediaId: up.mediaId, url: up.url, ...(up.width ? { width: up.width } : {}), ...(up.height ? { height: up.height } : {}) });
  } catch (err) {
    return errResult(safeText(why(err)));
  }
}

/** `*` one path part, `**` any depth, `?` one character, `{a,b}` either. The rest is literal. */
export function globToRegExp(pattern: string): RegExp {
  if (pattern.length > 200) throw new Error("pattern is over 200 characters.");
  let out = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") i++;
        out += "(?:.*/)?";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "{") {
      braces++;
      out += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      out += ")";
    } else if (c === "," && braces > 0) out += "|";
    else out += c.replace(/[.+^$()|[\]\\/-]/g, "\\$&");
  }
  if (braces > 0) throw new Error("pattern has an unclosed {.");
  return new RegExp(`^${out}$`, "i");
}

interface Walked {
  files: string[];
  links: number;
  truncated: boolean;
}

/** Files below `root` (real path), as paths relative to it, sorted. Links, dot folders and node_modules are not entered. */
function walk(root: string): Walked {
  const out: Walked = { files: [], links: 0, truncated: false };
  let seen = 0;
  const visit = (dir: string, depth: number) => {
    for (const name of readdirSync(dir).sort()) {
      if (++seen > MAX_WALK_ENTRIES) {
        out.truncated = true;
        return;
      }
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        out.links++;
        continue;
      }
      if (st.isDirectory()) {
        if (depth < MAX_WALK_DEPTH) visit(full, depth + 1);
      } else if (st.isFile()) out.files.push(relative(root, full).split(/[\\/]/).join("/"));
      if (out.truncated) return;
    }
  };
  visit(root, 0);
  return out;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await fn(items[at]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

export async function uploadFolder(ctx: LocalCtx, args: ToolArgs): Promise<ToolResult> {
  const path = strArg(args, "path");
  if (!path) return errResult("path is needed: the folder to upload from.");
  try {
    const root = resolveInside(path, ctx.roots, ctx.cwd);
    if (!statSync(root).isDirectory()) return errResult(`${safeText(path)} is not a folder. Use lefine_upload_file for one file.`);
    const projectId = await resolveContentProject(ctx.ops, strArg(args, "project"), ctx.cwd);
    // Top level only unless the pattern reaches into folders (`**/*.png`, `photos/*.jpg`).
    const pattern = strArg(args, "pattern") ?? "*";
    const re = globToRegExp(pattern);
    const skip = typeof args.skip === "number" && Number.isInteger(args.skip) && args.skip > 0 ? args.skip : 0;
    const walked = walk(root);
    const matching = walked.files.filter((f) => re.test(f) && mediaTypeOf(f) !== null);
    const batch = matching.slice(skip, skip + MAX_FOLDER_FILES);
    const remaining = Math.max(0, matching.length - skip - batch.length);
    if (batch.length === 0) return okResult(`No picture, video or PDF in ${safeText(path)} matches "${safeText(pattern)}"${skip ? ` after the first ${skip}` : ""}.`, { uploaded: 0, failed: 0, remaining: 0, rows: [] });

    type Row = { file: string; ok: boolean; mediaId?: string; url?: string; error?: string };
    const rows = await pool(batch, CONCURRENCY, async (rel): Promise<Row> => {
      try {
        const up = await uploadOne(ctx, projectId, join(root, rel), {});
        return { file: rel, ok: true, mediaId: up.mediaId, url: up.url };
      } catch (err) {
        return { file: rel, ok: false, error: safeText(why(err)) };
      }
    });
    const uploaded = rows.filter((r) => r.ok).length;
    const failed = rows.length - uploaded;
    const table = [
      "| file | result | mediaId | url |",
      "|---|---|---|---|",
      ...rows.map((r) => `| ${cell(safeText(r.file))} | ${r.ok ? "uploaded" : cell(r.error)} | ${r.mediaId ?? ""} | ${r.url ?? ""} |`),
    ].join("\n");
    const notes = [
      remaining > 0 ? `${remaining} more match. Call again with skip: ${skip + batch.length}.` : "",
      walked.links > 0 ? `${walked.links} link(s) were not followed.` : "",
      walked.truncated ? `The folder is large: only the first ${MAX_WALK_ENTRIES} entries were looked at.` : "",
    ].filter(Boolean);
    return {
      ...okResult(`Uploaded ${uploaded} of ${rows.length}${failed ? `, ${failed} failed` : ""}.\n\n${table}${notes.length ? `\n\n${notes.join(" ")}` : ""}`, { uploaded, failed, remaining, rows }),
      ...(failed === rows.length ? { isError: true } : {}),
    };
  } catch (err) {
    return errResult(safeText(why(err)));
  }
}
