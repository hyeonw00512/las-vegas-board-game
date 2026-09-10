const socket = io();
const SESSION_KEY = 'lasVegasRoomSession';
const state = { room: null, playerId: null, rolling: false, actionLocked: false, lastDiceSignature: '', lastPlacementActionId: '', lastTurnKey: '', unreadChat: 0, soundEnabled: localStorage.getItem('lasVegasSound') !== 'off', orientationHintDismissed: sessionStorage.getItem('lasVegasOrientationHint') === 'dismissed' };
let audioContext;
const SOUND_ASSETS = Object.freeze({
  roll: '/sounds/dice-roll.mp3',
  place: '/sounds/dice-place.mp3',
  neutral: '/sounds/neutral-place.mp3',
  round: '/sounds/round-result.mp3',
  next: '/sounds/next-round.mp3',
  win: '/sounds/victory.mp3',
  turn: '/sounds/your-turn.mp3'
});
const soundPlayers = new Map();
const unavailableSoundAssets = new Set();

if (window.Phaser) {
  new window.Phaser.Game({
    type: window.Phaser.CANVAS,
    parent: 'phaser-ambient',
    transparent: true,
    width: 1280,
    height: 720,
    scale: { mode: window.Phaser.Scale.RESIZE },
    scene: {
      create() {
        for (let index = 0; index < 18; index += 1) {
          const chip = this.add.circle(
            window.Phaser.Math.Between(0, this.scale.width),
            window.Phaser.Math.Between(0, this.scale.height),
            window.Phaser.Math.Between(1, 3),
            index % 3 === 0 ? 0xf5df5b : 0x42f5a4,
            0.16
          );
          this.tweens.add({
            targets: chip,
            y: chip.y - window.Phaser.Math.Between(60, 180),
            alpha: { from: 0.05, to: 0.28 },
            duration: window.Phaser.Math.Between(3500, 7000),
            yoyo: true,
            repeat: -1,
            ease: 'Sine.inOut'
          });
        }
      }
    }
  });
}

const $ = (selector) => document.querySelector(selector);
const screens = ['#start-screen', '#lobby-screen', '#game-screen'];

function showScreen(id) {
  for (const selector of screens) $(selector).classList.toggle('hidden', selector !== id);
  $('#chat-toggle').classList.toggle('visible', id === '#game-screen');
  if (id !== '#game-screen') document.title = '라스베가스';
}

function currentPlayer() {
  return state.room?.players.find((player) => player.id === state.playerId);
}

function turnPlayer() {
  return state.room?.players[state.room.turnPlayerIndex];
}

function isMyTurn() {
  return turnPlayer()?.id === state.playerId && !state.room?.roundPlacementComplete && !state.room?.openingNeutralPending;
}

function totalRemainingDice(player) {
  return (player?.remainingDice ?? 0) + (player?.remainingNeutralDice ?? 0);
}

function errorAt(selector, message = '') {
  $(selector).textContent = message;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  window.setTimeout(() => element.classList.remove('show'), 1600);
}

function playSound(type) {
  if (!state.soundEnabled) return;
  if (playSoundAsset(type)) return;
  playFallbackTone(type);
}

function playSoundAsset(type) {
  const source = SOUND_ASSETS[type];
  if (!source || unavailableSoundAssets.has(type) || !window.Audio) return false;
  let player = soundPlayers.get(type);
  if (!player) {
    player = new Audio(source);
    player.preload = 'auto';
    player.volume = type === 'turn' ? 0.58 : 0.46;
    player.addEventListener('error', () => unavailableSoundAssets.add(type), { once: true });
    soundPlayers.set(type, player);
  }
  try {
    player.pause();
    player.currentTime = 0;
    const started = player.play();
    if (started?.catch) {
      started.catch(() => {
        unavailableSoundAssets.add(type);
        playFallbackTone(type);
      });
    }
    return true;
  } catch {
    unavailableSoundAssets.add(type);
    return false;
  }
}

