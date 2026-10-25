"use server"

import { s3Client } from "@/lib/s3"
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { createClient } from "@/lib/supabase/server"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import path from "path"

const BUCKET = process.env.AWS_BUCKET_NAME!
const CF_URL = (process.env.CLOUDFRONT_URL ?? "").replace(/\/$/, "")

function walleeSupabase() {
  return createSupabaseClient(
    process.env.WALLEE_SUPABASE_URL!,
    process.env.WALLEE_SUPABASE_SERVICE_KEY!,
  )
}

export type HomeSection = {
  id: string
  name: string
  slug: string
  json_url: string
  s3_prefix: string
  is_fresh_drops: boolean
  position: number
  is_enabled: boolean
  cover_image_url: string | null
  wallpaper_count: number
  created_at: string
  updated_at: string
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function listSections(): Promise<HomeSection[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("home_sections")
    .select("*")
    .order("position", { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as HomeSection[]
}

// ── Create ───────────────────────────────────────────────────────────────────

export async function createSection(
  name: string,
  slug: string,
  s3Prefix: string,
  isFreshDrops: boolean
): Promise<HomeSection> {
  const supabase = await createClient()
  const normSlug = slug.trim().toLowerCase().replace(/\s+/g, "-")

  // Idempotent: if this collection already exists, reuse it so that scraping
  // MORE media into the same slug is a first-class flow (no unique-violation
  // guardrail blocking re-uploads). Only re-arm the fresh-drops flag if asked.
  const { data: existing } = await supabase
    .from("home_sections")
    .select("*")
    .eq("slug", normSlug)
    .maybeSingle()

  if (existing) {
    if (isFreshDrops && !existing.is_fresh_drops) {
      await supabase
        .from("home_sections")
        .update({ is_fresh_drops: true })
        .eq("id", existing.id)
    }
    return { ...existing, is_fresh_drops: isFreshDrops || existing.is_fresh_drops } as HomeSection
  }

  // Make space at bottom
  const { count } = await supabase
    .from("home_sections")
    .select("id", { count: "exact", head: true })

  const { data, error } = await supabase
    .from("home_sections")
    .insert({
      name: name.trim(),
      slug: normSlug,
      s3_prefix: s3Prefix.trim().replace(/\/?$/, "/"),
      is_fresh_drops: isFreshDrops,
      json_url: "",
      position: (count ?? 0) + 1,
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data as HomeSection
}

// ── Update ───────────────────────────────────────────────────────────────────

export async function updateSection(
  id: string,
  updates: Partial<Pick<HomeSection, "name" | "is_enabled" | "is_fresh_drops">>
) {
  const supabase = await createClient()
  const { error } = await supabase
    .from("home_sections")
    .update(updates)
    .eq("id", id)
  if (error) throw new Error(error.message)
}

export async function reorderSections(orderedIds: string[]) {
  const supabase = await createClient()
  await Promise.all(
    orderedIds.map((id, index) =>
      supabase.from("home_sections").update({ position: index + 1 }).eq("id", id)
    )
  )
}

// ── Delete ───────────────────────────────────────────────────────────────────

export async function deleteSection(id: string) {
  const supabase = await createClient()
  const { error } = await supabase.from("home_sections").delete().eq("id", id)
  if (error) throw new Error(error.message)
}

// ── Upscale pipeline status ──────────────────────────────────────────────────

export type SectionUpscaleStatus = {
  id: string
  name: string
  slug: string
  is_enabled: boolean
  json_url: string
  total: number
  completed: number
  pending: number
  processing: number
  failed: number
  ready: boolean
}

export async function getSectionUpscaleStatus(): Promise<SectionUpscaleStatus[]> {
  const sections = await listSections()
  if (sections.length === 0) return []

  const wallee = walleeSupabase()
  const { data: rows } = await wallee
    .from("upscale_queue")
    .select("category, status")
    .in("category", sections.map((s) => s.slug))

  // Group counts by category
  const counts: Record<string, Record<string, number>> = {}
  for (const row of rows ?? []) {
    const cat = row.category as string
    const st = row.status as string
    counts[cat] ??= {}
    counts[cat][st] = (counts[cat][st] ?? 0) + 1
  }

  return sections.map((s) => {
    const c = counts[s.slug] ?? {}
    const completed  = c["completed"] ?? 0
    const pending    = c["pending"] ?? 0
    const processing = c["processing"] ?? 0
    const failed     = Object.entries(c)
      .filter(([k]) => k.startsWith("failed"))
      .reduce((acc, [, v]) => acc + v, 0)
    const total = completed + pending + processing + failed
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
    }
  })
}

// ── Master JSON merge ────────────────────────────────────────────────────────

const WALLPAPERS_V2_KEY = process.env.WALLPAPERS_V2_KEY ?? "wallpapers_v2.json"

async function mergeIntoMasterJson(
  entries: Array<{ p: string; t: string; w: number; h: number }>
): Promise<void> {
  let existing: Array<{ p: string; w: number; h: number; s?: number; t?: string }> = []

  try {
    const obj = await s3Client.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: WALLPAPERS_V2_KEY })
    )
    const body = await (obj.Body as any)?.transformToString()
    if (body) existing = JSON.parse(body).wallpapers ?? []
  } catch {
    // file doesn't exist yet — start fresh
  }

  const seen = new Set(existing.map((e) => e.p))
  for (const e of entries) {
    if (!seen.has(e.p)) {
      existing.push({ p: e.p, t: e.t, w: e.w, h: e.h, s: 1 })
      seen.add(e.p)
    }
  }

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: WALLPAPERS_V2_KEY,
      Body: JSON.stringify({ version: 2, wallpapers: existing }),
      ContentType: "application/json",
      CacheControl: "public, max-age=300",
    })
  )
}

