'use strict';
/*
 * effects.js — 세포 게임 VFX / 파티클 레이어 (window.Effects)
 *
 * ── app.js 와 합의된 계약 ──
 *   window.Effects = {
 *     reset(),
 *     setDish({cx,cy,r}),                     // 배경 미세입자 영역 갱신
 *     emit(type, payload),                    // 이벤트 트리거(아래 표)
 *     update(dt, t),                          // 시뮬 갱신(고정 dt)
 *     drawBackground(ctx, t),                 // 세포보다 아래 레이어(미세입자)
 *     draw(ctx, t),                           // 세포보다 위 레이어(흡수/분열/진화/광선/플래시)
 *     // ── QA/디자이너용 제어(부가) ──
 *     setQuality('high'|'med'|'low'|'auto'),  // 품질 단계(기본 auto: 프레임 예산 기반 자동 디그레이드)
 *     setEnabled(type, bool),                 // 이펙트 개별 on/off
 *     stats()                                 // 현재 활성/풀 카운트·품질·draw비용 진단
 *   }
 *   emit 이벤트 payload (프론트엔드와 합의):
 *     'absorb' { x, y, cx, cy, color }  // x,y=영양소(트레일 발생점) / cx,cy=세포중심(수렴 타깃; 없으면 접시중심 폴백)
 *     'divide' { x, y, r, color }       // 세포 분열
 *     'evolve' { x, y, color }          // 진화: 링 + 상승 파편 + 방사 광선 + 화면 플래시
 *     'buy'    { x, y, color }          // 업그레이드 구매 반짝임
 *   app.js 는 좌표/색만 넘기고 "어떻게 터지는가"는 이 모듈이 소유한다.
 *   이 파일이 없어도 app.js 는 정상 구동된다(경계 독립성). 게임 상태/입력엔 침범하지 않는다(읽기 전용 좌표만 수신).
 *
 * ── 성능 예산 ──
 *   파티클 상한 800 / 링 80 / 광선 72 / 플래시 4 — 초과 시 오래된 것부터 폐기(상한 가드).
 *   오브젝트 풀(partPool/ringPool) 재사용으로 GC 스파이크 최소화.
 *   draw 프레임당 FX 예산 4ms — auto 모드에서 EMA가 초과하면 품질을 자동 하향(저사양 디그레이드 경로).
 */
