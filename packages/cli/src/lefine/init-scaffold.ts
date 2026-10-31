/**
 * What `lefine init` writes so a fresh app shows a translated page with no other command and no edit
 * (the DX check, 2026-10-26: before this it wrote lefine.ts only, and a Next app needed `npm i`, proxy.ts and two
 * files under app/[locale]; a TanStack Start app got a Next import). Pure: it plans files, the command writes them.
 * It never replaces a file the app has: a planned file that exists is reported as skipped, with what to add. One
 * exception: create-next-app's own root layout and page (`replaces`). app/[locale]/layout.tsx must be the root layout
 * (DX walk 2026-10-29): with app/layout.tsx above it, (1) `<html lang="en">` served every language as English, with no
 * dir="rtl", and (2) `locale` was not a root param, so Next 16.3+ with Partial Prefetching (create-next-app's default)
 * printed "Error: Route "/[locale]": Next.js encountered URL data" in `next dev`: only root params may be read outside
 * <Suspense> (next/src/server/request/params.ts, allParamsAreRootParams). Next's i18n guide and next-intl's examples
 * put the root layout at app/[locale]/layout.tsx with no app/layout.tsx. So create-next-app's layout moves there (fonts,
 * CSS, metadata), and its app/layout.tsx and app/page.tsx (a page with no root layout fails the build) are removed.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { AppSummary } from "./types.js";

export type Framework = "next" | "tanstack-start" | "react";

/** A text the starter page shows: the first one with no argument in the app's live source locale. */
export interface SampleText {
  namespace: string;
  key: string;
}

export interface PlannedFile {
  path: string;
  content: string;
  /** Said when the file exists and is kept, so the person knows the one line to add. */
  ifExists?: string;
  /** Written over (or with `remove`, deleted) only while the existing file still holds exactly this text. */
  replaces?: string;
  /** Delete the file instead of writing it (create-next-app's root layout and page, whose place app/[locale] takes). */
  remove?: boolean;
  /** Said after the file is written: what the person still has to do. */
  note?: string;
}

/** From package.json. A missing or broken one is plain React (lefine/server + lefine/react). */
export function detectFramework(dir: string): Framework {
  // No package.json at all: the documented default, Next (lefine.ts as before).
  if (!existsSync(join(dir, "package.json"))) return "next";
  const deps = packageDeps(dir);
  if (deps.next) return "next";
  if (deps["@tanstack/react-start"]) return "tanstack-start";
  return "react";
}

/**
 * What init calls the app, and the guide for the next step. A Vue or Svelte app gets the same lefine.ts as React (the
 * "react" plan is lefine/server only); before this it was told it was React and given no next step (DX walk 2026-10-29).
 */
export function describeApp(framework: Framework, dir: string): { label: string; next: string } {
  if (framework === "next") return { label: "Next.js", next: "npm run dev, then open http://localhost:3000" };
  if (framework === "tanstack-start") return { label: "TanStack Start", next: "npm run dev, then open http://localhost:3000/<locale>" };
  const deps = packageDeps(dir);
  if (deps.react) return { label: "React", next: "load the texts and render: https://lefine.ai/docs/strings/react/" };
  const label = deps.vue ? "Vue" : deps.svelte ? "Svelte" : "JavaScript";
  return { label, next: `${label === "JavaScript" ? "load and format the texts" : `use them in ${label}`}: https://lefine.ai/docs/strings/vue/` };
}

export function packageDeps(dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as Record<string, Record<string, string> | undefined>;
    return { ...pkg.devDependencies, ...pkg.dependencies };
  } catch {
    return {};
  }
}

/** The install command of the app's package manager, by its lockfile. */
export function installCommand(dir: string): [string, ...string[]] {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return ["bun", "add", "lefine"];
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return ["pnpm", "add", "lefine"];
  if (existsSync(join(dir, "yarn.lock"))) return ["yarn", "add", "lefine"];
  return ["npm", "install", "lefine"];
}

