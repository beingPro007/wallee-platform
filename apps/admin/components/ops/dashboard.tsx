"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Cloud,
  Database,
  ExternalLink,
  Eye,
  FileJson,
  Folder,
  HardDrive,
  ImageIcon,
  Layers3,
  LayoutDashboard,
  Loader2,
  LogOut,
  Menu,
  Radio,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  TriangleAlert,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { getSupabaseClient } from "@/lib/supabase/client";
import type {
  Costs,
  Event,
  Health,
  Library,
  LibraryItem,
  Pipeline,
  Resource,
  Run,
  Storage,
} from "@/lib/ops/types";
import { ago, bytes, date, money, number, title } from "@/lib/ops/format";

type View =
  | "overview"
  | "pipeline"
  | "library"
  | "storage"
  | "costs"
  | "system";
type StorageSummary = Omit<Storage, "inventory">;
const NAV: { id: View; label: string; icon: LucideIcon; group: string }[] = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    group: "WORKSPACE",
  },
  {
    id: "pipeline",
    label: "Pipeline & activity",
    icon: Activity,
    group: "WORKSPACE",
  },
  {
    id: "library",
    label: "Image library",
    icon: ImageIcon,
    group: "WORKSPACE",
  },
  {
    id: "storage",
    label: "S3 storage",
    icon: HardDrive,
    group: "INFRASTRUCTURE",
  },
  { id: "costs", label: "AWS costs", icon: Wallet, group: "INFRASTRUCTURE" },
  {
    id: "system",
    label: "System health",
    icon: Server,
    group: "INFRASTRUCTURE",
  },
];
async function load<T>(view: string): Promise<Resource<T>> {
  const response = await fetch(`/api/ops/${view}`, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Unable to load this view.");
  return body;
}
function useSource<T>(name: string, interval = 0) {
  const [result, setResult] = useState<Resource<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true);
    try {
      const next = await load<T>(name);
      if (version === generation.current) setResult(next);
    } catch (error) {
      if (version === generation.current)
        setResult({
          data: null,
          error: (error as Error).message,
          fetchedAt: new Date().toISOString(),
        });
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [name]);
  useEffect(() => {
    refresh();
    if (!interval) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, interval);
    return () => clearInterval(timer);
  }, [refresh, interval]);
  return { ...result, data: result?.data ?? null, loading, refresh };
}
function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`ops-mark ${small ? "small" : ""}`}>
      <Layers3 size={small ? 17 : 22} strokeWidth={2.1} />
    </span>
  );
}
function Pill({ status, children }: { status: string; children?: ReactNode }) {
  return (
    <span className={`ops-pill ${status}`}>
      <span />
      {children || title(status)}
    </span>
  );
}
function Panel({
  title: heading,
  subtitle,
  action,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`ops-panel ${className}`}>
      <div className="panel-head">
        <div>
          <h2>{heading}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function Empty({
  icon: Icon = Radio,
  title: heading,
  description,
}: {
  icon?: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="ops-empty">
      <Icon size={28} />
      <strong>{heading}</strong>
      <p>{description}</p>
    </div>
  );
}
function SourceError({ message }: { message?: string | null }) {
  return message ? (
    <div className="source-error" role="alert">
      <TriangleAlert size={16} />
      <span>{message}</span>
    </div>
  ) : null;
}
function Skeleton({ label = "Reading live data…" }: { label?: string }) {
  return (
    <div className="ops-loading">
      <Loader2 size={18} className="spin" />
      {label}
    </div>
  );
}
function Metric({
  label,
  value,
  foot,
  icon: Icon,
  tone = "neutral",
  loading = false,
}: {
  label: string;
  value: string;
  foot: string;
  icon: LucideIcon;
  tone?: string;
  loading?: boolean;
}) {
  return (
    <div className="ops-metric">
      <div className="metric-label">
        {label}
        <Icon size={17} />
      </div>
      <div className={`metric-value ${loading ? "loading-value" : ""}`}>
        {loading ? "—" : value}
      </div>
      <div className={`metric-foot ${tone}`}>
        <span />
        {foot}
      </div>
    </div>
  );
}
function CostChart({
  data,
  large = false,
}: {
  data: Costs | null;
  large?: boolean;
}) {
  const [range, setRange] = useState<"month" | "week">("month");
  if (!data)
    return (
      <Empty
        icon={Wallet}
        title="Cost data unavailable"
        description="AWS billing is loaded independently from the pipeline."
      />
    );
  const days = range === "week" ? data.daily.slice(-7) : data.daily;
  const max = Math.max(...days.map((d) => d.total), 0.01);
  const width = 700;
  const height = large ? 230 : 170;
  const top = 15;
  const bottom = height - 25;
  const points = days.map((d, i) => [
    42 + (i / Math.max(days.length - 1, 1)) * (width - 58),
    bottom - (d.total / max) * (bottom - top),
  ]);
  const path = points
    .map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`)
    .join(" ");
  return (
    <>
      <div className="chart-heading">
        <div>
          <strong>{money(data.total, data.currency)}</strong>
          <span>month to date · account-wide</span>
        </div>
        <div className="segmented">
          <button
            className={range === "week" ? "selected" : ""}
            onClick={() => setRange("week")}
          >
            7 days
          </button>
          <button
            className={range === "month" ? "selected" : ""}
            onClick={() => setRange("month")}
          >
            This month
          </button>
        </div>
      </div>
      <div className="cost-chart">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Daily AWS cost, ${days.length} days. Month to date ${money(data.total, data.currency)}`}
        >
          <defs>
            <linearGradient
              id={large ? "cost-fill-lg" : "cost-fill"}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor="#71e5c0" stopOpacity=".2" />
              <stop offset="100%" stopColor="#71e5c0" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, 0.5, 1].map((n) => (
            <g key={n}>
              <line
                x1="42"
                x2={width - 10}
                y1={bottom - n * (bottom - top)}
                y2={bottom - n * (bottom - top)}
                stroke="#252a30"
                strokeDasharray="3 5"
              />
              <text
                x="0"
                y={bottom - n * (bottom - top) + 4}
                fill="#858d98"
                fontSize="10"
              >
                {money(max * n, data.currency)}
              </text>
            </g>
          ))}
          {points.length > 0 && (
            <>
              <path
                d={`${path} L${points[points.length - 1][0]},${bottom} L${points[0][0]},${bottom} Z`}
                fill={`url(#${large ? "cost-fill-lg" : "cost-fill"})`}
              />
              <path
                d={path}
                stroke="#72e0bd"
                strokeWidth="2.4"
                fill="none"
                strokeLinejoin="round"
              />
              {points.map((p, i) => (
                <circle key={i} cx={p[0]} cy={p[1]} r="3" fill="#72e0bd">
                  <title>
                    {date(days[i].date)}: {money(days[i].total, data.currency)}
                  </title>
                </circle>
              ))}
            </>
          )}
        </svg>
        <div className="chart-dates">
          <span>{days[0] ? date(days[0].date) : "—"}</span>
          <span>
            {days[Math.floor(days.length / 2)]
              ? date(days[Math.floor(days.length / 2)].date)
              : ""}
          </span>
          <span>{days.length ? date(days[days.length - 1].date) : "—"}</span>
        </div>
      </div>
    </>
  );
}
function StorageMix({ data }: { data: StorageSummary | null }) {
  if (!data)
    return (
      <Empty
        icon={HardDrive}
        title="Storage not available"
        description="The object inventory is still loading or its source is unavailable."
      />
    );
  const top = data.prefixes.slice(0, 4);
  const other = data.bytes - top.reduce((n, p) => n + p.bytes, 0);
  const groups = [
    ...top.map((p) => ({ name: p.name, value: p.bytes })),
    { name: "Other folders", value: other },
  ];
  const colors = ["#79e1bd", "#a59cf4", "#e4ba82", "#7eafeb", "#4b5563"];
  let position = 0;
  const segments = groups.map((g, i) => {
    const from = position;
    position += data.bytes ? (g.value / data.bytes) * 100 : 0;
    return `${colors[i]} ${from}% ${position}%`;
  });
  return (
    <div className="storage-mix">
      <div
        className="storage-ring"
        style={{ background: `conic-gradient(${segments.join(",")})` }}
      >
        <div>
          <strong>{bytes(data.bytes)}</strong>
          <span>current objects</span>
        </div>
      </div>
      <div className="storage-legend">
        {groups.map((g, i) => (
          <div key={g.name}>
            <span className="legend-name">
              <i style={{ background: colors[i] }} />
              {g.name.replace(/\/$/, "")}
            </span>
            <strong>{bytes(g.value)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
function ActivityList({
  runs,
  onSelect,
  compact = false,
}: {
  runs: Run[];
  onSelect: (run: Run) => void;
  compact?: boolean;
}) {
  if (!runs.length)
    return (
      <Empty
        icon={Activity}
        title="Waiting for the next operation"
        description="Persistent tracking begins with the next import or processing run. Older service logs are not reconstructed."
      />
    );
  return (
    <div className="activity-table">
      <div className="activity-labels">
        <span>OPERATION</span>
        <span>STATUS</span>
        <span>LAST UPDATE</span>
      </div>
      {runs.slice(0, compact ? 5 : 60).map((run) => (
        <button
          className="activity-row"
          key={run.id}
          onClick={() => onSelect(run)}
        >
          <div className="activity-name">
            <span className={`activity-icon ${run.kind}`}>
              {run.kind === "ingestion" ? (
                <ArrowDownLeft size={17} />
              ) : run.kind === "publish" ? (
                <FileJson size={17} />
              ) : (
                <Zap size={17} />
              )}
            </span>
            <div>
              <strong>{title(run.kind)}</strong>
              <small title={run.reference || ""}>
                {run.reference?.split("/").pop() ||
                  run.message ||
                  "Pipeline operation"}
              </small>
            </div>
          </div>
          <Pill status={run.status}>
            {run.status === "succeeded" ? "Completed" : title(run.status)}
          </Pill>
          <span className="activity-time">
            {ago(run.updated_at)}
            <ChevronRight size={14} />
          </span>
        </button>
      ))}
    </div>
  );
}
function Flow({ data }: { data: Pipeline | null }) {
  const counts = data?.summary.queue;
  const stages = [
    {
      name: "Ingestion",
      description: "Source downloads",
      icon: ArrowDownLeft,
      count: data?.runs.filter(
        (r) =>
          r.kind === "ingestion" &&
          r.status === "running" &&
          ["accepted", "downloading"].includes(r.stage),
      ).length,
    },
    {
      name: "Classification",
      description: "Category & duplicates",
      icon: Layers3,
      count: data?.runs.filter(
        (r) =>
          r.kind === "ingestion" &&
          r.stage === "classifying" &&
          r.status === "running",
      ).length,
    },
    {
      name: "Upscaling",
      description: "GPU processing",
      icon: Zap,
      count: counts ? counts.processing || 0 : undefined,
    },
    {
      name: "Publishing",
      description: "Catalog & previews",
      icon: Cloud,
      count: data?.runs.filter(
        (r) => r.kind === "publish" && r.status === "running",
      ).length,
    },
  ];
  return (
    <div className="pipeline-flow">
      {stages.map((stage, i) => (
        <div className="flow-unit" key={stage.name}>
          <div className={`flow-node ${stage.count ? "active" : ""}`}>
            <stage.icon size={20} />
            <span className="flow-count">
              {stage.count == null ? "—" : stage.count}
            </span>
          </div>
          <strong>{stage.name}</strong>
          <small>{stage.description}</small>
          {i < stages.length - 1 && (
            <ArrowRight className="flow-arrow" size={17} />
          )}
        </div>
      ))}
    </div>
  );
}
export function OperationsDashboard({ email }: { email: string }) {
  const [view, setView] = useState<View>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const pipeline = useSource<Pipeline>("pipeline", 30000);
  const storage = useSource<StorageSummary>("storage");
  const costs = useSource<Costs>("costs");
  const health = useSource<Health>("health", 300000);
  const warn =
    storage.data?.issues.filter((i) => i.severity === "warning") || [];
  const failed =
    (pipeline.data?.summary.operations_24h.failed || 0) +
    (pipeline.data?.summary.operations_24h.partial || 0);
  const pending = pipeline.data
    ? (pipeline.data.summary.queue.pending ?? 0)
    : undefined;
  const refreshing = pipeline.loading;
  const navigate = (next: View) => {
    setView(next);
    setMobileNav(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const heading = {
    overview: "Operations overview",
    pipeline: "Pipeline & activity",
    library: "Image library",
    storage: "S3 storage",
    costs: "AWS costs",
    system: "System health",
  }[view];
  const description = {
    overview: "A clear view of your pipeline, storage, and infrastructure.",
    pipeline: "Follow every recorded run, from source media to publication.",
    library:
      "Explore published images, desktop outputs, and the review backlog.",
    storage:
      "Understand what is stored, where it lives, and what needs attention.",
    costs: "Actual AWS account spend, with a transparent view of its scope.",
    system:
      "Data connections, automation schedules, and observability coverage.",
  }[view];
  return (
    <div className="ops-app">
      <aside className={`ops-sidebar ${mobileNav ? "open" : ""}`}>
        <a className="ops-brand" href="/protected">
          <Mark />
          <span>
            Wallee<span className="brand-sub">OPERATIONS</span>
          </span>
        </a>
        <button className="workspace-switch" onClick={() => navigate("system")}>
          <span className="workspace-avatar">W</span>
          <span>
            Wallee workspace<small>Production environment</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <nav aria-label="Main navigation">
          {NAV.map((item, i) => (
            <div key={item.id}>
              {(!i || item.group !== NAV[i - 1].group) && (
                <p className="nav-group">{item.group}</p>
              )}
              <button
                className={`nav-item ${view === item.id ? "active" : ""}`}
                aria-current={view === item.id ? "page" : undefined}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={18} />
                <span>{item.label}</span>
                {item.id === "system" && warn.length > 0 && (
                  <span className="nav-count">{warn.length}</span>
                )}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="readonly-note">
            <ShieldCheck size={18} />
            <div>
              Observe with confidence<small>This dashboard is read-only.</small>
            </div>
          </div>
          <div className="user-box">
            <span className="user-avatar">
              {email.slice(0, 1).toUpperCase()}
            </span>
            <span title={email}>
              {email.split("@")[0]}
              <small>Workspace administrator</small>
            </span>
            <button
              className="icon-button"
              aria-label="Sign out"
              onClick={async () => {
                await getSupabaseClient().auth.signOut();
                window.location.assign("/auth/sign-in");
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      {mobileNav && (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <div className="ops-workspace">
        <header className="ops-topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{heading}</strong>
          </div>
          <div className="topbar-right">
            <span className="environment">
              <span />
              Production
            </span>
            <button
              className="icon-button notification-button"
              aria-label={`${warn.length} storage checks need attention`}
              onClick={() => navigate("system")}
            >
              <Bell size={18} />
              {warn.length > 0 && <i />}
            </button>
            <span className="user-avatar small">
              {email.slice(0, 1).toUpperCase()}
            </span>
          </div>
        </header>
        <main className="ops-main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span /> YOUR WORKSPACE, AT A GLANCE
              </div>
              <h1>{heading}</h1>
              <p>{description}</p>
            </div>
            <div className="page-actions">
              <span className="live-label">
                <Radio size={13} /> Activity refreshes every 30s
              </span>
              <button
                className="ops-button"
                onClick={() => {
                  pipeline.refresh();
                  health.refresh();
                }}
                disabled={refreshing}
              >
                <RefreshCw size={15} className={refreshing ? "spin" : ""} />
                Refresh
              </button>
            </div>
          </div>
          {view === "overview" && (
            <>
              <div className="overview-note">
                <div>
                  <Eye size={15} />
                  <span>Observe mode</span>
                  <span className="note-divider" />
                  <span>
                    Live sources. No processing or publishing controls.
                  </span>
                </div>
                <span>
                  {new Date().toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
              </div>
              <div className="metric-grid">
                <Metric
                  label="Images in mobile catalog"
                  value={number(
                    storage.data?.manifests.find(
                      (m) => m.key === "wallpapers_v2.json",
                    )?.entries,
                  )}
                  foot="Published v2 catalog entries"
                  icon={ImageIcon}
                  loading={storage.loading}
                />
                <Metric
                  label="Waiting for upscaling"
                  value={number(pending)}
                  foot={
                    pipeline.error
                      ? "Pipeline source unavailable"
                      : "Current queue · scheduled dispatch"
                  }
                  icon={Layers3}
                  tone={pending ? "amber" : "neutral"}
                  loading={pipeline.loading}
                />
                <Metric
                  label="S3 current storage"
                  value={bytes(storage.data?.bytes)}
                  foot={
                    storage.data
                      ? `${number(storage.data.objects)} current objects`
                      : "Reading storage inventory"
                  }
                  icon={HardDrive}
                  loading={storage.loading}
                />
                <Metric
                  label="AWS month to date"
                  value={money(costs.data?.total, costs.data?.currency)}
                  foot={
                    costs.data?.estimated
                      ? "Estimated charges · account-wide"
                      : "Account-wide · AWS Cost Explorer"
                  }
                  icon={Wallet}
                  loading={costs.loading}
                />
              </div>
              <SourceError message={pipeline.error} />
              <SourceError message={storage.error} />
              <SourceError message={costs.error} />
              <div className="overview-grid">
                <Panel
                  title="Pipeline at a glance"
                  subtitle="Current work across the processing stages"
                  action={
                    <button
                      className="text-button"
                      onClick={() => navigate("pipeline")}
                    >
                      View activity <ArrowUpRight size={14} />
                    </button>
                  }
                >
                  <Flow data={pipeline.data} />
                  <div className="panel-footer">
                    <span>
                      <Clock3 size={13} />
                      Phone queue checked every 30 minutes
                    </span>
                    <span>
                      <span className="tiny-dot" />
                      Desktop dispatches directly
                    </span>
                  </div>
                </Panel>
                <Panel
                  title="Needs attention"
                  subtitle="Measured checks, not guessed health"
                  action={
                    <span className="count-tag">
                      {warn.length + Number(failed > 0)}
                    </span>
                  }
                >
                  {storage.loading ? (
                    <Skeleton label="Checking object references…" />
                  ) : (
                    <div className="attention-list">
                      {failed > 0 && (
                        <button onClick={() => navigate("pipeline")}>
                          <span className="attention-icon">
                            <TriangleAlert size={17} />
                          </span>
                          <div>
                            <strong>
                              {failed} failed or partial operations
                            </strong>
                            <small>Recorded in the last 24 hours</small>
                          </div>
                          <ChevronRight size={15} />
                        </button>
                      )}
                      {warn.slice(0, 2).map((issue) => (
                        <button
                          key={issue.title}
                          onClick={() => navigate("storage")}
                        >
                          <span className="attention-icon">
                            <TriangleAlert size={17} />
                          </span>
                          <div>
                            <strong>{issue.title}</strong>
                            <small>
                              {number(issue.count)} affected · inspect in
                              storage
                            </small>
                          </div>
                          <ChevronRight size={15} />
                        </button>
                      ))}
                      {!warn.length && !failed && (
                        <Empty
                          icon={CheckCircle2}
                          title={
                            storage.error
                              ? "Checks unavailable"
                              : "No measured warnings"
                          }
                          description={
                            storage.error
                              ? "Reconnect the source to run these checks."
                              : "Only connected sources are included in this assessment."
                          }
                        />
                      )}
                    </div>
                  )}
                </Panel>
                <Panel
                  title="AWS spending"
                  subtitle="Daily unblended cost · UTC"
                  action={
                    <button
                      className="text-button"
                      onClick={() => navigate("costs")}
                    >
                      Cost details <ArrowUpRight size={14} />
                    </button>
                  }
                >
                  {costs.loading ? (
                    <Skeleton label="Reading AWS billing…" />
                  ) : (
                    <CostChart data={costs.data} />
                  )}
                </Panel>
                <Panel
                  title="Storage distribution"
                  subtitle="Current objects · excludes version history"
                  action={
                    <button
                      className="icon-button"
                      aria-label="Explore storage"
                      onClick={() => navigate("storage")}
                    >
                      <ArrowUpRight size={17} />
                    </button>
                  }
                >
                  <StorageMix data={storage.data} />
                </Panel>
              </div>
              <Panel
                title="Recent activity"
                subtitle="Persistent records from ingestion, upscaling, and publishing"
                action={
                  <button
                    className="text-button"
                    onClick={() => navigate("pipeline")}
                  >
                    All activity <ArrowRight size={14} />
                  </button>
                }
              >
                {pipeline.loading && !pipeline.data ? (
                  <Skeleton />
                ) : (
                  <ActivityList
                    runs={pipeline.data?.runs || []}
                    onSelect={setSelectedRun}
                    compact
                  />
                )}
              </Panel>
            </>
          )}
          {view === "pipeline" && (
            <PipelinePage
              data={pipeline.data}
              error={pipeline.error}
              loading={pipeline.loading}
              onSelect={setSelectedRun}
            />
          )}
          {view === "storage" && (
            <StoragePage
              data={storage.data}
              health={health.data}
              error={storage.error}
              loading={storage.loading}
            />
          )}
          {view === "costs" && (
            <CostsPage
              data={costs.data}
              error={costs.error}
              loading={costs.loading}
            />
          )}
          {view === "library" && <LibraryPage />}
          {view === "system" && (
            <SystemPage
              pipeline={pipeline.data}
              storage={storage.data}
              costs={costs.data}
              health={health.data}
              errors={{
                pipeline: pipeline.error,
                storage: storage.error,
                costs: costs.error,
                health: health.error,
              }}
            />
          )}
          <footer className="ops-footer">
            <span>
              <Mark small /> Wallee Operations
            </span>
            <span>
              Read-only workspace <span>·</span> Source timestamps shown per
              panel
            </span>
          </footer>
        </main>
      </div>
      {selectedRun && (
        <RunDrawer run={selectedRun} onClose={() => setSelectedRun(null)} />
      )}
    </div>
  );
}
function PipelinePage({
  data,
  error,
  loading,
  onSelect,
}: {
  data: Pipeline | null;
  error?: string | null;
  loading: boolean;
  onSelect: (r: Run) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const runs = (data?.runs || []).filter(
    (r) =>
      (filter === "all" || r.status === filter) &&
      (r.reference || r.kind).toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <SourceError message={error} />
      <div className="metric-grid">
        <Metric
          label="Running operations"
          value={number(
            data?.runs.filter((r) => r.status === "running").length,
          )}
          foot="In the latest 60 recorded runs"
          icon={Activity}
        />
        <Metric
          label="Completed · 24h"
          value={number(
            data?.summary.operations_24h.succeeded ?? (data ? 0 : null),
          )}
          foot="Recorded operations, not unique images"
          icon={CheckCircle2}
          tone="green"
        />
        <Metric
          label="Needs attention · 24h"
          value={number(
            data
              ? (data.summary.operations_24h.failed || 0) +
                  (data.summary.operations_24h.partial || 0)
              : null,
          )}
          foot="Open a run to inspect its stages"
          icon={TriangleAlert}
          tone="amber"
        />
        <Metric
          label="Awaiting upscaling"
          value={number(data?.summary.queue.pending ?? (data ? 0 : null))}
          foot="Live phone processing queue"
          icon={Clock3}
        />
      </div>
      <Panel
        title="Operation history"
        subtitle={
          data?.summary.tracking_since
            ? `Tracking since ${new Date(data.summary.tracking_since).toLocaleString()}. Older service logs are not imported.`
            : "Tracking starts with the next pipeline operation."
        }
        action={<span className="count-tag">Latest 60 runs</span>}
      >
        <div className="table-toolbar">
          <div className="segmented">
            {["all", "running", "failed", "partial", "succeeded"].map((s) => (
              <button
                key={s}
                className={filter === s ? "selected" : ""}
                onClick={() => setFilter(s)}
              >
                {s === "succeeded" ? "Completed" : title(s)}
              </button>
            ))}
          </div>
          <label className="search-box">
            <Search size={16} />
            <input
              aria-label="Search activity"
              placeholder="Search operations…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        {loading && !data ? (
          <Skeleton />
        ) : (
          <ActivityList runs={runs} onSelect={onSelect} />
        )}
      </Panel>
      <Panel
        title="Current phone queue"
        subtitle="Queue history is periodically cleaned. Persistent operation history is shown above."
      >
        <div className="table-scroll">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Image</th>
                <th>Category</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data?.queue.map((row) => (
                <tr key={row.id}>
                  <td className="file-name" title={row.raw_s3_key}>
                    <ImageIcon size={15} />
                    {row.raw_s3_key.split("/").pop()}
                  </td>
                  <td>{row.category}</td>
                  <td>
                    <Pill
                      status={
                        row.status.startsWith("failed")
                          ? "failed"
                          : row.status === "completed"
                            ? "succeeded"
                            : row.status
                      }
                    >
                      {title(row.status)}
                    </Pill>
                  </td>
                  <td className="muted">{ago(row.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data?.queue.length && (
            <Empty
              title="No retained queue records"
              description="This is not a lifetime processing count. Desktop processing is tracked in operation history."
            />
          )}
        </div>
      </Panel>
    </>
  );
}
function StoragePage({
  data,
  health,
  error,
  loading,
}: {
  data: StorageSummary | null;
  health: Health | null;
  error?: string | null;
  loading: boolean;
}) {
  const [query, setQuery] = useState("");
  return (
    <>
      <SourceError message={error} />
      <div className="metric-grid">
        <Metric
          label="Current object storage"
          value={bytes(data?.bytes)}
          foot="Exact current-key inventory"
          icon={HardDrive}
        />
        <Metric
          label="Objects"
          value={number(data?.objects)}
          foot="Images, previews, and catalogs"
          icon={Folder}
        />
        <Metric
          label="AWS measured storage"
          value={bytes(health?.s3MeasuredBytes)}
          foot={
            health?.s3MeasuredAt
              ? `StandardStorage · ${date(health.s3MeasuredAt)}`
              : "Daily CloudWatch metric unavailable"
          }
          icon={Cloud}
        />
        <Metric
          label="Bucket versioning"
          value={data?.versioning || "—"}
          foot="Older versions are outside current inventory"
          icon={Layers3}
        />
      </div>
      <div className="storage-notice">
        <Database size={18} />
        <div>
          <strong>
            {data?.bucket || "S3 bucket"} <span> / {data?.region || "—"}</span>
          </strong>
          <p>
            Current-key inventory and AWS measured storage can differ because
            retained versions and other stored data are not in the current
            listing. Inventory refreshes every 15 minutes.
          </p>
        </div>
        <span className="muted">{data ? ago(data.fetchedAt) : "Loading"}</span>
      </div>
      <div className="overview-grid">
        <Panel
          title="Storage allocation"
          subtitle="Largest folders by current object size"
        >
          <StorageMix data={data} />
        </Panel>
        <Panel
          title="Catalog integrity"
          subtitle="References compared with the current S3 inventory"
        >
          {data?.manifests.map((m) => (
            <div className="catalog-row" key={m.key}>
              <span className="catalog-icon">
                <FileJson size={20} />
              </span>
              <div>
                <strong>{m.key}</strong>
                <small>
                  {number(m.entries)} entries ·{" "}
                  {m.modified ? ago(m.modified) : "Unknown update"}
                </small>
              </div>
              <Pill status={m.missing ? "partial" : "succeeded"}>
                {m.missing ? `${m.missing} missing` : "References found"}
              </Pill>
            </div>
          ))}
          {data?.issues.map((issue) => (
            <div className="integrity-note" key={issue.title}>
              <TriangleAlert size={15} />
              <div>
                <strong>
                  {issue.title} · {number(issue.count)}
                </strong>
                <p>{issue.detail}</p>
              </div>
            </div>
          ))}
        </Panel>
      </div>
      <Panel
        title="Bucket explorer"
        subtitle="Folders ordered by storage size"
        action={
          <label className="search-box">
            <Search size={16} />
            <input
              aria-label="Filter folders"
              placeholder="Find a folder…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        }
      >
        {loading && !data ? (
          <Skeleton label="Building the S3 inventory…" />
        ) : (
          <div className="table-scroll">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Folder</th>
                  <th>Purpose</th>
                  <th>Objects</th>
                  <th>Size</th>
                  <th>Share of storage</th>
                </tr>
              </thead>
              <tbody>
                {data?.prefixes
                  .filter((p) => p.name.includes(query.toLowerCase()))
                  .map((p) => (
                    <tr key={p.name}>
                      <td>
                        <span className="folder-name">
                          <Folder size={16} />
                          {p.name}
                        </span>
                      </td>
                      <td className="muted">{p.purpose}</td>
                      <td>{number(p.objects)}</td>
                      <td>{bytes(p.bytes)}</td>
                      <td>
                        <div className="usage-bar">
                          <span
                            style={{
                              width: `${Math.max(1, (p.bytes / data.bytes) * 100)}%`,
                            }}
                          />
                        </div>
                        <small className="muted">
                          {((p.bytes / data.bytes) * 100).toFixed(1)}%
                        </small>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
function CostsPage({
  data,
  error,
  loading,
}: {
  data: Costs | null;
  error?: string | null;
  loading: boolean;
}) {
  const delta =
    data && data.previousTotal > 0
      ? ((data.total - data.previousTotal) / data.previousTotal) * 100
      : null;
  return (
    <>
      <SourceError message={error} />
      <div className="billing-scope">
        <Wallet size={20} />
        <div>
          <strong>AWS account billing</strong>
          <p>
            These are account-wide charges for{" "}
            {data?.account || "the connected account"}, not Wallee-only costs.
            Modal GPU, Vercel, and Supabase invoices are separate and are not
            included.
          </p>
        </div>
        <Pill status="partial">
          {data?.estimated ? "Estimated" : "AWS reported"}
        </Pill>
      </div>
      <div className="metric-grid three">
        <Metric
          label="Month to date"
          value={money(data?.total, data?.currency)}
          foot={
            data
              ? `From ${date(data.start)} · unblended cost`
              : "AWS Cost Explorer"
          }
          icon={Wallet}
        />
        <Metric
          label="Previous month · comparable days"
          value={money(data?.previousTotal, data?.currency)}
          foot={
            data
              ? `First ${data.previousDays} days of the previous month`
              : "Same elapsed-day window"
          }
          icon={Clock3}
        />
        <Metric
          label="Change from previous period"
          value={
            delta == null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`
          }
          foot={
            delta == null
              ? "Comparison unavailable without prior spend"
              : "Historical comparison, not a forecast"
          }
          icon={Activity}
        />
      </div>
      <Panel
        title="Daily AWS spend"
        subtitle="UTC billing dates · hover a point for the reported amount"
        action={
          <span className="muted">
            {data ? `Retrieved ${ago(data.fetchedAt)}` : "Loading"}
          </span>
        }
      >
        {loading && !data ? (
          <Skeleton label="Reading Cost Explorer…" />
        ) : (
          <CostChart data={data} large />
        )}
      </Panel>
      <Panel
        title="Spend by service"
        subtitle="All AWS services in the connected account"
      >
        <div className="table-scroll">
          <table className="ops-table">
            <thead>
              <tr>
                <th>AWS service</th>
                <th>Cost</th>
                <th>Share of total</th>
              </tr>
            </thead>
            <tbody>
              {data?.services.map((s) => (
                <tr key={s.name}>
                  <td>
                    <span className="folder-name">
                      <Cloud size={17} />
                      {s.name.replace(/^Amazon /, "")}
                    </span>
                  </td>
                  <td>{money(s.total, data.currency)}</td>
                  <td>
                    <div className="cost-service-bar">
                      <span
                        style={{
                          width: `${data.total ? Math.max(0, (s.total / data.total) * 100) : 0}%`,
                        }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel-footer">
          Billing refreshes every 6 hours. AWS may revise estimated charges;
          this is not an invoice.
        </div>
      </Panel>
    </>
  );
}
function LibraryPage() {
  const [type, setType] = useState("phone");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);
  const source = useSource<Library>(
    `library?${new URLSearchParams({ type, q: search, category, page: String(page) })}`,
  );
  return (
    <>
      <div className="library-toolbar">
        <div className="segmented">
          {[
            ["phone", "Phone catalog"],
            ["desktop", "Desktop outputs"],
            ["review", "Awaiting review"],
          ].map(([id, label]) => (
            <button
              className={type === id ? "selected" : ""}
              key={id}
              onClick={() => {
                setType(id);
                setCategory("");
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="library-filters">
          <label className="search-box">
            <Search size={16} />
            <input
              aria-label="Search images"
              placeholder="Search images…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <select
            aria-label="Filter image category"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All categories</option>
            {source.data?.categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="library-caption">
        <span>
          {number(source.data?.total)}{" "}
          {type === "phone"
            ? "published catalog entries"
            : type === "desktop"
              ? "stored desktop outputs"
              : "images awaiting review"}
        </span>
        <span>
          {type === "desktop"
            ? "Storage presence does not imply publication."
            : "Browsing only · no image changes"}
        </span>
      </div>
      <SourceError message={source.error} />
      {source.loading ? (
        <div className="gallery-skeleton">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} />
          ))}
        </div>
      ) : (
        <div className={`image-grid ${type !== "phone" ? "landscape" : ""}`}>
          {source.data?.items.map((item) => (
            <button
              className="image-tile"
              key={item.key}
              onClick={() => setSelected(item)}
            >
              <div className="tile-preview">
                <img
                  src={item.thumb}
                  alt={`${item.category} wallpaper preview`}
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.style.visibility = "hidden";
                  }}
                />
                <ImageIcon className="image-placeholder" size={25} />
                <span className="tile-type">
                  {type === "phone"
                    ? "PHONE"
                    : type === "review"
                      ? "REVIEW"
                      : "DESKTOP"}
                </span>
                <span className="tile-open">
                  <ArrowUpRight size={16} />
                </span>
              </div>
              <div className="tile-caption">
                <strong>{title(item.category)}</strong>
                <span>
                  {item.width && item.height
                    ? `${item.width} × ${item.height}`
                    : item.bytes
                      ? bytes(item.bytes)
                      : "Dimensions not recorded"}
                </span>
                <small title={item.key}>{item.key.split("/").pop()}</small>
              </div>
            </button>
          ))}
        </div>
      )}
      {!source.loading && !source.data?.items.length && !source.error && (
        <Empty
          icon={ImageIcon}
          title="No images match these filters"
          description="Try another category or search term."
        />
      )}
      <div className="pagination">
        <span>
          Page {page} of {source.data?.pages || 1}
        </span>
        <div>
          <button
            className="ops-button"
            disabled={page <= 1 || source.loading}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft size={15} />
            Previous
          </button>
          <button
            className="ops-button"
            disabled={page >= (source.data?.pages || 1) || source.loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
      {selected && (
        <div className="drawer-backdrop" onClick={() => setSelected(null)}>
          <section
            className="image-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Image details"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="dialog-close icon-button"
              aria-label="Close image"
              onClick={() => setSelected(null)}
            >
              <X size={20} />
            </button>
            <div className="dialog-image">
              <img src={selected.url} alt={`${selected.category} wallpaper`} />
            </div>
            <div className="dialog-info">
              <Pill status="neutral">{title(selected.type)}</Pill>
              <h2>{title(selected.category)}</h2>
              <p>
                {selected.width
                  ? `${selected.width} × ${selected.height}`
                  : "Dimensions not indexed in this view"}
              </p>
              <code>{selected.key}</code>
              <a
                className="ops-button primary"
                href={selected.url}
                target="_blank"
                rel="noreferrer"
              >
                Open original
                <ExternalLink size={15} />
              </a>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
function SystemPage({
  pipeline,
  storage,
  costs,
  health,
  errors,
}: {
  pipeline: Pipeline | null;
  storage: StorageSummary | null;
  costs: Costs | null;
  health: Health | null;
  errors: Record<string, string | null | undefined>;
}) {
  const sources = [
    {
      name: "Processing database",
      detail: "Supabase · Wallee",
      icon: Database,
      data: pipeline,
      error: errors.pipeline,
    },
    {
      name: "Object storage",
      detail: storage ? `${storage.bucket} · ${storage.region}` : "Amazon S3",
      icon: HardDrive,
      data: storage,
      error: errors.storage,
    },
    {
      name: "Account billing",
      detail: "AWS Cost Explorer · account-wide",
      icon: Wallet,
      data: costs,
      error: errors.costs,
    },
    {
      name: "Delivery metrics",
      detail: "CloudFront & S3 · CloudWatch",
      icon: Cloud,
      data: health,
      error: errors.health,
    },
  ];
  return (
    <>
      <div className="connection-grid">
        {sources.map((s) => (
          <div className="connection-card" key={s.name}>
            <div className="connection-top">
              <s.icon size={22} />
              <Pill
                status={s.data ? "succeeded" : s.error ? "failed" : "neutral"}
              >
                {s.data ? "Readable" : s.error ? "Unavailable" : "Loading"}
              </Pill>
            </div>
            <h2>{s.name}</h2>
            <p>{s.detail}</p>
            <small>
              {s.data
                ? `Last retrieved ${ago(s.data.fetchedAt)}`
                : s.error || "Connecting…"}
            </small>
          </div>
        ))}
      </div>
      <div className="metric-grid three">
        <Metric
          label="CloudFront requests"
          value={number(health?.cloudfront.requests)}
          foot="Last 24 hours · AWS metrics"
          icon={Cloud}
        />
        <Metric
          label="Reported delivery error rate"
          value={
            health?.cloudfront.errorRate == null
              ? "—"
              : `${health.cloudfront.errorRate.toFixed(2)}%`
          }
          foot="CloudFront total HTTP error rate"
          icon={Activity}
        />
        <Metric
          label="Observed database images"
          value={number(pipeline?.summary.database_images)}
          foot="Stored wallpaper records, not unique media"
          icon={Database}
        />
      </div>
      <Panel
        title="Scheduled automation"
        subtitle="Read from the live database. No schedule controls are exposed here."
      >
        <div className="table-scroll">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Schedule</th>
                <th>Enabled</th>
                <th>Last result</th>
                <th>Last finished</th>
              </tr>
            </thead>
            <tbody>
              {pipeline?.summary.schedules.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>
                    <code>{s.schedule}</code>
                  </td>
                  <td>
                    <Pill status={s.active ? "succeeded" : "neutral"}>
                      {s.active ? "Enabled" : "Disabled"}
                    </Pill>
                  </td>
                  <td>
                    <Pill
                      status={
                        s.last_status === "succeeded"
                          ? "succeeded"
                          : s.last_status === "failed"
                            ? "failed"
                            : "neutral"
                      }
                    >
                      {s.last_status || "Not recorded"}
                    </Pill>
                  </td>
                  <td className="muted">{ago(s.last_finished)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <div className="overview-grid">
        <Panel
          title="Coverage & boundaries"
          subtitle="What this dashboard can and cannot establish"
        >
          <ul className="coverage-list">
            <li>
              <CheckCircle2 size={17} />
              <span>
                New ingestion, upscaling, desktop and publishing operations
                record their stages and outcomes.
              </span>
            </li>
            <li>
              <CheckCircle2 size={17} />
              <span>
                Storage references are compared with actual current S3 object
                keys.
              </span>
            </li>
            <li>
              <Clock3 size={17} />
              <span>
                Historical service logs are not backfilled. A readable data
                source does not prove every processing service is healthy.
              </span>
            </li>
            <li>
              <Wallet size={17} />
              <span>
                Modal, Vercel and Supabase invoices are not part of AWS billing.
              </span>
            </li>
          </ul>
        </Panel>
        <Panel
          title="Service consoles"
          subtitle="Open the provider for deeper diagnostics"
        >
          <a
            className="console-link"
            href="https://modal.com/apps/harrir-prod-2/main"
            target="_blank"
            rel="noreferrer"
          >
            <Zap size={18} />
            <div>
              <strong>Modal workspace</strong>
              <small>harrir-prod-2 · containers and service logs</small>
            </div>
            <ExternalLink size={15} />
          </a>
          <a
            className="console-link"
            href="https://vercel.com/gautam-ranas-projects/insta-s3-client-uploader"
            target="_blank"
            rel="noreferrer"
          >
            <Layers3 size={18} />
            <div>
              <strong>Vercel deployment</strong>
              <small>Admin application and runtime logs</small>
            </div>
            <ExternalLink size={15} />
          </a>
          <a
            className="console-link"
            href="https://supabase.com/dashboard/project/swmhjxpiwopguxwnjbdv"
            target="_blank"
            rel="noreferrer"
          >
            <Database size={18} />
            <div>
              <strong>Supabase database</strong>
              <small>Processing records and scheduled tasks</small>
            </div>
            <ExternalLink size={15} />
          </a>
        </Panel>
      </div>
    </>
  );
}
function RunDrawer({ run, onClose }: { run: Run; onClose: () => void }) {
  const source = useSource<Event[]>(
    `run?id=${encodeURIComponent(run.id)}`,
    15000,
  );
  const events = source.data || [];
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <section
        className="run-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Operation details"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <span className="eyebrow">OPERATION DETAILS</span>
          <button
            className="icon-button"
            aria-label="Close details"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <h2>{title(run.kind)}</h2>
        <Pill status={run.status} />
        <p className="run-description">{run.message}</p>
        <div className="run-meta">
          <span>
            Started<strong>{new Date(run.started_at).toLocaleString()}</strong>
          </span>
          <span>
            Last update<strong>{ago(run.updated_at)}</strong>
          </span>
          <span>
            Reference<code>{run.reference || run.id}</code>
          </span>
        </div>
        <h3>Recorded stages</h3>
        <p className="muted small-text">
          Latest 250 stages for this operation.
        </p>
        <SourceError message={source.error} />
        {source.loading && !events.length && <Skeleton />}
        <div className="event-timeline">
          {[...events].reverse().map((event) => (
            <div className={`timeline-event ${event.level}`} key={event.id}>
              <span className="event-dot">
                {event.level === "error" ? (
                  <X size={12} />
                ) : (
                  <Check size={12} />
                )}
              </span>
              <div>
                <strong>{event.message}</strong>
                <span>
                  {title(event.stage)} ·{" "}
                  {new Date(event.created_at).toLocaleTimeString()}
                </span>
                {Object.keys(event.details).length > 0 && (
                  <div className="event-details">
                    {Object.entries(event.details).map(([key, value]) => (
                      <small key={key}>
                        {title(key)}: {String(value)}
                      </small>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        {!events.length && !source.loading && !source.error && (
          <Empty
            title="No recorded stages"
            description="This operation does not have stage records yet."
          />
        )}
        <details className="technical-details">
          <summary>Technical details</summary>
          <pre>{JSON.stringify({ id: run.id, ...run.details }, null, 2)}</pre>
        </details>
      </section>
    </div>
  );
}
