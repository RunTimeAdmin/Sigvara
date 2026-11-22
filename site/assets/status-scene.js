// The services as a row of beacons (three.js, vendored), drawn only from what status.js has just
// judged, and drawn again each time it reads. What each thing means:
//   a beacon's light   the state status.js gave that service: green running, amber look at this,
//                      red down, and a hollow violet ring for no answer
//   a glass column     a measure with limits: for an operator, the time since its last epoch
//                      finished; for the event index, how many blocks it is behind the chain
//   the rings on it    where that measure counts as late, and as down
//   red beads          disagreements the checker recorded that can still be rejected
//   the floor lines    cyan from each service that reads the chain, pink from the checker to its disagreements
// A light breathes slowly and dust drifts; neither says anything. While status.js is reading, the
// corner says so.
//
// Without WebGL nothing is drawn and the card stays hidden: the list below holds all of it.

import * as THREE from "./vendor/three.module.min.js";

// Every feature is a switch here. Turn one off, do not delete it.
const CONFIG = {
  breathe: true,   // each light swells and fades a little
  parallax: true,  // the view leans a little toward the pointer
  sway: true,      // and drifts slowly from side to side
  flow: true,      // dashes run along the floor lines, toward what is read
  dust: true,      // motes in the air
};

const COLOR = { ok: 0xa3f1c6, attention: 0xffbf7a, unreachable: 0xc5b7ff, down: 0xff5c6c, reads: 0x6fe5ea, from: 0xff9db0 };
const TALL = 2.3;      // a glass column, from empty to its last limit

function canvasTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Draws `data.rows` in `host`. Returns { update, stop }, or null if there is no WebGL.
function start(host, data) {
  const LIMITS = data.limits;
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

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(narrow ? 26 : 17, 2, 0.1, 200);
  scene.add(new THREE.HemisphereLight(0xb9c2ff, 0x10132a, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
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
    const hole = g.createRadialGradient(w / 2, w / 2, w * 0.15, w / 2, w / 2, w / 2);
    hole.addColorStop(0, "rgba(0,0,0,0)"); hole.addColorStop(1, "rgba(0,0,0,1)");
    g.fillStyle = hole; g.fillRect(0, 0, w, w);
  });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(30, 30).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: gridTex, transparent: true, depthWrite: false })));

  // ---- the beacons ----
  // In a row on a wide screen. On a narrow one the beacons with a column stand in a back row, named
  // above their lights, and the others in a front row, named at their feet, so the names fit.
  const n = data.rows.length;
  const gap = 2.7;
  const back = data.rows.map((r, i) => i).filter((i) => data.rows[i].kind !== "divergence" && data.rows[i].kind !== "chain");
  const front = data.rows.map((r, i) => i).filter((i) => !back.includes(i));
  const inFront = (i) => narrow && front.includes(i);
  function place(i) {
    if (!narrow) return new THREE.Vector3((i - (n - 1) / 2) * gap, 0, 0);
    const row = inFront(i) ? front : back;
    return new THREE.Vector3((row.indexOf(i) - (row.length - 1) / 2) * (inFront(i) ? 3.6 : 2.3), 0, inFront(i) ? 4.8 : 0);
  }
  const glass = new THREE.CylinderGeometry(0.27, 0.27, TALL, 28, 1, true).translate(0, TALL / 2, 0);
  const core = new THREE.CylinderGeometry(0.2, 0.2, 1, 24).translate(0, 0.5, 0);
  const foot = new THREE.CylinderGeometry(0.5, 0.58, 0.16, 32).translate(0, 0.08, 0);
  const stand = new THREE.CylinderGeometry(0.16, 0.24, 1, 20).translate(0, 0.5, 0);
  const ball = new THREE.SphereGeometry(0.3, 28, 20);
  const hoop = new THREE.TorusGeometry(0.3, 0.05, 10, 32);
  const mark = new THREE.TorusGeometry(0.29, 0.018, 6, 32).rotateX(Math.PI / 2);
  const bead = new THREE.OctahedronGeometry(0.17);
  const targets = [];
  const posts = data.rows.map((row, i) => {
    const at = place(i);
    const group = new THREE.Group();
    group.position.copy(at);
    scene.add(group);
    const base = new THREE.Mesh(foot, new THREE.MeshStandardMaterial({ color: 0x2a315f, roughness: 0.45, metalness: 0.5 }));
    group.add(base);
    // An operator or the index has a column whether or not it answered this time.
    const gauged = row.kind === "primary" || row.kind === "checker" || row.kind === "index";
    // A column is as tall as its last limit: the index has only one, so its column is shorter.
    const tall = gauged ? TALL * (LIMITS[row.kind].tall ?? 1) : 0;
    const high = gauged ? tall : 1;
    let fill = null, tube = null;
    const marks = [];
    if (gauged) {
      tube = new THREE.Mesh(glass, new THREE.MeshStandardMaterial({ color: 0xdfe4ff, transparent: true, opacity: 0.13, roughness: 0.2, metalness: 0.3, side: THREE.DoubleSide, depthWrite: false }));
      tube.position.y = 0.16;
      tube.scale.y = tall / TALL;
      // Unshaded, so it is the same colour as the light above it.
      fill = new THREE.Mesh(core, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      fill.position.y = 0.16;
      group.add(fill, tube);
      for (const [where, name] of LIMITS[row.kind].marks) {
        const ring = new THREE.Mesh(mark, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
        ring.position.y = 0.16 + (where / LIMITS[row.kind].of) * tall;
        group.add(ring);
        marks.push(ring);
        // On a narrow screen there is room to name the rings only at the two ends of the back row:
        // to the left of the first column and to the right of the last. The one between has the same rings.
        const end = !narrow ? 1 : back.indexOf(i) === 0 ? -1 : back.indexOf(i) === back.length - 1 ? 1 : 0;
        if (end) marks.push(addLabel(name, at.clone().add(new THREE.Vector3(0.4 * end, ring.position.y, 0)), end > 0 ? "scale left" : "scale right"));
      }
    } else {
      const pole = new THREE.Mesh(stand, new THREE.MeshStandardMaterial({ color: 0x343c70, roughness: 0.45, metalness: 0.5 }));
      pole.position.y = 0.16;
      group.add(pole);
    }
    const top = 0.16 + high + 0.5;
    const light = new THREE.Mesh(ball, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.3 }));
    light.position.y = top;
    const ring = new THREE.Mesh(hoop, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    ring.position.y = top;
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.y = top;
    glow.scale.setScalar(1.9);
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 4.2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
    pool.position.y = 0.012;
    group.add(light, ring, glow, pool);
    const beads = new THREE.Group();
    beads.position.y = top;
    group.add(beads);
    // Anything on the beacon finds it.
    const reach = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, top + 0.4, 12).translate(0, (top + 0.4) / 2, 0), new THREE.MeshBasicMaterial({ visible: false }));
    reach.userData.post = i;
    group.add(reach);
    targets.push(reach);
    const above = narrow && !inFront(i);
    const label = addLabel("<b></b><span></span><span></span>", above ? at.clone().setY(top + 0.5) : at.clone().add(new THREE.Vector3(0, 0, 0.75)), above ? "status" : "under status");
    return { row, at, group, fill, tube, marks, tall, light, ring, glow, pool, beads, top, label, seed: i * 1.7 };
  });

  // The floor lines: each service that reads the chain, and the checker's disagreements.
  const dashTex = canvasTexture(64, 8, (g, w, h) => {
    const run = g.createLinearGradient(0, 0, w, 0);
    run.addColorStop(0, "rgba(255,255,255,.1)"); run.addColorStop(0.7, "rgba(255,255,255,.9)"); run.addColorStop(0.72, "rgba(255,255,255,.1)"); run.addColorStop(1, "rgba(255,255,255,.1)");
    g.fillStyle = run; g.fillRect(0, 0, w, h);
  });
  const flows = [];
  const find = (kind) => posts.find((p) => p.row.kind === kind);
  function line(from, to, bend, color) {
    if (!from || !to) return;
    const a = from.at, b = to.at, mid = a.clone().lerp(b, 0.5);
    mid.z += bend;
    const curve = new THREE.QuadraticBezierCurve3(a.clone().setY(0.03), mid.setY(0.03), b.clone().setY(0.03));
    const map = dashTex.clone();
    map.wrapS = THREE.RepeatWrapping; map.repeat.set(Math.max(4, Math.round(a.distanceTo(b) * 1.6)), 1); map.needsUpdate = true;
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.07, 6), new THREE.MeshBasicMaterial({ map, color, transparent: true, depthWrite: false }));
    tube.scale.y = 0.3;
    scene.add(tube);
    flows.push(map);
  }
  const chain = find("chain");
  // Each bends a different way, so that in a row they do not run into one track.
  line(find("primary"), chain, narrow ? -2.6 : -7, COLOR.reads);
  line(find("checker"), chain, narrow ? -1.9 : -4.4, COLOR.reads);
  line(find("index"), chain, narrow ? -1.1 : -1.8, COLOR.reads);
  line(find("checker"), find("divergence"), narrow ? 1.3 : 2.6, COLOR.from);

  let dust = null;
  if (CONFIG.dust) {
    const count = 110, pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { pos[i * 3] = (Math.random() - 0.5) * 20; pos[i * 3 + 1] = Math.random() * 5; pos[i * 3 + 2] = (Math.random() - 0.5) * 8; }
    dust = new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(pos, 3)),
      new THREE.PointsMaterial({ map: glowTex, color: 0xaab4ff, size: 0.08, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending }));
    scene.add(dust);
  }

  // ---- what was read ----
  let dirty = true;
  // "No answer" is written in the colour of its ring, not in the red of "down".
  const pillOf = (row) => (row.state === "unreachable" ? "st-none" : row.pill);
  function update(next) {
    hud.innerHTML = `<b class="${next.pill}">${next.headline}</b><span>${next.checked}</span>`;
    next.rows.forEach((row, i) => {
      const p = posts[i];
      if (!p) return;
      p.row = row;
      const color = COLOR[row.state] ?? COLOR.down;
      const answered = row.state !== "unreachable";
      p.light.visible = answered;
      p.ring.visible = !answered;
      for (const m of [p.light.material]) { m.color.set(color); m.emissive.set(color); }
      p.ring.material.color.set(color);
      p.glow.material.color.set(color);
      p.glow.material.opacity = answered ? 0.55 : 0.2;
      p.pool.material.color.set(color);
      if (p.fill) {
        const known = Number.isFinite(row.gauge);
        const part = known ? Math.min(1, Math.max(0, row.gauge / LIMITS[row.kind].of)) : 0;
        p.fill.visible = known;
        p.fill.scale.y = Math.max(0.02, part * p.tall);
        p.fill.material.color.set(color);
        // With no measure read, the column and its rings fade out: an empty column would read as a good one.
        p.tube.material.opacity = known ? 0.13 : 0.05;
        for (const m of p.marks) {
          if (m.isMesh) m.material.opacity = known ? 0.85 : 0.15;
          else m.classList.toggle("u-hidden", !known);
        }
      }
      p.beads.clear();
      for (let k = 0; k < Math.min(row.beads ?? 0, 12); k++) {
        const b = new THREE.Mesh(bead, new THREE.MeshStandardMaterial({ color: COLOR.down, emissive: COLOR.down, emissiveIntensity: 0.7 }));
        // In a row over the light, where each can be counted.
        const shown = Math.min(row.beads, 12), col = k % 6, line = Math.floor(k / 6);
        // On a narrow screen, seen from above, "over" would land on the row behind: there they stand beside the light.
        if (narrow) b.position.set(0.55 + col * 0.4, 0, 0.25 + line * 0.4);
        else b.position.set((col - (Math.min(6, shown - line * 6) - 1) / 2) * 0.42, 0.62 + line * 0.4, 0);
        p.beads.add(b);
      }
      const [name, state, fact] = p.label.children;
      name.textContent = row.name;
      state.textContent = row.label;
      state.className = pillOf(row);
      fact.textContent = row.fact ?? "";
    });
    // A tooltip that is open says what was just read, not what was read when it opened.
    show(hovered ?? held);
    dirty = true;
  }
  const reading = () => { const s = hud.querySelector("span"); if (s) s.textContent = "reading…"; };

  // ---- view ----
  const lean = { x: 0, y: 0, tx: 0, ty: 0 };
  let dist = 16, visible = false, hovered = null, held = null, touch = false, stopped = false;
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const half = Math.tan((camera.fov * Math.PI) / 360);
    dist = narrow ? Math.max(4.7 / (half * camera.aspect), 4.3 / half) : Math.max((((n - 1) / 2) * gap + 1.9) / (half * camera.aspect), 2.7 / half);
    camera.updateProjectionMatrix();
    dirty = true;
  }
  const point = new THREE.Vector3();
  function draw(t) {
    const drift = CONFIG.sway && !still ? Math.sin(t * 0.17) * 0.3 : 0;
    // On a narrow screen the view is from higher up, so the front row stands clear of the back one.
    camera.position.set(drift + lean.x * 0.7, 2.4 + dist * (narrow ? 0.5 : 0.2) - lean.y * 0.5, dist * (narrow ? 0.86 : 0.97) + (narrow ? 2.3 : 0));
    camera.lookAt(0, narrow ? 1.2 : 1.72, narrow ? 2.3 : 0);
    const lit = hovered ?? held;
    posts.forEach((p, i) => {
      const beat = CONFIG.breathe && !still ? 1 + Math.sin(t * 1.4 + p.seed) * 0.06 : 1;
      p.light.scale.setScalar(lit === i ? 1.3 : beat);
      p.glow.scale.setScalar((lit === i ? 2.6 : 1.9) * beat);
    });
    renderer.render(scene, camera);
    for (const l of labels) {
      point.copy(l.at).project(camera);
      const half = l.el.classList.contains("left") || l.el.classList.contains("right") ? 0 : l.el.offsetWidth / 2 + 4;
      l.el.style.left = `${Math.min(host.clientWidth - half, Math.max(half, ((point.x + 1) / 2) * host.clientWidth))}px`;
      l.el.style.top = `${((1 - point.y) / 2) * host.clientHeight}px`;
    }
    tip.classList.toggle("u-hidden", lit === null);
  }

  // ---- pointer ----
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(ev) {
    const b = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - b.left) / b.width) * 2 - 1, -((ev.clientY - b.top) / b.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(targets, false)[0]?.object.userData.post ?? null;
  }
  function show(i) {
    if (i === null) return;
    const row = posts[i].row;
    tip.innerHTML = `<b>${row.name}</b>: <span class="${pillOf(row)}">${row.label}</span><br>${row.text}${row.href ? "<br>Click to open where this was read from." : ""}`;
  }
  canvas.addEventListener("pointermove", (ev) => {
    const b = canvas.getBoundingClientRect();
    if (CONFIG.parallax) { lean.tx = ((ev.clientX - b.left) / b.width) * 2 - 1; lean.ty = ((ev.clientY - b.top) / b.height) * 2 - 1; }
    if (ev.pointerType === "mouse") {
      const i = pick(ev);
      if (i !== hovered) { hovered = i; show(i ?? held); canvas.classList.toggle("pick", i !== null && Boolean(posts[i].row.href)); }
    }
    dirty = true;
  });
  canvas.addEventListener("pointerleave", () => { lean.tx = lean.ty = 0; hovered = null; show(held); canvas.classList.remove("pick"); dirty = true; });
  canvas.addEventListener("pointerdown", (ev) => { touch = ev.pointerType !== "mouse"; });
  canvas.addEventListener("click", (ev) => {
    const i = pick(ev);
    dirty = true;
    // A finger has no hover: the first tap names the beacon, a second tap on it opens it.
    if (touch && i !== held) { held = i; show(i); return; }
    const href = i === null ? null : posts[i].row.href;
    if (!href) { if (i === null) held = null; return; }
    if (href.startsWith("http")) window.open(href, "_blank", "noopener");
    else window.location.href = href;
  });

  // ---- frame ----
  let last = null;
  function frame(ms) {
    if (stopped) return;
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
      if (CONFIG.flow) for (const map of flows) map.offset.x -= dt * 0.6;
      if (dust) dust.rotation.y = Math.sin(t * 0.05) * 0.05;
    }
    dirty = false;
    draw(t);
  }

  resize();
  update(data);
  const sized = new ResizeObserver(resize), seen = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
  sized.observe(host);
  seen.observe(host);
  requestAnimationFrame(frame);
  return { update, reading, stop: () => { stopped = true; sized.disconnect(); seen.disconnect(); renderer.dispose(); } };
}

// status.js says what it judged each time it has read, and when it starts reading again.
let live = null;
function begin() {
  const host = document.getElementById("stScene"), card = document.getElementById("stSceneCard"), data = window.SigvaraStatusScene;
  if (!host || !card || !data?.rows?.length) return;
  if (live) { live.update(data); return; }
  // Shown first, so the room can be measured; hidden again if there is nothing to draw with.
  card.classList.remove("u-hidden");
  live = start(host, data);
  if (!live) card.classList.add("u-hidden");
}
document.addEventListener("sigvara-status-scene", begin);
document.addEventListener("sigvara-status-reading", () => live?.reading());
begin();
