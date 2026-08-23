// Miniflare harness for integration tests — bundles the real Worker
// (src/index.ts, including the Cell Durable Object) with esbuild and runs it
// under a local workerd instance.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { Miniflare, type MiniflareOptions } from "miniflare";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, ".integration-build");
const outFile = path.join(outDir, "worker.mjs");

export const TEST_JWT_SECRET = "integration-test-secret";
export const ORIGIN = "https://fabrica-relay.test";

let mf: Miniflare | undefined;

async function bundleWorker(): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [path.resolve(here, "../../src/index.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "esnext",
    outfile: outFile,
    external: ["cloudflare:workers", "cloudflare:test"],
    conditions: ["workerd", "worker"],
    logLevel: "silent",
  });
}

export async function startRelay(): Promise<Miniflare> {
  if (mf) return mf;
  await bundleWorker();
  const options: MiniflareOptions = {
    modules: [
      {
        type: "ESModule",
        path: outFile,
      },
    ],
    compatibilityDate: "2024-12-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      FABRICA_RELAY_JWT_SECRET: TEST_JWT_SECRET,
      DIRECTOR_URL: ORIGIN,
    },
    durableObjects: {
      CELL: { className: "Cell", useSQLite: true },
    },
  };
  mf = new Miniflare(options);
  return mf;
}

export async function stopRelay(): Promise<void> {
  if (mf) {
    await mf.dispose();
    mf = undefined;
  }
}

export async function getWorker(): Promise<{
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}> {
  const relay = await startRelay();
  const worker = await relay.getWorker();
  // Miniflare's worker fetch accepts richer input types than the DOM lib
  // RequestInit we use in tests; narrow it for the test surface
  return {
    fetch: (input: string, init?: RequestInit) =>
      worker.fetch(input, init as never) as unknown as Promise<Response>,
  };
}