/** Server text in a `//` comment: printable ASCII only, so it cannot end the comment. */
const oneLine = (text: string) => text.replace(/[^\x20-\x7E]/g, "?");
const js = (value: unknown) => JSON.stringify(value).replace(/,/g, ", ");
/** An import specifier from one planned file to another, without the extension. */
const importPath = (from: string, to: string) => {
  const rel = relative(dirname(from), to).replace(/\\/g, "/").replace(/\.tsx?$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
};

function checkedId(app: Pick<AppSummary, "id">): string {
  if (!/^app_[a-z0-9]{3,64}$/.test(app.id)) throw new Error(`Unexpected app id from the server: ${JSON.stringify(oneLine(app.id))}`);
  return app.id;
}

/** A locale from the server goes into code, URLs and the terminal: only a BCP 47 shape is let in. */
export const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const localesOf = (app: Pick<AppSummary, "sourceLocale" | "targetLocales">) => {
  const all = [...new Set([app.sourceLocale, ...app.targetLocales])];
  const bad = all.find((l) => typeof l !== "string" || !LOCALE.test(l));
  if (bad !== undefined) throw new Error(`Unexpected locale from the server: ${JSON.stringify(oneLine(String(bad)))}`);
  return all;
};
/** A key or namespace goes into code as a string literal; only these characters are let in (no dot: it reads as a path). */
const safeName = (s: string) => /^[A-Za-z0-9_-]{1,128}$/.test(s);

type AppInfo = Pick<AppSummary, "id" | "name" | "sourceLocale" | "targetLocales">;

/** lefine.ts for a Next app (kept as the one-file form `renderLefineFile` tests). */
export function renderNextLefine(app: AppInfo, cdn?: string): string {
  return [
    "// Written by `npx lefine init`. The id never changes, so renaming the app in Lefine is safe.",
    'import { createLefine } from "lefine/next";',
    "",
    "export const lefine = createLefine({",
    `  project: ${JSON.stringify(checkedId(app))}, // ${oneLine(app.name)}`,
    `  locales: ${js(localesOf(app))},`,
    `  defaultLocale: ${JSON.stringify(app.sourceLocale)},`,
    ...(cdn ? [`  cdn: ${JSON.stringify(cdn)},`] : []),
    "});",
    "",
  ].join("\n");
}

/** Right-to-left scripts get dir="rtl" on <html>: Arabic, Sorani, Dhivehi, Persian, Hebrew, Pashto, Sindhi, Uyghur, Urdu, Yiddish. */
const RTL_LINES = [
  "/** Languages written right to left get dir=\"rtl\". */",
  "const rtl = (locale: string) => /^(ar|ckb|dv|fa|he|ps|sd|ug|ur|yi)(-|$)/i.test(locale);",
];
const HTML_DIR = 'lang={locale} dir={rtl(locale) ? "rtl" : "ltr"}';
const LOCALE_PROPS = "{ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }";
const STATIC_PARAMS = "export const generateStaticParams = () => lefine.locales.map((locale) => ({ locale }));";

/** create-next-app's starter page: removed with its layout (the proxy sends "/" to a locale). */
export const isCreateNextAppPage = (text: string) =>
  text.includes('from "./page.module.css"') && (text.includes("To get started, edit the") || text.includes("Get started by editing"));

const UNKNOWN_LOCALE = "  if (!lefine.locales.includes(locale)) notFound();";
const NOT_FOUND_IMPORT = 'import { notFound } from "next/navigation";';

/**
 * A URL no page matches (a locale with a path that does not exist, or a first segment that is not a locale). There is
 * no root layout above app/[locale], so Next renders this in its own built-in <html>: an <html> here would be nested
 * in it (a hydration error in next dev, 2026-10-29).
 */
const ROOT_NOT_FOUND = [
  "// Written by `npx lefine init`: a URL that no page matches. Next renders it in its own <html>, outside app/[locale].",
  "export default function NotFound() {",
  "  return <h1>Page not found</h1>;",
  "}",
  "",
].join("\n");

/** The one match of `re` in `text`, or null when there is none or more than one. */
function only(text: string, re: RegExp): RegExpExecArray | null {
  const all = [...text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))];
  return all.length === 1 ? all[0]! : null;
}

/**
 * create-next-app's root layout, rewritten as app/[locale]/layout.tsx: same imports (paths one folder deeper), fonts,
 * CSS and metadata; `lang` and `dir` from the locale; children inside <lefine.Provider>. Null when the file is not
 * create-next-app's (its own metadata says so) or not in the shape this rewrite knows: then nothing is moved.
 */
