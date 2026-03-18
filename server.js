import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (origin.includes("netlify.app") || origin.includes("railway.app") || origin === process.env.ALLOWED_ORIGIN) {
      return callback(null, true);
    }
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true
}));
app.use(express.json());

const TERRITORIES = "Washington DC, Arlington VA, Alexandria VA";

// ── Cache ──
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 24;
function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL) { cache.delete(key); return null; }
  return hit.data;
}
function setCache(key, data) { cache.set(key, { ts: Date.now(), data }); }

// ── Google Search ──
async function googleSearch(query, num = 10) {
  const url = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=${process.env.GOOGLE_CX}&q=${encodeURIComponent(query)}&num=${num}`;
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error("Google: " + d.error.message);
  return (d.items || []).map(i => ({ title: i.title, url: i.link, snippet: i.snippet }));
}

// ── ScraperAPI ──
async function scraperFetch(targetUrl) {
  try {
    const endpoint = `http://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}&render=false`;
    const r = await fetch(endpoint, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return "";
    return await r.text();
  } catch { return ""; }
}

// ── Claude ──
async function claudeSynthesize(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const d = await r.json();
  if (d.error) throw new Error("Claude: " + d.error.message);
  return d.content?.map(b => b.text || "").join("") || "";
}

function extractJSON(txt) {
  if (!txt) return null;
  try { return JSON.parse(txt.trim()); } catch {}
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s < 0 || e < 0) return null;
  try { return JSON.parse(txt.slice(s, e + 1).replace(/,(\s*[}\]])/g, "$1")); } catch { return null; }
}

