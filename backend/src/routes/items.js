
import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireUser as defaultRequireUser } from "../middleware/requireUser.js";
import { deleteStoredImage, isListingImageKey } from "./itemImages.js";
import { s3Client } from "../lib/s3.js";

export function createItemsRouter({
  db = supabase,
  s3 = s3Client,
  bucket = process.env.S3_BUCKET,
  auth = defaultRequireUser,
} = {}) {
const router = Router();

const PUBLIC_FIELDS =
  "id, title, type, category, location, date, description, status, created_at, image_object_key";

function formatItem(item) {
  const { image_object_key: imageObjectKey, ...publicItem } = item;
  return {
    ...publicItem,
    hasImage: Boolean(imageObjectKey),
    createdAt: publicItem.created_at,
  };
}

function isValidUUID(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function isValidDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function reportDatabaseError(operation, error) {
  // Keep detailed database errors in the server logs, not API responses.
  console.error(`[items] ${operation} failed:`, error.message);
}

// GET /api/items - Public listing board
router.get("/", async (req, res) => {
  const { data, error } = await db
    .from("items")
    .select(PUBLIC_FIELDS)
    .order("created_at", { ascending: false });

  if (error) {
    reportDatabaseError("List items", error);
    return res.status(500).json({
      error: "Could not load listings.",
    });
  }

  return res.json(data.map(formatItem));
});
// GET /api/items/mine - Listings owned by the signed-in user
router.get("/mine", auth, async (req, res) => {
  const { data, error } = await db
    .from("items")
    .select(PUBLIC_FIELDS)
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Could not load user listings:", error.message);
    return res.status(500).json({
      error: "Could not load your listings.",
    });
  }

  return res.json(data.map(formatItem));
});
// GET /api/items/:id - Public listing details
router.get("/:id", async (req, res) => {
  if (!isValidUUID(req.params.id)) {
    return res.status(400).json({ error: "Invalid listing ID." });
  }

  const { data, error } = await db
    .from("items")
    .select(PUBLIC_FIELDS)
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) {
    reportDatabaseError("Get item", error);
    return res.status(500).json({
      error: "Could not load the listing.",
    });
  }

  if (!data) {
    return res.status(404).json({ error: "Listing not found." });
  }

  return res.json(formatItem(data));
});

// POST /api/items - Signed-in users only
router.post("/", auth, async (req, res) => {
  const body = req.body ?? {};
  const { title, type, category, location, date, description } = body;

  const valid =
    typeof title === "string" &&
    title.trim().length > 0 &&
    title.trim().length <= 120 &&
    ["lost", "found"].includes(type) &&
    typeof category === "string" &&
    category.trim().length > 0 &&
    category.trim().length <= 60 &&
    typeof location === "string" &&
    location.trim().length > 0 &&
    location.trim().length <= 120 &&
    isValidDate(date) &&
    typeof description === "string" &&
    description.trim().length > 0 &&
    description.trim().length <= 1000;

  if (!valid) {
    return res.status(400).json({
      error:
        "Invalid listing details. Check required fields, date, and text lengths.",
    });
  }

  const { data, error } = await db
    .from("items")
    .insert({
      title: title.trim(),
      type,
      category: category.trim(),
      location: location.trim(),
      date,
      description: description.trim(),
      user_id: req.user.id,
    })
    .select(PUBLIC_FIELDS)
    .single();

  if (error) {
    reportDatabaseError("Create item", error);
    return res.status(500).json({
      error: "Could not create the listing.",
    });
  }

  return res.status(201).json(formatItem(data));
});

router.patch("/:id", auth, async (req, res) => {
  const { title, type, category, location, date, description } = req.body ?? {};

  const valid =
    typeof title === "string" && title.trim().length > 0 && title.trim().length <= 120 &&
    ["lost", "found"].includes(type) &&
    typeof category === "string" && category.trim().length > 0 && category.trim().length <= 60 &&
    typeof location === "string" && location.trim().length > 0 && location.trim().length <= 120 &&
    typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    typeof description === "string" && description.trim().length > 0 && description.trim().length <= 1000;

  if (!valid) {
    return res.status(400).json({ error: "Please check your listing details." });
  }

  const { data, error } = await db
    .from("items")
    .update({
      title: title.trim(),
      type,
      category: category.trim(),
      location: location.trim(),
      date,
      description: description.trim(),
    })
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .select(PUBLIC_FIELDS)
    .maybeSingle();

  if (error) {
    console.error("Update listing failed:", error.message);
    return res.status(500).json({ error: "Could not update listing." });
  }

  if (!data) {
    return res.status(404).json({ error: "Listing not found, or you do not own it." });
  }

  return res.json(formatItem(data));
});

router.delete("/:id", auth, async (req, res) => {
  const { data: current, error: lookupError } = await db
    .from("items")
    .select("id, user_id, image_object_key")
    .eq("id", req.params.id)
    .maybeSingle();
  if (lookupError) {
    console.error("Delete listing lookup failed:", lookupError.message);
    return res.status(500).json({ error: "Could not delete listing." });
  }
  if (!current || current.user_id !== req.user.id) {
    return res.status(404).json({ error: "Listing not found, or you do not own it." });
  }
  if (current.image_object_key && !bucket) {
    return res.status(503).json({ error: "Image storage is not configured; listing was not deleted." });
  }

  const { data, error } = await db
    .from("items")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .select("id, image_object_key")
    .maybeSingle();

  if (error) {
    console.error("Delete listing failed:", error.message);
    return res.status(500).json({ error: "Could not delete listing." });
  }

  if (!data) {
    return res.status(404).json({ error: "Listing not found, or you do not own it." });
  }

  let cleanupPending = false;
  if (data.image_object_key) {
    if (!isListingImageKey(data.id, data.image_object_key)) cleanupPending = true;
    else cleanupPending = !(await deleteStoredImage(s3, bucket, data.image_object_key));
  }

  return res.json({ success: true, cleanupPending });
});

// PATCH /api/items/:id/resolve - Only the owner can resolve
router.patch("/:id/resolve", auth, async (req, res) => {
  if (!isValidUUID(req.params.id)) {
    return res.status(400).json({ error: "Invalid listing ID." });
  }

  const { data, error } = await db
    .from("items")
    .update({ status: "resolved" })
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .in("status", ["open", "claimed"])
    .select(PUBLIC_FIELDS)
    .maybeSingle();

  if (error) {
    reportDatabaseError("Resolve item", error);
    return res.status(500).json({
      error: "Could not resolve the listing.",
    });
  }

  if (!data) {
    return res.status(404).json({
      error: "Listing not found, or you do not own an open or claimed listing.",
    });
  }

  return res.json(formatItem(data));
});

return router;
}

export default createItemsRouter();