(function () {
  const TAU = Math.PI * 2;
  const now = (typeof performance !== 'undefined' && performance.now)
    ? function () { return performance.now(); } : function () { return 0; };

  // ── 성능 예산/상한 ──
  const CAP = { parts: 800, rings: 80, rays: 72, flashes: 4 };
  const BUDGET_MS = 4.0;

  let parts = [], partPool = [];
  let rings = [], ringPool = [];
  let rays = [];
  let flashes = [];
  let ambient = [];
  let dish = null;

  let seedN = 1;
  function rnd() { seedN = (seedN * 1664525 + 1013904223) >>> 0; return seedN / 4294967296; }

  // ── 품질/토글(QA·디자이너) ──
  let quality = 'auto';   // 'high'|'med'|'low'|'auto'
  let qLevel = 'high';    // auto 가 해석한 현재 등급
  let drawMsEMA = 0;
  const enabled = { absorb: true, divide: true, evolve: true, buy: true, ambient: true, flash: true };

  function qScale() { return qLevel === 'low' ? 0.45 : qLevel === 'med' ? 0.75 : 1; }
  function blurOn() { return qLevel !== 'low'; }
  function flashOn() { return enabled.flash && qLevel !== 'low'; }

  // ── 오브젝트 풀 ──
  function allocPart() { return partPool.length ? partPool.pop() : {}; }
  function freePart(q) { if (partPool.length < 1200) partPool.push(q); }
  function allocRing() { return ringPool.length ? ringPool.pop() : {}; }
  function freeRing(r) { if (ringPool.length < 160) ringPool.push(r); }

  // ── 상한 가드(초과 시 오래된 것 폐기) ──
  function pushPart(q) {
    parts.push(q);
    if (parts.length > CAP.parts) {
      const over = parts.length - CAP.parts;
      for (let i = 0; i < over; i++) freePart(parts[i]);
      parts.splice(0, over);
    }
  }
  function pushRing(r) {
    rings.push(r);
    if (rings.length > CAP.rings) {
      const over = rings.length - CAP.rings;
      for (let i = 0; i < over; i++) freeRing(rings[i]);
      rings.splice(0, over);
    }
  }
  function pushRay(r) {
    rays.push(r);
    if (rays.length > CAP.rays) rays.splice(0, rays.length - CAP.rays);
  }

  function reset() {
    for (const q of parts) freePart(q);
    for (const r of rings) freeRing(r);
    parts = []; rings = []; rays = []; flashes = [];
  }

  function setDish(d) {
    dish = d;
    ambient = [];
    const n = 64;
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU, rr = Math.sqrt(rnd()) * d.r * 0.96;
      ambient.push({
        x: d.cx + Math.cos(a) * rr, y: d.cy + Math.sin(a) * rr,
        r: 0.6 + rnd() * 1.8,
        vx: (rnd() - 0.5) * 7, vy: (rnd() - 0.5) * 7,
        a: 0.06 + rnd() * 0.20, ph: rnd() * TAU,
      });
    }
  }

  function emit(type, p) {
    p = p || {};
    const col = p.color || '#5fe3b0';

    if (type === 'absorb') {
      if (!enabled.absorb) return;
      // 수렴 타깃 = 흡수한 세포 중심(cx,cy). 없으면 접시 중심, 그것도 없으면 영양소 위치로 폴백.
      const tx = (p.cx != null) ? p.cx : (dish ? dish.cx : p.x);
      const ty = (p.cy != null) ? p.cy : (dish ? dish.cy : p.y);
      const n = Math.max(3, Math.round((6 + (rnd() * 4 | 0)) * qScale()));
      for (let i = 0; i < n; i++) {
        const q = allocPart();
        const a = rnd() * TAU, off = rnd() * 5, sp = 30 + rnd() * 70;
        q.kind = 'suck';
        q.x = p.x + Math.cos(a) * off; q.y = p.y + Math.sin(a) * off;
        q.px = q.x; q.py = q.y;
        q.vx = Math.cos(a) * sp; q.vy = Math.sin(a) * sp; // 살짝 튀었다가
        q.tx = tx; q.ty = ty;                              // 세포로 빨려든다
        q.spring = 26 + rnd() * 10; q.damp = 5.5;
        q.r = 1.4 + rnd() * 1.8; q.col = col; q.g = 0;
        q.life = 0.9; q.t = -(i * 0.012);                  // 스태거 → 스트림 트레일
        pushPart(q);
      }
      const rg = allocRing();
      rg.x = p.x; rg.y = p.y; rg.r = 3; rg.r1 = 20; rg.life = 0.3; rg.t = 0; rg.col = col; rg.w = 2.2;
      pushRing(rg);

    } else if (type === 'divide') {
      if (!enabled.divide) return;
      const n = Math.max(6, Math.round(16 * qScale()));
      for (let i = 0; i < n; i++) {
        const q = allocPart();
        const a = (i / n) * TAU, sp = 60 + rnd() * 90;
        q.kind = 'spark';
        q.x = p.x; q.y = p.y; q.px = q.x; q.py = q.y;
        q.vx = Math.cos(a) * sp; q.vy = Math.sin(a) * sp;
        q.r = 2 + rnd() * 3; q.life = 0.5 + rnd() * 0.3; q.t = 0; q.col = col; q.g = 0;
        pushPart(q);
      }
      const rg = allocRing();
      rg.x = p.x; rg.y = p.y; rg.r = (p.r || 20) * 0.4; rg.r1 = (p.r || 20) * 2.2;
      rg.life = 0.5; rg.t = 0; rg.col = col; rg.w = 3;
      pushRing(rg);

    } else if (type === 'evolve') {
      if (!enabled.evolve) return;
      // 다단 팽창 링
      for (let k = 0; k < 3; k++) {
        const rg = allocRing();
        rg.x = p.x; rg.y = p.y; rg.r = 10; rg.r1 = 120 + k * 40;
        rg.life = 0.7 + k * 0.15; rg.t = -k * 0.12; rg.col = col; rg.w = 4 - k;
        pushRing(rg);
      }
      // 상승하는 발광 파편
      const nf = Math.max(8, Math.round(30 * qScale()));
      for (let i = 0; i < nf; i++) {
        const q = allocPart();
        const a = (i / nf) * TAU, sp = 90 + rnd() * 160;
        q.kind = 'glow';
        q.x = p.x; q.y = p.y; q.px = q.x; q.py = q.y;
        q.vx = Math.cos(a) * sp; q.vy = Math.sin(a) * sp - 30;
        q.r = 2 + rnd() * 3.5; q.life = 0.8 + rnd() * 0.5; q.t = 0; q.col = col; q.g = -60;
        pushPart(q);
      }
      // 방사형 빛줄기(radial burst)
      const nr = Math.max(6, Math.round(14 * qScale()));
      for (let i = 0; i < nr; i++) {
        const ang = (i / nr) * TAU + (rnd() - 0.5) * 0.08;
        pushRay({ x: p.x, y: p.y, ang: ang, len0: 14, len1: 150 + rnd() * 70,
          w: 3 + rnd() * 3, life: 0.55 + rnd() * 0.2, t: -rnd() * 0.06, col: col });
      }
      // 화면 전체 플래시
      if (flashOn()) {
        flashes.push({ life: 0.5, t: 0, col: col, maxA: 0.32 });
        if (flashes.length > CAP.flashes) flashes.splice(0, flashes.length - CAP.flashes);
      }

    } else if (type === 'buy') {
      if (!enabled.buy) return;
      const n = Math.max(3, Math.round(6 * qScale()));
      for (let i = 0; i < n; i++) {
        const q = allocPart();
        const a = rnd() * TAU, sp = 30 + rnd() * 60;
        q.kind = 'spark';
        q.x = p.x; q.y = p.y; q.px = q.x; q.py = q.y;
        q.vx = Math.cos(a) * sp; q.vy = Math.sin(a) * sp;
        q.r = 1.5 + rnd() * 2; q.life = 0.4; q.t = 0; q.col = col; q.g = 0;
        pushPart(q);
      }
    }
  }

  function update(dt, t) {
    // 전경 파티클
    for (let i = parts.length - 1; i >= 0; i--) {
      const q = parts[i];
      q.t += dt;
      if (q.t >= q.life) { freePart(q); parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
      if (q.t < 0) continue;                 // 스태거 대기
      q.px = q.x; q.py = q.y;
      if (q.kind === 'suck') {
        // 스프링 호밍: 세포 중심으로 가속하며 빨려든다
        q.vx += (q.tx - q.x) * q.spring * dt;
        q.vy += (q.ty - q.y) * q.spring * dt;
        q.vx *= (1 - q.damp * dt); q.vy *= (1 - q.damp * dt);
        q.x += q.vx * dt; q.y += q.vy * dt;
        const ddx = q.tx - q.x, ddy = q.ty - q.y;
        if (ddx * ddx + ddy * ddy < 36) {    // 도착 = 흡수 완료
          freePart(q); parts[i] = parts[parts.length - 1]; parts.pop(); continue;
        }
      } else {
        q.x += q.vx * dt; q.y += q.vy * dt;
        if (q.g) q.vy += q.g * dt;
        q.vx *= (1 - 2.2 * dt); q.vy *= (1 - 2.2 * dt);
      }
    }
    // 팽창 링
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i]; r.t += dt;
      if (r.t >= r.life) { freeRing(r); rings[i] = rings[rings.length - 1]; rings.pop(); }
    }
    // 방사 광선
    for (let i = rays.length - 1; i >= 0; i--) {
      const r = rays[i]; r.t += dt;
      if (r.t >= r.life) { rays[i] = rays[rays.length - 1]; rays.pop(); }
    }
    // 화면 플래시
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i]; f.t += dt;
      if (f.t >= f.life) { flashes[i] = flashes[flashes.length - 1]; flashes.pop(); }
    }
    // 배경 미세입자(부유 플랑크톤)
    if (dish && enabled.ambient) {
      for (const m of ambient) {
        m.x += m.vx * dt; m.y += m.vy * dt;
        const dx = m.x - dish.cx, dy = m.y - dish.cy;
        const d = Math.hypot(dx, dy);
        if (d > dish.r * 0.97) {            // 접시 경계 반사
          const nx = dx / d, ny = dy / d;
          const dot = m.vx * nx + m.vy * ny;
          m.vx -= 2 * dot * nx; m.vy -= 2 * dot * ny;
          m.x = dish.cx + nx * dish.r * 0.96; m.y = dish.cy + ny * dish.r * 0.96;
        }
      }
    }
  }

  function drawBackground(ctx, t) {
    if (!ambient.length || !enabled.ambient) return;
    ctx.save();
    for (const m of ambient) {
      const tw = m.a * (0.6 + 0.4 * Math.sin(t * 1.5 + m.ph));
      ctx.fillStyle = 'rgba(150, 240, 210, ' + tw + ')';
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  function draw(ctx, t) {
    const t0 = now();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';   // 생체발광 느낌: 가산혼합 1회 토글로 배칭

    // 팽창 링
    for (const r of rings) {
      if (r.t < 0) continue;
      const k = r.t / r.life;
      const rad = r.r + (r.r1 - r.r) * easeOutCirc(k);
      ctx.globalAlpha = (1 - k) * 0.9;
      ctx.strokeStyle = r.col;
      ctx.lineWidth = Math.max(0.5, r.w * (1 - k));
      if (blurOn()) { ctx.shadowColor = r.col; ctx.shadowBlur = 10; } else ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, TAU); ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // 방사형 빛줄기(진화)
    if (rays.length) {
      ctx.lineCap = 'round';
      for (const r of rays) {
        if (r.t < 0) continue;
        const k = r.t / r.life;
        const env = k < 0.25 ? k / 0.25 : 1 - (k - 0.25) / 0.75;
        const tip = r.len0 + (r.len1 - r.len0) * easeOutCirc(k);
        const ca = Math.cos(r.ang), sa = Math.sin(r.ang);
        ctx.globalAlpha = Math.max(0, env) * 0.7;
        ctx.strokeStyle = r.col;
        ctx.lineWidth = Math.max(0.5, r.w * (1 - k));
        ctx.beginPath();
        ctx.moveTo(r.x + ca * r.len0, r.y + sa * r.len0);
        ctx.lineTo(r.x + ca * tip, r.y + sa * tip);
        ctx.stroke();
      }
    }

    // 파티클(코어 + 헤일로 — shadowBlur 없이 저비용 글로우)
    ctx.lineCap = 'round';
    for (const q of parts) {
      if (q.t < 0) continue;
      const k = q.t / q.life;
      const fade = 1 - k;
      const rr = q.r * (1 - k * 0.35);
      if (q.kind === 'suck') {                 // 빨려드는 트레일(이전→현재 선)
        ctx.globalAlpha = fade * 0.5;
        ctx.strokeStyle = q.col;
        ctx.lineWidth = rr * 1.2;
        ctx.beginPath(); ctx.moveTo(q.px, q.py); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
      ctx.fillStyle = q.col;
      ctx.globalAlpha = fade * 0.22;           // 헤일로
      ctx.beginPath(); ctx.arc(q.x, q.y, rr * 2.4, 0, TAU); ctx.fill();
      ctx.globalAlpha = fade * 0.95;           // 코어
      ctx.beginPath(); ctx.arc(q.x, q.y, rr, 0, TAU); ctx.fill();
    }

    // 화면 전체 플래시(진화 — 가장 위)
    if (flashes.length) {
      let vw, vh;
      try { const m = ctx.getTransform(); vw = ctx.canvas.width / (m.a || 1); vh = ctx.canvas.height / (m.d || 1); }
      catch (e) { vw = ctx.canvas.width; vh = ctx.canvas.height; }
      for (const f of flashes) {
        const k = f.t / f.life;
        const env = k < 0.18 ? k / 0.18 : 1 - (k - 0.18) / 0.82;
        ctx.globalAlpha = Math.max(0, env) * f.maxA;
        ctx.fillStyle = f.col;
        ctx.fillRect(0, 0, vw, vh);
      }
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.restore();

    // 프레임 예산 기반 자동 디그레이드(저사양 경로)
    const ms = now() - t0;
    drawMsEMA = drawMsEMA * 0.9 + ms * 0.1;
    if (quality === 'auto') {
      if (drawMsEMA > BUDGET_MS && qLevel !== 'low') qLevel = (qLevel === 'high' ? 'med' : 'low');
      else if (drawMsEMA < BUDGET_MS * 0.5 && qLevel !== 'high') qLevel = (qLevel === 'low' ? 'med' : 'high');
    }
  }

  function easeOutCirc(t) { return Math.sqrt(1 - Math.pow(t - 1, 2)); }

  // ── QA/디자이너용 제어 ──
  function setQuality(lv) {
    if (lv === 'auto') { quality = 'auto'; }
    else if (lv === 'high' || lv === 'med' || lv === 'low') { quality = lv; qLevel = lv; }
  }
  function setEnabled(type, b) { if (Object.prototype.hasOwnProperty.call(enabled, type)) enabled[type] = !!b; }
  function stats() {
    return { parts: parts.length, rings: rings.length, rays: rays.length, flashes: flashes.length,
      pool: partPool.length, quality: quality, qLevel: qLevel,
      drawMsEMA: Math.round(drawMsEMA * 100) / 100, cap: CAP };
  }

  window.Effects = { reset, setDish, emit, update, drawBackground, draw, setQuality, setEnabled, stats };
})();
