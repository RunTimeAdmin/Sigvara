// The simulation, replayed in 3D (three.js, vendored beside this file since the site loads no
// outside scripts).
//
// It draws only what simulation.js has already read, and invents nothing: each column is a
// simulated agent, standing where its kind stands; its height is the number of payments in the
// primary oracle's evidence that had settled by the time shown; each moving dot is one of those
// payments, travelling from the wallet that paid to the agent paid. Every state is a function of
// the time shown, so the slider can go to any moment.

import * as THREE from "./vendor/three.module.min.js";

// Every feature is a switch here. Turn one off, do not delete it.
const CONFIG = {
  autoplay: true,     // replay from day 0 when the card opens (never under reduced motion)
  loop: true,         // start again after reaching today
  orbit: true,        // the camera drifts round while playing
  edges: true,        // a faint line for each payer and agent that have traded by the time shown
  shadows: true,
  secondsPerDay: 1.3, // replay speed, in real seconds for one simulated day
  pulseSeconds: 0.8,  // how long one payment's dot is in flight
  holdSeconds: 4,     // rest at today before looping
};

const COLOR = { steady: 0xa3f1c6, mediocre: 0xb8a5ff, failing: 0xffbf7a, ring: 0xff8585 };
const C_PAYER = 0xe9e5ff, C_RING = 0xff6b6b, C_BASE = 0x6fe5ea, C_NEG = 0xff3d3d, C_SLASH = 0xff3d3d;
const R_AGENTS = 5.5, R_PAYERS = 8.6, R_RING_PAYERS = 7.2, R_GROUND = 9.8;
const H_MIN = 0.14, H_MAX = 4.4, MAX_PULSES = 600;
const ELEVATION = (40 * Math.PI) / 180, FOV = 36, LOOK_Y = -1.1;

