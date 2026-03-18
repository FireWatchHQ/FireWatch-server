import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "firewatch2026";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, "search_logs.json");

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

// ── Log helpers ──
function readLogs() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
  } catch { return []; }
}

function writeLog(entry) {
  try {
    const logs = readLogs();
    logs.unshift(entry); // newest first
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs.slice(0, 2000), null, 2)); // keep last 2000
  } catch(e) { console.error("Log write error:", e.message); }
}

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

// ── SerpApi ──
async function serpSearch(query, serpKey, num=10) {
  if (!serpKey) throw new Error("SerpApi key required");
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=${num}&api_key=${serpKey}&gl=us&hl=en`;
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error("SerpApi: " + d.error);
  return (d.organic_results||[]).map(i=>({ title:i.title, url:i.link, snippet:i.snippet||"" }));
}

// ── Apollo ──
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

// ── Gemini ──
async function geminiChat(messages, systemContext, geminiKey) {
  if (!geminiKey) throw new Error("Gemini API key required");
  const contents = messages.map(m => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.text }]
  }));
  const body = {
    system_instruction: { parts: [{ text: systemContext }] },
    contents,
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: 1500, temperature: 0.7 }
  };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
    { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) }
  );
  const d = await r.json();
  if (d.error) throw new Error("Gemini: " + d.error.message);
  return d.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("") || "No response.";
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
  const { query, forceRefresh, serpKey } = req.body;
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
    const searches = await Promise.allSettled([
      serpSearch(`${q} property management company contact Washington DC Arlington Alexandria`, serpKey),
      serpSearch(`${q} building engineer facilities director phone email`, serpKey),
      serpSearch(`${q} property manager chief engineer linkedin`, serpKey),
      serpSearch(`${q} property owner LLC Washington DC Virginia`, serpKey),
      serpSearch(`${q} building owner real estate`, serpKey),
      serpSearch(`${q} fire alarm sprinkler inspection vendor contractor`, serpKey),
      serpSearch(`${q} fire marshal inspection violation`, serpKey),
      serpSearch(`${q} building permit fire alarm sprinkler site:dcra.dc.gov OR site:pivs.dcra.dc.gov`, serpKey),
      serpSearch(`${q} permit fire sprinkler alarm site:arlingtonva.us OR site:permits.arlingtonva.us`, serpKey),
      serpSearch(`${q} permit fire sprinkler alarm site:alexandriava.gov OR site:aca.alexandriava.gov`, serpKey),
      serpSearch(`${q} fire marshal violation failed inspection DC Virginia`, serpKey),
      serpSearch(`${q} loopnet costar property details`, serpKey),
      serpSearch(`${q} tenants floors square feet building`, serpKey),
      serpSearch(`${q} Washington DC Arlington Alexandria building address contact`, serpKey),
    ]);

    const allSnippets = searches
      .filter(s=>s.status==="fulfilled")
      .flatMap(s=>s.value)
      .map(r=>`SOURCE: ${r.url}\nTITLE: ${r.title}\nSNIPPET: ${r.snippet}`)
      .join("\n\n");

    const [dcP, arP, alP, viol] = await Promise.allSettled([
      serpSearch(`"${q}" permit fire alarm sprinkler suppression DCRA Washington DC ${new Date().getFullYear()}`, serpKey),
      serpSearch(`"${q}" permit fire alarm sprinkler Arlington County Virginia ${new Date().getFullYear()}`, serpKey),
      serpSearch(`"${q}" permit fire alarm sprinkler Alexandria Virginia ${new Date().getFullYear()}`, serpKey),
      serpSearch(`"${q}" fire marshal violation citation inspection failed DC Virginia`, serpKey),
    ]);

    const permitSnippets = [dcP,arP,alP,viol]
      .filter(s=>s.status==="fulfilled")
      .flatMap(s=>s.value)
      .map(r=>`SOURCE: ${r.url}\nTITLE: ${r.title}\nSNIPPET: ${r.snippet}`)
      .join("\n\n");

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
  "propertyManagement": { "company": "or Unknown", "manager": "or Unknown", "managerPhone": "or Unknown", "managerEmail": "or Unknown", "managerTitle": "or Property Manager" },
  "engineering": { "chiefEngineer": "or Unknown", "engineerPhone": "or Unknown", "engineerEmail": "or Unknown", "engineerTitle": "or Chief Engineer" },
  "tenants": ["major tenants or residents"],
  "fireLifeSafety": { "currentProvider": "or Unknown", "contractStatus": "or Unknown", "contractExpirationEstimate": "or Unknown", "lastInspectionDate": "or Unknown", "systems": ["fire alarm","sprinkler","suppression","monitoring"] },
  "permits": { "openPermits": ["confirmed open permits with numbers and dates"], "recentPermits": ["recently closed permits"], "violations": ["confirmed violations with citation numbers and dates"] },
  "gpo": ["Vizient or Premier if applicable"],
  "salesNotes": "Best sales angle, urgency, who to call first, contract timing",
  "confidence": "High or Medium or Low",
  "sources": ["up to 8 real source URLs"],
  "verifyLinks": ["https://pivs.dcra.dc.gov/PIVS/search.aspx","https://fems.dc.gov/service/fire-safety-inspections","https://otr.cfo.dc.gov/page/real-property-tax-database-search","https://permits.arlingtonva.us/CitizenAccess/","https://fire.arlingtonva.us/fire-prevention/","https://aca.alexandriava.gov/CitizenAccess/","https://www.alexandriava.gov/fire/fire-prevention"]
}
Only use Unknown for unverified contacts. Never fabricate phones, emails, permit numbers, or violations.`;

    const raw = await claudeSynthesize(prompt);
    let parsed = extractJSON(raw) || {
      building:query, address:"Verify manually", type:"Commercial", region:"Washington DC",
      buildingSynopsis:"Could not extract data.", owner:{name:"Unknown",phone:"Unknown",email:"Unknown"},
      ownershipHistory:[], propertyManagement:{company:"Unknown",manager:"Unknown",managerPhone:"Unknown",managerEmail:"Unknown",managerTitle:"Property Manager"},
      engineering:{chiefEngineer:"Unknown",engineerPhone:"Unknown",engineerEmail:"Unknown",engineerTitle:"Chief Engineer"},
      tenants:[], fireLifeSafety:{currentProvider:"Unknown",contractStatus:"Unknown",contractExpirationEstimate:"Unknown",lastInspectionDate:"Unknown",systems:[]},
      permits:{openPermits:[],recentPermits:[],violations:[]}, gpo:[], salesNotes:"", confidence:"Low", sources:[],
      verifyLinks:["https://pivs.dcra.dc.gov/PIVS/search.aspx","https://fems.dc.gov/service/fire-safety-inspections","https://permits.arlingtonva.us/CitizenAccess/","https://aca.alexandriava.gov/CitizenAccess/"]
    };

    // Apollo enrichment
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

    // ── LOG THIS SEARCH ──
    writeLog({
      id: Date.now(),
      type: "property_search",
      timestamp: new Date().toISOString(),
      searchedAt: parsed.searchedAt,
      query,
      result: parsed
    });

    res.json(parsed);
  } catch(e) {
    console.error(e);
    res.status(500).json({ error:e.message });
  }
});

