import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import {
  contentTypesCommand,
  renderContentTypes,
  typeName,
  type ContentField,
} from "../content-types.js";

/** The fixture project of lefine/content's tests (packages/lefine/src/content/__tests__/fixtures). */
const POSTS: ContentField[] = [
  {
    type: "text",
    name: "title",
    label: "Title",
    required: true,
    localized: true,
  },
  { type: "richText", name: "body", localized: true },
  { type: "upload", name: "cover", label: "Cover image" },
  {
    type: "select",
    name: "tags",
    hasMany: true,
    options: ["news", { label: "Guide", value: "guide" }],
  },
  {
    type: "blocks",
    name: "sections",
    blocks: [
      {
        slug: "hero",
        fields: [{ type: "text", name: "heading", localized: true }],
      },
    ],
  },
];
const PROJECT = {
  id: "prj_site",
  slug: "site",
  name: "Site",
  sourceLocale: "en",
  targetLocales: ["de", "pt"],
  fallbackLocale: "en",
};

describe("renderContentTypes", () => {
  it("one interface per content type, the LefineContent map and the project config", () => {
    const text = renderContentTypes({
      workspaceId: "ws_acme",
      project: PROJECT,
      collections: [
        {
          slug: "posts",
          labels: { singular: "Post", plural: "Posts" },
          fields: POSTS,
        },
      ],
    });
    expect(text).toContain(
      'import type { LefineRichText } from "lefine/content";',
    );
    expect(text).toContain("export interface Posts {");
    expect(text).toContain("  title: string;\n");
    expect(text).toContain("  body: LefineRichText | null;\n");
    expect(text).toContain('  tags: Array<"news" | "guide"> | null;\n');
    expect(text).toContain('blockType: "hero";');
    expect(text).toContain('  "posts": Posts;\n');
    expect(text).toContain(
      '  workspaceId: "ws_acme",\n  projectId: "prj_site",\n  fallbackLocale: "en",\n  locales: ["en","de","pt"],',
    );
    expect(
      renderContentTypes({
        workspaceId: "ws_acme",
        project: PROJECT,
        collections: [{ slug: "posts", fields: POSTS }],
      }),
    ).toBe(
      renderContentTypes({
        workspaceId: "ws_acme",
        project: PROJECT,
        collections: [{ slug: "posts", fields: POSTS }],
      }),
    );
  });

  it("tabs and groups without a name add no key; named ones nest; arrays have rows; every type compiles", () => {
    const fields: ContentField[] = [
      {
        type: "tabs",
        tabs: [
          {
            label: "Content",
            fields: [
              { type: "group", fields: [{ type: "text", name: "kicker" }] },
            ],
          },
          {
            name: "seo",
            label: "SEO",
            fields: [{ type: "text", name: "metaTitle" }],
          },
        ],
      },
      {
        type: "group",
        name: "meta",
        fields: [
          { type: "checkbox", name: "featured" },
          { type: "date", name: "on" },
        ],
      },
      {
        type: "array",
        name: "faq",
        fields: [
          { type: "text", name: "q" },
          { type: "textarea", name: "a" },
        ],
      },
      { type: "relationship", name: "author", relationTo: "authors" },
      {
        type: "relationship",
        name: "related",
        relationTo: "posts",
        hasMany: true,
      },
      { type: "number", name: "minutes" },
      { type: "radio", name: "layout", options: ["wide", "narrow"] },
      { type: "email", name: "contact" },
      { type: "json", name: "extra" },
      { type: "text", name: "not-an-identifier" },
      { type: "weird", name: "future" },
    ];
    const text = renderContentTypes({
      workspaceId: "ws_acme",
      project: { ...PROJECT, fallbackLocale: null },
      collections: [
        { slug: "landing-pages", fields },
        { slug: "posts", fields: POSTS },
        { slug: "lefine-content", fields: [] },
      ],
    });
    expect(text).toContain("export interface LandingPages {");
    expect(text).toContain("  kicker: string | null;\n");
    expect(text).toContain("  seo: {\n");
    expect(text).toContain('  "not-an-identifier": string | null;\n');
    expect(text).toContain("  extra: unknown;\n");
    expect(text).toContain("  fallbackLocale: null,");
    // "lefine-content" -> LefineContent collides with the map's name.
    expect(text).toContain("export interface LefineContentType {}");
    expect(compile(text)).toEqual([]);
  });

  it("a project name cannot break out of the header comment", () => {
    const name = "Site\u2028export const pwned = 1;\nalert(1)";
    const text = renderContentTypes({
      workspaceId: "ws_acme",
      project: { ...PROJECT, name },
      collections: [],
    });
    const header = text.split(/\r\n|[\n\r\u2028\u2029]/)[0]!;
    expect(header).toContain("pwned");
    expect(text).not.toMatch(/[\u2028\u2029]/);
    expect(text.split("\n").filter((l) => l.includes("pwned"))).toEqual([
      header,
    ]);
    expect(() =>
      renderContentTypes({
        workspaceId: "ws_acme",
        project: { ...PROJECT, id: "prj_x y" },
        collections: [],
      }),
    ).toThrow(/Unexpected project/);
  });

  it("names", () => {
    expect(typeName("blog-posts")).toBe("BlogPosts");
    expect(typeName("faq")).toBe("Faq");
  });
});

