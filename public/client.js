function fmtTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// Per-page state, set by initBoard / initSpymaster:
//   IS_BOARD_VIEW — true = public board, false = spymaster key
//   POLL_KEY      — what /api/state|spystate is keyed by (boardId vs secret token)
//   BOARD_ID      — public board id, used for every mutation
let IS_BOARD_VIEW = true;
let POLL_KEY = '';
let BOARD_ID = '';

async function post(path, body) {
  await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  refreshState();
}

async function reveal(index) {
  // On the spymaster view, locking in a guess is deliberate and irreversible,
  // so confirm first. The public/TV board stays instant for fast play.
  if (!IS_BOARD_VIEW) {
    const tiles = document.querySelectorAll('.tile');
    const word = tiles[index] ? tiles[index].textContent.trim() : 'this tile';
    // Tapping an already-guessed tile on the spymaster key undoes the guess.
    if (tiles[index] && tiles[index].classList.contains('revealed')) {
      if (!confirm(`Undo the guess on "${word}"? It will be hidden on the board again.`)) return;
      post('/api/unreveal', { token: POLL_KEY, index });
      return;
    }
    if (!confirm(`Lock in "${word}" as your team's guess? This reveals it on the board.`)) return;
  }
  post('/api/reveal', { boardId: BOARD_ID, index });
}

function timerAction(action) {
  post(`/api/timer/${action}`, { boardId: BOARD_ID });
}

function turnNext() {
  post('/api/turn/next', { boardId: BOARD_ID });
}

function takeShot(side) {
  post('/api/shot', { boardId: BOARD_ID, side });
}

// Banner text/class from live state — end state (win / assassin) or whose turn.
// Kept in sync with bannerInfo() in server.js.
function bannerInfo(data) {
  const o = data.outcome;
  const drink = o && o.over ? `🥃 Everyone on Team ${o.loser} takes a shot` : '';
  if (o && o.over && o.assassin) {
    return { text: `💀 Assassin! Team ${o.loser} loses`, drink, cls: 'phase-banner ended assassin' };
  }
  if (o && o.over) {
    return { text: `🎉 TEAM ${o.winner} WINS!`, drink, cls: `phase-banner ended team-${o.winner.toLowerCase()}` };
  }
  return { text: `TEAM ${data.activeTeam}'S TURN`, drink, cls: `phase-banner team-${data.activeTeam.toLowerCase()}` };
}

// Wrong-guess drink popup. Shown on every open view when a tile flips to a
// color that isn't the active team's. The penalty for whoever tapped it depends
// on the card: neutral = 2 sips, other team = 5 sips, assassin = finish the drink.
// Shown even when the reveal ends the game; the losing-team shot stacks on top.
let prevRevealed = null; // null until the first poll, so a page load doesn't fire it
let drinkTimeout = null;

function wrongGuessPenalty(color) {
  if (color === 'NEUTRAL') return { title: '🥃 Wrong guess!', what: 'a neutral word', drink: 'takes 2 sips' };
  if (color === 'ASSASSIN') return { title: '💀 Assassin!', what: 'the assassin', drink: 'finishes their drink' };
  return { title: '🥃 Wrong guess!', what: "the other team's word", drink: 'takes 5 sips' };
}

function showDrinkAlert(word, color) {
  const p = wrongGuessPenalty(color);
  let el = document.getElementById('drink-alert');
  if (!el) {
    el = document.createElement('div');
    el.id = 'drink-alert';
    el.addEventListener('click', () => el.classList.remove('show'));
    document.body.appendChild(el);
  }
  el.className = color === 'ASSASSIN' ? 'drink-alert assassin' : 'drink-alert';
  el.innerHTML = '';
  const big = document.createElement('div');
  big.className = 'drink-alert-big';
  big.textContent = p.title;
  const small = document.createElement('div');
  small.className = 'drink-alert-small';
  small.textContent = `"${word}" was ${p.what}. Whoever tapped it ${p.drink}.`;
  el.append(big, small);
  void el.offsetWidth; // let the slide-in replay when a new alert replaces one
  el.classList.add('show');
  clearTimeout(drinkTimeout);
  drinkTimeout = setTimeout(() => el.classList.remove('show'), 6000);
}

function checkWrongGuess(data) {
  const colors = data.colors || data.displayColors;
  if (prevRevealed) {
    data.revealed.forEach((r, i) => {
      if (r && !prevRevealed[i] && colors[i] && colors[i] !== data.activeTeam) {
        const tile = document.querySelectorAll('.tile')[i];
        showDrinkAlert(tile ? tile.textContent.trim() : 'That word', colors[i]);
      }
    });
  }
  prevRevealed = data.revealed.slice();
}

async function refreshState() {
  const endpoint = IS_BOARD_VIEW ? `/api/state/${POLL_KEY}` : `/api/spystate/${POLL_KEY}`;
  const res = await fetch(endpoint);
  if (!res.ok) return;
  const data = await res.json();

  const timerEl = document.getElementById('timer');
  if (timerEl) {
    timerEl.textContent = fmtTime(data.timer.remaining);
    timerEl.classList.toggle('running', data.timer.running);
    timerEl.classList.toggle('done', data.timer.remaining === 0);
  }

  // Turn / end-state banner (present on both board + spymaster views).
  const banner = document.getElementById('phase-banner');
  if (banner && data.activeTeam) {
    const info = bannerInfo(data);
    banner.textContent = info.text;
    if (info.drink) {
      const d = document.createElement('span');
      d.className = 'banner-drink';
      d.textContent = info.drink;
      banner.appendChild(d);
    }
    banner.className = info.cls;
  }

  // Shot tally (present on both views).
  const tally = document.getElementById('tally');
  if (tally && data.shots) {
    tally.textContent = `🥃 Spymaster shots: ${data.shots.spymaster} · Guesser shots: ${data.shots.guesser}`;
  }

  checkWrongGuess(data);

  const tiles = document.querySelectorAll('.tile');
  tiles.forEach((tile, i) => {
    const revealed = data.revealed[i];
    if (IS_BOARD_VIEW) {
      if (!revealed) {
        // A guess can be undone by the spymaster, so clear any revealed color.
        if (tile.classList.contains('revealed')) {
          tile.classList.remove('revealed', 'team-a', 'team-b', 'team-neutral', 'team-assassin');
          tile.disabled = false;
        }
        return;
      }
      const color = data.displayColors[i];
      tile.classList.add('revealed', `team-${color.toLowerCase()}`);
      tile.disabled = true;
    } else {
      // Spymaster view: colors are already rendered server-side; just dim once
      // revealed. Revealed tiles stay tappable so the spymaster can undo them.
      tile.classList.toggle('revealed', !!revealed);
      tile.title = revealed ? 'Tap to undo this guess' : '';
    }
  });
}

// Flash any button/tile on click so a tap is visibly acknowledged, even when
// the resulting state change is subtle or a no-op. Delegated so one handler
// covers every button and tile on the page.
document.addEventListener('click', (e) => {
  const el = e.target.closest('.btn, .tile');
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation on rapid repeat clicks
  el.classList.add('flash');
});
document.addEventListener('animationend', (e) => {
  if (e.animationName === 'click-flash') e.target.classList.remove('flash');
});

function initBoard(boardId) {
  IS_BOARD_VIEW = true;
  POLL_KEY = boardId;
  BOARD_ID = boardId;
  refreshState();
  setInterval(refreshState, 1000);
}

function initSpymaster(token, boardId) {
  IS_BOARD_VIEW = false;
  POLL_KEY = token;
  BOARD_ID = boardId;
  refreshState();
  setInterval(refreshState, 1000);
}
