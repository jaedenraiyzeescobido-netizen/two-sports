const express = require("express");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const PBA_API = "https://pba-api01.actech2.com";
const ONESPORTS_NEWS = "https://www.onesports.ph/news/";
const ONESPORTS_CHANNEL = "https://www.youtube.com/@onesportsphl";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const cache = new Map();

const TEAMS = [
  "Barangay Ginebra San Miguel",
  "San Miguel Beermen",
  "TNT Tropang Giga",
  "Meralco Bolts",
  "Magnolia Chicken Timplados",
  "Rain or Shine Elasto Painters",
  "Phoenix Fuel Masters",
  "NLEX Road Warriors",
  "Converge FiberXers",
  "NorthPort Batang Pier",
  "Terrafirma Dyip",
  "Blackwater Bossing"
];

const CONFERENCES = {
  governors: {
    name: "Governors' Cup",
    slug: "pba-50th-season-governors-cup"
  },
  commissioners: {
    name: "Commissioner's Cup",
    slug: "pba-50th-season-commissioners-cup"
  }
};

function getCache(key) {
  const item = cache.get(key);

  if (!item || Date.now() > item.expires) {
    cache.delete(key);
    return null;
  }

  return item.data;
}

function setCache(key, data, seconds = 120) {
  cache.set(key, {
    data,
    expires: Date.now() + seconds * 1000
  });
}

async function fetchText(url, timeout = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept": "text/html,application/json,application/xml,*/*"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return "";
  }
}

function validConference(key) {
  return Object.prototype.hasOwnProperty.call(CONFERENCES, key);
}

/* ---------------- GAMES ---------------- */

function findTeamNames(text) {
  const lower = String(text || "").toLowerCase();

  return TEAMS.filter(team =>
    lower.includes(team.toLowerCase())
  );
}

function parseGames(html, conferenceKey) {
  const $ = cheerio.load(html);
  const games = new Map();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href") || "";
    const match = href.match(/game_id=(\d+)/i);

    if (!match) return;

    const id = match[1];

    let container = $(element).closest(
      "tr, article, li, .game, .game-card, .match, .match-card"
    );

    if (!container.length) {
      container = $(element).parent();
    }

    const text = cleanText(container.text());
    const title = cleanText($(element).text());
    const combined = `${title} ${text}`;
    const teams = findTeamNames(combined);

    const scores = combined.match(/\b\d{1,3}\b/g) || [];

    games.set(id, {
      id,
      conference: conferenceKey,
      conferenceName: CONFERENCES[conferenceKey].name,
      title: title || `PBA Game ${id}`,
      text: combined,
      teams,
      scores: scores.slice(-2),
      url: absoluteUrl(href, "https://www.pba.ph/")
    });
  });

  return [...games.values()];
}

async function getGames(conferenceKey) {
  if (!validConference(conferenceKey)) {
    throw new Error("Invalid conference.");
  }

  const cacheKey = `games-${conferenceKey}`;
  const cached = getCache(cacheKey);

  if (cached) return cached;

  const conference = CONFERENCES[conferenceKey];
  const url = `${PBA_API}/tournaments/${conference.slug}`;

  const html = await fetchText(url, 25000);
  const games = parseGames(html, conferenceKey);

  const result = {
    available: games.length > 0,
    conference: conference.name,
    conferenceKey,
    games,
    updatedAt: new Date().toISOString(),
    message: games.length
      ? ""
      : "The tournament page loaded, but no game records could be extracted."
  };

  setCache(cacheKey, result, 90);
  return result;
}

/* ---------------- BOX SCORES ---------------- */

function normalizeHeader(value) {
  return cleanText(value).toUpperCase();
}

function findHeaderRow($table, $) {
  let best = null;
  let bestScore = 0;

  $table.find("tr").each((_, row) => {
    const values = $(row).find("th,td").map((_, cell) =>
      normalizeHeader($(cell).text())
    ).get();

    const hasPlayer = values.some(value =>
      /PLAYER|NAME/.test(value)
    );

    const statCount = values.filter(value =>
      /PTS|REB|AST|FG|FT|3P|STL|BLK|TO|PF|MIN|PLUS|OR|DR/.test(value)
    ).length;

    const score = (hasPlayer ? 10 : 0) + statCount;

    if (hasPlayer && score > bestScore) {
      best = row;
      bestScore = score;
    }
  });

  return best;
}

function extractTeamName($table, $) {
  let current = $table;

  for (let i = 0; i < 6 && current.length; i++) {
    const heading = current.prevAll(
      "h1,h2,h3,h4,h5,strong,b"
    ).first();

    if (heading.length) {
      const value = cleanText(heading.text());

      if (value.length > 2 && value.length < 100) {
        return value;
      }
    }

    current = current.parent();
  }

  return "";
}

