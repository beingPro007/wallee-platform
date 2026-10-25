import { NextRequest, NextResponse } from "next/server";
import { previewSection, publish } from "@/lib/home/service";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

export const maxDuration = 120;
const SECRET = process.env.BUILD_WEBHOOK_SECRET ?? "";

export async function POST(req: NextRequest) {
  const token = req.headers.get("x-webhook-secret");
  if (!SECRET || token !== SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const slug = body?.slug as string | undefined;
  if (!slug)
    return NextResponse.json({ error: "Missing slug" }, { status: 400 });

  // Automated publishing needs its own server credential; an anonymous client
  // cannot update section metadata under RLS. Never publish half a result.
  const adminKey = process.env.ADMIN_SUPABASE_SERVICE_KEY;
  if (!adminKey)
    return NextResponse.json(
      {
        error:
          "Automatic publishing is not configured. Use Home & Publishing while signed in.",
      },
      { status: 503 },
    );
  // The webhook secret was checked above; this credential stays server-side.
  const adminClient = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    adminKey,
  );
  const { data: section } = await adminClient
    .from("home_sections")
    .select("id")
    .eq("slug", slug)
    .single();

  if (!section) {
    return NextResponse.json({
      status: "ignored",
      reason: "slug not a registered section",
    });
  }

  try {
    const preview = await previewSection(adminClient, section.id);
    const result = await publish(adminClient, section.id, preview.token);
    return NextResponse.json({ status: "built", ...result });
  } catch (e) {
    return NextResponse.json(
      { status: "error", message: (e as Error).message },
      { status: 500 },
    );
  }
}
