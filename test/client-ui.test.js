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
  assert.match(styles, /\.die \{ width:44px; height:44px;/);
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
