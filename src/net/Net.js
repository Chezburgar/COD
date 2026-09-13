/* ══════════════════════════════════════════════════════════════════════════
   Net — peer-to-peer matches over WebRTC.

   One player hosts and owns the simulation; everyone else sends input and
   renders an interpolated view of the host's world, with client-side
   prediction and replay for their own soldier. Signalling runs through the
   public PeerJS broker — there is no game server, which is what lets the
   whole thing live on static hosting.
   ══════════════════════════════════════════════════════════════════════════ */
import Peer from 'peerjs';
import * as THREE from 'three';

const PREFIX = 'ocxf-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1
const SNAPSHOT_HZ = 20;

// TURN relays, for the players whose networks refuse a direct connection: a
// symmetric NAT has no route STUN alone can find, and without a relay those
// players simply cannot join at all.
//
// Metered mints short-lived credentials per request from an API key. That key
// reaches the browser either way, so it is not a secret in the usual sense —
// but it is still an account credential with a metered bill behind it, so it
// is not written down in the repository. Supply it at build time:
//
//   VITE_TURN_KEY=<key> npm run build
//
// and on GitHub Pages set it as a repository secret the workflow passes
// through. With no key the game falls back to STUN, which is what it used
// before this and is enough for most networks.
const TURN_KEY = import.meta.env?.VITE_TURN_KEY ?? '';
const TURN_HOST = import.meta.env?.VITE_TURN_HOST ?? 'frontlines.metered.live';
const TURN_API = TURN_KEY
  ? `https://${TURN_HOST}/api/v1/turn/credentials?apiKey=${encodeURIComponent(TURN_KEY)}`
  : null;
const STUN_ONLY = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

export function makeRoomCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[(Math.random() * ALPHABET.length) | 0];
  return s;
}

const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

export class Net {
  constructor() {
    this.peer = null;
    this.role = null;            // 'host' | 'client' | null
    this.code = null;
    this.conns = new Map();      // peerId -> { conn, playerId, name, loadout, ready, ping, lastCmd }
    this.hostConn = null;
    this.on = {};
    this.myId = 0;
    this.snapAccum = 0;
    this.cmdSeq = 0;
    this.pendingCmds = [];       // client: unacknowledged commands for replay
    this.lastAck = 0;
    this.serverTimeOffset = 0;
    this.ping = 0;
    this.closed = false;
  }

  emit(name, ...a) { this.on[name]?.(...a); }

  /**
   * ICE servers for the connection. Credentials are short-lived, so they are
   * fetched once per session and reused; if the service is unreachable this
   * still returns STUN, which is what the game had before and is enough for
   * most networks.
   */
  async _ice() {
    if (this._icePromise) return this._icePromise;
    this._icePromise = (async () => {
      if (!TURN_API) return STUN_ONLY;
      try {
        const res = await fetch(TURN_API, { cache: 'no-store' });
        if (!res.ok) throw new Error(`turn ${res.status}`);
        const servers = await res.json();
        if (!Array.isArray(servers) || !servers.length) throw new Error('turn empty');
        // Keep STUN alongside: a direct route is always cheaper than a relay,
        // and ICE will prefer one when it can find it.
        return [...STUN_ONLY, ...servers];
      } catch (err) {
        console.warn('TURN unavailable, falling back to STUN only', err);
        return STUN_ONLY;
      }
    })();
    return this._icePromise;
  }

