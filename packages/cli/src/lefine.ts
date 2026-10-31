#!/usr/bin/env node
/**
 * Lefine CLI (`lefine`). Separate entry from `better-i18n`, which keeps
 * working exactly as before for existing Better users.
 */

import { program, type Command } from "commander";
import { readFileSync } from "node:fs";
import { loginCommand, logoutCommand, whoamiCommand } from "./lefine/auth-commands.js";
import { resolveLefineAuth } from "./lefine/credentials.js";
import { actionsCommand, runCommand } from "./lefine/actions-commands.js";
import { importCommand } from "./lefine/import-command.js";
import { ciTrustAddCommand, ciTrustListCommand, ciTrustRemoveCommand } from "./lefine/ci-commands.js";
import { contentPageCommand, contentPagesCommand, contentProjectsCommand, contentPublishCommand } from "./lefine/content-manage.js";
import { contentTypesCommand } from "./lefine/content-types.js";
import { contentPushCommand } from "./lefine/content-push.js";
import { initCommand } from "./lefine/init-command.js";
import { runBridge } from "./lefine/mcp-bridge.js";
import { migrateCommand } from "./lefine/migrate.js";

import {
  stringsCheckCommand,
  stringsPublishCommand,
  stringsPullCommand,
  stringsPushCommand,
  stringsStatusCommand,
  stringsTypesCommand,
} from "./lefine/strings-commands.js";
import { stringsMissingCommand, stringsUnusedCommand } from "./lefine/strings-usage.js";
import { lefineDoctorCommand } from "./lefine/doctor-command.js";
import { stringsSnapshotCommand } from "./lefine/strings-snapshot.js";
import { appsCommand, keysCreateCommand, keysDeleteCommand, keysListCommand, languagesAddCommand, runsCommand } from "./lefine/strings-manage.js";

/* No project env-file loading here, on purpose: a cloned project must not be
   able to set LEFINE_API_URL or LEFINE_TOKEN and redirect the user's key. */

/* The version of the package this file runs from (`dist/lefine.js` sits one
   level under the package root). Read at run time so it works on Node
   without JSON import attributes. */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };

program
  .name("lefine")
  .description("Lefine from the terminal: sign in, then push, check, publish and pull your strings")
  .version(pkg.version);

program
  .command("login")
  .description("Sign in through the browser (device code, works over SSH)")
  .option("--token <key>", "Use an access key (lfn_...) instead of the browser")
  .option("--no-browser", "Do not try to open the browser")
  .option("--api-url <url>", "API origin (default: LEFINE_API_URL or https://dash.lefine.ai)")
  .option("--json", "Machine-readable output")
  .action((options) => loginCommand(options));

program
  .command("init")
  .description("Sign in, pick the app, install lefine, and write lefine.ts plus a first translated page for Next or TanStack Start")
  .option("--app <id|slug>", "The app, without the question (CI)")
  .option("-d, --dir <path>", "The app's directory")
  .option("-o, --output <path>", "Where lefine.ts goes (default: the framework's place)")
  .option("--force", "Replace an existing lefine.ts (never your pages)")
  .option("--no-install", "Do not add lefine to package.json")
  .option("--api-url <url>", "API origin")
  .option("--json", "Machine-readable output")
  .action((options) => initCommand(options));

program
  .command("logout")
  .description("Remove the saved key from this machine")
  .option("--json", "Machine-readable output")
  .action(logoutCommand);

program
  .command("whoami")
  .description("Show who you are signed in as")
  .option("--api-url <url>", "API origin")
  .option("--json", "Machine-readable output")
  .action(whoamiCommand);

const strings = program.command("strings").description("Your app's strings: pull, push, check, unused, missing, publish, status, types, keys, runs, languages");

const projectOptions = (cmd: ReturnType<typeof program.command>) =>
  cmd
    .option("-p, --project <app-id>", "The app's id, app_... (default: from lefine.ts or i18n.config.ts). workspace/app also works, as an alias")
    .option("-d, --dir <path>", "Directory with the config and code")
    .option("--api-url <url>", "API origin")
    .option("--json", "Machine-readable output");

