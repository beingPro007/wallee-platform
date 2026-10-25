import { NextRequest, NextResponse } from "next/server"
import { buildSectionJson } from "@/app/actions/sections"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"

const SECRET = process.env.BUILD_WEBHOOK_SECRET ?? ""

export async function POST(req: NextRequest) {
  const token = req.headers.get("x-webhook-secret")
  if (!SECRET || token !== SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const slug = body?.slug as string | undefined
  if (!slug) return NextResponse.json({ error: "Missing slug" }, { status: 400 })

  // Look up section id by slug (anon key is fine — home_sections has public SELECT policy)
  const adminClient = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
  const { data: section } = await adminClient
    .from("home_sections")
    .select("id")
    .eq("slug", slug)
    .single()

  if (!section) {
    return NextResponse.json({ status: "ignored", reason: "slug not a registered section" })
  }

  try {
    const result = await buildSectionJson(section.id)
    return NextResponse.json({ status: "built", ...result })
  } catch (e) {
    return NextResponse.json({ status: "error", message: (e as Error).message }, { status: 500 })
  }
}
