"use server"

import { s3Client } from "@/lib/s3"
import {
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  type ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3"

const BUCKET = process.env.AWS_BUCKET_NAME!
const CF_URL = (process.env.CLOUDFRONT_URL ?? "").replace(/\/$/, "")
// Modal upscaler approval endpoint (upscales a staged candidate to 8K).
const APPROVE_URL = process.env.MODAL_APPROVE_DESKTOP_URL || "https://harrir-prod-2--wall-e-upscaler-approve-desktop.modal.run"

export type DesktopCandidate = {
  key: string
  url: string
  category: string
  confidence: number | null
  predRotation: number | null
}

// ── List staged candidates from S3 (desktop_review/) ─────────────────────────
export async function listDesktopCandidates(): Promise<DesktopCandidate[]> {
  const out: DesktopCandidate[] = []
  let token: string | undefined = undefined
  do {
    const resp: ListObjectsV2CommandOutput = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: "desktop_review/",
        ContinuationToken: token,
        MaxKeys: 1000,
      })
    )
    for (const o of resp.Contents ?? []) {
      const key = o.Key!
      if (!/\.(jpg|jpeg|png|webp)$/i.test(key)) continue
      const parts = key.split("/")
      const category = parts.length >= 3 ? parts[1] : "desktop"

      let confidence: number | null = null
      let predRotation: number | null = null
      try {
        const h = await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
        const m = h.Metadata ?? {}
        confidence = m["confidence"] ? parseFloat(m["confidence"]) : null
        predRotation = m["pred-rotation"] ? parseInt(m["pred-rotation"]) : null
      } catch {
        // metadata is best-effort
      }

      out.push({
        key,
        url: `${CF_URL}/${key.split("/").map(encodeURIComponent).join("/")}`,
        category,
        confidence,
        predRotation,
      })
    }
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined
  } while (token)

  // Highest-confidence first
  out.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
  return out
}

// ── Reject → just delete the staged file ─────────────────────────────────────
export async function rejectDesktopCandidate(key: string): Promise<void> {
  if (!key.startsWith("desktop_review/")) throw new Error("Invalid candidate key")
  await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
}

// ── Approve → claim each candidate by moving desktop_review/ → desktop_pending/
//    (so it leaves the review list immediately and can't be re-approved), then
//    hand the claimed keys to the Modal upscaler. Idempotent: a second approve
//    of the same key finds nothing to move. ────────────────────────────────────
export async function approveDesktopCandidates(
  keys: string[]
): Promise<{ status: string; count?: number; message?: string }> {
  const valid = keys.filter((k) => k.startsWith("desktop_review/"))
  if (valid.length === 0) return { status: "ignored" }

  const claimed: string[] = []
  for (const k of valid) {
    const dest = "desktop_pending/" + k.slice("desktop_review/".length)
    try {
      await s3Client.send(
        new CopyObjectCommand({
          Bucket: BUCKET,
          CopySource: `${BUCKET}/${k.split("/").map(encodeURIComponent).join("/")}`,
          Key: dest,
          MetadataDirective: "COPY",
        })
      )
      await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: k }))
      claimed.push(dest)
    } catch {
      // Already claimed/gone (e.g. double-click) — skip. Idempotent.
    }
  }
  if (claimed.length === 0) return { status: "ignored", count: 0 }

  const res = await fetch(APPROVE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys: claimed }),
  })
  return res.json()
}
