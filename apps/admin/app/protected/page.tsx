"use client"

import { useEffect, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { getSupabaseClient } from "@/lib/supabase/client"
import { SocialUploader } from "@/components/insta-uploader"
import { Button } from "@/components/ui/button"
import { SectionsManager } from "@/components/sections-manager"
import type { User } from "@supabase/supabase-js"
import { ImageModeration } from "@/components/image-moderation"
import { PipelineStatus } from "@/components/pipeline-status"
import { DesktopCandidates } from "@/components/desktop-candidates"

type Tab = "scraper" | "moderation" | "sections" | "pipeline" | "desktop"

const TABS: { id: Tab; label: string }[] = [
  { id: "scraper",    label: "📸 Scraper"    },
  { id: "moderation", label: "🔍 Moderation" },
  { id: "sections",   label: "📱 Sections"   },
  { id: "pipeline",   label: "⚙️ Pipeline"   },
  { id: "desktop",    label: "🖥️ Desktop"    },
]

export default function Protected() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>("scraper")
  const [sectionsKey, setSectionsKey] = useState(0)
  const router = useRouter()
  const supabase = getSupabaseClient()

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }: { data: { session: import("@supabase/supabase-js").Session | null } }) => {
      if (!session) { router.push("/auth/sign-in"); return }
      setUser(session.user)
      setLoading(false)
    })
  }, [supabase, router])

  const handleLogout = useCallback(async () => {
    await supabase.auth.signOut()
    router.push("/")
  }, [supabase, router])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        Loading…
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-10 bg-background/80 backdrop-blur border-b px-3 sm:px-4 py-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Logged in as</p>
          <p className="text-sm font-semibold truncate">{user?.email}</p>
        </div>
        <Button onClick={handleLogout} variant="outline" size="sm" className="shrink-0">
          Logout
        </Button>
      </header>

      {/* Tab bar — horizontally scrollable on small screens */}
      <nav className="sticky top-[57px] z-10 border-b px-2 sm:px-4 flex gap-1 pt-2 bg-background overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`shrink-0 whitespace-nowrap px-3 sm:px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${
              tab === id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <main className="flex-1 flex flex-col items-center py-6 sm:py-8 px-3 sm:px-4 gap-6">
        {tab === "scraper" && (
          <SocialUploader
            onSectionCreated={() => setSectionsKey((k) => k + 1)}
          />
        )}
        {tab === "moderation" && <ImageModeration />}
        {tab === "sections" && <SectionsManager key={sectionsKey} />}
        {tab === "pipeline" && <PipelineStatus />}
        {tab === "desktop" && <DesktopCandidates />}
      </main>
    </div>
  )
}
