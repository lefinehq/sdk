/**
 * `lefine content types`: writes a TypeScript file with one interface per
 * content type of a Lefine Content project, a `LefineContent` map for
 * `lefine/content`, and the project's ids and languages.
 *
 * The field shapes are Lefine's (Payload-style: `text`, `richText`, `group`,
 * `tabs`, `blocks`, ...),
 * read through `content.collections.get`. The types describe a page as the
 * edge serves it: one language, fallback applied, every field present
 * (`null` when empty). The older `better-i18n content:types`
 * (`commands/content-types.ts`) reads Better i18n's models and stays as is.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fail, out, type GlobalOptions } from "./auth-commands.js";
import { LefineError, createOpClient, getMe, type OpClient } from "./client.js";
import { resolveLefineAuth } from "./credentials.js";
import { safeText } from "./safe-text.js";

export interface ContentField {
  type: string;
  name?: string;
  label?: string;
  required?: boolean;
  localized?: boolean;
  hasMany?: boolean;
  relationTo?: string;
  options?: Array<string | { label: string; value: string }>;
  fields?: ContentField[];
  tabs?: Array<{ name?: string; label?: string; fields: ContentField[] }>;
  blocks?: Array<{ slug: string; fields: ContentField[] }>;
}

export interface ContentProject {
  id: string;
  slug?: string;
  name?: string;
  sourceLocale: string;
  targetLocales: string[];
  fallbackLocale: string | null;
}

export interface ContentTypeModel {
  slug: string;
  labels?: { singular: string; plural: string };
  fields: ContentField[];
}

export interface ContentTypesInput {
  workspaceId: string;
  project: ContentProject;
  collections: ContentTypeModel[];
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (name: string) =>
  IDENTIFIER.test(name) ? name : JSON.stringify(name);
const comment = (text: string | undefined, pad: string) =>
  text
    ? `${pad}/** ${text.replace(/\*\//g, "*\\/").replace(/\s+/g, " ").trim()} */\n`
    : "";

/**
 * Server text inside a `//` line comment: printable ASCII only. A line break (including U+2028/U+2029, which JSON.stringify keeps)
 * would end the comment and turn the rest of a project name into code in the user's repo.
 */
const oneLine = (text: string) =>
  JSON.stringify(text.replace(/[^\x20-\x7E]/g, "?"));

/** "blog-posts" -> "BlogPosts". */
export function typeName(slug: string): string {
  const name = slug
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return /^[A-Za-z]/.test(name) ? name : `Type${name}`;
}

const optionValue = (o: string | { value: string }) =>
  typeof o === "string" ? o : o.value;

/** The value's type, without `| null`. */
function valueType(field: ContentField, pad: string): string {
  const many = (t: string) => (field.hasMany ? `Array<${t}>` : t);
  switch (field.type) {
    case "text":
      return many("string");
    case "textarea":
    case "email":
    case "date":
      return "string";
    case "number":
      return many("number");
    case "checkbox":
      return "boolean";
    case "select":
    case "radio": {
      const values = (field.options ?? []).map((o) =>
        JSON.stringify(optionValue(o)),
      );
      const union = values.length > 0 ? values.join(" | ") : "string";
      return field.type === "select" && field.hasMany
        ? `Array<${union}>`
        : union;
    }
    case "richText":
      return "LefineRichText";
    case "relationship":
    case "upload":
      return many("string");
    case "json":
      return "unknown";
    case "group":
      return objectType(field.fields ?? [], pad);
    case "array":
      return `Array<${objectType(field.fields ?? [], pad, ["id?: string;"])}>`;
    case "blocks": {
      const rows = (field.blocks ?? []).map((b) =>
        objectType(b.fields, pad, [
          "id?: string;",
          `blockType: ${JSON.stringify(b.slug)};`,
        ]),
      );
      return rows.length > 0 ? `Array<${rows.join(" | ")}>` : "Array<never>";
    }
    default:
      return "unknown";
  }
}

/** `{ ... }` for one level of fields. Tabs without a name and groups without a name add no key: their fields sit here. */
function objectType(
  fields: readonly ContentField[],
  pad: string,
  head: string[] = [],
): string {
  const inner = `${pad}  `;
  const lines = head.map((h) => `${inner}${h}\n`);
  lines.push(...members(fields, inner));
  return lines.length === 0
    ? "Record<string, never>"
    : `{\n${lines.join("")}${pad}}`;
}

function members(fields: readonly ContentField[], pad: string): string[] {
  const lines: string[] = [];
  for (const field of fields) {
    if (field.type === "tabs") {
      for (const tab of field.tabs ?? []) {
        if (tab.name)
          lines.push(
            `${comment(tab.label, pad)}${pad}${key(tab.name)}: ${objectType(tab.fields, pad)};\n`,
          );
        else lines.push(...members(tab.fields, pad));
      }
      continue;
    }
    if (!field.name) {
      if (field.type === "group")
        lines.push(...members(field.fields ?? [], pad));
      continue;
    }
    const type = valueType(field, pad);
    const nullable =
      field.required || type === "unknown" ? type : `${type} | null`;
    const doc = [
      field.label,
      field.type === "relationship" && field.relationTo
        ? `Page id in "${field.relationTo}".`
        : field.type === "upload"
          ? "Media id."
          : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`${comment(doc, pad)}${pad}${key(field.name)}: ${nullable};\n`);
  }
  return lines;
}