projectOptions(program.command("doctor").description("One report and a 0-100 score: hard-coded text in the code, texts that break, missing and unused keys"))
  .option("--threshold <score>", "Fail under this score (default 70)")
  .option("--verbose", "Show every finding")
  .action((options) => lefineDoctorCommand(options));

strings
  .command("pull")
  .description("Download translations from the CDN to local JSON files")
  .option("-p, --project <app-id>", "The app's id, app_... (default: from i18n.config.ts). workspace/app also works, as an alias")
  .option("-o, --output <path>", "Output directory (default: ./locales)")
  .option("-l, --locales <codes>", "Comma-separated locale codes (default: all)")
  .option("-d, --dir <path>", "Directory with the config")
  .option("--cdn-url <url>", "CDN origin (default: LEFINE_CDN_URL or https://cdn.lefine.ai)")
  .option("--since <revision>", "List what changed since this revision first")
  .option("--force", "Download every locale even when it is unchanged since the last pull")
  .option("--verbose", "Show detail per locale")
  .option("--json", "Machine-readable output")
  .action(stringsPullCommand);

projectOptions(strings.command("push").description("Show what would change, then push the source file (or translations) to Lefine"))
  .option("--file <path>", "Source locale file: JSON, YAML, XLIFF, Android XML or .properties (default: <output>/<default locale>.json)")
  .option("--namespace <name>", "For a YAML, XLIFF, XML or .properties file: its namespace (default: the file's name)")
  .option("--locale <code>", "The file's language (default: the source). Another language sets its translations")
  .option("--all [folder]", "Every language file in the folder (default: <output>): de.json or i18next's de/common.json. Source first")
  .option("-y, --yes", "Apply without asking (required in CI)")
  .action((options) => stringsPushCommand(options));

projectOptions(strings.command("check").description("Server checks (ICU, placeholders, markup) plus a scan of your code"))
  .option("--file <path>", "Source locale file")
  .option("--locale <code>", "Source locale")
  .action(stringsCheckCommand);

projectOptions(strings.command("unused").description("Keys in Lefine your code never uses (a scan of the code, compared on the server)"))
  .option("--namespace <name>", "Only this namespace")
  .option("--ci", "Exit 1 when a key is unused")
  .option("--delete", "Delete them (a person approves it in Lefine; the CLI opens the page and waits)")
  .option("--approval <id>", "Run a delete a person already approved")
  .option("-y, --yes", "Skip the question here; the person still approves in Lefine")
  .action((options) => stringsUnusedCommand(options));

projectOptions(strings.command("missing").description("Names in your code with no key in Lefine (users would see the raw name)"))
  .option("--namespace <name>", "Only this namespace")
  .action((options) => stringsMissingCommand(options));

projectOptions(strings.command("publish").description("Publish to the CDN after a person approves it in Lefine, and wait until every locale is verified"))
  .option("-y, --yes", "Skip the question here; a person still approves the publish in Lefine (the CLI opens the page and waits)")
  .action((options) => stringsPublishCommand(options));

projectOptions(strings.command("status").description("Live revision, pending changes and the last CDN check")).action(
  stringsStatusCommand,
);

projectOptions(strings.command("types").description("Write a .d.ts with every key of the app, so the editor knows keys added in Lefine"))
  .option("-o, --output <path>", "File to write (default: lefine-strings.d.ts)")
  .option("--binding <name>", "Register the types with next-intl, use-intl, lefine/strings or none (default: from package.json)")
  .action(stringsTypesCommand);

projectOptions(strings.command("snapshot").description("Write the published texts to a file for createLefine({ snapshot }): the first request after a deploy is served from it"))
  .option("-o, --output <path>", "File to write (default: lefine-snapshot.json)")
  .option("--cdn-url <url>", "CDN origin (default: LEFINE_CDN_URL or https://cdn.lefine.ai)")
  .action((options) => stringsSnapshotCommand(options));

const keys = strings.command("keys").description("The app's keys: list, create, delete");
projectOptions(keys.command("list").description("Keys with their source text (or --locale), page by page"))
  .option("--namespace <name>", "Only this namespace")
  .option("--search <text>", "Part of the key or of any of its texts")
  .option("--locale <code>", "Which text to show (default: the source locale)")
  .option("--limit <n>", "Keys per page, 1-200 (default 50)")
  .option("--all", "Every page")
  .action((options) => keysListCommand(options));
