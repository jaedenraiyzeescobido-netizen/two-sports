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

async function fetchText(url, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TwoSports/1.0)",
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
    .replace(/\s+/g, " ")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function absoluteUrl(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return "";
  }
}

function parseGames(html, conference) {
  const $ = cheerio.load(html);
  const games = new Map();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href") || "";
    const match = href.match(/game_id=(\d+)/i);

    if (!match) return;

    const id = match[1];
    const container = $(element).closest(
      "tr, article, li, .game, .game-card, .match, .match-card"
    );

    const text = cleanText(
      container.length ? container.text() : $(element).text()
    );

    const headings = container.find("h1,h2,h3,h4,strong,b");
    const headingText = cleanText(headings.text());

    const combined = `${headingText} ${text}`;

    const scoreMatches = combined.match(/\b\d{1,3}\b/g) || [];

    games.set(id, {
      id,
      conference,
      title: headingText || cleanText($(element).text()) || `PBA Game ${id}`,
      text: combined,
      url: absoluteUrl(href, "https://www.pba.ph/"),
      scores: scoreMatches.slice(-2)
    });
  });

  return [...games.values()];
}

async function getGames(conferenceKey) {
  const conference = CONFERENCES[conferenceKey];

  if (!conference) {
    throw new Error("Invalid conference.");
  }

  const cacheKey = `games-${conferenceKey}`;
  const cached = getCache(cacheKey);

  if (cached) return cached;

  const url = `${PBA_API}/tournaments/${conference.slug}`;
  const html = await fetchText(url, 20000);
  const games = parseGames(html, conferenceKey);

  const result = {
    available: games.length > 0,
    conference: conference.name,
    games,
    updatedAt: new Date().toISOString()
  };

  setCache(cacheKey, result, 90);
  return result;
}

function normalizeHeader(value) {
  return cleanText(value)
    .replace(/\s+/g, " ")
    .replace(/%/g, "%")
    .toUpperCase();
}

