"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  listDesktopCandidates,
  approveDesktopCandidates,
  rejectDesktopCandidate,
  type DesktopCandidate,
} from "@/app/actions/desktop"

export function DesktopCandidates() {
  const [items, setItems] = useState<DesktopCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [note, setNote] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await listDesktopCandidates())
    } catch (e) {
      setNote(`Failed to load: ${e instanceof Error ? e.message : e}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const setB = (k: string, v: boolean) => setBusy((b) => ({ ...b, [k]: v }))

  const approve = async (key: string) => {
    setB(key, true)
    try {
      await approveDesktopCandidates([key])
      setItems((x) => x.filter((i) => i.key !== key))
      setNote("✅ Approved — upscaling to 8K in the background.")
    } catch (e) {
      setNote(`Approve failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setB(key, false)
    }
  }

  const reject = async (key: string) => {
    setB(key, true)
    try {
      await rejectDesktopCandidate(key)
      setItems((x) => x.filter((i) => i.key !== key))
    } catch (e) {
      setNote(`Reject failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setB(key, false)
    }
  }

  const approveAll = async () => {
    const keys = items.map((i) => i.key)
    if (!keys.length) return
    setNote("⏳ Approving all…")
    await approveDesktopCandidates(keys)
    setItems([])
    setNote(`✅ Approved ${keys.length} — upscaling to 8K in the background.`)
  }

  return (
    <div className="w-full max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-2xl font-bold">🖥️ Desktop Candidates</h2>
          <p className="text-sm text-muted-foreground">
            Rotated-landscape images the detector proposes as desktop wallpapers.
            Approve → upscaled to 8K. Reject → discarded.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={load} disabled={loading}>
            ↻ Refresh
          </Button>
          <Button onClick={approveAll} disabled={loading || !items.length}>
            Approve all ({items.length})
          </Button>
        </div>
      </div>

      {note && (
        <div className="mb-3 p-2 bg-secondary rounded text-sm">{note}</div>
      )}

      {loading ? (
        <p className="text-muted-foreground">Loading candidates…</p>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground">No candidates pending review. 🎉</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((it) => (
            <Card key={it.key} className="overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={it.url}
                alt={it.category}
                className="w-full aspect-video object-cover bg-muted"
                loading="lazy"
              />
              <div className="p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono truncate" title={it.key}>
                    {it.category}
                  </span>
                  {it.confidence != null && (
                    <span className="px-2 py-0.5 rounded bg-muted whitespace-nowrap">
                      conf {it.confidence.toFixed(2)}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    onClick={() => approve(it.key)}
                    disabled={busy[it.key]}
                  >
                    ✅ Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => reject(it.key)}
                    disabled={busy[it.key]}
                  >
                    🗑 Reject
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
