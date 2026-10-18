import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import express from "express";
import { createClaimsRouter } from "../src/routes/claims.js";
import { createRequireUser } from "../src/middleware/requireUser.js";

const request = createRequire(import.meta.url)("supertest");
const ITEM_ID = "123e4567-e89b-42d3-a456-426614174000";
const CLAIM_ID = "223e4567-e89b-42d3-a456-426614174000";
const OWNER_ID = "323e4567-e89b-42d3-a456-426614174000";
const CLAIMANT_ID = "423e4567-e89b-42d3-a456-426614174000";
const OTHER_ID = "523e4567-e89b-42d3-a456-426614174000";

function fakeDb({ itemOverrides = {}, initialClaims = [] } = {}) {
  const state = {
    items: [{
      id: ITEM_ID, user_id: OWNER_ID, title: "Blue notebook", type: "found", category: "Books",
      location: "Library", date: "2026-10-18", status: "open", created_at: "2026-10-18T10:00:00Z",
      ...itemOverrides,
    }],
    claims: initialClaims.map((claim) => ({
      id: CLAIM_ID, item_id: ITEM_ID, claimant_user_id: CLAIMANT_ID,
      explanation: "It has my initials inside.", status: "pending",
      created_at: "2026-10-18T11:00:00Z", decided_at: null, ...claim,
    })),
    calls: [],
  };

  const users = { "owner-token": OWNER_ID, "claimant-token": CLAIMANT_ID, "other-token": OTHER_ID };
  const db = {
    state,
    auth: { async getUser(token) {
      const id = users[token];
      return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: new Error("invalid") };
    } },
    from(table) {
      const rowsForTable = () => table === "item_claims" ? state.claims : state[table];
      const filters = [];
      let operation = "select";
      const query = {
        select() { operation = "select"; return query; },
        eq(column, value) { filters.push((row) => row[column] === value); return query; },
        in(column, values) { filters.push((row) => values.includes(row[column])); return query; },
        order() { return query; },
        async maybeSingle() {
          const rows = (rowsForTable() || []).filter((row) => filters.every((filter) => filter(row)));
          if (operation !== "select") throw new Error("Unsupported fake DB operation");
          return { data: rows[0] || null, error: null };
        },
        then(resolve, reject) {
          const rows = (rowsForTable() || []).filter((row) => filters.every((filter) => filter(row)));
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, args) {
      state.calls.push({ name, args });
      const fail = (code) => ({ data: null, error: { code } });
      if (name === "submit_item_claim") {
        const item = state.items.find((candidate) => candidate.id === args.p_item_id);
        if (!item) return fail("P0002");
        if (!item.user_id || item.user_id === args.p_claimant_user_id) return fail("42501");
        if (item.type !== "found" || item.status !== "open") return fail("55000");
        const active = state.claims.some((claim) => claim.item_id === item.id
          && claim.claimant_user_id === args.p_claimant_user_id
          && ["pending", "approved"].includes(claim.status));
        if (active) return fail("23505");
        const claim = {
          id: `623e4567-e89b-42d3-a456-42661417400${state.claims.length}`,
          item_id: item.id, claimant_user_id: args.p_claimant_user_id,
          explanation: args.p_explanation, status: "pending",
          created_at: "2026-10-19T10:00:00Z", decided_at: null,
        };
        state.claims.unshift(claim);
        return { data: claim, error: null };
      }
      const claim = state.claims.find((candidate) => candidate.id === args.p_claim_id);
      if (!claim) return fail("P0002");
      const item = state.items.find((candidate) => candidate.id === claim.item_id);
      if (!item) return fail("P0002");
      if (claim.claimant_user_id === args.p_actor_user_id || item.user_id !== args.p_actor_user_id) return fail("42501");
      if (claim.status !== "pending") return fail("55000");
      if (item.type !== "found" || item.status !== "open") return fail("55000");
      claim.status = args.p_decision;
      claim.decided_at = "2026-10-19T12:00:00Z";
      if (args.p_decision === "approved") {
        item.status = "claimed";
        for (const competing of state.claims) {
          if (competing.item_id === item.id && competing.id !== claim.id && competing.status === "pending") {
            competing.status = "rejected";
            competing.decided_at = claim.decided_at;
          }
        }
      }
      return { data: claim, error: null };
    },
  };
  return db;
}

function setup(options) {
  const db = fakeDb(options);
  const app = express();
  app.use(express.json());
  app.use("/api", createClaimsRouter({ db, auth: createRequireUser(db) }));
  return { app, db };
}

function authorized(testRequest, token = "claimant-token") {
  return testRequest.set("Authorization", `Bearer ${token}`);
}

test("submits an authenticated claim using the verified user ID", async () => {
  const { app, db } = setup();
  const response = await authorized(request(app).post(`/api/items/${ITEM_ID}/claims`))
    .send({ explanation: "There is a unique sticker I put inside." });
  assert.equal(response.status, 201);
  assert.equal(response.body.status, "pending");
  assert.equal(response.body.explanation, "There is a unique sticker I put inside.");
  assert.equal(db.state.calls[0].args.p_claimant_user_id, CLAIMANT_ID);
  assert.equal(Object.hasOwn(response.body, "claimant_user_id"), false);
});

test("rejects unauthenticated submission and invalid IDs or explanations", async () => {
  const { app } = setup();
  assert.equal((await request(app).post(`/api/items/${ITEM_ID}/claims`).send({ explanation: "mine" })).status, 401);
  assert.equal((await authorized(request(app).post("/api/items/not-a-uuid/claims")).send({ explanation: "mine" })).status, 400);
  assert.equal((await authorized(request(app).post(`/api/items/${ITEM_ID}/claims`)).send({ explanation: "  " })).status, 400);
  assert.equal((await authorized(request(app).post(`/api/items/${ITEM_ID}/claims`)).send({ explanation: "x".repeat(501) })).status, 400);
});

test("rejects self-claims, lost items, NULL owners, and ineligible listings", async () => {
  const own = setup({ itemOverrides: { user_id: CLAIMANT_ID } });
  const lost = setup({ itemOverrides: { type: "lost" } });
  const ownerMissing = setup({ itemOverrides: { user_id: null } });
  const resolved = setup({ itemOverrides: { status: "resolved" } });
  const claimed = setup({ itemOverrides: { status: "claimed" } });
  assert.equal((await authorized(request(own.app).post(`/api/items/${ITEM_ID}/claims`)).send({ explanation: "mine" })).status, 403);
  assert.equal((await authorized(request(lost.app).post(`/api/items/${ITEM_ID}/claims`)).send({ explanation: "mine" })).status, 409);
  assert.equal((await authorized(request(ownerMissing.app).post(`/api/items/${ITEM_ID}/claims`)).send({ explanation: "mine" })).status, 403);
  assert.equal((await authorized(request(resolved.app).post(`/api/items/${ITEM_ID}/claims`)).send({ explanation: "mine" })).status, 409);
  assert.equal((await authorized(request(claimed.app).post(`/api/items/${ITEM_ID}/claims`)).send({ explanation: "mine" })).status, 409);
});

test("prevents duplicate active claims and keeps rejected claims retryable", async () => {
  const duplicate = setup({ initialClaims: [{ status: "pending" }] });
  assert.equal((await authorized(request(duplicate.app).post(`/api/items/${ITEM_ID}/claims`)).send({ explanation: "another reason" })).status, 409);
  const rejectedHistory = setup({ initialClaims: [{ status: "rejected", decided_at: "2026-10-18T12:00:00Z" }] });
  const response = await authorized(request(rejectedHistory.app).post(`/api/items/${ITEM_ID}/claims`)).send({ explanation: "updated details" });
  assert.equal(response.status, 201);
});

test("claimant and listing owner can read their authorized claim details only", async () => {
  const privateClaim = { explanation: "The serial label is 12345." };
  const { app } = setup({ initialClaims: [privateClaim] });
  const claimant = await authorized(request(app).get("/api/claims/mine"));
  const owner = await authorized(request(app).get("/api/items/" + ITEM_ID + "/claims"), "owner-token");
  const ownerDashboard = await authorized(request(app).get("/api/claims/for-my-listings"), "owner-token");
  const unrelatedDashboard = await authorized(request(app).get("/api/claims/for-my-listings"), "other-token");
  const other = await authorized(request(app).get("/api/items/" + ITEM_ID + "/claims"), "other-token");
  assert.equal(claimant.status, 200);
  assert.equal(claimant.body[0].explanation, privateClaim.explanation);
  assert.equal(owner.status, 200);
  assert.equal(owner.body[0].explanation, privateClaim.explanation);
  assert.equal(ownerDashboard.body[0].explanation, privateClaim.explanation);
  assert.deepEqual(unrelatedDashboard.body, []);
  assert.equal(other.status, 404);
});

test("owner can reject a claim and the listing remains open", async () => {
  const { app, db } = setup({ initialClaims: [{ id: CLAIM_ID }] });
  const response = await authorized(request(app).post(`/api/claims/${CLAIM_ID}/reject`), "owner-token");
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "rejected");
  assert.equal(db.state.items[0].status, "open");
});

