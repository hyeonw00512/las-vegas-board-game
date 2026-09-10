import { randomInt, randomUUID } from 'node:crypto';

export const PLAYER_COLORS = ['#ff4d6d', '#43a8ff', '#35d07f', '#ffd166', '#b983ff'];
const REWARD_VALUES = [10, 20, 30, 40, 50, 60, 70, 80, 90];
const NEUTRAL_ID = 'NEUTRAL';
const NEUTRAL_COLOR = '#f4f1e8';

function shuffledRewardDeck() {
  const deck = REWARD_VALUES.flatMap((value) => Array(6).fill(value));
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  return deck;
}

function dealRewards(deck) {
  const rewards = [];
  while (rewards.reduce((total, value) => total + value, 0) < 50 && deck.length) {
    rewards.push(deck.pop());
  }
  return rewards.sort((a, b) => b - a);
}

function neutralDicePerPlayer(playerCount) {
  if (playerCount === 2) return 4;
  if (playerCount === 3 || playerCount === 4) return 2;
  return 0;
}

function boundedNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.round(number))) : fallback;
}

export class GameRoom {
  constructor(code, hostSocket, nickname, options = 5) {
    const requested = typeof options === 'object' ? options : { maxPlayers: options };
    this.code = code;
    this.hostId = hostSocket.id;
    this.status = 'LOBBY';
    this.settings = {
      maxPlayers: boundedNumber(requested.maxPlayers, 2, 5, 5),
      diceCount: boundedNumber(requested.diceCount, 6, 10, 8),
      rounds: boundedNumber(requested.rounds, 2, 6, 4),
      turnSeconds: [0, 30, 45, 60].includes(Number(requested.turnSeconds)) ? Number(requested.turnSeconds) : 0
    };
    this.maxPlayers = this.settings.maxPlayers;
    this.round = 0;
    this.turnPlayerIndex = 0;
    this.players = [];
    this.casinos = [];
    this.chatMessages = [];
    this.logs = [];
    this.addPlayer(hostSocket, nickname);
  }

  addPlayer(socket, nickname) {
    if (this.status !== 'LOBBY') throw new Error('이미 게임이 시작된 방입니다.');
    if (this.players.length >= this.maxPlayers) throw new Error('방이 가득 찼습니다.');
    const cleanName = String(nickname || '').trim().slice(0, 12);
    if (!cleanName) throw new Error('닉네임을 입력해주세요.');
    if (this.players.some((player) => player.nickname.toLowerCase() === cleanName.toLowerCase())) {
      throw new Error('이미 사용 중인 닉네임입니다.');
    }

    const player = {
      id: socket.id,
      nickname: cleanName,
      color: PLAYER_COLORS[this.players.length],
      ready: false,
      dice: [],
      remainingDice: this.settings.diceCount,
      remainingNeutralDice: 0,
      selectedFace: null,
      money: 0,
      connected: true
    };
    Object.defineProperty(player, 'reconnectToken', {
      value: randomUUID(),
      writable: false,
      enumerable: false
    });
    this.players.push(player);
    this.addLog(`${cleanName}님이 방에 참가했습니다.`, 'join');
    return player;
  }

  reconnectPlayer(token) {
    const player = this.players.find((item) => item.reconnectToken === token && !item.abandoned);
    if (!player) throw new Error('복구할 플레이어 정보를 찾을 수 없습니다.');
    player.connected = true;
    return player;
  }

  markDisconnected(playerId) {
    const player = this.getPlayer(playerId);
    if (player) player.connected = false;
  }

