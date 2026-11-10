const express = require("express");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = "https://pba-api01.actech2.com";

const CONFERENCES = [
  {
    id: "governors",
    name: "Season 50 Governors' Cup",
    slug: "pba-50th-season-governors-cup"
  },
  {
    id: "commissioners",
    name: "Season 50 Commissioner's Cup",
    slug: "pba-50th-season-commissioners-cup"
  }
];

const TEAMS = [
  { id: "BWB", code: "BWB", name: "Blackwater Bossing" },
  { id: "CON", code: "CON", name: "Converge FiberXers" },
  { id: "GIN", code: "GIN", name: "Barangay Ginebra San Miguel" },
  { id: "MAG", code: "MAG", name: "Magnolia Hotshots" },
  { id: "MER", code: "MER", name: "Meralco Bolts" },
  { id: "MGP", code: "MGP", name: "Macau Giant Pandas", guest: true },
  { id: "NLX", code: "NLX", name: "NLEX Road Warriors" },
  { id: "PHX", code: "PHX", name: "Phoenix Fuel Masters" },
  { id: "ROS", code: "ROS", name: "Rain or Shine Elasto Painters" },
  { id: "SMB", code: "SMB", name: "San Miguel Beermen" },
  { id: "TER", code: "TER", name: "Terrafirma Dyip" },
  { id: "TGR", code: "TGR", name: "Titan Ultra Giant Risers" },
  { id: "TNT", code: "TNT", name: "TNT Tropang 5G" }
];

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const cache = new Map();

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 TwoSports/2.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (!response.ok) {
      throw new Error(`Source returned HTTP ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function getPage(url) {
  const cached = cache.get(url);

  if (cached && Date.now() - cached.time < 60000) {
    return cached.html;
  }

  const html = await fetchText(url);
  cache.set(url, { html, time: Date.now() });

  return html;
}

function getConference(id) {
  return CONFERENCES.find(c => c.id === id);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseGames(html, conference) {
  const $ = cheerio.load(html);
  const games = new Map();

  $("a[href*='game_id=']").each((_, element) => {
    const href = $(element).attr("href") || "";
    const match = href.match(/[?&]game_id=(\d+)/);

    if (!match) return;

    const id = match[1];
    const url = new URL(href, BASE).toString();

    if (!games.has(id)) {
      games.set(id, {
        id,
        conference: conference.id,
        conferenceName: conference.name,
        url,
        label: cleanText($(element).text()) || `PBA Game ${id}`
      });
    }
  });

  return [...games.values()];
}

function normalizeHeader(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[%().]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function numberValue(value) {
  const text = cleanText(value);

  if (!text || text === "-" || text === "—") return null;

  const match = text.replace(/,/g, "").match(/-?\d+(\.\d+)?/);

  return match ? Number(match[0]) : null;
}

function findHeader(headers, candidates) {
  return headers.findIndex(header => candidates.includes(header));
}

function parseBoxScoreTables($) {
  const output = [];

  $("table").each((_, table) => {
    const rows = $(table).find("tr").toArray();

    if (rows.length < 2) return;

    let headerRowIndex = -1;
    let headers = [];

    for (let i = 0; i < Math.min(rows.length, 6); i++) {
      const cells = $(rows[i]).find("th,td").toArray();

      const current = cells.map(cell =>
        normalizeHeader($(cell).text())
      );

      const hasPlayer = current.some(h =>
        ["player", "name", "playername"].includes(h)
      );

      const hasStats = current.some(h =>
        ["pts", "point", "points", "reb", "rebounds", "ast", "assists"].includes(h)
      );

      if (hasPlayer && hasStats) {
        headerRowIndex = i;
        headers = current;
        break;
      }
    }

    if (headerRowIndex < 0) return;

    const playerIndex = findHeader(headers, [
      "player", "name", "playername"
    ]);

    const pointsIndex = findHeader(headers, [
      "pts", "point", "points"
    ]);

    const reboundsIndex = findHeader(headers, [
      "reb", "rebs", "rebound", "rebounds"
    ]);

    const assistsIndex = findHeader(headers, [
      "ast", "asts", "assist", "assists"
    ]);

    const minutesIndex = findHeader(headers, [
      "min", "mins", "minutes"
    ]);

    const stealsIndex = findHeader(headers, [
      "stl", "steals"
    ]);

    const blocksIndex = findHeader(headers, [
      "blk", "blocks"
    ]);

    const turnoversIndex = findHeader(headers, [
      "to", "tov", "turnovers"
    ]);

    const threesIndex = findHeader(headers, [
      "3pm", "3ptm", "threepointersmade"
    ]);

    const teamHeading = $(table)
      .closest("section,div")
      .find("h2,h3,h4")
      .first()
      .text()
      .trim();

    for (const row of rows.slice(headerRowIndex + 1)) {
      const cells = $(row).find("td,th").toArray();

      if (!cells.length) continue;

      const values = cells.map(cell =>
        cleanText($(cell).text())
      );

      const name = values[playerIndex];

      if (!name || /team totals|starters|bench/i.test(name)) {
        continue;
      }

      const points = numberValue(values[pointsIndex]);
      const rebounds = numberValue(values[reboundsIndex]);
      const assists = numberValue(values[assistsIndex]);

      if (points === null || rebounds === null || assists === null) {
        continue;
      }

      output.push({
        name,
        team: teamHeading || null,
        minutes: minutesIndex >= 0 ? values[minutesIndex] : null,
        points,
        rebounds,
        assists,
        steals: stealsIndex >= 0 ? numberValue(values[stealsIndex]) : null,
        blocks: blocksIndex >= 0 ? numberValue(values[blocksIndex]) : null,
        turnovers: turnoversIndex >= 0 ? numberValue(values[turnoversIndex]) : null,
        threePointersMade: threesIndex >= 0 ? numberValue(values[threesIndex]) : null
      });
    }
  });

  return output;
}

function extractGenericTables($) {
  const tables = [];

  $("table").each((_, table) => {
    const rows = [];

    $(table).find("tr").each((__, row) => {
      const cells = $(row).find("th,td").map((___, cell) =>
        cleanText($(cell).text())
      ).get();

      if (cells.length) rows.push(cells);
    });

    if (rows.length) tables.push(rows);
  });

  return tables;
}

async function getConferenceGames(conference) {
  const url = `${BASE}/tournaments/${conference.slug}`;
  const html = await getPage(url);

  return parseGames(html, conference);
}

async function getGameDetails(gameId, conference) {
  const url =
    `${BASE}/tournaments/${conference.slug}?game_id=${encodeURIComponent(gameId)}`;

  const html = await getPage(url);
  const $ = cheerio.load(html);

  const title =
    cleanText($("h1").first().text()) ||
    cleanText($("title").text()) ||
    `Game ${gameId}`;

  const bodyText = cleanText($("body").text());
  const players = parseBoxScoreTables($);
  const tables = extractGenericTables($);

  return {
    id: String(gameId),
    conference: conference.id,
    conferenceName: conference.name,
    title,
    text: bodyText.slice(0, 12000),
    tables,
    players,
    boxScoreAvailable: players.length > 0,
    sourceUrl: url
  };
}

/* YOUTUBE VIDEO FEED */

async function getOneSportsChannelId() {
  const cached = cache.get("onesports-channel-id");

  if (cached && Date.now() - cached.time < 86400000) {
    return cached.id;
  }

  const html = await fetchText(
    "https://www.youtube.com/@onesportsphl",
    15000
  );

  const patterns = [
    /"channelId":"(UC[a-zA-Z0-9_-]{20,})"/,
    /"externalId":"(UC[a-zA-Z0-9_-]{20,})"/,
    /\/channel\/(UC[a-zA-Z0-9_-]{20,})/
  ];

  let channelId = null;

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match) {
      channelId = match[1];
      break;
    }
  }

  if (!channelId) {
    throw new Error("Could not identify the One Sports YouTube channel.");
  }

  cache.set("onesports-channel-id", {
    id: channelId,
    time: Date.now()
  });

  return channelId;
}

function parseYouTubeFeed(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const videos = [];

  $("entry").each((_, entry) => {
    const title = cleanText($(entry).find("title").first().text());

    const videoId =
      cleanText($(entry).find("yt\\:videoId").first().text()) ||
      cleanText($(entry).find("videoId").first().text());

    const published = cleanText(
      $(entry).find("published").first().text()
    );

    const description = cleanText(
      $(entry).find("media\\:group media\\:description").text()
    );

    if (!videoId || !title) return;

    if (!/PBA|basketball|governors|commissioner|highlights/i.test(title)) {
      return;
    }

    videos.push({
      id: videoId,
      title,
      description,
      published,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      source: "One Sports Philippines"
    });
  });

  return videos;
}

async function getHighlights() {
  const cached = cache.get("pba-highlights");

  if (cached && Date.now() - cached.time < 300000) {
    return cached.videos;
  }

  const channelId = await getOneSportsChannelId();

  const feedUrl =
    `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;

  const xml = await fetchText(feedUrl, 15000);
  const videos = parseYouTubeFeed(xml);

  cache.set("pba-highlights", {
    videos,
    time: Date.now()
  });

  return videos;
}

/* ROUTES */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "Two Sports",
    time: new Date().toISOString()
  });
});

