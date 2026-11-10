const express = require("express");
const path = require("path");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = "https://pba-api01.actech2.com";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const TOURNAMENTS = [
  {
    id: "governors-2026",
    name: "PBA 50th Season Governors' Cup",
    slug: "pba-50th-season-governors-cup",
    season: "Season 50"
  },
  {
    id: "commissioners-2026",
    name: "PBA 50th Season Commissioner's Cup",
    slug: "pba-50th-season-commissioners-cup",
    season: "Season 50"
  }
];

const CACHE = new Map();
const CACHE_TIME = 60 * 1000;

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cacheGet(key) {
  const item = CACHE.get(key);
  if (!item || Date.now() - item.time > CACHE_TIME) return null;
  return item.value;
}

function cacheSet(key, value) {
  CACHE.set(key, { value, time: Date.now() });
}

async function getPage(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 TwoSports/2.0",
      "Accept": "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error("PBA source returned HTTP " + response.status);
  }

  return response.text();
}

function getTournament(id) {
  return TOURNAMENTS.find(t => t.id === id || t.slug === id);
}

function extractTeamNames($, element) {
  const node = $(element);
  const candidates = [];

  for (let i = 0; i < 5 && node.length; i++) {
    candidates.push(clean(node.text()));
    if (candidates[candidates.length - 1].length > 250) break;
    node = node.parent();
  }

  return candidates;
}

function parseGames(html, tournament) {
  const $ = cheerio.load(html);
  const games = [];
  const seen = new Set();

  $('a[href*="game_id="]').each((_, element) => {
    const href = $(element).attr("href") || "";
    const match = href.match(/[?&]game_id=(\d+)/);

    if (!match) return;

    const id = match[1];
    if (seen.has(id)) return;
    seen.add(id);

    let parent = $(element);
    let context = "";

    for (let i = 0; i < 6 && parent.length; i++) {
      context = clean(parent.text());
      if (context.length > 30 && context.length < 1200) break;
      parent = parent.parent();
    }

    const label = clean($(element).text());

    games.push({
      id,
      conferenceId: tournament.id,
      conference: tournament.name,
      season: tournament.season,
      label,
      summary: context,
      sourceUrl:
        `${BASE}/tournaments/${tournament.slug}?game_id=${id}`
    });
  });

  return games;
}

function parseGameDetails(html, tournament, id) {
  const $ = cheerio.load(html);

  const title = clean($("h1").first().text());
  const pageText = clean($("body").text());

  const tables = [];

  $("table").each((_, table) => {
    const rows = [];

    $(table).find("tr").each((__, row) => {
      const cells = $(row)
        .find("th,td")
        .map((___, cell) => clean($(cell).text()))
        .get();

      if (cells.length) rows.push(cells);
    });

    if (rows.length) tables.push(rows);
  });

  const headings = $("h1,h2,h3")
    .map((_, el) => clean($(el).text()))
    .get()
    .filter(Boolean);

  const images = $("img")
    .map((_, el) => ({
      alt: clean($(el).attr("alt")),
      src: $(el).attr("src") || ""
    }))
    .get()
    .filter(x => x.src);

  return {
    id,
    conferenceId: tournament.id,
    conference: tournament.name,
    title,
    headings,
    text: pageText.slice(0, 25000),
    tables,
    images,
    sourceUrl:
      `${BASE}/tournaments/${tournament.slug}?game_id=${id}`
  };
}

async function getTournamentGames(tournament) {
  const key = "games:" + tournament.id;
  const cached = cacheGet(key);
  if (cached) return cached;

  const html = await getPage(
    `${BASE}/tournaments/${tournament.slug}`
  );

  const games = parseGames(html, tournament);
  cacheSet(key, games);
  return games;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Two Sports",
    source: BASE,
    configuredConferences: TOURNAMENTS.length
  });
});

app.get("/api/pba/conferences", (_req, res) => {
  res.json({
    conferences: TOURNAMENTS.map(t => ({
      id: t.id,
      name: t.name,
      season: t.season
    }))
  });
});

app.get("/api/pba/conferences/:id/games", async (req, res) => {
  const tournament = getTournament(req.params.id);

  if (!tournament) {
    return res.status(404).json({
      error: "Conference not configured."
    });
  }

  try {
    const games = await getTournamentGames(tournament);

    res.set("Cache-Control", "no-store");

    res.json({
      conference: tournament.name,
      games,
      count: games.length,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(502).json({
      error: "Could not retrieve conference games.",
      details: error.message
    });
  }
});

app.get("/api/pba/games", async (_req, res) => {
  const results = await Promise.allSettled(
    TOURNAMENTS.map(getTournamentGames)
  );

  const games = results.flatMap(result =>
    result.status === "fulfilled" ? result.value : []
  );

  const errors = results
    .filter(result => result.status === "rejected")
    .map(result => result.reason.message);

  if (!games.length) {
    return res.status(502).json({
      error: "No PBA games could be retrieved.",
      errors
    });
  }

  res.set("Cache-Control", "no-store");

  res.json({
    games,
    count: games.length,
    errors,
    updatedAt: new Date().toISOString()
  });
});

app.get("/api/pba/games/:id", async (req, res) => {
  const id = String(req.params.id).replace(/\D/g, "");

  if (!id) {
    return res.status(400).json({
      error: "Invalid game ID."
    });
  }

  const selected = req.query.conference
    ? [getTournament(req.query.conference)].filter(Boolean)
    : TOURNAMENTS;

  const results = await Promise.allSettled(
    selected.map(async tournament => {
      const html = await getPage(
        `${BASE}/tournaments/${tournament.slug}?game_id=${id}`
      );

      if (!html.includes(id)) return null;

      return parseGameDetails(html, tournament, id);
    })
  );

  const found = results.find(
    result => result.status === "fulfilled" && result.value
  );

  if (!found) {
    return res.status(404).json({
      error: "Game details could not be found."
    });
  }

  res.json(found.value);
});

app.get("/api/pba/players", async (_req, res) => {
  res.json({
    players: [],
    available: false,
    message:
      "A verified PBA roster and player-statistics feed has not been connected."
  });
});

app.get("/api/pba/teams", (_req, res) => {
  res.json({
    teams: [],
    available: false,
    message:
      "Team profile and official logo data must be connected before being displayed."
  });
});

app.get("/api/pba/highlights", (_req, res) => {
  res.json({
    highlights: [],
    available: false,
    message:
      "No verified highlight-video feed is connected."
  });
});

app.get("/api/pba/playoffs", (_req, res) => {
  res.json({
    available: false,
    message:
      "An official playoff bracket feed has not been connected."
  });
});

app.get("/api/test-pba", async (_req, res) => {
  try {
    const html = await getPage(
      `${BASE}/tournaments/${TOURNAMENTS[0].slug}`
    );

    res.json({
      connected: true,
      pageLength: html.length,
      containsGameLinks: html.includes("game_id=")
    });
  } catch (error) {
    res.status(502).json({
      connected: false,
      error: error.message
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Two Sports listening on " + PORT);
});