  abandonPlayer(playerId) {
    const player = this.getPlayer(playerId);
    if (!player || player.connected) return;
    player.abandoned = true;
    player.dice = [];
    player.remainingDice = 0;
    player.remainingNeutralDice = 0;
    player.selectedFace = null;
    if (this.hostId === playerId) {
      const nextHost = this.players.find((item) => item.connected && !item.abandoned);
      if (nextHost) this.hostId = nextHost.id;
    }
    if (this.status !== 'PLAYING' || this.roundPlacementComplete) return;
    if (this.players.every((item) => this.totalRemainingDice(item) === 0)) {
      this.completeRoundPlacement();
    } else if (this.currentTurnPlayer()?.id === playerId) {
      this.advanceTurn();
    }
  }

  removePlayer(socketId) {
    const index = this.players.findIndex((player) => player.id === socketId);
    if (index < 0) return;
    this.players.splice(index, 1);
    if (this.hostId === socketId && this.players[0]) this.hostId = this.players[0].id;
    if (this.turnPlayerIndex >= this.players.length) this.turnPlayerIndex = 0;
  }

  toggleReady(socketId) {
    const player = this.getPlayer(socketId);
    if (!player) throw new Error('플레이어를 찾을 수 없습니다.');
    player.ready = !player.ready;
  }

  canStart(socketId) {
    return socketId === this.hostId && this.players.length >= 2 && this.players.every((player) => player.ready && player.connected);
  }

  start(socketId) {
    if (!this.canStart(socketId)) throw new Error('모든 참가자가 준비해야 방장이 시작할 수 있습니다.');
    this.round = 1;
    this.startPlayerIndex = 0;
    this.rewardDeck = shuffledRewardDeck();
    this.prepareRound();
    this.addLog(`게임이 시작되었습니다. (${this.settings.rounds}라운드)`, 'start');
  }

  prepareRound() {
    this.status = 'PLAYING';
    this.turnPlayerIndex = this.startPlayerIndex;
    this.roundPlacementComplete = false;
    this.settlementPending = false;
    this.settlementReadyAt = null;
    this.roundResults = [];
    this.lastAction = null;
    this.lastPlacement = null;
    this.casinos = Array.from({ length: 6 }, (_, index) => ({
      number: index + 1,
      rewards: dealRewards(this.rewardDeck),
      placedDice: []
    }));
    this.openingNeutralPending = this.players.length === 3;
    const neutralCount = neutralDicePerPlayer(this.players.length);
    for (const player of this.players) {
      player.dice = [];
      player.remainingDice = this.settings.diceCount;
      player.remainingNeutralDice = neutralCount;
      player.selectedFace = null;
    }
    if (this.openingNeutralPending) this.turnDeadline = null;
    else this.resetTurnDeadline();
  }

  nextRound(socketId) {
    if (socketId !== this.hostId) throw new Error('방장만 다음 라운드를 시작할 수 있습니다.');
    if (this.status !== 'ROUND_RESULT') throw new Error('다음 라운드를 시작할 수 없는 상태입니다.');
    if (this.round >= this.settings.rounds) throw new Error('모든 라운드가 종료되었습니다.');
    this.round += 1;
    this.startPlayerIndex = (this.startPlayerIndex + 1) % this.players.length;
    this.prepareRound();
    this.addLog(`${this.round}라운드가 시작되었습니다.`, 'round');
  }

  restartGame(socketId) {
    if (socketId !== this.hostId) throw new Error('방장만 다시 시작할 수 있습니다.');
    if (this.status !== 'GAME_OVER') throw new Error('게임 종료 후 다시 시작할 수 있습니다.');
    this.players = this.players.filter((player) => player.connected && !player.abandoned);
    if (this.players.length < 2) throw new Error('다시 시작하려면 연결된 플레이어가 2명 이상 필요합니다.');
    for (const player of this.players) {
      player.money = 0;
      player.ready = true;
    }
    this.round = 1;
    this.startPlayerIndex = 0;
    this.rewardDeck = shuffledRewardDeck();
    this.prepareRound();
    this.addLog('같은 참가자로 새 게임을 시작했습니다.', 'start');
  }

