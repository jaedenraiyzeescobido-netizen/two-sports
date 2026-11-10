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

async function getPage(url) {
  const cached = cache.get(url);

  if (cached && Date.now() - cached.time < 60000) {
    return cached.html;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 TwoSports/1.0",
        "Accept": "text/html,application/xhtml+xml"
      }
    });

    if (!response.ok) {
      throw new Error(`Source returned HTTP ${response.status}`);
    }

    const html = await response.text();
    cache.set(url, { html, time: Date.now() });
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

function getConference(id) {
  return CONFERENCES.find(c => c.id === id);
}

function parseGames(html, conference) {
  const $ = cheerio.load(html);
  const games = new Map();

  $("a[href*='game_id=']").each((_, element) => {
    const href = $(element).attr("href") || "";
    const match = href.match(/game_id=(\d+)/);

    if (!match) return;

    const id = match[1];
    const url = new URL(href, BASE).toString();
    const label = $(element).text().replace(/\s+/g, " ").trim();

    if (!games.has(id)) {
      games.set(id, {
        id,
        conference: conference.id,
        conferenceName: conference.name,
        url,
        label
      });
    }
  });

  return [...games.values()];
}

function parseNumber(value) {
  const number = Number(String(value || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function parseBoxScoreTables($) {
  const players = [];

  $("table").each((_, table) => {
    const rows = $(table).find("tr").toArray();
    if (!rows.length) return;

    const headers = $(rows[0])
      .find("th,td")
      .map((__, cell) => $(cell).text().trim().toLowerCase())
      .get();

    const playerIndex = headers.findIndex(h => h === "player");
    const pointsIndex = headers.findIndex(h => h === "pts");
    const reboundsIndex = headers.findIndex(h => h === "reb");
    const assistsIndex = headers.findIndex(h => h === "ast");

    if (
      playerIndex < 0 ||
      pointsIndex < 0 ||
      reboundsIndex < 0 ||
      assistsIndex < 0
    ) return;

    for (const row of rows.slice(1)) {
      const cells = $(row).find("td").toArray();
      if (!cells.length) continue;

      const values = cells.map(cell => $(cell).text().trim());
      const name = values[playerIndex];

      if (!name || /team totals|starters|bench/i.test(name)) continue;

      const points = parseNumber(values[pointsIndex]);
      const rebounds = parseNumber(values[reboundsIndex]);
      const assists = parseNumber(values[assistsIndex]);

      if (points === null || rebounds === null || assists === null) continue;

      players.push({
        name,
        points,
        rebounds,
        assists,
        minutes: values[headers.findIndex(h => h === "mins")] || null,
        steals: parseNumber(values[headers.findIndex(h => h === "stl")]),
        blocks: parseNumber(values[headers.findIndex(h => h === "blk")]),
        turnovers: parseNumber(values[headers.findIndex(h => h === "to")])
      });
    }
  });

  return players;
}

async function getConferenceGames(conference) {
  const url = `${BASE}/tournaments/${conference.slug}`;
  const html = await getPage(url);
  return parseGames(html, conference);
}

async function getGameDetails(gameId, conference) {
  const url = `${BASE}/tournaments/${conference.slug}?game_id=${encodeURIComponent(gameId)}`;
  const html = await getPage(url);
  const $ = cheerio.load(html);

  const title = $("h1").first().text().trim() ||
    $("title").text().trim() ||
    `Game ${gameId}`;

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  const teams = [];
  const codes = bodyText.match(/\b(BWB|CON|GIN|MAG|MER|MGP|NLX|PHX|ROS|SMB|TER|TGR|TNT)\b/g) || [];

  for (const code of codes) {
    if (!teams.includes(code)) teams.push(code);
  }

  return {
    id: String(gameId),
    conference: conference.id,
    conferenceName: conference.name,
    title,
    text: bodyText,
    teams,
    players: parseBoxScoreTables($),
    sourceUrl: url
  };
}

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
  const conference = getConference(req.query.conference || "governors");

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
    count: TEAMS.length,
    note: "Team directory. Official logo images are not included until verified image sources are available."
  });
});

/*
 * Conference averages are calculated from actual player rows
 * in the source's completed-game box scores.
 */
app.get("/api/pba/players/averages", async (req, res) => {
  const conference = getConference(req.query.conference || "governors");

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
        // Skip a game whose box score is unavailable.
      }
    }

    const players = [...totals.values()].map(player => ({
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
      count: players.length,
      note: "Averages use only retrieved box scores. Players or games missing from the source may be absent."
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

app.get("/api/pba/players", (req, res) => {
  res.json({
    available: false,
    players: [],
    message: "A complete verified player directory is not available from the connected source yet. Use the conference averages endpoint for players found in retrieved box scores."
  });
});

app.get("/api/pba/highlights", (req, res) => {
  res.json({
    available: false,
    highlights: [],
    message: "No verified highlight feed is connected."
  });
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

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Two Sports running on port ${PORT}`);
});
