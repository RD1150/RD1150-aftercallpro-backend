# AfterCallPro Glue Backend (Render-ready)

This service connects your AI receptionist to GoHighLevel, HubSpot, and Salesforce.
It also adds a basic spam filter, booking link handoff, and a simple analytics store.

## 1) Local quick start

```bash
npm install
cp .env.example .env   # then edit with your keys
npm start
```

## 2) Deploy to Render (recommended)

1. Create a new **GitHub repo** and push these files.
2. In **render.com** → New → **Web Service** → connect the repo.
3. Environment:
   - Runtime: **Node 18+**
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Add the following **Environment Variables** in Render:
   - `GHL_API_KEY`
   - `GHL_LOCATION_ID`
   - `GHL_CALENDAR_LINK`
   - `HUBSPOT_TOKEN`
   - `SF_INSTANCE_URL`
   - `SF_ACCESS_TOKEN`
   - `SF_API_VERSION` (e.g., v61.0)
   - `SF_OBJECT` (Lead or Contact)
   - `PORT` (Render sets this automatically, but keep in .env for local)
5. Deploy. You’ll get a URL like:
   `https://aftercallpro-backend.onrender.com`

## 3) Wire your numbers and AI

- **Voice webhook** (Twilio or GHL number):
  `POST https://YOUR_URL/voice/inbound`

- **After each call**, your AI posts the summary/transcript:
  `POST https://YOUR_URL/lead`
  ```json
  {
    "name": "Jane Doe",
    "phone": "+18053402583",
    "email": "jane@example.com",
    "company": "Doe Plumbing",
    "summary": "Emergency leak; wants visit today 4–6pm.",
    "transcript": "full text...",
    "tags": ["aftercallpro","lead","inbound"]
  }
  ```

- **Booking link** handoff (used by agent or AI):
  `POST https://YOUR_URL/book` → returns your GHL calendar link + SMS template.

- **Metrics** (for your dashboard):
  `GET https://YOUR_URL/metrics` → JSON of last 30 days.

## Notes
- HubSpot: create a **Private App** and use the token in `HUBSPOT_TOKEN`.
- Salesforce: obtain a **Bearer access token** from your Connected App OAuth flow,
  set `SF_INSTANCE_URL`, `SF_ACCESS_TOKEN`, `SF_API_VERSION`, and `SF_OBJECT`.
- GoHighLevel: use **LeadConnector API key** and your **Location ID**.
