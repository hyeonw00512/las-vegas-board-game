import test from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../server/game/GameRoom.js';

function socket(id) {
  return { id };
}

test('방장은 방을 만들고 다른 플레이어를 받을 수 있다', () => {
  const room = new GameRoom('ABCDE', socket('host'), '현', 3);
  room.addPlayer(socket('guest'), '친구');
  assert.equal(room.players.length, 2);
  assert.equal(room.hostId, 'host');
  assert.notEqual(room.players[0].color, room.players[1].color);
});

test('모두 준비한 경우에만 방장이 시작할 수 있다', () => {
  const room = new GameRoom('ABCDE', socket('host'), '현', 3);
  room.addPlayer(socket('guest'), '친구');
  assert.equal(room.canStart('host'), false);
  room.toggleReady('host');
  room.toggleReady('guest');
  assert.equal(room.canStart('guest'), false);
  assert.equal(room.canStart('host'), true);
  room.start('host');
  assert.equal(room.status, 'PLAYING');
  assert.equal(room.casinos.length, 6);
});

test('주사위 굴림과 숫자 묶음 선택은 서버가 검증한다', () => {
  const room = new GameRoom('ABCDE', socket('host'), '현', 2);
  room.addPlayer(socket('guest'), '친구');
  room.toggleReady('host');
  room.toggleReady('guest');
  room.start('host');
  assert.throws(() => room.roll('guest'), /현재 플레이어/);
  const dice = room.roll('host');
  assert.equal(dice.length, 12);
  assert.ok(dice.every((die) => die.face >= 1 && die.face <= 6));
  room.selectFace('host', dice[0].face);
  assert.equal(room.getPlayer('host').selectedFace, dice[0].face);
  assert.throws(() => room.roll('host'), /이미 주사위를/);
  const selectedFace = dice[0].face;
  const selectedCount = dice.filter((die) => die.face === selectedFace).length;
  const selectedPlayerCount = dice.filter((die) => die.face === selectedFace && !die.isNeutral).length;
  const selectedNeutralCount = dice.filter((die) => die.face === selectedFace && die.isNeutral).length;
  const result = room.placeDice('host');
  assert.equal(result.count, selectedCount);
  assert.equal(room.casinos[selectedFace - 1].placedDice.length, selectedCount);
  assert.equal(room.getPlayer('host').remainingDice, 8 - selectedPlayerCount);
  assert.equal(room.getPlayer('host').remainingNeutralDice, 4 - selectedNeutralCount);
  assert.equal(room.currentTurnPlayer().id, 'guest');
  assert.throws(() => room.placeDice('host'), /현재 플레이어/);
});

test('주사위를 모두 쓴 플레이어는 건너뛰고 전원이 소진하면 배치를 종료한다', () => {
  const room = new GameRoom('ABCDE', socket('host'), '현', 2);
  room.addPlayer(socket('guest'), '친구');
  room.toggleReady('host');
  room.toggleReady('guest');
  room.start('host');

  room.getPlayer('host').remainingDice = 1;
  room.getPlayer('host').remainingNeutralDice = 0;
  room.getPlayer('host').dice = [{ face: 3, isNeutral: false }];
  room.selectFace('host', 3);
  room.placeDice('host');
  assert.equal(room.currentTurnPlayer().id, 'guest');

  room.getPlayer('guest').remainingDice = 1;
  room.getPlayer('guest').remainingNeutralDice = 0;
  room.getPlayer('guest').dice = [{ face: 5, isNeutral: false }];
  room.selectFace('guest', 5);
  const result = room.placeDice('guest');
  assert.equal(result.roundPlacementComplete, true);
  assert.equal(room.roundPlacementComplete, true);
  assert.equal(room.settlementPending, true);
  assert.equal(room.status, 'PLAYING');
  assert.equal(room.lastPlacement.face, 5);
});

