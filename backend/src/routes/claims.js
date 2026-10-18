import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireUser as defaultRequireUser } from "../middleware/requireUser.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAIM_FIELDS = "id, item_id, claimant_user_id, explanation, status, created_at, decided_at";
const ITEM_FIELDS = "id, title, type, category, location, date, status, created_at";

function validUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function publicClaim(claim, item) {
  return {
    id: claim.id,
    itemId: claim.item_id,
    explanation: claim.explanation,
    status: claim.status,
    createdAt: claim.created_at,
    decidedAt: claim.decided_at,
    ...(item ? { item } : {}),
  };
}

function databaseFailure(res, error, fallback) {
  // Only inspect the SQLSTATE. Error messages can contain private claim details.
  const code = error?.code;
  if (code === "42501") return res.status(403).json({ error: "You are not allowed to perform this claim action." });
  if (code === "P0002") return res.status(404).json({ error: "Claim or listing not found." });
  if (code === "23505") return res.status(409).json({ error: "An active claim already exists, or this item already has an approved claim." });
  if (code === "55000") return res.status(409).json({ error: "The claim or listing is no longer eligible for this action." });
  if (code === "22023" || code === "23514") return res.status(400).json({ error: "Invalid claim details." });
  return res.status(500).json({ error: fallback });
}

export function createClaimsRouter({ db = supabase, auth = defaultRequireUser } = {}) {
  const router = Router();

  // POST /api/items/:id/claims
  router.post("/items/:id/claims", auth, async (req, res) => {
    if (!validUuid(req.params.id)) return res.status(400).json({ error: "Invalid listing ID." });
    const explanation = req.body?.explanation;
    if (typeof explanation !== "string" || explanation.trim().length < 1 || explanation.trim().length > 500) {
      return res.status(400).json({ error: "Explain why the item belongs to you (1–500 characters)." });
    }

    // Friendly preflight checks; the database function repeats these under a row lock.
    const { data: item, error: itemError } = await db.from("items")
      .select("id, title, user_id, type, status")
      .eq("id", req.params.id)
      .maybeSingle();
    if (itemError) return res.status(500).json({ error: "Could not submit the claim." });
    if (!item) return res.status(404).json({ error: "Listing not found." });
    if (!item.user_id || item.user_id === req.user.id) {
      return res.status(403).json({ error: "You cannot claim this listing." });
    }
    if (item.type !== "found" || item.status !== "open") {
      return res.status(409).json({ error: "This listing is not available to claim." });
    }

    const { data, error } = await db.rpc("submit_item_claim", {
      p_item_id: req.params.id,
      p_claimant_user_id: req.user.id,
      p_explanation: explanation.trim(),
    });
    if (error) return databaseFailure(res, error, "Could not submit the claim.");
    return res.status(201).json(publicClaim(data, {
      id: item.id,
      title: item.title,
      type: item.type,
      status: item.status,
    }));
  });

  // GET /api/claims/mine
  router.get("/claims/mine", auth, async (req, res) => {
    const { data: claims, error } = await db.from("item_claims")
      .select(CLAIM_FIELDS)
      .eq("claimant_user_id", req.user.id)
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: "Could not load your claims." });

    const itemIds = [...new Set(claims.map((claim) => claim.item_id))];
    let items = [];
    if (itemIds.length) {
      const result = await db.from("items").select(ITEM_FIELDS).in("id", itemIds);
      if (result.error) return res.status(500).json({ error: "Could not load your claims." });
      items = result.data;
    }
    const byId = new Map(items.map((item) => [item.id, item]));
    return res.json(claims.map((claim) => publicClaim(claim, byId.get(claim.item_id) ?? null)));
  });

  // GET /api/claims/for-my-listings
  router.get("/claims/for-my-listings", auth, async (req, res) => {
    const { data: items, error: itemError } = await db.from("items")
      .select(ITEM_FIELDS)
      .eq("user_id", req.user.id)
      .eq("type", "found");
    if (itemError) return res.status(500).json({ error: "Could not load claims for your listings." });
    if (!items.length) return res.json([]);

    const { data: claims, error } = await db.from("item_claims")
      .select(CLAIM_FIELDS)
      .in("item_id", items.map((item) => item.id))
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: "Could not load claims for your listings." });
    const byId = new Map(items.map((item) => [item.id, item]));
    return res.json(claims.map((claim) => publicClaim(claim, byId.get(claim.item_id) ?? null)));
  });

  // GET /api/items/:id/claims
  router.get("/items/:id/claims", auth, async (req, res) => {
    if (!validUuid(req.params.id)) return res.status(400).json({ error: "Invalid listing ID." });
    const { data: item, error: itemError } = await db.from("items")
      .select(ITEM_FIELDS + ", user_id")
      .eq("id", req.params.id)
      .maybeSingle();
    if (itemError) return res.status(500).json({ error: "Could not load listing claims." });
    if (!item || item.user_id !== req.user.id || item.type !== "found") {
      return res.status(404).json({ error: "Listing not found." });
    }

    const { data: claims, error } = await db.from("item_claims")
      .select(CLAIM_FIELDS)
      .eq("item_id", item.id)
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: "Could not load listing claims." });
    const { user_id: _ownerId, ...publicItem } = item;
    return res.json(claims.map((claim) => publicClaim(claim, publicItem)));
  });

  async function decide(req, res, decision) {
    if (!validUuid(req.params.id)) return res.status(400).json({ error: "Invalid claim ID." });
    const { data, error } = await db.rpc("decide_item_claim", {
      p_claim_id: req.params.id,
      p_actor_user_id: req.user.id,
      p_decision: decision,
    });
    if (error) return databaseFailure(res, error, "Could not record the claim decision.");
    return res.json(publicClaim(data));
  }

  router.post("/claims/:id/approve", auth, (req, res) => decide(req, res, "approved"));
  router.post("/claims/:id/reject", auth, (req, res) => decide(req, res, "rejected"));

  return router;
}

export default createClaimsRouter();
