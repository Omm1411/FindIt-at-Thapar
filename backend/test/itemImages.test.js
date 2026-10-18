import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import express from "express";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { createItemImagesRouter } from "../src/routes/itemImages.js";
import { createItemsRouter } from "../src/routes/items.js";
import { createRequireUser } from "../src/middleware/requireUser.js";

const request = createRequire(import.meta.url)("supertest");

const ITEM_ID = "123e4567-e89b-42d3-a456-426614174000";
const OWNER_ID = "223e4567-e89b-42d3-a456-426614174000";
const OTHER_ID = "323e4567-e89b-42d3-a456-426614174000";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
const s3 = new S3Client({ region: "ap-southeast-2", credentials: { accessKeyId: "mock", secretAccessKey: "mock" } });
const s3Mock = mockClient(s3);

function fakeDb(initial = {}) {
  const state = {
    item: {
      id: ITEM_ID,
      user_id: OWNER_ID,
      image_object_key: null,
      ...initial,
    },
    updates: [],
    events: [],
    failUpdate: false,
  };
  const db = {
    state,
    auth: {
      async getUser(token) {
        return token === "valid-test-token"
          ? { data: { user: { id: OWNER_ID } }, error: null }
          : { data: { user: null }, error: new Error("invalid test token") };
      },
    },
    from() {
      let operation = "select";
      let patch = null;
      const filters = {};
      const query = {
        select() { return query; },
        update(value) { operation = "update"; patch = value; return query; },
        delete() { operation = "delete"; return query; },
        eq(column, value) { filters[column] = value; return query; },
        is(column, value) { filters[column] = value; return query; },
        async maybeSingle() {
          const matches = state.item && Object.entries(filters).every(([key, value]) => state.item[key] === value);
          if (!matches) return { data: null, error: null };
          if (operation === "update") {
            if (state.failUpdate) return { data: null, error: new Error("mock database update failure") };
            state.updates.push({ ...patch });
            state.events.push("db-update");
            Object.assign(state.item, patch);
          }
          if (operation === "delete") {
            const deleted = { ...state.item };
            state.item = null;
            return { data: deleted, error: null };
          }
          return { data: { ...state.item }, error: null };
        },
      };
      return query;
    },
  };
  return db;
}

function setup({ item, bucket = "test-private-bucket" } = {}) {
  const db = fakeDb(item);
  const app = express();
  app.use("/api/items", createItemImagesRouter({
    db,
    s3,
    bucket,
    auth: createRequireUser(db),
    presign: async (_client, _bucket, key, expiresIn) => `https://signed.invalid/${key}?ttl=${expiresIn}`,
  }));
  return { app, db };
}

function withAuth(testRequest) {
  return testRequest.set("Authorization", "Bearer valid-test-token");
}

beforeEach(() => s3Mock.reset());
after(() => s3.destroy());

test("rejects unauthenticated and invalid-token uploads", async () => {
  const { app } = setup();
  const noToken = await request(app).post(`/api/items/${ITEM_ID}/image`).attach("image", PNG, "photo.png");
  const badToken = await request(app).post(`/api/items/${ITEM_ID}/image`)
    .set("Authorization", "Bearer bad-token").attach("image", PNG, "photo.png");
  assert.equal(noToken.status, 401);
  assert.equal(badToken.status, 401);
});

test("requires the listing owner and rejects NULL owners", async () => {
  const other = setup({ item: { user_id: OTHER_ID } });
  const denied = await withAuth(request(other.app).post(`/api/items/${ITEM_ID}/image`)).attach("image", PNG, "photo.png");
  assert.equal(denied.status, 404);
  const nullOwner = setup({ item: { user_id: null } });
  const deniedNull = await withAuth(request(nullOwner.app).post(`/api/items/${ITEM_ID}/image`)).attach("image", PNG, "photo.png");
  assert.equal(deniedNull.status, 403);
  assert.equal(s3Mock.commandCalls(PutObjectCommand).length, 0);
});

test("denies image removal by non-owners and NULL owners", async () => {
  const key = `items/${ITEM_ID}/923e4567-e89b-42d3-a456-426614174000.png`;
  const other = setup({ item: { user_id: OTHER_ID, image_object_key: key } });
  const denied = await withAuth(request(other.app).delete(`/api/items/${ITEM_ID}/image`));
  assert.equal(denied.status, 404);
  const nullOwner = setup({ item: { user_id: null, image_object_key: key } });
  const deniedNull = await withAuth(request(nullOwner.app).delete(`/api/items/${ITEM_ID}/image`));
  assert.equal(deniedNull.status, 403);
  assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 0);
});

test("rejects content that is not an allowed image regardless of client MIME", async () => {
  const { app } = setup();
  const response = await withAuth(request(app).post(`/api/items/${ITEM_ID}/image`))
    .attach("image", Buffer.from("not an image"), { filename: "photo.png", contentType: "image/png" });
  assert.equal(response.status, 415);
  assert.equal(s3Mock.commandCalls(PutObjectCommand).length, 0);
});

