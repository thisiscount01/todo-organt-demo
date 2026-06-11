'use strict';
/*
 * 세포 키우기 게임 — 얇은 서버 (server.js)
 *
 * 역할(합의된 방향): 시뮬레이션 권위는 클라이언트. 서버는 얇게 유지한다.
 *   1) public/ 정적 서빙
 *   2) 세이브 저장/로드 라운드트립 (파일 영속)
 *   3) 점수판(최고 바이오매스) 저장/조회
 *
 * ── 풀스택(1513819693410942976)과 합의 대상인 세이브/점수 API 계약(제안) ──
 *   POST /api/save        body: { slot:string, state:object }      → { ok:true }
 *   GET  /api/load/:slot                                            → { ok:true, state:object|null }
 *   POST /api/score       body: { name:string, score:number }      → { ok:true, rank:number }
 *   GET  /api/scores                                                → { ok:true, scores:[{name,score,at}] }
 *   상태 직렬화 스키마는 클라이언트(app.js)의 serialize()/SAVE_VERSION 가 기준.
 *   서버는 state 내용을 해석하지 않고 그대로 보관/반환한다(불투명 blob).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, '.data');
const SAVE_FILE = path.join(DATA_DIR, 'saves.json');
const SCORE_FILE = path.join(DATA_DIR, 'scores.json');

// ───────────────────────── 영속 스토어 (파일 기반) ─────────────────────────
function ensureData() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}
function writeJson(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj)); return true; }
  catch (e) { console.error('write fail', file, e.message); return false; }
}
ensureData();
let SAVES = readJson(SAVE_FILE, {});      // { [slot]: { state, at } }
let SCORES = readJson(SCORE_FILE, []);    // [{ name, score, at }]

// ───────────────────────── 정적 파일 서빙 ─────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // 경로 탈출 방지
  const safe = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ───────────────────────── 본문 파서 ─────────────────────────
function readBody(req, cb) {
  let body = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1e6) { tooBig = true; req.destroy(); } // 1MB 상한
  });
  req.on('end', () => {
    if (tooBig) return cb(new Error('payload too large'));
    if (!body) return cb(null, {});
    try { cb(null, JSON.parse(body)); } catch (e) { cb(e); }
  });
  req.on('error', (e) => cb(e));
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ───────────────────────── 라우팅 ─────────────────────────
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const method = req.method;

  // 세이브 저장
  if (method === 'POST' && url === '/api/save') {
    return readBody(req, (err, data) => {
      if (err || !data || typeof data.slot !== 'string' || typeof data.state !== 'object' || data.state === null) {
        return sendJson(res, 400, { ok: false, error: 'bad request' });
      }
      SAVES[data.slot] = { state: data.state, at: Date.now() };
      writeJson(SAVE_FILE, SAVES);
      return sendJson(res, 200, { ok: true });
    });
  }

  // 세이브 로드
  if (method === 'GET' && url.startsWith('/api/load/')) {
    const slot = decodeURIComponent(url.slice('/api/load/'.length));
    const rec = SAVES[slot];
    return sendJson(res, 200, { ok: true, state: rec ? rec.state : null, at: rec ? rec.at : null });
  }

  // 점수 등록
  if (method === 'POST' && url === '/api/score') {
    return readBody(req, (err, data) => {
      if (err || !data || typeof data.score !== 'number' || !isFinite(data.score)) {
        return sendJson(res, 400, { ok: false, error: 'bad request' });
      }
      const name = (typeof data.name === 'string' ? data.name : '익명').slice(0, 24) || '익명';
      SCORES.push({ name, score: Math.floor(data.score), at: Date.now() });
      SCORES.sort((a, b) => b.score - a.score);
      SCORES = SCORES.slice(0, 50);
      writeJson(SCORE_FILE, SCORES);
      const rank = SCORES.findIndex(s => s.name === name && s.score === Math.floor(data.score)) + 1;
      return sendJson(res, 200, { ok: true, rank });
    });
  }

  // 점수판 조회
  if (method === 'GET' && url === '/api/scores') {
    return sendJson(res, 200, { ok: true, scores: SCORES.slice(0, 10) });
  }

  // 헬스체크
  if (method === 'GET' && url === '/api/health') {
    return sendJson(res, 200, { ok: true, up: true });
  }

  // 그 외 → 정적 파일
  if (method === 'GET') return serveStatic(req, res);
  res.writeHead(405); res.end('method not allowed');
});

server.listen(PORT, () => {
  console.log('세포 키우기 게임 서버 기동 → http://localhost:' + PORT);
});