const $ = (id) => document.getElementById(id);
const fmtDay = (sec) => new Date(sec * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
// How many of a sorted list are at or before t.
function countUpTo(sorted, t) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

let started = false;
function boot() {
  const data = window.SigvaraSimData;
  if (started || !data) return;
  const card = $("sceneCard");
  // Nothing to replay unless at least one agent's payments could be read.
  if (!card || !data.agents.some((a) => a.flow?.length)) return;
  try {
    started = true;
    init(data, card);
  } catch (e) {
    // No WebGL, or it failed: the rest of the page says the same things in words.
    card.classList.add("u-hidden");
    console.warn("The 3D replay is not shown:", e);
  }
}

function init(data, card) {
  const X = window.SigvaraExplorer;
  const { start, kinds } = data;
  const tEnd = Math.min(Date.now() / 1000, start + data.days * 86400);
  const kindOf = new Map(kinds.map((k) => [k.key, k]));
  const colorOf = (a) => COLOR[kindOf.get(a.profile)?.pill ?? a.profile] ?? 0xc4cbe0;

  // ---- where everything stands ----
  // Agents on the inner circle, kind by kind with a gap between kinds.
  const groups = kinds.map((k) => data.agents.filter((a) => a.profile === k.key).sort((x, y) => x.day - y.day || x.address.localeCompare(y.address))).filter((g) => g.length);
  const slots = groups.reduce((n, g) => n + g.length + 1, 0);
  const step = (Math.PI * 2) / slots;
  const colR = Math.min(0.5, R_AGENTS * step * 0.36);
  const agents = [];
  let slot = 0;
  for (const g of groups) {
    for (const a of g) {
      const ang = slot++ * step;
      agents.push({ a, ang, x: Math.cos(ang) * R_AGENTS, z: Math.sin(ang) * R_AGENTS, color: colorOf(a),
        times: (a.flow ?? []).map((f) => f.t).sort((p, q) => p - q) });
    }
    slot++;
  }
  const maxCount = Math.max(1, ...agents.map((s) => s.times.length));
  const heightAt = (s, t) => H_MIN + (H_MAX * countUpTo(s.times, t)) / maxCount;

  // Payers: wallets a ring's operator funds stand together beside their ring, everyone else
  // evenly round the outside.
  const ringSet = new Set(data.ringPayers);
  const firstPaid = new Map();
  for (const s of agents) for (const f of s.a.flow ?? []) if (!(firstPaid.get(f.payer) <= f.t)) firstPaid.set(f.payer, f.t);
  const names = [...firstPaid.keys()].sort();
  const ringAgents = agents.filter((s) => (kindOf.get(s.a.profile)?.pill ?? s.a.profile) === "ring");
  const ringAng = ringAgents.length ? ringAgents.reduce((n, s) => n + s.ang, 0) / ringAgents.length : 0;
  const ringNames = ringAgents.length ? names.filter((p) => ringSet.has(p)) : [];
  const others = names.filter((p) => !ringNames.includes(p));
  const payers = new Map();
  others.forEach((p, i) => {
    const ang = (i / others.length) * Math.PI * 2 + step / 2;
    payers.set(p, { x: Math.cos(ang) * R_PAYERS, z: Math.sin(ang) * R_PAYERS, ring: false, first: firstPaid.get(p) });
  });
  ringNames.forEach((p, i) => {
    const ang = ringAng + (i - (ringNames.length - 1) / 2) * 0.16;
    payers.set(p, { x: Math.cos(ang) * R_RING_PAYERS, z: Math.sin(ang) * R_RING_PAYERS, ring: true, first: firstPaid.get(p) });
  });
  const payerList = [...payers.values()];

  // Every payment, oldest first, and every payer and agent pair by when they first traded.
  const flows = [];
  const pairs = new Map();
  agents.forEach((s) => {
    for (const f of s.a.flow ?? []) {
      const p = payers.get(f.payer);
      flows.push({ t: f.t, s, p, color: f.neg ? C_NEG : f.base ? C_BASE : p.ring ? C_RING : C_PAYER });
      const key = f.payer + s.a.address;
      if (!(pairs.get(key)?.t <= f.t)) pairs.set(key, { t: f.t, s, p });
    }
  });
  flows.sort((p, q) => p.t - q.t);
  const flowTimes = flows.map((f) => f.t);
  const edges = [...pairs.values()].sort((p, q) => p.t - q.t);

  // ---- the scene ----
  const holder = $("simScene");
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = CONFIG.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "A 3D replay of the simulation's payments. The cast list below gives the same agents and counts as text.");
  holder.prepend(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 2, 0.1, 200);
  scene.add(new THREE.HemisphereLight(0xe6e9ff, 0x2a2f55, 1.25));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(7, 13, 5);
  sun.castShadow = CONFIG.shadows;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 40 });
  sun.shadow.bias = -0.0005;
  sun.shadow.radius = 7;
  scene.add(sun);
  // A low light from the other side, so the shaded half of each column still has shape.
  const fill = new THREE.DirectionalLight(0x9fb4ff, 0.9);
  fill.position.set(-8, 4, -6);
  scene.add(fill);

  const ground = new THREE.Mesh(new THREE.CircleGeometry(R_GROUND, 96), new THREE.MeshStandardMaterial({ color: 0x343b72, roughness: 0.9, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  // Two faint circles mark where agents and customers stand.
  for (const r of [R_AGENTS, R_PAYERS]) {
    const ringMark = new THREE.Mesh(new THREE.RingGeometry(r - 0.015, r + 0.015, 128), new THREE.MeshBasicMaterial({ color: 0x9aa6dc, transparent: true, opacity: 0.22 }));
    ringMark.rotation.x = -Math.PI / 2;
    ringMark.position.y = 0.005;
    scene.add(ringMark);
  }
  // A lit rim, so the floor has an edge.
  const rim = new THREE.Mesh(new THREE.RingGeometry(R_GROUND - 0.07, R_GROUND, 128), new THREE.MeshBasicMaterial({ color: 0x9b8cff, transparent: true, opacity: 0.7 }));
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.006;
  scene.add(rim);
  // A faint polar grid gives the floor some scale.
  const grid = new THREE.PolarGridHelper(R_GROUND, 24, 6, 96, 0x8f9be0, 0x8f9be0);
  grid.material.transparent = true;
  grid.material.opacity = 0.09;
  grid.position.y = 0.004;
  scene.add(grid);

  const colGeo = new THREE.CylinderGeometry(colR, colR, 1, 28).translate(0, 0.5, 0);
  const footGeo = new THREE.RingGeometry(colR * 1.12, colR * 1.34, 40).rotateX(-Math.PI / 2);
  const haloGeo = new THREE.TorusGeometry(colR * 1.7, 0.09, 12, 48).rotateX(Math.PI / 2);
  const haloMat = new THREE.MeshBasicMaterial({ color: C_SLASH, toneMapped: false });
  const capGeo = new THREE.CircleGeometry(colR * 0.82, 28).rotateX(-Math.PI / 2);
  for (const s of agents) {
    s.column = new THREE.Mesh(colGeo, new THREE.MeshPhysicalMaterial({ color: s.color, roughness: 0.32, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.25, emissive: s.color, emissiveIntensity: 0.12 }));
    // A lit cap, so the top of each column reads as its value.
    s.cap = new THREE.Mesh(capGeo, new THREE.MeshBasicMaterial({ color: s.color, toneMapped: false }));
    s.cap.position.set(s.x, 0, s.z);
    s.column.position.set(s.x, 0, s.z);
    s.column.castShadow = CONFIG.shadows;
    s.column.userData.s = s;
    const foot = new THREE.Mesh(footGeo, new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.55 }));
    foot.position.set(s.x, 0.012, s.z);
    s.halo = new THREE.Mesh(haloGeo, haloMat);
    s.halo.position.set(s.x, 0, s.z);
    scene.add(s.column, s.cap, foot, s.halo);
  }
  const columns = agents.map((s) => s.column);

  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  const payerMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.15, 16, 12), new THREE.MeshStandardMaterial({ roughness: 0.4 }), payerList.length);
  payerList.forEach((p, i) => payerMesh.setColorAt(i, tint.setHex(p.ring ? C_RING : C_PAYER)));
  payerMesh.castShadow = CONFIG.shadows;
  scene.add(payerMesh);

  const pulseMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.1, 10, 8), new THREE.MeshBasicMaterial({ toneMapped: false }), MAX_PULSES);
  pulseMesh.setColorAt(0, tint.setHex(0xffffff));
  pulseMesh.frustumCulled = false;
  scene.add(pulseMesh);

  // Ordinary pairs are a faint web. A ring's own wallets get bright lines, since that closed loop
  // is the thing to see.
  const edgeSets = [];
  if (CONFIG.edges) {
    for (const [ring, color, opacity] of [[false, 0xaab4ee, 0.07], [true, C_RING, 0.85]]) {
      const list = edges.filter((e) => e.p.ring === ring);
      if (!list.length) continue;
      const pos = new Float32Array(list.length * 6);
      list.forEach((e, i) => pos.set([e.p.x, ring ? 0.06 : 0.03, e.p.z, e.s.x, ring ? 0.06 : 0.03, e.s.z], i * 6));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity, toneMapped: !ring }));
      lines.frustumCulled = false;
      scene.add(lines);
      edgeSets.push({ lines, times: list.map((e) => e.t) });
    }
  }

  // ---- time ----
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const speed = 86400 / CONFIG.secondsPerDay;   // simulated seconds per real second
  const span = CONFIG.pulseSeconds * speed;      // a payment's dot is in flight this long, in simulated time
  let t = tEnd;                                  // the time shown
  let playing = CONFIG.autoplay && !reduced;
  let hold = 1.5;                                // real seconds to rest before the next replay starts
  let azimuth = ringAng + 0.5, dirty = true, visible = true, hovered = null;

  const play = $("simPlay"), scrub = $("simScrub"), dayLabel = $("simSceneDay"), countLabel = $("simSceneCount"), tip = $("simTip");
  const unread = data.agents.filter((a) => a.registeredAt && !a.flow).length;

  function draw() {
    const shown = Math.min(t, tEnd);
    for (const s of agents) {
      const here = s.a.registeredAt > 0 && s.a.registeredAt <= shown;
      const h = heightAt(s, shown);
      s.h = here ? h : 0;
      s.column.visible = here;
      s.column.scale.y = h;
      s.column.material.emissiveIntensity = s === hovered ? 0.45 : 0.12;
      // A slash that is cancelled leaves no mark; any other shows from the time it was filed.
      s.halo.visible = here && s.a.slashAt > 0 && s.a.slashAt <= shown && s.a.slash !== "none" && s.a.slash !== "cancelled";
      s.halo.position.y = h + 0.22;
      s.cap.visible = here;
      s.cap.position.y = h + 0.004;
    }
    payerList.forEach((p, i) => {
      dummy.position.set(p.x, 0.13, p.z);
      dummy.scale.setScalar(p.first <= shown ? (p.ring ? 1.7 : 1) : 0.0001);
      dummy.updateMatrix();
      payerMesh.setMatrixAt(i, dummy.matrix);
    });
    payerMesh.instanceMatrix.needsUpdate = true;

    // Payments in flight: those that settled within the last `span` of the time shown.
    const hi = countUpTo(flowTimes, t), lo = Math.max(countUpTo(flowTimes, t - span), hi - MAX_PULSES);
    let n = 0;
    for (let i = lo; i < hi; i++) {
      const f = flows[i], u = (t - f.t) / span, v = 1 - u;
      const top = f.s.h + 0.05, lift = Math.max(top, 0.2) + 2.2;
      dummy.position.set(
        v * v * f.p.x + 2 * u * v * (f.p.x + f.s.x) / 2 + u * u * f.s.x,
        v * v * 0.2 + 2 * u * v * lift + u * u * top,
        v * v * f.p.z + 2 * u * v * (f.p.z + f.s.z) / 2 + u * u * f.s.z);
      dummy.scale.setScalar(u > 0.85 ? (1 - u) / 0.15 + 0.2 : 1);
      dummy.updateMatrix();
      pulseMesh.setMatrixAt(n, dummy.matrix);
      pulseMesh.setColorAt(n, tint.setHex(f.color));
      n++;
    }
    pulseMesh.count = n;
    pulseMesh.instanceMatrix.needsUpdate = true;
    pulseMesh.instanceColor.needsUpdate = true;
    for (const set of edgeSets) set.lines.geometry.setDrawRange(0, countUpTo(set.times, shown) * 2);

    const day = Math.floor((shown - start) / 86400) + 1;
    const count = countUpTo(flowTimes, shown);
    dayLabel.textContent = `Day ${day} · ${fmtDay(shown)}`;
    countLabel.textContent = `${count.toLocaleString("en-US")} ${count === 1 ? "payment" : "payments"} so far`
      + (unread ? ` (${unread} ${unread === 1 ? "agent's" : "agents'"} payments could not be read)` : "");
    scrub.value = String(Math.round(((shown - start) / (tEnd - start)) * 1000));
    scrub.setAttribute("aria-valuetext", `Day ${day}, ${fmtDay(shown)}`);

    camera.position.set(Math.cos(azimuth) * camera.userData.dist * Math.cos(ELEVATION), camera.userData.dist * Math.sin(ELEVATION) + camera.userData.lookY, Math.sin(azimuth) * camera.userData.dist * Math.cos(ELEVATION));
    camera.lookAt(0, camera.userData.lookY, 0);
    renderer.render(scene, camera);
    if (hovered) { fillTip(hovered); placeTip(); }
  }

  function resize() {
    const w = holder.clientWidth, h = holder.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Far enough back that the whole floor and the tallest column are in frame, and no further.
    const tanV = Math.tan((FOV * Math.PI) / 360);
    const wide = R_GROUND / (tanV * camera.aspect), tall = (R_GROUND * Math.sin(ELEVATION) + 1.4) / tanV;
    camera.userData.dist = Math.max(wide, tall) * 1.2;
    // In a wide frame the floor is aimed low to leave the top for the columns; a narrow frame has room to spare.
    camera.userData.lookY = wide > tall ? 0.6 : LOOK_Y;
    camera.updateProjectionMatrix();
    dirty = true;
  }

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!visible) return;
    if (playing) {
      if (hold > 0) {
        hold -= dt;
        if (hold <= 0) t = start;
      } else {
        t += dt * speed;
        // Run a little past today so the last payments land, then rest.
        if (t >= tEnd + span) {
          t = tEnd + span;
          if (CONFIG.loop) hold = CONFIG.holdSeconds; else setPlaying(false);
        }
      }
      if (CONFIG.orbit && !drag) azimuth += dt * 0.05;
      dirty = true;
    }
    if (dirty) { dirty = false; draw(); }
  }

  function setPlaying(on) {
    playing = on;
    play.textContent = on ? "Pause" : "Play";
    play.setAttribute("aria-pressed", String(on));
  }
  play.addEventListener("click", () => {
    // Play from the end starts over.
    if (!playing && t >= tEnd) { t = start; hold = 0; }
    setPlaying(!playing);
  });
  scrub.addEventListener("input", () => {
    setPlaying(false);
    hold = 0;
    t = start + (Number(scrub.value) / 1000) * (tEnd - start);
    dirty = true;
  });

  // ---- pointer: drag to turn, hover for an agent's numbers, click to open its score epochs ----
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), top = new THREE.Vector3();
  let drag = null;
  function pick(ev) {
    const box = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - box.left) / box.width) * 2 - 1, -((ev.clientY - box.top) / box.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(columns, false)[0]?.object.userData.s ?? null;
  }
  function placeTip() {
    top.set(hovered.x, hovered.h + 0.3, hovered.z).project(camera);
    tip.style.left = `${((top.x + 1) / 2) * holder.clientWidth}px`;
    tip.style.top = `${((1 - top.y) / 2) * holder.clientHeight}px`;
  }
  // The tooltip's lines for the hovered column at the replay's present moment. It is filled again
  // as the replay plays, so its count keeps up with the column it is on; only a change is written.
  let tipKey = "";
  function fillTip(s) {
    const shown = Math.min(t, tEnd), n = countUpTo(s.times, shown);
    const key = `${s.a.address}|${n}|${fmtDay(shown)}`;
    if (key === tipKey) return;
    tipKey = key;
    const line = (text, cls) => { const el = document.createElement("div"); el.textContent = text; if (cls) el.className = cls; return el; };
    tip.replaceChildren(
      line(X.short(s.a.address), "sim-tip-addr"),
      line(`${kindOf.get(s.a.profile)?.label ?? s.a.profile} · ${data.statusOf(s.a, start)[1]} today`),
      line(`${n.toLocaleString("en-US")} ${n === 1 ? "payment" : "payments"} by ${fmtDay(shown)}`),
      line(`Earned score today: ${s.a.earned}`));
  }
  function setHover(s) {
    if (s === hovered) return;
    hovered = s;
    canvas.classList.toggle("pick", Boolean(s));
    tip.classList.toggle("u-hidden", !s);
    if (s) {
      tipKey = "";
      fillTip(s);
      placeTip();
    }
    dirty = true;
  }
  canvas.addEventListener("pointerdown", (ev) => { drag = { x: ev.clientX, moved: false }; canvas.setPointerCapture(ev.pointerId); });
  canvas.addEventListener("pointermove", (ev) => {
    if (drag) {
      const dx = ev.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (drag.moved) { azimuth += dx * 0.006; drag.x = ev.clientX; setHover(null); dirty = true; }
    } else if (ev.pointerType === "mouse") setHover(pick(ev));
  });
  canvas.addEventListener("pointerup", (ev) => {
    const was = drag;
    drag = null;
    if (was?.moved) return;
    const s = pick(ev);
    // A mouse click opens the agent; a tap shows its numbers first, and a second tap opens it.
    if (s && (ev.pointerType === "mouse" || s === hovered)) location.href = `epochs?a=${s.a.address}`;
    else setHover(s);
  });
  canvas.addEventListener("pointercancel", () => { drag = null; });
  canvas.addEventListener("pointerleave", () => { if (!drag) setHover(null); });

  // ---- the key ----
  const key = (cls, text) => { const el = document.createElement("span"); el.className = cls; el.textContent = text; return el; };
  const legend = [...kinds.filter((k) => agents.some((s) => s.a.profile === k.key)).map((k) => key(`ex-pill ${k.pill ?? k.key}`, k.label))];
  if (agents.some((s) => !s.a.registeredAt)) legend.push(key("sim-key later", "Agent not registered yet"));
  legend.push(key("sim-key wallet", "Customer wallet and its payments"));
  if (payerList.some((p) => p.ring)) legend.push(key("sim-key ringpay", "Wallet funded by the ring's operator and its payments"));
  if (flows.some((f) => f.color === C_BASE)) legend.push(key("sim-key base", "Payment on Base Sepolia"));
  if (flows.some((f) => f.color === C_NEG)) legend.push(key("sim-key neg", "Reported as not delivered"));
  if (agents.some((s) => s.a.slashAt > 0 && s.a.slash !== "none" && s.a.slash !== "cancelled")) legend.push(key("sim-key slash", "Slash filed"));
  $("simSceneLegend").replaceChildren(...legend);

  card.classList.remove("u-hidden");
  setPlaying(playing);
  resize();
  new ResizeObserver(resize).observe(holder);
  // Nothing is drawn while the card is off screen.
  new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; last = performance.now(); }).observe(holder);
  // Build every shader now, so none is compiled in the middle of the replay.
  draw();
  renderer.compile(scene, camera);
  requestAnimationFrame(frame);
}

document.addEventListener("sigvara-sim-data", boot);
boot();