projectOptions(keys.command("create <namespace.key>").description("Add a key (live with the next publish)"))
  .option("--text <source>", "Its source text")
  .option("--description <text>", "A note for translators")
  .action((name, options) => keysCreateCommand(name, options));
projectOptions(keys.command("delete <keys...>").description("Delete keys by namespace.key or id (a person approves it in Lefine)"))
  .option("--approval <id>", "Run a delete a person already approved")
  .option("-y, --yes", "Skip the question here; the person still approves in Lefine")
  .action((names, options) => keysDeleteCommand(names, options));

projectOptions(strings.command("runs [id]").description("Recent syncs, imports and publishes, or one with its steps"))
  .option("--kind <kind>", "Only this kind of run")
  .option("--limit <n>", "How many, 1-50 (default 10)")
  .action((id, options) => runsCommand(id, options));

const languages = strings.command("languages").description("The app's languages");
projectOptions(languages.command("add <locale>").description("Add a language (a person approves it in Lefine)"))
  .option("--approval <id>", "Run an add a person already approved")
  .action((locale, options) => languagesAddCommand(locale, options));

program
  .command("apps")
  .description("Your workspace's apps, with their ids")
  .option("--api-url <url>", "API origin")
  .option("--json", "Machine-readable output")
  .action(appsCommand);

projectOptions(
  program
    .command("import <path>")
    .description("Move in from Crowdin, Lokalise, Phrase, Transifex or POEditor: their export (a file or folder of JSON, XLIFF or PO) with keys, translations and review state"),
)
  .requiredOption("--from <tool>", "crowdin, lokalise, phrase, transifex or poeditor")
  .option("--locale <code>", "The language of a file that does not say it (POEditor JSON, an XLIFF with no target language)")
  .option("--include-fuzzy", "PO entries marked fuzzy (needs review in the tool) come in as reviewed instead of being left out")
  .option("--namespace <name>", "Namespace for keys with no dot in them (default common)")
  .option("--state <state>", "For a format with no review state: reviewed (default) or approved (an export made with the tool's approved-only filter)")
  .option("-y, --yes", "Apply without asking (required in CI)")
  .action((path, options) => importCommand(path, options));

program
  .command("actions [words...]")
  .description("Search every action this key can run, in every module: name, what it does, its input")
  .option("--module <module>", "Only strings, content, studio, social or integrations")
  .option("--limit <n>", "How many, 1-10 (default 10)")
  .option("--api-url <url>", "API origin")
  .option("--json", "Machine-readable output")
  .action((words, options) => actionsCommand(words ?? [], options));

program
  .command("run <action>")
  .description("Run one action by its name (see lefine actions); one that asks first waits for a person's yes in Lefine")
  .option("--input <json>", "The input: JSON, @file.json, or - for stdin")
  .option("--approval <id>", "Run an action a person already approved")
  .option("--api-url <url>", "API origin")
  .option("--json", "Machine-readable output")
  .action((action, options) => runCommand(action, options));

const ci = program.command("ci").description("CI sign-in: GitHub Actions runs that sign in with no stored secret");
const trust = ci.command("trust").description("Which GitHub repositories may sign in to the app from GitHub Actions");

projectOptions(trust.command("add <owner/name>").description("Let this repository's GitHub Actions runs sign in to the app (a person approves it in Lefine)"))
  .option("--repository-id <id>", "GitHub's numeric id (default: from gh or GitHub's API)")
  .option("--ref <ref>", "Only runs on this branch or ref (main, refs/tags/v1)")
  .option("--environment <name>", "Only jobs in this GitHub environment")
  .option("--level <level>", "read, write or publish (default write; a publish still asks a person)")
  .option("--approval <id>", "Run an add a person already approved")
  .action((repository, options) => ciTrustAddCommand(repository, options));

projectOptions(trust.command("list").description("The repositories the app trusts")).action(ciTrustListCommand);

projectOptions(trust.command("remove <id>").description("Stop a repository from signing in")).action((id, options) => ciTrustRemoveCommand(id, options));

