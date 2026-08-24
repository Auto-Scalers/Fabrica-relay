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

export const TEST_JWT_SECRET = "integration-test-secret";
export const ORIGIN = "https://fabrica-relay.test";

const bundled = new Set<string>();
const instances = new Map<string, Miniflare>();

async function bundleWorker(id: string): Promise<string> {
  const outFile = path.join(outDir, `worker-${id}.mjs`);
  if (bundled.has(id)) return outFile;
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
  bundled.add(id);
  return outFile;
}

// extraBindings spins up an isolated instance (e.g. FABRICA_RELAY_LEASE_MS for
// the short-lease drain test); the default instance is shared/cached.
export async function startRelay(
  extraBindings?: Record<string, string>,
): Promise<Miniflare> {
  const key = extraBindings ? JSON.stringify(extraBindings) : "default";
  let mf = instances.get(key);
  if (!mf) {
    // Distinct bundle per instance so parallel vitest workers never race
    // on the same esbuild output file
    const id = key.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40) || "default";
    const outFile = await bundleWorker(id);
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
        ...extraBindings,
      },
      durableObjects: {
        CELL: { className: "Cell", useSQLite: true },
      },
    };
    mf = new Miniflare(options);
    instances.set(key, mf);
  }
  return mf;
}

export async function stopRelay(): Promise<void> {
  for (const mf of instances.values()) {
    await mf.dispose();
  }
  instances.clear();
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
