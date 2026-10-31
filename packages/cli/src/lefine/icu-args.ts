/**
 * The arguments of an ICU text and the TypeScript type each needs, for `lefine strings types`
 * (`{count, plural, ...}` -> count: number). A small structural reader of the same grammar lefine's parser
 * reads: apostrophe quoting, `{name}`, `{name, type, ...}` with plural/select branches, tags. A text it
 * cannot read gives no types (the key stays untyped), never a wrong one.
 */

export type ArgType = "string | number" | "number" | "Date | number" | "string";

const TYPES: Record<string, ArgType> = {
  number: "number",
  plural: "number",
  selectordinal: "number",
  date: "Date | number",
  time: "Date | number",
  select: "string",
};

export function icuArgs(text: string): Record<string, ArgType> | null {
  const out: Record<string, ArgType> = {};
  let i = 0;
  const add = (name: string, type: ArgType) => {
    // A name used as a plain {name} and as a number keeps the stricter type.
    if (!out[name] || out[name] === "string | number") out[name] = type;
  };

  const message = (depth: number, counting: boolean): void => {
    while (i < text.length) {
      const c = text[i];
      if (c === "'") {
        const next = text[i + 1];
        if (next === "'") i += 2;
        else if (next === "{" || next === "}" || next === "<" || next === ">" || (next === "#" && counting)) {
          const end = text.indexOf("'", i + 1);
          i = end === -1 ? text.length : end + 1;
        } else i++;
      } else if (c === "{") argument(depth);
      else if (c === "}" && depth > 0) return;
      else i++;
    }
  };

  const argument = (depth: number): void => {
    i++; // {
    const m = /^\s*([^\s{},#<>]+)\s*(?:,\s*([a-z]+)\s*)?/.exec(text.slice(i));
    if (!m) throw new Error("bad argument");
    i += m[0].length;
    const name = m[1]!;
    const type = m[2];
    if (!type) {
      if (text[i] !== "}") throw new Error("bad argument");
      i++;
      return add(name, "string | number");
    }
    const kind = TYPES[type];
    if (!kind) throw new Error(`unknown type ${type}`);
    add(name, kind);
    if (type === "plural" || type === "selectordinal" || type === "select") {
      if (text[i] !== ",") throw new Error("expected ,");
      i++;
      // Branches: `selector {message}` until the closing brace.
      for (;;) {
        while (/\s/.test(text[i] ?? "")) i++;
        if (text[i] === "}") break;
        const sel = /^(?:offset:\s*\d+|=-?\d+|[^\s{}]+)/.exec(text.slice(i));
        if (!sel) throw new Error("bad branch");
        i += sel[0].length;
        if (sel[0].startsWith("offset:")) continue;
        while (/\s/.test(text[i] ?? "")) i++;
        if (text[i] !== "{") throw new Error("expected {");
        i++;
        message(depth + 1, type !== "select");
        if (text[i] !== "}") throw new Error("unclosed branch");
        i++;
      }
      i++;
      return;
    }
    // number / date / time style: up to the matching brace.
    let nested = 0;
    for (; i < text.length; i++) {
      if (text[i] === "{") nested++;
      else if (text[i] === "}" && nested-- === 0) break;
    }
    i++;
  };

  try {
    message(0, false);
    return out;
  } catch {
    return null;
  }
}
