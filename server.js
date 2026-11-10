const express = require('express');
const path = require('path');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = 'https://pba-api01.actech2.com';

const TOURNAMENTS = [
  { name: "PBA 50th Season Governors' Cup", slug: 'pba-50th-season-governors-cup' },
  { name: "PBA 50th Season Commissioner's Cup", slug: 'pba-50th-season-commissioners-cup' }
];

app.use(express.static(path.join(__dirname, 'public')));

const clean = s => (s || '').replace(/\s+/g, ' ').trim();

async function getPage(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 TwoSportsFanApp/1.0',
      'Accept': 'text/html,application/xhtml+xml'
    },
    signal: AbortSignal.timeout(30000)
  });

  const html = await response.text();

  if (!response.ok) {
    throw new Error(`PBA source returned HTTP ${response.status}`);
  }

  return html;
}

function parseGames(html, tournament) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const games = [];

  $('a[href*="game_id="]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/[?&]game_id=(\d+)/);

    if (!match || seen.has(match[1])) return;

    seen.add(match[1]);

    let node = $(el);
    let context = '';

    for (let i = 0; i < 5 && node.length; i++, node = node.parent()) {
      context = clean(node.text());
      if (context.length > 20) break;
    }

    games.push({
      id: match[1],
      tournament: tournament.name,
      sourceUrl: `${BASE}/tournaments/${tournament.slug}?game_id=${match[1]}`,
      label: clean($(el).text()) || `Game ${match[1]}`,
      summary: context
    });
  });

  return games;
}

function parseGamePage(html, tournament, id) {
  const $ = cheerio.load(html);
  const pageText = clean($('body').text());
  const tables = [];

  $('table').each((_, table) => {
    const rows = [];

    $(table).find('tr').each((__, tr) => {
      const cells = $(tr)
        .find('th,td')
        .map((___, td) => clean($(td).text()))
        .get();

      if (cells.length) rows.push(cells);
    });

    if (rows.length) tables.push(rows);
  });

  const playByPlay = [];

  $('body *').each((_, el) => {
    if ($(el).children().length) return;

    const t = clean($(el).text());

    if (/^(P[1-4]|Q[1-4])\s+\d{1,2}:\d{2}/i.test(t) && t.length < 260) {
      playByPlay.push(t);
    }
  });

  return {
    id,
    tournament: tournament.name,
    sourceUrl: `${BASE}/tournaments/${tournament.slug}?game_id=${id}`,
    title: clean($('h1').first().text()) || tournament.name,
    text: pageText.slice(0, 18000),
    tables,
    playByPlay: [...new Set(playByPlay)].slice(0, 150)
  };
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'Two Sports',
    source: BASE
  });
});

app.get('/api/test-pba', async (_req, res) => {
  const url = `${BASE}/tournaments/${TOURNAMENTS[0].slug}`;

  try {
    const html = await getPage(url);

    res.json({
      connected: true,
      status: 200,
      pageLength: html.length,
      containsGames: html.includes('game_id=')
    });
  } catch (e) {
    res.json({
      connected: false,
      error: e.message
    });
  }
});

app.get('/api/pba/games', async (_req, res) => {
  const results = await Promise.allSettled(
    TOURNAMENTS.map(async t =>
      parseGames(await getPage(`${BASE}/tournaments/${t.slug}`), t)
    )
  );

  const games = results.flatMap(r =>
    r.status === 'fulfilled' ? r.value : []
  );

  const errors = results.flatMap((r, i) =>
    r.status === 'rejected'
      ? [{
          tournament: TOURNAMENTS[i].name,
          message: r.reason.message
        }]
      : []
  );

  res.set('Cache-Control', 'no-store');

  if (!games.length) {
    return res.status(502).json({
      error: 'No PBA games could be retrieved.',
      errors
    });
  }

  res.json({
    updatedAt: new Date().toISOString(),
    games,
    errors
  });
});

app.get('/api/pba/games/:id', async (req, res) => {
  const id = String(req.params.id).replace(/\D/g, '');

  if (!id) {
    return res.status(400).json({ error: 'Invalid game id' });
  }

  const results = await Promise.allSettled(
    TOURNAMENTS.map(async t => {
      const html = await getPage(
        `${BASE}/tournaments/${t.slug}?game_id=${id}`
      );

      return /Game Details|Competition|Box Score/i.test(html)
        ? parseGamePage(html, t, id)
        : null;
    })
  );

  const found = results.find(
    r => r.status === 'fulfilled' && r.value
  );

  if (!found) {
    return res.status(404).json({
      error: 'Game details were not found.'
    });
  }

  res.set('Cache-Control', 'no-store');
  res.json(found.value);
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Two Sports listening on ${PORT}`);
});
