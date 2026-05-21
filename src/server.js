const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SESSION_DURATION_MS = 60 * 60 * 1000;   // 1 heure
const GRACE_PERIOD_MS     = 10 * 60 * 1000;   // 10 min de grâce
const NO_SHOW_TIMEOUT_MS  =  5 * 60 * 1000;   // 5 min no-show
const HOURLY_RATE         = 12;                // €/heure

// ─── ÉTAT ─────────────────────────────────────────────────────────────────────
const state = {
  // status: 'waiting' | 'assigned' | 'playing' | 'no_show' | 'done'
  queue: [],

  // 10 anglaises + 1 française
  billiards: [
    ...Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      type: 'english',
      label: `Billard ${i + 1}`,
      status: 'free',
      queueId: null,
      tableNum: null,
      sessionStart: null,
      assignedAt: null,
    })),
    {
      id: 11,
      type: 'french',
      label: 'Billard Français',
      status: 'free',
      queueId: null,
      tableNum: null,
      sessionStart: null,
      assignedAt: null,
    },
  ],

  // Historique soirée
  history: [],
  // { id, tableNum, billiardId, billiardType, joinedAt, startedAt, endedAt,
  //   waitMins, sessionMins, overtimeMins, supplement, reason: 'normal'|'no_show'|'removed' }

  eveningStart: Date.now(),
};

// ─── UTILITAIRES ─────────────────────────────────────────────────────────────
function minsAgo(ts) { return ts ? Math.floor((Date.now() - ts) / 60000) : 0; }
function secsLeft(ts, dur) { return ts ? Math.max(0, Math.floor((ts + dur - Date.now()) / 1000)) : 0; }
function freeBilliards() { return state.billiards.filter(b => b.status === 'free'); }
function waitingQueue() { return state.queue.filter(q => q.status === 'waiting'); }

// Calcul supplément : temps dépassé au-delà de 1h, proratisé au tarif horaire
function calcSupplement(sessionStart) {
  if (!sessionStart) return 0;
  const totalMs = Date.now() - sessionStart;
  const overtimeMs = Math.max(0, totalMs - SESSION_DURATION_MS);
  const overtimeMins = overtimeMs / 60000;
  return Math.round((overtimeMins / 60) * HOURLY_RATE * 100) / 100;
}

function calcOvertimeMins(sessionStart) {
  if (!sessionStart) return 0;
  return Math.max(0, Math.floor((Date.now() - sessionStart - SESSION_DURATION_MS) / 60000));
}

function estimateWaitMins(posInQueue, preferredType) {
  const type = preferredType || 'english';
  const playing = state.billiards
    .filter(b => b.type === type && b.sessionStart && (b.status === 'playing' || b.status === 'overtime'))
    .map(b => Math.max(0, Math.ceil((b.sessionStart + SESSION_DURATION_MS - Date.now()) / 60000)))
    .sort((a, b) => a - b);

  if (playing.length === 0) return 0;

  // Pour le français (1 seule table) : position 1 = temps restant, position 2 = temps restant + 60, etc.
  // Pour l'anglais (10 tables) : répartition sur les tables disponibles
  if (type === 'french') {
    const baseWait = playing[0]; // temps restant sur la seule table française
    return baseWait + (posInQueue - 1) * 60;
  }

  const idx = Math.min(posInQueue - 1, playing.length - 1);
  return playing[idx];
}

