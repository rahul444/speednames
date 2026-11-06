const express = require('express');
const os = require('os');
const QRCode = require('qrcode');
const {
  createGame, resetGameByToken, getGameById, getGameByToken,
  setRevealed, turnNext, takeShot,
  timerStart, timerPause, timerReset, timerCurrentRemaining,
  DEFAULT_TURN_SECONDS
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
// Set BIND_HOST=127.0.0.1 when running behind a same-host reverse proxy or
// Cloudflare Tunnel so the application port is not reachable from the network.
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';

// Trust a loopback reverse proxy (e.g. cloudflared / nginx on the same host) so
// req.protocol reflects the original scheme via X-Forwarded-Proto.
app.set('trust proxy', 'loopback');

// Shareable board/spymaster links are derived from the incoming request (Host +
// scheme), which "just works" behind Cloudflare Tunnel or any reverse proxy. Set
// BASE_URL only to force a canonical origin, e.g. https://speednames.example.com.
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/static', express.static(__dirname + '/public'));

const TEAM_LABEL = { A: 'Team A', B: 'Team B', NEUTRAL: 'Neutral', ASSASSIN: 'Assassin' };

// ---------- Helpers ----------
function layout(title, body) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>${body}</body>
</html>`;
}

// Escape untrusted text (e.g. player-supplied words) before putting it in HTML.
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function localIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

// Public origin for shareable links + QR codes. Prefers an explicit BASE_URL,
// otherwise derives from the request (works behind Cloudflare Tunnel / any proxy).
// When the page is opened on the host machine itself (localhost), substitute the
// LAN IP so other devices on the wifi can actually reach the link.
function publicOrigin(req) {
  if (BASE_URL) return BASE_URL;
  const host = req.get('host') || `localhost:${PORT}`;
  const hostname = host.split(':')[0];
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    const ip = localIPs()[0];
    if (ip) return `http://${ip}:${PORT}`;
  }
  return `${req.protocol}://${host}`;
}
function absoluteUrl(req, path) {
  return publicOrigin(req) + path;
}

async function qrDataUrl(text) {
  try {
    return await QRCode.toDataURL(text, { margin: 1, width: 160 });
  } catch {
    return null;
  }
}

// End state (UI only): a team wins when all its tiles are revealed; revealing
// the assassin ends the game immediately.
function outcome(game) {
  const assassinIdx = game.colors.indexOf('ASSASSIN');
  if (assassinIdx >= 0 && game.revealed[assassinIdx]) {
    // The team whose turn it was tapped the assassin, so they lose.
    const loser = game.activeTeam;
    return { over: true, assassin: true, winner: loser === 'A' ? 'B' : 'A', loser };
  }
  for (const team of ['A', 'B']) {
    const idxs = game.colors.map((c, i) => (c === team ? i : -1)).filter(i => i >= 0);
    if (idxs.length && idxs.every(i => game.revealed[i])) {
      return { over: true, assassin: false, winner: team, loser: team === 'A' ? 'B' : 'A' };
    }
  }
  return { over: false, assassin: false, winner: null, loser: null };
}

// Banner shown on the board + spymaster views: whose turn it is, or the end state.
// Kept in sync with bannerInfo() in public/client.js.
function bannerInfo(game) {
  const o = outcome(game);
  const drink = o.over ? `🥃 Everyone on Team ${o.loser} takes a shot` : '';
  if (o.over && o.assassin) {
    return { text: `💀 Assassin! Team ${o.loser} loses`, drink, cls: 'phase-banner ended assassin' };
  }
  if (o.over) {
    return { text: `🎉 TEAM ${o.winner} WINS!`, drink, cls: `phase-banner ended team-${o.winner.toLowerCase()}` };
  }
  return { text: `TEAM ${game.activeTeam}'S TURN`, drink, cls: `phase-banner team-${game.activeTeam.toLowerCase()}` };
}

function bannerHtml(b) {
  return b.text + (b.drink ? `<span class="banner-drink">${b.drink}</span>` : '');
}

function statusLine(game) {
  const revealed = game.revealed.filter(Boolean).length;
  return revealed > 0 ? `In play — ${revealed}/25 revealed` : 'Ready — 0/25 revealed';
}

function notFoundPage() {
  return layout('Speednames — Game not found', `
    <div class="wrap narrow">
      <h1>Game not found</h1>
      <p class="sub">That link is invalid or the game no longer exists. <a href="/">Create a new game</a>.</p>
    </div>`);
}

