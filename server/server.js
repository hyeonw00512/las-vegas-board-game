import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { GameRoom } from './game/GameRoom.js';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: false } });
const rooms = new Map();
const reconnectTimers = new Map();
const settlementTimers = new Map();
const RECONNECT_GRACE_MS = 60_000;
const OPENING_NEUTRAL_DELAY_MS = 900;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const clientPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function reply(callback, payload) {
  if (typeof callback === 'function') callback(payload);
}

function publish(room) {
  const socketIds = io.sockets.adapter.rooms.get(room.code);
  if (!socketIds) return;
  for (const socketId of socketIds) {
    const target = io.sockets.sockets.get(socketId);
    if (target) target.emit('roomState', room.toJSON(socketPlayerId(target)));
  }
}

function scheduleOpeningNeutral(room) {
  if (!room.openingNeutralPending) return;
  setTimeout(() => {
    if (rooms.get(room.code) !== room || room.status !== 'PLAYING' || !room.openingNeutralPending) return;
    const dice = room.assignOpeningNeutral();
    publish(room);
    io.to(room.code).emit('openingNeutralPlaced', { dice });
  }, OPENING_NEUTRAL_DELAY_MS);
}

function scheduleRoundSettlement(room) {
  if (!room.settlementPending || settlementTimers.has(room.code)) return;
  const delay = Math.max(0, (room.settlementReadyAt || Date.now()) - Date.now());
  const timer = setTimeout(() => {
    settlementTimers.delete(room.code);
    if (rooms.get(room.code) !== room || !room.settlementPending) return;
    room.settleRound();
    publish(room);
    io.to(room.code).emit('roundSettled', { round: room.round, gameOver: room.status === 'GAME_OVER' });
  }, delay);
  settlementTimers.set(room.code, timer);
}

function findSocketRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function socketPlayerId(socket) {
  return socket.data.playerId || socket.id;
}