app.get("/api/pba/conferences", (req, res) => {
  res.json({
    conferences: CONFERENCES,
    current: CONFERENCES[0].id
  });
});

app.get("/api/pba/conferences/:id/games", async (req, res) => {
  const conference = getConference(req.params.id);

  if (!conference) {
    return res.status(404).json({ error: "Conference not found." });
  }

  try {
    const games = await getConferenceGames(conference);

    res.json({
      available: true,
      conference,
      games,
      count: games.length
    });
  } catch (error) {
    res.status(503).json({
      available: false,
      conference,
      games: [],
      error: "PBA games could not be retrieved.",
      detail: error.message
    });
  }
});

app.get("/api/pba/games/:id", async (req, res) => {
  const conference = getConference(
    req.query.conference || "governors"
  );

  if (!conference) {
    return res.status(404).json({ error: "Conference not found." });
  }

  try {
    const game = await getGameDetails(req.params.id, conference);

    res.json(game);
  } catch (error) {
    res.status(503).json({
      error: "Game details could not be retrieved.",
      detail: error.message
    });
  }
});

app.get("/api/pba/teams", (req, res) => {
  res.json({
    available: true,
    teams: TEAMS,
    count: TEAMS.length
  });
});

app.get("/api/pba/players/averages", async (req, res) => {
  const conference = getConference(
    req.query.conference || "governors"
  );

  if (!conference) {
    return res.status(404).json({ error: "Conference not found." });
  }

  try {
    const games = await getConferenceGames(conference);
    const totals = new Map();

    for (const game of games) {
      try {
        const details = await getGameDetails(game.id, conference);

        for (const player of details.players || []) {
          const key = player.name.toLowerCase();

          if (!totals.has(key)) {
            totals.set(key, {
              name: player.name,
              games: 0,
              points: 0,
              rebounds: 0,
              assists: 0,
              steals: 0,
              blocks: 0,
              turnovers: 0,
              stealsGames: 0,
              blocksGames: 0,
              turnoversGames: 0
            });
          }

          const item = totals.get(key);

          item.games++;
          item.points += player.points;
          item.rebounds += player.rebounds;
          item.assists += player.assists;

          if (player.steals !== null) {
            item.steals += player.steals;
            item.stealsGames++;
          }

          if (player.blocks !== null) {
            item.blocks += player.blocks;
            item.blocksGames++;
          }

          if (player.turnovers !== null) {
            item.turnovers += player.turnovers;
            item.turnoversGames++;
          }
        }
      } catch (error) {
        console.warn(`Skipping game ${game.id}:`, error.message);
      }
    }

    const players = [...totals.values()].map(player => ({
      id: player.name,
      name: player.name,
      games: player.games,
      conference: conference.name,
      averages: {
        points: +(player.points / player.games).toFixed(1),
        rebounds: +(player.rebounds / player.games).toFixed(1),
        assists: +(player.assists / player.games).toFixed(1),
        steals: player.stealsGames
          ? +(player.steals / player.stealsGames).toFixed(1)
          : null,
        blocks: player.blocksGames
          ? +(player.blocks / player.blocksGames).toFixed(1)
          : null,
        turnovers: player.turnoversGames
          ? +(player.turnovers / player.turnoversGames).toFixed(1)
          : null
      }
    }));

    res.json({
      available: players.length > 0,
      conference,
      players,
      count: players.length
    });
  } catch (error) {
    res.status(503).json({
      available: false,
      conference,
      players: [],
      error: "Conference averages could not be calculated.",
      detail: error.message
    });
  }
});

