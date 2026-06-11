'use strict';
/*
 * app.js — 세포 키우기 게임 클라이언트 본체 (시뮬레이션 권위)
 *
 * 담당(프론트엔드): 게임 루프(고정 timestep), 마우스 추종 이동, 공간분할 흡수 판정,
 *   BM/진화 경제 상태머신, HUD/업그레이드 DOM, 세이브 라운드트립.
 * 결합 훅(각 모듈 없어도 폴백으로 구동 — 경계 독립성):
 *   - 비주얼 아트:  window.CellArt   (cellart.js)
 *   - VFX:        window.Effects   (effects.js)
 *   - 디자인토큰:  CSS :root 변수   (style.css)
 *   - 세이브 API:  /api/save · /api/load · /api/score · /api/scores (server.js)
 */
(function () {
  const TAU = Math.PI * 2;
  const SIM_DT = 1 / 60;            // 고정 시뮬레이션 스텝
  const MAX_FRAME = 0.25;          // 누적 스텝 폭주 방지 상한
  const SAVE_VERSION = 1;
  const SLOT = 'default';

  // ───────────────────────── 데이터 테이블 ─────────────────────────
  // 진화 단계: threshold=다음 단계로 가기 위해 필요한 누적 BM, cost=진화 BM 비용
  const STAGES = [
    { name: '원핵세포', threshold: 0,    cost: 0,    effMul: 1.0, autoBase: 0,   cellR: 17 },
    { name: '진핵세포', threshold: 150,  cost: 120,  effMul: 1.5, autoBase: 0.5, cellR: 21 },
    { name: '군체',     threshold: 600,  cost: 480,  effMul: 2.2, autoBase: 1.6, cellR: 25 },
    { name: '다세포체', threshold: 2200, cost: 1700, effMul: 3.2, autoBase: 4.0, cellR: 29 },
    { name: '유기체',   threshold: 7000, cost: 6000, effMul: 4.8, autoBase: 10,  cellR: 33 },
  ];

  // 기관(업그레이드): 반복 구매. cost(level)=floor(baseCost*costMul^level)
  const UPGRADES = [
    { id: 'membrane', name: '세포막 강화', type: 'efficiency', desc: lvl => `흡수효율 +25% (현재 +${lvl * 25}%)`,
      baseCost: 12, costMul: 1.55, max: 30, unlockStage: 0 },
    { id: 'vacuole',  name: '액포 (자동흡수)', type: 'auto', desc: lvl => `자동생산 +0.4/s (현재 +${(lvl * 0.4).toFixed(1)})`,
      baseCost: 28, costMul: 1.6, max: 40, unlockStage: 0 },
    { id: 'cilia',    name: '섬모', type: 'mobility', desc: lvl => `이동속도·흡수반경 +8% (현재 +${lvl * 8}%)`,
      baseCost: 35, costMul: 1.7, max: 14, unlockStage: 1 },
    { id: 'divide',   name: '세포 분열', type: 'count', desc: lvl => `세포 +1 (현재 ${1 + lvl}마리 · 최대 7)`,
      baseCost: 60, costMul: 2.3, max: 6, unlockStage: 1 },
  ];
  const UP_BY_ID = Object.fromEntries(UPGRADES.map(u => [u.id, u]));

  // 영양소 등급: 작고 흔한 것 ~ 크고 희귀한 것
  const NUT_TIERS = [
    { tier: 0, r: 5,  value: 1,  weight: 0.72 },
    { tier: 1, r: 7,  value: 4,  weight: 0.22 },
    { tier: 2, r: 9,  value: 12, weight: 0.06 },
  ];

  // ───────────────────────── 상태 ─────────────────────────
  const state = {
    bm: 0,
    totalEarned: 0,
    stage: 0,
    upgrades: { membrane: 0, vacuole: 0, cilia: 0, divide: 0 },
    // 파생(recompute로 채움)
    absorbEfficiency: 1,
    autoBM: 0,
    cellCount: 1,
    speedMul: 1,
    radiusMul: 1,
    bestEarned: 0,
  };

  function upgradeCost(u, lvl) { return Math.floor(u.baseCost * Math.pow(u.costMul, lvl)); }

  function recompute() {
    const st = STAGES[state.stage];
    state.absorbEfficiency = (1 + 0.25 * state.upgrades.membrane) * st.effMul;
    state.autoBM = st.autoBase + 0.4 * state.upgrades.vacuole;
    state.cellCount = 1 + state.upgrades.divide;
    state.speedMul = 1 + 0.08 * state.upgrades.cilia;
    state.radiusMul = 1 + 0.08 * state.upgrades.cilia;
    syncCells();
  }

  // 진화 진행 정보
  function evoInfo() {
    const cur = STAGES[state.stage];
    const next = STAGES[state.stage + 1];
    if (!next) return { max: true, progress: 1, ready: false, next: null, cur };
    const span = next.threshold - cur.threshold;
    const progress = span <= 0 ? 1 : clamp((state.totalEarned - cur.threshold) / span, 0, 1);
    const ready = state.totalEarned >= next.threshold;
    return { max: false, progress, ready, next, cur, cost: next.cost };
  }

  // ───────────────────────── 캔버스 ─────────────────────────
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  let cssW = 0, cssH = 0, dpr = 1;
  const dish = { cx: 0, cy: 0, r: 0 };

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = window.innerWidth; cssH = window.innerHeight;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dish.cx = cssW / 2;
    dish.cy = cssH / 2;
    dish.r = Math.min(cssW, cssH) * 0.46;
    if (window.Effects) window.Effects.setDish({ cx: dish.cx, cy: dish.cy, r: dish.r });
  }
  window.addEventListener('resize', resize);

  // ───────────────────────── 입력 ─────────────────────────
  const pointer = { x: 0, y: 0, active: false };
  function setPointerFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const px = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const py = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    pointer.x = px; pointer.y = py; pointer.active = true;
    hideHint();
  }
  canvas.addEventListener('mousemove', setPointerFromEvent);
  canvas.addEventListener('touchstart', e => { setPointerFromEvent(e); e.preventDefault(); }, { passive: false });
  canvas.addEventListener('touchmove', e => { setPointerFromEvent(e); e.preventDefault(); }, { passive: false });

  let hintHidden = false;
  function hideHint() {
    if (hintHidden) return; hintHidden = true;
    const h = document.getElementById('hint'); if (h) h.classList.add('fade');
  }

  // ───────────────────────── 세포 ─────────────────────────
  let cells = [];
  let cellSeed = 1;
  function makeCell(x, y) {
    return { x, y, vx: 0, vy: 0, r: STAGES[state.stage].cellR, seed: (cellSeed++ * 1.713) % TAU };
  }
  function syncCells() {
    const target = state.cellCount;
    while (cells.length < target) cells.push(makeCell(dish.cx, dish.cy));
    while (cells.length > target) cells.pop();
    const baseR = STAGES[state.stage].cellR * state.radiusMul;
    // 세포 수 많을수록 개별 반지름 약간 축소(밸런스)
    const rr = baseR * (target > 1 ? 0.84 : 1);
    for (const c of cells) c.r = rr;
  }

  function cellTarget(i) {
    if (state.cellCount === 1 || i === 0) return { x: pointer.x, y: pointer.y };
    const others = state.cellCount - 1;
    const ang = ((i - 1) / others) * TAU + nowT * 0.4;
    const ring = STAGES[state.stage].cellR * 2.4;
    return { x: pointer.x + Math.cos(ang) * ring, y: pointer.y + Math.sin(ang) * ring };
  }

  function updateCells(dt) {
    const maxSpeed = 560 * state.speedMul;
    const k = 95, c = 15;            // 임계감쇠 스프링(제자리 진동 없음)
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const tg = cellTarget(i);
      // 스프링 가속
      let ax = (tg.x - cell.x) * k - cell.vx * c;
      let ay = (tg.y - cell.y) * k - cell.vy * c;
      cell.vx += ax * dt; cell.vy += ay * dt;
      // 최대 속도 제한
      const sp = Math.hypot(cell.vx, cell.vy);
      if (sp > maxSpeed) { const s = maxSpeed / sp; cell.vx *= s; cell.vy *= s; }
      cell.x += cell.vx * dt; cell.y += cell.vy * dt;
      // 접시 경계 이탈 방지(반지름 고려)
      const dx = cell.x - dish.cx, dy = cell.y - dish.cy;
      const d = Math.hypot(dx, dy);
      const lim = dish.r - cell.r - 2;
      if (d > lim) {
        const nx = dx / d, ny = dy / d;
        cell.x = dish.cx + nx * lim; cell.y = dish.cy + ny * lim;
        // 경계 접선으로 속도 투영(붙어서 미끄러짐, 튕김 없음)
        const dot = cell.vx * nx + cell.vy * ny;
        if (dot > 0) { cell.vx -= dot * nx; cell.vy -= dot * ny; }
      }
    }
  }

  // ───────────────────────── 영양소 ─────────────────────────
  let nutrients = [];
  let nutSeed = 1;
  function nutCapacity() { return Math.round((dish.r * dish.r) / 5200) + 12; }

  function pickTier() {
    let r = Math.random(), acc = 0;
    for (const t of NUT_TIERS) { acc += t.weight; if (r <= acc) return t; }
    return NUT_TIERS[0];
  }
  function spawnNutrient(initial) {
    const t = pickTier();
    const a = Math.random() * TAU;
    const rr = Math.sqrt(Math.random()) * (dish.r - 14);
    const speed = 8 + Math.random() * 16;
    const dir = Math.random() * TAU;
    nutrients.push({
      x: dish.cx + Math.cos(a) * rr, y: dish.cy + Math.sin(a) * rr,
      vx: Math.cos(dir) * speed, vy: Math.sin(dir) * speed,
      r: t.r, tier: t.tier, value: t.value, seed: (nutSeed++ % 1000) / 1000,
    });
  }
  let spawnAcc = 0;
  function updateNutrients(dt) {
    // 표류 + 경계 반사
    for (const n of nutrients) {
      n.x += n.vx * dt; n.y += n.vy * dt;
      const dx = n.x - dish.cx, dy = n.y - dish.cy;
      const d = Math.hypot(dx, dy);
      const lim = dish.r - n.r - 2;
      if (d > lim) {
        const nx = dx / d, ny = dy / d;
        const dot = n.vx * nx + n.vy * ny;
        n.vx -= 2 * dot * nx; n.vy -= 2 * dot * ny;
        n.x = dish.cx + nx * lim; n.y = dish.cy + ny * lim;
      }
    }
    // 스폰(용량까지 점진)
    spawnAcc += dt;
    const interval = 0.18;
    while (spawnAcc >= interval) {
      spawnAcc -= interval;
      if (nutrients.length < nutCapacity()) spawnNutrient(false);
    }
  }

  // ───────── 공간분할 그리드 흡수 판정 ─────────
  function absorb(dt) {
    if (!nutrients.length) return;
    const cell = 64; // 그리드 셀 크기 (최대 흡수반경 + 영양소 반경 여유)
    const cols = Math.ceil(cssW / cell) + 1;
    const grid = new Map();
    const key = (cx, cy) => cx + cy * cols;
    for (let i = 0; i < nutrients.length; i++) {
      const n = nutrients[i];
      const gx = (n.x / cell) | 0, gy = (n.y / cell) | 0;
      const kk = key(gx, gy);
      let arr = grid.get(kk); if (!arr) { arr = []; grid.set(kk, arr); }
      arr.push(i);
    }
    const eaten = new Set();
    for (const c of cells) {
      const reach = c.r;                 // 흡수 반경 = 세포 반지름(섬모는 c.r에 이미 반영)
      const gx = (c.x / cell) | 0, gy = (c.y / cell) | 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const arr = grid.get(key(gx + ox, gy + oy));
        if (!arr) continue;
        for (const idx of arr) {
          if (eaten.has(idx)) continue;
          const n = nutrients[idx];
          const dx = n.x - c.x, dy = n.y - c.y;
          const rad = reach + n.r;
          if (dx * dx + dy * dy <= rad * rad) {  // 반지름 합 이내일 때만(스치기 오판정 없음)
            eaten.add(idx);
            const gain = n.value * state.absorbEfficiency;
            state.bm += gain;
            state.totalEarned += gain;
            // VFX 계약: x,y=영양소(트레일 발생점) / cx,cy=세포중심(수렴 타깃) / color=등급색
            if (window.Effects) window.Effects.emit('absorb', { x: n.x, y: n.y, cx: c.x, cy: c.y, color: nutColor(n.tier) });
            botOnAbsorb && botOnAbsorb(gain);
          }
        }
      }
    }
    if (eaten.size) {
      nutrients = nutrients.filter((_, i) => !eaten.has(i));
      uiDirty = true;
    }
  }
  function nutColor(tier) {
    const pal = window.CellArt && window.CellArt.palette.nutrients[tier];
    return pal ? pal.edge : ['#5fe3b0', '#ffd86b', '#a98bff'][tier] || '#5fe3b0';
  }

  // ───────────────────────── 자동생산 ─────────────────────────
  function autoProduce(dt) {
    if (state.autoBM > 0) {
      const gain = state.autoBM * dt;
      state.bm += gain;
      state.totalEarned += gain;
      uiDirty = true;
    }
  }

  // ───────────────────────── 경제(구매) ─────────────────────────
  // 단일 스레드 동기 처리 → 더블클릭도 각 호출이 잔액 재검사(음수·레이스 없음)
  function buyUpgrade(id) {
    const u = UP_BY_ID[id];
    if (!u) return false;
    const lvl = state.upgrades[id];
    if (lvl >= u.max) { toast('이미 최대 레벨', true); return false; }
    if (state.stage < u.unlockStage) { toast('진화 단계 부족', true); return false; }
    const cost = upgradeCost(u, lvl);
    if (state.bm < cost) { toast('바이오매스 부족', true); return false; }
    state.bm -= cost;                 // 비용 차감 + 효과 적용을 원자적으로
    state.upgrades[id] = lvl + 1;
    recompute();
    flashCard(id);
    if (id === 'divide') {
      // 새 세포 분열 연출
      const c = cells[cells.length - 1];
      if (c && window.Effects) window.Effects.emit('divide', { x: c.x, y: c.y, r: c.r, color: '#9bf6d2' });
    }
    uiDirty = true;
    return true;
  }

  function doEvolve() {
    const info = evoInfo();
    if (info.max) { toast('최종 단계 도달', true); return false; }
    if (!info.ready) { toast('누적 BM 부족(진화 조건 미달)', true); return false; }
    if (state.bm < info.cost) { toast('바이오매스 부족', true); return false; }
    state.bm -= info.cost;
    state.stage += 1;
    recompute();
    flashCard('evolve');
    // 진화 연출(각 세포에서)
    for (const c of cells) if (window.Effects) window.Effects.emit('evolve', { x: c.x, y: c.y, color: STAGES[state.stage].mem || '#bcd9ff' });
    toast('진화! → ' + STAGES[state.stage].name);
    uiDirty = true;
    return true;
  }

  // ───────────────────────── HUD / 상점 DOM ─────────────────────────
  const el = id => document.getElementById(id);
  const cardEls = {};
  function buildShop() {
    const list = el('shopList');
    list.innerHTML = '';
    // 진화 카드(최상단)
    list.appendChild(makeCard('evolve', true));
    for (const u of UPGRADES) list.appendChild(makeCard(u.id, false));
  }
  function makeCard(id, isEvo) {
    const d = document.createElement('div');
    d.className = 'up' + (isEvo ? ' is-evo' : '');
    d.dataset.id = id;
    d.innerHTML =
      '<div class="up-top"><span class="up-name"></span><span class="up-lvl"></span></div>' +
      '<div class="up-desc"></div>' +
      '<div class="up-cost"><span class="ico"></span><span class="cost-val"></span></div>';
    d.addEventListener('click', () => { id === 'evolve' ? doEvolve() : buyUpgrade(id); });
    cardEls[id] = {
      root: d,
      name: d.querySelector('.up-name'),
      lvl: d.querySelector('.up-lvl'),
      desc: d.querySelector('.up-desc'),
      cost: d.querySelector('.cost-val'),
    };
    return d;
  }
  function flashCard(id) {
    const c = cardEls[id]; if (!c) return;
    c.root.classList.remove('flash'); void c.root.offsetWidth; c.root.classList.add('flash');
  }

  function setCardState(card, cls, lock) {
    const root = card.root;
    root.classList.remove('is-buyable', 'is-poor', 'is-locked', 'is-owned');
    root.classList.add(cls);
    if (lock) root.dataset.lock = lock; else root.removeAttribute('data-lock');
  }

  function updateShop() {
    // 진화 카드
    const ev = evoInfo();
    const ec = cardEls['evolve'];
    if (ev.max) {
      ec.name.textContent = '진화 — 최종 단계';
      ec.lvl.textContent = STAGES[state.stage].name;
      ec.desc.textContent = '더 진화할 수 없습니다.';
      ec.cost.textContent = 'MAX';
      setCardState(ec, 'is-owned');
    } else {
      ec.name.textContent = '진화 → ' + ev.next.name;
      ec.lvl.textContent = STAGES[state.stage].name;
      ec.desc.textContent = `효율 ×${ev.next.effMul} · 자동 +${ev.next.autoBase}/s · 외형 변화`;
      ec.cost.textContent = fmt(ev.cost);
      if (!ev.ready) setCardState(ec, 'is-locked', `누적 ${fmt(ev.next.threshold)} 필요`);
      else if (state.bm < ev.cost) setCardState(ec, 'is-poor');
      else setCardState(ec, 'is-buyable');
    }
    // 기관 카드
    for (const u of UPGRADES) {
      const card = cardEls[u.id];
      const lvl = state.upgrades[u.id];
      card.name.textContent = u.name;
      card.lvl.textContent = 'Lv ' + lvl + (u.max ? '/' + u.max : '');
      card.desc.textContent = u.desc(lvl);
      if (lvl >= u.max) {
        card.cost.textContent = 'MAX';
        setCardState(card, 'is-owned');
      } else {
        const cost = upgradeCost(u, lvl);
        card.cost.textContent = fmt(cost);
        if (state.stage < u.unlockStage) setCardState(card, 'is-locked', `${STAGES[u.unlockStage].name} 필요`);
        else if (state.bm < cost) setCardState(card, 'is-poor');
        else setCardState(card, 'is-buyable');
      }
    }
  }

  function updateHUD() {
    el('bm').textContent = fmt(Math.floor(state.bm));
    el('eff').textContent = state.absorbEfficiency.toFixed(1);
    el('auto').textContent = state.autoBM.toFixed(1);
    el('cells').textContent = state.cellCount;
    const ev = evoInfo();
    el('stageName').textContent = STAGES[state.stage].name;
    const fill = el('evoFill');
    fill.style.width = (ev.progress * 100).toFixed(1) + '%';
    if (ev.max) {
      el('evoNextLabel').textContent = '최종 단계';
      el('evoBarText').textContent = 'MAX';
      fill.classList.add('ready');
    } else {
      el('evoNextLabel').textContent = '다음: ' + ev.next.name;
      el('evoBarText').textContent = fmt(Math.floor(Math.min(state.totalEarned, ev.next.threshold))) + ' / ' + fmt(ev.next.threshold);
      fill.classList.toggle('ready', ev.ready);
    }
  }

  let toastTimer = null;
  function toast(msg, warn) {
    const t = el('toast');
    t.textContent = msg;
    t.classList.toggle('warn', !!warn);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
  }

  function fmt(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
    return '' + Math.round(n);
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ───────────────────────── 세이브 / 로드 / 점수 ─────────────────────────
  function serialize() {
    return {
      v: SAVE_VERSION,
      bm: state.bm,
      totalEarned: state.totalEarned,
      stage: state.stage,
      upgrades: { ...state.upgrades },
      bestEarned: Math.max(state.bestEarned, state.totalEarned),
      ts: Date.now(),
    };
  }
  function applyState(s) {
    if (!s || typeof s !== 'object') return false;
    state.bm = +s.bm || 0;
    state.totalEarned = +s.totalEarned || 0;
    state.stage = clamp(s.stage | 0, 0, STAGES.length - 1);
    state.upgrades = {
      membrane: (s.upgrades && s.upgrades.membrane | 0) || 0,
      vacuole: (s.upgrades && s.upgrades.vacuole | 0) || 0,
      cilia: (s.upgrades && s.upgrades.cilia | 0) || 0,
      divide: (s.upgrades && s.upgrades.divide | 0) || 0,
    };
    state.bestEarned = +s.bestEarned || state.totalEarned;
    recompute();
    uiDirty = true;
    return true;
  }

  async function saveGame(silent) {
    const snap = serialize();
    try { localStorage.setItem('cellSave', JSON.stringify(snap)); } catch (_) {}
    try {
      const res = await fetch('/api/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot: SLOT, state: snap }),
      });
      const j = await res.json();
      if (!silent) toast(j.ok ? '저장 완료' : '저장 실패(로컬 보관됨)', !j.ok);
      return j.ok;
    } catch (e) {
      if (!silent) toast('서버 저장 실패(로컬 보관됨)', true);
      return false;
    }
  }

  async function loadGame() {
    let loaded = null;
    try {
      const res = await fetch('/api/load/' + SLOT);
      const j = await res.json();
      if (j && j.ok && j.state) loaded = j.state;
    } catch (_) {}
    if (!loaded) {
      try { const ls = localStorage.getItem('cellSave'); if (ls) loaded = JSON.parse(ls); } catch (_) {}
    }
    if (loaded) { applyState(loaded); toast('불러오기 완료'); return true; }
    toast('저장 데이터 없음', true);
    return false;
  }

  async function submitScore(name) {
    const score = Math.floor(Math.max(state.totalEarned, state.bestEarned));
    try {
      const res = await fetch('/api/score', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || '익명', score }),
      });
      const j = await res.json();
      if (j.ok) toast('순위 등록: ' + j.rank + '위');
      return j;
    } catch (_) { toast('순위 등록 실패', true); return null; }
  }

  async function openBoard() {
    const modal = el('board');
    const listEl = el('boardList');
    listEl.innerHTML = '<li class="b-empty">불러오는 중…</li>';
    modal.classList.remove('hidden');
    try {
      const res = await fetch('/api/scores');
      const j = await res.json();
      const scores = (j && j.scores) || [];
      if (!scores.length) { listEl.innerHTML = '<li class="b-empty">기록 없음 — 첫 주자가 되세요</li>'; return; }
      listEl.innerHTML = '';
      for (const s of scores) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="b-name"></span><span class="b-score">${fmt(s.score)}</span>`;
        li.querySelector('.b-name').textContent = s.name;
        listEl.appendChild(li);
      }
    } catch (_) { listEl.innerHTML = '<li class="b-empty">순위 불러오기 실패</li>'; }
  }

  // 자동 저장
  function startAutosave() {
    setInterval(() => saveGame(true), 15000);
    window.addEventListener('visibilitychange', () => { if (document.hidden) saveGame(true); });
  }

  // ───────────────────────── 렌더 ─────────────────────────
  function render(t) {
    // 배경
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = (window.CellArt && window.CellArt.palette.bg) || '#04120f';
    ctx.fillRect(0, 0, cssW, cssH);

    // 접시
    if (window.CellArt) window.CellArt.drawDish(ctx, dish, t);
    else fallbackDish(t);

    // 배경 미세입자(세포 아래)
    if (window.Effects) window.Effects.drawBackground(ctx, t);

    // 영양소
    for (const n of nutrients) {
      if (window.CellArt) window.CellArt.drawNutrient(ctx, n, t);
      else { ctx.fillStyle = nutColor(n.tier); ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, TAU); ctx.fill(); }
    }

    // 세포
    const sdef = window.CellArt ? window.CellArt.stageDef(state.stage) : null;
    for (const c of cells) {
      if (window.CellArt) window.CellArt.drawCell(ctx, c, sdef, t);
      else fallbackCell(c);
    }

    // 전경 VFX(흡수/분열/진화)
    if (window.Effects) window.Effects.draw(ctx, t);

    // 포인터 표식(커서 숨김 보완)
    drawReticle();

    // 비네트
    drawVignette();
  }

  function drawReticle() {
    ctx.save();
    ctx.strokeStyle = 'rgba(150,240,210,0.5)';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(pointer.x, pointer.y, 7, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pointer.x - 11, pointer.y); ctx.lineTo(pointer.x - 4, pointer.y);
    ctx.moveTo(pointer.x + 4, pointer.y); ctx.lineTo(pointer.x + 11, pointer.y);
    ctx.moveTo(pointer.x, pointer.y - 11); ctx.lineTo(pointer.x, pointer.y - 4);
    ctx.moveTo(pointer.x, pointer.y + 4); ctx.lineTo(pointer.x, pointer.y + 11);
    ctx.stroke();
    ctx.restore();
  }

  function drawVignette() {
    const g = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.35, cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, cssW, cssH);
  }

  function fallbackDish(t) {
    ctx.strokeStyle = '#2f7d68'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(dish.cx, dish.cy, dish.r, 0, TAU); ctx.stroke();
  }
  function fallbackCell(c) {
    ctx.fillStyle = '#37c79a';
    ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, TAU); ctx.fill();
  }

  // ───────────────────────── 루프(고정 timestep) ─────────────────────────
  let last = performance.now();
  let acc = 0;
  let nowT = 0; // 시각용 누적 시간(초)
  let uiDirty = true;
  let frameCount = 0, fpsTimer = 0, fps = 60;

  function simulate(dt) {
    updateCells(dt);
    updateNutrients(dt);
    absorb(dt);
    autoProduce(dt);
    if (window.Effects) window.Effects.update(dt, nowT);
    if (botTick) botTick(dt);
  }

  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > MAX_FRAME) dt = MAX_FRAME; // 탭 복귀/저FPS 폭주 방지
    acc += dt;
    nowT += dt;
    let steps = 0;
    while (acc >= SIM_DT && steps < 8) { simulate(SIM_DT); acc -= SIM_DT; steps++; }
    if (acc > SIM_DT) acc = 0; // 남은 과다분 폐기(일관성 유지)

    render(nowT);

    // UI는 매 프레임 갱신(저비용) — BM 카운트가 부드럽게 흐름
    updateHUD();
    updateShop();

    // FPS 측정
    frameCount++; fpsTimer += dt;
    if (fpsTimer >= 0.5) { fps = Math.round(frameCount / fpsTimer); frameCount = 0; fpsTimer = 0; }

    requestAnimationFrame(frame);
  }

  // ───────────────────────── 자가검증 봇(?autotest) ─────────────────────────
  // 콘솔만 보는 헤드리스 환경에서도 핵심 루프(흡수→축적→구매→진화)를 자동 재현.
  let botTick = null, botOnAbsorb = null;
  function setupBot() {
    if (!/[?&]autotest/.test(location.search)) return;
    const log = (...a) => console.log('[AUTOTEST]', ...a);
    let elapsed = 0, absorbCount = 0, buys = 0, evolves = 0, lastBuyTry = 0;
    const milestones = new Set();
    log('start — 핵심 루프 자동 재현 시작');
    botOnAbsorb = () => { absorbCount++; };
    botTick = (dt) => {
      elapsed += dt;
      // 1) 가장 가까운 영양소로 포인터 이동(세포가 추종)
      let best = null, bd = Infinity;
      for (const n of nutrients) {
        const dx = n.x - cells[0].x, dy = n.y - cells[0].y, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = n; }
      }
      if (best) { pointer.x = best.x; pointer.y = best.y; pointer.active = true; }
      // 2) 0.4초마다 살 수 있는 것 구매(진화 우선)
      lastBuyTry += dt;
      if (lastBuyTry >= 0.4) {
        lastBuyTry = 0;
        const ev = evoInfo();
        if (!ev.max && ev.ready && state.bm >= ev.cost) { if (doEvolve()) { evolves++; log(`진화 #${evolves} → ${STAGES[state.stage].name} (BM ${Math.floor(state.bm)})`); } }
        else {
          for (const u of UPGRADES) {
            if (state.stage < u.unlockStage) continue;
            const lvl = state.upgrades[u.id]; if (lvl >= u.max) continue;
            if (state.bm >= upgradeCost(u, lvl)) { if (buyUpgrade(u.id)) { buys++; break; } }
          }
        }
      }
      // 3) 마일스톤 로그
      for (const m of [50, 200, 1000, 5000]) {
        if (state.totalEarned >= m && !milestones.has(m)) { milestones.add(m); log(`누적 BM ${m} 도달 (t=${elapsed.toFixed(1)}s, 흡수 ${absorbCount}회, 세포 ${state.cellCount})`); }
      }
      // 4) 종료 요약
      if (elapsed >= 30 && !window.__AUTOTEST_DONE) {
        window.__AUTOTEST_DONE = true;
        const summary = {
          ok: absorbCount > 0 && buys > 0 && state.totalEarned > 0 && state.bm >= 0,
          absorbCount, buys, evolves, stage: state.stage, stageName: STAGES[state.stage].name,
          bm: Math.floor(state.bm), totalEarned: Math.floor(state.totalEarned),
          eff: +state.absorbEfficiency.toFixed(2), autoBM: +state.autoBM.toFixed(2),
          cells: state.cellCount, fps, negativeBM: state.bm < 0,
        };
        window.__AUTOTEST = summary;
        log('SUMMARY ' + JSON.stringify(summary));
        log(summary.ok && !summary.negativeBM ? 'RESULT: PASS' : 'RESULT: FAIL');
        // 세이브 라운드트립 검증
        verifySaveRoundtrip(log);
      }
    };
  }

  async function verifySaveRoundtrip(log) {
    const before = serialize();
    const okSave = await saveGame(true);
    try {
      const res = await fetch('/api/load/' + SLOT);
      const j = await res.json();
      const back = j && j.state;
      const match = back && Math.floor(back.totalEarned) === Math.floor(before.totalEarned) && back.stage === before.stage;
      log('SAVE_ROUNDTRIP ' + JSON.stringify({ okSave, match: !!match, stage: back && back.stage, totalEarned: back && Math.floor(back.totalEarned) }));
    } catch (e) { log('SAVE_ROUNDTRIP error ' + e.message); }
  }

  // ───────────────────────── 초기화 ─────────────────────────
  function bindUI() {
    el('saveBtn').addEventListener('click', () => saveGame(false));
    el('loadBtn').addEventListener('click', () => loadGame());
    el('boardBtn').addEventListener('click', openBoard);
    el('closeBoard').addEventListener('click', () => el('board').classList.add('hidden'));
    el('submitScore').addEventListener('click', () => submitScore(el('boardName').value.trim()));
  }

  async function init() {
    resize();
    pointer.x = dish.cx; pointer.y = dish.cy;
    recompute();
    syncCells();
    // 초기 영양소 시딩
    for (let i = 0; i < nutCapacity(); i++) spawnNutrient(true);
    buildShop();
    bindUI();
    updateHUD();
    updateShop();
    // 기존 저장 자동 로드(없으면 무시)
    if (!/[?&]fresh/.test(location.search) && !/[?&]autotest/.test(location.search)) {
      await loadGame().catch(() => {});
    }
    setupBot();
    startAutosave();
    last = performance.now();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
