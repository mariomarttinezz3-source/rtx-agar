'use strict';
// =====================================================================
//  Servidor Agar privado — modos FFA, Instant, Crazy y Bots (minions)
//  Sin dependencias (Node.js 16+).   Uso:  node server.js
// =====================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------- CONFIGURACIÓN ----------------------------
const PORT = Number(process.env.PORT) || 3000;
const SERVER_NAME = process.env.SERVER_NAME || 'RTX Agar';
const TICK_RATE = 25;
const TICK_MS = 1000 / TICK_RATE;
const MAX_CELL_MASS = 22500;
const MAX_PLAYERS_PER_ROOM = 60;

// Cada modo es una sala independiente con sus propias reglas
const MODES = {
  ffa: { label: 'FFA Clásico', worldSize: 7000, startMass: 20, maxCells: 16, mergeMs: 15000, mergeMassMul: 15,
    speed: 1.2, viruses: 25, food: 1000, foodMass: 3, bots: 10, decay: 0.00025, minions: 0, splitMin: 36 },
  instant: { label: 'Instant', worldSize: 8000, startMass: 500, maxCells: 32, mergeMs: 700, mergeMassMul: 0,
    speed: 1.35, viruses: 35, food: 1400, foodMass: 2, bots: 14, decay: 0.0004, minions: 0, splitMin: 36 },
  crazy: { label: 'Crazy', worldSize: 9000, startMass: 2500, maxCells: 64, mergeMs: 1500, mergeMassMul: 0,
    speed: 1.6, viruses: 80, food: 1600, foodMass: 4, bots: 14, decay: 0.0005, minions: 0, splitMin: 30 },
  bots: { label: 'Bots (minions)', worldSize: 7000, startMass: 20, maxCells: 16, mergeMs: 15000, mergeMassMul: 15,
    speed: 1, viruses: 25, food: 1300, foodMass: 1, bots: 6, decay: 0.00025, minions: 3, splitMin: 36 },
};
// MODES=ffa,instant para activar solo algunos; BOTS=n para fijar bots en todas las salas
const ENABLED = (process.env.MODES || 'ffa,instant,crazy,bots').split(',').map((s) => s.trim()).filter((m) => MODES[m]);
if (process.env.BOTS !== undefined) for (const m of Object.values(MODES)) m.bots = Number(process.env.BOTS) || 0;

const BOT_NAMES = ['Pepe', 'Lagarto', 'Sushi', 'Tornado', 'Noob', 'Pro', 'Hielo', 'Fuego', 'Gato', 'Mango',
  'Rayo', 'Kiwi', 'Zorro', 'Bolita', 'Tiburón', 'Ninja', 'Panda', 'Chispa', 'Turbo', 'Pulpo'];
const COLORS = ['#ff4d4d', '#ff9f1a', '#ffd32a', '#32ff7e', '#18dcff', '#7d5fff', '#ff3838', '#3ae374',
  '#17c0eb', '#cd84f1', '#ffb8b8', '#67e6dc', '#ff6bcb', '#4bcffa', '#f8a5c2', '#c4e538'];

let nextId = 1;
const rand = (a, b) => a + Math.random() * (b - a);
const radius = (m) => Math.sqrt(m) * 10;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const cleanText = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

