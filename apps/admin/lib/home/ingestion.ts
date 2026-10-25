import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { create, sections } from "./service";
import { validSlug, sources } from "./catalog";
import type { HomeSection } from "./types";
export type ImportInput = {
  url: string;
  destination: "auto" | "collection" | "new";
  sectionId?: string;
  name?: string;
};
export class ImportError extends Error {
  constructor(
    message: string,
    public sectionId?: string,
  ) {
    super(message);
  }
}
export function sourceUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2048)
    throw new Error("Enter an Instagram, Pinterest or Wallhaven URL.");
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new Error("Enter a complete URL beginning with https://.");
  }
  const host = u.hostname.replace(/^www\./, "");
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    ![
      "instagram.com",
      "pinterest.com",
      "pin.it",
      "wallhaven.cc",
      "whvn.cc",
    ].includes(host)
  )
    throw new Error("Use an https:// Instagram, Pinterest or Wallhaven URL.");
  if (host === "instagram.com" && !/^\/(p|reel|tv)\/[^/]+/.test(u.pathname))
    throw new Error("Use an Instagram post or reel URL.");
  if (u.pathname === "/")
    throw new Error(
      "Use a post, board or search URL rather than the site homepage.",
    );
  u.hash = "";
  return u.toString();
}
export function importCategory(s: HomeSection) {
  const candidates = sources(s);
  const prefix = candidates.find(
    (p) =>
      /^[a-z0-9][a-z0-9_-]*\/$/.test(p) &&
      p !== "desktop_wallpapers/" &&
      p !== "premium/",
  );
  if (!prefix)
    throw new Error(
      "This section uses a nested or desktop folder. Choose a phone collection or automatic categorization.",
    );
  return validSlug(prefix.slice(0, -1));
}
async function dispatch(payload: { url: string; session_slug?: string }) {
  const r = await fetch(
    "https://harrir-prod-2--wall-e-worker-ingest.modal.run",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(25000),
      cache: "no-store",
    },
  );
  if (!r.ok) throw new Error("Ingestion request rejected");
  return r.json();
}
export async function startImport(
  client: SupabaseClient,
  input: ImportInput,
  send: typeof dispatch = dispatch,
) {
  const url = sourceUrl(input.url);
  if (!["auto", "collection", "new"].includes(input.destination))
    throw new Error("Choose an import destination.");
  let section: HomeSection | undefined;
  if (input.destination === "new") {
    const name = input.name?.trim() || "";
    const slug = validSlug(
      name
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/[^a-z0-9_-]/g, "")
        .slice(0, 80),
    );
    section = await create(client, { name, slug, prefix: slug + "/" });
  }
  if (input.destination === "collection") {
    section = (await sections(client)).find((s) => s.id === input.sectionId);
    if (!section)
      throw new Error(
        "Choose an existing collection. Refresh if it was changed.",
      );
  }
  const payload = section
    ? { url, session_slug: importCategory(section) }
    : { url };
  try {
    const result = await send(payload);
    if (result?.status !== "processing_started" || !(result.count > 0))
      throw new Error("Not accepted");
    return {
      accepted: true,
      sectionId: section?.id || null,
      sectionName: section?.name || null,
      destination: input.destination,
    };
  } catch {
    throw new ImportError(
      "No confirmed ingestion response. Check Pipeline & activity before retrying. Any new section is saved and hidden; choose it under Existing collection for another attempt.",
      section?.id,
    );
  }
}
