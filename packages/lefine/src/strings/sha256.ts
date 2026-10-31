// SHA-256 as a hex string, computed synchronously. The loader checks every language file against the manifest's
// sha256. crypto.subtle.digest answers in a later task, and Next's Cache Components count that as uncached I/O:
// `next build` of a fresh create-next-app 16.4 stopped with "encountered uncached or runtime data during
// prerendering" on every [locale] page (2026-10-28, found in the npm publish dry run). Node (20.16+, 22.3+) hashes
// natively through process.getBuiltinModule; anywhere else (browser, React Native, an edge runtime) the code below.

type NodeCrypto = { createHash(algorithm: string): { update(data: Uint8Array): { digest(encoding: "hex"): string } } };

function nodeCrypto(): NodeCrypto | null {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  try {
    const mod = typeof proc?.getBuiltinModule === "function" ? (proc.getBuiltinModule("node:crypto") as NodeCrypto | undefined) : undefined;
    return typeof mod?.createHash === "function" ? mod : null;
  } catch {
    return null;
  }
}

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

let tables: { k: Uint32Array; h: Uint32Array } | null = null;

/** The constants: the first 32 bits of the fractional parts of the square (h) and cube (k) roots of the first primes. */
function constants(): { k: Uint32Array; h: Uint32Array } {
  if (tables) return tables;
  const k = new Uint32Array(64);
  const h = new Uint32Array(8);
  const frac = (x: number) => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
  for (let n = 2, i = 0; i < 64; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) prime = false;
    if (!prime) continue;
    if (i < 8) h[i] = frac(Math.sqrt(n));
    k[i++] = frac(Math.cbrt(n));
  }
  return (tables = { k, h });
}

/** The portable path. Exported for the tests, which compare it with node:crypto. */
export function sha256HexJs(bytes: Uint8Array): string {
  const { k, h: h0 } = constants();
  const len = bytes.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const view = new DataView(m.buffer);
  view.setUint32(total - 8, Math.floor(len / 2 ** 29));
  view.setUint32(total - 4, (len * 8) >>> 0);
  const h = h0.slice();
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 7]! + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10))) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => (h[i] = h[i]! + v));
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

export function sha256Hex(bytes: Uint8Array): string {
  const native = nodeCrypto();
  return native ? native.createHash("sha256").update(bytes).digest("hex") : sha256HexJs(bytes);
}