test("rejects unauthorized review, claimant self-review, and non-pending decisions", async () => {
  const unauthorized = setup({ initialClaims: [{ id: CLAIM_ID }] });
  const claimant = await authorized(request(unauthorized.app).post(`/api/claims/${CLAIM_ID}/approve`));
  const other = await authorized(request(unauthorized.app).post(`/api/claims/${CLAIM_ID}/reject`), "other-token");
  assert.equal(claimant.status, 403);
  assert.equal(other.status, 403);

  const decided = setup({ initialClaims: [{ id: CLAIM_ID, status: "rejected", decided_at: "2026-10-18T12:00:00Z" }] });
  const secondDecision = await authorized(request(decided.app).post(`/api/claims/${CLAIM_ID}/approve`), "owner-token");
  assert.equal(secondDecision.status, 409);
});

test("approval claims the listing and closes competing pending claims", async () => {
  const competingId = "723e4567-e89b-42d3-a456-426614174000";
  const { app, db } = setup({ initialClaims: [
    { id: CLAIM_ID, claimant_user_id: CLAIMANT_ID },
    { id: competingId, claimant_user_id: OTHER_ID, explanation: "Another private reason." },
  ] });
  const response = await authorized(request(app).post(`/api/claims/${CLAIM_ID}/approve`), "owner-token");
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "approved");
  assert.equal(db.state.items[0].status, "claimed");
  assert.equal(db.state.claims.find((claim) => claim.id === competingId).status, "rejected");
});