function parseBoxScoreTables(html) {
  const $ = cheerio.load(html);
  const tables = [];

  $("table").each((_, tableElement) => {
    const $table = $(tableElement);
    const headerRow = findHeaderRow($table, $);

    if (!headerRow) return;

    const columns = $(headerRow).find("th,td").map((_, cell) =>
      cleanText($(cell).text())
    ).get();

    const normalized = columns.map(normalizeHeader);
    const playerIndex = normalized.findIndex(value =>
      /PLAYER|NAME/.test(value)
    );

    if (playerIndex < 0) return;

    const players = [];
    let afterHeader = false;

    $table.find("tr").each((_, row) => {
      if (row === headerRow) {
        afterHeader = true;
        return;
      }

      if (!afterHeader) return;

      const values = $(row).find("th,td").map((_, cell) =>
        cleanText($(cell).text())
      ).get();

      if (values.length < 2) return;

      const name = values[playerIndex];

      if (!name || /TOTAL|STARTERS|BENCH|PLAYER/i.test(name)) {
        return;
      }

      const stats = {};

      columns.forEach((column, index) => {
        stats[column || `Column ${index + 1}`] =
          values[index] || "";
      });

      players.push({
        name,
        stats
      });
    });

    if (players.length) {
      tables.push({
        team: extractTeamName($table, $),
        columns,
        players
      });
    }
  });

  return tables;
}

async function getGameDetails(id, conferenceKey) {
  if (!/^\d+$/.test(String(id))) {
    throw new Error("Invalid game ID.");
  }

  if (!validConference(conferenceKey)) {
    throw new Error("A valid conference is required.");
  }

  const cacheKey = `details-${conferenceKey}-${id}`;
  const cached = getCache(cacheKey);

  if (cached) return cached;

  const conference = CONFERENCES[conferenceKey];

  // The game ID is queried against the selected tournament.
  const urls = [
    `${PBA_API}/tournaments/${conference.slug}?game_id=${encodeURIComponent(id)}`,
    `https://www.pba.ph/playbyplay?game_id=${encodeURIComponent(id)}`
  ];

  let lastError = "No readable box score was found.";

  for (const url of urls) {
    try {
      const html = await fetchText(url, 22000);
      const boxScoreTables = parseBoxScoreTables(html);

      if (boxScoreTables.length) {
        const result = {
          available: true,
          id,
          conference: conferenceKey,
          conferenceName: conference.name,
          boxScoreAvailable: true,
          boxScoreTables,
          players: boxScoreTables.flatMap(table =>
            table.players.map(player => ({
              ...player,
              team: table.team
            }))
          ),
          updatedAt: new Date().toISOString()
        };

        setCache(cacheKey, result, 120);
        return result;
      }

      lastError =
        "The page loaded, but no readable box-score table was present.";
    } catch (error) {
      lastError = error.message;
    }
  }

  return {
    available: false,
    id,
    conference: conferenceKey,
    conferenceName: conference.name,
    boxScoreAvailable: false,
    boxScoreTables: [],
    players: [],
    error: lastError
  };
}

/* ---------------- PLAYERS ---------------- */

async function getPlayers(conferenceKey) {
  if (!validConference(conferenceKey)) {
    throw new Error("Invalid conference.");
  }

  const cacheKey = `players-${conferenceKey}`;
  const cached = getCache(cacheKey);

  if (cached) return cached;

  const gameData = await getGames(conferenceKey);
  const players = new Map();

  // Only use players actually found in retrieved box scores.
  for (const game of gameData.games.slice(0, 30)) {
    try {
      const details = await getGameDetails(game.id, conferenceKey);

      for (const player of details.players || []) {
        const key = `${player.name.toLowerCase()}-${player.team || ""}`;

        if (!players.has(key)) {
          players.set(key, {
            name: player.name,
            team: player.team || "",
            stats: player.stats || {},
            conference: conferenceKey,
            gameIds: [game.id]
          });
        } else {
          const existing = players.get(key);

          if (!existing.gameIds.includes(game.id)) {
            existing.gameIds.push(game.id);
          }
        }
      }
    } catch (error) {
      console.log(`Player extraction skipped for game ${game.id}: ${error.message}`);
    }
  }

  const result = {
    available: players.size > 0,
    conference: conferenceKey,
    players: [...players.values()],
    message: players.size
      ? ""
      : "No player names could be extracted from the available box scores."
  };

  setCache(cacheKey, result, 180);
  return result;
}

/* ---------------- NEWS ---------------- */