function findHeaderRow($table, $) {
  let best = null;
  let bestScore = 0;

  $table.find("tr").each((_, row) => {
    const cells = $(row).find("th,td");
    const values = cells.map((_, cell) =>
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

  for (let i = 0; i < 5 && current.length; i++) {
    const previous = current.prevAll("h1,h2,h3,h4,h5,strong,b").first();

    if (previous.length) {
      const value = cleanText(previous.text());

      if (value.length > 2 && value.length < 80) {
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

  $("table").each((tableIndex, tableElement) => {
    const $table = $(tableElement);
    const headerRow = findHeaderRow($table, $);

    if (!headerRow) return;

    const columns = $(headerRow)
      .find("th,td")
      .map((_, cell) => cleanText($(cell).text()))
      .get();

    if (columns.length < 2) return;

    const normalized = columns.map(normalizeHeader);
    const playerIndex = normalized.findIndex(value =>
      /PLAYER|NAME/.test(value)
    );

    if (playerIndex === -1) return;

    const players = [];

    let foundHeader = false;

    $table.find("tr").each((_, row) => {
      if (row === headerRow) {
        foundHeader = true;
        return;
      }

      if (!foundHeader) return;

      const cells = $(row).find("th,td");

      if (!cells.length) return;

      const values = cells.map((_, cell) =>
        cleanText($(cell).text())
      ).get();

      if (values.length < 2) return;

      const playerName = values[playerIndex];

      if (!playerName) return;

      if (
        /TOTAL|TEAM TOTAL|PLAYER|STARTERS|BENCH/i.test(playerName)
      ) {
        return;
      }

      const stats = {};

      columns.forEach((column, index) => {
        stats[column || `Column ${index + 1}`] =
          values[index] ?? "";
      });

      players.push({
        name: playerName,
        stats
      });
    });

    if (!players.length) return;

    tables.push({
      team: extractTeamName($table, $),
      columns,
      players
    });
  });

  return tables;
}

function getGameIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("game_id");
  } catch {
    return null;
  }
}

async function getGameDetails(id) {
  const cacheKey = `details-${id}`;
  const cached = getCache(cacheKey);

  if (cached) return cached;

  const urls = [
    `https://www.pba.ph/playbyplay?game_id=${id}`,
    `${PBA_API}/games/${id}`
  ];

  let lastError = "Game details unavailable.";

  for (const url of urls) {
    try {
      const html = await fetchText(url, 18000);
      const boxScoreTables = parseBoxScoreTables(html);

      if (boxScoreTables.length) {
        const result = {
          available: true,
          id,
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

      lastError = "The page loaded, but no readable box-score tables were found.";
    } catch (error) {
      lastError = error.message;
    }
  }

  return {
    available: false,
    id,
    boxScoreAvailable: false,
    boxScoreTables: [],
    players: [],
    error: lastError
  };
}

/* ---------------- NEWS ---------------- */

function extractNewsFromHtml(html) {
  const $ = cheerio.load(html);
  const articles = new Map();

  function addArticle(article) {
    if (!article) return;

    const title = cleanText(article.title || article.name);
    const url = absoluteUrl(
      article.url || article.link || article.href,
      ONESPORTS_NEWS
    );

    if (!title || !url) return;

    const combined = `${title} ${article.category || ""} ${article.description || ""}`;

    if (!/pba|basketball|pb a news/i.test(combined)) return;

    if (!url.includes("onesports.ph")) return;

    articles.set(url, {
      title,
      url,
      date: article.date || article.published || "",
      image: article.image || article.thumbnail || "",
      category: article.category || "PBA"
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

        if (
          value.headline ||
          (value.name && (value.url || value.mainEntityOfPage))
        ) {
          const image =
            typeof value.image === "string"
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

    if (!title || title.length < 12) return;

    const card = $(element).closest(
      "article, li, .card, .post, .story, .news-item"
    );

    const context = cleanText(card.text());

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
      image: absoluteUrl(image, ONESPORTS_NEWS),
      category: context
    });
  });

  return [...articles.values()].slice(0, 40);
}

async function getNews() {
  const cached = getCache("onesports-news");
  if (cached) return cached;

  const html = await fetchText(ONESPORTS_NEWS, 20000);
  const articles = extractNewsFromHtml(html);

  const result = {
    available: articles.length > 0,
    source: ONESPORTS_NEWS,
    articles,
    message: articles.length
      ? ""
      : "One Sports loaded, but no PBA articles could be extracted. The site may load its articles dynamically.",
    updatedAt: new Date().toISOString()
  };

  setCache("onesports-news", result, 300);
  return result;
}

/* ---------------- YOUTUBE SHORTS-STYLE FEED ---------------- */

async function getYouTubeChannelId() {
  const cached = getCache("youtube-channel-id");
  if (cached) return cached;

  const html = await fetchText(ONESPORTS_CHANNEL, 15000);

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

async function getYouTubeVideos() {
  const cached = getCache("youtube-videos");
  if (cached) return cached;

  const channelId = await getYouTubeChannelId();

  const rssUrl =
    `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;

  const xml = await fetchText(rssUrl, 15000);

  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];

  const videos = entries.map(entry => {
    const id = (entry.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/) || [])[1] || "";
    const title = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    const published = (entry.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || "";

    const decodedTitle = cleanText(
      title.replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
    );

    return {
      id,
      title: decodedTitle,
      published,
      url: `https://www.youtube.com/watch?v=${id}`,
      embedUrl:
        `https://www.youtube.com/embed/${id}?playsinline=1&controls=1&rel=0&enablejsapi=1`,
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
    };
  }).filter(video =>
    video.id &&
    /pba|basketball|philippine basketball|governors cup|commissioners cup/i.test(video.title)
  );

  const result = {
    available: videos.length > 0,
    videos,
    source: ONESPORTS_CHANNEL,
    updatedAt: new Date().toISOString()
  };

  setCache("youtube-videos", result, 300);
  return result;
}

/* ---------------- API ROUTES ---------------- */

app.get("/api/pba/conferences", (req, res) => {
  res.json(CONFERENCES);
});

app.get("/api/pba/teams", (req, res) => {
  res.json({
    available: true,
    teams: TEAMS
  });
});

app.get("/api/pba/games", async (req, res) => {
  const conference = req.query.conference || "governors";

  try {
    const result = await getGames(conference);
    res.json(result);
  } catch (error) {
    res.status(502).json({
      available: false,
      games: [],
      error: error.message
    });
  }
});

app.get("/api/pba/games/:id", async (req, res) => {
  try {
    const result = await getGameDetails(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(502).json({
      available: false,
      error: error.message
    });
  }
});

app.get("/api/pba/news", async (req, res) => {
  try {
    res.json(await getNews());
  } catch (error) {
    res.status(502).json({
      available: false,
      articles: [],
      error: error.message,
      source: ONESPORTS_NEWS
    });
  }
});

app.get("/api/pba/highlights", async (req, res) => {
  try {
    res.json(await getYouTubeVideos());
  } catch (error) {
    res.status(502).json({
      available: false,
      videos: [],
      error: error.message
    });
  }
});

app.get("/api/pba/players", async (req, res) => {
  res.json({
    available: false,
    players: [],
    message: "The official PBA player directory source has not been verified. Player information is not fabricated."
  });
});

app.get("/api/pba/players/averages", (req, res) => {
  res.json({
    available: false,
    players: [],
    message: "Player averages are unavailable until verified box-score data can be retrieved."
  });
});

app.get("/api/pba/playoffs", (req, res) => {
  res.json({
    available: false,
    message: "A verified live playoff bracket source is not currently available."
  });
});

/* ---------------- DIAGNOSTICS ---------------- */

app.get("/api/test-pba", async (req, res) => {
  const results = {};

  for (const key of Object.keys(CONFERENCES)) {
    try {
      const result = await getGames(key);

      results[key] = {
        available: result.available,
        count: result.games.length
      };
    } catch (error) {
      results[key] = {
        available: false,
        error: error.message
      };
    }
  }

  res.json(results);
});

app.get("/api/test-news", async (req, res) => {
  try {
    const result = await getNews();

    res.json({
      available: result.available,
      count: result.articles.length,
      message: result.message || ""
    });
  } catch (error) {
    res.json({
      available: false,
      error: error.message
    });
  }
});

app.get("/api/test-videos", async (req, res) => {
  try {
    const result = await getYouTubeVideos();

    res.json({
      available: result.available,
      count: result.videos.length
    });
  } catch (error) {
    res.json({
      available: false,
      error: error.message
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    app: "Two Sports",
    time: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Two Sports running on port ${PORT}`);
});
