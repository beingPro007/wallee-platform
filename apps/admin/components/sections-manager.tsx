"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import {
  listSections,
  createSection,
  updateSection,
  reorderSections,
  deleteSection,
  buildSectionJson,
  type HomeSection,
} from "@/app/actions/sections"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"

// ── Helpers ───────────────────────────────────────────────────────────────────

function toSlug(name: string) {
  return name.toLowerCase().trim().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "")
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionCard({
  section,
  index,
  total,
  onMoveUp,
  onMoveDown,
  onToggleEnabled,
  onToggleFreshDrops,
  onBuildJson,
  onDelete,
  onRename,
}: {
  section: HomeSection
  index: number
  total: number
  onMoveUp: () => void
  onMoveDown: () => void
  onToggleEnabled: () => void
  onToggleFreshDrops: () => void
  onBuildJson: () => void
  onDelete: () => void
  onRename: (name: string) => void
}) {
  const [buildStatus, setBuildStatus] = useState<string | null>(null)
  const [building, startBuilding] = useTransition()
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState(section.name)
  const nameRef = useRef<HTMLInputElement>(null)

  const handleBuild = () => {
    startBuilding(async () => {
      try {
        setBuildStatus("⏳ Scanning S3...")
        const { count } = await onBuildJson() as unknown as { count: number }
        setBuildStatus(`✅ ${count} wallpapers`)
        setTimeout(() => setBuildStatus(null), 4000)
      } catch (e) {
        setBuildStatus(`❌ ${e instanceof Error ? e.message : "Failed"}`)
      }
    })
  }

  return (
    <Card className="overflow-hidden border border-border/60 hover:border-border transition-colors">
      <div className="flex gap-0">
        {/* Cover image */}
        <div className="relative w-24 shrink-0 bg-muted">
          {section.cover_image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={section.cover_image_url}
              alt={section.name}
              className="w-full h-full object-cover aspect-[9/16]"
            />
          ) : (
            <div className="w-full aspect-[9/16] flex items-center justify-center text-3xl text-muted-foreground">
              🖼
            </div>
          )}
          {section.is_fresh_drops && (
            <div className="absolute top-1 left-1 bg-orange-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
              FRESH
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 p-3 flex flex-col gap-2 min-w-0">
          {/* Name row */}
          <div className="flex items-center gap-2">
            {editingName ? (
              <form
                className="flex gap-1 flex-1"
                onSubmit={(e) => {
                  e.preventDefault()
                  onRename(nameInput)
                  setEditingName(false)
                }}
              >
                <Input
                  ref={nameRef}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  className="h-7 text-sm flex-1"
                  autoFocus
                  onBlur={() => {
                    onRename(nameInput)
                    setEditingName(false)
                  }}
                />
              </form>
            ) : (
              <button
                className="font-semibold text-sm truncate text-left hover:text-primary transition-colors"
                onClick={() => {
                  setEditingName(true)
                  setTimeout(() => nameRef.current?.select(), 50)
                }}
                title="Click to rename"
              >
                {section.name}
              </button>
            )}

            {/* Wallpaper count badge */}
            {section.wallpaper_count > 0 && (
              <span className="shrink-0 text-[11px] bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded-full">
                {section.wallpaper_count}
              </span>
            )}
          </div>

          {/* Slug */}
          <div className="text-[11px] text-muted-foreground font-mono truncate">
            {section.json_url ? (
              <a href={section.json_url} target="_blank" rel="noreferrer" className="hover:underline">
                sessions/{section.slug}.json ↗
              </a>
            ) : (
              <span className="text-orange-500">No JSON yet — click Build</span>
            )}
          </div>

          {/* Toggles row */}
          <div className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={section.is_enabled}
                onChange={onToggleEnabled}
                className="accent-primary w-3.5 h-3.5"
              />
              Enabled
            </label>
            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={section.is_fresh_drops}
                onChange={onToggleFreshDrops}
                className="accent-orange-500 w-3.5 h-3.5"
              />
              Fresh Drops
            </label>
          </div>

          {/* Build status */}
          {buildStatus && (
            <div className="text-xs font-mono py-0.5">{buildStatus}</div>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap gap-1.5 mt-auto pt-1">
            <Button
              size="sm"
              variant="secondary"
              className="h-7 text-xs px-2"
              onClick={handleBuild}
              disabled={building}
            >
              {building ? "⏳" : "🔨"} Build JSON
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs px-2"
              onClick={onMoveUp}
              disabled={index === 0}
              title="Move up"
            >
              ↑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs px-2"
              onClick={onMoveDown}
              disabled={index === total - 1}
              title="Move down"
            >
              ↓
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-7 text-xs px-2 ml-auto"
              onClick={onDelete}
              title="Delete section"
            >
              🗑
            </Button>
          </div>
        </div>
      </div>
    </Card>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function SectionsManager() {
  const [sections, setSections] = useState<HomeSection[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, startCreate] = useTransition()

  // New section form
  const [newName, setNewName] = useState("")
  const [newSlug, setNewSlug] = useState("")
  const [newPrefix, setNewPrefix] = useState("")
  const [newIsFresh, setNewIsFresh] = useState(false)
  const [createError, setCreateError] = useState("")

  const reload = async () => {
    setLoading(true)
    try {
      setSections(await listSections())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() }, [])

  const handleCreate = () => {
    if (!newName.trim()) { setCreateError("Name is required"); return }
    const slug = newSlug.trim() || toSlug(newName)
    const prefix = newPrefix.trim() || `premium/${slug}/`

    startCreate(async () => {
      try {
        setCreateError("")
        await createSection(newName, slug, prefix, newIsFresh)
        setNewName(""); setNewSlug(""); setNewPrefix(""); setNewIsFresh(false)
        await reload()
      } catch (e) {
        setCreateError(e instanceof Error ? e.message : "Failed to create")
      }
    })
  }

  const handleMove = async (index: number, direction: "up" | "down") => {
    const next = [...sections]
    const swap = direction === "up" ? index - 1 : index + 1
    ;[next[index], next[swap]] = [next[swap], next[index]]
    setSections(next)
    await reorderSections(next.map((s) => s.id))
  }

  const handleToggle = async (id: string, field: "is_enabled" | "is_fresh_drops", value: boolean) => {
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, [field]: value } : s)))
    await updateSection(id, { [field]: value })
    if (field === "is_fresh_drops") await reload() // unique constraint might reject
  }

  const handleRename = async (id: string, name: string) => {
    if (!name.trim()) return
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)))
    await updateSection(id, { name })
  }

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this section? This cannot be undone.")) return
    setSections((prev) => prev.filter((s) => s.id !== id))
    await deleteSection(id)
  }

  const handleBuildJson = (id: string) => async () => {
    const result = await buildSectionJson(id)
    await reload()
    return result
  }

  return (
    <div className="w-full max-w-2xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">📱 Home Sections</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Control what appears on the mobile home screen — drag to reorder
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
          {loading ? "⏳" : "↻"} Refresh
        </Button>
      </div>

      {/* Section list */}
      {loading ? (
        <div className="text-center text-muted-foreground py-8">Loading sections…</div>
      ) : sections.length === 0 ? (
        <div className="text-center text-muted-foreground py-8 border rounded-lg">
          No sections yet. Create one below.
        </div>
      ) : (
        <div className="space-y-3">
          {sections.map((section, index) => (
            <SectionCard
              key={section.id}
              section={section}
              index={index}
              total={sections.length}
              onMoveUp={() => handleMove(index, "up")}
              onMoveDown={() => handleMove(index, "down")}
              onToggleEnabled={() => handleToggle(section.id, "is_enabled", !section.is_enabled)}
              onToggleFreshDrops={() => handleToggle(section.id, "is_fresh_drops", !section.is_fresh_drops)}
              onBuildJson={handleBuildJson(section.id)}
              onDelete={() => handleDelete(section.id)}
              onRename={(name) => handleRename(section.id, name)}
            />
          ))}
        </div>
      )}

      {/* New section form */}
      <Card className="p-4 border-dashed">
        <h3 className="font-semibold text-sm mb-3">➕ New Section</h3>
        <div className="space-y-2">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block">Display name *</label>
              <Input
                placeholder="e.g. Anime Picks"
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value)
                  if (!newSlug) setNewSlug(toSlug(e.target.value))
                  if (!newPrefix) setNewPrefix(`premium/${toSlug(e.target.value)}/`)
                }}
                className="h-8 text-sm"
              />
            </div>
            <div className="w-full sm:w-36">
              <label className="text-xs text-muted-foreground mb-1 block">Slug (auto)</label>
              <Input
                placeholder="anime_picks"
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                className="h-8 text-sm font-mono"
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              S3 prefix (where approved images live)
            </label>
            <Input
              placeholder="premium/anime/"
              value={newPrefix}
              onChange={(e) => setNewPrefix(e.target.value)}
              className="h-8 text-sm font-mono"
            />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={newIsFresh}
              onChange={(e) => setNewIsFresh(e.target.checked)}
              className="accent-orange-500 w-4 h-4"
            />
            Mark as Fresh Drops banner
          </label>

          {createError && (
            <p className="text-xs text-destructive">{createError}</p>
          )}

          <Button
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            className="w-full h-8 text-sm"
          >
            {creating ? "Creating…" : "Create Section"}
          </Button>
        </div>
      </Card>
    </div>
  )
}
