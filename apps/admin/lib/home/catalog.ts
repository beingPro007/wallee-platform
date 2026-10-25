import type { Entry, HomeSection } from "./types";
export function validSlug(value: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value))
    throw new Error(
      "Use a collection ID with lowercase letters, numbers, hyphens or underscores.",
    );
  return value;
}
export function validPrefix(value: string) {
  const prefix = value.trim().replace(/\/+$/, "") + "/";
  if (
    !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/$/.test(prefix) ||
    /^(raw_images|thumbs|sessions|desktop_pending|desktop_review|wallpapers)\//.test(
      prefix,
    )
  )
    throw new Error(
      "Choose a processed image folder, not an input, preview or catalog folder.",
    );
  return prefix;
}
export function sources(section: Pick<HomeSection, "slug" | "s3_prefix">) {
  validSlug(section.slug);
  const prefix = validPrefix(section.s3_prefix || section.slug + "/");
  return [
    ...new Set([
      prefix,
      ...(prefix === `premium/${section.slug}/` ? [`${section.slug}/`] : []),
    ]),
  ];
}
export function canonical(key: string) {
  return key.startsWith("wallpapers/") ? key.slice(11) : key;
}
export function parseEntries(value: unknown): Entry[] {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { wallpapers: unknown }).wallpapers)
  )
    throw new Error(
      "The existing catalog is invalid. Publishing stopped to preserve it.",
    );
  return (value as { wallpapers: unknown[] }).wallpapers.map((e) => {
    if (typeof e === "string") return { p: canonical(e), w: 0, h: 0 };
    if (!e || typeof e !== "object" || typeof (e as Entry).p !== "string")
      throw new Error("The existing catalog contains an invalid image.");
    const x = e as Entry;
    return {
      ...x,
      p: canonical(x.p),
      w: Number(x.w) || 0,
      h: Number(x.h) || 0,
    };
  });
}
export function assembleCatalog(
  old: Entry[],
  master: Entry[],
  available: Set<string>,
  prefixes: string[],
) {
  const prior = new Map(
    old.map((e) => [canonical(e.p), { ...e, p: canonical(e.p) }]),
  );
  const metadata = new Map(master.map((e) => [e.p, e]));
  const result = new Map<string, Entry>();
  let missing = 0;
  for (const [key, e] of prior) {
    if (available.has(key))
      result.set(key, { ...e, ...metadata.get(key), p: key });
    else missing++;
  }
  for (const key of [...available].sort()) {
    if (
      prefixes.some((p) => key.startsWith(p)) &&
      /\.(jpe?g|png|webp)$/i.test(key) &&
      !result.has(key)
    )
      result.set(key, metadata.get(key) || { p: key, w: 0, h: 0 });
  }
  const entries = [...result.values()].map((e) => ({
    ...e,
    t:
      e.t ||
      `thumbs/${e.p.replace(/^desktop_wallpapers\//, "").replace(/\.[^.]+$/, "")}.webp`,
  }));
  return {
    entries,
    count: entries.length,
    added: entries.filter((e) => !prior.has(e.p)).length,
    missing,
    previousCount: old.length,
  };
}
