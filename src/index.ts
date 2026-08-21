import { Hono } from "hono";
import { cors } from "hono/cors";
import { createDirectorApp } from "./director/index.js";
import { Cell } from "./cell/index.js";

type Bindings = {
  CELL: DurableObjectNamespace;
  FABRICA_RELAY_JWT_SECRET: string;
  DIRECTOR_URL: string;
};

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", cors());
app.route("/", createDirectorApp());

const HUB_ID = "relay-hub";

export default {
  async fetch(request: Request, env: Bindings, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.pathname === "/v1/host/control" ||
      url.pathname.startsWith("/v1/host/data/") ||
      url.pathname.startsWith("/v1/connect/")
    ) {
      const id = env.CELL.idFromName(HUB_ID);
      const stub = env.CELL.get(id);
      return stub.fetch(request);
    }
    return app.fetch(request, env);
  },
};

export { Cell };
