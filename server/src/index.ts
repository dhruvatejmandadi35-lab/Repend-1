import "dotenv/config";
import express from "express";
import cors from "cors";
import generateRoute from "./routes/generate.js";
import verifyRoute from "./routes/verify.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "256kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: "claude-opus-4-7" });
});

app.use("/api/generate", generateRoute);
app.use("/api/verify", verifyRoute);

const PORT = Number(process.env.PORT ?? 8787);
app.listen(PORT, () => {
  console.log(`[repend] server listening on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[repend] WARNING: ANTHROPIC_API_KEY is not set");
  }
});
