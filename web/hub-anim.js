// Front page: a laptop showing the hub, with a cursor that clicks through it.
const screen = document.getElementById('hub-screen');
if (screen) {
  const cursor = document.getElementById('hub-cursor');
  const steps = [...document.querySelectorAll('#hub-steps li')];
  const navs = [...screen.querySelectorAll('.hub-side a[data-k]')];
  const panes = [...screen.querySelectorAll('.hub-pane')];
  const ORDER = ['command', 'relay', 'maps', 'group', 'ask'];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // A QR-like pattern for the group pane (decorative).
  const qr = document.getElementById('hub-qr');
  if (qr) {
    let seed = 7;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    const finder = (r, c) => [[0, 0], [0, 14], [14, 0]].some(([y, x]) => r >= y && r < y + 7 && c >= x && c < x + 7 && (r === y || r === y + 6 || c === x || c === x + 6 || (r > y + 1 && r < y + 5 && c > x + 1 && c < x + 5)));
    const inFinder = (r, c) => [[0, 0], [0, 14], [14, 0]].some(([y, x]) => r >= y - 1 && r < y + 8 && c >= x - 1 && c < x + 8);
    let cells = '';
    for (let r = 0; r < 21; r++) for (let c = 0; c < 21; c++) {
      const on = inFinder(r, c) ? finder(r, c) : rnd() > 0.52;
      if (on) cells += `<i style="grid-area:${r + 1}/${c + 1}"></i>`;
    }
    qr.innerHTML = cells;
  }

  function show(k) {
    navs.forEach((a) => a.classList.toggle('on', a.dataset.k === k));
    panes.forEach((p) => p.classList.toggle('on', p.dataset.pane === k));
    steps.forEach((s) => s.classList.toggle('on', s.dataset.k === k));
  }

  function moveTo(el, dx = 0.5, dy = 0.5) {
    const s = screen.getBoundingClientRect(), r = el.getBoundingClientRect();
    const x = r.left - s.left + r.width * dx, y = r.top - s.top + r.height * dy;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
  }
  async function click() {
    cursor.classList.remove('click'); void cursor.offsetWidth; cursor.classList.add('click');
    await wait(180);
  }

  // Per-section moments, played after the nav click.
  const SCENES = {
    async command() { await wait(2600); },
    async relay() {
      const tx = document.getElementById('hub-tx1'), st = tx.querySelector('.st');
      st.className = 'st warn'; st.textContent = 'Waiting for signal';
      await wait(700);
      moveTo(document.getElementById('hub-send')); await wait(750); await click();
      document.getElementById('hub-net').textContent = 'connected';
      st.className = 'st blue'; st.textContent = 'Broadcast'; await wait(1100);
      st.className = 'st ok'; st.textContent = 'Confirmed'; await wait(1300);
      document.getElementById('hub-net').textContent = 'offline';
    },
    async maps() {
      const pin = document.getElementById('hub-pin'); pin.classList.remove('show');
      await wait(600);
      const svg = screen.querySelector('.hp-map'), b = svg.getBoundingClientRect(), s = screen.getBoundingClientRect();
      // the new pin sits at 262,128 in a 400x220 slice-scaled viewBox
      const k = Math.max(b.width / 400, b.height / 220), ox = (b.width - 400 * k) / 2, oy = (b.height - 220 * k) / 2;
      cursor.style.transform = `translate(${b.left - s.left + ox + 262 * k}px, ${b.top - s.top + oy + 128 * k}px)`;
      await wait(800); await click(); pin.classList.add('show'); await wait(2000);
    },
    async group() {
      const m = document.getElementById('hub-member'); m.classList.remove('show');
      await wait(1200); m.classList.add('show'); await wait(2200);
    },
    async ask() {
      const q = document.getElementById('hub-q'), a = document.getElementById('hub-a');
      q.textContent = ''; a.classList.remove('show');
      moveTo(q.parentElement, 0.3, 0.5); await wait(700); await click();
      for (const ch of 'How do I make water safe to drink?') { q.textContent += ch; await wait(32); }
      await wait(350); a.classList.add('show'); await wait(3000);
    },
  };

  let running = false, visible = false, inView = false, jump = null, token = 0;
  async function loop() {
    if (running) return;
    running = true;
    let i = 0;
    const my = ++token;
    while (visible && my === token) {
      const k = jump ?? ORDER[i % ORDER.length];
      if (jump) { i = ORDER.indexOf(jump); jump = null; }
      const nav = navs.find((a) => a.dataset.k === k);
      moveTo(nav, 0.35, 0.55); await wait(800);
      await click(); show(k);
      await SCENES[k]();
      if (my !== token) break;
      i++;
    }
    running = false;
  }

  steps.forEach((s) => s.addEventListener('click', () => {
    jump = s.dataset.k; show(s.dataset.k);
    if (reduce) { const q = document.getElementById('hub-q'); q.textContent = 'How do I make water safe to drink?'; document.getElementById('hub-a').classList.add('show'); document.getElementById('hub-pin').classList.add('show'); document.getElementById('hub-member').classList.add('show'); }
  }));

  if (reduce) {
    cursor.hidden = true;
    show('command');
  } else {
    show('command');
    moveTo(screen, 0.6, 0.45);
    const update = () => {
      const was = visible;
      visible = inView && !document.hidden;
      if (visible && !was) { token++; running = false; loop(); }
    };
    new IntersectionObserver(([e]) => { inView = e.isIntersecting; update(); }, { threshold: 0.25 }).observe(screen);
    document.addEventListener('visibilitychange', update);
  }
}
