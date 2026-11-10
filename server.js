const express = require("express");
const path = require("path");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = "https://pba-api01.actech2.com";

const TOURNAMENTS = [
{
name: "PBA 50th Season Governors' Cup",
slug: "pba-50th-season-governors-cup"
},
{
name: "PBA 50th Season Commissioner's Cup",
slug: "pba-50th-season-commissioner-s-cup"
}
];

app.use(express.static(path.join(__dirname, "public")));

let gamesCache = {
data: null,
updatedAt: 0
};

const CACHE_DURATION = 30000;

async function getPage(url) {
const response = await fetch(url, {
headers: {
"User-Agent": "Mozilla/5.0 TwoSports/1.0",
"Accept": "text/html,application/xhtml+xml"
},
signal: AbortSignal.timeout(20000)
});

if (!response.ok) {
throw new Error("PBA source returned ${response.status}");
}

return await response.text();
}

function clean(value) {
return (value || "").replace(/\s+/g, " ").trim();
}

function parseGames(html, tournament) {
const $ = cheerio.load(html);
const seen = new Set();
const games = [];

$('a[href*="game_id="]').each((_, element) => {
const href = $(element).attr("href") || "";
const match = href.match(/[?&]game_id=(\d+)/);

if (!match || seen.has(match[1])) return;

seen.add(match[1]);

const id = match[1];
const text = clean($(element).text());
const parentText = clean($(element).parent().text());
const surrounding = clean(
  $(element).parent().parent().text()
);

const combined = [
  text,
  parentText,
  surrounding
].filter(Boolean).join(" · ");

const teams = combined.match(
  /\b([A-Z]{2,4})\s+(\d+)\s+(Final|Q[1-4]|OT|upcoming|live)?\s*([A-Z]{2,4})\s+(\d+)?/i
);

games.push({
  id,
  tournament: tournament.name,
  sourceUrl:
    `${BASE}/tournaments/${tournament.slug}?game_id=${id}`,
  label: text || combined || `Game ${id}`,
  summary: combined,
  status: teams?.[3] || "details",
  homeCode: teams?.[1] || null,
  homeScore: teams?.[2]
    ? Number(teams[2])
    : null,
  awayCode: teams?.[4] || null,
  awayScore: teams?.[5]
    ? Number(teams[5])
    : null
});

});

return games;
}

function parseGamePage(html, tournament, id) {
const $ = cheerio.load(html);

const pageText = clean($("body").text());
const title =
clean($("h1").first().text()) || tournament.name;

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

const boxScoreTables = tables.filter(rows =>
rows.some(row =>
row.some(cell => /PLAYER/i.test(cell))
) &&
rows.some(row =>
row.some(cell => /^PTS$/i.test(cell))
)
);

const playByPlay = [];

$("body *").each((_, element) => {
if ($(element).children().length) return;

const text = clean($(element).text());

if (/^P[1-4]\s+\d{1,2}:\d{2}/.test(text)) {
  if (text.length < 260) {
    playByPlay.push(text);
  }
}

});

const teams = [];

const codeMatches = [
...pageText.matchAll(
/\b(GIN|SMB|TNT|MER|MAG|ROS|CON|NLEX|NLX|PHX|BLA|BWB|TER|NOR|TGR|MGP)\b/g
)
];

for (const match of codeMatches) {
if (!teams.includes(match[1])) {
teams.push(match[1]);
}
}

return {
id,
tournament: tournament.name,
sourceUrl:
"${BASE}/tournaments/${tournament.slug}?game_id=${id}",
title,
text: pageText.slice(0, 18000),
tables: boxScoreTables,
playByPlay: [...new Set(playByPlay)].slice(0, 100),
teams
};
}

app.get("/api/health", (_req, res) => {
res.json({
ok: true,
service: "Two Sports",
source: BASE
});
});

app.get("/api/pba/games", async (_req, res) => {
try {
if (
gamesCache.data &&
Date.now() - gamesCache.updatedAt < CACHE_DURATION
) {
return res.json(gamesCache.data);
}

const results = await Promise.allSettled(
  TOURNAMENTS.map(async tournament => {
    const url =
      `${BASE}/tournaments/${tournament.slug}`;

    const html = await getPage(url);

    return parseGames(html, tournament);
  })
);

const games = [];
const errors = [];

results.forEach((result, index) => {
  if (result.status === "fulfilled") {
    games.push(...result.value);
  } else {
    errors.push({
      tournament: TOURNAMENTS[index].name,
      message: result.reason.message
    });
  }
});

const responseData = {
  updatedAt: new Date().toISOString(),
  games,
  errors
};

if (games.length > 0) {
  gamesCache = {
    data: responseData,
    updatedAt: Date.now()
  };
}

res.set("Cache-Control", "public, max-age=15");

if (games.length === 0) {
  return res.status(502).json({
    error: "No PBA games could be retrieved.",
    errors
  });
}

res.json(responseData);

} catch (error) {
res.status(502).json({
error: "Could not retrieve PBA games.",
detail: error.message
});
}
});

app.get("/api/pba/games/:id", async (req, res) => {
const id = String(req.params.id).replace(/\D/g, "");

if (!id) {
return res.status(400).json({
error: "Invalid game ID"
});
}

const results = await Promise.allSettled(
TOURNAMENTS.map(async tournament => {
const url =
"${BASE}/tournaments/${tournament.slug}?game_id=${id}";

  const html = await getPage(url);

  return parseGamePage(html, tournament, id);
})

);

for (const result of results) {
if (result.status !== "fulfilled") continue;

const game = result.value;

if (
  game.text ||
  game.tables.length ||
  game.playByPlay.length
) {
  res.set("Cache-Control", "public, max-age=8");
  return res.json(game);
}

}

res.status(404).json({
error: "Game details could not be found."
});
});

app.get("*", (_req, res) => {
res.sendFile(
path.join(__dirname, "public", "index.html")
);
});
app.get("/api/test-pba", async (req, res) => {
  const url = "https://pba-api01.actech2.com/tournaments/pba-50th-season-governors-cup";

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000)
    });

    const html = await response.text();

    res.json({
      connected: true,
      status: response.status,
      pageLength: html.length,
      containsGames: html.includes("game_id=")
    });
  } catch (error) {
    res.json({
      connected: false,
      error: error.message
    });
  }
});
app.listen(PORT, "0.0.0.0", () => {
console.log("Two Sports listening on port ${PORT}");
});
