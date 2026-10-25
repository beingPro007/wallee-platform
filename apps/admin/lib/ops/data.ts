import { unstable_cache } from "next/cache";
import { createClient } from "@supabase/supabase-js";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  GetBucketVersioningCommand,
} from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import type {
  Costs,
  Health,
  Library,
  LibraryItem,
  ObjectRow,
  Pipeline,
  Prefix,
  Resource,
  Storage,
} from "./types";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Configuration missing: ${name}`);
  return value;
}
function awsConfig() {
  return {
    region:
      process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
    credentials: {
      accessKeyId: required("AWS_ACCESS_KEY_ID"),
      secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
    },
    maxAttempts: 2,
  };
}
const identity = unstable_cache(
  async () => {
    const who = await new STSClient(awsConfig()).send(
      new GetCallerIdentityCommand({}),
    );
    if (who.Arn !== "arn:aws:iam::071788126830:user/Gautam")
      throw new Error("AWS identity mismatch: expected Gautam");
    return who.Account!;
  },
  ["ops-aws-identity-v1"],
  { revalidate: 3600 },
);
const s3 = () => new S3Client(awsConfig());
const bucket = () => required("AWS_BUCKET_NAME");
const db = () =>
  createClient(
    required("WALLEE_SUPABASE_URL"),
    required("WALLEE_SUPABASE_SERVICE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
const now = () => new Date().toISOString();
const day = (date: Date) => date.toISOString().slice(0, 10);
function problem(error: unknown) {
  const e = error as { name?: string; message?: string };
  if (
    e.message?.startsWith("Configuration missing:") ||
    e.message?.startsWith("AWS identity mismatch:")
  )
    return e.message;
  if (/AccessDenied|Unauthorized|UnrecognizedClient/.test(e.name || ""))
    return "This data source denied access. Check the server permissions.";
  return `This data source is unavailable${e.name ? ` (${e.name})` : ""}. Other panels remain available.`;
}
export async function resource<T>(fn: () => Promise<T>): Promise<Resource<T>> {
  try {
    return { data: await fn(), error: null, fetchedAt: now() };
  } catch (error) {
    console.error("Operations source failed:", (error as Error).name);
    return { data: null, error: problem(error), fetchedAt: now() };
  }
}

export const pipeline = unstable_cache(
  async (): Promise<Pipeline> => {
    const client = db();
    const [summary, runs, events, queue] = await Promise.all([
      client.rpc("ops_dashboard_summary"),
      client
        .from("ops_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(60),
      client
        .from("ops_events")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(160),
      client
        .from("upscale_queue")
        .select(
          "id,category,status,raw_s3_key,upscaled_s3_key,created_at,updated_at",
        )
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    for (const result of [summary, runs, events, queue])
      if (result.error) throw new Error("Pipeline database query failed");
    return {
      summary: summary.data,
      runs: runs.data ?? [],
      events: events.data ?? [],
      queue: queue.data ?? [],
      fetchedAt: now(),
    };
  },
  ["ops-pipeline-v1"],
  { revalidate: 15 },
);

type ManifestEntry = string | { p: string; t?: string; w?: number; h?: number };
async function manifest(key: string) {
  const obj = await s3().send(
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
  );
  const parsed = JSON.parse(await obj.Body!.transformToString());
  if (!Array.isArray(parsed.wallpapers))
    throw new Error("Invalid image manifest");
  return {
    key,
    entries: parsed.wallpapers as ManifestEntry[],
    modified: obj.LastModified?.toISOString() ?? null,
  };
}
const master = unstable_cache(
  async () => {
    await identity();
    return manifest("wallpapers_v2.json");
  },
  ["ops-v2-v2-desktop-reset"],
  { revalidate: 300 },
);
function purpose(name: string) {
  if (name === "thumbs/") return "Image previews";
  if (name === "desktop_wallpapers/") return "Processed desktop images";
  if (name === "desktop_review/") return "Awaiting desktop review";
  if (name === "desktop_pending/") return "Approved desktop inputs";
  if (name === "raw_images/") return "Processing inputs";
  if (name === "sessions/") return "Collection catalogs";
  if (name === "(root files)") return "Published catalogs";
  if (name === "wallpapers/") return "Legacy path — investigate new writes";
  return "Category images";
}
export const storage = unstable_cache(
  async (): Promise<Storage> => {
    const account = await identity();
    const client = s3();
    const inventory: ObjectRow[] = [];
    let token: string | undefined;
    do {
      const result = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket(),
          ContinuationToken: token,
          MaxKeys: 1000,
        }),
      );
      for (const item of result.Contents ?? [])
        inventory.push({
          key: item.Key!,
          bytes: item.Size ?? 0,
          modified: item.LastModified?.toISOString() ?? "",
        });
      token = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (token);
    const grouped = new Map<string, Prefix>();
    const keys = new Set(inventory.map((item) => item.key));
    for (const item of inventory) {
      const name = item.key.includes("/")
        ? item.key.split("/")[0] + "/"
        : "(root files)";
      const row = grouped.get(name) ?? {
        name,
        objects: 0,
        bytes: 0,
        purpose: purpose(name),
      };
      row.objects++;
      row.bytes += item.bytes;
      grouped.set(name, row);
    }
    const [v1, v2, versions] = await Promise.all([
      manifest("wallpapers.json"),
      manifest("wallpapers_v2.json"),
      client.send(new GetBucketVersioningCommand({ Bucket: bucket() })),
    ]);
    const manifests = [v1, v2].map((m) => ({
      key: m.key,
      entries: m.entries.length,
      modified: m.modified,
      missing: m.entries.filter(
        (e) => !keys.has(typeof e === "string" ? e : e.p),
      ).length,
    }));
    const missingThumbs = v2.entries.filter(
      (e) =>
        typeof e !== "string" &&
        !keys.has(e.t || `thumbs/${e.p.replace(/\.[^.]+$/, "")}.webp`),
    ).length;
    const desktop = inventory.filter((o) =>
      o.key.startsWith("desktop_wallpapers/"),
    );
    const v1keys = new Set(
      v1.entries.map((e) => (typeof e === "string" ? e : e.p)),
    );
    const desktopUnlisted = desktop.filter((o) => !v1keys.has(o.key)).length;
    const desktopV2 = v2.entries.filter((e) =>
      (typeof e === "string" ? e : e.p).startsWith("desktop_wallpapers/"),
    ).length;
    const issues: Storage["issues"] = [];
    for (const m of manifests)
      if (m.missing)
        issues.push({
          title: "Catalog references missing images",
          detail: m.key,
          count: m.missing,
          severity: "warning",
        });
    if (missingThumbs)
      issues.push({
        title: "Published previews are missing",
        detail: "Primary mobile catalog",
        count: missingThumbs,
        severity: "warning",
      });
    if (desktopUnlisted)
      issues.push({
        title: "Desktop images outside the catalog",
        detail:
          "Files exist in storage; review publication records before removal.",
        count: desktopUnlisted,
        severity: "warning",
      });
    if (desktop.length && !desktopV2)
      issues.push({
        title: "Desktop has no v2 publication",
        detail: "Desktop processing currently writes the legacy catalog only.",
        count: desktop.length,
        severity: "info",
      });
    if (grouped.has("wallpapers/"))
      issues.push({
        title: "Legacy folder contains current objects",
        detail: "New standard outputs should use category folders.",
        count: grouped.get("wallpapers/")!.objects,
        severity: "warning",
      });
    return {
      bucket: bucket(),
      account,
      region: awsConfig().region,
      objects: inventory.length,
      bytes: inventory.reduce((n, o) => n + o.bytes, 0),
      prefixes: [...grouped.values()].sort((a, b) => b.bytes - a.bytes),
      versioning: versions.Status ?? "Disabled",
      manifests,
      issues,
      fetchedAt: now(),
    };
  },
  ["ops-storage-v3-desktop-reset"],
  { revalidate: 900 },
);

export const costs = unstable_cache(
  async (): Promise<Costs> => {
    const account = await identity();
    const client = new CostExplorerClient({
      ...awsConfig(),
      region: "us-east-1",
    });
    const today = new Date();
    const start = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
    );
    const end = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + 1,
      ),
    );
    const previous = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1),
    );
    const previousEnd = new Date(
      Date.UTC(
        previous.getUTCFullYear(),
        previous.getUTCMonth(),
        Math.min(
          today.getUTCDate(),
          new Date(
            Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0),
          ).getUTCDate(),
        ) + 1,
      ),
    );
    const daily: Costs["daily"] = [];
    const services = new Map<string, number>();
    let estimated = false;
    let currency = "USD";
    let token: string | undefined;
    do {
      const result = await client.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: day(start), End: day(end) },
          Granularity: "DAILY",
          Metrics: ["UnblendedCost"],
          GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
          NextPageToken: token,
        }),
      );
      for (const row of result.ResultsByTime ?? []) {
        let total = 0;
        estimated ||= !!row.Estimated;
        for (const group of row.Groups ?? []) {
          const amount = Number(group.Metrics?.UnblendedCost?.Amount ?? 0);
          const name = group.Keys?.[0] || "Other";
          currency = group.Metrics?.UnblendedCost?.Unit || currency;
          total += amount;
          services.set(name, (services.get(name) ?? 0) + amount);
        }
        const existing = daily.find((d) => d.date === row.TimePeriod?.Start);
        if (existing) existing.total += total;
        else daily.push({ date: row.TimePeriod!.Start!, total });
      }
      token = result.NextPageToken;
    } while (token);
    const prior = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: day(previous), End: day(previousEnd) },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
      }),
    );
    return {
      account,
      start: day(start),
      end: day(end),
      currency,
      total: daily.reduce((n, d) => n + d.total, 0),
      previousTotal: (prior.ResultsByTime ?? []).reduce(
        (n, r) => n + Number(r.Total?.UnblendedCost?.Amount ?? 0),
        0,
      ),
      previousDays: Math.round((+previousEnd - +previous) / 86400000),
      estimated,
      daily: daily.sort((a, b) => a.date.localeCompare(b.date)),
      services: [...services]
        .map(([name, total]) => ({ name, total }))
        .sort((a, b) => b.total - a.total),
      fetchedAt: now(),
    };
  },
  ["ops-costs-v1"],
  { revalidate: 21600 },
);

export const health = unstable_cache(
  async (): Promise<Health> => {
    await identity();
    const client = new CloudWatchClient({
      ...awsConfig(),
      region: "us-east-1",
    });
    const end = new Date();
    const start = new Date(+end - 86400000);
    const dist = process.env.CLOUDFRONT_DISTRIBUTION_ID || "E2VYY9XQB5FRGW";
    const query = (metric: string, statistic: "Sum" | "Average") =>
      client.send(
        new GetMetricStatisticsCommand({
          Namespace: "AWS/CloudFront",
          MetricName: metric,
          Dimensions: [
            { Name: "DistributionId", Value: dist },
            { Name: "Region", Value: "Global" },
          ],
          StartTime: start,
          EndTime: end,
          Period: 3600,
          Statistics: [statistic],
        }),
      );
    const [requests, errors, bytes] = await Promise.all([
      query("Requests", "Sum"),
      query("TotalErrorRate", "Average"),
      client.send(
        new GetMetricStatisticsCommand({
          Namespace: "AWS/S3",
          MetricName: "BucketSizeBytes",
          Dimensions: [
            { Name: "BucketName", Value: bucket() },
            { Name: "StorageType", Value: "StandardStorage" },
          ],
          StartTime: new Date(+end - 3 * 86400000),
          EndTime: end,
          Period: 86400,
          Statistics: ["Average"],
        }),
      ),
    ]);
    const sample = [...(bytes.Datapoints ?? [])].sort(
      (a, b) => +(b.Timestamp ?? 0) - +(a.Timestamp ?? 0),
    )[0];
    const traffic = requests.Datapoints ?? [];
    const errorSamples = errors.Datapoints ?? [];
    return {
      cloudfront: {
        requests: traffic.length
          ? traffic.reduce((n, d) => n + (d.Sum ?? 0), 0)
          : null,
        errorRate:
          errorSamples.length &&
          traffic.length &&
          traffic.reduce((n, d) => n + (d.Sum ?? 0), 0) > 0
            ? errorSamples.reduce(
                (n, d) =>
                  n +
                  (d.Average ?? 0) *
                    (traffic.find(
                      (t) => Number(t.Timestamp) === Number(d.Timestamp),
                    )?.Sum ?? 0),
                0,
              ) / traffic.reduce((n, d) => n + (d.Sum ?? 0), 0)
            : null,
        period: "Last 24 hours · CloudWatch hourly periods",
        lastSample: traffic[0]?.Timestamp?.toISOString() ?? null,
      },
      s3MeasuredBytes: sample?.Average ?? null,
      s3MeasuredAt: sample?.Timestamp?.toISOString() ?? null,
      fetchedAt: now(),
    };
  },
  ["ops-health-v1"],
  { revalidate: 300 },
);

const desktopInventory = unstable_cache(
  async (prefix: string) => {
    await identity();
    const inventory: ObjectRow[] = [];
    let token: string | undefined;
    do {
      const result = await s3().send(
        new ListObjectsV2Command({
          Bucket: bucket(),
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const item of result.Contents ?? [])
        inventory.push({
          key: item.Key!,
          bytes: item.Size ?? 0,
          modified: item.LastModified?.toISOString() ?? "",
        });
      token = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (token);
    return { inventory, fetchedAt: now() };
  },
  ["ops-desktop-inventory-v2-desktop-reset"],
  { revalidate: 300 },
);

export async function library(params: URLSearchParams): Promise<Library> {
  const type = params.get("type") || "phone";
  const query = (params.get("q") || "").toLowerCase();
  const category = params.get("category") || "";
  const page = Math.max(1, Math.min(10000, Number(params.get("page")) || 1));
  const base = required("CLOUDFRONT_URL").replace(/\/$/, "");
  const url = (key: string) =>
    base + "/" + key.split("/").map(encodeURIComponent).join("/");
  let items: LibraryItem[];
  let fetchedAt: string;
  if (type === "phone") {
    const m = await master();
    fetchedAt = m.modified || now();
    items = m.entries
      .filter((e): e is Exclude<ManifestEntry, string> => typeof e !== "string")
      .map((e) => ({
        key: e.p,
        thumb: url(e.t || `thumbs/${e.p.replace(/\.[^.]+$/, "")}.webp`),
        url: url(e.p),
        category: e.p.split("/")[0],
        width: e.w || null,
        height: e.h || null,
        bytes: null,
        type: "phone",
      }));
  } else {
    const prefix =
      type === "review" ? "desktop_review/" : "desktop_wallpapers/";
    const s = await desktopInventory(prefix);
    fetchedAt = s.fetchedAt;
    items = s.inventory
      .filter((o) => o.key.startsWith(prefix))
      .map((o) => ({
        key: o.key,
        thumb:
          type === "review"
            ? url(o.key)
            : url(
                `thumbs/${o.key.slice(prefix.length).replace(/\.[^.]+$/, "")}.webp`,
              ),
        url: url(o.key),
        category: o.key.split("/")[1],
        width: null,
        height: null,
        bytes: o.bytes,
        type,
      }));
  }
  const categories = [...new Set(items.map((i) => i.category))].sort();
  items = items.filter(
    (i) =>
      (!query || i.key.toLowerCase().includes(query)) &&
      (!category || i.category === category),
  );
  return {
    items: items.slice((page - 1) * 36, page * 36),
    total: items.length,
    page,
    pages: Math.max(1, Math.ceil(items.length / 36)),
    categories,
    fetchedAt,
  };
}

export async function runEvents(id: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw new Error("Invalid operation identifier");
  const result = await db()
    .from("ops_events")
    .select("*")
    .eq("run_id", id)
    .order("created_at", { ascending: false })
    .limit(250);
  if (result.error) throw new Error("Operation query failed");
  return result.data;
}