  returnLobby(socketId) {
    if (socketId !== this.hostId) throw new Error('방장만 로비로 돌아갈 수 있습니다.');
    if (this.status === 'PLAYING') throw new Error('진행 중인 게임에서는 로비로 돌아갈 수 없습니다.');
    this.players = this.players.filter((player) => player.connected && !player.abandoned);
    this.status = 'LOBBY';
    this.round = 0;
    this.turnPlayerIndex = 0;
    this.startPlayerIndex = 0;
    this.roundPlacementComplete = false;
    this.roundResults = [];
    this.casinos = [];
    this.turnDeadline = null;
    for (const player of this.players) {
      player.ready = false;
      player.money = 0;
      player.dice = [];
      player.remainingDice = this.settings.diceCount;
      player.remainingNeutralDice = 0;
      player.selectedFace = null;
    }
  }

  leavePlayer(playerId) {
    if (this.status === 'PLAYING') {
      const player = this.getPlayer(playerId);
      this.markDisconnected(playerId);
      this.addLog(`${player.nickname}님이 게임에서 나갔습니다.`, 'leave');
      this.abandonPlayer(playerId);
      return;
    }
    this.removePlayer(playerId);
  }

  forfeitPlayer(playerId) {
    if (this.status !== 'PLAYING') throw new Error('진행 중인 게임에서만 포기할 수 있습니다.');
    const player = this.getPlayer(playerId);
    if (!player || player.abandoned) throw new Error('포기할 플레이어를 찾을 수 없습니다.');
    player.connected = false;
    this.addLog(`${player.nickname}님이 게임을 포기했습니다.`, 'forfeit');
    this.abandonPlayer(playerId);
  }

  assignOpeningNeutral() {
    if (!this.openingNeutralPending) throw new Error('사전 배치할 중립 주사위가 없습니다.');
    const dice = Array.from({ length: 2 }, () => randomInt(1, 7));
    for (const face of dice) {
      this.casinos[face - 1].placedDice.push(this.makePlacedDie(null, true));
    }
    this.openingNeutralPending = false;
    this.lastAction = {
      id: randomUUID(),
      playerId: NEUTRAL_ID,
      nickname: '시스템',
      openingNeutral: true,
      faces: dice
    };
    this.lastPlacement = this.lastAction;
    this.addLog(`시스템이 남는 흰색 주사위 ${dice.join('·')}을 자동 배치했습니다.`, 'neutral');
    this.resetTurnDeadline();
    return dice;
  }

  roll(socketId) {
    if (this.status !== 'PLAYING') throw new Error('게임이 진행 중이 아닙니다.');
    if (this.roundPlacementComplete) throw new Error('이번 라운드의 배치가 끝났습니다.');
    if (this.openingNeutralPending) throw new Error('시스템이 남는 중립 주사위를 배정 중입니다.');
    this.assertTurn(socketId);
    const player = this.getPlayer(socketId);
    if (!player) throw new Error('플레이어를 찾을 수 없습니다.');
    if (player.dice.length) throw new Error('이미 주사위를 굴렸습니다.');
    if (this.totalRemainingDice(player) <= 0) throw new Error('남은 주사위가 없습니다.');
    player.dice = [
      ...Array.from({ length: player.remainingDice }, () => ({ face: randomInt(1, 7), isNeutral: false })),
      ...Array.from({ length: player.remainingNeutralDice }, () => ({ face: randomInt(1, 7), isNeutral: true }))
    ];
    return player.dice.map((die) => ({ ...die }));
  }

  selectFace(socketId, face) {
    this.assertTurn(socketId);
    const player = this.getPlayer(socketId);
    const numericFace = Number(face);
    if (!player?.dice.some((die) => die.face === numericFace)) throw new Error('선택할 수 없는 주사위입니다.');
    player.selectedFace = numericFace;
  }

