import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../client/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../client/js/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../client/css/style.css', import.meta.url), 'utf8');

test('게임 이름과 인원별 플레이 방법을 제공한다', () => {
  assert.match(html, /<title>라스베가스<\/title>/);
  for (const playerCount of [2, 3, 4, 5]) {
    assert.match(html, new RegExp(`data-rule-panel="${playerCount}"`));
  }
});

test('주사위 굴림 효과는 새로운 굴림 데이터에만 적용한다', () => {
  assert.match(script, /diceSignature !== state\.lastDiceSignature/);
  assert.match(script, /shouldAnimate \? 'rolling-in'/);
  assert.doesNotMatch(script, /setTimeout\(\(\) => \{ state\.rolling = false; renderDice/);
  assert.match(styles, /\.die\.rolling-in \{ animation:dice-in/);
});

test('게임 종료 동작과 사운드 설정 UI를 제공한다', () => {
  for (const id of ['restart-game-button', 'return-lobby-button', 'leave-room-button', 'sound-toggle']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /function playSound\(type\)/);
  assert.match(styles, /@keyframes settlement-in/);
});

test('방 설정, 턴 타이머와 게임 로그 UI를 제공한다', () => {
  for (const id of ['max-players', 'dice-count', 'round-count', 'turn-seconds', 'turn-timer', 'game-log-list']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /window\.setInterval\(renderTimer, 250\)/);
});

test('모바일 안전 영역과 키보드 접근성을 제공한다', () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /role="timer" aria-live="polite"/);
  assert.match(html, /role="tabpanel"/);
  assert.match(script, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
  assert.match(styles, /100dvh/);
  assert.match(styles, /safe-area-inset-bottom/);
  assert.match(styles, /prefers-reduced-motion:reduce/);
  assert.match(styles, /\.die \{ width:54px; height:54px;/);
});

test('내 차례 강조와 모바일 가로 화면 안내를 제공한다', () => {
  for (const id of ['turn-alert', 'turn-alert-action', 'orientation-hint', 'orientation-dismiss']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /classList\.toggle\('my-turn', myTurn\)/);
  assert.match(script, /document\.title = myTurn \? '🎲 내 차례 · 라스베가스'/);
  assert.match(styles, /\.turn-alert\.visible/);
  assert.match(styles, /orientation:portrait/);
  assert.match(styles, /orientation:landscape/);
});

test('카지노 직접 배치와 초대 링크 참가를 제공한다', () => {
  for (const id of ['copy-invite', 'room-code']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(script, /function inviteLink/);
  assert.match(script, /function applyInviteFromLocation/);
  assert.match(script, /function normalizeRoomCode/);
  assert.match(script, /function placeSelectedDice\(casinoNumber\)/);
  assert.match(script, /#casino-board'\)\.addEventListener\('click', tryPlaceOnCasino/);
  assert.match(styles, /\.casino-card\.can-place/);
});

test('3인전 남는 주사위는 시스템 배정 상태를 표시한다', () => {
  assert.match(script, /남는 주사위 배정 중…/);
  assert.doesNotMatch(script, /emit\(state\.room\?\.openingNeutralPending \? 'rollOpeningNeutral'/);
  assert.match(html, /시스템이 자동으로 굴려/);
});

test('배치와 내 차례에 맞춘 효과음과 칩 배치 효과를 제공한다', () => {
  assert.match(script, /playSound\('turn'\)/);
  assert.match(script, /playSound\('neutral'\)/);
  assert.match(script, /const SOUND_ASSETS = Object\.freeze/);
  assert.match(script, /your-turn\.mp3/);
  assert.match(script, /function playSoundAsset\(type\)/);
  assert.match(script, /function playFallbackTone\(type\)/);
  assert.match(script, /just-placed/);
  assert.match(styles, /@keyframes chip-drop/);
  assert.match(styles, /\.casino-card\.just-placed/);
});

test('마지막 배치 확인과 라운드 수익 요약을 제공한다', () => {
  for (const id of ['placement-flash', 'round-summary', 'settlement-board']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /function renderPlacementFlash\(room\)/);
  assert.match(script, /function renderRoundSummary\(room\)/);
  assert.match(script, /function renderSettlementBoard\(room\)/);
  assert.match(script, /room\.lastPlacement \?\? room\.lastAction/);
  assert.match(styles, /\.casino-card\.last-placement/);
  assert.match(styles, /\.round-earnings/);
});

test('진행 중 게임 포기와 제외 처리를 제공한다', () => {
  assert.match(html, /id="forfeit-button"/);
  assert.match(script, /function forfeitGame\(\)/);
  assert.match(script, /emit\('forfeitGame'\)/);
  assert.match(script, /filter\(\(player\) => !player\.abandoned\)/);
  assert.match(styles, /\.topbar-forfeit/);
  assert.match(styles, /\.room-actions \.topbar-rule \{ display:none; \}/);
});

test('큰 주사위와 선택 안내로 주사위 조작을 명확하게 한다', () => {
  assert.match(html, /id="selection-summary"/);
  assert.match(script, /눈 주사위 \$\{selectedCount\}개 선택됨/);
  assert.match(styles, /\.die \{ flex:0 0 auto; width:60px; height:60px;/);
  assert.match(styles, /\.face i \{ width:11px; height:11px;/);
  assert.match(styles, /\.die\.selected \{ border-color:var\(--yellow\); transform:translateY\(-7px\) scale\(1\.06\)/);
});

test('카지노 판 위 배치 주사위도 눈금과 색상으로 구분한다', () => {
  assert.match(script, /class="board-die/);
  assert.match(script, /pipMarkup\(group\.face\)/);
  assert.match(styles, /\.board-die \{[^}]*width:34px; height:34px;/);
  assert.match(styles, /\.board-die \.face i \{ width:6px; height:6px;/);
});
