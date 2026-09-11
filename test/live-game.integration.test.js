import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class GameClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.room = null;
    this.nextAckId = 0;
    this.acks = new Map();
    this.roomWaiters = [];
    this.connected = deferred();
    this.socket.on('message', (message) => this.receive(String(message)));
    this.socket.on('error', (error) => this.connected.reject(error));
  }

  receive(packet) {
    if (packet === '2') return this.socket.send('3');
    if (packet.startsWith('0')) return this.socket.send('40');
    if (packet.startsWith('40')) return this.connected.resolve();
    if (packet.startsWith('42')) {
      const [event, payload] = JSON.parse(packet.slice(2));
      if (event === 'roomState') {
        this.room = payload;
        this.roomWaiters = this.roomWaiters.filter((waiter) => {
          if (!waiter.check(payload)) return true;
          clearTimeout(waiter.timeout);
          waiter.resolve(payload);
          return false;
        });
      }
      return;
    }
    if (packet.startsWith('43')) {
      const match = packet.slice(2).match(/^(\d+)([\s\S]+)$/);
      if (!match) return;
      const ack = this.acks.get(Number(match[1]));
      if (!ack) return;
      this.acks.delete(Number(match[1]));
      ack.resolve(JSON.parse(match[2])[0]);
    }
  }

  async ready() {
    await Promise.race([this.connected.promise, delay(5_000).then(() => { throw new Error('Socket.IO 연결 시간이 초과되었습니다.'); })]);
  }

  emit(event, data = {}) {
    const id = this.nextAckId++;
    const ack = deferred();
    this.acks.set(id, ack);
    this.socket.send(`42${id}${JSON.stringify([event, data])}`);
    return Promise.race([ack.promise, delay(5_000).then(() => { throw new Error(`${event} 응답 시간이 초과되었습니다.`); })]);
  }

  waitForRoom(check, timeoutMs = 8_000) {
    if (this.room && check(this.room)) return Promise.resolve(this.room);
    const waiter = deferred();
    const item = {
      check,
      resolve: waiter.resolve,
      timeout: setTimeout(() => waiter.reject(new Error('게임 상태 갱신 시간이 초과되었습니다.')), timeoutMs)
    };
    this.roomWaiters.push(item);
    return waiter.promise;
  }

  close() {
    this.socket.close();
  }
}

async function waitForServer(server, port) {
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  await Promise.race([
    once(server.stdout, 'data').then(() => undefined),
    delay(5_000).then(() => { throw new Error(`서버 시작 시간이 초과되었습니다: ${output}`); })
  ]);
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /id="casino-board"/);
}

test('실제 Socket.IO 게임에서 두 명이 배치·정산·게임 종료까지 진행한다', { timeout: 60_000 }, async () => {
  const port = 31_000 + (process.pid % 1_000);
  const server = spawn(process.execPath, ['server/server.js', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const clients = [];
  try {
    await waitForServer(server, port);
    const host = new GameClient(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    await host.ready();
    const created = await host.emit('createRoom', { nickname: 'Host', maxPlayers: 2, diceCount: 6, rounds: 2, turnSeconds: 0 });
    assert.equal(created.ok, true);
    host.playerId = created.playerId;
    clients.push(host);

    const guest = new GameClient(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    await guest.ready();
    const joined = await guest.emit('joinRoom', { nickname: 'Guest', code: created.room.code });
    assert.equal(joined.ok, true);
    guest.playerId = joined.playerId;
    clients.push(guest);
    await Promise.all(clients.map((client) => client.waitForRoom((room) => room.players.length === 2)));

    for (const client of clients) assert.equal((await client.emit('toggleReady')).ok, true);
    assert.equal((await host.emit('startGame')).ok, true);
    await Promise.all(clients.map((client) => client.waitForRoom((room) => room.status === 'PLAYING')));

    let placementCount = 0;
    while (host.room.status !== 'GAME_OVER') {
      if (host.room.status === 'ROUND_RESULT') {
        assert.equal((await host.emit('nextRound')).ok, true);
        await host.waitForRoom((room) => room.status === 'PLAYING');
        continue;
      }

      if (host.room.roundPlacementComplete) {
        await host.waitForRoom((room) => room.status !== 'PLAYING', 12_000);
        continue;
      }

      const room = host.room;
      const activeId = room.players[room.turnPlayerIndex].id;
      const active = clients.find((client) => client.playerId === activeId);
      assert.ok(active, '현재 차례 플레이어 연결');
      await active.waitForRoom((current) => current.status === 'PLAYING' && !current.roundPlacementComplete && current.players[current.turnPlayerIndex]?.id === activeId);
      const me = active.room.players.find((player) => player.id === activeId);
      if (!me.dice.length) {
        const rolled = await active.emit('rollDice');
        assert.equal(rolled.ok, true, rolled.message);
        await active.waitForRoom((current) => current.players.find((player) => player.id === activeId)?.dice.length > 0);
      }
      const dice = active.room.players.find((player) => player.id === activeId).dice;
      const face = dice[0].face;
      assert.equal((await active.emit('selectDice', { face })).ok, true);
      await active.waitForRoom((current) => current.players.find((player) => player.id === activeId)?.selectedFace === face);
      const previousPlacementId = active.room.lastPlacement?.id;
      const placed = await active.emit('placeDice');
      assert.equal(placed.ok, true);
      placementCount += 1;
      await host.waitForRoom((current) => current.lastPlacement?.id !== previousPlacementId && current.lastPlacement?.face === face);
      assert.ok(host.room.casinos[face - 1].placedDice.every((die) => die.face === face));
    }

    assert.ok(placementCount > 0);
    assert.equal(host.room.round, 2);
    assert.ok(host.room.players.every((player) => Number.isFinite(player.money)));
  } finally {
    clients.forEach((client) => client.close());
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await Promise.race([exited, delay(5_000)]);
  }
});
