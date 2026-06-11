'use strict';
/* verify.js — 임시 검증 하니스(브라우저 없이 app.js를 실제 구동).
 * 최소 DOM/canvas 셰임 위에서 ?autotest 봇을 돌려 핵심 루프(흡수→축적→구매→진화)와
 * 세이브 라운드트립을 재현·관찰한다. 실제 server.js(localhost)에 fetch로 붙는다.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PORT = process.env.PORT || 3000;
const BASE = 'http://localhost:' + PORT;

// 무엇이든 받아주는 프록시(DOM 엘리먼트 + canvas 2D 컨텍스트 대용)
function anyProxy() {
  const fn = function () { return p; };
  const p = new Proxy(fn, {
    get(t, prop) {
      if (prop === 'value') return '';
      if (prop === Symbol.toPrimitive) return () => 0;
      return p;
    },
    set() { return true; },
    apply() { return p; },
  });
  return p;
}
const ANY = anyProxy();

// 수동 rAF
let rafCb = null;
global.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
global.cancelAnimationFrame = () => {};

let perfNow = 0; // 프레임 타임스탬프는 rAF 콜백 인자로 직접 주입(performance는 Node 기본 유지)

global.localStorage = (() => {
  const m = {};
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } };
})();

const canvas = {
  width: 0, height: 0, style: {},
  getContext: () => ANY,
  addEventListener: () => {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
};

global.document = {
  readyState: 'complete',
  getElementById: () => ANY,
  createElement: () => ANY,
  querySelector: () => ANY,
  addEventListener: () => {},
};
// canvas#game만 실제 객체 반환
global.document.getElementById = (id) => (id === 'game' ? canvas : ANY);

global.location = { search: '?autotest' };

global.window = global;
global.window.innerWidth = 1280;
global.window.innerHeight = 720;
global.window.devicePixelRatio = 1;
global.window.addEventListener = () => {};

// 상대 URL → 실제 서버
const realFetch = global.fetch;
global.fetch = (url, opts) => realFetch(typeof url === 'string' && url.startsWith('/') ? BASE + url : url, opts);

// 모듈 로드(IIFE가 window에 등록)
function load(file) {
  const code = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
  vm.runInThisContext(code, { filename: file });
}
load('cellart.js');
load('effects.js');
load('app.js'); // init()이 동기 실행되며 requestAnimationFrame(frame) 등록

(async () => {
  // 31초 시뮬레이션을 16.67ms 스텝으로 구동
  const STEP = 1000 / 60;
  let frames = 0;
  while (rafCb && perfNow < 31000 && frames < 4000) {
    perfNow += STEP;
    const cb = rafCb; rafCb = null;
    try { cb(perfNow); } catch (e) { console.error('frame error', e); break; }
    frames++;
    if (window.__AUTOTEST) break;
  }
  // 봇 종료 후 비동기 세이브 라운드트립 완료 대기
  await new Promise(r => setTimeout(r, 800));
  // 몇 프레임 더 돌려 저장 후 상태 안정
  for (let i = 0; i < 5 && rafCb; i++) { perfNow += STEP; const cb = rafCb; rafCb = null; cb(perfNow); }
  await new Promise(r => setTimeout(r, 400));

  const r = window.__AUTOTEST;
  console.log('\n===== VERIFY RESULT =====');
  console.log('frames driven:', frames, '| sim sec:', (perfNow / 1000).toFixed(1));
  console.log(JSON.stringify(r, null, 2));
  const pass = r && r.ok && !r.negativeBM && r.absorbCount > 0 && r.buys > 0 && r.totalEarned > 0;
  console.log('OVERALL:', pass ? 'PASS' : 'FAIL');
  process.exit(pass ? 0 : 1);
})();
