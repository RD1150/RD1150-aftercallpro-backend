// server.js — AfterCallPro “glue” backend with GHL + HubSpot + Salesforce upserts
// Run:  node server.js
// Requires: npm i express node-fetch sqlite3 sqlite dotenv
import express from "express";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true })); // for Twilio form posts
app.use(express.json());

// ---------- SQLite (simple analytics store) ----------
let db;
(async () => {
  db = await open({ filename: "./acp.sqlite", driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT,
      from_number TEXT,
      to_number TEXT,
      spam_score INTEGER,
      disposition TEXT,
      summary TEXT,
      transcript TEXT,
      minutes REAL DEFAULT 0
    );
  `);
})();

// ---------- Helpers ----------
const safeTrim = (s = "", max = 4000) => String(s || "").slice(0, max);

// --- LeadConnector (GoHighLevel) ---
const lc = async (path, method = "GET", body) => {
  const r = await fetch(`https://api.leadconnectorhq.com${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${process.env.GHL_API_KEY}`,
      "Version": "2021-07-28",
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`LeadConnector ${method} ${path} ${r.status}: ${t}`);
  }
  return r.json();
};

// --- HubSpot (Private App token) ---
const hubspotBase = "https://api.hubapi.com";
const hubspotHeaders = {
  "Authorization": `Bearer ${process.env.HUBSPOT_TOKEN}`,
  "Content-Type": "application/json",
};

async function hubspotUpsert({ email, phone, firstName, lastName, summary }) {
  if (!process.env.HUBSPOT_TOKEN) return { skipped: true, reason: "No HUBSPOT_TOKEN" };

  // Try to find by email
  let vid = null;
  if (email) {
    const findByEmail = await fetch(
      `${hubspotBase}/crm/v3/objects/contacts/search`,
      {
        method: "POST",
        headers: hubspotHeaders,
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
          properties: ["email"],
          limit: 1,
        }),
      }
    );
    const js = await findByEmail.json();
    if (js?.results?.length) vid = js.results[0].id;
  }

  // If not found and we have a phone, try phone search
  if (!vid && phone) {
    const findByPhone = await fetch(
      `${hubspotBase}/crm/v3/objects/contacts/search`,
      {
        method: "POST",
        headers: hubspotHeaders,
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: "phone", operator: "EQ", value: phone }] }],
          properties: ["phone"],
          limit: 1,
        }),
      }
    );
    const jp = await findByPhone.json();
    if (jp?.results?.length) vid = jp.results[0].id;
  }

  const props = {
    email: email || undefined,
    phone: phone || undefined,
    firstname: firstName || "Caller",
    lastname: lastName || "",
    acp_call_summary__c: safeTrim(summary, 4000), // custom property if created; otherwise ignored
  };

  if (vid) {
    // Update
    const up = await fetch(`${hubspotBase}/crm/v3/objects/contacts/${vid}`, {
      method: "PATCH",
      headers: hubspotHeaders,
      body: JSON.stringify({ properties: props }),
    });
    if (!up.ok) throw new Error(`HubSpot PATCH ${up.status}`);
    return { updated: true, id: vid };
  } else {
    // Create
    const cr = await fetch(`${hubspotBase}/crm/v3/objects/contacts`, {
      method: "POST",
      headers: hubspotHeaders,
      body: JSON.stringify({ properties: props }),
    });
    if (!cr.ok) throw new Error(`HubSpot CREATE ${cr.status}`);
    const j = await cr.json();
    return { created: true, id: j.id };
  }
}

// --- Salesforce (REST API) ---
const sf = {
  url: process.env.SF_INSTANCE_URL,
  token: process.env.SF_ACCESS_TOKEN,
  version: process.env.SF_API_VERSION || "v61.0",
  object: process.env.SF_OBJECT || "Lead", // "Lead" or "Contact"
};

const sfHeaders = {
  "Authorization": `Bearer ${sf.token}`,
  "Content-Type": "application/json",
};

async function salesforceQuery(soql) {
  if (!sf.url || !sf.token) return { totalSize: 0, records: [] };
  const r = await fetch(`${sf.url}/services/data/${sf.version}/query/?q=${encodeURIComponent(soql)}`, {
    headers: sfHeaders,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Salesforce QUERY ${r.status}: ${t}`);
  }
  return r.json();
}

async function salesforceUpsert({ email, phone, firstName, lastName, company, summary }) {
  if (!sf.url || !sf.token) return { skipped: true, reason: "No Salesforce credentials" };

  // Choose fields per object
  const obj = sf.object; // Lead or Contact
  const fields = obj === "Contact"
    ? { FirstName: firstName || "Caller", LastName: lastName || "Unknown", Email: email || undefined, Phone: phone || undefined, Description: safeTrim(summary, 4000) }
    : { FirstName: firstName || "Caller", LastName: lastName || "Unknown", Company: company || "AfterCallPro", Email: email || undefined, Phone: phone || undefined, Description: safeTrim(summary, 4000) };

  // Try find by Email then Phone
  let recordId = null;
  if (email) {
    const resE = await salesforceQuery(`SELECT Id FROM ${obj} WHERE Email = '${email.replace(/'/g, "\\'")}' LIMIT 1`);
    if (resE?.records?.length) recordId = resE.records[0].Id;
  }
  if (!recordId && phone) {
    const resP = await salesforceQuery(`SELECT Id FROM ${obj} WHERE Phone = '${phone.replace(/'/g, "\\'")}' LIMIT 1`);
    if (resP?.records?.length) recordId = resP.records[0].Id;
  }

  if (recordId) {
    // Update
    const up = await fetch(`${sf.url}/services/data/${sf.version}/sobjects/${obj}/${recordId}`, {
      method: "PATCH",
      headers: sfHeaders,
      body: JSON.stringify(fields),
    });
    if (!up.ok) {
      const t = await up.text();
      throw new Error(`Salesforce UPDATE ${up.status}: ${t}`);
    }
    return { updated: true, id: recordId };
  } else {
    // Create
    const cr = await fetch(`${sf.url}/services/data/${sf.version}/sobjects/${obj}`, {
      method: "POST",
      headers: sfHeaders,
      body: JSON.stringify(fields),
    });
    if (!cr.ok) {
      const t = await cr.text();
      throw new Error(`Salesforce CREATE ${cr.status}: ${t}`);
    }
    const j = await cr.json();
    return { created: true, id: j.id };
  }
}

