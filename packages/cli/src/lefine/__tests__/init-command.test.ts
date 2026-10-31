import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand, renderLefineFile, type RunInstall } from "../init-command.js";
import { pickSample } from "../init-scaffold.js";

const WEB = { id: "app_0123456789abcdef0123456789abcdef", slug: "web", name: "Acme web", sourceLocale: "en", targetLocales: ["de", "pt-BR"], keyCount: 3 };
const DOCS = { ...WEB, id: "app_fedcba9876543210fedcba9876543210", slug: "docs", name: "Docs" };

describe("renderLefineFile", () => {
  it("writes the id with the current name as a comment, and the app's locales", () => {
    expect(renderLefineFile(WEB)).toBe(
      [
        "// Written by `npx lefine init`. The id never changes, so renaming the app in Lefine is safe.",
        'import { createLefine } from "lefine/next";',
        "",
        "export const lefine = createLefine({",
        '  project: "app_0123456789abcdef0123456789abcdef", // Acme web',
        '  locales: ["en", "de", "pt-BR"],',
        '  defaultLocale: "en",',
        "});",
        "",
      ].join("\n"),
    );
  });

  it("a name cannot leave its comment, and an id that is not Lefine's shape is refused", () => {
    expect(renderLefineFile({ ...WEB, name: "x process.exit()\n" })).toContain("// x?process.exit()?\n");
    expect(() => renderLefineFile({ ...WEB, id: 'app_x"; evil' })).toThrow("Unexpected app id");
  });
});

