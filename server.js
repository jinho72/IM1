/**
 * INYUN Exhibition — Orchestration Server
 *
 * Manages:
 *  - User sessions (welcome → identity → lobby)
 *  - World State aggregation from all user intents (broadcast at 10Hz)
 *  - Blob DNA cross-influence between users in lobby
 *  - Artist / Master View (privileged WebSocket role)
 *  - Operator controls (pause, reset)
 *
 * Run:  npm install && node server.js
 * Port: 8080  (set PORT env var to override)
 *
 * Master View connection:
 *   ws://host?role=master&token=<MASTER_TOKEN>
 *   Set MASTER_TOKEN env var in Railway (default: 'inyun-master-2025')
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT            = process.env.PORT || 8080;
const MASTER_TOKEN    = process.env.MASTER_TOKEN || 'inyun-master-2025';
const TICK_HZ         = 10;
const MAX_USERS       = 50;
const CROSS_INFLUENCE = 0.004;   // bleed rate toward field average per tick
const IDENTITY_PULL   = 0.012;   // pull back toward own identity per tick

// ─── Operator state ───────────────────────────────────────────────────────────
let operatorState = { paused: false, safeMode: false };

// ─── World State ──────────────────────────────────────────────────────────────
let worldState = {
  mood: 'DRIFT', ai: 40, artist: 35, user: 25,
  energy: 0.5, density: 0.5, lobbyCount: 0, tick: 0,
};

// ─── Sessions & Masters ───────────────────────────────────────────────────────
const sessions = new Map();   // ws → session
const masters  = new Set();   // master WebSocket connections
let sessionCounter = 0;

function makeSession(ws) {
  return {
    id:           `P${String(++sessionCounter).padStart(3,'0')}`,
    ws,
    stage:        'welcome',   // welcome | identity | lobby
    identity:     null,
    intent:       { ai:33, artist:33, user:34 },
    blobDNA:      neutralDNA(),
    targetDNA:    neutralDNA(),
    joinedAt:     Date.now(),
    // Artist override fields (set by master view)
    clusterGroup:  null,
    artistOpacity: 1.0,
    artistScale:   1.0,
    artistOrbit:   0.5,
  };
}

// ─── Neutral (crystal) DNA ────────────────────────────────────────────────────
function neutralDNA() {
  return {
    color:        [0.72, 0.88, 1.0],
    freqs:        [1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
    amps:         [0.04, 0.04, 0.04, 0.04, 0.04, 0.04],
    phases:       [0.0,  0.0,  0.0,  0.0,  0.0,  0.0],
    glossiness:   0.95,
    transparency: 0.85,
    iridBase:     0.12,
    innerGlow:    0.08,
    breathFreq:   0.4,
    breathAmt:    0.006,
    rotXRate:     0.0003,
    rotYRate:     0.0008,
    rotZRate:     0.0002,
  };
}

// ─── Identity → DNA ───────────────────────────────────────────────────────────
function identityToDNA({ answers, imageHash, intent }) {
  const text = (answers || []).join(' ');
  let seed = imageHash || 0;
  for (let i = 0; i < text.length; i++)
    seed = ((seed << 5) - seed + text.charCodeAt(i)) | 0;
  seed = Math.abs(seed);

  const rng  = mulberry32(seed);
  const hue  = rng() * 360;
  const color = hslToRgb01(hue, 0.5 + rng()*0.5, 0.55 + rng()*0.3);

  const aiW  = (intent?.ai     ?? 33) / 100;
  const artW = (intent?.artist ?? 33) / 100;
  const usrW = (intent?.user   ?? 34) / 100;

  return {
    color,
    freqs:        Array.from({length:6}, () => 0.6 + rng()*2.2 + aiW*0.8),
    amps:         Array.from({length:6}, () => 0.06 + rng()*0.18 + artW*0.07),
    phases:       Array.from({length:6}, () => rng()*Math.PI*2*(1+usrW*0.5)),
    glossiness:   0.3 + rng()*0.6  + aiW*0.1,
    transparency: 0.3 + rng()*0.5,
    iridBase:     0.15 + rng()*0.55 + artW*0.15,
    innerGlow:    0.15 + rng()*0.6  + usrW*0.15,
    breathFreq:   0.3  + rng()*0.5,
    breathAmt:    0.01 + rng()*0.02,
    rotXRate:     (rng()-0.5)*0.0014,
    rotYRate:     0.0008 + rng()*0.0018,
    rotZRate:     (rng()-0.5)*0.0009,
  };
}

// ─── DNA helpers ──────────────────────────────────────────────────────────────
function avgDNA(list) {
  if (!list.length) return null;
  const n = list.length;
  const z = {
    color:[0,0,0], freqs:Array(6).fill(0), amps:Array(6).fill(0),
    phases:Array(6).fill(0), glossiness:0, transparency:0,
    iridBase:0, innerGlow:0,
  };
  for (const d of list) {
    z.color[0]+=d.color[0]; z.color[1]+=d.color[1]; z.color[2]+=d.color[2];
    for (let i=0;i<6;i++){z.freqs[i]+=d.freqs[i];z.amps[i]+=d.amps[i];z.phases[i]+=d.phases[i];}
    z.glossiness+=d.glossiness; z.transparency+=d.transparency;
    z.iridBase+=d.iridBase; z.innerGlow+=d.innerGlow;
  }
  z.color = z.color.map(v=>v/n);
  ['freqs','amps','phases'].forEach(k=>{ z[k]=z[k].map(v=>v/n); });
  ['glossiness','transparency','iridBase','innerGlow'].forEach(k=>{ z[k]/=n; });
  return z;
}

function lerpDNA(a, b, t) {
  const lv = (x,y) => x+(y-x)*t;
  return { ...a,
    color:        a.color.map((v,i)=>lv(v,b.color[i])),
    freqs:        a.freqs.map((v,i)=>lv(v,b.freqs[i])),
    amps:         a.amps.map((v,i)=>lv(v,b.amps[i])),
    phases:       a.phases.map((v,i)=>lv(v,b.phases[i])),
    glossiness:   lv(a.glossiness,   b.glossiness),
    transparency: lv(a.transparency, b.transparency),
    iridBase:     lv(a.iridBase,     b.iridBase),
    innerGlow:    lv(a.innerGlow,    b.innerGlow),
  };
}

// ─── Math utils ───────────────────────────────────────────────────────────────
function mulberry32(seed) {
  return function() {
    seed|=0; seed=seed+0x6D2B79F5|0;
    let t=Math.imul(seed^seed>>>15,1|seed);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return((t^t>>>14)>>>0)/4294967296;
  };
}
function hslToRgb01(h,s,l){
  h/=360;
  const q=l<0.5?l*(1+s):l+s-l*s, p=2*l-q;
  return [hr(p,q,h+1/3),hr(p,q,h),hr(p,q,h-1/3)];
}
function hr(p,q,t){
  if(t<0)t+=1;if(t>1)t-=1;
  if(t<1/6)return p+(q-p)*6*t;
  if(t<1/2)return q;
  if(t<2/3)return p+(q-p)*(2/3-t)*6;
  return p;
}
function clamp(v,a,b){ return Math.min(b,Math.max(a,v)); }

// ─── HTTP ─────────────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');

  if (req.url==='/health') {
    res.writeHead(200,{'Content-Type':'application/json'});
    const lobby = [...sessions.values()].filter(s=>s.stage==='lobby').length;
    res.end(JSON.stringify({
      status:'ok', total:sessions.size, lobby,
      masters: masters.size,
      world: worldState,
      operator: operatorState,
    }));
  } else if (req.url==='/' || req.url==='/index.html') {
    const filePath = path.join(__dirname, 'companion_v8.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('companion_v8.html not found'); return; }
      res.writeHead(200, {'Content-Type':'text/html'});
      res.end(data);
    });
  } else if (req.url==='/master' || req.url==='/master.html') {
    const filePath = path.join(__dirname, 'companion-master.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('companion-master.html not found'); return; }
      res.writeHead(200, {'Content-Type':'text/html'});
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end();
  }
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {

  // ── Parse role from query string ──────────────────────────────────────────
  // Users connect as:   ws://host/
  // Master connects as: ws://host/?role=master&token=<MASTER_TOKEN>
  const url   = new URL(req.url, `http://localhost`);
  const role  = url.searchParams.get('role');
  const token = url.searchParams.get('token');

  // ── Master connection ──────────────────────────────────────────────────────
  if (role === 'master') {
    if (token !== MASTER_TOKEN) {
      log(`⛔  Master rejected — bad token`);
      ws.close(1008, 'Unauthorized');
      return;
    }
    masters.add(ws);
    log(`🎛️  Master connected  (${masters.size} master(s) active)`);

    // Send full current snapshot immediately
    sendMasterSnapshot(ws);

    ws.on('message', raw => handleMasterMessage(ws, raw));

    ws.on('close', () => {
      masters.delete(ws);
      log(`🎛️  Master disconnected  (${masters.size} master(s) remaining)`);
    });

    ws.on('error', e => log(`⚠️  Master WS error: ${e.message}`));
    return; // do not fall through to user session logic
  }

  // ── User connection ────────────────────────────────────────────────────────
  if (sessions.size >= MAX_USERS) { ws.close(1013,'Full'); return; }

  const s = makeSession(ws);
  sessions.set(ws, s);
  log(`🔌 ${s.id} connected  (${sessions.size} total)`);

  send(ws, { type:'welcome', payload:{
    sessionId:  s.id,
    world:      worldState,
    neutralDNA: neutralDNA(),
    questions:  QUESTIONS,
  }});

  ws.on('message', raw => {
    let msg; try { msg=JSON.parse(raw); } catch { return; }
    const s = sessions.get(ws);
    if (!s) return;

    switch (msg.type) {

      case 'submit_identity': {
        const { answers, imageHash, intent } = msg.payload||{};
        s.identity  = { answers: answers||[], imageHash: imageHash||0, intent: intent||s.intent };
        s.intent    = intent || s.intent;
        s.blobDNA   = identityToDNA(s.identity);
        s.targetDNA = {...s.blobDNA};
        s.stage     = 'lobby';
        log(`🧬 ${s.id} → lobby  (${lobbyCount()} in lobby)`);
        send(ws, { type:'identity_confirmed', payload:{ dna:s.blobDNA } });
        broadcastPresence();
        // Notify masters of new blob
        broadcastMaster({
          type: 'blob_joined',
          payload: sessionToMasterBlob(s),
        });
        break;
      }

      case 'update_intent': {
        const {ai,artist,user:u} = msg.payload||{};
        s.intent = {
          ai:     clamp(+ai||33,     0, 100),
          artist: clamp(+artist||33, 0, 100),
          user:   clamp(+u||34,      0, 100),
        };
        if (s.identity) { s.identity.intent=s.intent; s.targetDNA=identityToDNA(s.identity); }
        break;
      }

      case 'operator': {
        const {action} = msg.payload||{};
        if (action==='pause') {
          operatorState.paused = !operatorState.paused;
          broadcast({type:'operator_state', payload:operatorState});
          broadcastMaster({type:'operator_state', payload:operatorState});
          log(`⏸  ${operatorState.paused?'PAUSED':'RESUMED'}`);
        } else if (action==='reset') {
          for (const [,sess] of sessions) {
            sess.stage    = 'welcome';
            sess.identity = null;
            sess.blobDNA  = neutralDNA();
            sess.targetDNA = neutralDNA();
            sess.clusterGroup  = null;
            sess.artistOpacity = 1.0;
            sess.artistScale   = 1.0;
            sess.artistOrbit   = 0.5;
          }
          broadcast({type:'reset', payload:{}});
          broadcastMaster({type:'reset', payload:{}});
          log('🔄 RESET');
        }
        break;
      }

      case 'ping': send(ws,{type:'pong',payload:{ts:Date.now()}}); break;
    }
  });

  ws.on('close', () => {
    const leaving = sessions.get(ws);
    log(`❌ ${leaving?.id} left  (${sessions.size-1} remaining)`);
    // Notify masters before deleting
    if (leaving) {
      broadcastMaster({ type:'blob_left', payload:{ id: leaving.id } });
    }
    sessions.delete(ws);
    broadcastPresence();
  });

  ws.on('error', e => log(`⚠️  ${e.message}`));
});

// ─── Master message handler ───────────────────────────────────────────────────
function handleMasterMessage(ws, raw) {
  let msg; try { msg=JSON.parse(raw); } catch { return; }

  switch (msg.type) {

    // Cluster a set of blobs together
    case 'master_cluster': {
      const { ids, groupId } = msg.payload||{};
      if (!ids?.length || !groupId) break;
      for (const [,s] of sessions) {
        if (ids.includes(s.id)) {
          s.clusterGroup = groupId;
          send(s.ws, { type:'cluster_assigned', payload:{ groupId } });
        }
      }
      // Echo update back to all masters
      broadcastMaster({ type:'cluster_update', payload:{ ids, groupId } });
      log(`🎛️  Cluster ${groupId}: [${ids.join(', ')}]`);
      break;
    }

    // Dissolve a cluster group
    case 'master_decluster': {
      const { groupId } = msg.payload||{};
      if (!groupId) break;
      const affected = [];
      for (const [,s] of sessions) {
        if (s.clusterGroup === groupId) {
          s.clusterGroup = null;
          send(s.ws, { type:'cluster_removed', payload:{} });
          affected.push(s.id);
        }
      }
      broadcastMaster({ type:'decluster_update', payload:{ groupId, affected } });
      log(`🎛️  Decluster ${groupId}: [${affected.join(', ')}]`);
      break;
    }

    // Override a single blob's visual properties
    case 'master_override': {
      const { id, opacity, scale, orbit } = msg.payload||{};
      const target = [...sessions.values()].find(s => s.id === id);
      if (!target) break;
      if (opacity !== undefined) target.artistOpacity = clamp(opacity / 100, 0, 1);
      if (scale   !== undefined) target.artistScale   = clamp(scale   / 100, 0.3, 2);
      if (orbit   !== undefined) target.artistOrbit   = clamp(orbit   / 100, 0, 1);
      send(target.ws, { type:'artist_override', payload:{ opacity, scale, orbit } });
      log(`🎛️  Override ${id}: op=${opacity} sc=${scale} or=${orbit}`);
      break;
    }

    // Dissolve every cluster and scatter all blobs
    case 'master_explode_all': {
      for (const [,s] of sessions) {
        if (s.clusterGroup) {
          s.clusterGroup = null;
          send(s.ws, { type:'cluster_removed', payload:{} });
        }
      }
      broadcast({ type:'field_explode', payload:{} });
      broadcastMaster({ type:'explode_confirmed', payload:{} });
      log('💥  EXPLODE ALL');
      break;
    }

    // Master pause/resume (same as operator)
    case 'master_pause': {
      operatorState.paused = !operatorState.paused;
      broadcast({ type:'operator_state', payload:operatorState });
      broadcastMaster({ type:'operator_state', payload:operatorState });
      log(`🎛️  ${operatorState.paused?'PAUSED':'RESUMED'} via master`);
      break;
    }

    // Request a fresh full snapshot
    case 'master_snapshot_request': {
      sendMasterSnapshot(ws);
      break;
    }

    case 'ping': send(ws,{type:'pong',payload:{ts:Date.now()}}); break;
  }
}

// ─── World tick ───────────────────────────────────────────────────────────────
setInterval(() => {
  if (operatorState.paused) return;
  worldState.tick++;

  const lobby = [...sessions.values()].filter(s=>s.stage==='lobby');
  worldState.lobbyCount = lobby.length;

  // DNA cross-influence
  if (lobby.length > 1) {
    const avg = avgDNA(lobby.map(s=>s.blobDNA));
    for (const s of lobby) {
      s.blobDNA = lerpDNA(s.blobDNA, avg,         CROSS_INFLUENCE);
      s.blobDNA = lerpDNA(s.blobDNA, s.targetDNA, IDENTITY_PULL);
    }
  }

  // Aggregate world state from intents
  if (lobby.length) {
    let ai=0,art=0,usr=0,glow=0,gloss=0;
    for (const s of lobby) {
      ai+=s.intent.ai; art+=s.intent.artist; usr+=s.intent.user;
      glow+=s.blobDNA.innerGlow; gloss+=s.blobDNA.glossiness;
    }
    const n = lobby.length;
    worldState.ai     = Math.round(ai/n);
    worldState.artist = Math.round(art/n);
    worldState.user   = Math.round(usr/n);
    worldState.energy  = glow/n;
    worldState.density = gloss/n;
    const e = worldState.energy;
    worldState.mood = e>0.75?'SURGE':e>0.6?'PULSE':e>0.45?'BLOOM':e>0.35?'DRIFT':e>0.25?'ERODE':e>0.15?'STILL':'VOID';
  }

  // Push tick to each lobby user
  for (const [ws, s] of sessions) {
    if (s.stage !== 'lobby') continue;
    const others = lobby.filter(o=>o!==s).map(o=>({
      id:         o.id,
      color:      o.blobDNA.color,
      innerGlow:  o.blobDNA.innerGlow,
      glossiness: o.blobDNA.glossiness,
      breathAmt:  o.blobDNA.breathAmt,
      clusterGroup: o.clusterGroup || null,
    }));
    send(ws, { type:'tick', payload:{
      world:   worldState,
      myDNA:   s.blobDNA,
      // Pass artist overrides so client can apply them
      artistOverride: {
        opacity: s.artistOpacity,
        scale:   s.artistScale,
        orbit:   s.artistOrbit,
      },
      others,
    }});
  }

  // Push master tick at same rate (10Hz)
  if (masters.size > 0) {
    const masterPayload = {
      type: 'master_tick',
      payload: {
        world: worldState,
        blobs: lobby.map(s => sessionToMasterBlob(s)),
      },
    };
    const str = JSON.stringify(masterPayload);
    for (const mws of masters) {
      if (mws.readyState === mws.OPEN) mws.send(str);
    }
  }

}, 1000 / TICK_HZ);

// ─── Master helpers ───────────────────────────────────────────────────────────

// Serialize a session into the shape the master view expects
function sessionToMasterBlob(s) {
  return {
    id:           s.id,
    color:        s.blobDNA.color,
    intent:       s.intent,
    dna: {
      gloss: s.blobDNA.glossiness.toFixed(2),
      irid:  s.blobDNA.iridBase.toFixed(2),
      glow:  s.blobDNA.innerGlow.toFixed(2),
      speed: s.blobDNA.breathFreq.toFixed(2),
    },
    clusterGroup:  s.clusterGroup  || null,
    artistOpacity: s.artistOpacity != null ? s.artistOpacity : 1.0,
    artistScale:   s.artistScale   != null ? s.artistScale   : 1.0,
    artistOrbit:   s.artistOrbit   != null ? s.artistOrbit   : 0.5,
    joinedAt:      s.joinedAt,
    stage:         s.stage,
  };
}

// Send the full current field state to a master on connect
function sendMasterSnapshot(ws) {
  const lobby = [...sessions.values()].filter(s=>s.stage==='lobby');
  send(ws, {
    type: 'master_snapshot',
    payload: {
      world:         worldState,
      operator:      operatorState,
      blobs:         lobby.map(sessionToMasterBlob),
      totalSessions: sessions.size,
    },
  });
  log(`🎛️  Snapshot sent: ${lobby.length} blobs in lobby`);
}

// Broadcast a message to all connected master views
function broadcastMaster(obj) {
  if (!masters.size) return;
  const str = JSON.stringify(obj);
  for (const mws of masters) {
    if (mws.readyState === mws.OPEN) mws.send(str);
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────
function lobbyCount() { return [...sessions.values()].filter(s=>s.stage==='lobby').length; }

function broadcastPresence() {
  const payload = { lobbyCount: lobbyCount(), total: sessions.size };
  broadcast({ type:'presence', payload });
  broadcastMaster({ type:'presence', payload });
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const str = JSON.stringify(obj);
  for (const [ws] of sessions) {
    if (ws.readyState === ws.OPEN) ws.send(str);
  }
}

function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }

// ─── Questions ────────────────────────────────────────────────────────────────
const QUESTIONS = [
  { id:'q1', prompt:'What brought you here today?',    placeholder:'A word, a feeling, a reason…' },
  { id:'q2', prompt:'What are you carrying with you?', placeholder:'Something on your mind, body, or soul…' },
  { id:'q3', prompt:'What do you want to leave behind?', placeholder:'Let it dissolve here…' },
];

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  log(`✅  Server running on port ${PORT}`);
  log(`    Users:  ws://localhost:${PORT}/`);
  log(`    Master: ws://localhost:${PORT}/?role=master&token=${MASTER_TOKEN}`);
  log(`    Health: http://localhost:${PORT}/health`);
  log(`    Master: http://localhost:${PORT}/master`);
});

process.on('SIGTERM', () => {
  wss.close(() => httpServer.close(() => process.exit(0)));
});
