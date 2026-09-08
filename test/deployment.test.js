import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const render = await readFile(new URL('../render.yaml', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../.github/workflows/node-ci.yml', import.meta.url), 'utf8');
const server = await readFile(new URL('../server/server.js', import.meta.url), 'utf8');

test('Render 웹 서비스가 빌드·실행·상태 확인을 정의한다', () => {
  assert.match(render, /runtime: node/);
  assert.match(render, /buildCommand: npm ci/);
  assert.match(render, /startCommand: npm start/);
  assert.match(render, /healthCheckPath: \/health/);
  assert.match(render, /autoDeployTrigger: checksPass/);
});

test('GitHub Actions에서 Node 20으로 테스트한다', () => {
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v7/);
  assert.match(workflow, /node-version: 20\.x/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
});

test('서버가 호스팅 포트와 종료 신호를 처리한다', () => {
  assert.match(server, /process\.env\.PORT/);
  assert.match(server, /app\.get\('\/health'/);
  assert.match(server, /process\.on\('SIGTERM'/);
  assert.match(server, /process\.on\('SIGINT'/);
});