// ══════════════════════════════════════════
// POST /search/rfp
// ══════════════════════════════════════════
app.post("/search/rfp", async (req, res) => {
  const { forceRefresh, serpKey } = req.body || {};
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
      serpSearch(`SAM.gov fire alarm inspection sprinkler suppression solicitation "Washington DC" OR "Arlington" OR "Alexandria" active open ${year} ${nextYear}`, serpKey),
      serpSearch(`SAM.gov fire protection life safety inspection contract opportunity DC Virginia active ${year}`, serpKey),
      serpSearch(`"DC Office of Contracting" OR "ocp.dc.gov" fire alarm sprinkler suppression inspection RFP open active ${year}`, serpKey),
      serpSearch(`"Arlington County" procurement fire alarm sprinkler suppression inspection RFP solicitation ${year} ${nextYear}`, serpKey),
      serpSearch(`"City of Alexandria" procurement fire alarm sprinkler suppression inspection solicitation bid ${year} ${nextYear}`, serpKey),
      serpSearch(`site:sam.gov fire inspection "Washington DC" OR "Arlington VA" OR "Alexandria VA" ${year}`, serpKey),
      serpSearch(`fire alarm sprinkler suppression inspection contract bid solicitation "Washington DC" ${year} due`, serpKey),
    ]);

    const allSnippets = searches
      .filter(s=>s.status==="fulfilled")
      .flatMap(s=>s.value)
      .map(r=>`SOURCE: ${r.url}\nTITLE: ${r.title}\nSNIPPET: ${r.snippet}`)
      .join("\n\n");

    const prompt = `You are a government procurement expert for fire & life safety services.
Today: ${TODAY()} — Territory: ${TERRITORIES} ONLY
Extract ONLY active RFPs: fire alarm, sprinkler, suppression, or life safety inspection. Location: DC, Arlington VA, or Alexandria VA only. Due date AFTER ${TODAY()}.

SEARCH RESULTS:
${allSnippets}

Return ONLY this JSON:
{"rfps":[{"title":"","agency":"","source":"SAM.gov or DC Government or Arlington County or City of Alexandria","region":"","solicitationNumber":"","issueDate":"","dueDate":"must be future date","estimatedValue":"","description":"","services":[],"url":"","status":"Active","notes":""}],"summary":""}
Only confirmed future due dates. Never fabricate.`;

    const raw = await claudeSynthesize(prompt);
    let parsed = extractJSON(raw) || { rfps:[], summary:"No active RFPs found." };
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