test("rejects files over 5 MB", async () => {
  const { app } = setup();
  const response = await withAuth(request(app).post(`/api/items/${ITEM_ID}/image`))
    .attach("image", Buffer.alloc(5 * 1024 * 1024 + 1), { filename: "large.png", contentType: "image/png" });
  assert.equal(response.status, 413);
  assert.equal(s3Mock.commandCalls(PutObjectCommand).length, 0);
});

test("stores a valid image and only then updates the database key", async () => {
  const { app, db } = setup();
  s3Mock.on(PutObjectCommand).resolves({});
  const response = await withAuth(request(app).post(`/api/items/${ITEM_ID}/image`)).attach("image", PNG, "fake.jpg");
  assert.equal(response.status, 200);
  assert.equal(response.body.hasImage, true);
  assert.match(db.state.item.image_object_key, new RegExp(`^items/${ITEM_ID}/.+\\.png$`));
  const put = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
  assert.equal(put.ContentType, "image/png");
  assert.equal(put.Bucket, "test-private-bucket");
});

test("cleans up the new object when the database update fails", async () => {
  const { app, db } = setup();
  db.state.failUpdate = true;
  s3Mock.on(PutObjectCommand).resolves({});
  s3Mock.on(DeleteObjectCommand).resolves({});
  const response = await withAuth(request(app).post(`/api/items/${ITEM_ID}/image`)).attach("image", PNG, "photo.png");
  assert.equal(response.status, 500);
  assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 1);
});

test("reports an S3 upload failure without changing the stored key", async () => {
  const oldKey = `items/${ITEM_ID}/723e4567-e89b-42d3-a456-426614174000.png`;
  const { app, db } = setup({ item: { image_object_key: oldKey } });
  s3Mock.on(PutObjectCommand).rejects(Object.assign(new Error("mock S3 failure"), { name: "S3Exception" }));
  const response = await withAuth(request(app).post(`/api/items/${ITEM_ID}/image`)).attach("image", PNG, "photo.png");
  assert.equal(response.status, 502);
  assert.equal(db.state.item.image_object_key, oldKey);
});

test("replacement writes the new key before deleting the old object", async () => {
  const oldKey = `items/${ITEM_ID}/423e4567-e89b-42d3-a456-426614174000.jpg`;
  const { app, db } = setup({ item: { image_object_key: oldKey } });
  const order = db.state.events;
  s3Mock.on(PutObjectCommand).callsFake(() => { order.push("put"); return {}; });
  s3Mock.on(DeleteObjectCommand).callsFake(() => { order.push("delete"); return {}; });
  const response = await withAuth(request(app).post(`/api/items/${ITEM_ID}/image`)).attach("image", PNG, "replacement.png");
  assert.equal(response.status, 200);
  assert.equal(db.state.item.image_object_key.endsWith(".png"), true);
  assert.deepEqual(order, ["put", "db-update", "delete"]);
});

test("removal clears the database pointer before deleting the object", async () => {
  const key = `items/${ITEM_ID}/523e4567-e89b-42d3-a456-426614174000.webp`;
  const { app, db } = setup({ item: { image_object_key: key } });
  s3Mock.on(DeleteObjectCommand).callsFake(() => {
    assert.equal(db.state.item.image_object_key, null);
    return {};
  });
  const response = await withAuth(request(app).delete(`/api/items/${ITEM_ID}/image`));
  assert.equal(response.status, 200);
  assert.equal(response.body.hasImage, false);
  assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 1);
});

test("listing deletion cleans its stored image after the row delete succeeds", async () => {
  const key = `items/${ITEM_ID}/823e4567-e89b-42d3-a456-426614174000.png`;
  const { db } = setup({ item: { image_object_key: key } });
  const app = express();
  app.use("/api/items", createItemsRouter({
    db,
    s3,
    bucket: "test-private-bucket",
    auth: createRequireUser(db),
  }));
  s3Mock.on(DeleteObjectCommand).callsFake(() => {
    assert.equal(db.state.item, null);
    return {};
  });
  const response = await withAuth(request(app).delete(`/api/items/${ITEM_ID}`));
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 1);
});

test("presigns only the key stored for an existing listing", async () => {
  const key = `items/${ITEM_ID}/623e4567-e89b-42d3-a456-426614174000.png`;
  const { app } = setup({ item: { image_object_key: key } });
  const response = await withAuth(request(app).get(`/api/items/${ITEM_ID}/image-url`));
  assert.equal(response.status, 200);
  assert.equal(response.body.url, `https://signed.invalid/${key}?ttl=300`);
  assert.equal(response.body.expiresIn, 300);
});

test("requires authentication to obtain a temporary image URL", async () => {
  const key = `items/${ITEM_ID}/a23e4567-e89b-42d3-a456-426614174000.png`;
  const { app } = setup({ item: { image_object_key: key } });
  const response = await request(app).get(`/api/items/${ITEM_ID}/image-url`);
  assert.equal(response.status, 401);
});
