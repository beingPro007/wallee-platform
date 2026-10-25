"use server"

import { s3Client } from "@/lib/s3"
import { ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

const BUCKET_NAME = process.env.AWS_BUCKET_NAME!

const ROOT_PREFIX = "premium_raw_images/"

export async function listCategories() {
    if (!BUCKET_NAME) throw new Error("AWS_BUCKET_NAME is not defined")

    try {
        const command = new ListObjectsV2Command({
            Bucket: BUCKET_NAME,
            Prefix: ROOT_PREFIX,
            Delimiter: "/",
        })

        const response = await s3Client.send(command)

        return response.CommonPrefixes?.map((prefix) => {
            // prefix.Prefix is like "premium_raw_images/category/"
            const parts = prefix.Prefix!.split('/')
            return parts[parts.length - 2]
        }) || []
    } catch (error) {
        console.error("Error listing categories:", error)
        return []
    }
}

export async function listRawImages(category?: string) {
    if (!BUCKET_NAME) {
        throw new Error("AWS_BUCKET_NAME is not defined")
    }

    if (!process.env.CLOUDFRONT_URL) {
        throw new Error("CLOUDFRONT_URL is not defined")
    }

    try {
        const prefix = category ? `${ROOT_PREFIX}${category}/` : ROOT_PREFIX
        const command = new ListObjectsV2Command({
            Bucket: BUCKET_NAME,
            Prefix: prefix,
        })

        const response = await s3Client.send(command)

        // Filter out folders (keys ending in /)
        const contents = response.Contents?.filter(item => !item.Key!.endsWith('/')) || []

        // Generate URLs for each image
        const images = contents.map((item) => {
            const url = `${process.env.CLOUDFRONT_URL}/${item.Key!.split('/').map(encodeURIComponent).join('/')}`

            return {
                key: item.Key!,
                lastModified: item.LastModified,
                size: item.Size,
                url,
                category: category || item.Key!.split('/')[1] // Try to infer category if not provided
            }
        })

        return images
    } catch (error) {
        console.error("Error listing images:", error)
        throw new Error("Failed to list images")
    }
}

export async function approveImage(key: string, category: string) {
    if (!BUCKET_NAME) {
        throw new Error("AWS_BUCKET_NAME is not defined")
    }

    // Extract filename from key
    const filename = key.split('/').pop()
    if (!filename) throw new Error("Invalid key")

    const destinationKey = `premium/${category}/${filename}`

    try {
        // 1. Copy object
        await s3Client.send(new CopyObjectCommand({
            Bucket: BUCKET_NAME,
            CopySource: `${BUCKET_NAME}/${key}`,
            Key: destinationKey,
        }))

        // 2. Delete original
        await s3Client.send(new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
        }))

        return { success: true, message: "Image approved and moved" }
    } catch (error) {
        console.error("Error approving image:", error)
        throw new Error("Failed to approve image")
    }
}

export async function denyImage(key: string) {
    if (!BUCKET_NAME) {
        throw new Error("AWS_BUCKET_NAME is not defined")
    }

    try {
        await s3Client.send(new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
        }))

        return { success: true, message: "Image denied and deleted" }
    } catch (error) {
        console.error("Error denying image:", error)
        throw new Error("Failed to deny image")
    }
}