function cleanSkin(s) {
  s = String(s || '').trim();
  if (!s) return '';
  if (s.length > 300 || !/^https:\/\/[^\s"'()<>]+$/i.test(s)) return '';
  return s;
}

// ------------------------------- JUGADOR -------------------------------
class Player {
  constructor(room, name, isBot, conn, master) {
    this.room = room;
    this.id = nextId++;
    this.name = name;
    this.isBot = isBot;
    this.conn = conn;
    this.master = master || null;      // si es minion, su dueño
    this.minions = [];
    this.minionCollect = false;
    this.color = master ? master.color : pick(COLORS);
    this.skin = master ? master.skin : '';
    this.cells = [];
    this.tx = room.W / 2; this.ty = room.W / 2;
    this.alive = false;
    this.wantsPlay = false;
    this.viewX = room.W / 2; this.viewY = room.W / 2; this.viewF = 1;
    this.deadAt = 0;
    this.botTimer = 0;
    this.party = '';
    this.stats = null;
  }
  get team() { return this.master ? this.master.id : this.id; }
  totalMass() { let m = 0; for (const c of this.cells) m += c.mass; return m; }
  spawn() {
    const pos = this.master && this.master.cells.length
      ? { x: this.master.cells[0].x + rand(-250, 250), y: this.master.cells[0].y + rand(-250, 250) }
      : this.room.safeSpawn();
    const W = this.room.W;
    pos.x = clamp(pos.x, 100, W - 100); pos.y = clamp(pos.y, 100, W - 100);
    const mass = this.master ? Math.max(20, this.room.mode.startMass * 0.5) : this.room.mode.startMass;
    this.cells = [this.room.makeCell(this, pos.x, pos.y, mass)];
    this.tx = pos.x; this.ty = pos.y;
    this.alive = true;
    this.stats = { food: 0, start: Date.now(), maxMass: mass, bestRank: 99 };
  }
  info() { return [this.id, this.name, this.color, this.skin]; }
}

// -------------------------------- SALA ---------------------------------
class Room {
  constructor(key) {
    this.key = key;
    this.mode = MODES[key];
    this.W = this.mode.worldSize;
    this.players = new Map();
    this.food = [];
    this.viruses = [];
    this.ejected = [];
    this.tickCount = 0;
    this.leaderboard = [];
    for (let i = 0; i < this.mode.food; i++) this.addFood();
    for (let i = 0; i < this.mode.viruses; i++) this.addVirus();
    for (let i = 0; i < this.mode.bots; i++) {
      const b = new Player(this, pick(BOT_NAMES), true, null);
      b.spawn();
      this.players.set(b.id, b);
    }
  }

  humans() { let n = 0; for (const p of this.players.values()) if (p.conn) n++; return n; }
  makeCell(owner, x, y, mass) { return { id: nextId++, owner, x, y, mass, vx: 0, vy: 0, mergeAt: 0 }; }
  addFood() { this.food.push({ x: rand(0, this.W), y: rand(0, this.W), c: (Math.random() * COLORS.length) | 0 }); }
  addVirus(x, y, vx = 0, vy = 0) {
    this.viruses.push({ id: nextId++, x: x ?? rand(300, this.W - 300), y: y ?? rand(300, this.W - 300), mass: 100, vx, vy, feeds: 0 });
  }
  safeSpawn() {
    for (let t = 0; t < 30; t++) {
      const x = rand(200, this.W - 200), y = rand(200, this.W - 200);
      let ok = true;
      for (const p of this.players.values()) {
        for (const c of p.cells) if (Math.hypot(c.x - x, c.y - y) < radius(c.mass) + 400) { ok = false; break; }
        if (!ok) break;
      }
      if (ok) return { x, y };
    }
    return { x: rand(200, this.W - 200), y: rand(200, this.W - 200) };
  }
  mergeDelay(mass) { return this.mode.mergeMs + mass * this.mode.mergeMassMul; }

  // ------------------------------ acciones ------------------------------
  split(p) {
    if (!p.alive) return;
    const now = Date.now();
    const list = p.cells.slice().sort((a, b) => b.mass - a.mass);
    for (const c of list) {
      if (p.cells.length >= this.mode.maxCells) break;
      if (c.mass < this.mode.splitMin) continue;
      let dx = p.tx - c.x, dy = p.ty - c.y;
      const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
      const half = c.mass / 2;
      c.mass = half;
      const n = this.makeCell(p, c.x + dx * radius(half) * 0.3, c.y + dy * radius(half) * 0.3, half);
      const boost = 20 + Math.min(radius(half) * 0.03, 10);
      n.vx = dx * boost; n.vy = dy * boost;
      const mt = now + this.mergeDelay(half);
      c.mergeAt = Math.max(c.mergeAt, mt); n.mergeAt = mt;
      p.cells.push(n);
    }
  }
  multiSplit(p, times) {
    for (let i = 0; i < times; i++) this.split(p);
    for (const m of p.minions) if (!p.minionCollect) for (let i = 0; i < times; i++) this.split(m);
  }
  eject(p) {
    if (!p.alive) return;
    const now = Date.now();
    for (const c of p.cells) {
      if (c.mass < 35) continue;
      let dx = p.tx - c.x, dy = p.ty - c.y;
      const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
      c.mass -= 10;
      const r = radius(c.mass);
      const ang = Math.atan2(dy, dx) + rand(-0.12, 0.12);
      this.ejected.push({ id: nextId++, x: c.x + Math.cos(ang) * (r + 12), y: c.y + Math.sin(ang) * (r + 12),
        mass: 10, vx: Math.cos(ang) * 26, vy: Math.sin(ang) * 26, owner: p, born: now });
    }
  }
  popOnVirus(cell, virus) {
    const p = cell.owner;
    cell.mass += virus.mass;
    const free = this.mode.maxCells - p.cells.length;
    if (free <= 0) return;
    const pieces = Math.min(free, Math.max(2, Math.floor(cell.mass / 30)));
    const pieceMass = Math.max(12, (cell.mass / (pieces + 1)) * 0.6);
    const now = Date.now();
    for (let i = 0; i < pieces && cell.mass - pieceMass > 15; i++) {
      const ang = (i / pieces) * Math.PI * 2 + rand(-0.2, 0.2);
      cell.mass -= pieceMass;
      const n = this.makeCell(p, cell.x, cell.y, pieceMass);
      n.vx = Math.cos(ang) * 20; n.vy = Math.sin(ang) * 20;
      n.mergeAt = now + this.mergeDelay(pieceMass);
      p.cells.push(n);
    }
    cell.mergeAt = now + this.mergeDelay(cell.mass);
  }

  // -------------------------------- bots --------------------------------
  botThink(p, foodOnly) {
    if (--p.botTimer > 0) return;
    p.botTimer = 4 + ((Math.random() * 5) | 0);
    const me = p.cells.reduce((a, b) => (b.mass > a.mass ? b : a));
    const myR = radius(me.mass);
    let fleeX = 0, fleeY = 0, threat = false, best = null, bestScore = -Infinity;
    const range = 900 + myR;
    for (const q of this.players.values()) {
      if (q.team === p.team) continue;
      for (const c of q.cells) {
        const d = Math.hypot(c.x - me.x, c.y - me.y);
        if (d > range) continue;
        if (c.mass > me.mass * 1.25 && d < radius(c.mass) + 450) {
          fleeX += (me.x - c.x) / (d || 1); fleeY += (me.y - c.y) / (d || 1); threat = true;
        } else if (!foodOnly && me.mass > c.mass * 1.3) {
          const s = (c.mass / (d + 50)) * 3;
          if (s > bestScore) { bestScore = s; best = c; }
        }
      }
    }
    if (threat) { p.tx = me.x + fleeX * 600; p.ty = me.y + fleeY * 600; return; }
    for (const v of this.viruses) {
      if (me.mass > v.mass * 1.33 && Math.hypot(v.x - me.x, v.y - me.y) < myR + 150) {
        p.tx = me.x + (me.x - v.x); p.ty = me.y + (me.y - v.y); return;
      }
    }
    for (const f of this.food) {
      const d = Math.abs(f.x - me.x) + Math.abs(f.y - me.y);
      if (d > 700 + myR) continue;
      const s = 1 / (d + 30);
      if (s > bestScore) { bestScore = s; best = f; }
    }
    if (best) {
      p.tx = best.x; p.ty = best.y;
      if (best.owner && me.mass > best.mass * 2.6 && p.cells.length < 4 && Math.random() < 0.15 &&
        Math.hypot(best.x - me.x, best.y - me.y) < myR + 300) this.split(p);
    } else {
      p.tx = clamp(me.x + rand(-800, 800), 0, this.W); p.ty = clamp(me.y + rand(-800, 800), 0, this.W);
    }
  }

  // -------------------------------- tick --------------------------------
  tick() {
    const now = Date.now();
    const M = this.mode, W = this.W;
    this.tickCount++;

    for (const p of this.players.values()) {
      if (p.master) { // minion
        if (!p.master.conn) continue;
        if (!p.alive && p.master.alive && now - p.deadAt > 1500) p.spawn();
        if (p.alive) {
          if (p.master.minionCollect) this.botThink(p, true);
          else { p.tx = p.master.tx; p.ty = p.master.ty; }
        }
      } else if (p.isBot) {
        if (!p.alive && now - p.deadAt > 3000) { p.spawn(); p.name = pick(BOT_NAMES); this.broadcast({ t: 'pi', p: [p.info()] }); }
        if (p.alive) this.botThink(p, false);
      }
    }

    // movimiento
    for (const p of this.players.values()) {
      for (const c of p.cells) {
        const r = radius(c.mass);
        const dx = p.tx - c.x, dy = p.ty - c.y;
        const d = Math.hypot(dx, dy);
        const maxSpeed = 11 * Math.pow(c.mass, -0.24) * M.speed;
        if (d > 1) {
          const sp = maxSpeed * Math.min(1, d / (r * 0.6 + 20));
          c.x += (dx / d) * sp; c.y += (dy / d) * sp;
        }
        c.x += c.vx; c.y += c.vy;
        c.vx *= 0.91; c.vy *= 0.91;
        if (Math.abs(c.vx) < 0.05) c.vx = 0;
        if (Math.abs(c.vy) < 0.05) c.vy = 0;
        c.x = clamp(c.x, r * 0.4, W - r * 0.4);
        c.y = clamp(c.y, r * 0.4, W - r * 0.4);
        if (c.mass > 100) c.mass -= c.mass * M.decay;
      }
      // modos rápidos: las células listas para juntarse se atraen
      if (M.mergeMs < 5000 && p.cells.length > 1) {
        let sx = 0, sy = 0, sm = 0;
        for (const c of p.cells) { sx += c.x * c.mass; sy += c.y * c.mass; sm += c.mass; }
        const cx = sx / sm, cy = sy / sm;
        for (const c of p.cells) {
          if (now < c.mergeAt || Math.hypot(c.vx, c.vy) > 4) continue;
          c.x += (cx - c.x) * 0.06; c.y += (cy - c.y) * 0.06;
        }
      }
      // límite de masa por célula: se auto-divide
      for (const c of p.cells.slice()) {
        if (c.mass > MAX_CELL_MASS) {
          if (p.cells.length < M.maxCells) {
            const half = c.mass / 2; c.mass = half;
            const n = this.makeCell(p, c.x, c.y, half);
            const a = Math.random() * Math.PI * 2; n.vx = Math.cos(a) * 15; n.vy = Math.sin(a) * 15;
            n.mergeAt = c.mergeAt = now + this.mergeDelay(half);
            p.cells.push(n);
          } else c.mass = MAX_CELL_MASS;
        }
      }
      // colisión / fusión entre células propias
      const cs = p.cells;
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          const a = cs[i], b = cs[j];
          if (a.mass <= 0 || b.mass <= 0) continue;
          const ra = radius(a.mass), rb = radius(b.mass);
          let dx = b.x - a.x, dy = b.y - a.y;
          if (dx > ra + rb || dx < -ra - rb || dy > ra + rb || dy < -ra - rb) continue;
          let d = Math.hypot(dx, dy);
          if (d >= ra + rb) continue;
          if (now > a.mergeAt && now > b.mergeAt) {
            if (d < Math.max(ra, rb) - Math.min(ra, rb) * 0.2) {
              const big = a.mass >= b.mass ? a : b, small = big === a ? b : a;
              big.mass += small.mass; small.mass = 0;
            }
          } else {
            if (Math.hypot(a.vx, a.vy) > 4 || Math.hypot(b.vx, b.vy) > 4) continue;
            if (d < 0.01) { dx = rand(-1, 1); dy = rand(-1, 1); d = Math.hypot(dx, dy); }
            const push = (ra + rb - d) * 0.5, tot = a.mass + b.mass;
            a.x -= (dx / d) * push * (b.mass / tot); a.y -= (dy / d) * push * (b.mass / tot);
            b.x += (dx / d) * push * (a.mass / tot); b.y += (dy / d) * push * (a.mass / tot);
          }
        }
      }
      p.cells = cs.filter((c) => c.mass > 0);
    }

    for (const e of this.ejected) {
      e.x += e.vx; e.y += e.vy; e.vx *= 0.88; e.vy *= 0.88;
      e.x = clamp(e.x, 0, W); e.y = clamp(e.y, 0, W);
    }
    for (const v of this.viruses) {
      if (v.vx || v.vy) {
        v.x += v.vx; v.y += v.vy; v.vx *= 0.92; v.vy *= 0.92;
        if (Math.abs(v.vx) < 0.05) v.vx = 0;
        if (Math.abs(v.vy) < 0.05) v.vy = 0;
        v.x = clamp(v.x, 0, W); v.y = clamp(v.y, 0, W);
      }
    }

    const allCells = [];
    for (const p of this.players.values()) for (const c of p.cells) allCells.push(c);

    // comida
    const food = this.food;
    for (const c of allCells) {
      const r = radius(c.mass);
      for (let i = food.length - 1; i >= 0; i--) {
        const f = food[i];
        const dx = f.x - c.x; if (dx > r || dx < -r) continue;
        const dy = f.y - c.y; if (dy > r || dy < -r) continue;
        if (dx * dx + dy * dy < r * r) {
          c.mass += M.foodMass;
          if (c.owner.stats) c.owner.stats.food++;
          food[i] = food[food.length - 1]; food.pop();
        }
      }
    }

    // masa expulsada
    for (const c of allCells) {
      const r = radius(c.mass);
      for (let i = this.ejected.length - 1; i >= 0; i--) {
        const e = this.ejected[i];
        if (e.owner === c.owner && now - e.born < 400) continue;
        if (c.mass < e.mass * 1.1) continue;
        const dx = e.x - c.x; if (dx > r || dx < -r) continue;
        const dy = e.y - c.y; if (dy > r || dy < -r) continue;
        if (dx * dx + dy * dy < r * r) { c.mass += e.mass; this.ejected.splice(i, 1); }
      }
    }
    for (let i = this.ejected.length - 1; i >= 0; i--) {
      const e = this.ejected[i];
      for (const v of this.viruses) {
        if (Math.hypot(e.x - v.x, e.y - v.y) < radius(v.mass)) {
          v.mass += e.mass; v.feeds++;
          if (v.feeds >= 7) {
            v.feeds = 0; v.mass = 100;
            const d = Math.hypot(e.vx, e.vy) || 1;
            this.addVirus(v.x, v.y, (e.vx / d) * 22, (e.vy / d) * 22);
          }
          this.ejected.splice(i, 1);
          break;
        }
      }
    }

    // células se comen
    allCells.sort((a, b) => b.mass - a.mass);
    for (let i = 0; i < allCells.length; i++) {
      const big = allCells[i];
      if (big.mass <= 0) continue;
      const rb = radius(big.mass);
      const team = big.owner.team;
      for (let j = i + 1; j < allCells.length; j++) {
        const small = allCells[j];
        if (small.mass <= 0 || small.owner.team === team) continue;
        if (big.mass < small.mass * 1.25) break; // la lista está ordenada: el resto es más chico
        const rs = radius(small.mass);
        const dx = small.x - big.x; if (dx > rb || dx < -rb) continue;
        const dy = small.y - big.y; if (dy > rb || dy < -rb) continue;
        if (Math.hypot(dx, dy) < rb - rs * 0.35) { big.mass += small.mass; small.mass = 0; }
      }
    }

    // virus
    for (let i = this.viruses.length - 1; i >= 0; i--) {
      const v = this.viruses[i];
      const rv = radius(v.mass);
      for (const c of allCells) {
        if (c.mass <= 0 || c.mass < v.mass * 1.33) continue;
        const rc = radius(c.mass);
        if (Math.hypot(v.x - c.x, v.y - c.y) < rc - rv * 0.35) {
          this.popOnVirus(c, v);
          this.viruses.splice(i, 1);
          break;
        }
      }
    }

    // muertes
    for (const p of this.players.values()) {
      p.cells = p.cells.filter((c) => c.mass > 0);
      if (!p.alive) continue;
      const m = p.totalMass();
      if (p.stats && m > p.stats.maxMass) p.stats.maxMass = m;
      if (p.cells.length === 0) {
        p.alive = false; p.deadAt = now;
        if (p.conn) {
          const s = p.stats;
          p.conn.send({ t: 'dead', food: s.food, max: Math.floor(s.maxMass), time: Math.floor((now - s.start) / 1000),
            rank: s.bestRank < 99 ? s.bestRank : null });
        }
      }
    }

    let add = 0;
    while (this.food.length < M.food && add++ < 40) this.addFood();
    if (this.viruses.length < M.viruses && Math.random() < 0.03) this.addVirus();
    while (this.viruses.length > M.viruses * 2) this.viruses.shift();

    this.sendState();
  }

  // -------------------------------- red ---------------------------------
  broadcast(obj) {
    const data = wsFrame(1, Buffer.from(JSON.stringify(obj)));
    for (const p of this.players.values()) if (p.conn) p.conn.sendRaw(data);
  }

  sendState() {
    const sendFood = this.tickCount % 3 === 0;
    for (const p of this.players.values()) {
      if (!p.conn) continue;
      if (p.conn.socket.writableLength > 512 * 1024) continue;
      if (p.alive && p.cells.length) {
        let sx = 0, sy = 0, m = 0;
        for (const c of p.cells) { sx += c.x * c.mass; sy += c.y * c.mass; m += c.mass; }
        p.viewX = sx / m; p.viewY = sy / m;
        p.viewF = 1 + Math.sqrt(m) / 45 + Math.min(p.cells.length, 16) * 0.02;
      }
      const hw = 1100 * p.viewF;
      const x0 = p.viewX - hw, x1 = p.viewX + hw, y0 = p.viewY - hw, y1 = p.viewY + hw;
      const out = [];
      for (const q of this.players.values()) {
        const type = q === p ? 1 : (q.master === p ? 4 : 0);
        for (const c of q.cells) {
          const r = radius(c.mass);
          if (c.x + r < x0 || c.x - r > x1 || c.y + r < y0 || c.y - r > y1) continue;
          out.push([c.id, Math.round(c.x), Math.round(c.y), Math.round(r), q.id, type]);
        }
      }
      for (const v of this.viruses) {
        if (v.x < x0 - 150 || v.x > x1 + 150 || v.y < y0 - 150 || v.y > y1 + 150) continue;
        out.push([v.id, Math.round(v.x), Math.round(v.y), Math.round(radius(v.mass)), 0, 2]);
      }
      for (const e of this.ejected) {
        if (e.x < x0 || e.x > x1 || e.y < y0 || e.y > y1) continue;
        out.push([e.id, Math.round(e.x), Math.round(e.y), Math.round(radius(e.mass) * 0.6), e.owner.id, 3]);
      }
      const msg = { t: 's', x: Math.round(p.viewX), y: Math.round(p.viewY), f: +p.viewF.toFixed(3),
        m: Math.floor(p.alive ? p.totalMass() : 0), c: out };
      if (sendFood) {
        const fd = [];
        for (const f of this.food) {
          if (f.x < x0 || f.x > x1 || f.y < y0 || f.y > y1) continue;
          fd.push(Math.round(f.x), Math.round(f.y), f.c);
        }
        msg.fd = fd;
      }
      p.conn.send(msg);
    }

    if (this.tickCount % 12 === 0) {
      const ranked = [...this.players.values()].filter((p) => p.alive && !p.master)
        .map((p) => ({ p, m: p.totalMass() })).sort((a, b) => b.m - a.m);
      ranked.forEach((r, i) => { if (r.p.stats && i + 1 < r.p.stats.bestRank) r.p.stats.bestRank = i + 1; });
      const lb = ranked.slice(0, 10).map((r) => [r.p.id, r.p.name, Math.floor(r.m)]);
      this.broadcast({ t: 'lb', lb, on: this.humans() });
    }

    if (this.tickCount % 5 === 0) { // posiciones de la party (minimapa)
      const parties = new Map();
      for (const p of this.players.values()) {
        if (!p.party || !p.conn) continue;
        if (!parties.has(p.party)) parties.set(p.party, []);
        parties.get(p.party).push(p);
      }
      for (const [code, members] of parties) {
        const list = members.map((p) => [p.id, p.name, Math.round(p.viewX), Math.round(p.viewY), Math.floor(p.alive ? p.totalMass() : 0), p.alive ? 1 : 0]);
        const total = list.reduce((s, x) => s + x[4], 0);
        for (const p of members) p.conn.send({ t: 'party', code, list, total });
      }
    }
  }

  onMessage(conn, msg) {
    const p = conn.player;
    if (!p) return;
    switch (msg.t) {
      case 'join': {
        const name = cleanText(msg.name, 16) || 'Sin nombre';
        const skin = cleanSkin(msg.skin);
        p.name = name; p.skin = skin;
        p.wantsPlay = true;
        if (!p.alive) p.spawn();
        // minions en modo bots
        if (this.mode.minions && p.minions.length === 0) {
          for (let i = 0; i < this.mode.minions; i++) {
            const mn = new Player(this, name, true, null, p);
            p.minions.push(mn); this.players.set(mn.id, mn);
            mn.spawn();
          }
        }
        for (const mn of p.minions) { mn.name = name; mn.skin = skin; mn.color = p.color; }
        this.broadcast({ t: 'pi', p: [p.info(), ...p.minions.map((m) => m.info())] });
        break;
      }
      case 'm':
        if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
          p.tx = clamp(msg.x, -500, this.W + 500); p.ty = clamp(msg.y, -500, this.W + 500);
        }
        break;
      case 'split': this.multiSplit(p, clamp(Number(msg.n) || 1, 1, 6)); break;
      case 'eject': this.eject(p); for (const mn of p.minions) if (!p.minionCollect) this.eject(mn); break;
      case 'minion': p.minionCollect = !p.minionCollect; conn.send({ t: 'minion', collect: p.minionCollect }); break;
      case 'chat': {
        const now = Date.now();
        if (now - conn.lastChat < 700) return;
        conn.lastChat = now;
        const text = cleanText(msg.msg, 120);
        if (text) this.broadcast({ t: 'chat', id: p.id, n: p.name, c: p.color, msg: text });
        break;
      }
      case 'partyCreate': {
        p.party = crypto.randomBytes(3).toString('hex').toUpperCase();
        conn.send({ t: 'party', code: p.party, list: [], total: 0 });
        break;
      }
      case 'partyJoin': {
        const code = cleanText(msg.code, 10).toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (code.length >= 4) { p.party = code; conn.send({ t: 'party', code, list: [], total: 0 }); }
        break;
      }
      case 'partyLeave': p.party = ''; conn.send({ t: 'party', code: '', list: [], total: 0 }); break;
      case 'ping': conn.send({ t: 'pong', ts: msg.ts }); break;
    }
  }

  addConnection(conn) {
    const p = new Player(this, 'Sin nombre', false, conn);
    conn.player = p;
    conn.room = this;
    this.players.set(p.id, p);
    conn.send({ t: 'init', id: p.id, w: this.W, name: SERVER_NAME, mode: this.key, modeLabel: this.mode.label,
      colors: COLORS, minions: this.mode.minions, maxSplit: Math.log2(this.mode.maxCells) | 0 });
    conn.send({ t: 'pi', p: [...this.players.values()].map((q) => q.info()) });
  }

  removeConnection(conn) {
    const p = conn.player;
    if (!p) return;
    for (const mn of p.minions) this.players.delete(mn.id);
    this.players.delete(p.id);
    conn.player = null;
  }
}

