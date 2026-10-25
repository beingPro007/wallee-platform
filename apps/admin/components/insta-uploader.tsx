"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
import { createSection } from "@/app/actions/sections"

// Modal ETL worker (replaces the old ECS/Fargate trigger). Accepts a POST
// with { url, session_slug } and spawns a detached scrape → S3 → upscale_queue job.
const API_URL = process.env.NEXT_PUBLIC_MODAL_INGEST_URL || "https://harrir-prod-2--wall-e-worker-ingest.modal.run"

function toSlug(name: string) {
  return name.toLowerCase().trim().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "")
}

export function SocialUploader({ onSectionCreated }: { onSectionCreated?: () => void }) {
  const [url, setUrl] = useState("")
  const [sessionName, setSessionName] = useState("")
  const [isFreshDrops, setIsFreshDrops] = useState(false)
  const [status, setStatus] = useState("")
  const [loading, setLoading] = useState(false)

  const instaRegex = /^(https?:\/\/)?(www\.)?instagram\.com\/(p|reel|tv)\/[A-Za-z0-9_-]+(\/)?(\?.*)?$/
  const pinterestRegex = /^(https?:\/\/)?(www\.)?(pinterest\.com|pin\.it)\/.*$/
  const wallhavenRegex = /^(https?:\/\/)?(www\.)?(wallhaven\.cc|whvn\.cc)\/.*$/

  const handleUpload = async () => {
    const trimmedUrl = url.trim()
    if (!trimmedUrl) { setStatus("⚠️ Please enter a URL."); return }

    const isInsta = instaRegex.test(trimmedUrl)
    const isPin = pinterestRegex.test(trimmedUrl)
    const isWall = wallhavenRegex.test(trimmedUrl)
    if (!isInsta && !isPin && !isWall) {
      setStatus("⚠️ Please enter a valid Instagram, Pinterest, or Wallhaven URL.")
      return
    }

    // Session name is OPTIONAL. With a name → premium collection; without →
    // the worker auto-classifies images into categories.
    const hasSession = !!sessionName.trim()
    const slug = hasSession ? toSlug(sessionName) : ""

    setLoading(true)
    setStatus(hasSession
      ? `⏳ Triggering scrape for "${sessionName}"…`
      : `⏳ Triggering scrape (auto-classify)…`)

    try {
      // 1. Start the scrape. Only send session_slug when one was provided.
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hasSession ? { url: trimmedUrl, session_slug: slug } : { url: trimmedUrl }),
      })
      const data = await res.json()

      if (!res.ok || data?.status === "error") {
        setStatus(`❌ Scrape error:\n${JSON.stringify(data, null, 2)}`)
        return
      }

      // No session → nothing to record; images are auto-sorted into categories.
      if (!hasSession) {
        setStatus(`✅ Scrape started (auto-classify). Images will be sorted into categories automatically.`)
        setUrl("")
        return
      }

      setStatus(`✅ Scrape started! Syncing section record…`)

      // 2. Upsert the home_sections record. Idempotent — scraping MORE media
      //    into an existing collection just adds to it (no guardrail).
      try {
        const section = await createSection(sessionName.trim(), slug, `premium/${slug}/`, isFreshDrops)
        setStatus(
          `🎉 Done! Media is being added to collection "${section.name}".\n` +
          `→ Once upscaling finishes, hit "Build JSON" in Sections Manager to (re)publish`
        )
        onSectionCreated?.()
      } catch (createErr) {
        setStatus(
          `✅ Scrape started, but section sync failed:\n` +
          `${createErr instanceof Error ? createErr.message : createErr}`
        )
      }

      setUrl("")
      setSessionName("")
    } catch (err) {
      setStatus(`❌ Network error: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="w-full max-w-md p-6">
      <h2 className="text-2xl font-bold mb-6 text-center">📸 Social Media Scraper</h2>

      <div className="space-y-4">
        {/* Session name (optional) */}
        <div>
          <label className="block text-sm font-medium mb-1.5">
            Session name <span className="text-muted-foreground font-normal">(optional)</span>
          </label>
          <Input
            type="text"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            placeholder="e.g. Anime Winter Collection"
            disabled={loading}
          />
          <p className="text-xs text-muted-foreground mt-1">
            {sessionName ? (
              <>
                slug: <code className="bg-muted px-1 rounded">{toSlug(sessionName)}</code>
                {" "}· S3 prefix:{" "}
                <code className="bg-muted px-1 rounded">premium/{toSlug(sessionName)}/</code>
              </>
            ) : (
              <>Leave empty to auto-classify images into categories (no collection).</>
            )}
          </p>
        </div>

        {/* URL */}
        <div>
          <label className="block text-sm font-medium mb-1.5">Post, Board, or Search URL</label>
          <Input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Instagram / Pinterest / Wallhaven URL…"
            disabled={loading}
            onFocus={() => setStatus("")}
          />
        </div>

        {/* Fresh drops toggle */}
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isFreshDrops}
            onChange={(e) => setIsFreshDrops(e.target.checked)}
            disabled={loading}
            className="accent-orange-500 w-4 h-4"
          />
          <span>Mark as <strong>Fresh Drops</strong> banner section</span>
        </label>

        <Button
          onClick={handleUpload}
          disabled={loading || !url.trim()}
          className="w-full"
        >
          {loading ? "🚀 Processing…" : sessionName.trim() ? "🚀 Scrape & Create Section" : "🚀 Scrape (Auto-Classify)"}
        </Button>

        {status && (
          <div className="mt-2 p-3 bg-secondary rounded-lg text-sm font-mono whitespace-pre-wrap break-words">
            {status}
          </div>
        )}
      </div>
    </Card>
  )
}