function playFallbackTone(type) {
  const notes = {
    roll: [170, 120, 155], place: [280, 430], round: [330, 440, 660],
    next: [260, 390], win: [392, 523, 659, 784], turn: [523, 659], neutral: [220, 330, 440]
  }[type] || [320];
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  audioContext ??= new AudioContextClass();
  audioContext.resume().catch(() => {});
  const start = audioContext.currentTime;
  notes.forEach((frequency, index) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const time = start + index * 0.075;
    oscillator.type = type === 'roll' ? 'triangle' : type === 'neutral' ? 'square' : 'sine';
    oscillator.frequency.setValueAtTime(frequency, time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(type === 'turn' ? 0.055 : 0.08, time + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.11);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(time);
    oscillator.stop(time + 0.12);
  });
}

function renderSoundButton() {
  const button = $('#sound-toggle');
  button.textContent = `사운드 ${state.soundEnabled ? 'ON' : 'OFF'}`;
  button.setAttribute('aria-pressed', String(state.soundEnabled));
  button.title = 'sounds 폴더에 음원 파일이 있으면 실제 음원을, 없으면 기본 효과음을 사용합니다.';
}

function emit(event, data = {}) {
  return new Promise((resolve) => socket.emit(event, data, resolve));
}

function nickname() {
  return $('#nickname').value.trim();
}

