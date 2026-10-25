const fs = require("fs"),
  ts = require("typescript"),
  vm = require("vm"),
  assert = require("assert");
const src = fs.readFileSync(
  require("path").join(__dirname, "../lib/ops/auth.ts"),
  "utf8",
);
const out = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
let user;
const context = {
  exports: {},
  process: {
    env: { OPS_ADMIN_EMAILS: "admin-one@example.com,admin-two@example.com" },
  },
  require: () => ({
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user }, error: null }) },
    }),
  }),
};
vm.runInNewContext(out, context);
const { isAllowedEmail, requireOpsUser } = context.exports;
(async () => {
  for (const email of ["admin-one@example.com", "admin-two@example.com"]) {
    user = { email, email_confirmed_at: "2026-10-25" };
    assert.equal((await requireOpsUser()).email, email);
  }
  for (const item of [
    null,
    { email: "attacker@example.com", email_confirmed_at: "2026-10-25" },
    { email: "admin-one@example.com", email_confirmed_at: null },
  ]) {
    user = item;
    await assert.rejects(
      requireOpsUser(),
      (e) => e.status === (item ? 403 : 401),
    );
  }
  assert.equal(isAllowedEmail("admin-one@example.com", true, ""), false);
  console.log(
    "PASS: two allowed verified emails; unauthorized/unverified/empty-list denied",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
