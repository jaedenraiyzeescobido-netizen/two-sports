const express = require("express");
const path = require("path");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = "https://pba-api01.actech2.com";

const TOURNAMENTS = [
  {
    name: "PBA 50th Season Governors' Cup",
    slug: "pba-50th-season-commissioner-s-cup"
  },
  {
    name: "PBA 50th Season Commissioner's Cup",
    slug: "pba-50th-season-commissioner-s-cup"
  }
];

app.use(express.static(path.join(__dirname, "public")));

async function getPage(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "TwoSportsFanApp/1.0 (public scoreboard viewer)",
      "Accept": "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`PBA source returned ${response.status}`);
  }

  return await response.text();
}

function clean(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function parseGames(html, tournament) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const games = [];

  $('a[href*="game_id="]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const match = href.match(/[?&]game_id=(\d+)/);

    if (!match || seen.has(match[1])) return;

    seen.add(match[1]);

    const id = match[1];
    const text = clean($(el).text());
    const parentText = clean($(el).parent().text());
    const surrounding = clean($(el).parent().parent().text());

    const combined = [text, parentText, surrounding]
      .filter(Boolean)
      .join(" · ");

    const teams = combined.match(
      /\b([A-Z]{2,4})\s+(\d+)\s+(Final|Q[1-4]|OT|upcoming|live)?\s*([A-Z]{2,4})\s+(\d+)?/i
    );

    games.push({
      id,
      tournament: tournament.name,
      sourceUrl: `${BASE}/tournaments/${tournament.slug}?game_id=${id}`,
      label: text || combined || `Game ${id}`,
      summary: combined,
      status: teams?.[3] || "details",
      homeCode: teams?.[1] || null,
      homeScore: teams?.[2] ? Number(teams[2]) : null,
      awayCode: teams?.[4] || null,
      awayScore: teams?.[5] ? Number(teams[5]) : null
    });
  });

  return games;
}

function parseGamePage(html, tournament, id) {
  const $ = cheerio.load(html);
  const pageText = clean($("body").text());
  const title = clean($("h1").first().text()) || tournament.name;

  const tables = [];

  $("table").each((_, table) => {
    const rows = [];

    $(table).find("tr").each((__, tr) => {
      const cells = $(tr)
        .find("th,td")
        .map((___, td) => clean($(td).text()))
        .get();

      if (cells.length) rows.push(cells);
    });

    if (rows.length) tables.push(rows);
  });

  const boxScoreTables = tables.filter(rows =>
    rows.some(r => r.some(c => /PLAYER/i.test(c))) &&
    rows.some(r => r.some(c => /^PTS$/i.test(c)))
  );

  const playByPlay = [];

  $("body *").each((_, el) => {
    if ($(el).children().length) return;

    const text = clean($(el).text());

    if (/^P[1-4]\s+\d{1,2}:\d{2}/.test(text)) {
      if (text.length < 260) playByPlay.push(text);
    }
  });

  const teams = [];

  const codeMatches = [
    ...pageText.matchAll(
      /\b(GIN|SMB|TNT|MER|MAG|ROS|CON|NLEX|NLX|PHX|BLA|BWB|TER|NOR|TGR|MGP)\b/g
    )
  ];

  for (const m of codeMatches) {
    if (!teams.includes(m[1])) teams.push(m[1]);
  }

  return {
    id,
    tournament: tournament.name,
    sourceUrl: `${BASE}/tournaments/${tournament.slug}?game_id=${id}`,
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
    source: BASE
  });
});

app.get("/api/pba/games", async (_req, res) => {
  try {
    const results = await Promise.all(
      TOURNAMENTS.map(async tournament => {
        const html = await getPage(
          `${BASE}/tournaments/${tournament.slug}`
        );

        return parseGames(html, tournament);
      })
    );

    const games = results.flat();

    res.set("Cache-Control", "public, max-age=15");

    res.json({
      updatedAt: new Date().toISOString(),
      games
    });

  } catch (error) {
    res.status(502).json({
      error: "Could not retrieve the public PBA scoreboard right now.",
      detail: error.message
    });
  }
});

app.get("/api/pba/games/:id", async (req, res) => {
  try {
    const id = String(req.params.id).replace(/\D/g, "");

    if (!id) {
      return res.status(400).json({
        error: "Invalid game id"
      });
    }

    let found = null;

    for (const tournament of TOURNAMENTS) {
      try {
        const html = await getPage(
          `${BASE}/tournaments/${tournament.slug}?game_id=${id}`
        );

        if (/Game Details|Competition|Box Score/i.test(html)) {
          found = parseGamePage(html, tournament, id);
          break;
        }
      } catch (_) {}
    }

    if (!found) {
      return res.status(404).json({
        error: "Game details were not found."
      });
    }

    res.set("Cache-Control", "public, max-age=8");
    res.json(found);

  } catch (error) {
    res.status(502).json({
      error: "Could not load game details.",
      detail: error.message
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Two Sports listening on ${PORT}`);
});
