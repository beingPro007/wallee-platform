export type HomeSection = {
  id: string;
  name: string;
  slug: string;
  json_url: string;
  s3_prefix: string;
  is_fresh_drops: boolean;
  position: number;
  is_enabled: boolean;
  cover_image_url: string | null;
  wallpaper_count: number;
  created_at: string;
  updated_at: string;
};
export type Entry = { p: string; t?: string; w: number; h: number; s?: number };
export type PublishPreview = {
  token: string;
  count: number;
  added: number;
  missing: number;
  missingPreviews: number;
  entries: Entry[];
  source: string;
  previousCount: number;
};
