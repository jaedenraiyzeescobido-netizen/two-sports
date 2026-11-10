require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API = "https://api.statsradar.io/v1";
const KEY = process.env.STATSRADAR_KEY;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

let cachedLeagueId = null;
let leagueCacheAt = 0;

async function statsRadar(pathname) {
  if (!KEY) throw new Error("StatsRadar API key is not configured.");

  const response = await fetch(API + pathname, {
    headers: {
      Authorization: `Bearer ${KEY}`,
      Accept: "application/json"
    }
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`StatsRadar error: ${response.status}`);
  }

  return body.data;
}

async function getPbaLeagueId() {
  if (cachedLeagueId && Date.now() - leagueCacheAt < 3600000) {
    return cachedLeagueId;
  }

  const leagues = await statsRadar("/leagues");
  const pba = (leagues || []).find(x =>
    String(x.name).toLowerCase().includes("pba")
  );

  if (!pba) throw new Error("PBA league not found.");

  cachedLeagueId = pba.leagueId;
  leagueCacheAt = Date.now();

  return cachedLeagueId;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, providerConfigured: !!KEY });
});

app.get("/api/pba/matches", async (req, res) => {
  try {
    const leagueId = await getPbaLeagueId();
    const now = new Date();

    const from = req.query.from ||
      new Date(now.getTime() - 3 * 86400000).toISOString();

    const until = req.query.until ||
      new Date(now.getTime() + 4 * 86400000).toISOString();

    const data = await statsRadar(
      `/leagues/${encodeURIComponent(leagueId)}/matches?from=${encodeURIComponent(from)}&until=${encodeURIComponent(until)}`
    );

    res.json({ data });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/pba/teams", async (req, res) => {
  try {
    const leagueId = await getPbaLeagueId();
    res.json({
      data: await statsRadar(`/leagues/${encodeURIComponent(leagueId)}/teams`)
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/pba/matches/:matchId", async (req, res) => {
  try {
    res.json({
      data: await statsRadar(`/matches/${encodeURIComponent(req.params.matchId)}`)
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Two Sports running on port ${PORT}`);
});
