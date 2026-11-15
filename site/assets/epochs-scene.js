// Scores as a row of columns (three.js, vendored), drawn only from what epochs.js has already
// read. With an agent looked up it is that agent's proposals; with none it is the agents scored
// in about the last day. Either way the newest stands on the right. What each thing means:
//   a tall column    a score, to scale against the 100 marked on the wall
//   blue             that score was finalized
//   amber            a proposal still pending (tall if its score is known)
//   a grey stub      a proposal that ended with no score
//   a red stub       a proposal the committee rejected, or a score cleared by a slash
//   the line         joins one agent's finalized scores in order
// Columns stand in order, not spaced by time. They rise from the floor when the room first shows,
// which says nothing, like the dust and the slow sway.
//
// Without WebGL nothing is drawn and the card stays hidden: the lists below hold all of it.

import * as THREE from "./vendor/three.module.min.js";

// Every feature is a switch here. Turn one off, do not delete it.
const CONFIG = {
  rise: true,      // columns grow from the floor when the room first shows
  parallax: true,  // the view leans a little toward the pointer
  sway: true,      // and drifts slowly from side to side
  line: true,      // the line through one agent's finalized scores
  dust: true,      // motes in the air
  mirror: true,    // the floor shows a faint reflection of each column
  most: 60,        // the newest this many columns are drawn (16 on a narrow screen)
};

const COLOR = { finalized: 0x6fa8ff, pending: 0xffbf7a, ended: 0x6b7299, rejected: 0xff5c6c, cleared: 0xff5c6c };
const HIGH = 3.2;      // a score of 100 stands this high
const STUB = 0.1;      // a column with no score

function canvasTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function fmtLeft(sec) {
  if (sec <= 0) return "window closed";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return `window closes in ${d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${Math.max(1, m)}m`}`;
}

// Draws `data.bars` in `host`. Returns a function that stops it, or null if there is no WebGL.
function start(host, data) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (_) {
    return null;
  }
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const narrow = host.clientWidth < 560;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-hidden", "true");
  const hud = document.createElement("div");
  hud.className = "sim-scene-hud";
  const tip = document.createElement("div");
  tip.className = "sim-tip u-hidden";
  host.replaceChildren(canvas, hud, tip);

  const bars = data.bars.slice(-(narrow ? 16 : CONFIG.most));
  hud.innerHTML = data.hud.map((line, i) => (i ? `<span>${line}</span>` : `<b>${line}</b>`)).join("")
    + '<span class="op-pending u-hidden"></span>'
    + (bars.length < data.of ? `<span>the newest ${bars.length} of ${data.of} drawn</span>` : "");

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x171b34, 60, 160);
  // A long lens, so the columns at the sides are not sheared.
  const camera = new THREE.PerspectiveCamera(15, 2, 0.1, 200);
  scene.add(new THREE.HemisphereLight(0xb9c2ff, 0x10132a, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(-5, 8, 9);
  scene.add(sun);

  const labels = [];
  function addLabel(html, point, cls = "") {
    const el = document.createElement("div");
    el.className = `op-label ${cls}`;
    el.innerHTML = html;
    host.appendChild(el);
    labels.push({ el, at: point });
    return el;
  }

  // ---- the floor and the wall behind, marked every 25 ----
  const step = Math.min(0.85, (narrow ? 7 : 15) / bars.length);
  const wide = Math.max(bars.length * step, 3);
  const glowTex = canvasTexture(128, 128, (g) => {
    const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, "rgba(255,255,255,.9)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  });
  const floorTex = canvasTexture(1024, 256, (g, w, h) => {
    g.fillStyle = "#1c2149"; g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(154,166,220,.14)"; g.lineWidth = 2;
    for (let x = 0; x <= w; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y <= h; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    const fade = g.createLinearGradient(0, 0, 0, h);
    fade.addColorStop(0, "rgba(23,27,52,0)"); fade.addColorStop(1, "rgba(23,27,52,.95)");
    g.fillStyle = fade; g.fillRect(0, 0, w, h);
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(wide + 4, 5).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: floorTex, transparent: true, opacity: 0.82 }));
  floor.position.z = 1.2;
  scene.add(floor);
  const wallTex = canvasTexture(512, 256, (g, w, h) => {
    const up = g.createLinearGradient(0, 0, 0, h);
    up.addColorStop(0, "#171b34"); up.addColorStop(0.7, "#171b34"); up.addColorStop(1, "#232a5c");
    g.fillStyle = up; g.fillRect(0, 0, w, h);
  });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(wide + 30, HIGH + 12), new THREE.MeshBasicMaterial({ map: wallTex }));
  // The wall stands right behind the columns, so a column's top reads against the wall's lines.
  const BACK = -step * 0.4;
  wall.position.set(0, (HIGH + 12) / 2, BACK - 0.02);
  scene.add(wall);
  for (const mark of [0, 25, 50, 75, 100]) {
    const y = (mark / 100) * HIGH;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-wide / 2 - 0.45, y, BACK), new THREE.Vector3(wide / 2 + 0.45, y, BACK)]),
      new THREE.LineBasicMaterial({ color: 0x9aa6dc, transparent: true, opacity: mark === 100 ? 0.8 : 0.35 }));
    scene.add(line);
    addLabel(String(mark), new THREE.Vector3(-wide / 2 - 0.75, y, BACK), "scale");
  }
  // Which way the row runs.
  addLabel(data.ends[0], new THREE.Vector3(-wide / 2 + 0.2, -0.12, 0.3), "scale under");
  addLabel(data.ends[1], new THREE.Vector3(wide / 2 - 0.2, -0.12, 0.3), "scale under");

  // ---- the columns ----
  // One agent's row is drawn slimmer, so the wall's lines and the line through its scores show between.
  const thick = step * (data.line ? 0.46 : 0.66);
  const geo = new THREE.BoxGeometry(thick, 1, thick).translate(0, 0.5, 0);
  const edges = new THREE.EdgesGeometry(geo);
  // Lighter toward the top, so a column reads as lit from above.
  const shade = canvasTexture(8, 128, (g, w, h) => {
    const up = g.createLinearGradient(0, 0, 0, h);
    up.addColorStop(0, "#ffffff"); up.addColorStop(1, "#59608c");
    g.fillStyle = up; g.fillRect(0, 0, w, h);
  });
  // Each score is written over its column where there is room for the numbers.
  const numbered = bars.length <= (narrow ? 16 : 26);
  const targets = [];
  const tops = [];
  let lastValue = null, lastButOne = null;
  const cols = bars.map((bar, i) => {
    const x = (i - (bars.length - 1) / 2) * step;
    const color = COLOR[bar.kind] ?? COLOR.ended;
    const scored = Number.isFinite(bar.value);
    const high = scored ? Math.max(STUB, (bar.value / 100) * HIGH) : STUB;
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, map: shade, emissive: color, emissiveMap: shade, emissiveIntensity: scored ? 0.35 : 0.1, roughness: 0.35, metalness: 0.2, transparent: !scored, opacity: scored ? 1 : 0.75 }));
    m.position.x = x;
    m.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.45), transparent: true, opacity: scored ? 0.85 : 0.4 })));
    // One agent's scores repeat from proposal to proposal: there a number is written only where it changes.
    if (numbered && scored && bar.kind === "finalized" && !(data.line && bar.value === lastValue)) addLabel(String(bar.value), new THREE.Vector3(x, high + 0.08, 0), "num");
    if (scored && bar.kind === "finalized") { lastButOne = lastValue; lastValue = bar.value; }
    m.userData.pick = { bar };
    targets.push(m);
    scene.add(m);
    if (scored) {
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(step * 3.2, step * 3.2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: glowTex, color, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
      pool.position.set(x, 0.01, 0);
      scene.add(pool);
    }
    if (bar.kind === "finalized" && scored) tops.push(new THREE.Vector3(x, high, 0));
    let under = null;
    if (CONFIG.mirror && scored) {
      under = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, map: shade, transparent: true, opacity: 0.32 }));
      under.position.set(x, -0.02, 0);
      scene.add(under);
    }
    return { m, under, bar, x, high, from: i * Math.min(0.06, 1.2 / bars.length) };
  });
  let path = null;
  if (CONFIG.line && data.line && tops.length > 1) {
    path = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(tops.map((p) => p.clone().setY(p.y + 0.05)), false, "catmullrom", 0), tops.length * 4, 0.03, 6), new THREE.MeshBasicMaterial({ color: 0xf1ecff }));
    scene.add(path);
  }

  // The newest pending proposal carries its score over it, and its window is counted down in the
  // corner, where it cannot be read against the wall's lines. The newest finalized score is always numbered.
  const pending = [...cols].reverse().find((c) => c.bar.kind === "pending" && Number.isFinite(c.bar.value));
  const newest = data.line ? [...cols].reverse().find((c) => c.bar.kind === "finalized") : null;
  const closes = hud.querySelector(".op-pending");
  if (pending) addLabel(String(pending.bar.value), new THREE.Vector3(pending.x, pending.high + 0.08, 0), "num pending");
  if (newest && (!numbered || newest.bar.value === lastButOne)) addLabel(String(newest.bar.value), new THREE.Vector3(newest.x, newest.high + 0.08, 0), "num");
  function tick() {
    if (!pending) return;
    const text = `pending ${pending.bar.value}` + (pending.bar.closes ? `, ${fmtLeft(pending.bar.closes - Math.floor(Date.now() / 1000))}` : "");
    if (closes.textContent !== text) { closes.textContent = text; closes.classList.remove("u-hidden"); }
  }

  let dust = null;
  if (CONFIG.dust) {
    const n = 110, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[i * 3] = (Math.random() - 0.5) * (wide + 6); pos[i * 3 + 1] = Math.random() * 5; pos[i * 3 + 2] = (Math.random() - 0.5) * 5 + 1; }
    dust = new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(pos, 3)),
      new THREE.PointsMaterial({ map: glowTex, color: 0xaab4ff, size: 0.08, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending }));
    scene.add(dust);
  }

  // ---- view ----
  const lean = { x: 0, y: 0, tx: 0, ty: 0 };
  let dist = 16, dirty = true, visible = false, hovered = null, held = null, touch = false, stopped = false;
  let clock = CONFIG.rise && !still ? 0 : Infinity;
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const half = Math.tan((camera.fov * Math.PI) / 360);
    dist = Math.max((wide / 2 + (narrow ? 0.75 : 1.1)) / (half * camera.aspect), (narrow ? 3 : 2.2) / half);
    camera.updateProjectionMatrix();
    dirty = true;
  }
  function rise(T) {
    for (const c of cols) {
      const u = Math.min(1, Math.max(0, (T - c.from) / 0.7));
      c.m.scale.y = Math.max(0.001, c.high * u * u * (3 - 2 * u));
      // Only the foot of each column shows in the floor.
      if (c.under) c.under.scale.y = -Math.min(0.5, c.m.scale.y);
    }
    if (path) path.visible = T > cols[cols.length - 1].from + 0.7;
  }
  const point = new THREE.Vector3();
  function draw(t) {
    const drift = CONFIG.sway && !still ? Math.sin(t * 0.17) * 0.7 : 0;
    // From almost straight ahead and a little above, so the wall's lines stay level across the row.
    camera.position.set(-dist * 0.03 + drift + lean.x * 1.6, (narrow ? 2.3 : 1.7) + dist * 0.07 - lean.y * 0.5, dist * 0.98);
    // On a narrow screen the count above takes three lines, so the row sits lower.
    camera.lookAt(0, narrow ? 2.25 : 1.62, 0);
    const lit = hovered ?? held;
    for (const m of targets) {
      const scored = Number.isFinite(m.userData.pick.bar.value);
      m.material.emissiveIntensity = m === lit ? 1.5 : scored ? 0.35 : 0.1;
      m.scale.x = m.scale.z = m === lit ? 1.35 : 1;
    }
    renderer.render(scene, camera);
    for (const l of labels) {
      point.copy(l.at).project(camera);
      const half = l.el.offsetWidth / 2 + 6;
      l.el.style.left = `${Math.min(host.clientWidth - half, Math.max(half, ((point.x + 1) / 2) * host.clientWidth))}px`;
      l.el.style.top = `${((1 - point.y) / 2) * host.clientHeight}px`;
    }
    tip.classList.toggle("u-hidden", !lit);
    if (lit) {
      const c = cols.find((k) => k.m === lit);
      point.set(c.x, c.high + 0.45, 0).project(camera);
      const half = tip.offsetWidth / 2 + 6;
      tip.style.left = `${Math.min(host.clientWidth - half, Math.max(half, ((point.x + 1) / 2) * host.clientWidth))}px`;
      tip.style.top = `${Math.max(tip.offsetHeight + 6, ((1 - point.y) / 2) * host.clientHeight)}px`;
    }
  }

  // ---- pointer ----
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(ev) {
    const b = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - b.left) / b.width) * 2 - 1, -((ev.clientY - b.top) / b.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(targets, false)[0]?.object;
    if (hit) return hit;
    // A stub is a few pixels high: anywhere in the air above it finds it too.
    const onWall = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), point);
    if (!onWall || point.y < 0 || point.y > HIGH) return null;
    const near = cols.find((c) => Math.abs(c.x - point.x) < step / 2);
    return near ? near.m : null;
  }
  const show = (m) => { if (m) tip.innerHTML = m.userData.pick.bar.tip; };
  canvas.addEventListener("pointermove", (ev) => {
    const b = canvas.getBoundingClientRect();
    if (CONFIG.parallax) { lean.tx = ((ev.clientX - b.left) / b.width) * 2 - 1; lean.ty = ((ev.clientY - b.top) / b.height) * 2 - 1; }
    if (ev.pointerType === "mouse") {
      const m = pick(ev);
      if (m !== hovered) { hovered = m; show(m ?? held); canvas.classList.toggle("pick", Boolean(m)); }
    }
    dirty = true;
  });
  canvas.addEventListener("pointerleave", () => { lean.tx = lean.ty = 0; hovered = null; show(held); canvas.classList.remove("pick"); dirty = true; });
  canvas.addEventListener("pointerdown", (ev) => { touch = ev.pointerType !== "mouse"; });
  canvas.addEventListener("click", (ev) => {
    const m = pick(ev);
    dirty = true;
    // A finger has no hover: the first tap names the column, a second tap on it goes to it.
    if (touch && m !== held) { held = m; show(m); return; }
    if (!m) { held = null; return; }
    const { href, id } = m.userData.pick.bar;
    if (href) { window.location.href = href; return; }
    const entry = id && document.getElementById(id);
    if (!entry) return;
    entry.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
    entry.classList.add("flash");
    setTimeout(() => entry.classList.remove("flash"), 2200);
  });

  // ---- frame ----
  let last = null, clockAt = 0;
  function frame(ms) {
    if (stopped) return;
    requestAnimationFrame(frame);
    if (!visible || !canvas.isConnected) { last = null; return; }
    const dt = last === null ? 0 : Math.min(0.05, (ms - last) / 1000);
    last = ms;
    const t = ms / 1000;
    if (ms - clockAt > 1000) { clockAt = ms; tick(); }
    lean.x += (lean.tx - lean.x) * Math.min(1, dt * 4);
    lean.y += (lean.ty - lean.y) * Math.min(1, dt * 4);
    // With reduced motion nothing moves by itself: the room is drawn when something changes.
    if (still) { if (!dirty && Math.abs(lean.tx - lean.x) < 0.001 && Math.abs(lean.ty - lean.y) < 0.001) return; }
    else {
      if (clock < 3) { clock += dt; rise(clock); }
      if (dust) dust.rotation.y = Math.sin(t * 0.05) * 0.05;
    }
    dirty = false;
    draw(t);
  }

  resize();
  rise(clock);
  tick();
  const sized = new ResizeObserver(resize), seen = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
  sized.observe(host);
  seen.observe(host);
  requestAnimationFrame(frame);
  return () => { stopped = true; sized.disconnect(); seen.disconnect(); renderer.dispose(); };
}

// epochs.js says what to draw each time it has read something new, or null for nothing.
let stop = null;
function begin() {
  const host = document.getElementById("epScene"), card = document.getElementById("epSceneCard"), data = window.SigvaraEpochScene;
  if (!host || !card) return;
  stop?.();
  stop = null;
  if (!data?.bars?.length) { card.classList.add("u-hidden"); return; }
  // Shown first, so the room can be measured; hidden again if there is nothing to draw with.
  card.classList.remove("u-hidden");
  card.querySelector("h2").textContent = data.title;
  card.classList.toggle("no-line", !data.line);
  document.getElementById("epSceneNote").textContent = data.note;
  stop = start(host, data);
  if (!stop) card.classList.add("u-hidden");
}
document.addEventListener("sigvara-epoch-scene", begin);
begin();
