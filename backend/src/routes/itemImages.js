import { Router } from "express";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { supabase } from "../lib/supabase.js";
import { s3Client, getImageUrl } from "../lib/s3.js";
import { createRequireUser } from "../middleware/requireUser.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

export function isListingImageKey(itemId, key) {
  return typeof key === "string" &&
    new RegExp(`^items/${itemId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|png|webp)$`, "i").test(key);
}

const multipart = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 },
});

function parseMultipart(req, res, next) {
  multipart.single("image")(req, res, (error) => {
    if (!error) return next();
    const tooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? "Image must be 5 MB or smaller." : "Could not read the uploaded image.",
    });
  });
}

export async function deleteStoredImage(s3, bucket, key) {
  if (!bucket || !key) return true;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (error) {
      if (attempt === 2) {
        console.error("S3 image cleanup failed after retries:", error.name || "S3 error");
      }
    }
  }
  return false;
}

export function createItemImagesRouter({
  db = supabase,
  s3 = s3Client,
  bucket = process.env.S3_BUCKET,
  presign = getImageUrl,
  auth = createRequireUser(db),
} = {}) {
  const router = Router();

  async function ownedListing(req, res) {
    const { data, error } = await db.from("items")
      .select("id, user_id, image_object_key")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) {
      console.error("Image listing lookup failed:", error.message);
      res.status(500).json({ error: "Could not load the listing." });
      return null;
    }
    if (!data) {
      res.status(404).json({ error: "Listing not found." });
      return null;
    }
    if (!data.user_id) {
      res.status(403).json({ error: "This listing has no owner who can manage its image." });
      return null;
    }
    if (data.user_id !== req.user.id) {
      res.status(404).json({ error: "Listing not found, or you do not own it." });
      return null;
    }
    return data;
  }

  router.post("/:id/image", auth, parseMultipart, async (req, res) => {
    if (!bucket) return res.status(503).json({ error: "Image storage is not configured." });
    const listing = await ownedListing(req, res);
    if (!listing) return;
    if (!req.file) return res.status(400).json({ error: "Choose an image to upload." });

    let detected;
    try {
      detected = await fileTypeFromBuffer(req.file.buffer);
    } catch {
      return res.status(415).json({ error: "Choose a valid JPEG, PNG, or WebP image." });
    }
    const extension = detected && ACCEPTED_TYPES.get(detected.mime);
    if (!extension) {
      return res.status(415).json({ error: "Choose a valid JPEG, PNG, or WebP image." });
    }

    const newKey = `items/${listing.id}/${randomUUID()}.${extension}`;
    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: newKey,
        Body: req.file.buffer,
        ContentLength: req.file.size,
        ContentType: detected.mime,
      }));
    } catch (error) {
      console.error("S3 image upload failed:", error.name || "S3 error");
      return res.status(502).json({ error: "Image upload failed. Please try again." });
    }

    let updateQuery = db.from("items")
      .update({ image_object_key: newKey })
      .eq("id", listing.id)
      .eq("user_id", req.user.id);
    updateQuery = listing.image_object_key == null
      ? updateQuery.is("image_object_key", null)
      : updateQuery.eq("image_object_key", listing.image_object_key);
    const { data, error } = await updateQuery.select("id")
      .maybeSingle();
    if (error || !data) {
      await deleteStoredImage(s3, bucket, newKey);
      if (error) console.error("Saving image key failed:", error.message);
      return res.status(error ? 500 : 404).json({ error: "Could not attach the image to this listing." });
    }

    let cleanupPending = false;
    if (listing.image_object_key && isListingImageKey(listing.id, listing.image_object_key)) {
      cleanupPending = !(await deleteStoredImage(s3, bucket, listing.image_object_key));
    }
    return res.json({ hasImage: true, cleanupPending });
  });

  router.get("/:id/image-url", auth, async (req, res) => {
    if (!bucket) return res.status(503).json({ error: "Image storage is not configured." });
    const { data, error } = await db.from("items")
      .select("id, image_object_key")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) {
      console.error("Image lookup failed:", error.message);
      return res.status(500).json({ error: "Could not load the image." });
    }
    if (!data) return res.status(404).json({ error: "Listing not found." });
    if (!data.image_object_key || !isListingImageKey(data.id, data.image_object_key)) {
      return res.status(404).json({ error: "This listing has no image." });
    }
    try {
      const url = await presign(s3, bucket, data.image_object_key, 300);
      return res.json({ url, expiresIn: 300 });
    } catch (error) {
      console.error("Presigning image URL failed:", error.name || "S3 error");
      return res.status(502).json({ error: "Could not load the image." });
    }
  });

  router.delete("/:id/image", auth, async (req, res) => {
    if (!bucket) return res.status(503).json({ error: "Image storage is not configured." });
    const listing = await ownedListing(req, res);
    if (!listing) return;
    if (!listing.image_object_key) return res.json({ hasImage: false });
    if (!isListingImageKey(listing.id, listing.image_object_key)) {
      return res.status(500).json({ error: "Stored image reference is invalid; contact support." });
    }

    const { data, error } = await db.from("items")
      .update({ image_object_key: null })
      .eq("id", listing.id)
      .eq("user_id", req.user.id)
      .eq("image_object_key", listing.image_object_key)
      .select("id")
      .maybeSingle();
    if (error || !data) {
      if (error) console.error("Clearing image key failed:", error.message);
      return res.status(error ? 500 : 404).json({ error: "Could not remove the image." });
    }
    const removed = await deleteStoredImage(s3, bucket, listing.image_object_key);
    return res.json({ hasImage: false, cleanupPending: !removed });
  });

  return router;
}

export default createItemImagesRouter();