// ══════════════════════════════════════════
// POST /chat/gemini — logs full conversation
// ══════════════════════════════════════════
app.post("/chat/gemini", async (req, res) => {
  const { messages, buildingContext, geminiKey } = req.body;
  if (!messages || !messages.length) return res.status(400).json({ error:"messages required" });
  try {
    const systemContext = `You are a fire & life safety sales intelligence assistant with access to Google Search.
You are helping research a commercial property in Washington DC, Arlington VA, or Alexandria VA.
KNOWN PROPERTY DATA:\n${buildingContext || "No prior data available."}
Find missing contacts, search permits, write outreach emails. Be direct and specific. Territory: Washington DC, Arlington VA, Alexandria VA.`;

    const reply = await geminiChat(messages, systemContext, geminiKey);

    // ── LOG GEMINI CONVERSATION ──
    writeLog({
      id: Date.now(),
      type: "gemini_chat",
      timestamp: new Date().toISOString(),
      building: buildingContext ? buildingContext.split("\n")[0].replace("Building: ","") : "Unknown",
      messages: messages,
      reply: reply
    });

    res.json({ reply });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
// GET /admin/logs — password protected
// ══════════════════════════════════════════
app.get("/admin/logs", (req, res) => {
  const pw = req.query.pw;
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error:"Unauthorized" });

  const logs = readLogs();
  const type = req.query.type; // optional filter: property_search or gemini_chat
  const filtered = type ? logs.filter(l => l.type === type) : logs;

  res.json({
    total: filtered.length,
    logs: filtered
  });
});

// GET /admin — HTML dashboard (password protected)
app.get("/admin", (req, res) => {
  const pw = req.query.pw;
  if (pw !== ADMIN_PASSWORD) {
    return res.send(`
      <html><body style="background:#0d0d0d;color:#e8e4dc;font-family:monospace;padding:40px;text-align:center">
        <h2 style="color:#E63025">FireWatch Admin</h2>
        <form method="GET">
          <input name="pw" type="password" placeholder="Admin password" style="padding:10px;font-size:16px;margin:10px;background:#111;color:#fff;border:1px solid #333;border-radius:3px"/>
          <button type="submit" style="padding:10px 20px;background:#E63025;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:16px">Enter</button>
        </form>
      </body></html>
    `);
  }

  const logs = readLogs();
  const searches = logs.filter(l => l.type === "property_search");
  const chats = logs.filter(l => l.type === "gemini_chat");

  const searchRows = searches.map(l => `
    <tr style="border-bottom:1px solid #2a2a2a">
      <td style="padding:10px;color:#888;white-space:nowrap">${l.searchedAt||l.timestamp}</td>
      <td style="padding:10px;font-weight:bold;color:#E63025">${l.query}</td>
      <td style="padding:10px;color:#5dda7a">${l.result?.building||"—"}</td>
      <td style="padding:10px;color:#6aadff">${l.result?.propertyManagement?.manager||"Unknown"}</td>
      <td style="padding:10px;color:#f4a44a">${l.result?.propertyManagement?.managerPhone||"—"}</td>
      <td style="padding:10px;color:#f4a44a">${l.result?.propertyManagement?.managerEmail||"—"}</td>
      <td style="padding:10px;color:#aaa">${l.result?.engineering?.chiefEngineer||"Unknown"}</td>
      <td style="padding:10px;color:#aaa">${l.result?.fireLifeSafety?.currentProvider||"Unknown"}</td>
      <td style="padding:10px"><span style="background:rgba(230,48,37,.15);color:#ff6b63;padding:2px 6px;border-radius:2px;font-size:11px">${l.result?.confidence||"?"}</span></td>
    </tr>
  `).join("");

  const chatRows = chats.map(l => {
    const qa = l.messages.map((m,i) => {
      const isUser = m.role === "user";
      const reply = i === l.messages.length - 1 ? l.reply : "";
      return `<div style="margin:6px 0;padding:8px 12px;background:${isUser?"rgba(230,48,37,.1)":"rgba(66,133,244,.08)"};border-radius:3px;border-left:3px solid ${isUser?"#E63025":"#4285f4"}">
        <span style="font-size:10px;color:${isUser?"#E63025":"#4285f4"};text-transform:uppercase;letter-spacing:1px">${isUser?"User":"Gemini"}</span>
        <div style="margin-top:4px;color:#e8e4dc;font-size:13px">${m.text}</div>
        ${reply?`<div style="margin-top:8px;padding:8px;background:rgba(66,133,244,.05);border-radius:2px;color:#ccc;font-size:12px;white-space:pre-wrap">${reply}</div>`:""}
      </div>`;
    }).join("");
    return `
      <tr style="border-bottom:1px solid #2a2a2a" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'table-row':'none';this.style.cursor='pointer'">
        <td style="padding:10px;color:#888;white-space:nowrap">${new Date(l.timestamp).toLocaleString()}</td>
        <td style="padding:10px;color:#5dda7a;font-weight:bold">${l.building||"Unknown"}</td>
        <td style="padding:10px;color:#aaa">${l.messages.length} messages</td>
        <td style="padding:10px;color:#4285f4">${l.messages[0]?.text?.slice(0,60)||""}...</td>
      </tr>
      <tr style="display:none"><td colspan="4" style="padding:16px;background:#0f0f0f">${qa}</td></tr>
    `;
  }).join("");

  res.send(`
    <html>
    <head><title>FireWatch Admin</title>
    <style>body{background:#0d0d0d;color:#e8e4dc;font-family:'Courier New',monospace;margin:0;padding:0}
    .topbar{background:#0a0a0a;border-bottom:2px solid #E63025;padding:16px 32px;display:flex;align-items:center;justify-content:space-between}
    h1{font-size:24px;letter-spacing:3px;text-transform:uppercase;margin:0}h1 span{color:#E63025}
    .content{padding:32px}.tab{display:inline-block;padding:10px 20px;cursor:pointer;font-family:monospace;font-size:12px;letter-spacing:2px;text-transform:uppercase;border:1px solid #2a2a2a;margin-right:8px;border-radius:2px}
    .tab.active{background:rgba(230,48,37,.1);border-color:#E63025;color:#E63025}.tab:hover{border-color:#555;color:#fff}
    table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:10px;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#666;border-bottom:2px solid #2a2a2a}
    tr:hover td{background:rgba(255,255,255,.02)}.stat{background:#141414;border:1px solid #2a2a2a;border-radius:3px;padding:20px 24px;display:inline-block;margin-right:16px;margin-bottom:16px}
    .stat-num{font-size:36px;font-weight:bold;color:#E63025}.stat-lbl{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#666;margin-top:4px}
    </style></head>
    <body>
    <div class="topbar"><h1>FIRE<span>WATCH</span> ADMIN</h1><span style="font-family:monospace;font-size:11px;color:#666">${new Date().toLocaleString()}</span></div>
    <div class="content">
      <div>
        <div class="stat"><div class="stat-num">${searches.length}</div><div class="stat-lbl">Property Searches</div></div>
        <div class="stat"><div class="stat-num" style="color:#4285f4">${chats.length}</div><div class="stat-lbl">Gemini Chats</div></div>
        <div class="stat"><div class="stat-num" style="color:#5dda7a">${new Set(searches.map(s=>s.query?.toLowerCase())).size}</div><div class="stat-lbl">Unique Queries</div></div>
      </div>

      <div style="margin:24px 0 16px">
        <span class="tab active" onclick="document.getElementById('searches').style.display='block';document.getElementById('chats').style.display='none';this.className='tab active';document.querySelectorAll('.tab')[1].className='tab'">📋 Property Searches (${searches.length})</span>
        <span class="tab" onclick="document.getElementById('chats').style.display='block';document.getElementById('searches').style.display='none';this.className='tab active';document.querySelectorAll('.tab')[0].className='tab'">🔵 Gemini Chats (${chats.length})</span>
        <a href="/admin/logs?pw=${pw}" style="float:right;color:#E63025;font-family:monospace;font-size:11px;text-decoration:none;padding:10px 16px;border:1px solid #E63025;border-radius:2px">⬇ Download JSON</a>
      </div>

      <div id="searches">
        <table>
          <thead><tr><th>Time</th><th>Query</th><th>Building Found</th><th>Manager</th><th>Manager Phone</th><th>Manager Email</th><th>Engineer</th><th>F&LS Provider</th><th>Confidence</th></tr></thead>
          <tbody>${searchRows||'<tr><td colspan="9" style="padding:30px;text-align:center;color:#444">No searches yet</td></tr>'}</tbody>
        </table>
      </div>

      <div id="chats" style="display:none">
        <p style="font-size:12px;color:#666;margin-bottom:12px">Click any row to expand the full conversation.</p>
        <table>
          <thead><tr><th>Time</th><th>Building</th><th>Messages</th><th>First Question</th></tr></thead>
          <tbody>${chatRows||'<tr><td colspan="4" style="padding:30px;text-align:center;color:#444">No chats yet</td></tr>'}</tbody>
        </table>
      </div>
    </div>
    </body></html>
  `);
});

// ── Debug ──
app.get("/debug/search", async (req, res) => {
  const query = req.query.q || "Sibley Memorial Hospital Washington DC";
  const serpKey = req.query.key || process.env.SERPAPI_KEY;
  try {
    const results = await serpSearch(`${query} property management contact`, serpKey);
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
