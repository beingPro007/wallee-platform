import { NextRequest, NextResponse } from "next/server";
import { requireOpsUser, AccessError } from "@/lib/ops/auth";
import { createClient } from "@/lib/supabase/server";
import {
  sections,
  create,
  update,
  reorder,
  previewSection,
  publish,
} from "@/lib/home/service";
export const runtime = "nodejs";
export const maxDuration = 120;
const respond = (data: unknown, status = 200) =>
  NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
function failure(e: unknown) {
  return respond(
    {
      error:
        e instanceof Error ? e.message : "Unable to complete this request.",
    },
    e instanceof AccessError ? e.status : 400,
  );
}
export async function GET(request: NextRequest) {
  try {
    await requireOpsUser();
    const client = await createClient();
    const id = request.nextUrl.searchParams.get("preview");
    return respond(
      id ? await previewSection(client, id) : await sections(client),
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: NextRequest) {
  try {
    await requireOpsUser();
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.headers.get("host"))
      return respond({ error: "Request origin is not allowed." }, 403);
    if (!request.headers.get("content-type")?.includes("application/json"))
      return respond({ error: "JSON request required." }, 415);
    const body = await request.json();
    const client = await createClient();
    switch (body.action) {
      case "create":
        return respond(await create(client, body));
      case "update":
        return respond(
          await update(client, body.id, body.version, body.changes || {}),
        );
      case "reorder":
        if (
          !Array.isArray(body.ids) ||
          body.ids.some((id: unknown) => typeof id !== "string")
        )
          throw new Error("Invalid section order.");
        await reorder(client, body.ids);
        return respond({ ok: true });
      case "publish":
        return respond(await publish(client, body.id, body.token));
      default:
        return respond({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    return failure(e);
  }
}