  placeDice(socketId) {
    if (this.status !== 'PLAYING') throw new Error('게임이 진행 중이 아닙니다.');
    if (this.roundPlacementComplete) throw new Error('이번 라운드의 배치가 끝났습니다.');
    this.assertTurn(socketId);
    const player = this.getPlayer(socketId);
    if (!player || !player.selectedFace) throw new Error('배치할 주사위를 먼저 선택해주세요.');

    const face = player.selectedFace;
    const selectedDice = player.dice.filter((die) => die.face === face);
    const count = selectedDice.length;
    if (!count) throw new Error('선택한 주사위가 없습니다.');
    const casino = this.casinos.find((item) => item.number === face);
    if (!casino) throw new Error('배치할 장소를 찾을 수 없습니다.');

    casino.placedDice.push(...selectedDice.map((die) => this.makePlacedDie(player, die.isNeutral)));
    player.remainingDice -= selectedDice.filter((die) => !die.isNeutral).length;
    player.remainingNeutralDice -= selectedDice.filter((die) => die.isNeutral).length;
    player.dice = [];
    player.selectedFace = null;
    this.lastAction = {
      id: randomUUID(),
      playerId: player.id,
      nickname: player.nickname,
      face,
      count
    };
    this.lastPlacement = this.lastAction;
    this.addLog(`${player.nickname} → ${face}번 카지노에 주사위 ${count}개 배치`, 'place');

    if (this.players.every((item) => this.totalRemainingDice(item) === 0)) {
      this.completeRoundPlacement();
    } else {
      this.advanceTurn();
    }

    return {
      face,
      count,
      roundPlacementComplete: this.roundPlacementComplete,
      nextTurnPlayerId: this.roundPlacementComplete ? null : this.currentTurnPlayer()?.id
    };
  }

  advanceTurn() {
    for (let offset = 1; offset <= this.players.length; offset += 1) {
      const candidateIndex = (this.turnPlayerIndex + offset) % this.players.length;
      if (this.totalRemainingDice(this.players[candidateIndex]) > 0) {
        this.turnPlayerIndex = candidateIndex;
        this.resetTurnDeadline();
        return;
      }
    }
  }

  completeRoundPlacement() {
    this.roundPlacementComplete = true;
    this.settlementPending = true;
    this.settlementReadyAt = Date.now() + 3500;
    this.turnDeadline = null;
  }

  currentTurnPlayer() {
    return this.players[this.turnPlayerIndex];
  }

  assertTurn(socketId) {
    if (this.currentTurnPlayer()?.id !== socketId) throw new Error('현재 플레이어의 차례가 아닙니다.');
  }

  resetTurnDeadline() {
    this.turnDeadline = this.settings.turnSeconds > 0 ? Date.now() + this.settings.turnSeconds * 1000 : null;
  }

