import wasmModule from "./generated/turnocerto.wasm";
import "./generated/wasm_exec.js";

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

type GoConstructor = new () => GoRuntime;
type GoRequestHandler = (request: Request, env: WorkerEnvironment) => Promise<Response>;

interface WorkerEnvironment {
  APP_ENV: string;
  CREATION_RATE_LIMITER: RateLimit;
  DB: D1Database;
  PREVIEW_TOKEN_HASH?: string;
  TURNSTILE_ALLOWED_HOSTNAME?: string;
  TURNSTILE_SECRET_KEY?: string;
  WEB_ORIGIN: string;
}

interface GoGlobals {
  Go?: GoConstructor;
  turnocertoFetch?: GoRequestHandler;
}

const goGlobals = globalThis as typeof globalThis & GoGlobals;
let goFailure = false;
let goHandlerPromise: Promise<GoRequestHandler> | undefined;

function startGo(): Promise<GoRequestHandler> {
  if (!goHandlerPromise) {
    goHandlerPromise = (async () => {
      if (!goGlobals.Go) throw new Error("Go WebAssembly runtime is unavailable");
      const runtime = new goGlobals.Go();
      const instance = await WebAssembly.instantiate(wasmModule, runtime.importObject);
      const exit = runtime.run(instance);
      void exit.catch(() => {
        goFailure = true;
      });
      const handler = goGlobals.turnocertoFetch;
      if (!handler) throw new Error("Go API did not initialize");
      return handler;
    })();
  }
  return goHandlerPromise;
}

function unavailableResponse(): Response {
  // This transport fallback runs only if Go cannot start; it has no application or CORS behavior.
  return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
}

export default {
  async fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    try {
      if (goFailure) return unavailableResponse();
      return await (await startGo())(request, env);
    } catch {
      return unavailableResponse();
    }
  },
} satisfies ExportedHandler<WorkerEnvironment>;
