const express = require("express");
const path = require("path");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = "https://pba-api01.actech2.com";
const REFRESH_INTERVAL = 60 * 1000;
const REQUEST_TIMEOUT = 15000;

app.use(express.static(path.join(__dirname, "public")));

const clean = value =>
  String(value || "").replace(/\s+/g, " ").trim();

const DEFAULT_CONFERENCES = [
  {
    id: "governors-cup",
    name: "Season 50 Governors' Cup",
    slug: "pba-50th-season-governors-cup",
    season: "Season 50"
  },
  {
    id: "commissioners-cup",
    name: "Season 50 Commissioner's Cup",
    slug: "pba-50th-season-commissioners-cup",
    season: "Season 50"
  }
];

// Optional future conferences can be configured in Render
// using the PBA_TOURNAMENTS environment variable.
// Format: name|slug|season,name|slug|season
function loadConferences() {
  const configured = process.env.PBA_TOURNAMENTS;

  if (!configured) return DEFAULT_CONFERENCES;

  const parsed = configured.split(",").map((entry, index) => {
    const [name, slug, season] = entry.split("|").map(clean);

    if (!name || !slug) return null;

    return {
      id: slug,
      name,
      slug,
      season: season || "PBA Season"
    };
  }).filter(Boolean);

  return parsed.length ? parsed : DEFAULT_CONFERENCES;
}

const CONFERENCES = loadConferences();

const cache = {
  games: {},
  details: {},
  lastUpdated: {},
  errors: {}
};

async function getPage(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 TwoSports/2.0",
      "Accept": "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT)
  });

  if (!response.ok) {
    throw new Error(`PBA source returned HTTP ${response.status}`);
  }

  return response.text();
}

function parseGames(html, conference) {
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

    let node = $(element);
    let summary = "";

    for (let i = 0; i < 6 && node.length; i++) {
      summary = clean(node.text());

      if (summary.length > 20) break;

      node = node.parent();
    }

    games.push({
      id,
      conferenceId: conference.id,
      conference: conference.name,
      season: conference.season,
      label: clean($(element).text()) || `Game ${id}`,
      summary,
      sourceUrl:
        `${BASE}/tournaments/${conference.slug}?game_id=${id}`
    });
  });

  return games;
}

function parseGameDetails(html, conference, id) {
  const $ = cheerio.load(html);

  const tables = [];

  $("table").each((_, table) => {
    const rows = [];

    $(table).find("tr").each((__, row) => {
      const cells = $(row)
        .find("th, td")
        .map((___, cell) => clean($(cell).text()))
        .get();

      if (cells.length) rows.push(cells);
    });

    if (rows.length) tables.push(rows);
  });

  const playByPlay = [];

  $("body *").each((_, element) => {
    if ($(element).children().length) return;

    const value = clean($(element).text());

    if (
      /^(P[1-4]|Q[1-4])\s+\d{1,2}:\d{2}/i.test(value) &&
      value.length < 260
    ) {
      playByPlay.push(value);
    }
  });

  return {
    id,
    conferenceId: conference.id,
    conference: conference.name,
    season: conference.season,
    title: clean($("h1").first().text()) || `Game ${id}`,
    sourceUrl:
      `${BASE}/tournaments/${conference.slug}?game_id=${id}`,
    pageText: clean($("body").text()).slice(0, 18000),
    boxScoreTables: tables,
    playByPlay: [...new Set(playByPlay)].slice(0, 200),
    updatedAt: new Date().toISOString()
  };
}

function findConference(id) {
  return CONFERENCES.find(conference =>
    conference.id === id || conference.slug === id
  );
}

async function refreshConference(conference) {
  try {
    const url = `${BASE}/tournaments/${conference.slug}`;
    const html = await getPage(url);
    const games = parseGames(html, conference);

    cache.games[conference.id] = games;
    cache.lastUpdated[conference.id] = new Date().toISOString();
    cache.errors[conference.id] = null;

    return {
      conference: conference.name,
      games,
      updatedAt: cache.lastUpdated[conference.id],
      error: null
    };
  } catch (error) {
    cache.errors[conference.id] = error.message;

    return {
      conference: conference.name,
      games: cache.games[conference.id] || [],
      updatedAt: cache.lastUpdated[conference.id] || null,
      error: error.message
    };
  }
}

async function refreshAllConferences() {
  await Promise.all(
    CONFERENCES.map(conference => refreshConference(conference))
  );
}

function startRefreshLoop() {
  refreshAllConferences().catch(error => {
    console.error("Initial PBA refresh failed:", error.message);
  });

  setInterval(() => {
    refreshAllConferences().catch(error => {
      console.error("PBA refresh failed:", error.message);
    });
  }, REFRESH_INTERVAL);
}

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Two Sports",
    source: BASE,
    refreshIntervalSeconds: REFRESH_INTERVAL / 1000,
    conferenceCount: CONFERENCES.length
  });
});