// --- Spam score (very simple heuristic) ---
const spamScore = (from, callerName = "") => {
  let s = 0;
  if (!from) s += 40;
  if (/^unknown|spam|scam/i.test(callerName)) s += 50;
  if (/^(222|000)/.test((from || "").replace(/\D/g, ""))) s += 25;
  if (from && from.length < 7) s += 30;
  return Math.min(100, s);
};

// ---------- 1) Inbound voice webhook ----------
app.post("/voice/inbound", async (req, res) => {
  const from = req.body.From || "";
  const to = req.body.To || "";
  const callerName = req.body.CallerName || "";
  const score = spamScore(from, callerName);

  await db.run(
    `INSERT INTO calls (started_at, from_number, to_number, spam_score, disposition)
     VALUES (datetime('now'), ?, ?, ?, 'in_progress')`,
    from, to, score
  );

  if (score >= 60) {
    const twiml = `
      <Response>
        <Reject reason="rejected_by_spam_filter"/>
      </Response>`;
    res.type("text/xml").send(twiml.trim());
    return;
  }

  // Hand off to your current AI receptionist / IVR logic or ring-through
  const twiml = `
    <Response>
      <Say voice="Polly.Joanna">Please hold while we connect you.</Say>
      <Dial timeout="20">
        <Number>${to}</Number>
      </Dial>
    </Response>`;
  res.type("text/xml").send(twiml.trim());
});

// ---------- 2) Lead upsert endpoint (called by your AI after a call) ----------
app.post("/lead", async (req, res) => {
  const {
    name = "",
    phone = "",
    email = "",
    company = "AfterCallPro",
    summary = "",
    transcript = "",
    tags = [],
  } = req.body;

  const [firstName, ...rest] = String(name || "").trim().split(/\s+/);
  const lastName = rest.join(" ");

  const results = {
    ghl: null,
    hubspot: null,
    salesforce: null,
  };

  // --- GoHighLevel upsert
  try {
    const contact = await lc("/v1/contacts/upsert", "POST", {
      contact: {
        phone: phone || undefined,
        email: email || undefined,
        firstName: firstName || "Caller",
        lastName: lastName || "",
        locationId: process.env.GHL_LOCATION_ID,
        tags,
        // customFields: [{ id: "Call Summary", value: safeTrim(summary, 4000) }]
      },
    });
    // Add transcript as a note
    if (contact?.contact?.id) {
      await lc("/v1/contacts/notes/", "POST", {
        contactId: contact.contact.id,
        body: `AfterCallPro transcript:\n\n${safeTrim(transcript, 15000)}`,
      });
    }
    results.ghl = { ok: true, id: contact?.contact?.id || null };
  } catch (e) {
    results.ghl = { ok: false, error: e.message };
  }

  // --- HubSpot upsert
  try {
    results.hubspot = await hubspotUpsert({
      email,
      phone,
      firstName,
      lastName,
      summary,
    });
  } catch (e) {
    results.hubspot = { ok: false, error: e.message };
  }

  // --- Salesforce upsert
  try {
    results.salesforce = await salesforceUpsert({
      email,
      phone,
      firstName,
      lastName,
      company,
      summary,
    });
  } catch (e) {
    results.salesforce = { ok: false, error: e.message };
  }

  // Save analytics
  await db.run(
    `UPDATE calls
     SET summary = ?, transcript = ?, disposition = 'completed'
     WHERE id = (SELECT id FROM calls ORDER BY id DESC LIMIT 1)`,
    safeTrim(summary, 4000),
    safeTrim(transcript, 15000)
  );

  res.json({ ok: true, results });
});

// ---------- 3) Booking link (returns your GHL calendar URL and an SMS template) ----------
app.post("/book", async (req, res) => {
  const { phone, message } = req.body;
  const link = process.env.GHL_CALENDAR_LINK;
  res.json({
    ok: true,
    link,
    smsTemplate: message || `Here’s the scheduling link: ${link}`,
  });
});

// ---------- 4) Simple analytics for your dashboard ----------
app.get("/metrics", async (_req, res) => {
  const rows = await db.all(`
    SELECT date(started_at) as day,
           COUNT(*) as calls,
           SUM(CASE WHEN spam_score>=60 THEN 1 ELSE 0 END) as blocked_spam
    FROM calls
    GROUP BY date(started_at)
    ORDER BY day DESC
    LIMIT 30
  `);
  res.json({ days: rows });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("AfterCallPro glue running on", PORT));