// ══════════════════════════════════════════
// POST /search/property
// ══════════════════════════════════════════
app.post("/search/property", async (req, res) => {
  const { query, forceRefresh } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });

  const cacheKey = "prop:" + query.toLowerCase().trim();
  if (!forceRefresh) {
    const cached = getCache(cacheKey);
    if (cached) return res.json({ ...cached, fromCache: true });
  } else {
    cache.delete(cacheKey);
  }

  try {
    const q2 = query.replace(/"/g, "");

    const searches = await Promise.allSettled([
      googleSearch(`${q2} property management company contact Washington DC Arlington Alexandria`),
      googleSearch(`${q2} building engineer facilities director phone email`),
      googleSearch(`${q2} site:linkedin.com facilities OR "chief engineer" OR "property manager"`),
      googleSearch(`${q2} property owner LLC Washington DC`),
      googleSearch(`${q2} ownership building real estate`),
      googleSearch(`${q2} fire alarm sprinkler inspection vendor contractor`),
      googleSearch(`${q2} fire marshal inspection violation`),
      googleSearch(`${q2} building permit fire alarm sprinkler Washington DC DCRA`),
      googleSearch(`${q2} building permit fire sprinkler Arlington Alexandria Virginia`),
      googleSearch(`${q2} loopnet costar property details`),
      googleSearch(`${q2} tenants floors square feet building`),
      googleSearch(`${q2} Washington DC building address contact`),
    ]);

    const allSnippets = searches
      .filter(s => s.status === "fulfilled")
      .flatMap(s => s.value)
      .map(r => `SOURCE: ${r.url}\nTITLE: ${r.title}\nSNIPPET: ${r.snippet}`)
      .join("\n\n");

    const enc = encodeURIComponent(query);
    const [dcPermits, arlingtonPermits, alexandriaPermits] = await Promise.all([
      scraperFetch(`https://pivs.dcra.dc.gov/PIVS/search.aspx?searchText=${enc}`),
      scraperFetch(`https://permits.arlingtonva.us/CitizenAccess/Cap/CapDetail.aspx?searchText=${enc}`),
      scraperFetch(`https://aca.alexandriava.gov/CitizenAccess/Cap/CapDetail.aspx?searchText=${enc}`),
    ]);

    const permitData = [
      dcPermits ? `DC PERMITS:\n${dcPermits.slice(0, 1500)}` : "",
      arlingtonPermits ? `ARLINGTON PERMITS:\n${arlingtonPermits.slice(0, 1500)}` : "",
      alexandriaPermits ? `ALEXANDRIA PERMITS:\n${alexandriaPermits.slice(0, 1500)}` : "",
    ].filter(Boolean).join("\n\n") || "Permit portal data not available.";

    const prompt = `You are an expert commercial real estate and fire & life safety research analyst covering ${TERRITORIES}.

Use the Google search results below AND your training knowledge to research: "${query}"

Prioritize search results for specific contact details. Use your training knowledge to fill in building synopsis, type, address, systems, and sales notes when search results are thin.

GOOGLE SEARCH RESULTS:
${allSnippets.slice(0, 10000)}

PERMIT PORTAL DATA:
${permitData}

Return ONLY this JSON, no other text before or after:
{
  "building": "full official building name",
  "address": "full street address including city and zip",
  "type": "building type (Senior Living, Hospital, Class A Office, Hotel, Retail, Government, etc.)",
  "region": "Washington DC or Arlington VA or Alexandria VA",
  "buildingSynopsis": "3-4 sentences on size, floors, year built, primary use, notable facts",
  "owner": {
    "name": "owner or LLC name or Unknown",
    "phone": "phone or Unknown",
    "email": "email or Unknown"
  },
  "ownershipHistory": ["previous owners if found"],
  "propertyManagement": {
    "company": "PM company or Unknown",
    "manager": "manager name or Unknown",
    "managerPhone": "phone or Unknown",
    "managerEmail": "email or Unknown",
    "managerTitle": "title or Property Manager"
  },
  "engineering": {
    "chiefEngineer": "name or Unknown",
    "engineerPhone": "phone or Unknown",
    "engineerEmail": "email or Unknown",
    "engineerTitle": "title or Chief Engineer"
  },
  "tenants": ["major tenants or residents"],
  "fireLifeSafety": {
    "currentProvider": "vendor or Unknown",
    "contractStatus": "status or Unknown",
    "contractExpirationEstimate": "estimate or Unknown",
    "lastInspectionDate": "date or Unknown",
    "systems": ["fire alarm", "sprinkler", "suppression", "monitoring"]
  },
  "permits": {
    "openPermits": ["open permits with dates"],
    "recentPermits": ["recently closed permits"],
    "violations": ["violations or failed inspections"]
  },
  "gpo": ["Vizient or Premier if applicable"],
  "salesNotes": "Best sales angle, urgency factors, who to call first, contract timing",
  "confidence": "High or Medium or Low",
  "sources": ["up to 8 source URLs"],
  "verifyLinks": [
    "https://pivs.dcra.dc.gov/PIVS/search.aspx",
    "https://fems.dc.gov/service/fire-safety-inspections",
    "https://otr.cfo.dc.gov/page/real-property-tax-database-search",
    "https://permits.arlingtonva.us/CitizenAccess/",
    "https://fire.arlingtonva.us/fire-prevention/",
    "https://aca.alexandriava.gov/CitizenAccess/",
    "https://www.alexandriava.gov/fire/fire-prevention"
  ]
}
Only use Unknown for contact details you cannot verify. Never fabricate phone numbers or emails.`;

    const raw = await claudeSynthesize(prompt);
    const parsed = extractJSON(raw) || {
      building: query, address: "Verify manually", type: "Commercial",
      region: "Washington DC", buildingSynopsis: "Could not extract data. Use verify links below.",
      owner: { name: "Unknown", phone: "Unknown", email: "Unknown" },
      ownershipHistory: [],
      propertyManagement: { company: "Unknown", manager: "Unknown", managerPhone: "Unknown", managerEmail: "Unknown", managerTitle: "Property Manager" },
      engineering: { chiefEngineer: "Unknown", engineerPhone: "Unknown", engineerEmail: "Unknown", engineerTitle: "Chief Engineer" },
      tenants: [],
      fireLifeSafety: { currentProvider: "Unknown", contractStatus: "Unknown", contractExpirationEstimate: "Unknown", lastInspectionDate: "Unknown", systems: [] },
      permits: { openPermits: [], recentPermits: [], violations: [] },
      gpo: [], salesNotes: "", confidence: "Low", sources: [],
      verifyLinks: [
        "https://pivs.dcra.dc.gov/PIVS/search.aspx",
        "https://fems.dc.gov/service/fire-safety-inspections",
        "https://permits.arlingtonva.us/CitizenAccess/",
        "https://aca.alexandriava.gov/CitizenAccess/"
      ]
    };

    parsed.searchedAt = new Date().toLocaleString();
    setCache(cacheKey, parsed);
    res.json(parsed);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
// POST /search/rfp
// ══════════════════════════════════════════
app.post("/search/rfp", async (req, res) => {
  const cacheKey = "rfp:latest";
  const cached = getCache(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const searches = await Promise.allSettled([
      googleSearch(`SAM.gov fire alarm sprinkler suppression inspection solicitation Washington DC Arlington Alexandria 2025 2026`),
      googleSearch(`site:ocp.dc.gov fire alarm sprinkler suppression inspection RFP 2025 2026`),
      googleSearch(`DC Office of Contracting Procurement fire alarm sprinkler suppression inspection solicitation 2025`),
      googleSearch(`Arlington County procurement fire alarm sprinkler suppression inspection RFP 2025 2026`),
      googleSearch(`City of Alexandria procurement fire alarm sprinkler suppression inspection solicitation 2025 2026`),
      googleSearch(`sam.gov fire protection inspection Washington DC Arlington Alexandria 2025`),
    ]);

    const allSnippets = searches
      .filter(s => s.status === "fulfilled")
      .flatMap(s => s.value)
      .map(r => `SOURCE: ${r.url}\nTITLE: ${r.title}\nSNIPPET: ${r.snippet}`)
      .join("\n\n");

    const prompt = `You are a government procurement expert. Extract all fire & life safety RFPs from these search results for ${TERRITORIES}.

SEARCH RESULTS:
${allSnippets}

Return ONLY this JSON, no other text:
{"rfps":[{"title":"","agency":"","source":"SAM.gov or DC Government or Arlington County or City of Alexandria","region":"Washington DC or Arlington VA or Alexandria VA","solicitationNumber":"","issueDate":"","dueDate":"","estimatedValue":"","description":"","services":[],"url":"","status":"Active or Upcoming or Recently Closed","notes":""}],"summary":"brief honest summary of what was found"}

Only include real fire alarm, sprinkler, fire suppression, or life safety inspection RFPs. Empty array if none found. Never fabricate RFPs.`;

    const raw = await claudeSynthesize(prompt);
    const parsed = extractJSON(raw) || { rfps: [], summary: "No active RFPs found at this time." };
    parsed.searchedAt = new Date().toLocaleString();
    setCache(cacheKey, parsed);
    res.json(parsed);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Debug: test Google search (GET for easy browser testing) ──
app.get("/debug/google", async (req, res) => {
  const query = req.query.q || "AVA Ballston Arlington VA";
  try {
    const results = await googleSearch(`${query} property management contact`);
    res.json({ query, count: results.length, results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Health check ──
app.get("/health", (req, res) => res.json({ status: "ok", territories: TERRITORIES, time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`FireWatch server running on port ${PORT} — covering ${TERRITORIES}`));
