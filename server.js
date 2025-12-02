// server.js
import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- REQUIRED FOR RENDER ---
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// --- Simple root (optional) ---
app.get("/", (req, res) => {
  res.json({ ok: true, service: "AfterCallPro backend" });
});

// ---- Placeholders you’ll wire later ----
app.post("/ingest/ghl", (req, res) => {
  // Expect webhook from GHL or your app
  // TODO: qualify/route lead, then forward to HubSpot/Salesforce
  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`AfterCallPro backend listening on :${PORT}`);
});
