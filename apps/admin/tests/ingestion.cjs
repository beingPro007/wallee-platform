const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm"),
  ts = require("typescript");
let rows = [],
  creates = 0,
  dispatches = [],
  deny = false;
function load(file) {
  const m = { exports: {} };
  const js = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, "../lib/home", file + ".ts"), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const req = (id) => {
    if (id === "server-only") return {};
    if (id === "./catalog") return load("catalog");
    if (id === "./service")
      return {
        sections: async () => rows,
        create: async (_, v) => {
          if (deny) throw new Error("Save denied");
          creates++;
          const s = {
            id: "new",
            name: v.name,
            slug: v.slug,
            s3_prefix: v.prefix,
            is_enabled: false,
          };
          rows.push(s);
          return s;
        },
      };
    return require(id);
  };
  vm.runInThisContext("(function(require,module,exports){" + js + "\n})")(
    req,
    m,
    m.exports,
  );
  return m.exports;
}
const { sourceUrl, importCategory, startImport } = load("ingestion");
const send = async (p) => {
  dispatches.push(p);
  return { status: "processing_started", count: 1 };
};
(async () => {
  for (const url of [
    "http://pin.it/x",
    "https://pin.it.evil.test/x",
    "https://user:pass@pin.it/x",
    "https://pin.it:8443/x",
    "file:///tmp/image",
    "https://instagram.com/user/",
    "https://wallhaven.cc/",
  ])
    assert.throws(() => sourceUrl(url));
  assert.equal(sourceUrl("https://pin.it/abc#fragment"), "https://pin.it/abc");
  await startImport(
    {},
    { url: "https://pin.it/abc", destination: "auto" },
    send,
  );
  assert.equal(dispatches[0].session_slug, undefined);
  assert.equal(creates, 0);
  rows = [
    { id: "legacy", name: "Baki", slug: "baki", s3_prefix: "premium/baki/" },
    { id: "custom", name: "Weekend", slug: "weekend", s3_prefix: "anime/" },
  ];
  await startImport(
    {},
    {
      url: "https://pin.it/abc",
      destination: "collection",
      sectionId: "legacy",
    },
    send,
  );
  assert.equal(dispatches.at(-1).session_slug, "baki");
  await startImport(
    {},
    {
      url: "https://pin.it/abc",
      destination: "collection",
      sectionId: "custom",
    },
    send,
  );
  assert.equal(dispatches.at(-1).session_slug, "anime");
  assert.throws(() =>
    importCategory({
      slug: "desktop",
      s3_prefix: "desktop_wallpapers/desktop/",
    }),
  );
  await assert.rejects(
    startImport(
      {},
      {
        url: "https://pin.it/abc",
        destination: "collection",
        sectionId: "unknown",
      },
      send,
    ),
    /existing collection/,
  );
  let previous = dispatches.length;
  deny = true;
  await assert.rejects(
    startImport(
      {},
      { url: "https://pin.it/abc", destination: "new", name: "Weekend Picks" },
      send,
    ),
    /Save denied/,
  );
  assert.equal(dispatches.length, previous);
  deny = false;
  const result = await startImport(
    {},
    { url: "https://pin.it/abc", destination: "new", name: "Weekend Picks" },
    send,
  );
  assert.equal(dispatches.at(-1).session_slug, "weekend_picks");
  assert.equal(result.sectionId, "new");
  assert.equal(rows.at(-1).is_enabled, false);
  await assert.rejects(
    startImport(
      {},
      {
        url: "https://pin.it/abc",
        destination: "collection",
        sectionId: "legacy",
      },
      async () => {
        throw new Error("timeout");
      },
    ),
    (e) => e.sectionId === "legacy" && e.message.includes("before retrying"),
  );
  await assert.rejects(
    startImport(
      {},
      { url: "https://pin.it/abc", destination: "auto" },
      async () => ({ status: "error" }),
    ),
    /No confirmed/,
  );
  console.log(
    "PASS source URL validation, auto/legacy/custom/new destinations, hidden creation before dispatch, denied creation, missing collection, desktop rejection and ambiguous response handling",
  );
  let status = 401,
    calls = 0;
  class AccessError extends Error {
    constructor(s) {
      super("Denied");
      this.status = s;
    }
  }
  const exports = {};
  const route = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, "../app/api/ingest/route.ts"), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  vm.runInThisContext("(function(require,exports){" + route + "\n})")((id) => {
    if (id === "next/server") return { NextResponse: Response };
    if (id === "@/lib/ops/auth")
      return {
        AccessError,
        requireOpsUser: async () => {
          if (status) throw new AccessError(status);
        },
      };
    if (id === "@/lib/supabase/server")
      return { createClient: async () => ({}) };
    if (id === "@/lib/home/ingestion")
      return {
        ImportError: class extends Error {},
        startImport: async () => {
          calls++;
          return { accepted: true };
        },
      };
    throw Error(id);
  }, exports);
  const request = (origin = "https://example.com") => ({
    headers: new Headers({
      host: "example.com",
      origin: origin,
      "content-type": "application/json",
    }),
    json: async () => ({}),
  });
  assert.equal((await exports.POST(request())).status, 401);
  status = 403;
  assert.equal((await exports.POST(request())).status, 403);
  status = 0;
  assert.equal((await exports.POST(request("https://evil.test"))).status, 403);
  assert.equal(calls, 0);
  assert.equal((await exports.POST(request())).status, 202);
  assert.equal(calls, 1);
  console.log(
    "PASS import API authentication, allowlist denial, cross-origin rejection and accepted status",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