// ---------- Create-game (home) page ----------
app.get('/', (req, res) => {
  const body = `
    <div class="wrap narrow">
      <h1>Speednames</h1>
      <p class="sub">A fast party variant of Codenames. Create a game, then share the links — each game is private to whoever holds its link.</p>
      <div class="card">
        <form method="POST" action="/new" class="setup-form">
          <label>Turn timer (seconds)</label>
          <input type="number" name="turnSeconds" value="${DEFAULT_TURN_SECONDS}" min="5">
          <button type="submit" class="btn">Create Game</button>
        </form>
      </div>
      <div class="card how-to">
        <h2>How to play</h2>
        <ol>
          <li><strong>Set up.</strong> Split into two teams (Team A and Team B), each with one spymaster. Create a game, put the <em>board link</em> on a TV or shared screen, and give the <em>spymaster link</em> only to the two spymasters.</li>
          <li><strong>Give a clue.</strong> On your team's turn, your spymaster says one word and a number, e.g. "Ocean, 2", pointing to that many of your team's words on the board.</li>
          <li><strong>Guess.</strong> Guessers tap words on the board. You can keep guessing up to the number given, plus one extra. Your turn ends if you tap a neutral word or the other team's word.</li>
          <li><strong>Beat the clock.</strong> Each turn is timed. When time runs out or your team is done, hit <em>Next Turn</em>.</li>
          <li><strong>Win.</strong> The first team to reveal all of its words wins. Tap the <span class="assassin-word">assassin</span> and your team loses on the spot.</li>
        </ol>
        <div class="how-to-note">
          <p><span aria-hidden="true">🥃</span>&nbsp; <strong>Drinking rules:</strong></p>
          <ul>
            <li><strong>Spymaster shot:</strong> only the spymaster drinks. Adds one minute to the timer, so they can think longer about a clue. No extra guesses.</li>
            <li><strong>Guessers' shot:</strong> two people on the guessing team each take a shot. Adds one minute <em>and</em> one extra guess. Can be taken any time during your turn, and repeated for more guesses.</li>
            <li><strong>Wrong guess:</strong> whoever tapped it drinks. Neutral word = 2 sips, the other team's word = 5 sips, the assassin = finish your drink.</li>
            <li><strong>Losing team:</strong> when the game ends, everyone on the losing team takes a shot (including a loss by assassin).</li>
          </ul>
        </div>
      </div>
    </div>`;
  res.send(layout('Speednames', body));
});

app.post('/new', (req, res) => {
  const turnSeconds = parseInt(req.body.turnSeconds, 10) || DEFAULT_TURN_SECONDS;
  const { spymasterToken } = createGame(turnSeconds);
  res.redirect(`/game/${spymasterToken}`);
});

// ---------- Share hub (keyed by the secret token; never shows colors) ----------
app.get('/game/:token', async (req, res) => {
  const game = getGameByToken(req.params.token);
  if (!game) return res.status(404).send(notFoundPage());

  const boardUrl = absoluteUrl(req, `/board/${game.id}`);
  const spyUrl = absoluteUrl(req, `/spymaster/${game.spymasterToken}`);
  const [boardQr, spyQr] = await Promise.all([qrDataUrl(boardUrl), qrDataUrl(spyUrl)]);

  const linkBlock = (title, hint, url, qr, openClass) => `
    <div class="card">
      <h2>${title}</h2>
      <p class="status">${hint}</p>
      <div class="qr-block">
        ${qr ? `<img class="qr" src="${qr}" alt="${title} QR code">` : ''}
        <div class="share-links">
          <code class="share-url">${esc(url)}</code>
          <div class="linkrow">
            <a class="btn ${openClass}" href="${esc(url)}" target="_blank">Open</a>
            <button type="button" class="btn ghost" onclick="copyLink(this, '${esc(url)}')">Copy link</button>
          </div>
        </div>
      </div>
    </div>`;

  const body = `
    <div class="wrap">
      <h1>Game ready 🎉</h1>
      <p class="sub">${statusLine(game)}. Bookmark this page — it's the only place both links live.</p>
      <div class="grid">
        ${linkBlock('Board link', 'Share with everyone / open on the TV.', boardUrl, boardQr, '')}
        ${linkBlock('Spymaster link', 'Give to your spymaster only — it shows the color key.', spyUrl, spyQr, 'ghost')}
      </div>
      <form method="POST" action="/game/${game.spymasterToken}/reset" class="setup-form"
            onsubmit="return confirm('Play again? This deals a new board (new words + colors) and clears reveals, timer, and shots. The links stay the same.')">
        <button type="submit" class="btn">Play again — new board, same links</button>
      </form>
    </div>
    <script>
      function copyLink(btn, url) {
        var done = function () {
          var t = btn.textContent; btn.textContent = 'Copied!';
          setTimeout(function () { btn.textContent = t; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done).catch(function () { fallbackCopy(url, done); });
        } else {
          fallbackCopy(url, done);
        }
      }
      function fallbackCopy(text, done) {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) {}
        document.body.removeChild(ta);
      }
    </script>`;
  res.send(layout('Speednames — Game ready', body));
});

