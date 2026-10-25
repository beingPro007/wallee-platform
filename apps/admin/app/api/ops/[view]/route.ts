import { NextRequest, NextResponse } from "next/server";
import { requireOpsUser, AccessError } from "@/lib/ops/auth";
import {
  pipeline,
  storage,
  costs,
  health,
  library,
  resource,
  runEvents,
} from "@/lib/ops/data";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ view: string }> },
) {
  try {
    await requireOpsUser();
    const { view } = await context.params;
    let result;
    switch (view) {
      case "run":
        result = await resource(() =>
          runEvents(request.nextUrl.searchParams.get("id") || ""),
        );
        break;
      case "pipeline":
        result = await resource(pipeline);
        break;
      case "storage":
        result = await resource(storage);
        break;
      case "costs":
        result = await resource(costs);
        break;
      case "health":
        result = await resource(health);
        break;
      case "library":
        result = await resource(() => library(request.nextUrl.searchParams));
        break;
      default:
        return NextResponse.json({ error: "Unknown view" }, { status: 404 });
    }
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof AccessError)
      return NextResponse.json(
        { error: error.message },
        {
          status: error.status,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    return NextResponse.json(
      { error: "Unable to authenticate this request." },
      { status: 503 },
    );
  }
}