export function moveRootLayout(text: string, paths: { root: string; layout: string; lefine: string }, namespaces: string): string | null {
  if (!text.includes("Generated by create next app")) return null;
  const lines = text.split("\n");
  const importLines = lines.map((l, i) => (l.startsWith("import ") ? i : -1)).filter((i) => i >= 0);
  if (importLines.length === 0 || importLines.some((i) => !/;\s*$/.test(lines[i]!))) return null;
  const signature = only(text, /export default function \w+\([^)]*\)\s*\{/);
  const html = only(text, /<html\b([^>]*?)\slang=(?:"[^"]*"|\{[^}]*\})/);
  const children = only(text, /\{children\}/);
  if (!signature || !html || !children || /\bparams\b/.test(text)) return null;

  let out = text
    .replace(html[0], `<html${html[1]} ${HTML_DIR}`)
    .replace(children[0], `<lefine.Provider locale={locale} namespaces={${namespaces}}>{children}</lefine.Provider>`)
    .replace(signature[0], [STATIC_PARAMS, "", `export default async function LocaleLayout(${LOCALE_PROPS}) {`, "  const { locale } = await params;", UNKNOWN_LOCALE].join("\n"));
  // Relative imports point one folder deeper now.
  out = out.replace(/(\bfrom\s+|^import\s+)"(\.{1,2}\/[^"]+)"/gm, (_m, head: string, spec: string) => `${head}${JSON.stringify(importPath(paths.layout, join(dirname(paths.root), spec)))}`);
  const outLines = out.split("\n");
  const lastImport = outLines.reduce((last, l, i) => (l.startsWith("import ") ? i : last), -1);
  outLines.splice(
    lastImport + 1,
    0,
    NOT_FOUND_IMPORT,
    ...(/import type \{[^}]*\bReactNode\b/.test(out) ? [] : ['import type { ReactNode } from "react";']),
    `import { lefine } from ${JSON.stringify(importPath(paths.layout, paths.lefine))};`,
    "",
    ...RTL_LINES,
  );
  return ["// Moved here by `npx lefine init` from app/layout.tsx: <html lang dir> follows the locale.", ...outLines].join("\n");
}

const pageText = (sample: SampleText | null, t: string) =>
  sample ? `{${t}(${JSON.stringify(sample.key)})}` : "Publish your texts in Lefine, then reload this page.";