// ─── STATS SOIRÉE ────────────────────────────────────────────────────────────
function computeStats() {
  const h = state.history;
  const completed = h.filter(e => e.sessionMins > 0);
  const totalSessions = completed.length;
  const avgSessionMins = totalSessions
    ? Math.round(completed.reduce((s, e) => s + e.sessionMins, 0) / totalSessions)
    : 0;
  const avgWaitMins = totalSessions
    ? Math.round(completed.filter(e => e.waitMins >= 0).reduce((s, e) => s + e.waitMins, 0) / totalSessions)
    : 0;
  const totalNoShows = h.filter(e => e.reason === 'no_show').length;
  const totalSupplements = h.reduce((s, e) => s + (e.supplement || 0), 0);
  const totalRevenue = (totalSessions * HOURLY_RATE) + totalSupplements;

  // Pic d'affluence : heure avec le plus d'entrées en file
  const byHour = {};
  h.forEach(e => {
    const hour = new Date(e.joinedAt).getHours();
    byHour[hour] = (byHour[hour] || 0) + 1;
  });
  const peakHour = Object.keys(byHour).sort((a,b) => byHour[b]-byHour[a])[0];

  // Par table de billard
  const perBilliard = state.billiards.map(b => {
    const sessions = completed.filter(e => e.billiardId === b.id);
    return {
      id: b.id,
      label: b.label,
      type: b.type,
      sessions: sessions.length,
      avgMins: sessions.length
        ? Math.round(sessions.reduce((s,e) => s+e.sessionMins,0) / sessions.length)
        : 0,
    };
  });

  // Actuellement en jeu
  const activeSessions = state.billiards.filter(
    b => b.status === 'playing' || b.status === 'overtime' || b.status === 'waiting_start'
  ).length;

  return {
    totalSessions,
    avgSessionMins,
    avgWaitMins,
    totalNoShows,
    totalSupplements: Math.round(totalSupplements * 100) / 100,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    peakHour: peakHour ? `${peakHour}h` : '—',
    perBilliard,
    activeSessions,
    queueLength: waitingQueue().length,
    eveningDuration: minsAgo(state.eveningStart),
    hourlyRate: HOURLY_RATE,
  };
}

// ─── BROADCAST ───────────────────────────────────────────────────────────────
function broadcastState() {
  const wq = waitingQueue();
  // File par type pour calculer les positions correctement
  const wqEnglish = wq.filter(q => (q.preferredType || 'english') === 'english');
  const wqFrench  = wq.filter(q => q.preferredType === 'french');

  const payload = {
    queue: state.queue
      .filter(q => !['done', 'no_show'].includes(q.status))
      .map(q => {
        const typeQueue = q.preferredType === 'french' ? wqFrench : wqEnglish;
        const posInType = typeQueue.indexOf(q); // position dans SA file de type
        const posGlobal = wq.indexOf(q);
        return {
          ...q,
          position: posInType >= 0 ? posInType + 1 : null,
          positionGlobal: posGlobal + 1,
          waitMins: minsAgo(q.joinedAt),
          estimatedWaitMins: posInType >= 0 ? estimateWaitMins(posInType + 1, q.preferredType) : 0,
        };
      }),
    billiards: state.billiards.map(b => ({
      ...b,
      sessionSecsLeft: secsLeft(b.sessionStart, SESSION_DURATION_MS),
      sessionMins: minsAgo(b.sessionStart),
      noShowSecsLeft: secsLeft(b.assignedAt, NO_SHOW_TIMEOUT_MS),
      overtimeMins: calcOvertimeMins(b.sessionStart),
      supplement: calcSupplement(b.sessionStart),
    })),
    stats: computeStats(),
    availability: {
      freeEnglish: state.billiards.filter(b => b.type === 'english' && b.status === 'free').length,
      freeFrench: state.billiards.filter(b => b.type === 'french' && b.status === 'free').length,
      totalEnglish: 10,
      totalFrench: 1,
    },
  };
  io.emit('state', payload);
}

// ─── AUTO-ASSIGN ─────────────────────────────────────────────────────────────
function freeBilliardsByType(type) {
  return state.billiards.filter(b => b.status === 'free' && b.type === type);
}

function tryAutoAssign(queueId) {
  const entry = state.queue.find(q => q.id === queueId);
  if (!entry || entry.status !== 'waiting') return;

  const type = entry.preferredType || 'english';
  const freeOfType = freeBilliardsByType(type);

  // Français : file stricte, pas de substitution automatique
  // Anglais : file normale
  if (freeOfType.length === 0) {
    // Pas de table dispo du bon type → rester en file, envoyer info au client
    io.emit('table_type_unavailable', {
      tableNum: entry.tableNum,
      preferredType: type,
      freeEnglish: freeBilliardsByType('english').length,
    });
    broadcastState();
    return;
  }

  const billiard = freeOfType[0];
  billiard.status = 'waiting_start';
  billiard.queueId = entry.id;
  billiard.tableNum = entry.tableNum;
  billiard.assignedAt = Date.now();

  entry.status = 'assigned';
  entry.billiardId = billiard.id;

  const bid = billiard.id;
  setTimeout(() => checkNoShow(entry.id, bid), NO_SHOW_TIMEOUT_MS + 500);

  io.emit('staff_sound', { type: 'assigned' });
  broadcastState();
}

