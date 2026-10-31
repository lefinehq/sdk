/**
 * The render contract for a section list (a `blocks` field): every row goes to the renderer named by its `blockType`.
 * payload.com's RenderBlocks returns null for a block it has no component for, so a page silently loses a section. Here an
 * unknown block throws UnknownBlockError, and a block whose schema refuses it throws InvalidBlockError.
 * A schema is anything with `parse(value)` that throws on bad input (a Zod schema fits; lefine itself has no Zod dependency).
 */

/** One row of a section list as the edge delivers it: `blockType` is the block's slug, the rest are its fields. */
export interface BlockRow {
  blockType: string;
  id?: string;
  [field: string]: unknown;
}

/** Per block slug, how to draw it. The block reaches the renderer typed by its slug (`lefine content types` writes the union). */
export type BlockRenderers<B extends BlockRow, R> = { [K in B["blockType"]]: (block: Extract<B, { blockType: K }>, at: { index: number }) => R };

/** Per block slug, the schema a block must pass before it is drawn. The parsed value is what the renderer gets. */
export type BlockSchemas<B extends BlockRow> = { [K in B["blockType"]]?: { parse(value: unknown): unknown } };

export class UnknownBlockError extends Error {
  constructor(
    readonly blockType: string,
    readonly index: number,
  ) {
    super(`No renderer for block "${blockType}" (row ${index}). Add one to renderBlocks, or remove the block from the page.`);
    this.name = "UnknownBlockError";
  }
}

export class InvalidBlockError extends Error {
  constructor(
    readonly blockType: string,
    readonly index: number,
    readonly cause: unknown,
  ) {
    super(`Block "${blockType}" (row ${index}) does not match its schema: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "InvalidBlockError";
  }
}

/**
 * Draws a section list. Null or undefined is an empty page section (no rows). Throws on a row that is not a block, a block
 * with no renderer, or one its schema refuses: catch it where your framework catches render errors.
 */
export function renderBlocks<B extends BlockRow, R>(blocks: readonly B[] | null | undefined, renderers: BlockRenderers<B, R>, options: { schemas?: BlockSchemas<B> } = {}): R[] {
  if (blocks === null || blocks === undefined) return [];
  const table = renderers as Record<string, ((block: unknown, at: { index: number }) => R) | undefined>;
  const schemas = (options.schemas ?? {}) as Record<string, { parse(value: unknown): unknown } | undefined>;
  return blocks.map((block, index) => {
    const type = typeof block === "object" && block !== null ? block.blockType : undefined;
    if (typeof type !== "string") throw new UnknownBlockError(String(type), index);
    const render = Object.hasOwn(table, type) ? table[type] : undefined;
    if (!render) throw new UnknownBlockError(type, index);
    const schema = Object.hasOwn(schemas, type) ? schemas[type] : undefined;
    let value: unknown = block;
    if (schema) {
      try {
        value = schema.parse(block);
      } catch (cause) {
        throw new InvalidBlockError(type, index, cause);
      }
    }
    return render(value, { index });
  });
}