app.get("/api/pba/players", async (req, res) => {
  const conference = getConference(
    req.query.conference || "governors"
  );

  if (!conference) {
    return res.status(404).json({ error: "Conference not found." });
  }

  try {
    const games = await getConferenceGames(conference);
    const found = new Map();

    for (const game of games) {
      try {
        const details = await getGameDetails(game.id, conference);

        for (const player of details.players || []) {
          const key = player.name.toLowerCase();

          if (!found.has(key)) {
            found.set(key, {
              id: player.name,
              name: player.name,
              team: player.team || "",
              source: "Retrieved game box score"
            });
          }
        }
      } catch (error) {
        // Continue checking the other games.
      }
    }

    res.json({
      available: found.size > 0,
      players: [...found.values()],
      count: found.size
    });
  } catch (error) {
    res.status(503).json({
      available: false,
      players: [],
      error: "Players could not be retrieved.",
      detail: error.message
    });
  }
});

app.get("/api/pba/highlights", async (req, res) => {
  try {
    const videos = await getHighlights();

    res.json({
      available: videos.length > 0,
      highlights: videos,
      count: videos.length,
      source: "One Sports Philippines YouTube"
    });
  } catch (error) {
    res.status(503).json({
      available: false,
      highlights: [],
      error: "Official highlights could not be retrieved.",
      detail: error.message
    });
  }
});

app.get("/api/pba/playoffs", (req, res) => {
  res.json({
    available: false,
    bracket: null,
    message: "A verified playoff bracket feed is not connected."
  });
});

app.get("/api/test-pba", async (req, res) => {
  try {
    const conference = CONFERENCES[0];
    const games = await getConferenceGames(conference);

    res.json({
      ok: true,
      conference: conference.name,
      gamesFound: games.length,
      sample: games.slice(0, 5)
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/api/test-videos", async (req, res) => {
  try {
    const videos = await getHighlights();

    res.json({
      ok: true,
      count: videos.length,
      sample: videos.slice(0, 3)
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Two Sports running on port ${PORT}`);
});