test('라운드 정산 뒤에도 마지막 배치와 이번 라운드 수익 근거를 보존한다', () => {
  const room = new GameRoom('RECAP', socket('a'), 'A', 2);
  room.addPlayer(socket('b'), 'B');
  room.toggleReady('a'); room.toggleReady('b'); room.start('a');
  room.casinos.forEach((casino) => { casino.rewards = []; casino.placedDice = []; });
  room.casinos[3].rewards = [60];
  room.casinos[3].placedDice = Array.from({ length: 2 }, () => room.makePlacedDie(room.getPlayer('a'), false));
  room.lastPlacement = { id: 'last-bet', playerId: 'a', nickname: 'A', face: 4, count: 2 };
  room.roundPlacementComplete = true;
  room.settlementPending = true;
  room.settleRound();
  assert.equal(room.lastPlacement.face, 4);
  assert.equal(room.roundResults[3].awards[0].reward, 60);
  assert.equal(room.getPlayer('a').money, 60);
});

test('2인과 4인은 흰색 주사위 규칙에 맞게 나눠 갖는다', () => {
  const two = new GameRoom('TWOAA', socket('a'), 'A', 2);
  two.addPlayer(socket('b'), 'B');
  two.toggleReady('a'); two.toggleReady('b'); two.start('a');
  assert.deepEqual(two.players.map((player) => player.remainingNeutralDice), [4, 4]);

  const four = new GameRoom('FOURR', socket('a'), 'A', 4);
  ['b', 'c', 'd'].forEach((id) => four.addPlayer(socket(id), id.toUpperCase()));
  four.players.forEach((player) => four.toggleReady(player.id));
  four.start('a');
  assert.deepEqual(four.players.map((player) => player.remainingNeutralDice), [2, 2, 2, 2]);
});

test('3인은 시스템이 남은 흰색 주사위 2개를 자동 배치한다', () => {
  const room = new GameRoom('THREE', socket('a'), 'A', 3);
  room.addPlayer(socket('b'), 'B');
  room.addPlayer(socket('c'), 'C');
  room.players.forEach((player) => room.toggleReady(player.id));
  room.start('a');
  assert.equal(room.openingNeutralPending, true);
  assert.throws(() => room.roll('a'), /중립 주사위/);
  assert.equal(room.turnDeadline, null);
  const dice = room.assignOpeningNeutral();
  assert.equal(dice.length, 2);
  assert.equal(room.casinos.flatMap((casino) => casino.placedDice).filter((die) => die.isNeutral).length, 2);
  assert.equal(room.openingNeutralPending, false);
  assert.equal(room.currentTurnPlayer().id, 'a');
  assert.match(room.logs.at(-1).message, /시스템/);
});

test('지폐 54장을 섞고 카지노 1부터 6까지 순서대로 배분한다', () => {
  const room = new GameRoom('MONEY', socket('a'), 'A', 2);
  room.addPlayer(socket('b'), 'B');
  room.toggleReady('a'); room.toggleReady('b'); room.start('a');
  assert.deepEqual(room.casinos.map((casino) => casino.number), [1, 2, 3, 4, 5, 6]);
  assert.ok(room.casinos.every((casino) => casino.rewards.reduce((sum, value) => sum + value, 0) >= 50));
  const dealt = room.casinos.reduce((sum, casino) => sum + casino.rewards.length, 0);
  assert.equal(dealt + room.rewardDeck.length, 54);
});

test('같은 개수의 플레이어는 제외하고 남은 순서대로 지폐를 지급한다', () => {
  const room = new GameRoom('TIEAA', socket('a'), 'A', 3);
  room.addPlayer(socket('b'), 'B');
  room.addPlayer(socket('c'), 'C');
  room.players.forEach((player) => room.toggleReady(player.id));
  room.start('a');
  room.casinos.forEach((casino) => { casino.rewards = []; casino.placedDice = []; });
  room.casinos[0].rewards = [50, 30];
  room.casinos[0].placedDice = [
    ...Array.from({ length: 4 }, () => room.makePlacedDie(room.getPlayer('a'), false)),
    ...Array.from({ length: 4 }, () => room.makePlacedDie(room.getPlayer('b'), false)),
    ...Array.from({ length: 3 }, () => room.makePlacedDie(room.getPlayer('c'), false))
  ];
  room.roundPlacementComplete = true;
  const [result] = room.settleRound();
  assert.equal(room.getPlayer('a').money, 0);
  assert.equal(room.getPlayer('b').money, 0);
  assert.equal(room.getPlayer('c').money, 50);
  assert.equal(result.awards[0].playerId, 'c');
  assert.equal(result.counts.filter((entry) => entry.tied).length, 2);
});

