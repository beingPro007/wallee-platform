import { NextRequest, NextResponse } from "next/server";
import { requireOpsUser, AccessError } from "@/lib/ops/auth";
import { createClient } from "@/lib/supabase/server";
import { startImport, ImportError } from "@/lib/home/ingestion";
export const runtime = "nodejs";
export const maxDuration = 60;
const response = (data: unknown, status = 200) =>
  NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
export async function POST(request: NextRequest) {
  try {
    await requireOpsUser();
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.headers.get("host"))
      return response({ error: "Request origin is not allowed." }, 403);
    if (!request.headers.get("content-type")?.includes("application/json"))
      return response({ error: "JSON request required." }, 415);
    const input = await request.json();
    return response(await startImport(await createClient(), input), 202);
  } catch (e) {
    return response(
      {
        error: e instanceof Error ? e.message : "Import could not start.",
        sectionId: e instanceof ImportError ? e.sectionId : undefined,
      },
      e instanceof AccessError
        ? e.status
        : e instanceof ImportError
          ? 502
          : 400,
    );
  }
}