function normalizeRoomCode(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return String(url.searchParams.get('room') || url.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  } catch {
    const inviteCode = text.match(/(?:^|[?&#])(?:room|code)=([^&#\s]+)/i)?.[1];
    let decoded = inviteCode || text;
    try { decoded = decodeURIComponent(decoded); } catch { /* 이미 잘못 인코딩된 입력은 원문으로 처리 */ }
    return decoded.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  }
}

function inviteLink(code = state.room?.code) {
  return `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(code || '')}`;
}

function applyInviteFromLocation() {
  const code = normalizeRoomCode(window.location.href);
  if (!code) return;
  $('#room-code').value = code;
  $('#start-error').textContent = '초대 링크가 적용되었습니다. 닉네임을 입력하고 참가하세요.';
}

function renderLobby() {
  const room = state.room;
  if (!room) return;
  $('#lobby-code').textContent = room.code;
  $('#player-count').textContent = `${room.players.length} / ${room.maxPlayers}`;
  $('#lobby-settings').textContent = `최대 ${room.settings.maxPlayers}명 · 주사위 ${room.settings.diceCount}개 · ${room.settings.rounds}라운드 · ${room.settings.turnSeconds ? `턴 ${room.settings.turnSeconds}초` : '시간 제한 없음'}`;
  $('#lobby-players').innerHTML = room.players.map((player) => `
    <article class="player-row ${player.ready ? 'ready' : ''} ${player.connected ? '' : 'offline'}">
      <span class="player-token" style="--player:${player.color}">${player.nickname.slice(0, 1).toUpperCase()}</span>
      <div><b>${escapeHtml(player.nickname)}</b><small>${player.id === room.hostId ? 'HOST' : 'PLAYER'}</small></div>
      <span class="ready-state">${player.connected ? (player.ready ? 'READY' : 'WAIT') : 'RECONNECTING'}</span>
    </article>
  `).join('');

  const me = currentPlayer();
  $('#ready-button').textContent = me?.ready ? '준비 취소' : '준비하기';
  const canStart = room.hostId === state.playerId && room.players.length >= 2 && room.players.every((player) => player.ready && player.connected);
  $('#start-button').disabled = !canStart;
  $('#start-button').classList.toggle('hidden', room.hostId !== state.playerId);
}

function renderGame() {
  const room = state.room;
  if (!room) return;
  const me = currentPlayer();
  const myTurn = isMyTurn();
  const latestAction = room.lastPlacement ?? room.lastAction;
  const isNewPlacement = Boolean((latestAction?.face || latestAction?.faces?.length) && latestAction.id !== state.lastPlacementActionId);
  $('#game-screen').classList.toggle('my-turn', myTurn);
  $('#turn-alert').classList.toggle('visible', myTurn);
  document.title = myTurn ? '🎲 내 차례 · 라스베가스' : '라스베가스';
  $('#round-number').textContent = room.round;
  $('#round-total').textContent = room.settings.rounds;
  $('#game-code').textContent = room.code;
  $('#deck-count').textContent = room.rewardDeckCount;
  $('#score-players').innerHTML = room.players.filter((player) => !player.abandoned).map((player) => `
    <article class="score-row ${player.id === state.playerId ? 'is-me' : ''} ${player.id === turnPlayer()?.id && !room.roundPlacementComplete ? 'is-turn' : ''} ${player.connected ? '' : 'offline'}">
      <span class="score-color" style="--player:${player.color}"></span>
      <div><b>${escapeHtml(player.nickname)}</b><small>${player.connected ? (player.id === state.playerId ? 'YOU' : 'PLAYER') : 'RECONNECTING'}</small></div>
      <strong>₩${player.money}<small>${player.remainingDice} + <em>${player.remainingNeutralDice}</em> DICE</small></strong>
    </article>
  `).join('');
  $('#game-log-list').innerHTML = [...(room.logs ?? [])].slice(-8).reverse().map((log) => `
    <div class="log-row ${log.type}"><i></i><span>${escapeHtml(log.message)}</span></div>
  `).join('');
  $('#casino-board').innerHTML = [...room.casinos].sort((a, b) => a.number - b.number).map((casino) => {
    const wasPlaced = latestAction?.face === casino.number || latestAction?.faces?.includes(casino.number);
    const placementClass = `${isNewPlacement && wasPlaced ? `just-placed ${latestAction?.openingNeutral ? 'neutral-arrival' : ''}` : ''} ${wasPlaced ? 'last-placement' : ''}`;
    return `
    <article class="casino-card casino-${casino.number} ${myTurn && me?.selectedFace === casino.number ? 'can-place' : ''} ${placementClass}" data-casino="${casino.number}" role="button" tabindex="0" aria-label="${casino.number}번 카지노${myTurn && me?.selectedFace === casino.number ? ', 선택한 주사위 배치' : ''}" aria-disabled="${myTurn && me?.selectedFace === casino.number ? 'false' : 'true'}">
      <div class="casino-number">${casino.number}</div>
      <div class="reward-stack">${casino.rewards.map((reward) => `<span>₩${reward}</span>`).join('')}</div>
      <div class="bet-zone">${renderPlacedDice(casino)}</div>
      ${wasPlaced ? `<span class="last-placement-marker">${latestAction?.openingNeutral ? 'SYSTEM' : 'LAST BET'}</span>` : ''}
    </article>
  `;
  }).join('');
  if (isNewPlacement) state.lastPlacementActionId = latestAction.id;
  renderPlacementFlash(room);
  if (room.openingNeutralPending) {
    $('#turn-label').textContent = '3인 규칙 · 시스템 자동 처리';
    $('#turn-player').textContent = '남는 주사위 배정 중…';
  } else if (room.roundPlacementComplete) {
    $('#turn-label').textContent = '모든 주사위 배치 완료';
    $('#turn-player').textContent = room.settlementPending ? '마지막 배치를 확인하는 중…' : '라운드 정산 준비';
  } else if (isMyTurn()) {
    $('#turn-label').textContent = me?.dice.length ? '같은 숫자는 한 번에 선택됩니다' : '당신의 차례입니다';
    $('#turn-player').textContent = me?.dice.length ? '배치할 숫자를 선택하세요' : '주사위를 굴려주세요';
  } else {
    $('#turn-label').textContent = '다른 플레이어가 선택 중입니다';
    $('#turn-player').textContent = `${turnPlayer()?.nickname ?? '플레이어'}의 차례`;
  }
  $('#turn-alert-action').textContent = room.openingNeutralPending
    ? '남는 주사위 배정 중…'
    : room.roundPlacementComplete && room.settlementPending
      ? '마지막 배치와 판을 확인하세요'
    : me?.dice.length ? '숫자를 선택하고 카지노에 배치하세요' : '주사위를 굴려주세요';
  renderDice(me);
  renderSettlement();
  renderChat();
  renderTimer();
}

function renderTimer() {
  const timer = $('#turn-timer');
  const deadline = state.room?.turnDeadline;
  if (!deadline || state.room?.status !== 'PLAYING') {
    timer.classList.add('hidden');
    timer.classList.remove('urgent');
    return;
  }
  const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  timer.textContent = `${seconds}s`;
  timer.classList.remove('hidden');
  timer.classList.toggle('urgent', seconds <= 10);
}

window.setInterval(renderTimer, 250);

function renderChat() {
  if (!state.room) return;
  const container = $('#chat-messages');
  const messages = state.room.chatMessages ?? [];
  container.innerHTML = messages.length ? messages.map((message) => `
    <article class="chat-message ${message.playerId === state.playerId ? 'mine' : ''}">
      <div><b style="--player:${message.color}">${escapeHtml(message.nickname)}</b><time>${new Date(message.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</time></div>
      <p>${escapeHtml(message.message)}</p>
    </article>
  `).join('') : '<p class="chat-empty">아직 메시지가 없습니다.</p>';
  container.scrollTop = container.scrollHeight;
}

function renderSettlement() {
  const room = state.room;
  const overlay = $('#round-overlay');
  const visible = room?.status === 'ROUND_RESULT' || room?.status === 'GAME_OVER';
  overlay.classList.toggle('hidden', !visible);
  if (!visible) return;

  const gameOver = room.status === 'GAME_OVER';
  $('#settlement-kicker').textContent = gameOver ? 'FINAL RESULT' : 'ROUND RESULT';
  $('#settlement-title').textContent = gameOver ? '게임 종료' : `${room.round}라운드 정산`;
  $('#settlement-round').textContent = gameOver ? 'FINISH' : `${room.round} / ${room.settings.rounds}`;
  renderRoundSummary(room);
  renderSettlementBoard(room);

  if (gameOver) {
    $('#settlement-results').innerHTML = room.finalRanking.map((player, index) => `
      <article class="final-row rank-${player.rank}" style="--result-delay:${index * 120}ms">
        <strong>${player.rank}</strong><i style="--player:${player.color}"></i>
        <div><b>${escapeHtml(player.nickname)}</b><small>${player.rank === 1 ? 'WINNER' : 'PLAYER'}</small></div>
        <em>₩${player.money}</em>
      </article>
    `).join('');
    $('#settlement-help').textContent = `${room.settings.rounds}라운드의 모든 보상을 합산했습니다.`;
  } else {
    $('#settlement-results').innerHTML = room.roundResults.map((result, index) => `
      <article class="result-card" style="--result-delay:${index * 140}ms">
        <strong class="result-number">${result.casinoNumber}</strong>
        <div class="result-awards">
          ${result.awards.length ? result.awards.map((award) => `
            <span class="award ${award.isNeutral ? 'neutral-award' : ''}">
              <i style="--player:${award.color}"></i>
              <b>${escapeHtml(award.nickname)}</b>
              <em>${award.isNeutral ? '폐기 ' : '+'}₩${award.reward}</em>
            </span>
          `).join('') : '<small>지급 없음</small>'}
        </div>
        ${result.counts.some((entry) => entry.tied) ? '<small class="tie-label">동률 제외</small>' : ''}
      </article>
    `).join('');
    $('#settlement-help').textContent = state.playerId === room.hostId ? '결과를 확인한 뒤 다음 라운드를 시작하세요.' : '방장이 다음 라운드를 시작할 때까지 기다려주세요.';
  }

  const nextButton = $('#next-round-button');
  nextButton.classList.toggle('hidden', gameOver || state.playerId !== room.hostId);
  nextButton.disabled = gameOver || state.actionLocked;
  $('#final-actions').classList.toggle('hidden', !gameOver);
  $('#restart-game-button').classList.toggle('hidden', !gameOver || state.playerId !== room.hostId);
  $('#return-lobby-button').classList.toggle('hidden', !gameOver || state.playerId !== room.hostId);
}

function renderPlacementFlash(room) {
  const element = $('#placement-flash');
  const action = room.lastPlacement;
  if (!action?.id) {
    element.classList.add('hidden');
    return;
  }
  const destinations = action.faces?.length ? [...new Set(action.faces)].join(' · ') : action.face;
  const amount = action.count ? `주사위 ${action.count}개를 ` : '';
  element.classList.remove('hidden');
  element.classList.toggle('final-placement', Boolean(room.roundPlacementComplete && room.settlementPending));
  element.innerHTML = `<span>${room.roundPlacementComplete && room.settlementPending ? 'FINAL BET' : 'LAST BET'}</span><b>${escapeHtml(action.nickname)}${action.openingNeutral ? '이' : '님이'} ${destinations}번 카지노에 ${amount}놓았습니다.</b>`;
}

function roundEarnings(room) {
  const activePlayers = room.players.filter((player) => !player.abandoned);
  const earnings = new Map(activePlayers.map((player) => [player.id, 0]));
  for (const result of room.roundResults ?? []) {
    for (const award of result.awards ?? []) {
      if (!award.isNeutral) earnings.set(award.playerId, (earnings.get(award.playerId) ?? 0) + award.reward);
    }
  }
  return earnings;
}

function renderRoundSummary(room) {
  const action = room.lastPlacement;
  const destinations = action?.faces?.length ? [...new Set(action.faces)].join(' · ') : action?.face;
  const ending = action
    ? `${escapeHtml(action.nickname)}${action.openingNeutral ? '이' : '님이'} ${destinations}번 카지노에 ${action.count ? `주사위 ${action.count}개를 ` : ''}놓으며 마무리되었습니다.`
    : '모든 주사위 배치가 끝났습니다.';
  const earnings = roundEarnings(room);
  $('#round-summary').innerHTML = `
    <p><span>ROUND RECAP</span><b>${room.round}라운드는 ${ending}</b></p>
    <div class="round-earnings">${room.players.filter((player) => !player.abandoned).map((player) => `<span><i style="--player:${player.color}"></i>${escapeHtml(player.nickname)} <b>+₩${earnings.get(player.id) ?? 0}</b></span>`).join('')}</div>
  `;
}

function renderSettlementBoard(room) {
  const action = room.lastPlacement;
  $('#settlement-board').innerHTML = [...room.casinos].sort((a, b) => a.number - b.number).map((casino) => {
    const last = action?.face === casino.number || action?.faces?.includes(casino.number);
    return `<article class="settlement-casino ${last ? 'was-last' : ''}"><b>${casino.number}</b><div>${casino.rewards.map((reward) => `<span>₩${reward}</span>`).join('')}</div><small>${renderPlacedDice(casino)}</small>${last ? '<em>LAST</em>' : ''}</article>`;
  }).join('');
}

function renderPlacedDice(casino) {
  if (!casino.placedDice.length) return '<small>BET ZONE</small>';
  const groups = casino.placedDice.reduce((result, die) => {
    const current = result.get(die.playerId) || { ...die, count: 0 };
    current.count += 1;
    result.set(die.playerId, current);
    return result;
  }, new Map());
  return [...groups.values()].map((group) => `
    <span class="placed-group" title="${escapeHtml(group.nickname)} 주사위 ${group.count}개">
      <i style="--player:${group.color}"></i><b>${group.count}</b>
    </span>
  `).join('');
}

function renderDice(player) {
  const row = $('#dice-row');
  const dice = player?.dice ?? [];
  const diceSignature = dice.map((die) => `${die.face}${die.isNeutral ? 'N' : 'P'}`).join('-');
  const shouldAnimate = Boolean(diceSignature) && diceSignature !== state.lastDiceSignature;
  state.lastDiceSignature = diceSignature;
  const openingNeutral = state.room?.openingNeutralPending;
  $('#roll-button').disabled = state.rolling || state.actionLocked || dice.length > 0 || !isMyTurn();
  $('#roll-button').innerHTML = openingNeutral ? 'WAIT <span>시스템 배정 중</span>' : 'ROLL <span>주사위 굴리기</span>';
  $('#dice-hint').textContent = state.room?.roundPlacementComplete
    ? '배치 완료'
    : openingNeutral
      ? '남는 주사위 배정 중…'
    : dice.length
      ? `${totalRemainingDice(player)}개 굴림 완료`
      : isMyTurn() ? `내 주사위 ${player?.remainingDice ?? 0} · 흰색 ${player?.remainingNeutralDice ?? 0}` : `${turnPlayer()?.nickname ?? ''} 차례`;
  if (!dice.length) {
    const waitingCount = Math.min(10, Math.max(1, totalRemainingDice(player) || state.room?.settings.diceCount || 8));
    row.innerHTML = `<span class="empty-dice">${Array.from({ length: waitingCount }, () => '•').join(' ')}</span>`;
  } else {
    row.innerHTML = dice.map((die, index) => `
      <button class="die ${shouldAnimate ? 'rolling-in' : ''} ${player.selectedFace === die.face ? 'selected' : ''} ${die.isNeutral ? 'neutral-die' : ''}" data-face="${die.face}" style="--delay:${index * 55}ms;--die:${die.isNeutral ? '#f4f1e8' : player.color}" aria-label="${die.isNeutral ? '중립 ' : ''}주사위 ${die.face}">
        ${pipMarkup(die.face)}
      </button>
    `).join('');
  }
  const selectedCount = dice.filter((die) => die.face === player?.selectedFace).length;
  const placeButton = $('#place-button');
  placeButton.classList.toggle('hidden', !selectedCount || !isMyTurn());
  placeButton.disabled = state.actionLocked || !isMyTurn();
  placeButton.textContent = selectedCount ? `${player.selectedFace}번 장소에 ${selectedCount}개 배치` : '';
}

function pipMarkup(face) {
  const positions = {
    1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9]
  };
  return `<span class="face">${positions[face].map((position) => `<i class="pip-${position}"></i>`).join('')}</span>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

async function enter(event, payload) {
  errorAt('#start-error');
  const response = await emit(event, payload);
  if (!response?.ok) return errorAt('#start-error', response?.message || '잠시 후 다시 시도해주세요.');
  state.room = response.room;
  state.playerId = response.playerId;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    code: response.room.code,
    reconnectToken: response.reconnectToken
  }));
  showScreen('#lobby-screen');
  renderLobby();
}

$('#create-button').addEventListener('click', () => enter('createRoom', {
  nickname: nickname(),
  maxPlayers: Number($('#max-players').value),
  diceCount: Number($('#dice-count').value),
  rounds: Number($('#round-count').value),
  turnSeconds: Number($('#turn-seconds').value)
}));
async function joinRoom() {
  const code = normalizeRoomCode($('#room-code').value);
  if (code.length !== 5) return errorAt('#start-error', '방 코드 또는 올바른 초대 링크를 입력해주세요.');
  $('#room-code').value = code;
  return enter('joinRoom', { nickname: nickname(), code });
}
$('#join-button').addEventListener('click', joinRoom);
$('#room-code').addEventListener('input', (event) => {
  const text = event.target.value.trim();
  if (!/^https?:\/\//i.test(text)) event.target.value = text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
});
$('#room-code').addEventListener('keydown', (event) => { if (event.key === 'Enter') joinRoom(); });
$('#copy-code').addEventListener('click', async () => { await navigator.clipboard.writeText(state.room.code); toast('방 코드를 복사했습니다.'); });
$('#copy-invite').addEventListener('click', async () => { await navigator.clipboard.writeText(inviteLink()); toast('초대 링크를 복사했습니다.'); });
$('#ready-button').addEventListener('click', async () => { const response = await emit('toggleReady'); if (!response.ok) errorAt('#lobby-error', response.message); });
$('#start-button').addEventListener('click', async () => { const response = await emit('startGame'); if (!response.ok) errorAt('#lobby-error', response.message); });
$('#roll-button').addEventListener('click', async () => {
  if (state.rolling) return;
  state.rolling = true;
  playSound('roll');
  $('#roll-button').disabled = true;
  errorAt('#game-error');
  const response = await emit('rollDice');
  if (!response.ok) errorAt('#game-error', response.message);
  window.setTimeout(() => { state.rolling = false; }, 900);
});
$('#dice-row').addEventListener('click', async (event) => {
  const die = event.target.closest('.die');
  if (!die || state.rolling) return;
  const response = await emit('selectDice', { face: Number(die.dataset.face) });
  if (!response.ok) errorAt('#game-error', response.message);
});
async function placeSelectedDice(casinoNumber) {
  if (state.actionLocked || !isMyTurn()) return;
  const selectedFace = currentPlayer()?.selectedFace;
  if (!selectedFace) return errorAt('#game-error', '먼저 주사위 눈 하나를 선택해주세요.');
  if (casinoNumber && selectedFace !== casinoNumber) return errorAt('#game-error', `${selectedFace}번 주사위는 ${selectedFace}번 카지노에만 놓을 수 있습니다.`);
  state.actionLocked = true;
  $('#place-button').disabled = true;
  errorAt('#game-error');
  const response = await emit('placeDice');
  if (!response?.ok) errorAt('#game-error', response?.message || '배치하지 못했습니다.');
  state.actionLocked = false;
  renderDice(currentPlayer());
}

$('#place-button').addEventListener('click', () => placeSelectedDice());
function tryPlaceOnCasino(event) {
  const card = event.target.closest('.casino-card');
  if (!card) return;
  placeSelectedDice(Number(card.dataset.casino));
}
$('#casino-board').addEventListener('click', tryPlaceOnCasino);
$('#casino-board').addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  tryPlaceOnCasino(event);
});
$('#next-round-button').addEventListener('click', async () => {
  if (state.actionLocked) return;
  state.actionLocked = true;
  $('#next-round-button').disabled = true;
  const response = await emit('nextRound');
  if (!response?.ok) {
    errorAt('#game-error', response?.message || '다음 라운드를 시작하지 못했습니다.');
    state.actionLocked = false;
    renderSettlement();
  }
});

socket.on('roomState', (room) => {
  const previousStatus = state.room?.status;
  const previousTurnKey = state.lastTurnKey;
  state.room = room;
  if (room.status !== 'LOBBY') {
    state.actionLocked = false;
    showScreen('#game-screen');
    renderGame();
    if (previousStatus === 'PLAYING' && room.status === 'ROUND_RESULT') playSound('round');
    if (previousStatus !== 'GAME_OVER' && room.status === 'GAME_OVER') playSound('win');
    const turnKey = `${room.status}:${room.round}:${room.turnPlayerIndex}:${room.openingNeutralPending}`;
    if (previousTurnKey && previousTurnKey !== turnKey && isMyTurn()) playSound('turn');
    state.lastTurnKey = turnKey;
  } else {
    showScreen('#lobby-screen');
    renderLobby();
  }
});

socket.on('connect', async () => {
  const stored = sessionStorage.getItem(SESSION_KEY);
  if (!stored) return;
  try {
    const session = JSON.parse(stored);
    const response = await emit('restoreSession', session);
    if (!response?.ok) {
      sessionStorage.removeItem(SESSION_KEY);
      state.room = null;
      state.playerId = null;
      showScreen('#start-screen');
      errorAt('#start-error', response?.message || '기존 방을 복구하지 못했습니다.');
      return;
    }
    state.room = response.room;
    state.playerId = response.playerId;
    showScreen(response.room.status === 'LOBBY' ? '#lobby-screen' : '#game-screen');
    response.room.status === 'LOBBY' ? renderLobby() : renderGame();
    toast('기존 플레이어로 다시 연결했습니다.');
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
  }
});

applyInviteFromLocation();

socket.on('dicePlaced', ({ roundPlacementComplete }) => {
  playSound('place');
  if (roundPlacementComplete) toast('모든 주사위 배치가 끝났습니다.');
});

socket.on('openingNeutralPlaced', ({ dice }) => { playSound('neutral'); toast(`시스템이 흰색 주사위 ${dice.join(' · ')} 자동 배치`); });
socket.on('nextRound', ({ round }) => { playSound('next'); toast(`${round}라운드를 시작합니다.`); });
socket.on('gameRestarted', () => { playSound('next'); toast('새 게임을 시작합니다.'); });
socket.on('turnTimedOut', () => toast('제한 시간이 끝나 서버가 자동으로 배치했습니다.'));
socket.on('chatMessage', (message) => {
  if (!state.room) return;
  state.room.chatMessages = [...(state.room.chatMessages ?? []), message].slice(-50);
  renderChat();
  if (message.playerId !== state.playerId && window.matchMedia('(max-width: 1100px)').matches && !$('#chat-panel').classList.contains('open')) {
    state.unreadChat += 1;
    $('#chat-unread').textContent = state.unreadChat;
  }
});

$('#chat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#chat-input');
  const message = input.value.trim();
  if (!message) return;
  const response = await emit('chatMessage', { message });
  if (response?.ok) {
    input.value = '';
    errorAt('#chat-error');
  } else {
    errorAt('#chat-error', response?.message || '메시지를 보내지 못했습니다.');
  }
});

function openChat() {
  $('#chat-panel').classList.add('open');
  $('#chat-toggle').setAttribute('aria-expanded', 'true');
  state.unreadChat = 0;
  $('#chat-unread').textContent = '0';
  window.setTimeout(() => $('#chat-input').focus(), 0);
}

$('#chat-toggle').addEventListener('click', openChat);
$('#chat-close').addEventListener('click', () => {
  $('#chat-panel').classList.remove('open');
  $('#chat-toggle').setAttribute('aria-expanded', 'false');
  $('#chat-toggle').focus();
});

$('#sound-toggle').addEventListener('click', () => {
  state.soundEnabled = !state.soundEnabled;
  localStorage.setItem('lasVegasSound', state.soundEnabled ? 'on' : 'off');
  renderSoundButton();
  if (state.soundEnabled) playSound('place');
});
renderSoundButton();

if (state.orientationHintDismissed) $('#orientation-hint').classList.add('dismissed');
$('#orientation-dismiss').addEventListener('click', () => {
  state.orientationHintDismissed = true;
  sessionStorage.setItem('lasVegasOrientationHint', 'dismissed');
  $('#orientation-hint').classList.add('dismissed');
});

async function leaveRoom() {
  const response = await emit('leaveRoom');
  if (!response?.ok) return toast(response?.message || '방을 나가지 못했습니다.');
  sessionStorage.removeItem(SESSION_KEY);
  state.room = null;
  state.playerId = null;
  state.lastDiceSignature = '';
  showScreen('#start-screen');
  toast('방에서 나왔습니다.');
}

async function forfeitGame() {
  if (!window.confirm('게임을 포기하시겠습니까?\n포기하면 현재 게임과 최종 순위에서 제외되며 되돌릴 수 없습니다.')) return;
  const response = await emit('forfeitGame');
  if (!response?.ok) return toast(response?.message || '게임을 포기하지 못했습니다.');
  sessionStorage.removeItem(SESSION_KEY);
  state.room = null;
  state.playerId = null;
  state.lastDiceSignature = '';
  showScreen('#start-screen');
  toast('게임을 포기했습니다. 남은 플레이어는 계속 진행합니다.');
}

$('#lobby-leave-button').addEventListener('click', leaveRoom);
$('#leave-room-button').addEventListener('click', leaveRoom);
$('#forfeit-button').addEventListener('click', forfeitGame);
$('#restart-game-button').addEventListener('click', async () => {
  const response = await emit('restartGame');
  if (!response?.ok) toast(response?.message || '게임을 다시 시작하지 못했습니다.');
});
$('#return-lobby-button').addEventListener('click', async () => {
  const response = await emit('returnLobby');
  if (!response?.ok) toast(response?.message || '로비로 돌아가지 못했습니다.');
});

const rulesDialog = $('#rules-dialog');
document.querySelectorAll('.rules-open').forEach((button) => button.addEventListener('click', () => rulesDialog.showModal()));
$('#rules-close').addEventListener('click', () => rulesDialog.close());
rulesDialog.addEventListener('click', (event) => {
  if (event.target === rulesDialog) rulesDialog.close();
});
function activateRuleTab(button) {
  const playerCount = button.dataset.ruleTab;
  document.querySelectorAll('.rule-tab').forEach((tab) => {
    const active = tab === button;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.rule-panel').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.rulePanel !== playerCount));
}

document.querySelectorAll('.rule-tab').forEach((button) => {
  button.addEventListener('click', () => activateRuleTab(button));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('.rule-tab')];
    const current = tabs.indexOf(button);
    const target = event.key === 'Home' ? tabs[0]
      : event.key === 'End' ? tabs.at(-1)
      : tabs[(current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    activateRuleTab(target);
    target.focus();
  });
});

socket.on('disconnect', () => {
  if (state.room) toast('연결이 끊어졌습니다. 자동으로 재연결합니다.');
});
