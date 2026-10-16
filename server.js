const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'changeme';

const Q = [
  ["Name something people do during the sermon besides listening.", "Check their phone", "Sleep or nod off", "Doodle on the bulletin", "Whisper to a neighbor", "Check the time"],
  ["Name a reason people arrive late to church.", "Overslept", "Kids", "Traffic", "Could not find parking", "Could not find shoes"],
  ["Name a famous Bible character kids love.", "Noah", "David", "Jesus", "Moses", "Jonah"],
  ["Name a food you would expect at a church potluck.", "Fried chicken", "Sea Food Okro", "Jollof rice", "Pasta salad", "Cake or dessert"],
  ["Name a hymn or worship song everyone knows.", "Amazing Grace", "How Great Thou Art", "Great Is Thy Faithfulness", "Oceans", "Blessed Assurance"],
  ["Name something you would find in a church store.", "Worker's tag", "Water", "Books", "FOH", "Sign-up sheet"],
  ["Name something people say about the pastor's sermon length.", "\"Too long\"", "\"Just right\"", "\"Felt like an hour\"", "\"Wish it were longer\"", "\"Great, but I was hungry\""],
  ["Name a place in the church building besides the sanctuary.", "Picture booth", "Vendor Stand", "Restroom", "Parking lot", "Pastor's Office"],
  ["Name something people bring to church besides a Bible.", "Phone", "Offering", "Handbag or purse", "Thinking caps", "Notebook"],
  ["Name something that gets passed around in church.", "Offering basket", "Compliments", "Side eyes", "Tissues", "Hugs"]
];

const teamOf = t => (t % 2 === 0 ? 'A' : 'B');
const fresh = names => ({
  phase: 'lobby', turn: -1, order: [], scores: { A: 0, B: 0 }, results: [],
  names: names || { A: 'Team A', B: 'Team B' }, aud: new Map(), team: null
});

let G = fresh();
const players = new Map(); // cid -> { name, role: 'A' | 'B' | 'aud' }

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function view(ws) {
  const p = players.get(ws.cid) || null;
  const count = r => [...players.values()].filter(x => x.role === r).length;
  const v = {
    phase: G.phase, turn: G.turn, names: G.names, me: p, host: !!ws.host,
    roster: { A: count('A'), B: count('B'), aud: count('aud') }
  };
  const live = G.phase === 'open' || G.phase === 'revealed';
  if (G.turn >= 0 && live) {
    const q = Q[G.order[G.turn]];
    v.q = { text: q[0], opts: q.slice(1) };
    v.team = teamOf(G.turn);
    v.locked = G.team !== null;
  }
  if (p && p.role === 'aud' && G.aud.has(ws.cid)) v.pick = G.aud.get(ws.cid);
  const done = G.phase === 'revealed' || G.phase === 'done';
  const canSee = ws.host || (p && p.role === 'aud');
  if (canSee && (done || ws.host)) v.scores = G.scores;
  if (canSee && done && G.results.length) v.last = G.results[G.results.length - 1];
  if (ws.host && G.phase === 'open') {
    v.live = tally();
    v.audCount = G.aud.size;
  }
  return v;
}

function tally() {
  const c = [0, 0, 0, 0, 0];
  for (const [cid, o] of G.aud) {
    const p = players.get(cid);
    if (p && p.role === 'aud' && o >= 0 && o < 5) c[o]++;
  }
  return c;
}

function broadcast() {
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(JSON.stringify(view(ws)));
  }
}

function lockTeamAnswer(opt) {
  const counts = tally();
  const pts = opt >= 0 ? counts[opt] : 0;
  const team = teamOf(G.turn);
  G.team = opt;
  G.scores[team] += pts;
  const q = Q[G.order[G.turn]];
  G.results.push({ turn: G.turn, team, opt, pts, counts, qtext: q[0], opts: q.slice(1) });
  G.phase = 'revealed';
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'hello' && typeof m.cid === 'string') ws.cid = m.cid.slice(0, 64);
    if (!ws.cid) return;
    const p = players.get(ws.cid);

    if (m.t === 'host') ws.host = m.pw === HOST_PASSWORD;
    else if (m.t === 'join' && !p && G.phase === 'lobby') {
      const name = String(m.name || '').trim().slice(0, 30);
      if (name && ['A', 'B', 'aud'].includes(m.role)) players.set(ws.cid, { name, role: m.role });
    } else if (m.t === 'aud' && p && p.role === 'aud' && G.phase === 'open') {
      if (Number.isInteger(m.opt) && m.opt >= 0 && m.opt < 5) G.aud.set(ws.cid, m.opt);
    } else if (m.t === 'team' && p && p.role === teamOf(G.turn) && G.phase === 'open' && G.team === null) {
      if (Number.isInteger(m.opt) && m.opt >= -1 && m.opt < 5) lockTeamAnswer(m.opt);
    } else if (ws.host) {
      if (m.t === 'names' && G.names) {
        G.names = { A: String(m.A || 'Team A').slice(0, 30), B: String(m.B || 'Team B').slice(0, 30) };
      } else if (m.t === 'start' && (G.phase === 'lobby' || G.phase === 'done')) {
        const o = [...Array(10).keys()].sort(() => Math.random() - 0.5);
        const order = [];
        for (let i = 0; i < 5; i++) order.push(o[i], o[i + 5]);
        G = fresh(G.names);
        G.order = order; G.turn = 0; G.phase = 'open';
      } else if (m.t === 'next' && G.phase === 'revealed' && G.turn < 9) {
        G.turn++; G.phase = 'open'; G.aud = new Map(); G.team = null;
      } else if (m.t === 'end' && G.phase === 'revealed') {
        G.phase = 'done';
      } else if (m.t === 'reset') {
        G = fresh(G.names);
        if (m.clearPlayers) players.clear();
      }
    }
    broadcast();
  });
});

server.listen(PORT, () => {
  console.log('Church Family Feud running on port ' + PORT);
  if (HOST_PASSWORD === 'changeme') console.log('Warning: set the HOST_PASSWORD environment variable.');
});
