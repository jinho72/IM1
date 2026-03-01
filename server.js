/**
 * Companion Exhibition — Orchestration Server
 * 
 * Manages:
 *  - User sessions (welcome → identity → lobby)
 *  - World State aggregation from all user intents (broadcast at 10Hz)
 *  - Blob DNA cross-influence between users in lobby
 *  - Operator controls (pause, reset)
 * 
 * Run:  npm install && node server.js
 * Port: 8080  (set PORT env var to override)
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT               = process.env.PORT || 8080;
const TICK_HZ            = 10;
const MAX_USERS          = 50;
const CROSS_INFLUENCE    = 0.004;   // bleed rate toward field average per tick
const IDENTITY_PULL      = 0.012;   // pull back toward own identity per tick

// ─── Operator state ───────────────────────────────────────────────────────────
let operatorState = { paused: false, safeMode: false };

// ─── World State ──────────────────────────────────────────────────────────────
let worldState = {
  mood: 'DRIFT', ai: 40, artist: 35, user: 25,
  energy: 0.5, density: 0.5, lobbyCount: 0, tick: 0,
};

// ─── Sessions ─────────────────────────────────────────────────────────────────
const sessions = new Map();   // ws → session
let sessionCounter = 0;

function makeSession(ws) {
  return {
    id: `P${String(++sessionCounter).padStart(3,'0')}`,
    ws,
    stage: 'welcome',          // welcome | identity | lobby
    identity: null,
    intent: { ai:33, artist:33, user:34 },
    blobDNA: neutralDNA(),
    targetDNA: neutralDNA(),
    joinedAt: Date.now(),
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

  const aiW   = (intent?.ai     ?? 33) / 100;
  const artW  = (intent?.artist ?? 33) / 100;
  const usrW  = (intent?.user   ?? 34) / 100;

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
  const z = { color:[0,0,0], freqs:Array(6).fill(0), amps:Array(6).fill(0),
               phases:Array(6).fill(0), glossiness:0, transparency:0,
               iridBase:0, innerGlow:0 };
  for (const d of list) {
    z.color[0]+=d.color[0]; z.color[1]+=d.color[1]; z.color[2]+=d.color[2];
    for (let i=0;i<6;i++){z.freqs[i]+=d.freqs[i];z.amps[i]+=d.amps[i];z.phases[i]+=d.phases[i];}
    z.glossiness+=d.glossiness; z.transparency+=d.transparency;
    z.iridBase+=d.iridBase; z.innerGlow+=d.innerGlow;
  }
  z.color=z.color.map(v=>v/n);
  ['freqs','amps','phases'].forEach(k=>{ z[k]=z[k].map(v=>v/n); });
  ['glossiness','transparency','iridBase','innerGlow'].forEach(k=>{ z[k]/=n; });
  return z;
}

function lerpDNA(a, b, t) {
  const lv=(x,y)=>x+(y-x)*t;
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
function clamp(v,a,b){return Math.min(b,Math.max(a,v));}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  if (req.url==='/health') {
    res.writeHead(200,{'Content-Type':'application/json'});
    const lobby = [...sessions.values()].filter(s=>s.stage==='lobby').length;
    res.end(JSON.stringify({status:'ok',total:sessions.size,lobby,world:worldState,operator:operatorState}));
  } else if (req.url==='/' || req.url==='/index.html') {
    const filePath = path.join(__dirname, 'companion_v7_buttonchange_accessible.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('companion_v7_buttonchange_accessible.html not found'); return; }
      res.writeHead(200, {'Content-Type':'text/html'});
      res.end(data);
    });
  } else { res.writeHead(404); res.end(); }
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  if (sessions.size >= MAX_USERS) { ws.close(1013,'Full'); return; }

  const s = makeSession(ws);
  sessions.set(ws, s);
  log(`🔌 ${s.id} connected  (${sessions.size} total)`);

  send(ws, { type:'welcome', payload:{
    sessionId: s.id,
    world: worldState,
    neutralDNA: neutralDNA(),
    questions: QUESTIONS,
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
        break;
      }

      case 'update_intent': {
        const {ai,artist,user:u}=msg.payload||{};
        s.intent={ai:clamp(+ai||33,0,100),artist:clamp(+artist||33,0,100),user:clamp(+u||34,0,100)};
        if (s.identity) { s.identity.intent=s.intent; s.targetDNA=identityToDNA(s.identity); }
        break;
      }

      case 'operator': {
        const {action}=msg.payload||{};
        if (action==='pause') {
          operatorState.paused=!operatorState.paused;
          broadcast({type:'operator_state',payload:operatorState});
          log(`⏸  ${operatorState.paused?'PAUSED':'RESUMED'}`);
        } else if (action==='reset') {
          for (const [,sess] of sessions) {
            sess.stage='welcome'; sess.identity=null;
            sess.blobDNA=neutralDNA(); sess.targetDNA=neutralDNA();
          }
          broadcast({type:'reset',payload:{}});
          log('🔄 RESET');
        }
        break;
      }

      case 'ping': send(ws,{type:'pong',payload:{ts:Date.now()}}); break;
    }
  });

  ws.on('close', () => {
    log(`❌ ${sessions.get(ws)?.id} left  (${sessions.size-1} remaining)`);
    sessions.delete(ws);
    broadcastPresence();
  });
  ws.on('error', e => log(`⚠️  ${e.message}`));
});

// ─── World tick ───────────────────────────────────────────────────────────────
setInterval(() => {
  if (operatorState.paused) return;
  worldState.tick++;

  const lobby = [...sessions.values()].filter(s=>s.stage==='lobby');
  worldState.lobbyCount = lobby.length;

  if (lobby.length > 1) {
    const avg = avgDNA(lobby.map(s=>s.blobDNA));
    for (const s of lobby) {
      s.blobDNA = lerpDNA(s.blobDNA, avg,        CROSS_INFLUENCE);
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
    const n=lobby.length;
    worldState.ai=Math.round(ai/n); worldState.artist=Math.round(art/n); worldState.user=Math.round(usr/n);
    worldState.energy=glow/n; worldState.density=gloss/n;
    const e=worldState.energy;
    worldState.mood = e>0.75?'SURGE':e>0.6?'PULSE':e>0.45?'BLOOM':e>0.35?'DRIFT':e>0.25?'ERODE':e>0.15?'STILL':'VOID';
  }

  // Push tick to each lobby client
  for (const [ws, s] of sessions) {
    if (s.stage!=='lobby') continue;
    const others = lobby.filter(o=>o!==s).map(o=>({
      id:o.id, color:o.blobDNA.color, innerGlow:o.blobDNA.innerGlow,
      glossiness:o.blobDNA.glossiness, breathAmt:o.blobDNA.breathAmt,
    }));
    send(ws, { type:'tick', payload:{ world:worldState, myDNA:s.blobDNA, others } });
  }
}, 1000/TICK_HZ);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function lobbyCount(){ return [...sessions.values()].filter(s=>s.stage==='lobby').length; }
function broadcastPresence(){ broadcast({type:'presence',payload:{lobbyCount:lobbyCount(),total:sessions.size}}); }
function send(ws,obj){ if(ws.readyState===ws.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(obj){ const s=JSON.stringify(obj); for(const[ws]of sessions) if(ws.readyState===ws.OPEN) ws.send(s); }
function log(msg){ console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }

// ─── Questions ────────────────────────────────────────────────────────────────
const QUESTIONS = [
  { id:'q1', prompt:'What brought you here today?',          placeholder:'A word, a feeling, a reason…' },
  { id:'q2', prompt:'What are you carrying with you?',        placeholder:'Something on your mind, body, or soul…' },
  { id:'q3', prompt:'What do you want to leave behind?',      placeholder:'Let it dissolve here…' },
];

httpServer.listen(PORT, () => {
  log(`✅  ws://localhost:${PORT}   health: http://localhost:${PORT}/health`);
});
process.on('SIGTERM', ()=>{ wss.close(()=>httpServer.close(()=>process.exit(0))); });