function extractNewsFromHtml(html) {
  const $ = cheerio.load(html);
  const articles = new Map();

  function addArticle(article) {
    const title = cleanText(article.title || article.name);
    const url = absoluteUrl(
      article.url || article.link || article.href,
      ONESPORTS_NEWS
    );

    if (!title || !url || !url.includes("onesports.ph")) return;

    const combined = [
      title,
      article.category || "",
      article.description || ""
    ].join(" ");

    if (!/\bpba\b|basketball|philippine basketball/i.test(combined)) {
      return;
    }

    articles.set(url, {
      title,
      url,
      date: article.date || "",
      image: absoluteUrl(article.image || "", ONESPORTS_NEWS),
      category: "PBA"
    });
  }

  $("script[type='application/ld+json']").each((_, script) => {
    try {
      const data = JSON.parse($(script).html() || "{}");

      function walk(value) {
        if (!value || typeof value !== "object") return;

        if (Array.isArray(value)) {
          value.forEach(walk);
          return;
        }

        if (value.headline || value.name) {
          const image = typeof value.image === "string"
            ? value.image
            : value.image?.url || "";

          addArticle({
            title: value.headline || value.name,
            url: value.url || value.mainEntityOfPage?.["@id"],
            date: value.datePublished || "",
            image,
            description: value.description || ""
          });
        }

        Object.values(value).forEach(walk);
      }

      walk(data);
    } catch {}
  });

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href") || "";
    const title = cleanText($(element).text());

    if (title.length < 12) return;

    const card = $(element).closest(
      "article, li, .card, .post, .story, .news-item"
    );

    const image =
      card.find("img").first().attr("src") ||
      card.find("img").first().attr("data-src") ||
      "";

    const date =
      card.find("time").first().attr("datetime") ||
      cleanText(card.find("time").first().text());

    addArticle({
      title,
      url: href,
      date,
      image,
      description: cleanText(card.text())
    });
  });

  return [...articles.values()].slice(0, 40);
}

async function getNews() {
  const cached = getCache("onesports-news");
  if (cached) return cached;

  const html = await fetchText(ONESPORTS_NEWS, 22000);
  const articles = extractNewsFromHtml(html);

  const result = {
    available: articles.length > 0,
    source: ONESPORTS_NEWS,
    articles,
    message: articles.length
      ? ""
      : "The One Sports page loaded, but no PBA articles could be extracted.",
    updatedAt: new Date().toISOString()
  };

  setCache("onesports-news", result, 300);
  return result;
}

/* ---------------- YOUTUBE VIDEOS ---------------- */

async function getYouTubeChannelId() {
  const cached = getCache("youtube-channel-id");
  if (cached) return cached;

  const html = await fetchText(ONESPORTS_CHANNEL, 18000);

  const patterns = [
    /"channelId":"(UC[a-zA-Z0-9_-]+)"/,
    /"externalId":"(UC[a-zA-Z0-9_-]+)"/,
    /channel_id=([^"&]+)/,
    /youtube\.com\/channel\/(UC[a-zA-Z0-9_-]+)/
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match) {
      setCache("youtube-channel-id", match[1], 86400);
      return match[1];
    }
  }

  throw new Error("Could not identify the One Sports YouTube channel.");
}

function decodeXml(value) {
  return cleanText(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function getYouTubeVideos() {
  const cached = getCache("youtube-videos");
  if (cached) return cached;

  const channelId = await getYouTubeChannelId();

  const rssUrl =
    `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;

  const xml = await fetchText(rssUrl, 18000);
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];

  const videos = entries.map(entry => {
    const id = (entry.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/) || [])[1] || "";
    const title = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    const published = (entry.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || "";

    return {
      id: decodeXml(id),
      title: decodeXml(title),
      published: decodeXml(published),
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
      embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(id)}?playsinline=1&controls=1&rel=0`,
      thumbnail: `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`
    };
  }).filter(video => {
    if (!video.id) return false;

    const title = video.title.toLowerCase();

    const isPBA =
      /pba|philippine basketball|governors cup|commissioners cup/.test(title);

    const isLikelyFullBroadcast =
      /full game|full replay|live stream|full match|game replay|complete game|whole game|watch live/.test(title);

    return isPBA && !isLikelyFullBroadcast;
  });

  const result = {
    available: videos.length > 0,
    videos,
    source: ONESPORTS_CHANNEL,
    updatedAt: new Date().toISOString(),
    message: videos.length
      ? ""
      : "No matching PBA clips were found in the recent One Sports uploads."
  };

  setCache("youtube-videos", result, 300);
  return result;
}

/* ---------------- API ROUTES ---------------- */

app.get("/api
