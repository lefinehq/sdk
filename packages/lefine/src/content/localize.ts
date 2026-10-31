/**
 * A draft's data as one language reads it, for preview. The editor stores a translated field as `{ [locale]: value }`; the edge
 * file has it already picked. This does the same walk as Lefine's publish: tabs and unnamed groups add no key, a named group or tab nests, rows of a
 * non-translated list or section list hold translated fields of their own, and an empty value reads the next language of the chain.
 */

export interface ModelField {
  type: string;
  name?: string;
  localized?: boolean;
  fields?: ModelField[];
  tabs?: Array<{ name?: string; fields: ModelField[] }>;
  blocks?: Array<{ slug: string; fields: ModelField[] }>;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const own = (obj: unknown, key: string): unknown =>
  isObject(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined;

function hasText(node: unknown): boolean {
  if (!isObject(node)) return false;
  if (typeof node.text === "string" && node.text.trim() !== "") return true;
  const children = Array.isArray(node.children)
    ? node.children
    : isObject(node.root)
      ? [node.root]
      : [];
  return children.some(hasText);
}

/** Lefine's "no value": null, undefined, "" and a rich text without words. */
function isMissing(type: string, value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  return type === "richText" && isObject(value) && !hasText(value);
}

/** The value of a translated slot for the first language of `chain` that has one. Keys are matched case-insensitively. */
function pick(
  value: unknown,
  type: string,
  chain: readonly string[],
): { value: unknown; from: string | null } {
  if (!isObject(value)) return { value: null, from: null };
  const byLower = new Map(Object.keys(value).map((k) => [k.toLowerCase(), k]));
  for (const locale of chain) {
    const key = byLower.get(locale);
    const v = key === undefined ? undefined : value[key];
    if (!isMissing(type, v)) return { value: v, from: locale };
  }
  return { value: null, from: null };
}

/**
 * `chain` is lowercase, the language asked for first. Returns the data in that language and the fields that came from another one.
 */
export function localizeData(
  fields: readonly ModelField[],
  data: Json,
  chain: readonly string[],
): { data: Json; fallbacks: Array<{ path: string; from: string }> } {
  const fallbacks: Array<{ path: string; from: string }> = [];
  const out = level(fields, data, "", false, chain, fallbacks);
  return { data: out, fallbacks };
}

function level(
  fields: readonly ModelField[],
  data: Json,
  path: string,
  parentLocalized: boolean,
  chain: readonly string[],
  fallbacks: Array<{ path: string; from: string }>,
): Json {
  const out: Json = {};
  const visit = (list: readonly ModelField[]) => {
    for (const field of list) {
      if (field.type === "tabs") {
        for (const tab of field.tabs ?? []) {
          if (tab.name)
            out[tab.name] = level(
              tab.fields,
              isObject(own(data, tab.name))
                ? (own(data, tab.name) as Json)
                : {},
              join(path, tab.name),
              parentLocalized,
              chain,
              fallbacks,
            );
          else visit(tab.fields);
        }
        continue;
      }
      if (!field.name) {
        if (field.type === "group") visit(field.fields ?? []);
        continue;
      }
      const name = field.name;
      const here = join(path, name);
      const value = own(data, name);
      if (field.localized && !parentLocalized) {
        const picked = pick(value, field.type, chain);
        out[name] = picked.value;
        if (picked.from !== null && picked.from !== chain[0])
          fallbacks.push({ path: here, from: picked.from });
      } else if (field.type === "group" && isObject(value)) {
        out[name] = level(
          field.fields ?? [],
          value,
          here,
          parentLocalized,
          chain,
          fallbacks,
        );
      } else if (
        (field.type === "array" || field.type === "blocks") &&
        Array.isArray(value)
      ) {
        out[name] = value.map((row, i) => {
          if (!isObject(row)) return null;
          const inside =
            field.type === "array"
              ? field.fields
              : field.blocks?.find((b) => b.slug === row.blockType)?.fields;
          if (!inside) return null;
          return {
            ...(row.id !== undefined ? { id: row.id } : {}),
            ...(row.blockType !== undefined
              ? { blockType: row.blockType }
              : {}),
            ...level(
              inside,
              row,
              join(here, String(i)),
              parentLocalized,
              chain,
              fallbacks,
            ),
          };
        });
      } else {
        out[name] = value ?? null;
      }
    }
  };
  visit(fields);
  return out;
}

const join = (parent: string, key: string) =>
  parent ? `${parent}.${key}` : key;