  handleTurnTimeout() {
    if (this.status !== 'PLAYING' || !this.turnDeadline || Date.now() < this.turnDeadline) return null;
    const player = this.currentTurnPlayer();
    if (!player) return null;
    if (!player.dice.length) this.roll(player.id);
    const counts = new Map();
    for (const die of player.dice) counts.set(die.face, (counts.get(die.face) || 0) + 1);
    const face = player.selectedFace || [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    this.selectFace(player.id, face);
    const result = this.placeDice(player.id);
    this.addLog(`${player.nickname}님의 제한 시간이 끝나 ${face}번에 자동 배치했습니다.`, 'timeout');
    return { type: 'PLACE', playerId: player.id, ...result };
  }

  totalRemainingDice(player) {
    return player.remainingDice + player.remainingNeutralDice;
  }

  makePlacedDie(player, isNeutral) {
    return isNeutral
      ? { playerId: NEUTRAL_ID, nickname: '중립', color: NEUTRAL_COLOR, isNeutral: true }
      : { playerId: player.id, nickname: player.nickname, color: player.color, isNeutral: false };
  }

  settleRound() {
    if (!this.roundPlacementComplete) throw new Error('모든 주사위가 배치되지 않았습니다.');
    this.roundResults = this.casinos.map((casino) => {
      const grouped = new Map();
      for (const die of casino.placedDice) {
        const current = grouped.get(die.playerId) || { ...die, count: 0 };
        current.count += 1;
        grouped.set(die.playerId, current);
      }

      const countFrequency = new Map();
      for (const entry of grouped.values()) {
        countFrequency.set(entry.count, (countFrequency.get(entry.count) || 0) + 1);
      }

      const counts = [...grouped.values()].map((entry) => ({
        ...entry,
        tied: countFrequency.get(entry.count) > 1
      }));
      const eligible = counts.filter((entry) => !entry.tied).sort((a, b) => b.count - a.count);
      const awards = eligible.slice(0, casino.rewards.length).map((entry, index) => {
        const reward = casino.rewards[index];
        if (!entry.isNeutral) {
          const player = this.getPlayer(entry.playerId);
          if (player) player.money += reward;
        }
        return {
          rank: index + 1,
          playerId: entry.playerId,
          nickname: entry.nickname,
          color: entry.color,
          reward,
          isNeutral: entry.isNeutral
        };
      });

      return {
        casinoNumber: casino.number,
        counts: counts.sort((a, b) => b.count - a.count),
        awards,
        unclaimedRewards: casino.rewards.slice(awards.length)
      };
    });

    this.turnDeadline = null;
    this.settlementPending = false;
    this.settlementReadyAt = null;
    this.status = this.round >= this.settings.rounds ? 'GAME_OVER' : 'ROUND_RESULT';
    this.lastAction = { roundSettled: true, round: this.round };
    this.addLog(`${this.round}라운드 정산이 완료되었습니다.`, 'settle');
    return this.roundResults;
  }

  finalRanking() {
    return this.players.filter((player) => !player.abandoned)
      .sort((a, b) => b.money - a.money)
      .map((player, index) => ({
        rank: index + 1,
        playerId: player.id,
        nickname: player.nickname,
        color: player.color,
        money: player.money
      }));
  }

  getPlayer(socketId) {
    return this.players.find((player) => player.id === socketId);
  }

  sendChat(playerId, message) {
    const player = this.getPlayer(playerId);
    if (!player || !player.connected) throw new Error('메시지를 보낼 수 없는 플레이어입니다.');
    const cleanMessage = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!cleanMessage) throw new Error('메시지를 입력해주세요.');
    const chatMessage = {
      id: randomUUID(),
      playerId: player.id,
      nickname: player.nickname,
      color: player.color,
      message: cleanMessage,
      timestamp: Date.now()
    };
    this.chatMessages.push(chatMessage);
    this.chatMessages = this.chatMessages.slice(-50);
    return chatMessage;
  }

  addLog(message, type = 'system') {
    this.logs.push({ id: randomUUID(), type, message, timestamp: Date.now() });
    this.logs = this.logs.slice(-80);
  }

  toJSON(viewerId) {
    return {
      code: this.code,
      hostId: this.hostId,
      status: this.status,
      maxPlayers: this.maxPlayers,
      settings: this.settings,
      round: this.round,
      turnPlayerIndex: this.turnPlayerIndex,
      roundPlacementComplete: this.roundPlacementComplete,
      settlementPending: this.settlementPending,
      settlementReadyAt: this.settlementReadyAt,
      roundResults: this.roundResults,
      lastAction: this.lastAction,
      lastPlacement: this.lastPlacement,
      openingNeutralPending: this.openingNeutralPending,
      rewardDeckCount: this.rewardDeck?.length ?? 0,
      turnDeadline: this.turnDeadline,
      finalRanking: this.status === 'GAME_OVER' ? this.finalRanking() : [],
      chatMessages: this.chatMessages,
      logs: this.logs,
      players: this.players.map((player) => ({
        ...player,
        dice: player.id === viewerId ? player.dice : []
      })),
      casinos: this.casinos
    };
  }
}