// ── Build JSON ───────────────────────────────────────────────────────────────
// Scans s3_prefix, builds wallpapers_v2-format JSON, uploads to
// sessions/{slug}.json, updates the section record.

export async function buildSectionJson(
  id: string
): Promise<{ jsonUrl: string; count: number }> {
  const supabase = await createClient()

  const { data: section, error: fetchErr } = await supabase
    .from("home_sections")
    .select("*")
    .eq("id", id)
    .single()

  if (fetchErr || !section) throw new Error("Section not found")

  // Query completed upscaled images for this slug from the wallee upscale_queue
  const wallee = walleeSupabase()
  const { data: rows, error: qErr } = await wallee
    .from("upscale_queue")
    .select("upscaled_s3_key, raw_s3_key, width, height")
    .eq("category", section.slug)
    .eq("status", "completed")
    .not("upscaled_s3_key", "is", null)

  if (qErr) throw new Error(`upscale_queue query failed: ${qErr.message}`)

  // p = wallpapers/{slug}/{file}.jpg  (upscaled full-res)
  // t = thumbs/{slug}/{file}.webp     (derived from raw_s3_key stem)
  const wallpapers = (rows ?? []).map((row) => {
    const p = row.upscaled_s3_key as string
    const rawKey = row.raw_s3_key as string
    const stem = path.basename(rawKey, path.extname(rawKey))
    const t = `thumbs/${section.slug}/${stem}.webp`
    const w = (row.width as number) || 0
    const h = (row.height as number) || 0
    return { p, t, w, h }
  })

  const coverPath = wallpapers.length > 0 ? `${CF_URL}/${wallpapers[0].p}` : null

  const jsonPayload = JSON.stringify({
    version: 2,
    session: section.slug,
    name: section.name,
    wallpapers,
  })

  const jsonKey = `sessions/${section.slug}.json`

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: jsonKey,
      Body: jsonPayload,
      ContentType: "application/json",
      CacheControl: "public, max-age=300",
    })
  )

  const jsonUrl = `${CF_URL}/${jsonKey}`

  // Also merge into master wallpapers_v2.json (s:1 flags them as session entries)
  await mergeIntoMasterJson(wallpapers)

  await supabase.from("home_sections").update({
    json_url: jsonUrl,
    wallpaper_count: wallpapers.length,
    cover_image_url: coverPath,
    is_enabled: wallpapers.length > 0,   // auto-enable once JSON has content
  }).eq("id", id)

  return { jsonUrl, count: wallpapers.length }
}