app.post('/game/:token/reset', (req, res) => {
  const id = resetGameByToken(req.params.token);
  if (!id) return res.status(404).send(notFoundPage());
  res.redirect(`/game/${req.params.token}`);
});

// ---------- Public board (TV) view ----------
app.get('/board/:id', (req, res) => {
  const game = getGameById(req.params.id);
  if (!game) return res.status(404).send(notFoundPage());

  const tiles = game.words.map((word, i) => {
    const revealed = game.revealed[i];
    const teamClass = revealed ? `revealed team-${game.colors[i].toLowerCase()}` : '';
    return `<button class="tile ${teamClass}" data-index="${i}" onclick="reveal(${i})" ${revealed ? 'disabled' : ''}>${esc(word)}</button>`;
  }).join('');

  const banner = bannerInfo(game);
  const body = `
    <div class="wrap board-wrap">
      <div class="top-row">
        <h1>Board</h1>
        <div class="timer" id="timer">--:--</div>
      </div>
      <div class="${banner.cls}" id="phase-banner">${bannerHtml(banner)}</div>
      <div class="board-grid">${tiles}</div>
      <div class="controls">
        <button class="btn" onclick="timerAction('start')">Start Timer</button>
        <button class="btn ghost" onclick="timerAction('pause')">Pause</button>
        <button class="btn ghost" onclick="timerAction('reset')">Reset</button>
        <button class="btn" onclick="turnNext()">Next Turn ▸</button>
        <button class="btn shot" onclick="takeShot('spymaster')">🥃 Spymaster +1:00</button>
        <button class="btn shot" onclick="takeShot('guesser')">🥃 Guessers +1:00</button>
      </div>
      <div class="tally" id="tally">🥃 Spymaster shots: ${game.shots.spymaster} · Guesser shots: ${game.shots.guesser}</div>
      <ul class="rule-note">
        <li>🥃 <strong>Guessers' shot:</strong> any time during your turn, two guessers each take a shot to earn the team one extra guess (+1:00). Repeat for more guesses.</li>
        <li>🥃 <strong>Spymaster shot:</strong> the spymaster drinks for +1:00 of thinking time.</li>
        <li>🥃 <strong>Wrong guess</strong> (whoever tapped it): neutral = 2 sips, other team's word = 5 sips, assassin = finish your drink.</li>
        <li>🥃 <strong>Losing team:</strong> everyone on it takes a shot.</li>
      </ul>
    </div>
    <script src="/static/client.js"></script>
    <script>initBoard('${game.id}');</script>`;
  res.send(layout('Speednames — Board', body));
});

