
import { Router } from "express";
import { supabase } from "../lib/supabase.js";

const router = Router();

const PUBLIC_FIELDS =
  "id, title, type, category, location, date, description, status, created_at";

function formatItem(item) {
  return {
    ...item,
    createdAt: item.created_at,
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

// Verify the Supabase access token supplied by the frontend.
async function requireUser(req, res, next) {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (!token) {
    return res.status(401).json({
      error: "Please sign in to perform this action.",
    });
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    return res.status(401).json({
      error: "Your session is invalid or expired. Please sign in again.",
    });
  }

  req.user = data.user;
  next();
}

// GET /api/items - Public listing board
router.get("/", async (req, res) => {
  const { data, error } = await supabase
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
router.get("/mine", requireUser, async (req, res) => {
  const { data, error } = await supabase
    .from("items")
    .select("id, title, type, category, location, date, description, status, created_at")
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

  const { data, error } = await supabase
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
router.post("/", requireUser, async (req, res) => {
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

  const { data, error } = await supabase
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

router.patch("/:id", requireUser, async (req, res) => {
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

  const { data, error } = await supabase
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
    .select("id, title, type, category, location, date, description, status, created_at")
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

router.delete("/:id", requireUser, async (req, res) => {
  const { data, error } = await supabase
    .from("items")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("Delete listing failed:", error.message);
    return res.status(500).json({ error: "Could not delete listing." });
  }

  if (!data) {
    return res.status(404).json({ error: "Listing not found, or you do not own it." });
  }

  return res.json({ success: true });
});

// PATCH /api/items/:id/resolve - Only the owner can resolve
router.patch("/:id/resolve", requireUser, async (req, res) => {
  if (!isValidUUID(req.params.id)) {
    return res.status(400).json({ error: "Invalid listing ID." });
  }

  const { data, error } = await supabase
    .from("items")
    .update({ status: "resolved" })
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .eq("status", "open")
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
      error: "Open listing not found, or you do not own it.",
    });
  }

  return res.json(formatItem(data));
});

export default router;
