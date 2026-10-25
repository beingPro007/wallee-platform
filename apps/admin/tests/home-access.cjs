const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm"),
  ts = require("typescript");
let status = 401,
  calls = 0;
class AccessError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const result = {};
const code = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, "../app/api/home/route.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const requireMock = (id) => {
  if (id === "next/server") return { NextResponse: Response };
  if (id === "@/lib/ops/auth")
    return {
      AccessError,
      requireOpsUser: async () => {
        if (status) throw new AccessError(status, "Denied");
      },
    };
  if (id === "@/lib/supabase/server")
    return {
      createClient: async () => {
        calls++;
        return {};
      },
    };
  if (id === "@/lib/home/service")
    return {
      sections: async () => [],
      create: async () => ({ id: "new" }),
      previewSection: async () => ({ count: 2 }),
    };
  throw new Error(id);
};
vm.runInThisContext("(function(require,exports){" + code + "\n})")(
  requireMock,
  result,
);
const request = (headers = {}, body = { action: "create" }) => ({
  headers: new Headers({ host: "example.com", ...headers }),
  nextUrl: new URL("https://example.com/api/home"),
  json: async () => body,
});
(async () => {
  assert.equal((await result.GET(request())).status, 401);
  assert.equal(calls, 0);
  status = 403;
  assert.equal((await result.POST(request())).status, 403);
  assert.equal(calls, 0);
  status = 0;
  assert.equal(
    (
      await result.POST(
        request({
          "content-type": "application/json",
          origin: "https://evil.example",
        }),
      )
    ).status,
    403,
  );
  assert.equal(calls, 0);
  assert.equal(
    (await result.POST(request({ "content-type": "text/plain" }))).status,
    415,
  );
  assert.equal(calls, 0);
  const r = await result.POST(
    request({
      "content-type": "application/json",
      origin: "https://example.com",
    }),
  );
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.equal((await r.json()).id, "new");
  console.log(
    "PASS home API: signed-out and unapproved denied before database access; cross-origin and non-JSON writes denied; same-origin authorized request succeeds",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
