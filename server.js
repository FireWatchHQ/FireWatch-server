
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
const TODAY = () => new Date().toISOString().split("T")[0];

// ── Cache ──
const cache = new Map();
const CACHE_TTL_DAY  = 1000 * 60 * 60 * 24;
const CACHE_TTL_HOUR = 1000 * 60 * 60 * 4;
function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > hit.ttl) { cache.delete(key); return null; }
  return hit.data;
}
function setCache(key, data, ttl=CACHE_TTL_DAY) {
  cache.set(key, { ts:Date.now(), data, ttl });
}

// ── SerpApi Google Search ──
async function serpSearch(query, num=10) {
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=${num}&api_key=${process.env.SERPAPI_KEY}&gl=us&hl=en`;
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error("SerpApi: " + d.error);
  return (d.organic_results||[]).map(i=>({ title:i.title, url:i.link, snippet:i.snippet||"" }));
}

// ── Apollo.io Contact Enrichment (optional) ──
async function apolloSearch(name, company) {
  if (!process.env.APOLLO_API_KEY) return null;
  try {
    const r = await fetch("https://api.apollo.io/v1/people/search", {
      method:"POST",
      headers:{ "Content-Type":"application/json", "x-api-key":process.env.APOLLO_API_KEY },
      body:JSON.stringify({
        q_person_name: name||"",
        q_organization_name: company||"",
        person_titles: ["property manager","facilities director","chief engineer","building engineer","plant operations"],
        page:1, per_page:5
      })
    });
    const d = await r.json();
    return d.people||[];
  } catch { return null; }
}

// ── Claude ──
async function claudeSynthesize(prompt, maxTokens=3000) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-api-key":process.env.ANTHROPIC_API_KEY,
      "anthropic-version":"2023-06-01"
    },
    body:JSON.stringify({
      model:"claude-sonnet-4-20250514",
      max_tokens:maxTokens,
      messages:[{ role:"user", content:prompt }]
    })
  });
  const d = await r.json();
  if (d.error) throw new Error("Claude: " + d.error.message);
  return d.content?.map(b=>b.text||"").join("") || "";
}

function extractJSON(txt) {
  if (!txt) return null;
  try { return JSON.parse(txt.trim()); } catch {}
  const s=txt.indexOf("{"), e=txt.lastIndexOf("}");
  if (s<0||e<0) return null;
  try { return JSON.parse(txt.slice(s,e+1).replace(/,(\s*[}\]])/g,"$1")); } catch { return null; }
}

// ══════════════════════════════════════════
// POST /search/property
// ══════════════════════════════════════════
app.post("/search/property", async (req, res) => {
  const { query, forceRefresh } = req.body;
  if (!query) return res.status(400).json({ error:"query required" });

  const cacheKey = "prop:" + query.toLowerCase().trim();
  if (!forceRefresh) {
    const cached = getCache(cacheKey);
    if (cached) return res.json({ ...cached, fromCache:true });
  } else {
    cache.delete(cacheKey);
  }

  try {
    const q = query.replace(/"/g,"");

    // ── 14 parallel Google searches ──
    const searches = await Promise.allSettled([
      serpSearch(`${q} property management company contact Washington DC Arlington Alexandria`),
      serpSearch(`${q} building engineer facilities director phone email`),
      serpSearch(`${q} property manager chief engineer linkedin`),
      serpSearch(`${q} property owner LLC Washington DC Virginia`),
      serpSearch(`${q} building owner real estate`),
      serpSearch(`${q} fire alarm sprinkler inspection vendor contractor`),
      serpSearch(`${q} fire marshal inspection violation`),
      serpSearch(`${q} building permit fire alarm sprinkler site:dcra.dc.gov OR site:pivs.dcra.dc.gov`),
      serpSearch(`${q} permit fire sprinkler alarm site:arlingtonva.us OR site:permits.arlingtonva.us`),
      serpSearch(`${q} permit fire sprinkler alarm site:alexandriava.gov OR site:aca.alexandriava.gov`),
      serpSearch(`${q} fire marshal violation failed inspection DC Virginia`),
      serpSearch(`${q} loopnet costar property details`),
      serpSearch(`${q} tenants floors square feet building`),
      serpSearch(`${q} Washington DC Arlington Alexandria building address contact`),
    ]);

    const allSnippets = searches
      .filter(s=>s.status==="fulfilled")
      .flatMap(s=>s.value)
      .map(r=>`SOURCE: ${r.url}\nTITLE: ${r.title}\nSNIPPET: ${r.snippet}`)
      .join("\n\n");

    // ── Targeted permit & violation searches ──
    const [dcP, arP, alP, viol] = await Promise.allSettled([
      serpSearch(`"${q}" permit fire alarm sprinkler suppression DCRA Washington DC ${new Date().getFullYear()}`),
      serpSearch(`"${q}" permit fire alarm sprinkler Arlington County Virginia ${new Date().getFullYear()}`),
      serpSearch(`"${q}" permit fire alarm sprinkler Alexandria Virginia ${new Date().getFullYear()}`),
      serpSearch(`"${q}" fire marshal violation citation inspection failed DC Virginia`),
    ]);

    const permitSnippets = [dcP,arP,alP,viol]
      .filter(s=>s.status==="fulfilled")
      .flatMap(s=>s.value)
      .map(r=>`SOURCE: ${r.url}\nTITLE: ${r.title}\nSNIPPET: ${r.snippet}`)
      .join("\n\n");

    // ── Claude synthesis ──
    const prompt = `You are an expert commercial real estate and fire & life safety research analyst covering ${TERRITORIES}.

Use the Google search results below AND your training knowledge to research: "${query}"
Today's date: ${TODAY()}

GENERAL SEARCH RESULTS:
${allSnippets.slice(0,8000)}

PERMIT & VIOLATION RESULTS:
${permitSnippets.slice(0,3000)}

Return ONLY this JSON, no other text:
{
  "building": "full official building name",
  "address": "full street address with city and zip",
  "type": "building type",
  "region": "Washington DC or Arlington VA or Alexandria VA",
  "buildingSynopsis": "3-4 sentences: size, floors, year built, primary use, notable facts",
  "owner": { "name": "or Unknown", "phone": "or Unknown", "email": "or Unknown" },
  "ownershipHistory": ["previous owners if found"],
  "propertyManagement": {
    "company": "or Unknown", "manager": "or Unknown",
    "managerPhone": "or Unknown", "managerEmail": "or Unknown",
    "managerTitle": "or Property Manager"
  },
  "engineering": {
    "chiefEngineer": "or Unknown", "engineerPhone": "or Unknown",
    "engineerEmail": "or Unknown", "engineerTitle": "or Chief Engineer"
  },
  "tenants": ["major tenants or residents"],
  "fireLifeSafety": {
    "currentProvider": "or Unknown", "contractStatus": "or Unknown",
    "contractExpirationEstimate": "or Unknown", "lastInspectionDate": "or Unknown",
    "systems": ["fire alarm", "sprinkler", "suppression", "monitoring"]
  },
  "permits": {
    "openPermits": ["ONLY confirmed open permits with numbers and dates"],
    "recentPermits": ["recently closed permits with dates"],
    "violations": ["ONLY confirmed violations with citation numbers and dates"]
  },
  "gpo": ["Vizient or Premier if applicable"],
  "salesNotes": "Best sales angle, urgency, who to call first, contract timing",
  "confidence": "High or Medium or Low",
  "sources": ["up to 8 real source URLs"],
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
Only use Unknown for unverified contacts. Never fabricate phones, emails, permit numbers, or violations.`;

    const raw = await claudeSynthesize(prompt);
    let parsed = extractJSON(raw) || {
      building:query, address:"Verify manually", type:"Commercial",
      region:"Washington DC", buildingSynopsis:"Could not extract data.",
      owner:{name:"Unknown",phone:"Unknown",email:"Unknown"},
      ownershipHistory:[],
      propertyManagement:{company:"Unknown",manager:"Unknown",managerPhone:"Unknown",managerEmail:"Unknown",managerTitle:"Property Manager"},
      engineering:{chiefEngineer:"Unknown",engineerPhone:"Unknown",engineerEmail:"Unknown",engineerTitle:"Chief Engineer"},
      tenants:[],
      fireLifeSafety:{currentProvider:"Unknown",contractStatus:"Unknown",contractExpirationEstimate:"Unknown",lastInspectionDate:"Unknown",systems:[]},
      permits:{openPermits:[],recentPermits:[],violations:[]},
      gpo:[], salesNotes:"", confidence:"Low", sources:[],
      verifyLinks:[
        "https://pivs.dcra.dc.gov/PIVS/search.aspx",
        "https://fems.dc.gov/service/fire-safety-inspections",
        "https://permits.arlingtonva.us/CitizenAccess/",
        "https://aca.alexandriava.gov/CitizenAccess/"
      ]
    };

    // ── Apollo enrichment if available ──
    if (process.env.APOLLO_API_KEY && parsed.propertyManagement?.company && parsed.propertyManagement.company !== "Unknown") {
      const people = await apolloSearch(null, parsed.propertyManagement.company);
      if (people && people.length > 0) {
        const mgr = people.find(p => p.title?.toLowerCase().includes("property manager") || p.title?.toLowerCase().includes("facilities"));
        const eng = people.find(p => p.title?.toLowerCase().includes("engineer") || p.title?.toLowerCase().includes("maintenance"));
        if (mgr) {
          if (mgr.name && parsed.propertyManagement.manager === "Unknown") parsed.propertyManagement.manager = mgr.name;
          if (mgr.email && parsed.propertyManagement.managerEmail === "Unknown") parsed.propertyManagement.managerEmail = mgr.email;
          if (mgr.phone_numbers?.[0] && parsed.propertyManagement.managerPhone === "Unknown") parsed.propertyManagement.managerPhone = mgr.phone_numbers[0];
          if (mgr.title) parsed.propertyManagement.managerTitle = mgr.title;
        }
        if (eng) {
          if (eng.name && parsed.engineering.chiefEngineer === "Unknown") parsed.engineering.chiefEngineer = eng.name;
          if (eng.email && parsed.engineering.engineerEmail === "Unknown") parsed.engineering.engineerEmail = eng.email;
          if (eng.phone_numbers?.[0] && parsed.engineering.engineerPhone === "Unknown") parsed.engineering.engineerPhone = eng.phone_numbers[0];
          if (eng.title) parsed.engineering.engineerTitle = eng.title;
        }
        parsed.apolloEnriched = true;
      }
    }

    parsed.searchedAt = new Date().toLocaleString();
    setCache(cacheKey, parsed);
    res.json(parsed);

  } catch(e) {
    console.error(e);
    res.status(500).json({ error:e.message });
  }
});

// ══════════════════════════════════════════
// POST /search/rfp — Active only, future due dates
// ══════════════════════════════════════════
app.post("/search/rfp", async (req, res) => {
  const { forceRefresh } = req.body || {};
  const cacheKey = "rfp:active";

  if (!forceRefresh) {
    const cached = getCache(cacheKey);
    if (cached) return res.json({ ...cached, fromCache:true });
  } else {
    cache.delete(cacheKey);
  }

  const year = new Date().getFullYear();
  const nextYear = year + 1;

  try {
    const searches = await Promise.allSettled([
      serpSearch(`SAM.gov fire alarm inspection sprinkler suppression solicitation "Washington DC" OR "Arlington" OR "Alexandria" active open ${year} ${nextYear}`),
      serpSearch(`SAM.gov fire protection life safety inspection contract opportunity DC Virginia active ${year}`),
      serpSearch(`"DC Office of Contracting" OR "ocp.dc.gov" fire alarm sprinkler suppression inspection RFP open active ${year}`),
      serpSearch(`"Arlington County" procurement fire alarm sprinkler suppression inspection RFP solicitation ${year} ${nextYear}`),
      serpSearch(`"City of Alexandria" procurement fire alarm sprinkler suppression inspection solicitation bid ${year} ${nextYear}`),
      serpSearch(`site:sam.gov fire inspection "Washington DC" OR "Arlington VA" OR "Alexandria VA" ${year}`),
      serpSearch(`fire alarm sprinkler suppression inspection contract bid solicitation "Washington DC" ${year} due`),
    ]);

    const allSnippets = searches
      .filter(s=>s.status==="fulfilled")
      .flatMap(s=>s.value)
      .map(r=>`SOURCE: ${r.url}\nTITLE: ${r.title}\nSNIPPET: ${r.snippet}`)
      .join("\n\n");

    const prompt = `You are a government procurement expert for fire & life safety services.

Today: ${TODAY()} — Territory: ${TERRITORIES} ONLY

Extract ONLY active RFPs meeting ALL criteria:
1. Fire alarm, sprinkler, suppression, or life safety inspection services
2. Location: Washington DC, Arlington VA, or Alexandria VA only  
3. Due date AFTER ${TODAY()} or explicitly active/open status
4. Do NOT include expired, closed, awarded, or cancelled solicitations

SEARCH RESULTS:
${allSnippets}

Return ONLY this JSON:
{"rfps":[{"title":"","agency":"","source":"SAM.gov or DC Government or Arlington County or City of Alexandria","region":"Washington DC or Arlington VA or Alexandria VA","solicitationNumber":"","issueDate":"","dueDate":"must be future date","estimatedValue":"","description":"","services":[],"url":"","status":"Active","notes":""}],"summary":"honest summary of results"}

Only include RFPs with confirmed future due dates. Empty array is better than stale data. Never fabricate.`;

    const raw = await claudeSynthesize(prompt);
    let parsed = extractJSON(raw) || { rfps:[], summary:"No active RFPs found." };

    // Hard filter — remove past due dates
    if (parsed.rfps) {
      parsed.rfps = parsed.rfps.filter(rfp => {
        if (!rfp.dueDate || rfp.dueDate==="Unknown" || rfp.dueDate==="") return true;
        try { return new Date(rfp.dueDate) > new Date(); } catch { return true; }
      });
      parsed.rfps = parsed.rfps.map(r=>({ ...r, status:"Active" }));
    }

    parsed.searchedAt = new Date().toLocaleString();
    parsed.territories = TERRITORIES;
    setCache(cacheKey, parsed, CACHE_TTL_HOUR);
    res.json(parsed);

  } catch(e) {
    console.error(e);
    res.status(500).json({ error:e.message });
  }
});

// ── Debug ──
app.get("/debug/search", async (req, res) => {
  const query = req.query.q || "Sibley Memorial Hospital Washington DC";
  try {
    const results = await serpSearch(`${query} property management contact`);
    res.json({ query, count:results.length, results });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Health ──
app.get("/health", (req, res) => res.json({
  status:"ok", territories:TERRITORIES,
  apollo: !!process.env.APOLLO_API_KEY,
  today:TODAY(), time:new Date().toISOString()
}));

app.listen(PORT, () => console.log(`FireWatch server on port ${PORT} — ${TERRITORIES}`));