/** Type-checks the generated file against a stub of lefine/content plus a use site. Returns the error messages. */
function compile(generated: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "lefine-types-"));
  try {
    mkdirSync(join(dir, "node_modules", "lefine", "content"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "lefine", "package.json"),
      JSON.stringify({ name: "lefine", type: "module", exports: { "./content": { types: "./content/index.d.ts" } } }),
    );
    writeFileSync(
      join(dir, "node_modules", "lefine", "content", "index.d.ts"),
      "export interface LefineRichText { root: { type: 'root'; children: unknown[] } }\n",
    );
    writeFileSync(join(dir, "lefine-content.ts"), generated);
    writeFileSync(
      join(dir, "use.ts"),
      [
        'import { lefineContent, type LefineContent } from "./lefine-content";',
        'const t: string = ({} as LefineContent["posts"]).title;',
        'const s = ({} as LefineContent["posts"]).sections?.[0];',
        'if (s && s.blockType === "hero") { const h: string | null = s.heading; void h; }',
        'const p: "prj_site" = lefineContent.projectId;',
        'const kicker: string | null = ({} as LefineContent["landing-pages"]).kicker;',
        "void t; void p; void kicker;",
      ].join("\n"),
    );
    const program = ts.createProgram([join(dir, "use.ts")], {
      strict: true,
      noEmit: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true,
      types: [],
    });
    return ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("lefine content types", () => {
  const realFetch = globalThis.fetch;
  const realExit = process.exit;
  const realLog = console.log;
  const realErr = console.error;
  let dir: string;
  let logs: string[];
  let calls: Array<{ name: string; input: unknown }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lefine-content-"));
    process.env.LEFINE_HOME = join(dir, "home");
    process.env.LEFINE_TOKEN = "lfn_test_token_value";
    process.env.LEFINE_API_URL = "http://api.test";
    logs = [];
    calls = [];
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.exit = realExit;
    console.log = realLog;
    console.error = realErr;
    delete process.env.LEFINE_HOME;
    delete process.env.LEFINE_TOKEN;
    delete process.env.LEFINE_API_URL;
    rmSync(dir, { recursive: true, force: true });
  });

  function api(projects: unknown[], moduleOff = false) {
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith("/v1/me"))
        return new Response(
          JSON.stringify({
            user: {},
            workspace: { id: "ws_acme", slug: "acme", name: "Acme" },
            scopes: ["content:read"],
            apps: null,
          }),
        );
      const name = url.split("/v1/ops/")[1]!;
      const body = JSON.parse(String(init?.body));
      calls.push({ name, input: body.input });
      if (moduleOff)
        return new Response(
          JSON.stringify({
            ok: false,
            error: { code: "MODULE_OFF", message: "content is off" },
          }),
          { status: 403 },
        );
      const data =
        name === "content.projects.list"
          ? { items: projects }
          : name === "content.collections.list"
            ? {
                items: [
                  { id: "col_posts", slug: "posts", kind: "collection" },
                  { id: "col_footer", slug: "footer", kind: "global" },
                ],
              }
            : body.input.collectionId === "col_footer"
              ? {
                  id: "col_footer",
                  slug: "footer",
                  kind: "global",
                  labels: { singular: "Footer", plural: "Footers" },
                  schemaVersion: 1,
                  fields: [{ type: "text", name: "copyright", localized: true }],
                }
              : {
                  id: "col_posts",
                  slug: "posts",
                  kind: "collection",
                  labels: { singular: "Post", plural: "Posts" },
                  schemaVersion: 1,
                  fields: POSTS,
                };
      return new Response(JSON.stringify({ ok: true, data }));
    }) as typeof fetch;
  }

  it("reads the only project's content types and globals and writes lefine-content.ts", async () => {
    api([PROJECT]);
    await contentTypesCommand({ dir });
    const text = readFileSync(join(dir, "lefine-content.ts"), "utf-8");
    expect(text).toContain("export interface Posts {");
    expect(text).toContain("export interface Footer {");
    expect(text).toContain('  workspaceId: "ws_acme",');
    expect(calls.map((c) => c.name)).toEqual([
      "content.projects.list",
      "content.collections.list",
      "content.collections.get",
      "content.collections.get",
    ]);
    expect(calls[2]?.input).toEqual({
      projectId: "prj_site",
      collectionId: "col_posts",
    });
    expect(logs.join("\n")).toContain("2 content types from Site");
  });

  it("several projects: --project picks one by slug or id; without it the command names them", async () => {
    api([PROJECT, { ...PROJECT, id: "prj_docs", slug: "docs", name: "Docs" }]);
    await contentTypesCommand({
      dir,
      project: "docs",
      output: "types/content.ts",
      json: true,
    }).catch(() => undefined);
    expect(logs.join("\n")).toContain("ENOENT"); // types/ does not exist: the error is reported, nothing half-written
    logs.length = 0;
    await contentTypesCommand({
      dir,
      project: "prj_docs",
      output: "docs-content.ts",
    });
    expect(readFileSync(join(dir, "docs-content.ts"), "utf-8")).toContain(
      'projectId: "prj_docs"',
    );
    logs.length = 0;
    await expect(contentTypesCommand({ dir })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain(
      "has 2 Content projects. Pick one with --project: site (prj_site), docs (prj_docs)",
    );
  });

  it("Content turned off: says so in Content's words", async () => {
    api([], true);
    await expect(contentTypesCommand({ dir })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("does not have Content");
  });
});