function reconnectKey(roomCode, playerId) {
  return `${roomCode}:${playerId}`;
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ nickname, maxPlayers, diceCount, rounds, turnSeconds } = {}, callback) => {
    try {
      const code = makeCode();
      const room = new GameRoom(code, socket, nickname, { maxPlayers, diceCount, rounds, turnSeconds });
      rooms.set(code, room);
      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerId = socket.id;
      const player = room.getPlayer(socket.id);
      reply(callback, { ok: true, room: room.toJSON(player.id), playerId: player.id, reconnectToken: player.reconnectToken });
      publish(room);
    } catch (error) {
      reply(callback, { ok: false, message: error.message });
    }
  });

  socket.on('joinRoom', ({ code, nickname } = {}, callback) => {
    try {
      const normalizedCode = String(code || '').trim().toUpperCase();
      const room = rooms.get(normalizedCode);
      if (!room) throw new Error('방 코드를 확인해주세요.');
      const player = room.addPlayer(socket, nickname);
      socket.join(normalizedCode);
      socket.data.roomCode = normalizedCode;
      socket.data.playerId = player.id;
      reply(callback, { ok: true, room: room.toJSON(player.id), playerId: player.id, reconnectToken: player.reconnectToken });
      publish(room);
    } catch (error) {
      reply(callback, { ok: false, message: error.message });
    }
  });

  socket.on('restoreSession', ({ code, reconnectToken } = {}, callback) => {
    try {
      const normalizedCode = String(code || '').trim().toUpperCase();
      const room = rooms.get(normalizedCode);
      if (!room) throw new Error('방이 종료되었거나 서버가 재시작되었습니다.');
      const player = room.reconnectPlayer(reconnectToken);
      const key = reconnectKey(normalizedCode, player.id);
      clearTimeout(reconnectTimers.get(key));
      reconnectTimers.delete(key);
      socket.join(normalizedCode);
      socket.data.roomCode = normalizedCode;
      socket.data.playerId = player.id;
      reply(callback, { ok: true, room: room.toJSON(player.id), playerId: player.id });
      publish(room);
    } catch (error) {
      reply(callback, { ok: false, message: error.message });
    }
  });

  socket.on('toggleReady', (_, callback) => {
    try {
      const room = findSocketRoom(socket);
      if (!room) throw new Error('참가 중인 방이 없습니다.');
      room.toggleReady(socketPlayerId(socket));
      publish(room);
      reply(callback, { ok: true });
    } catch (error) {
      reply(callback, { ok: false, message: error.message });
    }
  });

  socket.on('startGame', (_, callback) => {
    try {
      const room = findSocketRoom(socket);
      if (!room) throw new Error('참가 중인 방이 없습니다.');
      room.start(socketPlayerId(socket));
      publish(room);
      scheduleOpeningNeutral(room);
      io.to(room.code).emit('gameStarted');
      reply(callback, { ok: true });
    } catch (error) {
      reply(callback, { ok: false, message: error.message });
    }
  });

  socket.on('rollDice', (_, callback) => {
    try {
      const room = findSocketRoom(socket);
      if (!room) throw new Error('참가 중인 방이 없습니다.');
      const dice = room.roll(socketPlayerId(socket));
      publish(room);
      reply(callback, { ok: true, dice });
    } catch (error) {
      reply(callback, { ok: false, message: error.message });
    }
  });

  socket.on('selectDice', ({ face } = {}, callback) => {
    try {
      const room = findSocketRoom(socket);
      if (!room) throw new Error('참가 중인 방이 없습니다.');
      room.selectFace(socketPlayerId(socket), face);
      publish(room);
      reply(callback, { ok: true });
    } catch (error) {
      reply(callback, { ok: false, message: error.message });
    }
  });

  socket.on('placeDice', (_, callback) => {
    try {
      const room = findSocketRoom(socket);
      if (!room) throw new Error('참가 중인 방이 없습니다.');
      const result = room.placeDice(socketPlayerId(socket));
      io.to(room.code).emit('dicePlaced', result);
      publish(room);
      if (result.roundPlacementComplete) scheduleRoundSettlement(room);
      reply(callback, { ok: true, ...result });
    } catch (error) {
      reply(callback, { ok: false, message: error.message });
    }
  });

  socket.on('nextRound', (_, callback) => {
    try {
      const room = findSocketRoom(socket);
      if (!room) throw new Error('참가 중인 방이 없습니다.');
      room.nextRound(socketPlayerId(socket));
      publish(room);
      scheduleOpeningNeutral(room);
      io.to(room.code).emit('nextRound', { round: room.round, startPlayerId: room.currentTurnPlayer()?.id });
      reply(callback, { ok: true });
    } catch (error) {
      reply(callback, { ok: false, message: error.message });
    }
  });

  socket.on('restartGame', (_, callback) => {
    try {
      const room = findSocketRoom(socket);
      if (!room) throw new Error('참가 중인 방이 없습니다.');
      room.restartGame(socketPlayerId(socket));
      publish(room);
      scheduleOpeningNeutral(room);
      io.to(room.code).emit('gameRestarted');
      reply(callback, { ok: true });
    } catch (error) {
      reply(callback, { ok: false, message: error.message });
    }
  });

  socket.on('returnLobby', (_, callback) => {
    try {
      const room = findSocketRoom(socket);
      if (!room) throw new Error('참가 중인 방이 없습니다.');
      room.returnLobby(socketPlayerId(socket));
      publish(room);
      reply(callback, { ok: true });
    } catch (error) {
      reply(callback, { ok: false, message: error.message });
    }
  });

  socket.on('leaveRoom', (_, callback) => {
    try {
      const room = findSocketRoom(socket);
      if (!room) throw new Error('참가 중인 방이 없습니다.');
      const playerId = socketPlayerId(socket);
      const key = reconnectKey(room.code, playerId);
      clearTimeout(reconnectTimers.get(key));
      reconnectTimers.delete(key);
      room.leavePlayer(playerId);
      socket.leave(room.code);
      socket.data.roomCode = null;
      socket.data.playerId = null;
      if (!room.players.some((player) => player.connected)) rooms.delete(room.code);
      else {
        publish(room);
        scheduleRoundSettlement(room);
      }
      reply(callback, { ok: true });
    } catch (error) {
      reply(callback, { ok: false, message: error.message });
    }
  });

  socket.on('chatMessage', ({ message } = {}, callback) => {
    try {
      const room = findSocketRoom(socket);
      if (!room) throw new Error('참가 중인 방이 없습니다.');
      const chatMessage = room.sendChat(socketPlayerId(socket), message);
      io.to(room.code).emit('chatMessage', chatMessage);
      reply(callback, { ok: true });
    } catch (error) {
      reply(callback, { ok: false, message: error.message });
    }
  });

  socket.on('disconnect', () => {
    const room = findSocketRoom(socket);
    if (!room) return;
    const playerId = socketPlayerId(socket);
    room.markDisconnected(playerId);
    publish(room);
    const key = reconnectKey(room.code, playerId);
    clearTimeout(reconnectTimers.get(key));
    reconnectTimers.set(key, setTimeout(() => {
      reconnectTimers.delete(key);
      const currentRoom = rooms.get(room.code);
      const player = currentRoom?.getPlayer(playerId);
      if (!currentRoom || player?.connected) return;
      if (currentRoom.status === 'LOBBY') currentRoom.removePlayer(playerId);
      else currentRoom.abandonPlayer(playerId);
      if (!currentRoom.players.some((item) => item.connected)) rooms.delete(currentRoom.code);
      else {
        publish(currentRoom);
        scheduleRoundSettlement(currentRoom);
      }
    }, RECONNECT_GRACE_MS));
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    try {
      const timedOut = room.handleTurnTimeout();
      if (!timedOut) continue;
      io.to(room.code).emit('turnTimedOut', timedOut);
      publish(room);
      if (timedOut.roundPlacementComplete) scheduleRoundSettlement(room);
    } catch {
      // 다음 주기에서 상태를 다시 확인한다.
    }
  }
}, 500).unref();

app.use(express.static(clientPath));
app.use('/vendor/phaser', express.static(path.resolve(clientPath, '../node_modules/phaser/dist')));
app.get('/health', (_request, response) => response.json({ ok: true }));
app.use((_request, response) => response.sendFile(path.join(clientPath, 'index.html')));

const portArgumentIndex = process.argv.indexOf('--port');
const commandLinePort = portArgumentIndex >= 0 ? Number(process.argv[portArgumentIndex + 1]) : 0;
const port = commandLinePort || Number(process.env.PORT) || 3000;
httpServer.listen(port, '0.0.0.0', () => {
  console.log(`라스베가스: http://localhost:${port}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: 새 연결을 닫고 서버를 종료합니다.`);
  httpServer.close(() => process.exit(0));
  io.disconnectSockets(true);
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