describe("lefine init", () => {
  const realFetch = globalThis.fetch;
  const realExit = process.exit;
  const realLog = console.log;
  const realErr = console.error;
  const realTty = process.stdin.isTTY;
  let dir: string;
  let logs: string[];
  let apps: unknown[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lefine-init-"));
    process.env.LEFINE_HOME = join(dir, "home");
    process.env.LEFINE_TOKEN = "lfn_test_token_value";
    process.env.LEFINE_API_URL = "http://api.test";
    logs = [];
    apps = [WEB];
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;
    (process.stdin as { isTTY?: boolean }).isTTY = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/ops/strings.apps.list")) return new Response(JSON.stringify({ ok: true, data: { items: apps } }));
      // The live edge: the starter page shows the first plain text of the source locale.
      if (url.endsWith(`/${WEB.id}/manifest.json`)) return Response.json({ schema: 2, files: { en: { version: "mh3k2lc0-a1b2c3d4" } } });
      if (url.endsWith(`/${WEB.id}/v/mh3k2lc0-a1b2c3d4/en/translations.json`)) return Response.json({ home: { hi: "Hi {name}", title: "Welcome" } });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.exit = realExit;
    console.log = realLog;
    console.error = realErr;
    (process.stdin as { isTTY?: boolean }).isTTY = realTty;
    delete process.env.LEFINE_HOME;
    delete process.env.LEFINE_TOKEN;
    delete process.env.LEFINE_API_URL;
    delete process.env.LEFINE_CDN_URL;
    rmSync(dir, { recursive: true, force: true });
  });

  it("one app: writes lefine.ts without a question", async () => {
    await initCommand({ dir });
    expect(readFileSync(join(dir, "lefine.ts"), "utf-8")).toContain('project: "app_0123456789abcdef0123456789abcdef", // Acme web');
  });

  it("several apps: --app picks by slug or id; in CI without --app it lists them", async () => {
    apps = [WEB, DOCS];
    await expect(initCommand({ dir })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("has 2 apps. Pick one with --app: web, docs");
    await initCommand({ dir, app: "docs" });
    expect(readFileSync(join(dir, "lefine.ts"), "utf-8")).toContain(DOCS.id);
  });

  it("asks in a terminal", async () => {
    apps = [WEB, DOCS];
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    await initCommand({ dir }, async (list) => list[1]!);
    expect(readFileSync(join(dir, "lefine.ts"), "utf-8")).toContain(DOCS.id);
  });

  it("never replaces a file without --force", async () => {
    writeFileSync(join(dir, "lefine.ts"), "mine");
    await expect(initCommand({ dir })).rejects.toThrow("exit:1");
    expect(readFileSync(join(dir, "lefine.ts"), "utf-8")).toBe("mine");
    await initCommand({ dir, force: true });
    expect(existsSync(join(dir, "lefine.ts")) && readFileSync(join(dir, "lefine.ts"), "utf-8")).toContain(WEB.id);
  });

  const pkg = (deps: Record<string, string>) => writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps }));
  const read = (path: string) => readFileSync(join(dir, path), "utf-8");
  const installs: Array<{ cmd: string[]; cwd: string }> = [];
  const fakeInstall: RunInstall = (cmd, cwd) => (installs.push({ cmd, cwd }), true);

  it("a Next app: one command gives lefine.ts, proxy.ts and a translated page, and installs lefine", async () => {
    pkg({ next: "16.4.3", react: "19" });
    installs.length = 0;
    await initCommand({ dir }, undefined, fakeInstall);
    expect(read("lefine.ts")).toContain('import { createLefine } from "lefine/next";');
    expect(read("proxy.ts")).toContain('import { lefine } from "./lefine";');
    expect(read("app/[locale]/layout.tsx")).toContain('<lefine.Provider locale={locale} namespaces={["home"]}>');
    expect(read("app/[locale]/layout.tsx")).toContain('import { lefine } from "../../lefine";');
    // The first text with no argument: "hi" needs {name}, "title" does not.
    expect(read("app/[locale]/page.tsx")).toContain('const t = await lefine.getStrings(locale, "home");');
    expect(read("app/[locale]/page.tsx")).toContain('<h1>{t("title")}</h1>');
    expect(installs).toEqual([{ cmd: ["npm", "install", "lefine"], cwd: dir }]);
  });

  // DX walk 2026-10-29: create-next-app's app/layout.tsx kept <html lang="en">, so /de and /he were served as English
  // with no dir="rtl". Its <html>, fonts and CSS now move to app/[locale]/layout.tsx.
  const CNA_LAYOUT = `import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Create Next App",
  description: "Generated by create next app",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={\`\${geistSans.variable} \${geistMono.variable}\`}>
      <body>{children}</body>
    </html>
  );
}
`;
  const CNA_PAGE = `import Image from "next/image";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Image
          className={styles.logo}
          src="/next.svg"
          alt="Next.js logo"
          width={100}
          height={20}
          priority
        />
        <div className={styles.intro}>
          <h1>
            To get started, edit the{" "}
            <code className={styles.code}>page.tsx</code> file.
          </h1>
          <p>
            Looking for a starting point or more instructions? Head over to{" "}
            <a
              href="https://vercel.com/templates?framework=next.js&utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
              target="_blank"
              rel="noopener noreferrer"
            >
              Templates
            </a>{" "}
            or the{" "}
            <a
              href="https://nextjs.org/learn?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
              target="_blank"
              rel="noopener noreferrer"
            >
              Learning
            </a>{" "}
            center.
          </p>
        </div>
        <div className={styles.ctas}>
          <a
            className={styles.primary}
            href="https://vercel.com/new?utm_source=create-next-app&utm_medium=appdir-template&utm_campaign=create-next-app"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Image
              className={styles.logo}
              src="/vercel.svg"
              alt="Vercel logomark"
              width={16}
              height={14}
            />
            Deploy Now
          </a>
          <a
            className={styles.secondary}
            href="https://nextjs.org/docs?utm_source=create-next-app&utm_medium=appdir-template&utm_campaign=create-next-app"
            target="_blank"
            rel="noopener noreferrer"
          >
            Documentation
          </a>
        </div>
      </main>
    </div>
  );
}
`;
  const rtlOf = (layout: string) => new RegExp(/\/(\^\(ar[^/]+)\/i/.exec(layout)![1]!, "i");

  it("create-next-app's root layout and page: app/[locale]/layout.tsx becomes the root layout, with lang, dir, fonts and CSS", async () => {
    pkg({ next: "16.4.3", react: "19" });
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "layout.tsx"), CNA_LAYOUT);
    writeFileSync(join(dir, "app", "page.tsx"), CNA_PAGE);
    writeFileSync(join(dir, "app", "page.module.css"), ".page {}");
    await initCommand({ dir, install: false });
    const layout = read("app/[locale]/layout.tsx");
    expect(layout).toContain('<html lang={locale} dir={rtl(locale) ? "rtl" : "ltr"} className={`${geistSans.variable} ${geistMono.variable}`}>');
    expect(layout).toContain('import "../globals.css";');
    expect(layout).toContain('import { Geist, Geist_Mono } from "next/font/google";');
    expect(layout).toContain("export const metadata: Metadata");
    expect(layout).toContain('<lefine.Provider locale={locale} namespaces={["home"]}>{children}</lefine.Provider>');
    expect(layout).toContain("if (!lefine.locales.includes(locale)) notFound();");
    expect(layout).toContain('import { notFound } from "next/navigation";');
    expect(layout).not.toContain('lang="en"');
    new Bun.Transpiler({ loader: "tsx" }).transformSync(layout);
    // No layout above app/[locale]: locale is a root param (no "URL data" error in next dev), and no page without a root layout.
    expect(existsSync(join(dir, "app", "layout.tsx"))).toBe(false);
    expect(existsSync(join(dir, "app", "page.tsx"))).toBe(false);
    expect(existsSync(join(dir, "app", "page.module.css"))).toBe(false);
    // Next wraps it in its built-in <html>: an <html> of its own would nest (hydration error in next dev).
    expect(read("app/not-found.tsx").split("\n").slice(1).join("\n")).not.toContain("<html");
    expect(logs.join("\n")).toContain("Removed create-next-app's app/layout.tsx, app/page.tsx, app/page.module.css");
  });

  it("a root page of the app's own: nothing is moved or removed, and init says what to do", async () => {
    pkg({ next: "16.4.3" });
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "layout.tsx"), CNA_LAYOUT);
    writeFileSync(join(dir, "app", "page.tsx"), "export default function Home() { return <p>mine</p>; }\n");
    await initCommand({ dir, install: false });
    expect(read("app/layout.tsx")).toBe(CNA_LAYOUT);
    expect(read("app/page.tsx")).toContain("mine");
    expect(read("app/[locale]/layout.tsx")).not.toContain("<html");
    expect(logs.join("\n")).toContain("Move <html> and <body> into app/[locale]/layout.tsx");
  });

  it("dir is rtl for Hebrew, Arabic, Persian and Urdu (with or without a region), ltr for the rest", async () => {
    pkg({ next: "16.4.3" });
    await initCommand({ dir, install: false });
    const rtl = rtlOf(read("app/[locale]/layout.tsx"));
    for (const l of ["he", "ar", "ar-EG", "fa", "ur", "HE"]) expect(rtl.test(l), l).toBe(true);
    for (const l of ["en", "de", "zh-Hans", "ha", "arn", "fr-CA"]) expect(rtl.test(l), l).toBe(false);
  });

  it("no root layout: app/[locale]/layout.tsx is the root layout, with a not-found page for URLs outside it", async () => {
    pkg({ next: "16.4.3" });
    await initCommand({ dir, install: false });
    expect(read("app/[locale]/layout.tsx")).toContain('<html lang={locale} dir={rtl(locale) ? "rtl" : "ltr"}>');
    expect(read("app/[locale]/layout.tsx")).toContain("if (!lefine.locales.includes(locale)) notFound();");
    expect(existsSync(join(dir, "app", "layout.tsx"))).toBe(false);
    expect(existsSync(join(dir, "app", "not-found.tsx"))).toBe(true);
  });

  it("the app's own root layout is kept: no <html> in the locale layout, and init says what to move", async () => {
    pkg({ next: "16.4.3" });
    mkdirSync(join(dir, "app"), { recursive: true });
    const mine = 'export default function L({ children }: { children: React.ReactNode }) { return <html lang="en"><body>{children}</body></html>; }\n';
    writeFileSync(join(dir, "app", "layout.tsx"), mine);
    await initCommand({ dir, install: false });
    expect(read("app/layout.tsx")).toBe(mine);
    expect(read("app/[locale]/layout.tsx")).not.toContain("<html");
    expect(existsSync(join(dir, "app", "not-found.tsx"))).toBe(false);
    expect(logs.join("\n")).toContain("Move <html> and <body> into app/[locale]/layout.tsx with lang={locale}, then remove app/layout.tsx");
  });

  it("a Vue or Svelte app is not called React, and gets the guide for its next step", async () => {
    pkg({ vue: "^3.5.0" });
    await initCommand({ dir, install: false });
    expect(logs.join("\n")).toContain("(Vue): wrote lefine.ts");
    expect(logs.join("\n")).toContain("Next: use them in Vue: https://lefine.ai/docs/strings/vue/");
    logs.length = 0;
    pkg({ react: "19" });
    await initCommand({ dir, install: false, force: true });
    expect(logs.join("\n")).toContain("(React): wrote lefine.ts");
    expect(logs.join("\n")).toContain("https://lefine.ai/docs/strings/react/");
  });

  it("keeps the app's own files: an existing middleware, layout or lefine install is left alone", async () => {
    pkg({ next: "16.4.3", lefine: "^1.0.0" });
    writeFileSync(join(dir, "middleware.ts"), "mine");
    mkdirSync(join(dir, "app", "[locale]"), { recursive: true });
    writeFileSync(join(dir, "app", "[locale]", "layout.tsx"), "my layout");
    installs.length = 0;
    await initCommand({ dir, force: true }, undefined, fakeInstall);
    expect(existsSync(join(dir, "proxy.ts"))).toBe(false);
    expect(read("middleware.ts")).toBe("mine");
    expect(read("app/[locale]/layout.tsx")).toBe("my layout");
    expect(logs.join("\n")).toContain('wrap its children in <lefine.Provider locale={locale} namespaces={["home"]}>');
    expect(existsSync(join(dir, "app", "[locale]", "page.tsx"))).toBe(true);
    expect(installs).toEqual([]);
  });

  it("a Next app under src/ gets its files there; another edge (LEFINE_CDN_URL) is written into lefine.ts", async () => {
    pkg({ next: "16.4.3" });
    mkdirSync(join(dir, "src", "app"), { recursive: true });
    process.env.LEFINE_CDN_URL = "http://localhost:8899/";
    await initCommand({ dir, install: false }, undefined, fakeInstall);
    expect(read("src/lefine.ts")).toContain('cdn: "http://localhost:8899",');
    expect(read("src/proxy.ts")).toContain('from "./lefine"');
    expect(read("src/app/[locale]/page.tsx")).toContain('from "../../lefine"');
  });

  it("a TanStack Start app: a server function and a /$locale route; the loader is made only inside the server function", async () => {
    pkg({ "@tanstack/react-start": "1.169.4", "@tanstack/react-router": "1.170.46" });
    mkdirSync(join(dir, "src", "routes"), { recursive: true });
    await initCommand({ dir }, undefined, fakeInstall);
    const lefine = read("src/lefine.ts");
    expect(lefine).toContain('import { createStrings } from "lefine/server";');
    expect(lefine).not.toContain("lefine/next");
    expect(lefine).toContain("export const strings = () => (made ??= createStrings(");
    expect(lefine).toContain('.handler(({ data }) => strings().load(data, ["home"]));');
    const route = read("src/routes/$locale/index.tsx");
    expect(route).toContain('createFileRoute("/$locale/")');
    expect(route).toContain('const t = useStrings("home");');
    expect(route).toContain('from "../../lefine"');
  });

  it("a locale that is not BCP 47 is refused before anything is written: it would go into code, URLs and the terminal", async () => {
    pkg({ "@tanstack/react-start": "1" });
    apps = [{ ...WEB, sourceLocale: "en\u001b]8;;http://x\u0007" }];
    await expect(initCommand({ dir, install: false })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("Unexpected locale from the server");
    expect(logs.join("\n")).not.toContain("\u001b]8");
    expect(existsSync(join(dir, "src", "lefine.ts")) || existsSync(join(dir, "lefine.ts"))).toBe(false);
    apps = [{ ...WEB, targetLocales: ['de"; evil'] }];
    await expect(initCommand({ dir, install: false })).rejects.toThrow("exit:1");
  });

  it("nothing live yet: the page says to publish instead of naming a key", async () => {
    pkg({ next: "16.4.3" });
    apps = [{ ...WEB, id: "app_00000000000000000000000000000000" }];
    await initCommand({ dir, install: false });
    expect(read("app/[locale]/page.tsx")).toContain("Publish your texts in Lefine, then reload this page.");
    expect(read("app/[locale]/layout.tsx")).toContain("namespaces={[]}");
  });
});

describe("pickSample", () => {
  it("takes the first plain text; skips ICU, markup, dotted keys and names that are not safe in code", () => {
    expect(pickSample({ "a b": { x: "y" }, nav: { "k.dot": "no", "k\"q": "no", icu: "{n} items", tag: "<b>x</b>", ok: "Pricing" } })).toEqual({ namespace: "nav", key: "ok" });
    expect(pickSample({ nav: { only: "{n}" } })).toBeNull();
    expect(pickSample(null)).toBeNull();
  });
});