function checkNoShow(queueId, billiardId) {
  const billiard = state.billiards.find(b => b.id === billiardId);
  if (!billiard || billiard.status !== 'waiting_start') return;
  const entry = state.queue.find(q => q.id === queueId);
  if (entry) {
    entry.status = 'no_show';
    state.history.push({
      id: uuidv4(),
      tableNum: entry.tableNum,
      billiardId,
      billiardType: billiard.type,
      joinedAt: entry.joinedAt,
      startedAt: null,
      endedAt: Date.now(),
      waitMins: minsAgo(entry.joinedAt),
      sessionMins: 0,
      overtimeMins: 0,
      supplement: 0,
      reason: 'no_show',
    });
  }
  billiard.status = 'free';
  billiard.queueId = null;
  billiard.tableNum = null;
  billiard.assignedAt = null;

  io.emit('no_show_client', { tableNum: entry ? entry.tableNum : null });
  io.emit('staff_sound', { type: 'no_show' });

  const next = waitingQueue()[0];
  if (next) tryAutoAssign(next.id);
  else broadcastState();
}

// ─── OVERTIME ────────────────────────────────────────────────────────────────
function triggerOvertimeAlert(billiardId) {
  const billiard = state.billiards.find(b => b.id === billiardId);
  if (!billiard || billiard.status !== 'playing') return;
  billiard.status = 'overtime';
  const mustLeave = waitingQueue().length > 0;
  io.emit('overtime_alert', { billiardId, tableNum: billiard.tableNum, mustLeave });
  io.emit('staff_sound', { type: 'overtime' });
  setTimeout(() => {
    const b = state.billiards.find(b => b.id === billiardId);
    if (b && b.status === 'overtime') io.emit('overtime_urgent', { billiardId, tableNum: b.tableNum });
  }, GRACE_PERIOD_MS);
  broadcastState();
}

function freeTable(billiardId) {
  const billiard = state.billiards.find(b => b.id === billiardId);
  if (!billiard) return;
  const entry = state.queue.find(q => q.id === billiard.queueId);

  if (entry && billiard.sessionStart) {
    const sessionMins = minsAgo(billiard.sessionStart);
    const overtimeMins = calcOvertimeMins(billiard.sessionStart);
    const supplement = calcSupplement(billiard.sessionStart);
    state.history.push({
      id: uuidv4(),
      tableNum: billiard.tableNum,
      billiardId,
      billiardType: billiard.type,
      joinedAt: entry.joinedAt,
      startedAt: billiard.sessionStart,
      endedAt: Date.now(),
      waitMins: entry.joinedAt ? Math.floor((billiard.sessionStart - entry.joinedAt) / 60000) : 0,
      sessionMins,
      overtimeMins,
      supplement,
      reason: 'normal',
    });
  }

  if (entry) entry.status = 'done';
  const freedType = billiard.type;
  billiard.status = 'free';
  billiard.queueId = null;
  billiard.tableNum = null;
  billiard.sessionStart = null;
  billiard.assignedAt = null;

  // Priorité : quelqu'un qui attendait CE type spécifique, sinon premier de la file
  const wq = waitingQueue();
  const nextSameType = wq.find(q => q.preferredType === freedType);
  const next = nextSameType || wq[0];
  if (next) tryAutoAssign(next.id);
  else broadcastState();
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.get('/table/:num', (req, res) => res.sendFile(path.join(__dirname, '../public/client.html')));
app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, '../public/staff.html')));

