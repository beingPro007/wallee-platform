import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { s3Client } from "@/lib/s3";
import {
  assembleCatalog,
  canonical,
  parseEntries,
  sources,
  validPrefix,
  validSlug,
} from "./catalog";
import type { Entry, HomeSection, PublishPreview } from "./types";
const bucket = () => process.env.AWS_BUCKET_NAME!;
const base = () => process.env.CLOUDFRONT_URL!.replace(/\/$/, "");
const url = (key: string) =>
  base() + "/" + key.split("/").map(encodeURIComponent).join("/");
async function aws() {
  const r = await new STSClient({
    region: process.env.AWS_DEFAULT_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }).send(new GetCallerIdentityCommand({}));
  if (r.Arn !== "arn:aws:iam::071788126830:user/Gautam")
    throw new Error("Storage identity mismatch. Publishing stopped.");
}
export async function sections(client: SupabaseClient): Promise<HomeSection[]> {
  const r = await client
    .from("home_sections")
    .select("*")
    .order("position")
    .order("id");
  if (r.error)
    throw new Error("Unable to read home sections: " + r.error.message);
  return r.data || [];
}
async function section(client: SupabaseClient, id: string) {
  const r = await client
    .from("home_sections")
    .select("*")
    .eq("id", id)
    .single();
  if (r.error || !r.data)
    throw new Error("Section not found or access denied.");
  return r.data as HomeSection;
}
function checkWrite(result: {
  error: { message: string } | null;
  data: unknown[] | null;
}) {
  if (result.error) throw new Error(result.error.message);
  if (!result.data?.length)
    throw new Error(
      "Nothing was saved. The section changed or your account cannot edit it. Refresh and try again.",
    );
}
function name(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100)
    throw new Error("Enter a section name between 1 and 100 characters.");
  return value.trim();
}
export async function create(
  client: SupabaseClient,
  input: { name: string; slug: string; prefix: string },
) {
  const slug = validSlug(input.slug);
  const existing = await sections(client);
  if (existing.some((s) => s.slug === slug))
    throw new Error(
      "That collection ID already exists. Edit its existing section.",
    );
  const r = await client
    .from("home_sections")
    .insert({
      name: name(input.name),
      slug,
      s3_prefix: validPrefix(input.prefix),
      position: Math.max(0, ...existing.map((s) => s.position)) + 1,
      is_enabled: false,
      is_fresh_drops: false,
      json_url: "",
    })
    .select("*");
  checkWrite(r);
  return r.data![0];
}
export async function update(
  client: SupabaseClient,
  id: string,
  version: string,
  changes: Record<string, unknown>,
) {
  const current = await section(client, id);
  if (current.updated_at !== version)
    throw new Error("This section changed. Refresh before saving.");
  const patch: Record<string, unknown> = {};
  if ("name" in changes) patch.name = name(changes.name);
  for (const key of ["is_enabled", "is_fresh_drops"])
    if (key in changes) {
      if (typeof changes[key] !== "boolean")
        throw new Error("Invalid section setting.");
      patch[key] = changes[key];
    }
  if (
    patch.is_enabled === true &&
    (!current.json_url || current.wallpaper_count === 0)
  )
    throw new Error(
      "Publish images before showing this section on the home screen.",
    );
  if ("cover_image_url" in changes) {
    const cover = changes.cover_image_url;
    if (typeof cover !== "string" || !cover.startsWith(base() + "/"))
      throw new Error("Select a cover from this collection.");
    const preview = await previewSection(client, id);
    if (!preview.entries.some((e) => url(e.p) === cover))
      throw new Error("The cover must be one of this collection’s images.");
    patch.cover_image_url = cover;
  }
  if (!Object.keys(patch).length) throw new Error("No changes to save.");
  // The database enforces a single Fresh Drops section. Require explicitly clearing the previous choice.
  if (patch.is_fresh_drops === true) {
    const other = (await sections(client)).find(
      (s) => s.id !== id && s.is_fresh_drops,
    );
    if (other)
      throw new Error(
        `Turn off Fresh Drops on “${other.name}” first, then select this section.`,
      );
  }
  const r = await client
    .from("home_sections")
    .update(patch)
    .eq("id", id)
    .eq("updated_at", version)
    .select("*");
  checkWrite(r);
  return r.data![0];
}
export async function reorder(client: SupabaseClient, orderedIds: string[]) {
  const current = await sections(client);
  if (
    orderedIds.length !== current.length ||
    new Set(orderedIds).size !== current.length ||
    current.some((s) => !orderedIds.includes(s.id))
  )
    throw new Error("The section list changed. Refresh before reordering.");
  const changed: HomeSection[] = [];
  try {
    for (let i = 0; i < orderedIds.length; i++) {
      const row = current.find((s) => s.id === orderedIds[i])!;
      if (row.position === i + 1) continue;
      const r = await client
        .from("home_sections")
        .update({ position: i + 1 })
        .eq("id", row.id)
        .eq("updated_at", row.updated_at)
        .select("*");
      checkWrite(r);
      changed.push({ ...row, updated_at: r.data![0].updated_at });
    }
  } catch (e) {
    for (const row of changed.reverse())
      await client
        .from("home_sections")
        .update({ position: row.position })
        .eq("id", row.id)
        .eq("updated_at", row.updated_at);
    throw new Error(
      "Reordering was interrupted. Reload the list to see the saved order.",
    );
  }
}
export async function remove(client: SupabaseClient, id: string) {
  const r = await client
    .from("home_sections")
    .delete()
    .eq("id", id)
    .select("id");
  checkWrite(r);
}
async function read(key: string, optional = false) {
  try {
    const r = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket(), Key: key }),
    );
    return {
      entries: parseEntries(JSON.parse(await r.Body!.transformToString())),
      etag: r.ETag,
    };
  } catch (e) {
    if (optional && (e as { name?: string }).name === "NoSuchKey")
      return { entries: [] as Entry[], etag: undefined };
    throw e;
  }
}
async function list(prefix: string) {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const r = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    keys.push(...(r.Contents || []).map((o) => o.Key!));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}
function sessionKey(s: HomeSection) {
  if (!s.json_url) return `sessions/${validSlug(s.slug)}.json`;
  const u = new URL(s.json_url);
  if (u.origin !== new URL(base()).origin)
    throw new Error("This section points to an unsupported catalog host.");
  const key = decodeURIComponent(u.pathname.slice(1));
  if (!key.startsWith("sessions/") || key.includes(".."))
    throw new Error("Invalid collection catalog path.");
  return key;
}
async function plan(client: SupabaseClient, id: string) {
  await aws();
  const s = await section(client, id);
  const prefixes = sources(s);
  const [old, master] = await Promise.all([
    read(sessionKey(s), !s.json_url),
    read("wallpapers_v2.json"),
  ]);
  const folders = new Set([
    ...prefixes,
    ...old.entries.map(
      (e) => canonical(e.p).split("/").slice(0, -1).join("/") + "/",
    ),
  ]);
  if (folders.has("/"))
    throw new Error("Invalid image path in collection catalog.");
  const inventory = (await Promise.all([...folders].map(list))).flat();
  const available = new Set(inventory);
  const result = assembleCatalog(
    old.entries,
    master.entries,
    available,
    prefixes,
  );
  const thumbs = new Set(
    (
      await Promise.all(
        [
          ...new Set(
            result.entries.map(
              (e) => e.t!.split("/").slice(0, -1).join("/") + "/",
            ),
          ),
        ].map(list),
      )
    ).flat(),
  );
  const missingPreviews = result.entries.filter(
    (e) => !thumbs.has(e.t!),
  ).length;
  const token = createHash("sha256")
    .update(
      JSON.stringify({
        id,
        updated: s.updated_at,
        entries: result.entries,
        etag: old.etag,
        missingPreviews,
      }),
    )
    .digest("hex");
  return {
    s,
    preview: {
      ...result,
      missingPreviews,
      token,
      source: prefixes.join(" + "),
    } as PublishPreview,
  };
}
export async function previewSection(client: SupabaseClient, id: string) {
  return (await plan(client, id)).preview;
}
async function mergeMaster(entries: Entry[]) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const old = await read("wallpapers_v2.json");
    const merged = new Map(old.entries.map((e) => [e.p, e]));
    for (const e of entries)
      merged.set(
        e.p,
        merged.has(e.p) ? { ...e, ...merged.get(e.p) } : { ...e, s: 1 },
      );
    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucket(),
          Key: "wallpapers_v2.json",
          Body: JSON.stringify({
            version: 2,
            wallpapers: [...merged.values()],
          }),
          ContentType: "application/json",
          CacheControl: "public, max-age=300",
          ...(old.etag ? { IfMatch: old.etag } : { IfNoneMatch: "*" }),
        }),
      );
      return;
    } catch (e) {
      if (
        !["PreconditionFailed", "ConditionalRequestConflict"].includes(
          (e as { name: string }).name,
        ) ||
        attempt === 4
      )
        throw e;
    }
  }
}
export async function publish(
  client: SupabaseClient,
  id: string,
  expectedToken: string,
) {
  const { s, preview } = await plan(client, id);
  if (expectedToken !== preview.token)
    throw new Error(
      "Images or settings changed since the preview. Preview again before publishing.",
    );
  if (!preview.count)
    throw new Error(
      "No processed images found. Existing publication was preserved.",
    );
  // Verify write access before touching S3; RLS can silently return zero updated rows.
  const access = await client
    .from("home_sections")
    .update({ name: s.name })
    .eq("id", id)
    .eq("updated_at", s.updated_at)
    .select("*");
  checkWrite(access);
  const version = access.data![0].updated_at;
  // Immutable publication: failed metadata writes cannot replace the app’s active catalog.
  const key = `sessions/${validSlug(s.slug)}/${randomUUID()}.json`;
  const jsonUrl = url(key);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: JSON.stringify({
        version: 2,
        session: s.slug,
        name: s.name,
        wallpapers: preview.entries,
      }),
      ContentType: "application/json",
      CacheControl: "public, max-age=300",
      IfNoneMatch: "*",
    }),
  );
  await mergeMaster(preview.entries);
  let cover = s.cover_image_url;
  if (cover) {
    const key = canonical(decodeURIComponent(new URL(cover).pathname.slice(1)));
    cover = preview.entries.some((e) => e.p === key) ? url(key) : null;
  }
  const r = await client
    .from("home_sections")
    .update({
      json_url: jsonUrl,
      wallpaper_count: preview.count,
      cover_image_url: cover || url(preview.entries[0].p),
    })
    .eq("id", id)
    .eq("updated_at", version)
    .select("*");
  checkWrite(r);
  return { jsonUrl, count: preview.count, section: r.data![0] };
}
