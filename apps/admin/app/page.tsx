"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { getSupabaseClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"

export default function Home() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const router = useRouter()
  const supabase = getSupabaseClient()

  useEffect(() => {
    const checkSession = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      setSession(session)
      setLoading(false)

      if (session) {
        router.push("/protected")
      }
    }

    checkSession()
  }, [supabase, router])

  if (loading) {
    return <div className="flex items-center justify-center h-screen">Loading...</div>
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-6">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">Welcome to InstaS3</h1>
        <p className="text-lg text-muted-foreground mb-8">Upload Instagram content directly to S3</p>
      </div>

      <div className="flex gap-4">
        {/* <Button onClick={() => router.push("/auth/sign-up")} size="lg">
          Sign Up
        </Button> */}
        <Button onClick={() => router.push("/auth/sign-in")} variant="outline" size="lg">
          Sign In
        </Button>
      </div>
    </div>
  )
}