test('중립 주사위가 순위를 차지하면 해당 지폐는 폐기한다', () => {
  const room = new GameRoom('WHITE', socket('a'), 'A', 2);
  room.addPlayer(socket('b'), 'B');
  room.toggleReady('a'); room.toggleReady('b'); room.start('a');
  room.casinos.forEach((casino) => { casino.rewards = []; casino.placedDice = []; });
  room.casinos[0].rewards = [90, 40];
  room.casinos[0].placedDice = [
    ...Array.from({ length: 5 }, () => room.makePlacedDie(null, true)),
    ...Array.from({ length: 4 }, () => room.makePlacedDie(room.getPlayer('a'), false))
  ];
  room.roundPlacementComplete = true;
  const [result] = room.settleRound();
  assert.equal(result.awards[0].isNeutral, true);
  assert.equal(result.awards[0].reward, 90);
  assert.equal(room.getPlayer('a').money, 40);
});

test('다음 라운드에는 선플레이어가 한 칸 이동하고 새 보상을 배분한다', () => {
  const room = new GameRoom('NEXTT', socket('a'), 'A', 2);
  room.addPlayer(socket('b'), 'B');
  room.toggleReady('a'); room.toggleReady('b'); room.start('a');
  room.roundPlacementComplete = true;
  room.settleRound();
  assert.throws(() => room.nextRound('b'), /방장만/);
  room.nextRound('a');
  assert.equal(room.round, 2);
  assert.equal(room.currentTurnPlayer().id, 'b');
  assert.equal(room.status, 'PLAYING');
  assert.ok(room.casinos.every((casino) => casino.placedDice.length === 0));
});

test('4라운드 정산 후 누적 금액순 최종 순위를 만든다', () => {
  const room = new GameRoom('FINAL', socket('a'), 'A', 2);
  room.addPlayer(socket('b'), 'B');
  room.toggleReady('a'); room.toggleReady('b'); room.start('a');
  room.round = 4;
  room.getPlayer('a').money = 120;
  room.getPlayer('b').money = 180;
  room.roundPlacementComplete = true;
  room.settleRound();
  assert.equal(room.status, 'GAME_OVER');
  assert.deepEqual(room.finalRanking().map((player) => player.playerId), ['b', 'a']);
});

test('재접속 토큰으로 기존 플레이어 상태를 복구하고 토큰은 공개하지 않는다', () => {
  const room = new GameRoom('AGAIN', socket('a'), 'A', 2);
  const player = room.getPlayer('a');
  const token = player.reconnectToken;
  room.markDisconnected('a');
  assert.equal(player.connected, false);
  assert.throws(() => room.reconnectPlayer('wrong-token'), /복구할 플레이어/);
  assert.equal(room.reconnectPlayer(token).id, 'a');
  assert.equal(player.connected, true);
  assert.doesNotMatch(JSON.stringify(room.toJSON()), new RegExp(token));
});

test('참가자별 상태에는 자기 주사위만 포함된다', () => {
  const room = new GameRoom('SECRET', socket('a'), 'A', 2);
  room.addPlayer(socket('b'), 'B');
  room.toggleReady('a'); room.toggleReady('b'); room.start('a');
  const dice = room.roll('a');
  const hostView = room.toJSON('a');
  const guestView = room.toJSON('b');
  assert.deepEqual(hostView.players.find((player) => player.id === 'a').dice, dice);
  assert.deepEqual(guestView.players.find((player) => player.id === 'a').dice, []);
});

