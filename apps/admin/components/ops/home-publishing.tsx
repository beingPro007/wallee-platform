"use client";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import type { HomeSection, PublishPreview } from "@/lib/home/types";
async function api<T>(body?: unknown, query = ""): Promise<T> {
  const r = await fetch(
    "/api/home" + query,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          cache: "no-store",
        }
      : { cache: "no-store" },
  );
  const value = await r.json();
  if (!r.ok) throw new Error(value.error || "Unable to save.");
  return value;
}
const slugify = (v: string) =>
  v
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 80);
const imageUrl = (key: string) =>
  "https://d2xd8jrwaurdjd.cloudfront.net/" +
  key.split("/").map(encodeURIComponent).join("/");
export function HomePublishing() {
  const [rows, setRows] = useState<HomeSection[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [preview, setPreview] = useState<PublishPreview | null>(null),
    [limit, setLimit] = useState(24),
    [creating, setCreating] = useState(false),
    [newName, setNewName] = useState(""),
    [newFolder, setNewFolder] = useState(""),
    [folders, setFolders] = useState<string[]>([]);
  const [name, setName] = useState(""),
    [enabled, setEnabled] = useState(false),
    [fresh, setFresh] = useState(false);
  const current = rows.find((s) => s.id === selected);
  const reload = useCallback(async () => {
    const data = await api<HomeSection[]>();
    setRows(data);
    setSelected((id) =>
      data.some((s) => s.id === id) ? id : data[0]?.id || null,
    );
    return data;
  }, []);
  useEffect(() => {
    reload()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    fetch("/api/ops/storage")
      .then((r) => r.json())
      .then((r) =>
        setFolders(
          (r.data?.prefixes || [])
            .filter((p: { purpose: string }) => p.purpose === "Category images")
            .map((p: { name: string }) => p.name),
        ),
      )
      .catch(() => {});
  }, [reload]);
  useEffect(() => {
    setName(current?.name || "");
    setEnabled(current?.is_enabled || false);
    setFresh(current?.is_fresh_drops || false);
    setPreview(null);
    setLimit(24);
  }, [current?.id, current?.updated_at]);
  async function perform(action: string, work: () => Promise<void>) {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
      try {
        await reload();
      } catch {
        /* Preserve the original actionable error. */
      }
    } finally {
      setBusy("");
    }
  }
  async function move(index: number, direction: number) {
    const next = [...rows];
    [next[index], next[index + direction]] = [
      next[index + direction],
      next[index],
    ];
    await perform("order", async () => {
      await api({ action: "reorder", ids: next.map((s) => s.id) });
      await reload();
      setNotice("Home screen order saved.");
    });
  }
  const dirty =
    !!current &&
    (name !== current.name ||
      enabled !== current.is_enabled ||
      fresh !== current.is_fresh_drops);
  return (
    <div className="home-curation">
      <div className="home-strategy">
        <div>
          <span className="home-step">1</span>
          <strong>Curate</strong>
          <small>Name, order and visibility</small>
        </div>
        <div>
          <span className="home-step">2</span>
          <strong>Preview</strong>
          <small>Check processed images</small>
        </div>
        <div>
          <span className="home-step">3</span>
          <strong>Publish JSON</strong>
          <small>Update the app’s collection</small>
        </div>
      </div>
      <div className="home-toolbar">
        <p>
          Settings save directly to the home screen. Publishing updates a
          collection’s images.
        </p>
        <div>
          <button
            className="ops-button"
            disabled={!!busy || loading}
            onClick={() =>
              perform("refresh", async () => {
                await reload();
              })
            }
          >
            <RefreshCw size={15} />
            Refresh sections
          </button>
          <button
            className="ops-button primary"
            disabled={!!busy}
            onClick={() => setCreating(true)}
          >
            <Plus size={15} />
            New section
          </button>
        </div>
      </div>
      {error && (
        <div className="source-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="home-success" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {creating && (
        <form
          className="ops-panel home-create"
          onSubmit={(e) => {
            e.preventDefault();
            perform("create", async () => {
              const s = await api<HomeSection>({
                action: "create",
                name: newName,
                slug: slugify(newName),
                prefix: newFolder || slugify(newName) + "/",
              });
              await reload();
              setSelected(s.id);
              setCreating(false);
              setNewName("");
              setNewFolder("");
              setNotice(
                "Section created as hidden. Preview and publish its images before showing it.",
              );
            });
          }}
        >
          <div className="home-editor-heading">
            <h2>Create a section</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Cancel new section"
              disabled={!!busy}
              onClick={() => setCreating(false)}
            >
              <X size={18} />
            </button>
          </div>
          <div className="home-create-fields">
            <label>
              Section name
              <input
                required
                maxLength={100}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Weekend picks"
              />
            </label>
            <label>
              Processed image folder
              <input
                list="home-folders"
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                placeholder={
                  slugify(newName)
                    ? slugify(newName) + "/"
                    : "Choose a category folder"
                }
              />
              <datalist id="home-folders">
                {folders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </label>
          </div>
          <p className="muted">
            Collection ID: {slugify(newName) || "generated from the name"}. New
            sections start hidden.
          </p>
          <button
            className="ops-button primary"
            disabled={!!busy || !slugify(newName)}
          >
            {busy === "create" ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <Plus size={15} />
            )}
            Create hidden section
          </button>
        </form>
      )}
      {loading ? (
        <div className="ops-loading">
          <Loader2 className="spin" size={18} />
          Loading home sections…
        </div>
      ) : (
        <div className="home-workbench">
          <section className="ops-panel home-section-list">
            <div className="panel-head">
              <div>
                <h2>Home screen sections</h2>
                <p>{rows.length} sections · arrows change the app order</p>
              </div>
            </div>
            {!rows.length && (
              <div className="ops-empty">
                <ImageIcon />
                <strong>No sections yet</strong>
                <p>Create a hidden section to start curating.</p>
              </div>
            )}
            {rows.map((s, i) => (
              <div
                className={`home-section-row ${selected === s.id ? "selected" : ""}`}
                key={s.id}
              >
                <button
                  className="home-select"
                  disabled={!!busy}
                  onClick={() => {
                    setSelected(s.id);
                    setError("");
                    setNotice("");
                  }}
                >
                  <span className="home-cover">
                    {s.cover_image_url ? (
                      <img src={s.cover_image_url} alt="" loading="lazy" />
                    ) : (
                      <ImageIcon size={18} />
                    )}
                  </span>
                  <span>
                    <strong>{s.name}</strong>
                    <small>{s.wallpaper_count} recorded images</small>
                    <span className="home-tags">
                      <span className={s.is_enabled ? "shown" : "hidden"}>
                        {s.is_enabled ? (
                          <Eye size={11} />
                        ) : (
                          <EyeOff size={11} />
                        )}{" "}
                        {s.is_enabled ? "Visible" : "Hidden"}
                      </span>
                      {s.is_fresh_drops && <span>Fresh Drops</span>}
                    </span>
                  </span>
                </button>
                <div className="home-order">
                  <button
                    className="icon-button"
                    aria-label={`Move ${s.name} up`}
                    disabled={!!busy || i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Move ${s.name} down`}
                    disabled={!!busy || i === rows.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown size={15} />
                  </button>
                </div>
              </div>
            ))}
          </section>
          {current ? (
            <section className="ops-panel home-editor">
              <div className="home-editor-heading">
                <div>
                  <span className="eyebrow">SECTION SETTINGS</span>
                  <h2>{current.name}</h2>
                </div>
                <span className="muted">
                  {current.json_url ? "Published collection" : "Unpublished"}
                </span>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  perform("save", async () => {
                    await api({
                      action: "update",
                      id: current.id,
                      version: current.updated_at,
                      changes: {
                        name,
                        is_enabled: enabled,
                        is_fresh_drops: fresh,
                      },
                    });
                    await reload();
                    setNotice("Section settings saved.");
                  });
                }}
              >
                <label>
                  Display name
                  <input
                    value={name}
                    maxLength={100}
                    required
                    disabled={!!busy}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <div className="home-toggles">
                  <label>
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={
                        !!busy || !current.json_url || !current.wallpaper_count
                      }
                      onChange={(e) => setEnabled(e.target.checked)}
                    />
                    <span>
                      Show on home screen
                      <small>
                        {current.json_url
                          ? "Hidden sections keep their images and publication."
                          : "Publish a collection before making it visible."}
                      </small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={fresh}
                      disabled={!!busy}
                      onChange={(e) => setFresh(e.target.checked)}
                    />
                    <span>
                      Fresh Drops
                      <small>
                        Only one section can be the Fresh Drops banner.
                      </small>
                    </span>
                  </label>
                </div>
                <button className="ops-button" disabled={!!busy || !dirty}>
                  {busy === "save" ? (
                    <Loader2 className="spin" size={15} />
                  ) : (
                    <Check size={15} />
                  )}
                  Save settings
                </button>
              </form>
              <div className="home-publish">
                <h3>Collection images</h3>
                <p>
                  Preview combines saved images with the existing catalog. Queue
                  cleanup won’t empty your collection.
                </p>
                <div className="home-publish-actions">
                  <button
                    className="ops-button primary"
                    disabled={!!busy || dirty}
                    onClick={() =>
                      perform("preview", async () => {
                        setPreview(
                          await api<PublishPreview>(
                            undefined,
                            "?preview=" + current.id,
                          ),
                        );
                        setLimit(24);
                      })
                    }
                  >
                    {busy === "preview" ? (
                      <Loader2 className="spin" size={15} />
                    ) : (
                      <Eye size={15} />
                    )}
                    Preview build
                  </button>
                  {current.json_url && (
                    <a
                      className="ops-button"
                      href={current.json_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Published JSON
                      <ExternalLink size={14} />
                    </a>
                  )}
                </div>
                {dirty && (
                  <p className="home-hint">Save settings before previewing.</p>
                )}
                {preview && (
                  <div className="home-build-preview">
                    <div className="home-build-numbers">
                      <span>
                        <strong>{preview.count}</strong>ready images
                      </span>
                      <span>
                        <strong>{preview.added}</strong>new images
                      </span>
                      <span>
                        <strong>{preview.previousCount}</strong>previous entries
                      </span>
                    </div>
                    {current.wallpaper_count !== preview.previousCount && (
                      <p className="home-hint">
                        Saved section count: {current.wallpaper_count}.
                        Published catalog: {preview.previousCount}. Publishing
                        will update the saved count.
                      </p>
                    )}
                    {preview.missing > 0 && (
                      <p className="source-error">
                        {preview.missing} previous image references no longer
                        exist in storage and will be omitted.
                      </p>
                    )}
                    {preview.missingPreviews > 0 && (
                      <p className="home-hint">
                        {preview.missingPreviews} thumbnail previews are
                        missing. Original images remain available.
                      </p>
                    )}
                    <p className="muted small-text">
                      Choose an image below to use it as the section cover.
                    </p>
                    <div className="home-preview-grid">
                      {preview.entries.slice(0, limit).map((e) => (
                        <button
                          key={e.p}
                          disabled={!!busy}
                          title={e.p}
                          aria-label={`Use ${e.p.split("/").pop()} as cover`}
                          onClick={() =>
                            perform("cover", async () => {
                              await api({
                                action: "update",
                                id: current.id,
                                version: current.updated_at,
                                changes: { cover_image_url: imageUrl(e.p) },
                              });
                              await reload();
                              setNotice(
                                "Section cover saved. Preview again when ready to publish.",
                              );
                            })
                          }
                        >
                          <img
                            src={imageUrl(e.t || e.p)}
                            alt={e.p.split("/").pop()}
                            loading="lazy"
                            onError={(e) => {
                              e.currentTarget.style.visibility = "hidden";
                            }}
                          />
                          <ImageIcon size={16} />
                        </button>
                      ))}
                    </div>
                    {limit < preview.entries.length && (
                      <button
                        className="text-button"
                        disabled={!!busy}
                        onClick={() => setLimit((n) => n + 24)}
                      >
                        Show more images
                      </button>
                    )}
                    <button
                      className="ops-button primary home-publish-button"
                      disabled={!!busy || !preview.count}
                      onClick={() =>
                        perform("publish", async () => {
                          const r = await api<{ count: number }>({
                            action: "publish",
                            id: current.id,
                            token: preview.token,
                          });
                          await reload();
                          setPreview(null);
                          setNotice(
                            `Published ${r.count} images. Home screen visibility was preserved; the app refreshes on its next catalog load.`,
                          );
                        })
                      }
                    >
                      {busy === "publish" ? (
                        <Loader2 className="spin" size={15} />
                      ) : (
                        <Upload size={15} />
                      )}
                      Publish JSON · {preview.count} images
                    </button>
                    <p className="muted small-text">
                      Publishing does not enable hidden sections or delete image
                      files.
                    </p>
                  </div>
                )}
              </div>
            </section>
          ) : (
            <section className="ops-panel ops-empty">
              <ImageIcon />
              <strong>Select a section</strong>
              <p>Its settings and publishing preview will appear here.</p>
            </section>
          )}
        </div>
      )}
      <section className="ops-panel home-screen-preview">
        <div className="panel-head">
          <div>
            <h2>Home screen preview</h2>
            <p>
              Saved visible sections, in their current order. The mobile app
              controls the final layout.
            </p>
          </div>
        </div>
        <div className="home-preview-rows">
          {rows
            .filter((s) => s.is_enabled)
            .map((s) => (
              <div className="home-mini-section" key={s.id}>
                {s.cover_image_url ? (
                  <img src={s.cover_image_url} alt="" loading="lazy" />
                ) : (
                  <ImageIcon />
                )}
                <div>
                  <strong>{s.name}</strong>
                  <small>
                    {s.is_fresh_drops ? "Fresh Drops · " : ""}
                    {s.wallpaper_count} images
                  </small>
                </div>
              </div>
            ))}
          {!loading && !rows.some((s) => s.is_enabled) && (
            <p className="muted">No visible sections.</p>
          )}
        </div>
      </section>
    </div>
  );
}
