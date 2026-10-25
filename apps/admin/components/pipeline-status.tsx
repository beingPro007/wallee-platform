"use client"

import { useState, useEffect, useCallback } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { getSectionUpscaleStatus, buildSectionJson } from "@/app/actions/sections"
import type { SectionUpscaleStatus } from "@/app/actions/sections"

export function PipelineStatus() {
  const [sections, setSections] = useState<SectionUpscaleStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [building, setBuilding] = useState<string | null>(null)
  const [message, setMessage] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSections(await getSectionUpscaleStatus())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 30_000)
    return () => clearInterval(t)
  }, [refresh])

  const handleBuild = async (id: string) => {
    setBuilding(id)
    setMessage((m) => ({ ...m, [id]: "" }))
    try {
      const result = await buildSectionJson(id)
      setMessage((m) => ({ ...m, [id]: `✅ Built ${result.count} wallpapers` }))
      await refresh()
    } catch (e) {
      setMessage((m) => ({ ...m, [id]: `❌ ${(e as Error).message}` }))
    } finally {
      setBuilding(null)
    }
  }

  return (
    <div className="w-full max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Pipeline Status</h2>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          {loading ? "Refreshing…" : "↺ Refresh"}
        </Button>
      </div>

      {!loading && sections.length === 0 && (
        <p className="text-sm text-muted-foreground">No sections found.</p>
      )}

      {sections.map((s) => {
        const pct = s.total > 0 ? Math.round((s.completed / s.total) * 100) : 0
        const barColor = s.failed > 0
          ? "bg-destructive"
          : s.ready ? "bg-green-500" : "bg-primary"

        return (
          <Card key={s.id} className="p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{s.name}</p>
                <p className="text-xs text-muted-foreground font-mono">{s.slug}</p>
                {s.json_url && (
                  <p className="text-xs text-green-600 mt-0.5">JSON built</p>
                )}
              </div>
              <Button
                size="sm"
                disabled={!s.ready || building === s.id}
                onClick={() => handleBuild(s.id)}
              >
                {building === s.id ? "Building…" : "Build JSON"}
              </Button>
            </div>

            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${barColor}`}
                style={{ width: `${pct}%` }}
              />
            </div>

            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span>✅ {s.completed} done</span>
              <span>⏳ {s.pending} pending</span>
              {s.processing > 0 && <span>⚙️ {s.processing} processing</span>}
              {s.failed > 0 && <span className="text-destructive">❌ {s.failed} failed</span>}
              <span className="ml-auto font-medium">{pct}%</span>
            </div>

            {message[s.id] && (
              <p className="text-xs font-mono bg-muted px-2 py-1 rounded">{message[s.id]}</p>
            )}
          </Card>
        )
      })}
    </div>
  )
}