/** Every file a framework needs for its first translated page, relative to the app's root. */
export function planInit(framework: Framework, dir: string, app: AppInfo, sample: SampleText | null, cdn?: string): PlannedFile[] {
  const ns = sample && safeName(sample.namespace) && safeName(sample.key) ? sample : null;
  const namespaces = ns ? js([ns.namespace]) : "[]";
  if (framework === "next") {
    const src = existsSync(join(dir, "src", "app")) ? "src" : "";
    const appDir = join(src, "app");
    const lefinePath = join(src, "lefine.ts");
    const layout = join(appDir, "[locale]", "layout.tsx");
    const page = join(appDir, "[locale]", "page.tsx");
    const hasProxy = ["proxy.ts", "middleware.ts", "proxy.js", "middleware.js"].some((f) => existsSync(join(dir, src, f)));
    const rootLayout = join(appDir, "layout.tsx");
    const rootText = existsSync(join(dir, rootLayout)) ? readFileSync(join(dir, rootLayout), "utf-8") : null;
    const notFound = join(appDir, "not-found.tsx");
    const ifExists = `${layout} exists: wrap its children in <lefine.Provider locale={locale} namespaces={${namespaces}}>, and set <html lang={locale}> there.`;
    const header = (first: string, extra: string[] = []) => [first, ...extra, 'import type { ReactNode } from "react";', `import { lefine } from ${JSON.stringify(importPath(layout, lefinePath))};`, ""];
    const htmlLayout = [
      ...header("// Written by `npx lefine init`: the root layout. <html lang dir> follows the locale. Only the namespaces named here reach the browser.", [NOT_FOUND_IMPORT]),
      ...RTL_LINES,
      "",
      STATIC_PARAMS,
      "",
      `export default async function LocaleLayout(${LOCALE_PROPS}) {`,
      "  const { locale } = await params;",
      UNKNOWN_LOCALE,
      "  return (",
      `    <html ${HTML_DIR}>`,
      "      <body>",
      `        <lefine.Provider locale={locale} namespaces={${namespaces}}>`,
      "          {children}",
      "        </lefine.Provider>",
      "      </body>",
      "    </html>",
      "  );",
      "}",
      "",
    ].join("\n");
    const rootPage = join(appDir, "page.tsx");
    const rootPageText = existsSync(join(dir, rootPage)) ? readFileSync(join(dir, rootPage), "utf-8") : null;
    const pageCss = join(appDir, "page.module.css");
    /** Removing create-next-app's root page (and its CSS); null when the app has a root page of its own. */
    const rootPageGone: PlannedFile[] | null =
      rootPageText === null
        ? []
        : isCreateNextAppPage(rootPageText)
          ? [
              { path: rootPage, content: "", remove: true, replaces: rootPageText },
              ...(existsSync(join(dir, pageCss)) ? [{ path: pageCss, content: "", remove: true, replaces: readFileSync(join(dir, pageCss), "utf-8") }] : []),
            ]
          : null;
    /** app/[locale]/layout.tsx, and what making it the root layout needs around it. */
    const localeLayout = (): PlannedFile[] => {
      if (existsSync(join(dir, layout))) return [{ path: layout, ifExists, content: "" }];
      const notFoundFile = existsSync(join(dir, notFound)) ? [] : [{ path: notFound, content: ROOT_NOT_FOUND }];
      if (rootPageGone) {
        // No root layout: the locale layout is the root layout.
        if (rootText === null) return [{ path: layout, content: htmlLayout }, ...rootPageGone, ...notFoundFile];
        const moved = moveRootLayout(rootText, { root: rootLayout, layout, lefine: lefinePath }, namespaces);
        if (moved) return [{ path: layout, content: moved }, { path: rootLayout, content: "", remove: true, replaces: rootText }, ...rootPageGone, ...notFoundFile];
      }
      // The app's own root layout: kept. The page works; every language is still served with that layout's lang.
      return [
        {
          path: layout,
          content: [
            ...header("// Written by `npx lefine init`. Only the namespaces named here reach the browser."),
            STATIC_PARAMS,
            "",
            `export default async function LocaleLayout(${LOCALE_PROPS}) {`,
            "  const { locale } = await params;",
            "  return (",
            `    <lefine.Provider locale={locale} namespaces={${namespaces}}>`,
            "      {children}",
            "    </lefine.Provider>",
            "  );",
            "}",
            "",
          ].join("\n"),
          note: `${rootLayout} is above app/[locale], so every language gets its <html lang>, and next dev warns about params. Move <html> and <body> into ${layout} with lang={locale}, then remove ${rootLayout} and ${rootPage}: lefine.ai/docs/strings/nextjs/`,
        },
      ];
    };
    return [
      { path: lefinePath, content: renderNextLefine(app, cdn) },
      ...(hasProxy
        ? []
        : [
            {
              path: join(src, "proxy.ts"),
              content: [
                "// Sends each visitor to their language (/en, /de, ...). Written by `npx lefine init`.",
                `import { lefine } from ${JSON.stringify(importPath(join(src, "proxy.ts"), lefinePath))};`,
                "",
                "export default lefine.proxy;",
                'export const config = { matcher: ["/((?!api|_next|_vercel|.*\\\\..*).*)"] };',
                "",
              ].join("\n"),
            },
          ]),
      ...localeLayout(),
      {
        path: page,
        content: [
          "// Written by `npx lefine init`: your first translated page. Edit or delete it.",
          'import { Link } from "lefine/next/link";',
          `import { lefine } from ${JSON.stringify(importPath(page, lefinePath))};`,
          "",
          "export default async function Home({ params }: { params: Promise<{ locale: string }> }) {",
          "  const { locale } = await params;",
          ...(ns ? [`  const t = await lefine.getStrings(locale, ${JSON.stringify(ns.namespace)});`] : []),
          "  return (",
          "    <main style={{ padding: 32, fontFamily: \"system-ui\" }}>",
          `      <h1>${pageText(ns, "t")}</h1>`,
          "      <nav style={{ display: \"flex\", gap: 12 }}>",
          "        {lefine.locales.map((l) => (",
          '          <Link key={l} href="/" locale={l}>',
          "            {l}",
          "          </Link>",
          "        ))}",
          "      </nav>",
          "    </main>",
          "  );",
          "}",
          "",
        ].join("\n"),
      },
    ];
  }

  const src = existsSync(join(dir, "src")) ? "src" : "";
  const lefinePath = join(src, "lefine.ts");
  const serverFile = [
    "// Written by `npx lefine init`. The id never changes, so renaming the app in Lefine is safe.",
    ...(framework === "tanstack-start" ? ['import { createServerFn } from "@tanstack/react-start";'] : []),
    'import { createStrings } from "lefine/server";',
    "",
    `export const locales = ${js(localesOf(app))};`,
    `export const defaultLocale = ${JSON.stringify(app.sourceLocale)};`,
    "",
    ...(framework === "tanstack-start"
      ? [
          "// Made on first use, inside the server function: the browser bundle never gets the loader (TanStack Start",
          "// strips handler bodies there, and nothing else uses it).",
          "let made: ReturnType<typeof createStrings> | undefined;",
          `export const strings = () => (made ??= createStrings({ project: ${JSON.stringify(checkedId(app))}${cdn ? `, cdn: ${JSON.stringify(cdn)}` : ""} })); // ${oneLine(app.name)}`,
          "",
          "/** For a route loader: the texts of one locale, run on the server (plain JSON for <StringsProvider>). */",
          'export const loadStrings = createServerFn({ method: "GET" })',
          "  .validator((locale: string) => (locales.includes(locale) ? locale : defaultLocale))",
          `  .handler(({ data }) => strings().load(data, ${namespaces}));`,
        ]
      : [`export const strings = createStrings({ project: ${JSON.stringify(checkedId(app))}${cdn ? `, cdn: ${JSON.stringify(cdn)}` : ""} }); // ${oneLine(app.name)}`]),
    "",
  ].join("\n");
  if (framework !== "tanstack-start") return [{ path: lefinePath, content: serverFile }];

  const route = join(src, "routes", "$locale", "index.tsx");
  return [
    { path: lefinePath, content: serverFile },
    {
      path: route,
      content: [
        "// Written by `npx lefine init`: your first translated page, at /en, /de, ... Edit or delete it.",
        'import { createFileRoute, notFound } from "@tanstack/react-router";',
        'import { StringsProvider, useStrings } from "lefine/react";',
        `import { loadStrings, locales } from ${JSON.stringify(importPath(route, lefinePath))};`,
        "",
        'export const Route = createFileRoute("/$locale/")({',
        "  loader: ({ params }) => {",
        "    if (!locales.includes(params.locale)) throw notFound();",
        "    return loadStrings({ data: params.locale });",
        "  },",
        "  component: Page,",
        "  notFoundComponent: () => <p>There is no such language here.</p>,",
        "});",
        "",
        "function Page() {",
        "  return (",
        "    <StringsProvider {...Route.useLoaderData()}>",
        "      <Home />",
        "    </StringsProvider>",
        "  );",
        "}",
        "",
        "function Home() {",
        ...(ns ? [`  const t = useStrings(${JSON.stringify(ns.namespace)});`] : []),
        "  return (",
        '    <main style={{ padding: 32, fontFamily: "system-ui" }}>',
        `      <h1>${pageText(ns, "t")}</h1>`,
        '      <nav style={{ display: "flex", gap: 12 }}>',
        "        {locales.map((l) => (",
        "          <a key={l} href={`/${l}`}>",
        "            {l}",
        "          </a>",
        "        ))}",
        "      </nav>",
        "    </main>",
        "  );",
        "}",
        "",
      ].join("\n"),
    },
  ];
}

/** The first text with no argument in a published locale file ({ namespace: { key: text } }), for the starter page. */
export function pickSample(tree: unknown): SampleText | null {
  if (!tree || typeof tree !== "object") return null;
  for (const [namespace, keys] of Object.entries(tree as Record<string, unknown>)) {
    if (!safeName(namespace) || !keys || typeof keys !== "object") continue;
    for (const [key, text] of Object.entries(keys as Record<string, unknown>)) {
      if (safeName(key) && typeof text === "string" && text.trim() !== "" && !/[{}<]/.test(text)) return { namespace, key };
    }
  }
  return null;
}