test("concurrent approval requests produce only one approved claim in the route mock", async () => {
  const secondId = "823e4567-e89b-42d3-a456-426614174000";
  const { app, db } = setup({ initialClaims: [
    { id: CLAIM_ID, claimant_user_id: CLAIMANT_ID },
    { id: secondId, claimant_user_id: OTHER_ID, explanation: "Other claimant." },
  ] });
  const [first, second] = await Promise.all([
    authorized(request(app).post(`/api/claims/${CLAIM_ID}/approve`), "owner-token"),
    authorized(request(app).post(`/api/claims/${secondId}/approve`), "owner-token"),
  ]);
  assert.equal([first, second].filter((response) => response.status === 200).length, 1);
  assert.equal(db.state.claims.filter((claim) => claim.status === "approved").length, 1);
  assert.equal(db.state.items[0].status, "claimed");
  // This is a route/DB mock check; PostgreSQL lock and transaction behavior still needs DB integration verification.
});

test("does not reveal private claims when an owner asks for another listing", async () => {
  const { app } = setup();
  const response = await authorized(request(app).get(`/api/items/${ITEM_ID}/claims`), "other-token");
  assert.equal(response.status, 404);
  const malformed = await authorized(request(app).post("/api/claims/nope/approve"), "owner-token");
  assert.equal(malformed.status, 400);
});
