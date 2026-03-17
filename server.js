import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json());

// ── Territories ──
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

function snippetsToText(results) {
  return results.map(r => `SOURCE: ${r.url}\nTITLE: ${r.title}\nSNIPPET: ${r.snippet}`).join("\n\n");
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
    // ── 12 parallel Google searches ──
    const searches = await Promise.allSettled([
      // Contact & management
      googleSearch(`"${query}" property management company contact ${TERRITORIES}`),
      googleSearch(`"${query}" building engineer facilities director phone email ${TERRITORIES}`),
      googleSearch(`"${query}" site:linkedin.com facilities OR "chief engineer" OR "property manager"`),
      // Ownership
      googleSearch(`"${query}" property owner LLC deed ${TERRITORIES}`),
      googleSearch(`"${query}" ownership history building ${TERRITORIES}`),
      // Fire & life safety
      googleSearch(`"${query}" fire alarm sprinkler suppression inspection vendor contractor ${TERRITORIES}`),
      googleSearch(`"${query}" fire marshal inspection violation failed ${TERRITORIES}`),
      // Permits — all three jurisdictions
      googleSearch(`"${query}" building permit fire alarm sprinkler suppression Washington DC DCRA`),
      googleSearch(`"${query}" building permit fire sprinkler Arlington VA`),
      googleSearch(`"${query}" building permit fire sprinkler Alexandria VA`),
      // Property data
      googleSearch(`"${query}" site:loopnet.com OR site:costar.com`),
      // Tenants & synopsis
      googleSearch(`"${query}" tenants floors square feet building ${TERRITORIES}`),
    ]);

    const allSnippets = searches
      .filter(s => s.status === "fulfilled")
      .flatMap(s => s.value)
      .map(r => `SOURCE: ${r.url}\nTITLE: ${r.title}\nSNIPPET: ${r.snippet}`)
      .join("\n\n");

    // ── Scrape permit portals for all 3 territories ──
    const q = encodeURIComponent(query);
    const [dcPermits, arlingtonPermits, alexandriaPermits] = await Promise.all([
      scraperFetch(`https://pivs.dcra.dc.gov/PIVS/search.aspx?searchText=${q}`),
      scraperFetch(`https://permits.arlingtonva.us/CitizenAccess/Cap/CapDetail.aspx?searchText=${q}`),
      scraperFetch(`https://aca.alexandriava.gov/CitizenAccess/Cap/CapDetail.aspx?searchText=${q}`),
    ]);

    const permitData = [
      dcPermits ? `DC PERMITS:\n${dcPermits.slice(0, 1500)}` : "",
      arlingtonPermits ? `ARLINGTON PERMITS:\n${arlingtonPermits.slice(0, 1500)}` : "",
      alexandriaPermits ? `ALEXANDRIA PERMITS:\n${alexandriaPermits.slice(0, 1500)}` : "",
    ].filter(Boolean).join("\n\n") || "Permit portal data not available — verify manually.";

    // ── Claude synthesis ──
    const prompt = `You are an expert commercial real estate and fire & life safety research analyst covering ${TERRITORIES}.

Using ONLY the search results and permit data below, extract everything known about: "${query}"

SEARCH RESULTS:
${allSnippets.slice(0, 10000)}

PERMIT PORTAL DATA:
${permitData}

Return ONLY this JSON object, no other text before or after:
{
  "building": "full official building name",
  "address": "full street address including city and zip",
  "type": "building type (Hospital, Class A Office, Hotel, Retail, Government, etc.)",
  "region": "Washington DC or Arlington VA or Alexandria VA",
  "buildingSynopsis": "3-4 sentence summary covering size, floors, year built, primary use, notable tenants, and any recent news",
  "owner": {
    "name": "owner or LLC name or Unknown",
    "phone": "phone or Unknown",
    "email": "email or Unknown"
  },
  "ownershipHistory": ["list any previous owners or ownership changes found"],
  "propertyManagement": {
    "company": "PM company name or Unknown",
    "manager": "manager name or Unknown",
    "managerPhone": "phone or Unknown",
    "managerEmail": "email or Unknown",
    "managerTitle": "exact title or Property Manager"
  },
  "engineering": {
    "chiefEngineer": "name or Unknown",
    "engineerPhone": "phone or Unknown",
    "engineerEmail": "email or Unknown",
    "engineerTitle": "exact title or Chief Engineer"
  },
  "tenants": ["list major tenants found"],
  "fireLifeSafety": {
    "currentProvider": "current fire & life safety vendor or Unknown",
    "contractStatus": "contract details or Unknown",
    "contractExpirationEstimate": "estimated expiration based on typical 3-5 year contracts or Unknown",
    "lastInspectionDate": "date or Unknown",
    "systems": ["list all fire & life safety systems found: fire alarm, sprinkler, suppression, monitoring, kitchen hood, etc."]
  },
  "permits": {
    "openPermits": ["list all open fire/alarm/sprinkler permits found with dates"],
    "recentPermits": ["list recently closed relevant permits with dates"],
    "violations": ["list any fire marshal violations or failed inspections with dates"]
  },
  "gpo": ["Vizient and/or Premier if healthcare GPO member"],
  "salesNotes": "detailed sales intelligence — best angle, urgency factors, who to call first, contract timing",
  "confidence": "High or Medium or Low",
  "sources": ["list up to 8 source URLs used"],
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
Use "Unknown" for anything not found. Never fabricate names, phones, or emails.`;

    const raw = await claudeSynthesize(prompt);
    const parsed = extractJSON(raw) || {
      building: query, address: "Verify manually", type: "Commercial",
      region: "Washington DC", buildingSynopsis: "Could not extract structured data. Use verify links below.",
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
      googleSearch(`site:ocp.dc.gov fire alarm sprinkler suppression inspection RFP solicitation 2025 2026`),
      googleSearch(`"DC Office of Contracting" fire alarm sprinkler suppression inspection solicitation 2025`),
      googleSearch(`Arlington County procurement fire alarm sprinkler suppression inspection RFP 2025 2026`),
      googleSearch(`"City of Alexandria" procurement fire alarm sprinkler suppression inspection solicitation 2025 2026`),
      googleSearch(`site:sam.gov fire protection inspection "Washington DC" OR "Arlington" OR "Alexandria" 2025`),
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

// ── Health check ──
app.get("/health", (req, res) => res.json({ status: "ok", territories: TERRITORIES, time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`FireWatch server running on port ${PORT} — covering ${TERRITORIES}`));
