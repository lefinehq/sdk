// The real React Flight renderer (what Next uses to send Server Component props to the browser), loaded with
// React's react-server build like Next does, so a test can serialize what lefine.Provider hands to the client.
import Module, { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const flightPath = require.resolve("next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-server.node.production.js");
const compiled = dirname(dirname(dirname(flightPath))); // next/dist/compiled
const serverBuilds: Record<string, string> = {
  react: `${compiled}/react/react.react-server.js`,
  "next/dist/compiled/react": `${compiled}/react/react.react-server.js`,
  "react-dom": `${compiled}/react-dom/react-dom.react-server.js`,
  "next/dist/compiled/react-dom": `${compiled}/react-dom/react-dom.react-server.js`,
};

type Resolve = (request: string, parent: unknown, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: Resolve };

export function flightRender(value: unknown): Promise<{ errors: string[] }> {
  const original = M._resolveFilename;
  // Only while this require runs (synchronous): Flight and the React it pulls in see the react-server builds.
  M._resolveFilename = (request, parent, ...rest) => serverBuilds[request] ?? original(request, parent, ...rest);
  let server: { renderToPipeableStream: (v: unknown, m: object, o: object) => { pipe: (w: object) => void } };
  try {
    server = require(flightPath);
  } finally {
    M._resolveFilename = original;
  }
  return new Promise((resolve) => {
    const errors: string[] = [];
    const { pipe } = server.renderToPipeableStream(value, {}, { onError: (e: Error) => void errors.push(e.message) });
    pipe({ write: () => true, end: () => resolve({ errors }), on() {}, once() {}, emit() {}, removeListener() {} });
  });
}
