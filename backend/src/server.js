import "dotenv/config";
import express from "express";
import cors from "cors";
import itemsRouter from "./routes/items.js";
import itemImagesRouter from "./routes/itemImages.js";
import claimsRouter from "./routes/claims.js";

const app = express();
const PORT = process.env.PORT || 4000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";

app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "FindIt@Thapar API" });
});

app.use("/api/items", itemImagesRouter);
app.use("/api/items", itemsRouter);
app.use("/api", claimsRouter);

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, () => {
  console.log(`FindIt@Thapar API running at http://localhost:${PORT}`);
});