// Conference directory
app.get("/api/pba/conferences", (_req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    conferences: CONFERENCES.map(conference => ({
      ...conference,
      updatedAt: cache.lastUpdated[conference.id] || null,
      error: cache.errors[conference.id] || null
    }))
  });
});

// Current conference.
// Uses the most recently configured conference with available games.
// This is a fallback, not guaranteed official active-conference detection.
app.get("/api/pba/conferences/current", (_req, res) => {
  const available = CONFERENCES.filter(conference =>
    (cache.games[conference.id] || []).length > 0
  );

  const current = available[0] || CONFERENCES[0] || null;

  res.set("Cache-Control", "no-store");

  res.json({
    conference: current,
    detection: "latest-configured-conference-with-data",
    automaticOfficialDetection: false
  });
});

// All games from all configured conferences
app.get("/api/pba/games", async (_req, res) => {
  const results = await Promise.all(
    CONFERENCES.map(async conference => {
      if (!cache.lastUpdated[conference.id]) {
        return refreshConference(conference);
      }

      return {
        conference: conference.name,
        games: cache.games[conference.id] || [],
        updatedAt: cache.lastUpdated[conference.id],
        error: cache.errors[conference.id] || null
      };
    })
  );

  const games = results.flatMap(result => result.games || []);
  const errors = results
    .filter(result => result.error)
    .map(result => ({
      conference: result.conference,
      message: result.error
    }));

  res.set("Cache-Control", "no-store");

  if (!games.length) {
    return res.status(502).json({
      error: "No PBA games could be retrieved.",
      errors
    });
  }

  res.json({
    updatedAt: new Date().toISOString(),
    games,
    errors
  });
});

// Games from one conference
app.get("/api/pba/conferences/:conferenceId/games", async (req, res) => {
  const conference = findConference(req.params.conferenceId);

  if (!conference) {
    return res.status(404).json({
      error: "Conference not found."
    });
  }

  const result = await refreshConference(conference);

  res.set("Cache-Control", "no-store");

  if (!result.games.length) {
    return res.status(502).json({
      error: "No games could be retrieved for this conference.",
      conference: conference.name,
      details: result.error
    });
  }

  res.json(result);
});

// Refresh a conference manually
app.post("/api/pba/conferences/:conferenceId/refresh", async (req, res) => {
  const conference = findConference(req.params.conferenceId);

  if (!conference) {
    return res.status(404).json({
      error: "Conference not found."
    });
  }

  const result = await refreshConference(conference);

  res.set("Cache-Control", "no-store");
  res.json(result);
});

// Game details, box score tables and play-by-play
app.get("/api/pba/games/:id", async (req, res) => {
  const id = String(req.params.id).replace(/\D/g, "");

  if (!id) {
    return res.status(400).json({
      error: "Invalid game ID."
    });
  }

  const requestedConference = req.query.conference;
  const conferences = requestedConference
    ? [findConference(requestedConference)].filter(Boolean)
    : CONFERENCES;

  if (!conferences.length) {
    return res.status(404).json({
      error: "Conference not found."
    });
  }

  const errors = [];

  for (const conference of conferences) {
    const cacheKey = `${conference.id}:${id}`;
    const cached = cache.details[cacheKey];

    if (
      cached &&
      Date.now() - new Date(cached.updatedAt).getTime() < REFRESH_INTERVAL
    ) {
      return res.json(cached);
    }

    try {
      const url =
        `${BASE}/tournaments/${conference.slug}?game_id=${id}`;

      const html = await getPage(url);

      if (!/Game Details|Competition|Box Score|Play By Play/i.test(html)) {
        continue;
      }

      const details = parseGameDetails(html, conference, id);
      cache.details[cacheKey] = details;

      res.set("Cache-Control", "no-store");
      return res.json(details);
    } catch (error) {
      errors.push({
        conference: conference.name,
        message: error.message
      });
    }
  }

  res.status(404).json({
    error: "Game details could not be found.",
    errors
  });
});

// Diagnostic endpoint
app.get("/api/test-pba", async (_req, res) => {
  const results = await Promise.all(
    CONFERENCES.map(async conference => {
      try {
        const html = await getPage(
          `${BASE}/tournaments/${conference.slug}`
        );

        return {
          conference: conference.name,
          connected: true,
          pageLength: html.length,
          containsGameLinks: html.includes("game_id=")
        };
      } catch (error) {
        return {
          conference: conference.name,
          connected: false,
          error: error.message
        };
      }
    })
  );

  res.json({
    source: BASE,
    results
  });
});

// Frontend
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Two Sports listening on port ${PORT}`);
  startRefreshLoop();
});
