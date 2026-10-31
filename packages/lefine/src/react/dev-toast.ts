// Development only: "12 strings updated in Lefine · Reload" when a publish lands while the app runs (#88, from #58).
// The provider's caller (lefine.Provider, or createStrings().load) passes where the app's manifest is and the
// revision it rendered; this asks the manifest every 5 s and, on a newer revision, counts what the release changed
// (its changes.json) for the page's language. Every caller checks process.env.NODE_ENV, so a production build drops
// this file (react/__tests__/size.test.ts).

/** Where the app's files are on the edge (`{cdn}/{appId}`) and the revision the page was rendered from. */
export interface LiveStrings {
  base: string;
  revision: number;
}

const POLL_MS = 5_000;
let watching: string | null = null;

/** Starts once per app in the page; returns the stop for React's effect. */
export function watchPublishes(live: LiveStrings | undefined, locale: string): (() => void) | undefined {
  if (!live || typeof window === "undefined" || typeof document === "undefined" || watching === live.base) return undefined;
  watching = live.base;
  let seen = live.revision;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const manifest = (await (await fetch(`${live.base}/manifest.json`, { cache: "no-store" })).json()) as { revision?: number; version?: string };
      if (typeof manifest.revision === "number" && manifest.revision > seen) {
        seen = manifest.revision;
        show(await changedCount(live.base, manifest.version, locale));
      }
    } catch {
      // The edge is not reachable from here (offline, another port): nothing to tell.
    }
    if (!stopped) timer = setTimeout(tick, POLL_MS);
  };
  let timer = setTimeout(tick, POLL_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
    watching = null;
  };
}

/** What the release changed in this language (all languages when it is not listed); null when unknown. */
async function changedCount(base: string, version: string | undefined, locale: string): Promise<number | null> {
  if (!version || !/^[a-z0-9-]{1,64}$/.test(version)) return null;
  try {
    const changes = (await (await fetch(`${base}/v/${version}/changes.json`)).json()) as { locales?: Record<string, { added?: number; changed?: number; removed?: number }> };
    const sum = (l: { added?: number; changed?: number; removed?: number }) => (l.added ?? 0) + (l.changed ?? 0) + (l.removed ?? 0);
    const all = Object.entries(changes.locales ?? {});
    const mine = all.find(([code]) => code.toLowerCase() === locale.toLowerCase());
    return mine ? sum(mine[1]) : all.reduce((n, [, l]) => n + sum(l), 0);
  } catch {
    return null;
  }
}

function show(count: number | null): void {
  document.querySelector("[data-lefine-toast]")?.remove();
  const toast = document.createElement("div");
  toast.setAttribute("data-lefine-toast", "");
  toast.setAttribute("role", "status");
  toast.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;gap:12px;align-items:center;padding:10px 14px;background:#111;color:#fff;font:13px/1.3 system-ui;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25)";
  const text = document.createElement("span");
  text.textContent = count === null ? "Strings updated in Lefine" : `${count} ${count === 1 ? "string" : "strings"} updated in Lefine`;
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  reload.style.cssText = "background:#fff;color:#111;border:0;border-radius:6px;padding:4px 10px;font:inherit;cursor:pointer";
  reload.onclick = () => location.reload();
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss");
  close.style.cssText = "background:none;color:#fff;border:0;font:16px/1 system-ui;cursor:pointer";
  close.onclick = () => toast.remove();
  toast.append(text, reload, close);
  document.body.appendChild(toast);
}
