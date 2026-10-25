"use client"

import { useState, useEffect } from "react"
import { listRawImages, approveImage, denyImage, listCategories } from "@/app/actions/s3"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardFooter } from "@/components/ui/card"

interface S3Image {
    key: string
    url: string
    lastModified?: Date
    size?: number
    category?: string
}

export function ImageModeration() {
    const [images, setImages] = useState<S3Image[]>([])
    const [loading, setLoading] = useState(false)
    const [targetCategory, setTargetCategory] = useState("default")
    const [filterCategory, setFilterCategory] = useState<string>("all")
    const [availableCategories, setAvailableCategories] = useState<string[]>([])
    const [processing, setProcessing] = useState<string | null>(null) // Key of image currently being processed

    useEffect(() => {
        listCategories().then(setAvailableCategories)
    }, [])

    const fetchImages = async () => {
        setLoading(true)
        try {
            const categoryToFetch = filterCategory === "all" ? undefined : filterCategory
            const data = await listRawImages(categoryToFetch)
            setImages(data as any as S3Image[])
        } catch (error) {
            console.error("Failed to fetch images", error)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        fetchImages()
        if (filterCategory !== "all") {
            setTargetCategory(filterCategory)
        }
    }, [filterCategory])

    const handleApprove = async (key: string) => {
        if (!targetCategory) {
            alert("Please enter a category first")
            return
        }
        setProcessing(key)
        try {
            await approveImage(key, targetCategory)
            // Remove from list
            setImages(prev => prev.filter(img => img.key !== key))
        } catch (error) {
            console.error("Failed to approve", error)
            alert("Failed to approve image")
        } finally {
            setProcessing(null)
        }
    }

    const handleDeny = async (key: string) => {
        if (!confirm("Are you sure you want to delete this image?")) return
        setProcessing(key)
        try {
            await denyImage(key)
            // Remove from list
            setImages(prev => prev.filter(img => img.key !== key))
        } catch (error) {
            console.error("Failed to deny", error)
            alert("Failed to deny image")
        } finally {
            setProcessing(null)
        }
    }

    return (
        <div className="w-full max-w-6xl space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-card p-4 rounded-lg border shadow-sm">
                <h2 className="text-xl font-semibold">Image Moderation</h2>
                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium shrink-0">Filter:</span>
                        <select
                            className="h-9 w-full sm:w-40 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            value={filterCategory}
                            onChange={(e) => setFilterCategory(e.target.value)}
                        >
                            <option value="all">All Categories</option>
                            {availableCategories.map(cat => (
                                <option key={cat} value={cat}>{cat}</option>
                            ))}
                        </select>
                    </div>

                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium shrink-0">Target:</span>
                        <Input
                            value={targetCategory}
                            onChange={(e) => setTargetCategory(e.target.value)}
                            className="w-full sm:w-40"
                            placeholder="e.g. comic"
                        />
                    </div>
                    <Button onClick={fetchImages} disabled={loading} variant="outline" className="w-full sm:w-auto">
                        {loading ? "Refreshing..." : "Refresh"}
                    </Button>
                </div>
            </div>

            {images.length === 0 && !loading && (
                <p className="text-center text-muted-foreground p-8">No images found {filterCategory !== 'all' ? `in ${filterCategory}` : ''}</p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {images.map((image) => (
                    <Card key={image.key} className="overflow-hidden">
                        <div className="relative bg-muted">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={image.url}
                                alt={image.key}
                                className="w-full h-auto"
                                loading="lazy"
                            />
                        </div>
                        <CardContent className="p-3">
                            <p className="text-xs text-muted-foreground truncate" title={image.key}>
                                {image.key.split('/').pop()}
                            </p>
                            {image.category && (
                                <p className="text-xs font-semibold mt-1">
                                    {image.category}
                                </p>
                            )}
                        </CardContent>
                        <CardFooter className="p-3 pt-0 flex gap-2">
                            <Button
                                onClick={() => handleDeny(image.key)}
                                variant="destructive"
                                size="sm"
                                className="flex-1"
                                disabled={processing === image.key}
                            >
                                Deny
                            </Button>
                            <Button
                                onClick={() => handleApprove(image.key)}
                                variant="default" // Green-ish usually, or default primary
                                size="sm"
                                className="flex-1 bg-green-600 hover:bg-green-700"
                                disabled={processing === image.key}
                            >
                                Accept
                            </Button>
                        </CardFooter>
                    </Card>
                ))}
            </div>
        </div>
    )
}
