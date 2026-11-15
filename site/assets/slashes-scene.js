// Where each agent slash stands, as a floor it has crossed (three.js, vendored), drawn only from
// the proceedings slashes.js has already rebuilt. What each thing means:
//   a capsule        one slash filed against an agent, standing where it is now
//   the round pad    where every slash is filed
//   the three floors open (filed, not executed or dropped), executed, dropped
//   an amber band    the operator disputed it
//   a white halo     it was dropped by the admin's veto
//   a stack          an executed slash's stake, split to scale: burned, to the victim, and
//                    (before 2 November 2026) to the member who filed it
// The replay sends each slash off from the pad to where it stands, in the order they were filed.
// It shows order and outcome, not how long anything took. The dust and the slow sway say nothing.
//
// Without WebGL nothing is drawn and the card stays hidden: the list below holds all of it.

import * as THREE from "./vendor/three.module.min.js";

// Every feature is a switch here. Turn one off, do not delete it.
const CONFIG = {
  replay: true,    // slashes walk in from the pad when the room first shows, and on the button
  parallax: true,  // the view leans a little toward the pointer
  sway: true,      // and drifts slowly from side to side
  flow: true,      // dashes run along the paths, the way a slash goes
  dust: true,      // motes in the air
  most: 24,        // the newest this many slashes are drawn
};

const X = window.SigvaraExplorer;
const COLOR = { open: 0x8f9cff, executed: 0xff5c6c, dropped: 0xa3f1c6, disputed: 0xffbf7a, burned: 0xff8a3d, victim: 0x6fe5ea, filer: 0xff7ad9, pad: 0x9aa6dc };
const STEP = 0.75, WALK = 1.6, WAIT = 0.15, ON = 1.5;   // the replay, in seconds

function canvasTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ease = (u) => u * u * (3 - 2 * u);

