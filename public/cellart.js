'use strict';
/*
 * cellart.js — 세포/영양소/접시 비주얼 아트 모듈 (window.CellArt)
 *
 * ── 게임 비주얼 디자이너(1513428105967177839 / 1513427803968901203)와 합의 대상 계약(제안) ──
 *   window.CellArt = {
 *     palette,                                  // 색·톤의 단일 출처
 *     drawDish(ctx, dish, t),                   // dish = {cx, cy, r}
 *     drawNutrient(ctx, n, t),                  // n = {x, y, r, tier, seed, value}
 *     drawCell(ctx, cell, stageDef, t),         // cell = {x, y, r, vx, vy, seed}, stageDef = palette.stages[i]
 *     stageDef(stage)                           // 진화 단계 → 비주얼 정의
 *   }
 *   app.js 는 매 프레임 좌표/반지름/상태만 넘기고, "어떻게 보이는가"는 이 모듈이 소유한다.
 *   이 파일이 없어도 app.js 내장 폴백이 동작한다(경계 독립성).
 */
(function () {
  const TAU = Math.PI * 2;

  const palette = {
    bg: '#04120f',
    dishFill: 'rgba(18, 54, 46, 0.55)',
    dishRim: '#2f7d68',
    dishGlow: 'rgba(95, 227, 176, 0.18)',
    grid: 'rgba(95, 227, 176, 0.05)',
    // 영양소 등급별 색 (작을수록 흔하고 저가, 클수록 희귀·고가)
    nutrients: [
      { core: '#bff6e0', edge: '#5fe3b0' }, // tier0 일반(청록)
      { core: '#fff1c2', edge: '#ffd86b' }, // tier1 양분(골드)
      { core: '#d8ccff', edge: '#a98bff' }, // tier2 희귀(보라)
    ],
    // 진화 단계별 세포 비주얼
    stages: [
      { name: '원핵세포',  body: '#2bbd87', mem: '#7bf0c0', nucleus: '#0e6b4c', organelles: 1,  lobes: 1, glow: 'rgba(95,227,176,0.55)' },
      { name: '진핵세포',  body: '#37c79a', mem: '#9bf6d2', nucleus: '#0c5b58', organelles: 3,  lobes: 1, glow: 'rgba(110,235,200,0.6)' },
      { name: '군체',      body: '#3fb6c7', mem: '#a6f0ff', nucleus: '#0c4a5b', organelles: 4,  lobes: 3, glow: 'rgba(123,208,255,0.6)' },
      { name: '다세포체',  body: '#6aa6e0', mem: '#bcd9ff', nucleus: '#143a6b', organelles: 6,  lobes: 5, glow: 'rgba(123,160,255,0.62)' },
      { name: '유기체',    body: '#b07be0', mem: '#e6c8ff', nucleus: '#3a1a6b', organelles: 8,  lobes: 7, glow: 'rgba(190,140,255,0.66)' },
    ],
  };

  function stageDef(stage) {
    return palette.stages[Math.min(stage, palette.stages.length - 1)];
  }

  // ───────── 페트리접시 / 배경 ─────────
  function drawDish(ctx, dish, t) {
    const { cx, cy, r } = dish;
    // 접시 바닥 채움(살짝 빛나는 배지 톤)
    const g = ctx.createRadialGradient(cx, cy - r * 0.2, r * 0.2, cx, cy, r);
    g.addColorStop(0, 'rgba(26, 70, 60, 0.6)');
    g.addColorStop(0.7, 'rgba(12, 42, 35, 0.55)');
    g.addColorStop(1, 'rgba(6, 24, 20, 0.7)');
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.closePath();
    ctx.fillStyle = g; ctx.fill();

    // 미세 격자(현미경 눈금) — 접시 내부 클립
    ctx.clip();
    ctx.strokeStyle = palette.grid; ctx.lineWidth = 1;
    const step = 46;
    ctx.beginPath();
    for (let x = cx - r; x <= cx + r; x += step) { ctx.moveTo(x, cy - r); ctx.lineTo(x, cy + r); }
    for (let y = cy - r; y <= cy + r; y += step) { ctx.moveTo(cx - r, y); ctx.lineTo(cx + r, y); }
    ctx.stroke();
    ctx.restore();

    // 접시 테두리(이중 림 + 글로우)
    ctx.save();
    ctx.shadowColor = palette.dishGlow; ctx.shadowBlur = 24;
    ctx.strokeStyle = palette.dishRim; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(150, 240, 210, 0.25)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, r - 6, 0, TAU); ctx.stroke();
    // 빛 반사 호
    ctx.strokeStyle = 'rgba(220, 255, 245, 0.18)'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(cx, cy, r - 3, -2.2, -1.2); ctx.stroke();
    ctx.restore();
  }

  // ───────── 영양소 ─────────
  function drawNutrient(ctx, n, t) {
    const pal = palette.nutrients[n.tier] || palette.nutrients[0];
    const pulse = 1 + Math.sin(t * 3 + n.seed * 7) * 0.08;
    const r = n.r * pulse;
    ctx.save();
    ctx.translate(n.x, n.y);
    // 글로우 헤일로
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 2.4);
    g.addColorStop(0, pal.edge + 'cc');
    g.addColorStop(0.4, hexA(pal.edge, 0.25));
    g.addColorStop(1, hexA(pal.edge, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, r * 2.4, 0, TAU); ctx.fill();
    // 본체
    const bg = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
    bg.addColorStop(0, pal.core);
    bg.addColorStop(1, pal.edge);
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    // 하이라이트
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.arc(-r * 0.32, -r * 0.32, r * 0.28, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // ───────── 세포 ─────────
  // 멤브레인 떨림: 시간/시드 기반 사인 합으로 외곽선을 변형(살아있는 느낌).
  function cellOutline(ctx, r, t, seed, lobes, jitter) {
    const N = 48;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * TAU;
      const wob =
        Math.sin(a * lobes + t * 1.6 + seed) * 0.06 +
        Math.sin(a * (lobes + 2) - t * 2.3 + seed * 2) * 0.035 +
        Math.sin(a * 3 + t * 0.9) * 0.02;
      const rr = r * (1 + wob * jitter);
      const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function drawCell(ctx, cell, sdef, t) {
    sdef = sdef || palette.stages[0];
    const r = cell.r;
    const seed = cell.seed || 0;
    const speed = Math.hypot(cell.vx || 0, cell.vy || 0);
    const jitter = 1 + Math.min(1.2, speed / 220); // 빠를수록 더 출렁

    ctx.save();
    ctx.translate(cell.x, cell.y);

    // 외곽 글로우 맥동
    const glowPulse = 0.7 + Math.sin(t * 2.4 + seed) * 0.3;
    ctx.shadowColor = sdef.glow;
    ctx.shadowBlur = (14 + r * 0.4) * glowPulse;

    // 멤브레인(외막)
    cellOutline(ctx, r, t, seed, sdef.lobes, jitter * 0.9);
    const body = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r * 1.05);
    body.addColorStop(0, lighten(sdef.body, 0.22));
    body.addColorStop(0.75, sdef.body);
    body.addColorStop(1, darken(sdef.body, 0.18));
    ctx.fillStyle = body;
    ctx.fill();
    ctx.shadowBlur = 0;

    // 막 테두리(이중)
    ctx.lineWidth = Math.max(2, r * 0.06);
    ctx.strokeStyle = hexA(sdef.mem, 0.9);
    cellOutline(ctx, r * 0.985, t, seed, sdef.lobes, jitter * 0.9);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = hexA(sdef.mem, 0.35);
    cellOutline(ctx, r * 0.8, t, seed + 1, sdef.lobes, jitter * 0.6);
    ctx.stroke();

    // 세포질 하이라이트
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.arc(-r * 0.28, -r * 0.3, r * 0.42, 0, TAU); ctx.fill();

    // 핵
    const nr = r * 0.32;
    const ng = ctx.createRadialGradient(-nr * 0.3, -nr * 0.3, nr * 0.1, 0, 0, nr);
    ng.addColorStop(0, lighten(sdef.nucleus, 0.5));
    ng.addColorStop(1, sdef.nucleus);
    ctx.fillStyle = ng;
    ctx.beginPath(); ctx.arc(0, 0, nr, 0, TAU); ctx.fill();
    ctx.strokeStyle = hexA(sdef.mem, 0.5); ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(0, 0, nr, 0, TAU); ctx.stroke();

    // 소기관(orbiting organelles)
    for (let i = 0; i < sdef.organelles; i++) {
      const a = (i / sdef.organelles) * TAU + t * 0.6 + seed;
      const orad = r * (0.5 + 0.12 * Math.sin(t * 1.3 + i));
      const ox = Math.cos(a) * orad, oy = Math.sin(a) * orad;
      const or = r * 0.08;
      ctx.fillStyle = hexA(sdef.mem, 0.85);
      ctx.beginPath(); ctx.arc(ox, oy, or, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  // ───────── 색 유틸 ─────────
  function clampByte(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
  function parseHex(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function toHex(r, g, b) { return '#' + [r, g, b].map(v => clampByte(v).toString(16).padStart(2, '0')).join(''); }
  function lighten(hex, amt) { const [r, g, b] = parseHex(hex); return toHex(r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt); }
  function darken(hex, amt) { const [r, g, b] = parseHex(hex); return toHex(r * (1 - amt), g * (1 - amt), b * (1 - amt)); }
  function hexA(hex, a) { const [r, g, b] = parseHex(hex); return `rgba(${r},${g},${b},${a})`; }

  window.CellArt = { palette, stageDef, drawDish, drawNutrient, drawCell, _util: { lighten, darken, hexA } };
})();