// --------------------- WebSocket mínimo (RFC 6455) ---------------------
function wsFrame(op, payload) {
  const len = payload.length;
  let h;
  if (len < 126) h = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([h, payload]);
}

const rooms = {};
for (const k of ENABLED) rooms[k] = new Room(k);

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') return socket.destroy();
  const url = new URL(req.url || '/', 'http://x');
  const room = rooms[url.searchParams.get('mode')] || rooms[ENABLED[0]];
  if (room.humans() >= MAX_PLAYERS_PER_ROOM) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);

  const conn = {
    socket, open: true, lastChat: 0, player: null, room: null, msgCount: 0, msgWindow: Date.now(),
    sendRaw(buf) { if (this.open) socket.write(buf); },
    send(obj) { if (this.open) socket.write(wsFrame(1, Buffer.from(JSON.stringify(obj)))); },
    close() {
      if (!this.open) return;
      this.open = false;
      try { socket.end(wsFrame(8, Buffer.alloc(0))); } catch { /* ignore */ }
      cleanup();
    },
  };
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return; cleaned = true; conn.open = false;
    room.removeConnection(conn);
    console.log(`[-] ${room.key}: desconexión (${room.humans()} en sala)`);
  };
  room.addConnection(conn);
  console.log(`[+] ${room.key}: conexión (${room.humans()} en sala)`);

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > 65536n) return conn.close(); len = Number(big); off = 10; }
      if (len > 65536 || !masked) return conn.close();
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4); off += 4;
      const data = Buffer.from(buf.subarray(off, off + len));
      for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);
      if (op === 8) return conn.close();
      if (op === 9) { socket.write(wsFrame(10, data)); continue; }
      if (op !== 1) continue;
      // límite anti-spam: 120 mensajes/seg
      const now = Date.now();
      if (now - conn.msgWindow > 1000) { conn.msgWindow = now; conn.msgCount = 0; }
      if (++conn.msgCount > 120) continue;
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { continue; }
      if (msg && typeof msg === 'object') room.onMessage(conn, msg);
    }
  });
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

// ------------------------------ HTTP ----------------------------------
// index.html puede estar en /public o junto a server.js
const HAS_PUBLIC = fs.existsSync(path.join(__dirname, 'public', 'index.html'));
const PUBLIC = HAS_PUBLIC ? path.join(__dirname, 'public') : __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/modes') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ name: SERVER_NAME,
      modes: ENABLED.map((k) => ({ key: k, label: MODES[k].label, players: rooms[k].humans() })) }));
  }
  if (url === '/') url = '/index.html';
  if (!HAS_PUBLIC && url !== '/index.html') { res.writeHead(404); return res.end('No encontrado'); }
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
server.on('upgrade', handleUpgrade);

setInterval(() => {
  for (const r of Object.values(rooms)) {
    try { r.tick(); } catch (e) { console.error(`Error en sala ${r.key}:`, e); }
  }
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`\n  ${SERVER_NAME} corriendo en http://localhost:${PORT}`);
  console.log(`  Modos: ${ENABLED.map((k) => MODES[k].label).join(', ')}\n`);
});
