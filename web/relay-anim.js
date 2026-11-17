// Front-page relay animation: a signed transaction leaves a wallet with no
// internet, is verified by LASTSYNC, hops phone-to-phone over a local Wi-Fi
// mesh while the tower shows no signal, then — signal found — beams up and
// lands as a confirmed block. Alternates Bitcoin / Solana each cycle.

const cv = document.getElementById('lp-relay');
if (cv) start();

function start() {
  const ctx = cv.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CHAINS = [
    { name: 'BTC', color: [232, 184, 106], amount: '0.0150 BTC', block: 871204 },
    { name: 'SOL', color: [185, 162, 240], amount: '2.5 SOL', block: 312880119 },
  ];
  const STEEL = [143, 180, 217], WHITE = [230, 238, 247], RED = [240, 86, 106], GREEN = [95, 212, 154];
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  let W = 0, H = 0, DPR = 1, nodes = [], tower = null, chainPos = null, wide = true;
  let cycle = 0, t0 = performance.now(), blocks = [], logged = -1;
  const CYCLE = 8200;
  const particles = [];

  function layout() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = W * DPR; cv.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    wide = W > 980;
    const x0 = wide ? W * 0.47 : W * 0.06, x1 = wide ? W * 0.9 : W * 0.9;
    const yMid = wide ? H * 0.58 : H * 0.62;
    const span = x1 - x0;
    nodes = [
      { x: x0, y: yMid + 40, label: 'WALLET', sub: 'signed offline', kind: 'wallet' },
      { x: x0 + span * 0.22, y: yMid - 10, label: 'LASTSYNC', sub: 'verified', kind: 'core' },
      { x: x0 + span * 0.42, y: yMid + 50, label: 'PHONE', sub: 'wi-fi mesh', kind: 'phone' },
      { x: x0 + span * 0.6, y: yMid - 5, label: 'PHONE', sub: 'wi-fi mesh', kind: 'phone' },
    ];
    tower = { x: x0 + span * 0.8, y: yMid + 30 };
    chainPos = { x: x0 + span * 0.97, y: wide ? H * 0.2 : H * 0.18 };
  }

  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const lerp = (a, b, t) => a + (b - a) * t;
  const seg = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));

  // Timeline (ms within a cycle)
  const T = { sign: [0, 900], toCore: [900, 1900], verify: [1900, 2500], hop1: [2500, 3300], hop2: [3300, 4100], hold: [4100, 5200], up: [5200, 6200], land: [6200, 6800] };

  function packetPos(t) {
    const n = nodes;
    if (t < T.toCore[0]) return [n[0].x, n[0].y];
    if (t < T.toCore[1]) { const k = ease(seg(t, ...T.toCore)); return [lerp(n[0].x, n[1].x, k), lerp(n[0].y, n[1].y, k) - Math.sin(k * Math.PI) * 30]; }
    if (t < T.hop1[0]) return [n[1].x, n[1].y];
    if (t < T.hop1[1]) { const k = ease(seg(t, ...T.hop1)); return [lerp(n[1].x, n[2].x, k), lerp(n[1].y, n[2].y, k) - Math.sin(k * Math.PI) * 26]; }
    if (t < T.hop2[1]) { const k = ease(seg(t, ...T.hop2)); return [lerp(n[2].x, n[3].x, k), lerp(n[2].y, n[3].y, k) - Math.sin(k * Math.PI) * 26]; }
    if (t < T.up[0]) return [n[3].x, n[3].y];
    if (t < T.up[1]) {
      const k = ease(seg(t, ...T.up));
      const mid = [tower.x, tower.y - 40];
      const a = k < 0.5 ? [lerp(n[3].x, mid[0], k * 2), lerp(n[3].y, mid[1], k * 2)] : [lerp(mid[0], chainPos.x, (k - 0.5) * 2), lerp(mid[1], chainPos.y + 40, (k - 0.5) * 2)];
      return a;
    }
    return [chainPos.x, chainPos.y + 40];
  }

  function drawNode(n, active, chainColor, sym) {
    const r = n.kind === 'core' ? 22 : 17;
    const glow = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 3);
    glow.addColorStop(0, rgba(active ? chainColor : STEEL, active ? 0.22 : 0.07)); glow.addColorStop(1, rgba(STEEL, 0));
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(n.x, n.y, r * 3, 0, Math.PI * 2); ctx.fill();
    // hexagon
    ctx.beginPath();
    for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; const x = n.x + Math.cos(a) * r, y = n.y + Math.sin(a) * r; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.closePath();
    ctx.fillStyle = 'rgba(16,17,20,0.95)'; ctx.fill();
    ctx.strokeStyle = rgba(active ? chainColor : STEEL, active ? 0.95 : 0.45); ctx.lineWidth = 1.4; ctx.stroke();
    // icon glyph
    ctx.fillStyle = rgba(WHITE, 0.85); ctx.font = `700 ${n.kind === 'core' ? 11 : 10}px ui-monospace, Consolas, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (n.kind === 'phone') {
      ctx.strokeStyle = rgba(WHITE, 0.85); ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.roundRect(n.x - 4.5, n.y - 7, 9, 14, 2); ctx.stroke();
      ctx.fillStyle = rgba(WHITE, 0.85); ctx.fillRect(n.x - 1, n.y + 4, 2, 1.2);
    } else ctx.fillText(n.kind === 'wallet' ? sym : 'LS', n.x, n.y + 0.5);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = rgba([220, 228, 238], 0.85); ctx.font = '700 9.5px ui-monospace, Consolas, monospace';
    ctx.fillText(n.label, n.x, n.y + r + 16);
    ctx.fillStyle = rgba([150, 160, 172], 0.8); ctx.font = '9px ui-monospace, Consolas, monospace';
    ctx.fillText(n.sub, n.x, n.y + r + 28);
  }

  function frame(now) {
    const el = now - t0;
    if (el > CYCLE) { const P = CHAINS[cycle % 2]; blocks.push({ n: P.block + cycle, color: P.color }); if (blocks.length > 6) blocks.shift(); t0 = now; cycle++; logged = -1; }
    const t = (now - t0);
    const C = CHAINS[cycle % 2];
    ctx.clearRect(0, 0, W, H);

    // faint perspective grid floor
    ctx.save();
    ctx.strokeStyle = rgba(STEEL, 0.05); ctx.lineWidth = 1;
    const horizon = H * 0.42;
    for (let i = -20; i <= 20; i++) { ctx.beginPath(); ctx.moveTo(W * 0.68 + i * 18, horizon); ctx.lineTo(W * 0.68 + i * 110, H); ctx.stroke(); }
    for (let k = 0; k < 12; k++) { const y = horizon + (H - horizon) * ((k / 12) ** 1.8); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.restore();

    // mesh links (animated dashes)
    ctx.setLineDash([3, 7]); ctx.lineDashOffset = -now / 60; ctx.lineWidth = 1.2;
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i], b = nodes[i + 1];
      ctx.strokeStyle = rgba(STEEL, 0.35);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo((a.x + b.x) / 2, Math.min(a.y, b.y) - 34, b.x, b.y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // tower
    const signal = t >= T.up[0] - 150;
    const tc = signal ? GREEN : RED;
    ctx.strokeStyle = rgba(tc, 0.85); ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(tower.x - 12, tower.y + 30); ctx.lineTo(tower.x, tower.y - 22); ctx.lineTo(tower.x + 12, tower.y + 30); ctx.moveTo(tower.x - 7, tower.y + 8); ctx.lineTo(tower.x + 7, tower.y + 8); ctx.stroke();
    if (signal) {
      for (let k = 0; k < 3; k++) {
        const ph = ((now / 700) + k / 3) % 1;
        ctx.strokeStyle = rgba(GREEN, (1 - ph) * 0.7);
        ctx.beginPath(); ctx.arc(tower.x, tower.y - 22, 8 + ph * 30, -Math.PI * 0.85, -Math.PI * 0.15); ctx.stroke();
      }
    } else {
      ctx.strokeStyle = rgba(RED, 0.8);
      ctx.beginPath(); ctx.moveTo(tower.x - 9, tower.y - 34); ctx.lineTo(tower.x + 9, tower.y - 16); ctx.moveTo(tower.x + 9, tower.y - 34); ctx.lineTo(tower.x - 9, tower.y - 16); ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = rgba(tc, 0.95); ctx.font = '700 9.5px ui-monospace, Consolas, monospace';
    ctx.fillText(signal ? 'SIGNAL FOUND' : 'NO SIGNAL', tower.x, tower.y + 48);

    // beam from tower to chain while uploading
    if (t > T.up[0] && t < T.land[1] + 300) {
      const a = 1 - seg(t, T.land[1], T.land[1] + 300);
      const g = ctx.createLinearGradient(tower.x, tower.y, chainPos.x, chainPos.y);
      g.addColorStop(0, rgba(GREEN, 0.0)); g.addColorStop(1, rgba(C.color, 0.45 * a));
      ctx.strokeStyle = g; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(tower.x, tower.y - 22); ctx.lineTo(chainPos.x, chainPos.y + 40); ctx.stroke();
    }

    // chain: stack of blocks
    const bw = wide ? 92 : 70, bh = 22;
    const landed = t >= T.land[0];
    const stack = blocks.slice(-3);
    stack.forEach((b, i) => {
      const y = chainPos.y + 40 - (stack.length - i) * (bh + 6) - (landed ? 0 : 0);
      ctx.fillStyle = 'rgba(20,21,24,0.95)'; ctx.strokeStyle = rgba(b.color, 0.45); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(chainPos.x - bw / 2, y, bw, bh, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = rgba([160, 170, 182], 0.85); ctx.font = '9px ui-monospace, Consolas, monospace'; ctx.textAlign = 'center';
      ctx.fillText(`#${b.n.toLocaleString()}`, chainPos.x, y + 14.5);
    });
    if (landed) {
      const k = seg(t, T.land[0], T.land[1]);
      const y = chainPos.y + 40;
      ctx.fillStyle = rgba(C.color, 0.14 + 0.2 * (1 - k)); ctx.strokeStyle = rgba(C.color, 0.95); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.roundRect(chainPos.x - bw / 2, y, bw, bh, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '700 9.5px ui-monospace, Consolas, monospace';
      ctx.fillText('✓ CONFIRMED', chainPos.x, y + 14.5);
      if (k < 1) { ctx.strokeStyle = rgba(C.color, (1 - k) * 0.6); ctx.beginPath(); ctx.roundRect(chainPos.x - bw / 2 - k * 16, y - k * 10, bw + k * 32, bh + k * 20, 6); ctx.stroke(); }
    }
    ctx.fillStyle = rgba([150, 160, 172], 0.8); ctx.font = '700 9.5px ui-monospace, Consolas, monospace'; ctx.textAlign = 'center';
    ctx.fillText(`${C.name} NETWORK`, chainPos.x, chainPos.y + 40 + bh + 18);

    // nodes
    const pp = packetPos(t);
    nodes.forEach((n, i) => {
      const near = Math.hypot(pp[0] - n.x, pp[1] - n.y) < 30 && t < T.up[0] + 200;
      drawNode(n, near, C.color, C.name === 'BTC' ? '₿' : '◎');
    });
    // verify ring at LASTSYNC
    if (t > T.verify[0] && t < T.verify[1] + 400) {
      const k = seg(t, T.verify[0], T.verify[1]);
      const n = nodes[1];
      ctx.strokeStyle = rgba(GREEN, 0.9 * (1 - seg(t, T.verify[1], T.verify[1] + 400))); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(n.x, n.y, 30, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2); ctx.stroke();
      ctx.fillStyle = rgba(GREEN, 0.95 * (1 - seg(t, T.verify[1], T.verify[1] + 400))); ctx.font = '700 9.5px ui-monospace, Consolas, monospace'; ctx.textAlign = 'center';
      ctx.fillText('SIGNATURE ✓', n.x, n.y - 40);
    }
    // holding pulse at the last phone
    if (t > T.hold[0] && t < T.up[0]) {
      const n = nodes[3];
      const ph = ((now / 900) % 1);
      ctx.strokeStyle = rgba(C.color, (1 - ph) * 0.6); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(n.x, n.y, 18 + ph * 26, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = rgba([227, 201, 107], 0.95); ctx.font = '700 9.5px ui-monospace, Consolas, monospace';
      ctx.fillText('HOLDING · WAITING FOR SIGNAL', n.x, n.y - 38);
    }
    // sign flash at wallet
    if (t < T.sign[1] + 200) {
      const k = seg(t, T.sign[0], T.sign[1]);
      const n = nodes[0];
      ctx.strokeStyle = rgba(C.color, 1 - k); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(n.x, n.y, 18 + k * 30, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = rgba(C.color, 0.95); ctx.font = '700 9.5px ui-monospace, Consolas, monospace';
      ctx.fillText(`SIGNED · ${C.amount}`, n.x, n.y - 36);
    }

    // packet + trail particles
    if (t < T.land[0]) {
      for (let k = 0; k < 2; k++) particles.push({ x: pp[0], y: pp[1], vx: (Math.random() - 0.5) * 0.6, vy: (Math.random() - 0.5) * 0.6, life: 1, c: C.color });
      const g = ctx.createRadialGradient(pp[0], pp[1], 0, pp[0], pp[1], 16);
      g.addColorStop(0, rgba(WHITE, 1)); g.addColorStop(0.3, rgba(C.color, 0.8)); g.addColorStop(1, rgba(C.color, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(pp[0], pp[1], 16, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx; p.y += p.vy; p.life -= 0.022;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      ctx.fillStyle = rgba(p.c, p.life * 0.7);
      ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
    }

    // log lines synced to the timeline
    const steps = [
      [T.sign[0] + 50, `tx ${hex(cycle, 4)}…${hex(cycle + 7, 4)} signed offline · ${C.amount}`, ''],
      [T.verify[0], 'lastsync: decoded · 1/1 signatures valid ✓', 'ok'],
      [T.hop1[0], 'mesh: laptop → phone over local wi-fi', ''],
      [T.hold[0], 'uplink: no signal — holding transaction', 'bad'],
      [T.up[0], 'uplink: signal found — broadcasting…', ''],
      [T.land[0], `${C.name.toLowerCase()}: confirmed in block ${C.block + cycle}`, 'ok'],
    ];
    const due = steps.filter((s) => t >= s[0]).length - 1;
    if (due > logged) { for (let i = logged + 1; i <= due; i++) addLine(steps[i][1], steps[i][2]); logged = due; }

    if (!reduced && !document.hidden) requestAnimationFrame(frame);
  }

  const hex = (seed, n) => { let x = (seed * 2654435761) >>> 0, s = ''; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; s += (x >>> 16 & 15).toString(16); } return s; };
  const lines = [];
  function addLine(text, cls) {
    const box = document.getElementById('lp-txlines');
    if (!box) return;
    lines.push({ text, cls });
    while (lines.length > 4) lines.shift();
    box.innerHTML = '';
    for (const l of lines) { const d = document.createElement('div'); d.className = 'lp-line ' + l.cls; d.textContent = '› ' + l.text; box.append(d); }
  }

  // Seed a couple of earlier blocks so the chain isn't empty.
  blocks = [{ n: CHAINS[1].block - 2, color: CHAINS[1].color }, { n: CHAINS[0].block - 1, color: CHAINS[0].color }];
  layout();
  window.addEventListener('resize', layout);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !reduced) requestAnimationFrame(frame); });
  requestAnimationFrame(frame);
}
