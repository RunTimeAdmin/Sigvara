// The lobby as a room with depth (three.js, vendored). The same people as lobby.js draws, by the
// same rules: a look and a nickname come only from the address, a mood only from the status on
// chain, a prop only from how the agent is labelled. No score reaches this file either, and where
// someone stands still means nothing.
//
// Each person is the drawing lobby.js makes, set upright on the floor as a card. If WebGL is not
// there, start() says so and the page keeps the flat room.

import * as THREE from "./vendor/three.module.min.js";

// Every feature is a switch here. Turn one off, do not delete it.
const CONFIG = {
  wander: true,    // people walk about
  parallax: true,  // the view leans a little toward the pointer
  lamps: true,     // hanging lamps and their pools of light
  shadows: true,   // a soft shadow under each person
  speed: 0.5,      // floor units a second
};

const BG = 0x0f1221;
const byteOf = (address, i) => parseInt(String(address).slice(2 + i * 2, 4 + i * 2), 16);
const span = (from, to) => from + Math.random() * (to - from);

function canvasTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// A soft round glow, used for shadows (dark) and lamp light (bright).
const glow = (inner, outer) => canvasTexture(128, 128, (g) => {
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, inner); r.addColorStop(1, outer);
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
});

function label(text, size, width) {
  const tex = canvasTexture(512, 64, (g) => {
    g.font = `500 ${size}px Inter, ui-sans-serif, system-ui, sans-serif`;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = "#c4cbe0";
    g.fillText(text, 256, 34);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  s.scale.set(width, width / 8, 1);
  return s;
}

// One person's drawing as a texture. lobby.js makes the SVG; the browser rasterises it.
function portrait(Lobby, person) {
  const tex = new THREE.Texture();
  tex.colorSpace = THREE.SRGBColorSpace;
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = c.height = 224;
    c.getContext("2d").drawImage(img, 0, 0, 224, 224);
    tex.image = c;
    tex.needsUpdate = true;
  };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="224" height="224" viewBox="0 0 64 64" font-family="sans-serif">${Lobby.drawing(person)}</svg>`);
  return tex;
}

// Puts the people in a room inside `host`. Same contract as lobby.js's startLobby, and returns
// false, touching nothing, if there is no WebGL to draw with.
function start(host, people, onPick) {
  const Lobby = window.SigvaraLobby;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  } catch (_) {
    return false;
  }
  const wide = host.clientWidth >= 560;
  const W = wide ? 15 : 7;       // the floor, left to right
  const D = wide ? 7 : 9;      // and back to front
  const TALL = wide ? 1.75 : 1.45;               // a person's card
  const FEET = 0.11;               // how far up the card the feet are
  const DOOR_X = -W / 2 + 1.5, BENCH_X = W / 2 - 2.1;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(BG);
  const canvas = renderer.domElement;
  canvas.className = "ag-room3d";
  canvas.setAttribute("aria-hidden", "true");
  const tag = document.createElement("div");
  tag.className = "ag-tag3d u-hidden";
  host.classList.add("ag-lobby3d");
  host.replaceChildren(canvas, tag);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(BG, 18, 40);
  const camera = new THREE.PerspectiveCamera(30, 2, 0.1, 80);

  // ---- the room ----
  const floorTex = canvasTexture(1536, 768, (g, w, h) => {
    g.fillStyle = "#1d2244"; g.fillRect(0, 0, w, h);
    // Tiles.
    g.strokeStyle = "rgba(154,166,220,.10)"; g.lineWidth = 2;
    const tile = w / (wide ? 24 : 12);
    for (let x = 0; x <= w; x += tile) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y <= h; y += tile) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    // Light from the way in, across the floor.
    const door = g.createRadialGradient(w * ((DOOR_X + W / 2 + 3) / (W + 6)), 0, 0, w * ((DOOR_X + W / 2 + 3) / (W + 6)), 0, h * 0.75);
    door.addColorStop(0, "rgba(255,214,150,.48)"); door.addColorStop(1, "rgba(255,214,150,0)");
    g.fillStyle = door; g.fillRect(0, 0, w, h);
    // Dark toward the edges.
    const edge = g.createRadialGradient(w / 2, h * 0.45, h * 0.2, w / 2, h * 0.45, w * 0.62);
    edge.addColorStop(0, "rgba(15,18,33,0)"); edge.addColorStop(1, "rgba(15,18,33,.92)");
    g.fillStyle = edge; g.fillRect(0, 0, w, h);
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W + 6, D + 3), new THREE.MeshBasicMaterial({ map: floorTex }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, D / 2 + 0.2);
  scene.add(floor);

  const wallTex = canvasTexture(1024, 256, (g, w, h) => {
    const up = g.createLinearGradient(0, 0, 0, h);
    up.addColorStop(0, "#0f1221"); up.addColorStop(1, "#1a1f3d");
    g.fillStyle = up; g.fillRect(0, 0, w, h);
    // Panels, so the wall is not one flat sheet.
    g.strokeStyle = "rgba(154,166,220,.07)"; g.lineWidth = 2;
    for (let x = 0; x <= w; x += w / (wide ? 21 : 10)) { g.beginPath(); g.moveTo(x, h * 0.28); g.lineTo(x, h); g.stroke(); }
    g.fillStyle = "rgba(154,166,220,.07)"; g.fillRect(0, h * 0.28, w, 2);
    // Light on it: warm round the way in, and a wash under each lamp.
    const spots = [[(DOOR_X + W / 2 + 3) / (W + 6), "255,214,150", 0.34]];
    if (CONFIG.lamps) for (const x of wide ? [-W / 3.6, 0, W / 3.6] : [0]) spots.push([(x + W / 2 + 3) / (W + 6), "170,180,255", 0.16]);
    for (const [at, rgb, a] of spots) {
      const r = g.createRadialGradient(w * at, h * 0.8, 0, w * at, h * 0.8, h * 0.95);
      r.addColorStop(0, `rgba(${rgb},${a})`); r.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = r; g.fillRect(0, 0, w, h);
    }
    g.fillStyle = "rgba(154,166,220,.2)"; g.fillRect(0, h - 10, w, 10);
  });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(W + 6, 4.6), new THREE.MeshBasicMaterial({ map: wallTex }));
  wall.position.set(0, 2.3, -0.02);
  scene.add(wall);

  // The way in: a door standing open, with light behind it.
  const doorTex = canvasTexture(128, 224, (g, w, h) => {
    g.fillStyle = "#ffe2ae"; g.fillRect(0, 0, w, h);
    const fade = g.createLinearGradient(0, 0, 0, h);
    fade.addColorStop(0, "rgba(255,190,110,.55)"); fade.addColorStop(1, "rgba(255,240,210,0)");
    g.fillStyle = fade; g.fillRect(0, 0, w, h);
    g.fillStyle = "#181c31"; g.fillRect(0, 0, w * 0.34, h);            // the door itself, pushed aside
    g.fillStyle = "#9ca5bf"; g.beginPath(); g.arc(w * 0.26, h * 0.55, 4, 0, 7); g.fill();
    g.strokeStyle = "#2a2f4c"; g.lineWidth = 8; g.strokeRect(0, 0, w, h);
  });
  const door = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 2.35), new THREE.MeshBasicMaterial({ map: doorTex, fog: false }));
  door.position.set(DOOR_X, 1.175, 0);
  // Lettering is drawn larger where the room is shown smaller.
  const lettering = host.clientWidth < 900 ? 46 : 34, across = wide ? 4.4 : 3.2;
  const wayIn = label("Way in", lettering, across);
  wayIn.position.set(DOOR_X, 2.85, 0.05);
  scene.add(door, wayIn);

  // The suspended bench.
  const wood = new THREE.MeshBasicMaterial({ color: 0x343a63 });
  const seat = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.12, 0.62), wood);
  seat.position.set(BENCH_X, 0.56, 0.62);
  scene.add(seat);
  for (const dx of [-1.15, 1.15]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.5), new THREE.MeshBasicMaterial({ color: 0x272c4d }));
    leg.position.set(BENCH_X + dx, 0.25, 0.62);
    scene.add(leg);
  }
  const benchLabel = label("Suspended bench", lettering, across);
  benchLabel.position.set(BENCH_X, 2.85, 0.05);
  scene.add(benchLabel);

  if (CONFIG.lamps) {
    const light = glow("rgba(255,236,190,.55)", "rgba(255,236,190,0)");
    const n = wide ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? 0 : (i - 1) * (W / 3.6), z = D * 0.5;
      const cord = new THREE.Mesh(new THREE.BoxGeometry(0.02, 1.6, 0.02), new THREE.MeshBasicMaterial({ color: 0x3a4170 }));
      cord.position.set(x, 6.4, z);
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.26, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0x4a5290, side: THREE.DoubleSide }));
      shade.position.set(x, 5.55, z);
      const bulb = new THREE.Sprite(new THREE.SpriteMaterial({ map: light, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      bulb.position.set(x, 5.46, z);
      bulb.scale.setScalar(1.1);
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 6.5), new THREE.MeshBasicMaterial({ map: light, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5 }));
      pool.rotation.x = -Math.PI / 2;
      pool.position.set(x, 0.012, z);
      // On a narrow screen the lamp itself would hang in the middle of the picture: only its light is kept.
      scene.add(pool);
      if (wide) scene.add(cord, shade, bulb);
    }
  }

  // ---- the people ----
  const card = new THREE.PlaneGeometry(TALL, TALL).translate(0, TALL / 2 - FEET * TALL, 0);
  const shadowTex = glow("rgba(0,0,0,.55)", "rgba(0,0,0,0)");
  const shadowGeo = new THREE.PlaneGeometry(TALL * 0.8, TALL * 0.43).rotateX(-Math.PI / 2);
  const counts = { asleep: 0, ghost: 0, ring: 0 };
  const rings = people.filter((p) => p.kind === "ring" && p.mood === "awake").length;
  const X0 = -W / 2 + 0.8, X1 = W / 2 - 0.8, Z0 = 1.5, Z1 = wide ? D - 0.2 : D - 2.2;

  // Where someone starts means nothing, so they start spread evenly over the floor.
  const frac = (v) => v - Math.floor(v);
  const walkers = people.map((person, i) => {
    const a = person.address;
    const near = person.kind === "outside";
    const x = near ? DOOR_X + (byteOf(a, 10) / 255) * 2.4 : X0 + frac(i * 0.618034 + 0.31) * (X1 - X0);
    const z = Z0 + frac(i * 0.754878 + 0.17) * (Z1 - Z0);
    const w = { person, x, z, y: 0, tx: x, tz: z, pause: span(0, 3), near, how: "walk", slot: 0, seed: byteOf(a, 9), face: 1, moving: false };
    if (person.mood === "ghost") { w.how = "float"; w.slot = counts.ghost++; }
    else if (person.mood === "asleep") { w.how = "sit"; w.x = BENCH_X - 0.9 + (counts.asleep++ % 3) * Math.min(0.9, TALL * 0.6); w.z = 0.66; w.y = 0.62; }
    else if (person.waiting) { w.how = "sit"; w.x = DOOR_X + 0.15; w.z = 0.8; }
    else if (person.kind === "ring") { w.how = "ring"; w.slot = counts.ring++; }
    w.mesh = new THREE.Mesh(card, new THREE.MeshBasicMaterial({ map: portrait(Lobby, person), transparent: true, alphaTest: 0.02, depthWrite: false, opacity: person.mood === "ghost" ? 0.85 : 1 }));
    w.mesh.userData.w = w;
    scene.add(w.mesh);
    if (CONFIG.shadows && w.how !== "sit") {
      w.shadow = new THREE.Mesh(shadowGeo, new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: person.mood === "ghost" ? 0.35 : 1 }));
      scene.add(w.shadow);
    }
    return w;
  });
  const cards = walkers.map((w) => w.mesh);

  // A ring on the floor under whoever was clicked.
  const marker = new THREE.Mesh(new THREE.RingGeometry(TALL * 0.44, TALL * 0.53, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x6fe5ea, transparent: true, depthWrite: false, depthTest: false, fog: false }));
  marker.renderOrder = -1;
  marker.visible = false;
  scene.add(marker);

  let hoopX = 0, hoopZ = (Z0 + Z1) / 2, hoopToX = 0, hoopToZ = hoopZ;
  const step = (from, to, by) => (Math.abs(to - from) <= by ? to : from + Math.sign(to - from) * by);

  function move(t, dt) {
    const walk = CONFIG.speed * dt;
    if (Math.hypot(hoopToX - hoopX, hoopToZ - hoopZ) < 0.05) { hoopToX = span(X0 + 1.5, X1 - 1.5); hoopToZ = span(Z0 + 0.6, Z1 - 0.6); }
    hoopX = step(hoopX, hoopToX, walk * 0.6);
    hoopZ = step(hoopZ, hoopToZ, walk * 0.6);
    for (const w of walkers) {
      w.moving = false;
      if (w.how === "float") {
        w.x = W * 0.15 * Math.sin(t / 8 + w.slot * 1.9) - W * 0.03;
        w.z = 1.1;
        w.y = (wide ? 2.05 : 3.3) + 0.14 * Math.sin(t / 1.3 + w.slot);
      } else if (w.how === "ring") {
        const angle = t / 2.6 + (w.slot * 2 * Math.PI) / Math.max(1, rings);
        w.x = hoopX + TALL * 0.69 * Math.cos(angle);
        w.z = hoopZ + TALL * 0.37 * Math.sin(angle);
        w.face = -Math.sin(angle) >= 0 ? 1 : -1;
        w.moving = true;
      } else if (w.how === "walk" && CONFIG.wander) {
        const far = Math.hypot(w.tx - w.x, w.tz - w.z);
        if (far < 0.03) {
          w.pause -= dt;
          if (w.pause <= 0) {
            w.tx = w.near ? span(DOOR_X - 0.4, DOOR_X + 2.6) : span(X0, X1);
            w.tz = span(Z0, Z1);
            w.pause = span(1, 4.5);
          }
        } else {
          w.x += ((w.tx - w.x) / far) * walk;
          w.z += ((w.tz - w.z) / far) * walk;
          if (Math.abs(w.tx - w.x) > 0.05) w.face = w.tx > w.x ? 1 : -1;
          w.moving = true;
        }
      }
      // A small hop while walking, and a slow breath while standing.
      const lift = w.how === "sit" || w.how === "float" ? 0 : w.moving ? Math.abs(Math.sin(t * 9 + w.seed)) * 0.07 : Math.sin(t * 2.4 + w.seed) * 0.012;
      w.mesh.position.set(w.x, w.y + lift, w.z);
      const big = w === hovered || w === picked ? 1.25 : 1;
      w.mesh.scale.set(w.face * big, big, 1);
      if (w.shadow) w.shadow.position.set(w.x, 0.02, w.z + 0.04);
    }
    if (picked) marker.position.set(picked.x, 0.025, picked.z + 0.04);
  }

  // ---- view ----
  const lean = { x: 0, y: 0, tx: 0, ty: 0 };
  let dist = 20, dirty = true, visible = true, hovered = null, picked = null;
  function resize() {
    const w = host.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Back far enough that the floor nearly fills the frame from side to side.
    dist = D + ((W / 2 + 0.2) / (Math.tan((camera.fov * Math.PI) / 360) * camera.aspect)) * (wide ? 0.8 : 0.62);
    camera.updateProjectionMatrix();
    dirty = true;
  }
  const at = new THREE.Vector3();
  function draw() {
    camera.position.set(lean.x * 0.8, (wide ? 7 : 10) - lean.y * 0.4, dist);
    camera.lookAt(lean.x * 0.2, wide ? 1.0 : 1.3, D * (wide ? 0.5 : 0.46));
    renderer.render(scene, camera);
    const named = hovered ?? picked;
    tag.classList.toggle("u-hidden", !named);
    tag.classList.toggle("picked", Boolean(named) && named === picked);
    if (named) {
      at.set(named.x, named.y + TALL * 0.84, named.z).project(camera);
      tag.style.left = `${((at.x + 1) / 2) * host.clientWidth}px`;
      tag.style.top = `${((1 - at.y) / 2) * canvas.clientHeight}px`;
    }
  }

  // ---- pointer ----
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(ev) {
    const box = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - box.left) / box.width) * 2 - 1, -((ev.clientY - box.top) / box.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    // The nearest card whose drawing, not its empty corner, is under the pointer.
    for (const hit of ray.intersectObjects(cards, false)) {
      const u = hit.uv.x - 0.5, v = hit.uv.y - 0.5;
      if (u * u + v * v < 0.2) return hit.object.userData.w;
    }
    return null;
  }
  function setHover(w) {
    if (w === hovered) return;
    hovered = w;
    canvas.classList.toggle("pick", Boolean(w));
    if (w ?? picked) tag.textContent = Lobby.nickname((w ?? picked).person.address);
    dirty = true;
  }
  canvas.addEventListener("pointermove", (ev) => {
    const box = canvas.getBoundingClientRect();
    if (CONFIG.parallax) { lean.tx = ((ev.clientX - box.left) / box.width) * 2 - 1; lean.ty = ((ev.clientY - box.top) / box.height) * 2 - 1; }
    if (ev.pointerType === "mouse") setHover(pick(ev));
    dirty = true;
  });
  canvas.addEventListener("pointerleave", () => { lean.tx = lean.ty = 0; setHover(null); });
  canvas.addEventListener("click", (ev) => {
    const w = pick(ev);
    if (!w) return;
    picked = w;
    marker.visible = true;
    tag.textContent = Lobby.nickname(w.person.address);
    onPick(w.person);
    dirty = true;
  });

  // ---- frame ----
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  let last = null;
  function frame(ms) {
    requestAnimationFrame(frame);
    if (!visible || !canvas.isConnected) { last = null; return; }
    const dt = last === null ? 0 : Math.min(0.05, (ms - last) / 1000);
    last = ms;
    lean.x += (lean.tx - lean.x) * Math.min(1, dt * 4);
    lean.y += (lean.ty - lean.y) * Math.min(1, dt * 4);
    // With reduced motion nobody walks: the room is drawn when something changes, and then rests.
    if (still) { if (!dirty && Math.abs(lean.tx - lean.x) < 0.001) return; move(0, 0); }
    else move(ms / 1000, dt);
    dirty = false;
    draw();
  }

  resize();
  new ResizeObserver(resize).observe(host);
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(host);
  // The portraits arrive a moment after the room: draw again once they are in.
  setTimeout(() => { dirty = true; }, 400);
  setTimeout(() => { dirty = true; }, 1500);
  move(0, 0);
  requestAnimationFrame(frame);
  return true;
}

window.SigvaraLobbyScene = { start };
document.dispatchEvent(new Event("sigvara-lobby-scene"));
