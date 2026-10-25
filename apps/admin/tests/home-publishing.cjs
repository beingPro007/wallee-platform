const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm"),
  ts = require("typescript");
const root = path.resolve(__dirname, "..");
let objects, writes, dbRows, writeAllowed, clock, conflict;
const clone = (x) => JSON.parse(JSON.stringify(x));
class Query {
  constructor() {
    this.filters = [];
    this.op = "read";
  }
  select() {
    return this;
  }
  order() {
    return this;
  }
  eq(k, v) {
    this.filters.push([k, v]);
    return this;
  }
  update(v) {
    this.op = "update";
    this.value = v;
    return this;
  }
  insert(v) {
    this.op = "insert";
    this.value = v;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  single() {
    return this.exec(true);
  }
  then(a, b) {
    return Promise.resolve(this.exec(false)).then(a, b);
  }
  exec(single) {
    let rows = dbRows.filter((r) => this.filters.every(([k, v]) => r[k] === v));
    if (this.op !== "read" && !writeAllowed) return { data: [], error: null };
    if (this.op === "insert") {
      const row = { ...this.value, id: "new", updated_at: String(++clock) };
      dbRows.push(row);
      rows = [row];
    }
    if (this.op === "update")
      rows.forEach((r) =>
        Object.assign(r, this.value, { updated_at: String(++clock) }),
      );
    if (this.op === "delete") dbRows = dbRows.filter((r) => !rows.includes(r));
    return { data: clone(single ? rows[0] : rows), error: null };
  }
}
const db = { from: () => new Query() };
const missing = () =>
  Object.assign(new Error("missing"), { name: "NoSuchKey" });
const storage = {
  send: async (command) => {
    const x = command.input;
    switch (command.constructor.name) {
      case "ListObjectsV2Command":
        return {
          Contents: [...objects.keys()]
            .filter((k) => k.startsWith(x.Prefix))
            .map((Key) => ({ Key })),
          IsTruncated: false,
        };
      case "GetObjectCommand":
        if (!objects.has(x.Key)) throw missing();
        return {
          Body: { transformToString: async () => objects.get(x.Key) },
          ETag: "etag",
        };
      case "PutObjectCommand":
        if (x.Key === "wallpapers_v2.json" && conflict) {
          conflict = false;
          throw Object.assign(new Error("conflict"), {
            name: "PreconditionFailed",
          });
        }
        writes.push(x);
        objects.set(x.Key, String(x.Body));
        return {};
      default:
        throw new Error("Unexpected S3 command");
    }
  },
};
const cache = new Map();
function load(file) {
  file = path.resolve(root, file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} };
  cache.set(file, mod);
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const customRequire = (id) => {
    if (id === "server-only") return {};
    if (id === "@/lib/s3") return { s3Client: storage };
    if (id === "@aws-sdk/client-sts")
      return {
        STSClient: class {
          async send() {
            return { Arn: "arn:aws:iam::071788126830:user/Gautam" };
          }
        },
        GetCallerIdentityCommand: class {},
      };
    if (id.startsWith("."))
      return load(
        path.relative(root, path.resolve(path.dirname(file), id + ".ts")),
      );
    return require(id);
  };
  vm.runInThisContext(
    "(function(require,module,exports,process){" + js + "\n})",
    { filename: file },
  )(customRequire, mod, mod.exports, process);
  return mod.exports;
}
process.env.AWS_BUCKET_NAME = "test-bucket";
process.env.CLOUDFRONT_URL = "https://test.example";
const service = load("lib/home/service.ts");
const catalog = load("lib/home/catalog.ts");
function reset() {
  clock = 1;
  writeAllowed = true;
  conflict = false;
  writes = [];
  dbRows = [
    {
      id: "one",
      name: "Collection",
      slug: "collection",
      s3_prefix: "premium/collection/",
      updated_at: "1",
      position: 1,
      is_enabled: false,
      is_fresh_drops: false,
      json_url: "https://test.example/sessions/collection.json",
      cover_image_url: "https://test.example/wallpapers/collection/a.jpg",
      wallpaper_count: 2,
    },
  ];
  objects = new Map([
    [
      "sessions/collection.json",
      JSON.stringify({
        wallpapers: [
          {
            p: "collection/a.jpg",
            t: "thumbs/collection/a.webp",
            w: 100,
            h: 200,
          },
          { p: "collection/missing.jpg", w: 100, h: 200 },
        ],
      }),
    ],
    [
      "wallpapers_v2.json",
      JSON.stringify({
        version: 2,
        wallpapers: [
          { p: "collection/b.jpg", w: 200, h: 400 },
          { p: "unrelated/keep.jpg", w: 2, h: 3 },
        ],
      }),
    ],
    ["collection/a.jpg", "image"],
    ["collection/b.jpg", "image"],
    ["thumbs/collection/a.webp", "thumb"],
    ["thumbs/collection/b.webp", "thumb"],
  ]);
}
(async () => {
  let passed = 0;
  async function test(name, fn) {
    reset();
    await fn();
    passed++;
    console.log("PASS", name);
  }
  await test("preserves prior images after queue cleanup, adds saved images, counts missing references", async () => {
    const p = await service.previewSection(db, "one");
    assert.equal(p.count, 2);
    assert.equal(p.added, 1);
    assert.equal(p.missing, 1);
    assert.equal(p.entries[1].w, 200);
    assert.equal(p.missingPreviews, 0);
    assert.equal(writes.length, 0);
  });
  await test("publish preserves visibility and cover, creates immutable JSON, preserves master entries, retries concurrent merge", async () => {
    const p = await service.previewSection(db, "one");
    conflict = true;
    const result = await service.publish(db, "one", p.token);
    assert.match(result.jsonUrl, /sessions\/collection\/.*\.json$/);
    assert.equal(dbRows[0].is_enabled, false);
    assert.equal(
      dbRows[0].cover_image_url,
      "https://test.example/collection/a.jpg",
    );
    assert.equal(
      JSON.parse(objects.get("sessions/collection.json")).wallpapers.length,
      2,
    );
    const master = JSON.parse(objects.get("wallpapers_v2.json")).wallpapers;
    assert(master.some((e) => e.p === "unrelated/keep.jpg"));
    assert.equal(master.find((e) => e.p === "collection/a.jpg").s, 1);
  });
  await test("stale previews cannot publish", async () => {
    const p = await service.previewSection(db, "one");
    objects.set("collection/new.jpg", "image");
    await assert.rejects(
      service.publish(db, "one", p.token),
      /changed since the preview/,
    );
    assert.equal(writes.length, 0);
  });
  await test("RLS denial stops before storage writes", async () => {
    const p = await service.previewSection(db, "one");
    writeAllowed = false;
    await assert.rejects(
      service.publish(db, "one", p.token),
      /Nothing was saved/,
    );
    assert.equal(writes.length, 0);
  });
  await test("empty rebuild never overwrites the existing catalog", async () => {
    for (const k of ["collection/a.jpg", "collection/b.jpg"]) objects.delete(k);
    const p = await service.previewSection(db, "one");
    await assert.rejects(
      service.publish(db, "one", p.token),
      /No processed images/,
    );
    assert.equal(writes.length, 0);
  });
  await test("failed metadata save keeps the original active catalog URL", async () => {
    const p = await service.previewSection(db, "one");
    const send = storage.send;
    storage.send = async (c) => {
      const r = await send(c);
      if (
        c.constructor.name === "PutObjectCommand" &&
        c.input.Key === "wallpapers_v2.json"
      )
        writeAllowed = false;
      return r;
    };
    try {
      await assert.rejects(
        service.publish(db, "one", p.token),
        /Nothing was saved/,
      );
      assert.equal(
        dbRows[0].json_url,
        "https://test.example/sessions/collection.json",
      );
    } finally {
      storage.send = send;
    }
  });
  await test("new sections start hidden and unsafe folders are rejected", async () => {
    const r = await service.create(db, {
      name: "New section",
      slug: "new_section",
      prefix: "anime/",
    });
    assert.equal(r.is_enabled, false);
    assert.throws(
      () => catalog.validPrefix("raw_images/anime"),
      /processed image folder/,
    );
    assert.throws(
      () => catalog.validPrefix("../anime"),
      /processed image folder/,
    );
  });
  await test("stale edits and a second Fresh Drops section are rejected", async () => {
    await assert.rejects(
      service.update(db, "one", "old", { name: "New" }),
      /changed/,
    );
    dbRows.push({
      ...dbRows[0],
      id: "two",
      is_fresh_drops: true,
      name: "Other",
    });
    await assert.rejects(
      service.update(db, "one", "1", { is_fresh_drops: true }),
      /Other/,
    );
  });
  await test("reordering persists and ignores no database failures", async () => {
    dbRows.push({ ...dbRows[0], id: "two", position: 2 });
    await service.reorder(db, ["two", "one"]);
    assert.equal(dbRows.find((s) => s.id === "two").position, 1);
    writeAllowed = false;
    await assert.rejects(service.reorder(db, ["one", "two"]), /interrupted/);
  });
  await test("invalid catalog payload aborts before publication", async () => {
    objects.set("sessions/collection.json", '{"wallpapers":"invalid"}');
    await assert.rejects(service.previewSection(db, "one"), /invalid/);
    assert.equal(writes.length, 0);
  });
  console.log(`${passed} publishing tests passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
