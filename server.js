import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json());

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
  const endpoint = `http://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}&render=false`;
  const r = await fetch(endpoint, { timeout: 15000 });
  if (!r.ok) throw new Error("Scraper: " + r.status);
  return await r.text();
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
      max_tokens: 2000,
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
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });

  const cacheKey = "prop:" + query.toLowerCase().trim();
  const cached = getCache(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const [general, contacts, permits, violations, owner, linkedin] = await Promise.allSettled([
      googleSearch(`"${query}" property management facilities contact`),
      googleSearch(`"${query}" building engineer phone email`),
      googleSearch(`"${query}" building permit fire alarm sprinkler suppression DC`),
      googleSearch(`"${query}" fire marshal violation inspection failed DC`),
      googleSearch(`"${query}" property owner LLC deed Washington DC`),
      googleSearch(`"${query}" site:linkedin.com facilities OR engineer OR "property manager"`),
    ]);

    const snippets = [
      ...(general.value || []),
      ...(contacts.value || []),
      ...(permits.value || []),
      ...(violations.value || []),
      ...(owner.value || []),
      ...(linkedin.value || []),
    ].map(r => `SOURCE: ${r.url}\nTITLE: ${r.title}\nSNIPPET: ${r.snippet}`).join("\n\n");

    let permitData = "";
    try {
      const dcHtml = await scraperFetch(`https://pivs.dcra.dc.gov/PIVS/search.aspx?searchText=${encodeURIComponent(query)}`);
      permitData = dcHtml.slice(0, 3000);
    } catch {}

    const prompt = `You are a commercial real estate and fire & life safety research expert for Washington DC, Arlington, and Alexandria.

Using ONLY the data below, extract everything known about: "${query}"

SEARCH RESULTS:
${snippets.slice(0, 8000)}

PERMIT PORTAL DATA:
${permitData || "Not available"}

Return ONLY this JSON, no other text before or after:
{
  "building": "full building name",
  "address": "full street address",
  "type": "building type",
  "region": "Washington DC or Arlington or Alexandria",
  "buildingSynopsis": "2-3 sentence summary — size, use, year built, notable facts",
  "owner": {
    "name": "owner or LLC name or Unknown",
    "phone": "phone or Unknown",
    "email": "email or Unknown"
  },
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
  "fireLifeSafety": {
    "currentProvider": "vendor name or Unknown",
    "contractStatus": "Unknown",
    "lastInspectionDate": "date or Unknown",
    "systems": ["fire alarm", "sprinkler", "suppression"]
  },
  "permits": {
    "openPermits": ["list open permits or empty"],
    "recentPermits": ["list recent closed permits or empty"],
    "violations": ["list violations or empty"]
  },
  "gpo": ["Vizient and/or Premier if healthcare"],
  "salesNotes": "best sales angle based on findings",
  "confidence": "High or Medium or Low",
  "sources": ["up to 5 source URLs"],
  "verifyLinks": [
    "https://pivs.dcra.dc.gov/PIVS/search.aspx",
    "https://fems.dc.gov/service/fire-safety-inspections",
    "https://otr.cfo.dc.gov/page/real-property-tax-database-search",
    "https://permits.arlingtonva.us/CitizenAccess/",
    "https://aca.alexandriava.gov/CitizenAccess/"
  ]
}
Use Unknown for anything not found. Never fabricate data.`;

    const raw = await claudeSynthesize(prompt);
    const parsed = extractJSON(raw) || {
      building: query, address: "Verify manually", type: "Commercial",
      region: "Washington DC", buildingSynopsis: "Could not extract data.",
      owner: { name: "Unknown", phone: "Unknown", email: "Unknown" },
      propertyManagement: { company: "Unknown", manager: "Unknown", managerPhone: "Unknown", managerEmail: "Unknown", managerTitle: "Property Manager" },
      engineering: { chiefEngineer: "Unknown", engineerPhone: "Unknown", engineerEmail: "Unknown", engineerTitle: "Chief Engineer" },
      fireLifeSafety: { currentProvider: "Unknown", contractStatus: "Unknown", lastInspectionDate: "Unknown", systems: [] },
      permits: { openPermits: [], recentPermits: [], violations: [] },
      gpo: [], salesNotes: "", confidence: "Low", sources: [],
      verifyLinks: ["https://pivs.dcra.dc.gov/PIVS/search.aspx", "https://fems.dc.gov/service/fire-safety-inspections"]
    };

    parsed.searchedAt = new Date().toLocaleString();
    setCache(cacheKey, parsed);
    res.json(parsed);

  } catch (e) {
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
    const [sam, dc, arlington, alexandria] = await Promise.allSettled([
      googleSearch("SAM.gov fire alarm sprinkler suppression inspection solicitation DC Arlington Alexandria 2025 2026"),
      googleSearch("site:ocp.dc.gov fire alarm sprinkler suppression inspection RFP 2025 2026"),
      googleSearch("Arlington County procurement fire alarm sprinkler suppression inspection RFP 2025 2026"),
      googleSearch("City of Alexandria procurement fire alarm sprinkler inspection solicitation 2025 2026"),
    ]);

    const snippets = [
      ...(sam.value || []),
      ...(dc.value || []),
      ...(arlington.value || []),
      ...(alexandria.value || []),
    ].map(r => `SOURCE: ${r.url}\nTITLE: ${r.title}\nSNIPPET: ${r.snippet}`).join("\n\n");

    const prompt = `Extract all active fire & life safety RFPs from these search results.

RESULTS:
${snippets}

Return ONLY this JSON, no other text:
{"rfps":[{"title":"","agency":"","source":"SAM.gov or DC Government or Arlington County or City of Alexandria","region":"","solicitationNumber":"","issueDate":"","dueDate":"","estimatedValue":"","description":"","services":[],"url":"","status":"Active or Upcoming or Recently Closed","notes":""}],"summary":""}

Only include real fire alarm, sprinkler, or suppression RFPs. Empty array if none found.`;

    const raw = await claudeSynthesize(prompt);
    const parsed = extractJSON(raw) || { rfps: [], summary: "No RFPs found." };
    parsed.searchedAt = new Date().toLocaleString();
    setCache(cacheKey, parsed);
    res.json(parsed);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Health check ──
app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`FireWatch server on port ${PORT}`));