function start(host, list) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (_) {
    return false;
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

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x171b34, 40, 90);
  // A long lens, so the floors at the sides are not sheared.
  const camera = new THREE.PerspectiveCamera(narrow ? 30 : 18, 2, 0.1, 140);
  scene.add(new THREE.HemisphereLight(0xb9c2ff, 0x10132a, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(-4, 9, 7);
  scene.add(sun);

  // The way a slash goes is left to right on a wide screen, and back to front on a narrow one.
  const at = (along, across, y = 0) => (narrow ? new THREE.Vector3(across * 0.8, y, along) : new THREE.Vector3(along, y, across));
  const box = (along, high, across) => (narrow ? new THREE.BoxGeometry(across * 0.8, high, along) : new THREE.BoxGeometry(along, high, across));

  const labels = [];
  function addLabel(html, point, cls = "") {
    const el = document.createElement("div");
    el.className = `op-label ${cls}`;
    el.innerHTML = html;
    host.appendChild(el);
    labels.push({ el, at: point });
    return el;
  }

  // ---- the floor ----
  const glowTex = canvasTexture(128, 128, (g) => {
    const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, "rgba(255,255,255,.9)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  });
  const gridTex = canvasTexture(1024, 1024, (g, w) => {
    g.strokeStyle = "rgba(154,166,220,.15)"; g.lineWidth = 2;
    for (let i = 0; i <= w; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, w); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); }
    g.globalCompositeOperation = "destination-out";
    const hole = g.createRadialGradient(w / 2, w / 2, w * 0.2, w / 2, w / 2, w / 2);
    hole.addColorStop(0, "rgba(0,0,0,0)"); hole.addColorStop(1, "rgba(0,0,0,1)");
    g.fillStyle = hole; g.fillRect(0, 0, w, w);
  });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(34, 34).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: gridTex, transparent: true, depthWrite: false })));

  // ---- the gate and the three floors ----
  const GATE = -5.6, OPEN = { along: -1.1, across: 0 }, EXEC = { along: 4.3, across: -2.8 }, DROP = { along: 4.3, across: 2.6 };
  // A floor is longer the way the screen is wide, so the slashes on it stand side by side.
  const FLOOR = narrow ? { along: 2.7, across: 4.4 } : { along: 3.5, across: 2.8 };
  const EDGE = FLOOR.along / 2;
  // A slash that ended crosses the open floor along its side, clear of those standing on it.
  const LANE = FLOOR.across / 2 - 0.35;
  const shown = list.slice(-CONFIG.most);
  const by = (state) => shown.filter((p) => p.state === state);
  function floorOf(spot, color, name, n, lift) {
    const geo = box(FLOOR.along, 0.14, FLOOR.across);
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.2), emissive: color, emissiveIntensity: 0.05, roughness: 0.5, metalness: 0.4 }));
    m.position.copy(at(spot.along, spot.across, 0.07));
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 })));
    scene.add(m);
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(7, 7).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: glowTex, color, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }));
    pool.position.copy(at(spot.along, spot.across, 0.01));
    scene.add(pool);
    return addLabel(`<b>${name}</b><span>${n}</span>`, lift, "under").lastChild;
  }
  // Each floor is named at its near edge.
  const near = (spot) => (narrow ? at(spot.along + EDGE + 0.15, spot.across, 0) : at(spot.along, spot.across + FLOOR.across / 2 + 0.45, 0));
  const count = {
    // On a narrow screen the two paths leave the open floor at its near edge, so it is named at its side.
    open: floorOf(OPEN, COLOR.open, "Open", by("open").length, narrow ? at(OPEN.along + 0.4, -3.75, 0) : near(OPEN)),
    executed: floorOf(EXEC, COLOR.executed, "Executed", by("executed").length, near(EXEC)),
    dropped: floorOf(DROP, COLOR.dropped, "Dropped", by("dropped").length, near(DROP)),
  };

  const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.14, 40), new THREE.MeshStandardMaterial({ color: 0x3a4170, emissive: COLOR.pad, emissiveIntensity: 0.3, roughness: 0.5, metalness: 0.4 }));
  pad.position.copy(at(GATE, 0, 0.07));
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.025, 8, 48).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: COLOR.pad }));
  rim.position.y = 0.07;
  pad.add(rim);
  scene.add(pad);
  addLabel("<b>Filed here</b>", narrow ? at(GATE, 0, 0.9) : at(GATE, 1.2, 0), narrow ? "" : "under");

  // The paths, with dashes running the way a slash goes.
  const dashTex = canvasTexture(64, 8, (g, w, h) => {
    const run = g.createLinearGradient(0, 0, w, 0);
    run.addColorStop(0, "rgba(255,255,255,.1)"); run.addColorStop(0.7, "rgba(255,255,255,.9)"); run.addColorStop(0.72, "rgba(255,255,255,.1)"); run.addColorStop(1, "rgba(255,255,255,.1)");
    g.fillStyle = run; g.fillRect(0, 0, w, h);
  });
  const flows = [];
  function path(points, color, repeat) {
    const curve = new THREE.CatmullRomCurve3(points.map(([a, b]) => at(a, b, 0.03)));
    const map = dashTex.clone();
    map.wrapS = THREE.RepeatWrapping; map.repeat.set(repeat, 1); map.needsUpdate = true;
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.05, 6), new THREE.MeshBasicMaterial({ map, color, transparent: true, depthWrite: false }));
    tube.scale.y = 0.3;
    scene.add(tube);
    flows.push(map);
  }
  path([[GATE + 0.95, 0], [OPEN.along - EDGE, 0]], COLOR.pad, 8);
  path([[OPEN.along + EDGE, -LANE], [1.6, -1.7], [EXEC.along - EDGE, EXEC.across]], COLOR.executed, 7);
  path([[OPEN.along + EDGE, LANE], [1.6, 1.7], [DROP.along - EDGE, DROP.across]], COLOR.dropped, 7);

  // ---- the slashes ----
  // Where the n-th of `count` stands on a floor: rows of up to four, the oldest at the back.
  function slot(spot, n, count) {
    const cols = Math.min(4, count), rows = Math.ceil(count / 4);
    const col = n % 4, row = Math.floor(n / 4);
    const inRow = row === rows - 1 ? count - row * 4 : cols;
    const side = (col - (inRow - 1) / 2) * 0.8, deep = (row - (rows - 1) / 2) * Math.min(0.8, 2 / rows);
    return narrow ? { along: spot.along + deep, across: spot.across + side / 0.8 } : { along: spot.along + side, across: spot.across + deep };
  }
  const WHITE = 0xe9e5ff;   // a slash that has not ended
  const capsule = new THREE.CapsuleGeometry(0.25, 0.5, 6, 18).translate(0, 0.64, 0);
  const band = new THREE.TorusGeometry(0.27, 0.05, 8, 28).rotateX(Math.PI / 2);
  const halo = new THREE.TorusGeometry(0.2, 0.03, 8, 28).rotateX(Math.PI / 2);
  // The tallest executed stake stands this high; the rest are to the same scale.
  const most = shown.reduce((m, p) => (p.state === "executed" && p.taken > m ? p.taken : m), 0n);
  const targets = [];
  const counts = { open: 0, executed: 0, dropped: 0 };
  const tokens = shown.map((p, i) => {
    const spot = p.state === "open" ? OPEN : p.state === "executed" ? EXEC : DROP;
    const end = slot(spot, counts[p.state]++, by(p.state).length);
    // Every slash is open first: one that ended waits in the middle of the open floor on its way.
    const mid = p.state === "open" ? end : { along: OPEN.along + EDGE - 0.4, across: p.state === "executed" ? -LANE : LANE };
    const group = new THREE.Group();
    scene.add(group);
    const body = new THREE.Mesh(capsule, new THREE.MeshStandardMaterial({ color: WHITE, emissive: WHITE, emissiveIntensity: 0.25, roughness: 0.35, metalness: 0.2 }));
    body.userData.pick = { p, grow: 1.12 };
    targets.push(body);
    group.add(body);
    let mark = null;
    if (p.disputed) {
      mark = new THREE.Mesh(band, new THREE.MeshBasicMaterial({ color: COLOR.disputed }));
      mark.position.y = 0.62;
      group.add(mark);
    }
    let veto = null;
    if (p.vetoed) {
      veto = new THREE.Mesh(halo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      veto.position.y = 1.2;
      group.add(veto);
    }
    // An executed slash ends as its stake, split.
    let stack = null;
    if (p.state === "executed" && most > 0n) {
      stack = new THREE.Group();
      let y = 0;
      for (const [amount, color] of [[p.burned, COLOR.burned], [p.toVictim, COLOR.victim], [p.toReporter, COLOR.filer]]) {
        if (!amount) continue;
        const h = Math.max(0.05, 1.7 * (Number((amount * 10000n) / most) / 10000));
        const part = new THREE.Mesh(new THREE.BoxGeometry(0.44, h - 0.02, 0.44), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3, roughness: 0.4 }));
        part.position.y = y + h / 2;
        part.userData.pick = { p, grow: 1.08 };
        targets.push(part);
        stack.add(part);
        y += h;
      }
      group.add(stack);
    }
    return { p, group, body, mark, veto, stack, mid, end, from: i * STEP };
  });
  const LENGTH = Math.max(0, tokens.length - 1) * STEP + WALK + WAIT + ON + 0.4;

  // Where everything is at second T of the replay; at rest T is past its end.
  function pose(T) {
    const now = { open: 0, executed: 0, dropped: 0 };
    for (const k of tokens) {
      const t = T - k.from, done = k.p.state !== "open";
      k.group.visible = t >= 0;
      if (t < 0) continue;
      const u = ease(Math.min(1, t / WALK));
      const v = done ? ease(Math.min(1, Math.max(0, (t - WALK - WAIT) / ON))) : 0;
      const along = v > 0 ? k.mid.along + (k.end.along - k.mid.along) * v : GATE + (k.mid.along - GATE) * u;
      const across = v > 0 ? k.mid.across + (k.end.across - k.mid.across) * v : k.mid.across * u;
      const moving = (u > 0 && u < 1) || (v > 0 && v < 1);
      k.group.position.copy(at(along, across, 0.14 + (moving ? Math.abs(Math.sin(t * 9)) * 0.06 : 0)));
      const arrived = !done || v >= 1;
      // The counts under the floors follow what is over them.
      if (done && v > 0.75) now[k.p.state]++;
      else if (u > 0.75 && v < 0.2) now.open++;
      if (k.mark) k.mark.visible = u >= 1;
      if (k.veto) k.veto.visible = arrived;
      if (k.stack) { k.stack.visible = arrived; k.body.visible = !arrived; }
      const color = done && arrived ? COLOR[k.p.state] : WHITE;
      k.body.material.color.set(color);
      k.body.material.emissive.set(color);
    }
    for (const state in now) if (count[state].textContent !== String(now[state])) count[state].textContent = now[state];
  }

  let dust = null;
  if (CONFIG.dust) {
    const n = 140, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[i * 3] = (Math.random() - 0.5) * 20; pos[i * 3 + 1] = Math.random() * 6; pos[i * 3 + 2] = (Math.random() - 0.5) * 16; }
    dust = new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(pos, 3)),
      new THREE.PointsMaterial({ map: glowTex, color: 0xaab4ff, size: 0.1, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending }));
    scene.add(dust);
  }

  hud.innerHTML = `<b>${list.length} slash${list.length === 1 ? "" : "es"} filed</b>`
    + (list.length > shown.length ? `<span>the newest ${shown.length} drawn</span>` : "");
  let clock = Infinity, dirty = true;
  if (CONFIG.replay && !still) {
    const again = document.createElement("button");
    again.type = "button";
    again.className = "sim-btn sl-replay";
    again.textContent = "Replay";
    again.addEventListener("click", () => { clock = 0; });
    host.appendChild(again);
    clock = 0;
  }

  const describe = (p) => {
    const lines = [`Slash of agent <span class="sim-tip-addr">${X.esc(p.agent)}</span>${p.sim ? ` (simulated: ${X.esc(p.sim)})` : ""}`,
      `filed ${X.esc(X.fmtWhen(p.at))}`];
    if (p.evidence) lines.push(`“${X.esc(p.evidence.length > 110 ? p.evidence.slice(0, 107) + "…" : p.evidence)}”`);
    if (p.disputed) lines.push("disputed by the operator");
    lines.push(p.state === "open" ? "<b>open</b>: not executed or dropped"
      : p.state === "executed" ? `<b>executed</b> ${X.esc(X.fmtWhen(p.endTime))}: ${X.esc(X.fmtSvr(p.burned))} burned, ${X.esc(X.fmtSvr(p.toVictim))} to the victim${p.toReporter ? `, ${X.esc(X.fmtSvr(p.toReporter))} to the member who filed it` : ""}`
        : `<b>${p.vetoed ? "vetoed" : "dropped"}</b> ${X.esc(X.fmtWhen(p.endTime))}`);
    lines.push("Click to read it in the list below.");
    return lines.join("<br>");
  };

  // ---- view ----
  const lean = { x: 0, y: 0, tx: 0, ty: 0 };
  let dist = 16, visible = false, hovered = null, held = null, touch = false;
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const half = Math.tan((camera.fov * Math.PI) / 360);
    dist = narrow ? Math.max(5.2 / (half * camera.aspect), 15) : Math.max(8.2 / (half * camera.aspect), 3.6 / half);
    camera.updateProjectionMatrix();
    dirty = true;
  }
  const point = new THREE.Vector3();
  function draw(t) {
    const drift = CONFIG.sway && !still ? Math.sin(t * 0.17) * 0.8 : 0;
    if (narrow) { camera.position.set(drift + lean.x, dist * 0.64 - lean.y * 0.6, dist * 0.77 - 0.3); camera.lookAt(0, 0, -0.3); }
    else { 
      // Where the room is less wide than it is drawn for, the view looks further back, so the floors sit lower in it.
      const back = -0.5 - Math.max(0, 2.3 - camera.aspect) * 1.6;
      camera.position.set(0.3 - dist * 0.22 + drift + lean.x * 1.4, dist * 0.5 - lean.y * 0.6, dist * 0.84 + back); camera.lookAt(0.3, 0.2, back);
    }
    renderer.render(scene, camera);
    for (const l of labels) {
      point.copy(l.at).project(camera);
      const half = l.el.offsetWidth / 2 + 6;
      l.el.style.left = `${Math.min(host.clientWidth - half, Math.max(half, ((point.x + 1) / 2) * host.clientWidth))}px`;
      l.el.style.top = `${((1 - point.y) / 2) * host.clientHeight}px`;
    }
    const lit = hovered ?? held;
    tip.classList.toggle("u-hidden", !lit);
    for (const m of targets) {
      const mine = Boolean(lit) && m.userData.pick.p === lit.userData.pick.p;
      m.scale.setScalar(mine ? m.userData.pick.grow : 1);
      m.material.emissiveIntensity = mine ? 0.7 : m.userData.pick.grow > 1.1 ? 0.25 : 0.3;
    }
  }

  // ---- pointer ----
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(ev) {
    const b = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - b.left) / b.width) * 2 - 1, -((ev.clientY - b.top) / b.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(targets.filter((m) => m.visible && m.parent.visible && (m.parent.parent?.visible ?? true)), false)[0]?.object ?? null;
  }
  const show = (m) => { if (m) tip.innerHTML = describe(m.userData.pick.p); };
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
    // A finger has no hover: the first tap names the slash, a second tap on it goes to it.
    if (touch && m !== held) { held = m; show(m); return; }
    if (!m) { held = null; return; }
    const entry = document.getElementById(`proceeding-${m.userData.pick.p.index}`);
    if (!entry) return;
    entry.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
    entry.classList.add("flash");
    setTimeout(() => entry.classList.remove("flash"), 2200);
  });

  // ---- frame ----
  let last = null;
  function frame(ms) {
    requestAnimationFrame(frame);
    if (!visible || !canvas.isConnected) { last = null; return; }
    const dt = last === null ? 0 : Math.min(0.05, (ms - last) / 1000);
    last = ms;
    const t = ms / 1000;
    lean.x += (lean.tx - lean.x) * Math.min(1, dt * 4);
    lean.y += (lean.ty - lean.y) * Math.min(1, dt * 4);
    // With reduced motion nothing moves by itself: the room is drawn when something changes.
    if (still) { if (!dirty && Math.abs(lean.tx - lean.x) < 0.001 && Math.abs(lean.ty - lean.y) < 0.001) return; }
    else {
      if (clock < LENGTH) { clock += dt; pose(clock); }
      if (CONFIG.flow) for (const map of flows) map.offset.x -= dt * 0.7;
      if (dust) dust.rotation.y = t * 0.012;
    }
    dirty = false;
    draw(t);
  }

  host.classList.add("ready");
  resize();
  pose(clock);
  new ResizeObserver(resize).observe(host);
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(host);
  requestAnimationFrame(frame);
  return true;
}

function begin() {
  const host = document.getElementById("slScene"), list = window.SigvaraSlashData;
  if (!host || !list?.length || host.classList.contains("ready")) return;
  // Shown first, so the room can be measured; hidden again if there is nothing to draw with.
  const card = document.getElementById("slSceneCard");
  card.classList.remove("u-hidden");
  if (!start(host, list)) card.classList.add("u-hidden");
}
document.addEventListener("sigvara-slash-data", begin);
begin();
