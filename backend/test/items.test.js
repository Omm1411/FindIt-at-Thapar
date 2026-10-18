import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import express from "express";
import { createItemsRouter } from "../src/routes/items.js";
import { createRequireUser } from "../src/middleware/requireUser.js";

const request = createRequire(import.meta.url)("supertest");
const ITEM_ID = "123e4567-e89b-42d3-a456-426614174000";
const OWNER_ID = "223e4567-e89b-42d3-a456-426614174000";

function setup(initialStatus = "open") {
  const state = { items: [{
    id: ITEM_ID, user_id: OWNER_ID, title: "Blue notebook", type: "found", category: "Books",
    location: "Library", date: "2026-10-18", description: "Blue cover", status: initialStatus,
    created_at: "2026-10-18T10:00:00Z", image_object_key: null,
  }] };
  const db = {
    state,
    auth: { async getUser(token) {
      return token === "owner-token"
        ? { data: { user: { id: OWNER_ID } }, error: null }
        : { data: { user: null }, error: new Error("invalid") };
    } },
    from(table) {
      let operation = "select";
      let payload;
      const filters = [];
      const query = {
        select() { return query; },
        insert(value) { operation = "insert"; payload = value; return query; },
        update(value) { operation = "update"; payload = value; return query; },
        delete() { operation = "delete"; return query; },
        eq(column, value) { filters.push((row) => row[column] === value); return query; },
        in(column, values) { filters.push((row) => values.includes(row[column])); return query; },
        order() { return query; },
        async maybeSingle() { return execute(true); },
        async single() { return execute(true); },
        then(resolve, reject) { return Promise.resolve(execute(false)).then(resolve, reject); },
      };
      function execute(single) {
        const rows = state[table];
        if (!rows) return { data: null, error: new Error("unknown table") };
        if (operation === "insert") {
          const row = { id: "323e4567-e89b-42d3-a456-426614174000", status: "open", image_object_key: null, created_at: "2026-10-19T10:00:00Z", ...payload };
          rows.push(row);
          return { data: row, error: null };
        }
        const matches = rows.filter((row) => filters.every((filter) => filter(row)));
        if (operation === "update") matches.forEach((row) => Object.assign(row, payload));
        if (operation === "delete") state[table] = rows.filter((row) => !matches.includes(row));
        const selected = operation === "delete" ? matches : matches;
        return { data: single ? (selected[0] || null) : selected, error: null };
      }
      return query;
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/items", createItemsRouter({ db, auth: createRequireUser(db) }));
  return { app, db };
}

function owner(requestBuilder) {
  return requestBuilder.set("Authorization", "Bearer owner-token");
}

test("existing listing browse, create, and edit routes remain available", async () => {
  const { app, db } = setup();
  const board = await request(app).get("/api/items");
  assert.equal(board.status, 200);
  assert.equal(board.body[0].title, "Blue notebook");

  const created = await owner(request(app).post("/api/items")).send({
    title: "Found calculator", type: "found", category: "Electronics", location: "Hall",
    date: "2026-10-19", description: "Grey calculator",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.hasImage, false);
  assert.equal(db.state.items.at(-1).user_id, OWNER_ID);

  const edited = await owner(request(app).patch(`/api/items/${ITEM_ID}`)).send({
    title: "Updated notebook", type: "found", category: "Books", location: "Library",
    date: "2026-10-18", description: "Updated description",
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.title, "Updated notebook");
});

test("owner can resolve an open or claimed listing without changing unrelated listings", async () => {
  const { app, db } = setup("claimed");
  const response = await owner(request(app).patch(`/api/items/${ITEM_ID}/resolve`));
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "resolved");
  assert.equal(db.state.items[0].status, "resolved");
});

test("listing resolution and deletion still require the authenticated owner", async () => {
  const { app } = setup();
  assert.equal((await request(app).patch(`/api/items/${ITEM_ID}/resolve`)).status, 401);
  assert.equal((await request(app).delete(`/api/items/${ITEM_ID}`)).status, 401);
  assert.equal((await owner(request(app).delete(`/api/items/${ITEM_ID}`))).status, 200);
});