// ---------- Spymaster key view (keyed by the secret token) ----------
app.get('/spymaster/:token', (req, res) => {
  const game = getGameByToken(req.params.token);
  if (!game) return res.status(404).send(notFoundPage());

  const tiles = game.words.map((word, i) => {
    const revealed = game.revealed[i];
    const teamClass = `team-${game.colors[i].toLowerCase()}`;
    return `<button class="tile spy ${teamClass} ${revealed ? 'revealed' : ''}" onclick="reveal(${i})" ${revealed ? 'title="Tap to undo this guess"' : ''}>${esc(word)}</button>`;
  }).join('');

  const banner = bannerInfo(game);
  const body = `
    <div class="wrap board-wrap">
      <div class="top-row">
        <h1>Spymaster Key</h1>
        <div class="timer" id="timer">--:--</div>
      </div>
      <div class="${banner.cls}" id="phase-banner">${bannerHtml(banner)}</div>
      <p class="sub">Starting team: ${TEAM_LABEL[game.startingTeam]}. Tap a tile to mark it guessed; dimmed tiles are already guessed. Misclick? Tap a dimmed tile to undo that guess. <a href="/game/${game.spymasterToken}">Share links</a></p>
      <div class="board-grid">${tiles}</div>
      <div class="controls">
        <button class="btn" onclick="timerAction('start')">Start Timer</button>
        <button class="btn ghost" onclick="timerAction('pause')">Pause</button>
        <button class="btn ghost" onclick="timerAction('reset')">Reset</button>
        <button class="btn" onclick="turnNext()">Next Turn ▸</button>
        <button class="btn shot" onclick="takeShot('spymaster')">🥃 Spymaster +1:00</button>
        <button class="btn shot" onclick="takeShot('guesser')">🥃 Guessers +1:00</button>
      </div>
      <div class="tally" id="tally">🥃 Spymaster shots: ${game.shots.spymaster} · Guesser shots: ${game.shots.guesser}</div>
      <div class="legend">
        <span class="swatch team-a"></span> Team A
        <span class="swatch team-b"></span> Team B
        <span class="swatch team-neutral"></span> Neutral
        <span class="swatch team-assassin"></span> Assassin
      </div>
    </div>
    <script src="/static/client.js"></script>
    <script>initSpymaster('${game.spymasterToken}', '${game.id}');</script>`;
  res.send(layout('Speednames — Spymaster Key', body));
});

// ---------- API ----------
// Public endpoint: only reveals a tile's team color once it's actually been revealed.
app.get('/api/state/:id', (req, res) => {
  const game = getGameById(req.params.id);
  if (!game) return res.status(404).json({ error: 'not found' });
  res.json({
    revealed: game.revealed,
    displayColors: game.colors.map((c, i) => (game.revealed[i] ? c : null)),
    activeTeam: game.activeTeam,
    shots: game.shots,
    outcome: outcome(game),
    timer: { total: game.timer.total, running: game.timer.running, remaining: timerCurrentRemaining(game) }
  });
});

// Spymaster endpoint: always includes the full key. Keyed by the secret token.
app.get('/api/spystate/:token', (req, res) => {
  const game = getGameByToken(req.params.token);
  if (!game) return res.status(404).json({ error: 'not found' });
  res.json({
    revealed: game.revealed,
    colors: game.colors,
    activeTeam: game.activeTeam,
    shots: game.shots,
    outcome: outcome(game),
    timer: { total: game.timer.total, running: game.timer.running, remaining: timerCurrentRemaining(game) }
  });
});

// Mutations are keyed by the public board id (board-link holders can already
// reveal tiles; the only real secret is the color key behind the token).
app.post('/api/reveal', (req, res) => {
  setRevealed(req.body.boardId, parseInt(req.body.index, 10), true);
  res.json({ ok: true });
});

// Undo a guess (e.g. a misclick). Spymaster-only: keyed by the secret token,
// so holding the board link isn't enough to un-reveal tiles.
app.post('/api/unreveal', (req, res) => {
  const game = getGameByToken(req.body.token);
  if (!game) return res.status(404).json({ error: 'not found' });
  const index = parseInt(req.body.index, 10);
  if (!(index >= 0 && index < game.revealed.length)) return res.status(400).json({ error: 'bad index' });
  setRevealed(game.id, index, false);
  res.json({ ok: true });
});

app.post('/api/turn/next', (req, res) => {
  turnNext(req.body.boardId);
  res.json({ ok: true });
});

app.post('/api/shot', (req, res) => {
  takeShot(req.body.boardId, req.body.side);
  res.json({ ok: true });
});

app.post('/api/timer/start', (req, res) => {
  timerStart(req.body.boardId);
  res.json({ ok: true });
});

app.post('/api/timer/pause', (req, res) => {
  timerPause(req.body.boardId);
  res.json({ ok: true });
});

app.post('/api/timer/reset', (req, res) => {
  timerReset(req.body.boardId);
  res.json({ ok: true });
});

app.listen(PORT, BIND_HOST, () => {
  console.log('Speednames server running:');
  console.log(`  Local:   http://localhost:${PORT}`);
  localIPs().forEach(ip => console.log(`  Network: http://${ip}:${PORT}`));
  if (BASE_URL) console.log(`  Public:  ${BASE_URL} (BASE_URL override)`);
});
