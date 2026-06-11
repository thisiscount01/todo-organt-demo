'use strict';
/*
 * e2e-cell.js — QA 통합 검증 하니스 (public/·server.js 무수정, 검증 전용)
 *
 *  A) 서버 API 라운드트립/엣지   : 실제 server.js를 in-process 기동 후 http로 직접 검증
 *  B) 게임 핵심 로직(헤드리스)    : 실제 public/app.js를 DOM/canvas 스텁 위에서 구동
 *      - autotest 봇으로 핵심 루프(흡수→축적→구매→진화→자동생산) 30s 자동 재현
 *      - 경제 가드(자원0 차단·음수 금지·더블클릭) 직접 재현
 *      - 세이브 라운드트립(클라 serialize → /api/save → /api/load) 정확 복원
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PORT = 4071;
process.env.PORT = String(PORT);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ── 최소 HTTP 클라이언트 ──
function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => {
        let j = null; try { j = JSON.parse(b); } catch (_) {}
        resolve({ status: res.statusCode, json: j, raw: b }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ───────────────────────── A) 서버 API 검증 ─────────────────────────
async function testServer() {
  console.log('\n=== A) 서버 API (실제 server.js) ===');
  // 깨끗한 데이터 디렉터리 보장
  try { fs.rmSync(path.join(__dirname, '.data'), { recursive: true, force: true }); } catch (_) {}
  require('./server.js'); // 기동(listen)
  await sleep(400);

  const health = await req('GET', '/api/health');
  check('health 200', health.status === 200 && health.json && health.json.ok, JSON.stringify(health.json));

  const stateA = { v: 1, bm: 1234.5, totalEarned: 9876.25, stage: 2, upgrades: { membrane: 4, vacuole: 3, cilia: 1, divide: 2 }, bestEarned: 9876.25 };
  const save = await req('POST', '/api/save', { slot: 'default', state: stateA });
  check('save 200 ok', save.status === 200 && save.json && save.json.ok === true, JSON.stringify(save.json));

  const load = await req('GET', '/api/load/default');
  const back = load.json && load.json.state;
  const exact = back && JSON.stringify(back) === JSON.stringify(stateA);
  check('save→load 라운드트립 정확 일치(불투명 blob)', exact, exact ? '' : 'got=' + JSON.stringify(back));

  // 덮어쓰기
  const stateB = { ...stateA, bm: 42, stage: 0 };
  await req('POST', '/api/save', { slot: 'default', state: stateB });
  const load2 = await req('GET', '/api/load/default');
  check('동일 slot 덮어쓰기 반영', load2.json && load2.json.state && load2.json.state.bm === 42 && load2.json.state.stage === 0, JSON.stringify(load2.json.state));

  // 없는 slot → state null (크래시 없음)
  const miss = await req('GET', '/api/load/nope_slot_xyz');
  check('미존재 slot → state:null 안전 반환', miss.status === 200 && miss.json && miss.json.ok === true && miss.json.state === null, JSON.stringify(miss.json));

  // 손상/잘못된 입력 거부
  const bad1 = await req('POST', '/api/save', { state: { a: 1 } }); // slot 없음
  check('save 잘못된 입력(slot 누락) → 400 거부', bad1.status === 400, 'status=' + bad1.status);
  const bad2 = await req('POST', '/api/save', { slot: 's', state: null });
  check('save state:null → 400 거부', bad2.status === 400, 'status=' + bad2.status);

  // 점수판 랭킹
  await req('POST', '/api/score', { name: '가', score: 100 });
  await req('POST', '/api/score', { name: '나', score: 500 });
  const sc = await req('POST', '/api/score', { name: '다', score: 300 });
  check('score 등록 rank 반환', sc.json && sc.json.ok && typeof sc.json.rank === 'number', JSON.stringify(sc.json));
  const board = await req('GET', '/api/scores');
  const ord = board.json && board.json.scores;
  const sorted = ord && ord.length >= 3 && ord[0].score === 500 && ord[1].score === 300 && ord[2].score === 100;
  check('점수판 내림차순 정렬', sorted, JSON.stringify(ord && ord.map(s => s.score)));
  const badScore = await req('POST', '/api/score', { name: 'x', score: 'NaN!' });
  check('score 비수치 입력 → 400 거부', badScore.status === 400, 'status=' + badScore.status);
}

// ───────────────────────── B) 헤드리스 게임 로직 ─────────────────────────
function makeSandbox(search) {
  const logs = [];
  // ── 스텁 엘리먼트 ──
  function StubEl() {
    const self = {
      _children: [], _listeners: {}, _q: {},
      textContent: '', innerHTML: '', value: '', offsetWidth: 1,
      dataset: {}, style: {},
      classList: { _s: new Set(),
        add() { for (const a of arguments) self.classList._s.add(a); },
        remove() { for (const a of arguments) self.classList._s.delete(a); },
        toggle(c, f) { const on = f === undefined ? !self.classList._s.has(c) : !!f; on ? self.classList._s.add(c) : self.classList._s.delete(c); return on; },
        contains(c) { return self.classList._s.has(c); } },
      addEventListener(ev, fn) { (self._listeners[ev] = self._listeners[ev] || []).push(fn); },
      removeAttribute() {}, setAttribute() {},
      appendChild(c) { self._children.push(c); return c; },
      removeChild(c) { self._children = self._children.filter(x => x !== c); },
      querySelector(sel) { return self._q[sel] || (self._q[sel] = StubEl()); },
      getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 800 }; },
      getContext() { return ctxStub(); },
      width: 1280, height: 800,
      click() { (self._listeners['click'] || []).forEach(fn => fn({})); },
      fire(ev, arg) { (self._listeners[ev] || []).forEach(fn => fn(arg || {})); },
    };
    return self;
  }
  function ctxStub() {
    const g = { addColorStop() {} };
    return new Proxy({}, { get(_, k) {
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => g;
      if (k === 'canvas') return { width: 1280, height: 800 };
      return () => {};
    } });
  }
  const elById = {};
  const getEl = (id) => elById[id] || (elById[id] = StubEl());

  const localStore = new Map();
  const sandbox = {
    console: { log: (...a) => { logs.push(a.join(' ')); }, error: (...a) => { logs.push('ERR ' + a.join(' ')); }, warn() {} },
    Math, JSON, Date, Object, Array, Set, Map, Number, isFinite, parseInt, parseFloat,
    performance: { now: () => clockRef.t },
    requestAnimationFrame: (cb) => { rafRef.cb = cb; return 1; },
    cancelAnimationFrame() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: (k) => localStore.has(k) ? localStore.get(k) : null, setItem: (k, v) => localStore.set(k, String(v)), removeItem: (k) => localStore.delete(k) },
    location: { search: search },
    fetch: (url, opts) => fetchImpl(url, opts),
    document: {
      readyState: 'complete', hidden: false,
      getElementById: getEl,
      createElement: () => StubEl(),
      addEventListener() {},
    },
    window: {},
    navigator: { userAgent: 'node-qa' },
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
  };
  sandbox.window = sandbox; // window === global 자기참조
  sandbox.window.addEventListener = () => {};
  sandbox.globalThis = sandbox;
  const clockRef = { t: 0 };
  const rafRef = { cb: null };

  function fetchImpl(url, opts) {
    const method = (opts && opts.method) || 'GET';
    let body = null;
    if (opts && opts.body) { try { body = JSON.parse(opts.body); } catch (_) {} }
    return req(method, url, body).then(r => ({ ok: r.status >= 200 && r.status < 300, status: r.status, json: () => Promise.resolve(r.json) }));
  }

  return { sandbox, logs, clockRef, rafRef, elById, getEl };
}

function runApp(search, frames) {
  const env = makeSandbox(search);
  const code = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
  vm.createContext(env.sandbox);
  vm.runInContext(code, env.sandbox, { filename: 'app.js' });
  // init()은 동기적으로 첫 rAF를 예약함 → 프레임 구동
  for (let i = 0; i < frames; i++) {
    if (env.sandbox.window.__AUTOTEST_DONE) break;
    env.clockRef.t += 1000 / 60;
    const cb = env.rafRef.cb; env.rafRef.cb = null;
    if (!cb) break;
    try { cb(env.clockRef.t); } catch (e) { console.log('FRAME ERROR', e.message, e.stack); break; }
  }
  return env;
}

async function testAutotest() {
  console.log('\n=== B1) 핵심 루프 autotest (실제 app.js 30s 자동플레이) ===');
  const env = runApp('?autotest&fresh', 2400);
  await sleep(600); // verifySaveRoundtrip(async fetch) 완료 대기
  const sumLine = env.logs.find(l => l.includes('SUMMARY'));
  const rtLine = env.logs.find(l => l.includes('SAVE_ROUNDTRIP'));
  let sum = null; try { sum = JSON.parse(sumLine.slice(sumLine.indexOf('{'))); } catch (_) {}
  console.log('  summary:', sumLine || '(없음)');
  console.log('  roundtrip:', rtLine || '(없음)');

  check('흡수 발생(absorbCount>0)', sum && sum.absorbCount > 0, sum && 'absorb=' + sum.absorbCount);
  check('BM 누적(totalEarned>0)', sum && sum.totalEarned > 0, sum && 'total=' + sum.totalEarned);
  check('구매 발생(buys>0) + 효과 반영(eff>1 또는 autoBM>0 또는 cells>1)',
    sum && sum.buys > 0 && (sum.eff > 1 || sum.autoBM > 0 || sum.cells > 1),
    sum && `buys=${sum.buys} eff=${sum.eff} auto=${sum.autoBM} cells=${sum.cells}`);
  check('음수 잔액 없음(negativeBM=false, bm>=0)', sum && sum.negativeBM === false && sum.bm >= 0, sum && 'bm=' + sum.bm);
  check('진화 발생(stage 상승) + 자동생산 누적', sum && sum.stage >= 1 && sum.autoBM > 0, sum && `stage=${sum.stage}(${sum.stageName}) auto=${sum.autoBM}`);
  // 세이브 라운드트립(클라 경로 전체)
  let rt = null; try { rt = JSON.parse(rtLine.slice(rtLine.indexOf('{'))); } catch (_) {}
  check('세이브 라운드트립 일치(클라 serialize→save→load)', rt && rt.okSave === true && rt.match === true, JSON.stringify(rt));
  return env;
}

function testEconomyGuard() {
  console.log('\n=== B2) 경제 가드(자원0 차단·음수 금지·더블클릭) ===');
  // fresh: bm=0, autoBM=0(stage0) → 수입 없음. 구매 시도는 전부 차단되어야.
  const env = runApp('?fresh', 30); // 짧게 구동(초기화만, 수입 0)
  // 셸 카드 찾기: createElement로 만든 카드들은 shopList에 append됨
  const shop = env.elById['shopList'];
  const cards = (shop && shop._children) || [];
  const find = (id) => cards.find(c => c.dataset && c.dataset.id === id);
  const membrane = find('membrane');
  const evolve = find('evolve');
  const readBM = () => env.elById['bm'] ? env.elById['bm'].textContent : '?';
  const driveOne = () => { env.clockRef.t += 1000 / 60; const cb = env.rafRef.cb; env.rafRef.cb = null; if (cb) cb(env.clockRef.t); };

  check('상점 카드 생성됨(membrane·evolve)', !!membrane && !!evolve, 'cards=' + cards.map(c => c.dataset.id).join(','));

  driveOne();
  const bm0 = readBM();
  // 자원 0에서 더블클릭(연속 2회) → 둘 다 차단, lvl·bm 불변
  if (membrane) { membrane.fire('click'); membrane.fire('click'); }
  driveOne();
  const bmAfter = readBM();
  const lvlTxt = membrane && membrane._q['.up-lvl'] ? membrane._q['.up-lvl'].textContent : '?';
  check('BM 0일 때 구매 차단(잔액 0 불변, 음수 없음)', bm0 === '0' && bmAfter === '0', `before=${bm0} after=${bmAfter}`);
  check('차단 시 레벨 미증가(Lv 0 유지)', /Lv\s*0(\D|$)/.test(lvlTxt), 'lvl="' + lvlTxt + '"');

  // 진화도 자원/조건 부족 시 차단 — stage 불변
  const stageBefore = env.elById['stageName'] ? env.elById['stageName'].textContent : '?';
  if (evolve) { evolve.fire('click'); evolve.fire('click'); }
  driveOne();
  const stageAfter = env.elById['stageName'] ? env.elById['stageName'].textContent : '?';
  check('진화 조건 미달 시 차단(stage 불변)', stageBefore === stageAfter && stageBefore === '원핵세포', `${stageBefore}→${stageAfter}`);
}

(async () => {
  try {
    await testServer();
    await testAutotest();
    testEconomyGuard();
  } catch (e) {
    console.log('HARNESS ERROR', e.message, e.stack);
  }
  const fail = results.filter(r => !r.pass);
  console.log(`\n===== 결과: ${results.length - fail.length}/${results.length} PASS =====`);
  if (fail.length) console.log('실패:', fail.map(f => f.name).join(' | '));
  process.exit(fail.length ? 1 : 0);
})();