// Export CSV historique
app.get('/export-csv', (req, res) => {
  const rows = ['Table,Billard,Type,Arrivée,Début,Fin,Attente(min),Session(min),Overtime(min),Supplément(€),Statut'];
  state.history.forEach(e => {
    const fmt = ts => ts ? new Date(ts).toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'}) : '—';
    rows.push([
      e.tableNum, e.billiardId, e.billiardType === 'french' ? 'Française' : 'Anglaise',
      fmt(e.joinedAt), fmt(e.startedAt), fmt(e.endedAt),
      e.waitMins, e.sessionMins, e.overtimeMins, e.supplement, e.reason,
    ].join(','));
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="soiree-${new Date().toLocaleDateString('fr-FR').replace(/\//g,'-')}.csv"`);
  res.send(rows.join('\n'));
});

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  broadcastState();

  socket.on('join_queue', ({ tableNum, preferredType }) => {
    tableNum = parseInt(tableNum);
    const existing = state.queue.find(q => q.tableNum === tableNum && !['done','no_show','playing'].includes(q.status));
    if (existing) { socket.emit('join_result', { success: false, reason: 'already_in' }); return; }
    const entry = { id: uuidv4(), tableNum, preferredType: preferredType || 'english', joinedAt: Date.now(), status: 'waiting', billiardId: null };
    state.queue.push(entry);
    socket.emit('join_result', { success: true, queueId: entry.id });
    io.emit('staff_sound', { type: 'new_entry' });
    tryAutoAssign(entry.id);
  });

  socket.on('leave_queue', ({ tableNum }) => {
    tableNum = parseInt(tableNum);
    const entry = state.queue.find(q => q.tableNum === tableNum && q.status === 'waiting');
    if (entry) {
      entry.status = 'done';
      state.history.push({
        id: uuidv4(), tableNum, billiardId: null, billiardType: null,
        joinedAt: entry.joinedAt, startedAt: null, endedAt: Date.now(),
        waitMins: minsAgo(entry.joinedAt), sessionMins: 0, overtimeMins: 0, supplement: 0, reason: 'removed',
      });
      broadcastState();
    }
  });

  // STAFF : ajouter un client manuellement (sans QR code)
  // label = nom/description libre ex: "Monsieur au chapeau", "Table 5"
  socket.on('manual_add', ({ preferredType, label }) => {
    // Numéro de table fictif négatif pour ne pas conflicter avec les vraies tables
    const fakeTableNum = -(Date.now() % 100000);
    const entry = {
      id: uuidv4(),
      tableNum: fakeTableNum,
      label: label || 'Client comptoir',
      preferredType: preferredType || 'english',
      joinedAt: Date.now(),
      status: 'waiting',
      billiardId: null,
      isManual: true,
    };
    state.queue.push(entry);
    io.emit('staff_sound', { type: 'new_entry' });
    tryAutoAssign(entry.id);
  });

  socket.on('start_session', ({ billiardId }) => {
    const billiard = state.billiards.find(b => b.id === billiardId);
    if (!billiard || billiard.status !== 'waiting_start') return;
    billiard.status = 'playing';
    billiard.sessionStart = Date.now();
    const entry = state.queue.find(q => q.id === billiard.queueId);
    if (entry) entry.status = 'playing';
    setTimeout(() => triggerOvertimeAlert(billiardId), SESSION_DURATION_MS);
    broadcastState();
  });

  socket.on('end_session', ({ billiardId }) => freeTable(billiardId));

  socket.on('remove_from_queue', ({ queueId }) => {
    const entry = state.queue.find(q => q.id === queueId);
    if (!entry) return;
    if (entry.billiardId) {
      const b = state.billiards.find(b => b.id === entry.billiardId);
      if (b && b.status === 'waiting_start') {
        b.status = 'free'; b.queueId = null; b.tableNum = null; b.assignedAt = null;
        const next = waitingQueue()[0];
        if (next) tryAutoAssign(next.id);
      }
    }
    entry.status = 'done';
    state.history.push({
      id: uuidv4(), tableNum: entry.tableNum, billiardId: null, billiardType: null,
      joinedAt: entry.joinedAt, startedAt: null, endedAt: Date.now(),
      waitMins: minsAgo(entry.joinedAt), sessionMins: 0, overtimeMins: 0, supplement: 0, reason: 'removed',
    });
    broadcastState();
  });

  // Reset soirée (minuit ou manuellement)
  socket.on('reset_evening', () => {
    state.history = [];
    state.eveningStart = Date.now();
    broadcastState();
  });
});

setInterval(broadcastState, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅  Serveur  → http://localhost:${PORT}`);
  console.log(`📱  Client   → http://localhost:${PORT}/table/1`);
  console.log(`🎱  Staff    → http://localhost:${PORT}/staff`);
  console.log(`📊  Export   → http://localhost:${PORT}/export-csv`);
});
