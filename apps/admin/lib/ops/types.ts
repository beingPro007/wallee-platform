export type Resource<T> = {
  data: T | null;
  error: string | null;
  fetchedAt: string;
};
export type Run = {
  id: string;
  kind: string;
  reference: string | null;
  status: string;
  stage: string;
  message: string | null;
  details: Record<string, unknown>;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
};
export type Event = {
  id: number;
  run_id: string;
  stage: string;
  message: string;
  level: string;
  details: Record<string, unknown>;
  created_at: string;
};
export type Schedule = {
  id: number;
  name: string;
  schedule: string;
  active: boolean;
  last_status: string | null;
  last_finished: string | null;
};
export type Pipeline = {
  summary: {
    database_images: number;
    queue: Record<string, number>;
    operations_24h: Record<string, number>;
    tracking_since: string | null;
    schedules: Schedule[];
  };
  runs: Run[];
  events: Event[];
  queue: {
    id: string;
    category: string;
    status: string;
    raw_s3_key: string;
    upscaled_s3_key: string | null;
    created_at: string;
    updated_at: string;
  }[];
  fetchedAt: string;
};
export type ObjectRow = { key: string; bytes: number; modified: string };
export type Prefix = {
  name: string;
  objects: number;
  bytes: number;
  purpose: string;
};
export type Storage = {
  bucket: string;
  account: string;
  region: string;
  objects: number;
  bytes: number;
  prefixes: Prefix[];
  versioning: string;
  manifests: {
    key: string;
    entries: number;
    missing: number;
    modified: string | null;
  }[];
  issues: {
    title: string;
    detail: string;
    count: number;
    severity: "warning" | "info";
  }[];
  fetchedAt: string;
};
export type Costs = {
  account: string;
  start: string;
  end: string;
  currency: string;
  total: number;
  previousTotal: number;
  previousDays: number;
  estimated: boolean;
  daily: { date: string; total: number }[];
  services: { name: string; total: number }[];
  fetchedAt: string;
};
export type Health = {
  cloudfront: {
    requests: number | null;
    errorRate: number | null;
    period: string;
    lastSample: string | null;
  };
  s3MeasuredBytes: number | null;
  s3MeasuredAt: string | null;
  fetchedAt: string;
};
export type LibraryItem = {
  key: string;
  thumb: string;
  url: string;
  category: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  type: string;
};
export type Library = {
  items: LibraryItem[];
  total: number;
  page: number;
  pages: number;
  categories: string[];
  fetchedAt: string;
};
