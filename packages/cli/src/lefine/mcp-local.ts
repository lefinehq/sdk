/**
 * The tools this package adds to the server's own: the ones only a local process can do (it can read your
 * disk), plus the two coding tools (find a key before adding one). Definitions, filtering and dispatch.
 */

import { LefineError } from "./client.js";
import { type McpOptions } from "./mcp-config.js";
import { uploadFile, uploadFolder } from "./mcp-files.js";
import { importLocaleFiles } from "./mcp-locale.js";
import { readProjectInfo } from "./mcp-project.js";
import { type LocalCtx, type ToolArgs, type ToolResult, errResult, okResult } from "./mcp-result.js";
import { LOCAL_TOOLS as CODING_TOOLS, addKey, findSimilar } from "./mcp-tools.js";
import { safeText } from "./safe-text.js";

export interface LocalToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

interface LocalTool {
  def: LocalToolDef;
  /** Writes to Lefine: hidden under --read-only. */
  write: boolean;
  /** The module it belongs to (--toolsets); null: always shown. */
  toolset: string | null;
  run: (ctx: LocalCtx, args: ToolArgs) => Promise<ToolResult>;
}

const ann = (title: string, readOnly: boolean) => ({ title, readOnlyHint: readOnly, destructiveHint: false, idempotentHint: false, openWorldHint: false });

const coding = (name: string) => CODING_TOOLS.find((t) => t.name === name)! as unknown as Omit<LocalToolDef, "annotations">;

const TOOLS: LocalTool[] = [
  {
    def: {
      name: "lefine_project",
      description:
        "Which Lefine app and Content project this folder belongs to, read from lefine.ts and lefine.config.* here (read as text, never run). " +
        "Call it first in a code project, so you do not ask the person for ids. Also lists the folders local tools may read.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: ann("Project of this folder", true),
    },
    write: false,
    toolset: null,
    run: async (ctx) => {
      const info = readProjectInfo(ctx.cwd);
      const found = Boolean(info.appId || info.contentProject);
      const lines = [
        info.appId ? `Strings app: ${info.appId} (${info.appFile}).${info.locales ? ` Languages: ${info.locales.join(", ")}.` : ""}` : "No Strings app: no lefine.ts with a project id here. `npx lefine init` writes one.",
        info.contentFile ? `Content config: ${info.contentFile}${info.contentProject ? `, project ${safeText(info.contentProject)}` : ", it names no project"}.${info.contentTypes ? ` Types: ${info.contentTypes.map(safeText).join(", ")}.` : ""}` : "No lefine.config.* here.",
        `Local tools may read: ${ctx.roots.join(", ")}.`,
      ];
      return okResult(lines.join("\n"), { found, ...info, allowedFolders: ctx.roots });
    },
  },
  {
    def: {
      name: "lefine_upload_file",
      description:
        "Upload ONE local picture, video (mp4) or PDF to a Content project's media library. path is inside the folder this server runs in (or an allowed folder); 8 MB at most; the file's type must match its name. " +
        "project is a name, slug or id (left out: the one in lefine.config.*, or the workspace's only project). Answers mediaId and url. Nothing uses the file until a page points at it. For many files use lefine_upload_folder.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File to upload, e.g. public/hero.png." },
          project: { type: "string", description: "Content project name, slug or id (prj_...)." },
          alt: { type: "string", description: "Alt text in the project's main language." },
          folder: { type: "string", description: "Library folder. The library has no folders yet: the server refuses a name." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: ann("Upload a file", false),
    },
    write: true,
    toolset: "content",
    run: uploadFile,
  },
  {
    def: {
      name: "lefine_upload_folder",
      description:
        "Upload the pictures, videos and PDFs in a local folder to a Content project's media library: up to 50 per call, 4 at a time. Answers a table (file, result, mediaId, url). " +
        "pattern picks files, relative to the folder: default * (top level only), **/*.png goes into folders. If more match, the answer says which skip to call again with.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Folder to upload from." },
          project: { type: "string", description: "Content project name, slug or id (prj_...)." },
          pattern: { type: "string", description: "Glob: * ** ? {a,b}. Default *." },
          skip: { type: "integer", minimum: 0, description: "Skip the first N matches (for the next batch)." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: ann("Upload a folder", false),
    },
    write: true,
    toolset: "content",
    run: uploadFolder,
  },
  {
    def: {
      name: "lefine_import_locale_files",
      description:
        "Push local translation files (JSON, YAML, Android XML, XLIFF, .properties, .po) into a Strings app, in two steps. " +
        "FIRST call with dryRun left out: nothing is written; you get counts per file and a plan id. Show the person the counts. " +
        "THEN call again with dryRun: false: it is a normal Lefine write, so the server may ask a person to approve it first (then it says where). Source-language texts are saved approved and other languages as reviewed; a publish is separate. Only locale file types are read (.json .arb .yaml .yml .xml .xlf .xliff .properties .po). " +
        "Files: de.json = { namespace: { key: text } }, or de/common.yaml, or common.yaml (source language; pass locale for another).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "A locale file, or a folder of them (3 levels deep, 200 files, 20 MB)." },
          app: { type: "string", description: "Strings app name, slug or id (app_...). Left out: the one in lefine.ts." },
          format: { type: "string", enum: ["json", "yaml", "xml", "xliff", "properties", "po"], description: "How to parse the file. It never widens which files are read: the extension must be a locale type." },
          locale: { type: "string", description: "Language of files that do not say (default: the app's source language)." },
          namespace: { type: "string", description: "Namespace for a file named for its language." },
          dryRun: { type: "boolean", description: "Default true. false writes (through the server, which may ask a person first)." },
          confirmPlan: { type: "string", description: "Optional: the plan id the dry run gave; a stale one stops the import. It is not an approval." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: ann("Import locale files", false),
    },
    write: true,
    toolset: "strings",
    run: importLocaleFiles,
  },
  {
    def: { ...coding("lefine_find_similar_key"), annotations: ann("Find a similar key", true) },
    write: false,
    toolset: "strings",
    run: (ctx, args) => findSimilar(ctx.ops, args) as Promise<ToolResult>,
  },
  {
    def: { ...coding("lefine_add_key"), annotations: ann("Add one key", false) },
    write: true,
    toolset: "strings",
    run: (ctx, args) => addKey(ctx.ops, args, ctx.write) as Promise<ToolResult>,
  },
];

const visible = (t: LocalTool, options: McpOptions) => !(options.readOnly && t.write) && !(options.toolsets && t.toolset && !options.toolsets.has(t.toolset));

/** The local tool definitions the model may see under these options. */
export function localToolDefs(options: McpOptions): LocalToolDef[] {
  return TOOLS.filter((t) => visible(t, options)).map((t) => t.def);
}

export const isLocalTool = (name: unknown): boolean => TOOLS.some((t) => t.def.name === name);

/** Runs a local tool. Null for a name that is not local; an error result when the options turn it off. */
export async function callLocal(name: string, args: ToolArgs, ctx: LocalCtx, options: McpOptions): Promise<ToolResult | null> {
  const tool = TOOLS.find((t) => t.def.name === name);
  if (!tool) return null;
  if (!visible(tool, options)) return errResult(options.readOnly && tool.write ? `${name} is turned off: this server runs with --read-only.` : `${name} is turned off by --toolsets.`);
  try {
    return await tool.run(ctx, args);
  } catch (err) {
    return errResult(`Lefine refused: ${safeText(err instanceof LefineError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err))}`);
  }
}