test('채팅 메시지는 공백을 정리하고 최근 50개만 보관한다', () => {
  const room = new GameRoom('CHATT', socket('a'), 'A', 2);
  const first = room.sendChat('a', '  안녕   반가워  ');
  assert.equal(first.message, '안녕 반가워');
  for (let index = 0; index < 52; index += 1) room.sendChat('a', `메시지 ${index}`);
  assert.equal(room.chatMessages.length, 50);
  assert.equal(room.chatMessages.at(-1).message, '메시지 51');
});

test('게임 종료 후 같은 참가자로 다시 시작하면 점수와 라운드를 초기화한다', () => {
  const room = new GameRoom('RETRY', socket('a'), 'A', 2);
  room.addPlayer(socket('b'), 'B');
  room.toggleReady('a'); room.toggleReady('b'); room.start('a');
  room.status = 'GAME_OVER';
  room.getPlayer('a').money = 300;
  assert.throws(() => room.restartGame('b'), /방장만/);
  room.restartGame('a');
  assert.equal(room.status, 'PLAYING');
  assert.equal(room.round, 1);
  assert.ok(room.players.every((player) => player.money === 0));
});

test('방장은 결과 화면에서 참가자들과 로비로 돌아갈 수 있다', () => {
  const room = new GameRoom('LOBBY', socket('a'), 'A', 2);
  room.addPlayer(socket('b'), 'B');
  room.toggleReady('a'); room.toggleReady('b'); room.start('a');
  room.status = 'ROUND_RESULT';
  room.returnLobby('a');
  assert.equal(room.status, 'LOBBY');
  assert.equal(room.round, 0);
  assert.ok(room.players.every((player) => !player.ready && player.money === 0));
});

test('진행 중 방장이 나가면 다음 연결 참가자에게 방장을 넘긴다', () => {
  const room = new GameRoom('LEAVE', socket('a'), 'A', 2);
  room.addPlayer(socket('b'), 'B');
  room.toggleReady('a'); room.toggleReady('b'); room.start('a');
  room.leavePlayer('a');
  assert.equal(room.getPlayer('a').abandoned, true);
  assert.equal(room.hostId, 'b');
  assert.equal(room.currentTurnPlayer().id, 'b');
});

test('방 설정값을 허용 범위로 정리해 게임에 적용한다', () => {
  const room = new GameRoom('RULES', socket('a'), 'A', { maxPlayers: 3, diceCount: 10, rounds: 6, turnSeconds: 45 });
  room.addPlayer(socket('b'), 'B');
  room.toggleReady('a'); room.toggleReady('b'); room.start('a');
  assert.deepEqual(room.settings, { maxPlayers: 3, diceCount: 10, rounds: 6, turnSeconds: 45 });
  assert.equal(room.getPlayer('a').remainingDice, 10);
  assert.ok(room.turnDeadline > Date.now());
});

test('턴 제한 시간이 끝나면 가장 많이 나온 숫자를 서버가 자동 배치한다', () => {
  const room = new GameRoom('TIMER', socket('a'), 'A', { maxPlayers: 2, turnSeconds: 30 });
  room.addPlayer(socket('b'), 'B');
  room.toggleReady('a'); room.toggleReady('b'); room.start('a');
  const player = room.getPlayer('a');
  player.dice = [
    { face: 2, isNeutral: false }, { face: 2, isNeutral: false }, { face: 5, isNeutral: false }
  ];
  player.remainingDice = 3;
  player.remainingNeutralDice = 0;
  room.turnDeadline = Date.now() - 1;
  const result = room.handleTurnTimeout();
  assert.equal(result.type, 'PLACE');
  assert.equal(result.face, 2);
  assert.equal(room.casinos[1].placedDice.length, 2);
  assert.equal(room.currentTurnPlayer().id, 'b');
  assert.match(room.logs.at(-1).message, /자동 배치/);
});