  async _newPeer(id) {
    const iceServers = await this._ice();
    this.usingRelay = iceServers.length > STUN_ONLY.length;
    const opts = { debug: 0, config: { iceServers } };
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id, opts) : new Peer(opts);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { peer.destroy(); } catch { /* already gone */ }
        reject(new Error('Signalling server did not respond. Check your connection or play offline.'));
      }, 12000);
      peer.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(peer);
      });
      peer.on('error', (err) => {
        if (settled) { this.emit('error', err); return; }
        settled = true;
        clearTimeout(timer);
        try { peer.destroy(); } catch { /* already gone */ }
        reject(err);
      });
    });
  }

  /* ══ host ════════════════════════════════════════════════════════════════ */

  async host(code = makeRoomCode()) {
    this.code = code;
    this.closed = false;
    try {
      this.peer = await this._newPeer(PREFIX + code);
    } catch (e) {
      // Leave the transport clean so the player can simply try again.
      this.role = null;
      this.code = null;
      this.peer = null;
      throw e;
    }
    this.role = 'host';
    this.nextPlayerId = 2;

    this.peer.on('connection', (conn) => {
      conn.on('open', () => {
        if (this.conns.size >= 9) { conn.send({ t: 'full' }); setTimeout(() => conn.close(), 400); return; }
        const rec = { conn, playerId: this.nextPlayerId++, name: 'Operator', loadout: null, ping: 0, lastCmd: null, joined: false };
        this.conns.set(conn.peer, rec);
        conn.on('data', (msg) => this._hostMessage(rec, msg));
        conn.on('close', () => this._hostDrop(rec));
        conn.on('error', () => this._hostDrop(rec));
      });
    });
    this.peer.on('disconnected', () => { if (!this.closed) this.peer.reconnect(); });
    return code;
  }

  _hostDrop(rec) {
    if (!this.conns.has(rec.conn.peer)) return;
    this.conns.delete(rec.conn.peer);
    this.emit('playerLeft', rec.playerId, rec.name);
  }

  _hostMessage(rec, msg) {
    switch (msg.t) {
      case 'hello':
        rec.name = String(msg.name ?? 'Operator').slice(0, 14);
        rec.loadout = msg.loadout;
        rec.joined = true;
        this.emit('playerJoined', rec.playerId, rec.name, rec.loadout);
        rec.conn.send({ t: 'welcome', id: rec.playerId, code: this.code });
        break;
      case 'cmd':
        rec.lastCmd = msg;
        this.emit('command', rec.playerId, msg);
        break;
      case 'fire':
        this.emit('remoteFire', rec.playerId, msg);
        break;
      case 'throw':
        this.emit('remoteThrow', rec.playerId, msg);
        break;
      case 'loadout':
        rec.loadout = msg.loadout;
        this.emit('loadoutChange', rec.playerId, msg.loadout);
        break;
      case 'ping':
        rec.conn.send({ t: 'pong', ts: msg.ts, now: performance.now() });
        break;
      case 'pongAck':
        rec.ping = msg.rtt;
        this.emit('ping', rec.playerId, msg.rtt);
        break;
      default: break;
    }
  }

  broadcast(msg, exceptPlayerId = null) {
    for (const rec of this.conns.values()) {
      if (!rec.joined || rec.playerId === exceptPlayerId) continue;
      try { rec.conn.send(msg); } catch { /* connection closing */ }
    }
  }

  sendTo(playerId, msg) {
    for (const rec of this.conns.values()) {
      if (rec.playerId === playerId) { try { rec.conn.send(msg); } catch { /* closing */ } return; }
    }
  }

  /** Serialises the whole world for clients. Called at SNAPSHOT_HZ. */
  hostTick(dt, game) {
    if (this.role !== 'host' || this.conns.size === 0) return;
    this.snapAccum += dt;
    if (this.snapAccum < 1 / SNAPSHOT_HZ) return;
    this.snapAccum = 0;

    const ents = [];
    for (const c of game.combatants) {
      ents.push([
        c.id, r2(c.pos.x), r2(c.pos.y), r2(c.pos.z),
        r3(c.yaw), r3(c.pitch), Math.round(c.crouch * 100),
        Math.round(c.health), c.alive ? 1 : 0, c.slot,
        Math.round(c.ammo[c.slot] === Infinity ? 999 : c.ammo[c.slot]),
        r2(c.vel.x), r2(c.vel.y), r2(c.vel.z),
      ]);
    }
    const base = {
      t: 'snap',
      time: r3(game.time),
      ents,
      sc: game.teamScores,
      clk: Math.round(game.clock),
      uav: game.uavUntil.map((v) => r2(v)),
      // Round state, so a client's scoreboard and round banner match the host's.
      rw: game.roundWins,
      rd: game.round,
      rp: game.roundPhase === 'live' ? 1 : 0,
    };
    for (const rec of this.conns.values()) {
      if (!rec.joined) continue;
      // Ack the last command the simulation actually consumed — acking
      // anything newer would make the client drop input it still needs.
      const c = game.byId.get(rec.playerId);
      try { rec.conn.send({ ...base, ack: c?.lastAckSeq ?? 0 }); } catch { /* closing */ }
    }
  }

  /* ══ client ══════════════════════════════════════════════════════════════ */

  async join(code, name, loadout) {
    this.code = code.toUpperCase();
    this.closed = false;
    let conn;
    try {
      this.peer = await this._newPeer(null);
      conn = this.peer.connect(PREFIX + this.code, { reliable: true, serialization: 'binary' });
      this.hostConn = conn;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No lobby found with code ${this.code}.`)), 14000);
        conn.on('open', () => { clearTimeout(timer); resolve(); });
        conn.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
    } catch (e) {
      try { this.peer?.destroy(); } catch { /* already gone */ }
      this.peer = null;
      this.hostConn = null;
      this.role = null;
      throw e;
    }
    this.role = 'client';

    conn.on('data', (msg) => this._clientMessage(msg));
    conn.on('close', () => this.emit('hostLost'));
    conn.send({ t: 'hello', name, loadout });

    this._pingTimer = setInterval(() => {
      if (!conn.open) return;
      const ts = performance.now();
      conn.send({ t: 'ping', ts });
    }, 1500);
    return this.code;
  }

  _clientMessage(msg) {
    switch (msg.t) {
      case 'welcome':
        this.myId = msg.id;
        this.emit('welcome', msg);
        break;
      case 'full': this.emit('error', new Error('That lobby is full.')); break;
      case 'roster': this.emit('roster', msg.players, msg.config); break;
      case 'start': this.emit('start', msg); break;
      case 'snap': this.emit('snapshot', msg); break;
      case 'ev': for (const e of msg.e) this.emit('event', e); break;
      case 'pong': {
        const rtt = performance.now() - msg.ts;
        this.ping = this.ping ? this.ping * 0.7 + rtt * 0.3 : rtt;
        this.hostConn.send({ t: 'pongAck', rtt: Math.round(this.ping) });
        this.emit('ping', this.myId, Math.round(this.ping));
        break;
      }
      case 'bye': this.emit('hostLost'); break;
      default: break;
    }
  }

  sendCommand(cmd) {
    if (this.role !== 'client' || !this.hostConn?.open) return;
    const packed = {
      t: 'cmd', seq: ++this.cmdSeq, dt: r3(cmd.dt),
      mx: r2(cmd.moveX), mz: r2(cmd.moveZ),
      y: r3(cmd.yaw), p: r3(cmd.pitch), b: cmd.buttons,
    };
    this.pendingCmds.push({ ...packed });
    while (this.pendingCmds.length > 120) this.pendingCmds.shift();
    try { this.hostConn.send(packed); } catch { /* closing */ }
  }

  send(msg) {
    if (this.role === 'client' && this.hostConn?.open) {
      try { this.hostConn.send(msg); } catch { /* closing */ }
    }
  }

  ackCommands(seq) {
    this.lastAck = seq;
    while (this.pendingCmds.length && this.pendingCmds[0].seq <= seq) this.pendingCmds.shift();
  }

  /* ══ teardown ════════════════════════════════════════════════════════════ */
  close() {
    this.closed = true;
    clearInterval(this._pingTimer);
    if (this.role === 'host') this.broadcast({ t: 'bye' });
    for (const rec of this.conns.values()) { try { rec.conn.close(); } catch { /* gone */ } }
    this.conns.clear();
    try { this.hostConn?.close(); } catch { /* gone */ }
    try { this.peer?.destroy(); } catch { /* gone */ }
    this.peer = null;
    this.role = null;
    this.hostConn = null;
    this.pendingCmds.length = 0;
  }

  get playerCount() { return 1 + [...this.conns.values()].filter((r) => r.joined).length; }
}

export { SNAPSHOT_HZ, PREFIX };
