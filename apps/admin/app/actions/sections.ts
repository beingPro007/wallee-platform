"use server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { requireOpsUser } from "@/lib/ops/auth";
import * as home from "@/lib/home/service";
import type { HomeSection } from "@/lib/home/types";
export type { HomeSection } from "@/lib/home/types";
async function authorized() {
  await requireOpsUser();
  return createClient();
}
function walleeSupabase() {
  return createSupabaseClient(
    process.env.WALLEE_SUPABASE_URL!,
    process.env.WALLEE_SUPABASE_SERVICE_KEY!,
  );
}
export async function listSections() {
  return home.sections(await authorized());
}
export async function createSection(
  name: string,
  slug: string,
  s3Prefix: string,
  isFreshDrops: boolean,
) {
  const client = await authorized();
  const section = await home.create(client, { name, slug, prefix: s3Prefix });
  if (isFreshDrops)
    return home.update(client, section.id, section.updated_at, {
      is_fresh_drops: true,
    });
  return section;
}
export async function updateSection(
  id: string,
  changes: Partial<Pick<HomeSection, "name" | "is_enabled" | "is_fresh_drops">>,
) {
  const client = await authorized();
  const current = (await home.sections(client)).find((s) => s.id === id);
  if (!current) throw new Error("Section not found.");
  return home.update(client, id, current.updated_at, changes);
}
export async function reorderSections(ids: string[]) {
  return home.reorder(await authorized(), ids);
}
export async function deleteSection(id: string) {
  return home.remove(await authorized(), id);
}
export async function buildSectionJson(id: string) {
  const client = await authorized();
  const preview = await home.previewSection(client, id);
  return home.publish(client, id, preview.token);
}

export type SectionUpscaleStatus = {
  id: string;
  name: string;
  slug: string;
  is_enabled: boolean;
  json_url: string;
  total: number;
  completed: number;
  pending: number;
  processing: number;
  failed: number;
  ready: boolean;
};

export async function getSectionUpscaleStatus(): Promise<
  SectionUpscaleStatus[]
> {
  const sections = await listSections();
  if (sections.length === 0) return [];

  const wallee = walleeSupabase();
  const { data: rows, error } = await wallee
    .from("upscale_queue")
    .select("category, status")
    .in(
      "category",
      sections.map((s) => s.slug),
    );

  if (error) throw new Error(error.message);
  // Group counts by category
  const counts: Record<string, Record<string, number>> = {};
  for (const row of rows ?? []) {
    const cat = row.category as string;
    const st = row.status as string;
    counts[cat] ??= {};
    counts[cat][st] = (counts[cat][st] ?? 0) + 1;
  }

  return sections.map((s) => {
    const c = counts[s.slug] ?? {};
    const completed = c["completed"] ?? 0;
    const pending = c["pending"] ?? 0;
    const processing = c["processing"] ?? 0;
    const failed = Object.entries(c)
      .filter(([k]) => k.startsWith("failed"))
      .reduce((acc, [, v]) => acc + v, 0);
    const total = completed + pending + processing + failed;
    return {
      id: s.id,
      name: s.name,
      slug: s.slug,
      is_enabled: s.is_enabled,
      json_url: s.json_url,
      total,
      completed,
      pending,
      processing,
      failed,
      ready: total > 0 && pending === 0 && processing === 0,
    };
  });
}