const content = program.command("content").description("Your website content: projects, pages, publish, and typed models for lefine/content");

const contentOptions = (cmd: Command) =>
  cmd
    .option("-p, --project <id|slug>", "Content project (default: the only one in the workspace)")
    .option("--api-url <url>", "API origin")
    .option("--json", "Machine-readable output");

contentOptions(content.command("projects").description("Your workspace's Content projects, with their ids and languages")).action(contentProjectsCommand);

contentOptions(content.command("pages").description("A project's pages, newest first, with what is live in each language"))
  .option("--type <slug|id>", "Only this content type")
  .option("--search <text>", "Part of the title or slug")
  .option("--missing <locale>", "Only pages that still need this language")
  .option("--slug <slugs>", "Only these slugs, comma-separated (up to 50)")
  .option("--status <status>", "Only pages that are published, changed, not-published, offline or scheduled in --locale")
  .option("--locale <code>", "The language --status and a translated --where field are read in (default: the main language)")
  .option("--where <field=value>", "Only pages whose field has this value; repeat for more (AND). field:=json for a typed value: featured:=true, views:=3. Needs --type", (v: string, prev: string[] = []) => [...prev, v])
  .option("--expand <fields>", "Show the pages these relation fields point at, comma-separated (up to 5). Needs --type")
  .option("--sort <field>", "updatedAt (default) or createdAt")
  .option("--order <order>", "desc (default) or asc")
  .option("--limit <n>", "Pages per call, 1-50 (default 20)")
  .option("--all", "Every page")
  .action(contentPagesCommand);

contentOptions(content.command("page <id>").description("One page: its languages and its data")).action((id, options) => contentPageCommand(id, options));

contentOptions(content.command("publish <id>").description("Publish a page's latest version (a person approves it in Lefine; the CLI opens the page and waits)"))
  .option("--locales <codes>", "Comma-separated languages (default: every language of the project)")
  .option("--approval <id>", "Run a publish a person already approved")
  .option("-y, --yes", "Skip the question here; a person still approves in Lefine")
  .action((id, options) => contentPublishCommand(id, options));

contentOptions(content.command("push").description("Make Lefine's content types match lefine.config.ts: shows the diff first, never deletes; a type change is approved in Lefine"))
  .option("-c, --config <path>", "Config file (default: lefine.config.ts, .mts, .mjs, .js or .json here)")
  .option("-d, --dir <path>", "Directory to look in")
  .option("--dry-run", "Show what would change and stop")
  .option("-y, --yes", "Skip the question here; a type change is still approved in Lefine")
  .action((options) => contentPushCommand(options));

content
  .command("types")
  .description("Write a TypeScript file with one type per content type of a Content project")
  .option("-p, --project <id|slug>", "Content project (default: the only one in the workspace)")
  .option("-o, --output <path>", "File to write (default: lefine-content.ts)")
  .option("-d, --dir <path>", "Directory to write in")
  .option("--api-url <url>", "API origin")
  .option("--json", "Machine-readable output")
  .action(contentTypesCommand);

program
  .command("migrate [dir]")
  .description("Move next-intl / @better-i18n code to lefine: rewrites what maps one to one, lists the rest (dry run unless --write)")
  .option("--write", "Change the files")
  .option("--lefine-import <path>", "Where your lefine.ts is imported from (default: @/lefine)")
  .action((dir, options) => migrateCommand(dir, options));

program
  .command("mcp")
  .description("Lefine as a local MCP server (stdio) for Claude Desktop and IDEs; remote clients can use https://dash.lefine.ai/v1/mcp")
  .action(async () => {
    const found = resolveLefineAuth({});
    if (!found) process.stderr.write("lefine mcp: not signed in. Run `npx lefine login` or set LEFINE_TOKEN.\n");
    await runBridge(process.stdin, {
      auth: found ? { token: found.token, apiUrl: found.apiUrl } : null,
      fetch,
      write: (line) => process.stdout.write(`${line}\n`),
      log: (line) => process.stderr.write(`${line}\n`),
      clientVersion: pkg.version,
    });
  });

program.parse();
