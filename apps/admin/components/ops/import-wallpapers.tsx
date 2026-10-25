"use client";
import { useEffect, useState } from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  Check,
  Layers3,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { HomeSection } from "@/lib/home/types";
type Destination = "auto" | "collection" | "new";
export function ImportWallpapers({
  onHome,
  onActivity,
}: {
  onHome: () => void;
  onActivity: () => void;
}) {
  const [url, setUrl] = useState(""),
    [destination, setDestination] = useState<Destination>("auto"),
    [sectionId, setSectionId] = useState(""),
    [name, setName] = useState(""),
    [rows, setRows] = useState<HomeSection[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState<{ sectionName: string | null } | null>(
      null,
    );
  async function reload() {
    setLoading(true);
    try {
      const r = await fetch("/api/home", { cache: "no-store" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Unable to load collections.");
      setRows(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    reload();
  }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSuccess(null);
    try {
      const r = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, destination, sectionId, name }),
      });
      const data = await r.json();
      if (!r.ok) {
        if (data.sectionId) {
          setDestination("collection");
          setSectionId(data.sectionId);
        }
        await reload();
        throw new Error(data.error || "Import could not start.");
      }
      setSuccess(data);
      setUrl("");
      if (data.sectionId) {
        await reload();
        setDestination("collection");
        setSectionId(data.sectionId);
        setName("");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="import-layout">
      <section className="ops-panel import-form">
        <div className="home-editor-heading">
          <div>
            <span className="eyebrow">SCRAPE & INGEST</span>
            <h2>Bring in new wallpapers</h2>
          </div>
          <ArrowDownLeft size={24} />
        </div>
        <p className="muted">
          Import from Instagram, Pinterest or Wallhaven. Processing continues in
          the background.
        </p>
        <form onSubmit={submit}>
          <label>
            Source URL
            <input
              type="url"
              required
              value={url}
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://pin.it/…"
            />
          </label>
          <fieldset disabled={busy}>
            <legend>Where should the images go?</legend>
            {[
              [
                "auto",
                "Automatic categories",
                "Let the classifier choose categories. No home section is created.",
              ],
              [
                "collection",
                "Existing collection",
                "Add images to a collection you already curate.",
              ],
              [
                "new",
                "New home collection",
                "Create a hidden section with a name, then import its images.",
              ],
            ].map(([id, label, help]) => (
              <label
                className={`import-choice ${destination === id ? "selected" : ""}`}
                key={id}
              >
                <input
                  type="radio"
                  name="destination"
                  value={id}
                  checked={destination === id}
                  onChange={() => {
                    setDestination(id as Destination);
                    setError("");
                    setSuccess(null);
                  }}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{help}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {destination === "collection" && (
            <label>
              Collection
              <div className="import-collection-select">
                <select
                  aria-label="Collection"
                  required
                  value={sectionId}
                  disabled={busy || loading}
                  onChange={(e) => setSectionId(e.target.value)}
                >
                  <option value="">
                    {loading ? "Loading collections…" : "Choose a collection"}
                  </option>
                  {rows.map((s) => (
                    <option value={s.id} key={s.id}>
                      {s.name}
                      {s.is_enabled ? "" : " · hidden"}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy || loading}
                  aria-label="Refresh collection list"
                  onClick={reload}
                >
                  <RefreshCw size={16} />
                </button>
              </div>
              {!loading && !rows.length && (
                <small>No collections yet. Choose New home collection.</small>
              )}
            </label>
          )}
          {destination === "new" && (
            <label>
              Collection display name
              <input
                required
                maxLength={100}
                disabled={busy}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Weekend nature picks"
              />
              <small>
                The name appears on the mobile home screen after you publish and
                enable the section.
              </small>
            </label>
          )}
          {error && (
            <div className="source-error" role="alert">
              {error}
            </div>
          )}
          <button
            className="ops-button primary import-submit"
            disabled={
              busy || (destination === "collection" && (!sectionId || loading))
            }
          >
            {busy ? (
              <Loader2 size={17} className="spin" />
            ) : (
              <ArrowDownLeft size={17} />
            )}{" "}
            {busy ? "Sending import…" : "Start import"}
          </button>
        </form>
        {success && (
          <div className="import-success" role="status">
            <Check size={19} />
            <div>
              <strong>Import accepted</strong>
              <p>
                {success.sectionName
                  ? `Adding images to “${success.sectionName}”. Wait for processing, then preview and publish its JSON in Home & Publishing.`
                  : "Images will be categorized and processed. This does not create a named home-screen section."}
              </p>
              <div className="home-publish-actions">
                <button className="ops-button" onClick={onActivity}>
                  View activity
                  <ArrowRight size={14} />
                </button>
                {success.sectionName && (
                  <button className="ops-button primary" onClick={onHome}>
                    Home & Publishing
                    <ArrowRight size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </section>
      <aside className="ops-panel import-guide">
        <Layers3 size={25} />
        <h2>From URL to the home screen</h2>
        <ol>
          <li>
            <strong>Import</strong>
            <span>
              Download source images. A named collection uses its fixed
              destination rather than automatic classification.
            </span>
          </li>
          <li>
            <strong>Process</strong>
            <span>
              Phone images enter the upscale queue. Its scheduled check runs
              every 30 minutes; completion time varies.
            </span>
          </li>
          <li>
            <strong>Curate & publish</strong>
            <span>
              Open Home & Publishing, preview the finished images, publish JSON,
              then enable the section.
            </span>
          </li>
        </ol>
        <div className="import-routing-note">
          <strong>A name does not force phone format</strong>
          <p>
            Desktop processing is paused for redesign. Desktop candidates are
            skipped; they are not uploaded or added to phone collections.
          </p>
        </div>
        <button className="text-button" onClick={onHome}>
          Open Home & Publishing
          <ArrowRight size={14} />
        </button>
      </aside>
    </div>
  );
}