/** The file `lefine content types` writes. Pure: same input, same text. */
export function renderContentTypes(input: ContentTypesInput): string {
  const { project, workspaceId } = input;
  // Both end up in code the user commits; only the id shapes Lefine makes are accepted.
  if (
    !/^prj_[A-Za-z0-9_-]+$/.test(project.id) ||
    !/^ws_[A-Za-z0-9_-]+$/.test(workspaceId)
  ) {
    throw new Error(
      `Unexpected project or workspace id from the server: ${oneLine(project.id)}, ${oneLine(workspaceId)}`,
    );
  }
  const used = new Set(["LefineContent", "LefineRichText"]);
  const named = [...input.collections]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((c) => {
      let name = typeName(c.slug);
      while (used.has(name)) name = `${name}Type`;
      used.add(name);
      return { ...c, name };
    });
  const locales = [project.sourceLocale, ...project.targetLocales];
  const parts = [
    `// Generated by \`lefine content types\` from the Lefine Content project ${oneLine(project.name ?? project.id)} (${oneLine(project.id)}).`,
    "// Do not edit: run the command again after you change a content type.",
    "// A page has every field; an empty one is null (a required one too, on a page saved before it was required).",
    "",
    'import type { LefineRichText } from "lefine/content";',
    "",
    ...named.flatMap((c) => {
      const body = objectType(c.fields, "");
      // An interface needs a body; a content type without fields yet is an empty one.
      return [
        `${comment(c.labels?.singular, "")}export interface ${c.name} ${body.startsWith("{") ? body : "{}"}`,
        "",
      ];
    }),
    "/** Content type slug -> page data. Pass it to createContentClient<LefineContent>(). */",
    `export interface LefineContent ${named.length > 0 ? `{\n${named.map((c) => `  ${JSON.stringify(c.slug)}: ${c.name};\n`).join("")}}` : "{}"}`,
    "",
    "/** This project on the Lefine edge. Spread it into createContentClient(). */",
    "export const lefineContent = {",
    `  workspaceId: ${JSON.stringify(workspaceId)},`,
    `  projectId: ${JSON.stringify(project.id)},`,
    `  fallbackLocale: ${JSON.stringify(project.fallbackLocale)},`,
    `  locales: ${JSON.stringify(locales)},`,
    "} as const;",
    "",
  ];
  return parts.join("\n");
}

export interface ContentTypesOptions extends GlobalOptions {
  /** prj_... id or the project's slug. */
  project?: string;
  output?: string;
  dir?: string;
}

const items = <T>(v: unknown): T[] =>
  ((v as { items?: T[] } | null)?.items ?? []) as T[];

/** The Content project --project names (id or slug), or the workspace's only one. */
export async function pickContentProject(
  ops: OpClient,
  wanted?: string,
): Promise<ContentProject> {
  const projects = items<ContentProject>(
    await ops.callOp("content.projects.list", {}),
  );
  const project = wanted
    ? projects.find((p) => p.id === wanted || p.slug === wanted)
    : projects.length === 1
      ? projects[0]
      : undefined;
  if (!project) {
    const names =
      projects
        .map((p) => `${safeText(p.slug ?? p.id)} (${p.id})`)
        .join(", ") || "none";
    throw new Error(
      wanted
        ? `No Content project "${safeText(wanted)}" in this workspace. Projects: ${names}.`
        : `This workspace has ${projects.length} Content projects. Pick one with --project: ${names}.`,
    );
  }
  return project;
}

/** A workspace without the Content module says so, in words. */
export function failContent(err: unknown, json?: boolean): never {
  if (err instanceof LefineError && err.code === "MODULE_OFF")
    fail(
      new Error(
        "This workspace does not have Content. Turn it on in the dashboard under Modules.",
      ),
      json,
    );
  // The general wording names Strings' apps and previews; say it in Content's words.
  if (err instanceof LefineError && err.code === "NOT_FOUND")
    fail(
      new Error(
        `Not found: ${err.message}. List the projects with \`lefine content projects\` and the pages with \`lefine content pages\`.`,
      ),
      json,
    );
  if (err instanceof LefineError && err.code === "CONFLICT")
    fail(
      new Error(
        `The page changed since it was shown (${err.message}). Nothing was published. Run the command again to see the new version.`,
      ),
      json,
    );
  fail(err, json);
}

export async function contentTypesCommand(
  options: ContentTypesOptions,
): Promise<void> {
  try {
    const auth = resolveLefineAuth(options);
    if (!auth) throw new LefineError("UNAUTHORIZED", "no key");
    const me = await getMe(auth.apiUrl, auth.token);
    const ops = createOpClient(auth.apiUrl, auth.token);

    const project = await pickContentProject(ops, options.project);

    // Globals are on the edge too (read with content.global()): they get a type too.
    const types = items<{ id: string; slug: string; kind: string }>(
      await ops.callOp("content.collections.list", { projectId: project.id }),
    );
    const collections = await Promise.all(
      types.map((t) =>
        ops.callOp<ContentTypeModel>("content.collections.get", {
          projectId: project.id,
          collectionId: t.id,
        }),
      ),
    );

    const file = resolve(
      options.dir || process.cwd(),
      options.output || "lefine-content.ts",
    );
    writeFileSync(
      file,
      renderContentTypes({
        workspaceId: me.workspace.id,
        project,
        collections,
      }),
    );
    out(
      options.json,
      { file, project: project.id, types: collections.map((c) => c.slug) },
      () => {
        console.log(
          `  Wrote ${file}: ${collections.length} content type${collections.length === 1 ? "" : "s"} from ${safeText(project.name ?? project.id)}.`,
        );
      },
    );
  } catch (err) {
    failContent(err, options.json);
  }
}
