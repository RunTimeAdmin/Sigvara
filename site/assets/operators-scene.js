// The operators as machines in a room (three.js, vendored), drawn only from what operators.js has
// already read. What each thing means:
//   a machine        one address that has bonded; lit while it is active
//   the slabs under  its bond, one slab per deposit, to scale against the bond that makes it active
//   the ring         how far the operator is through its epoch, from its own /health
//   the two lines    what the primary and the checker do, not single transactions
//   a red bead       one disagreement the checker recorded, on the checker's line
// The blinking lights, the drifting dust and the slow sway are decoration and say nothing.
//
// Without WebGL nothing is drawn and the card stays hidden: the tables below hold all of it.

import * as THREE from "./vendor/three.module.min.js";

// Every feature is a switch here. Turn one off, do not delete it.
const CONFIG = {
  parallax: true,  // the view leans a little toward the pointer
  sway: true,      // and drifts slowly from side to side
  flow: true,      // dashes run along the two lines, in the direction of the work
  blink: true,     // the small lights on each machine
  dust: true,      // motes in the air
  clock: true,     // the epoch ring and the countdown under each name
};

const X = window.SigvaraExplorer;
const COLOR = { primary: 0x9475ff, checker: 0x6fe5ea, other: 0xc5b7ff, off: 0x4a5073, bad: 0xff5c6c, late: 0xffbf7a };
const PLINTH = 1.1;        // a bond exactly at the active threshold stands this high
const BODY = { w: 1.15, h: 1.45, d: 1.0 };

function canvasTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const minutes = (ms) => Math.max(1, Math.round(ms / 60000));

function start(host, data) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (_) {
    return false;
  }
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-hidden", "true");
  const hud = document.createElement("div");
  hud.className = "sim-scene-hud";
  const tip = document.createElement("div");
  tip.className = "sim-tip u-hidden";
  host.replaceChildren(canvas, hud, tip);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x171b34, 16, 34);
  const camera = new THREE.PerspectiveCamera(32, 2, 0.1, 80);
  scene.add(new THREE.HemisphereLight(0xb9c2ff, 0x10132a, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-4, 9, 7);
  scene.add(sun);

  const targets = [];     // what the pointer can find
  const labels = [];      // { el, at: Vector3 }
  const clocks = [];      // one per machine whose health was read
  const blinkers = [];
  const bobbers = [];
  const flows = [];

  function addLabel(html, at, cls = "") {
    const el = document.createElement("div");
    el.className = `op-label ${cls}`;
    el.innerHTML = html;
    host.appendChild(el);
    labels.push({ el, at });
    return el;
  }
  function target(mesh, tipHtml, href) {
    mesh.userData.pick = { tip: tipHtml, href, grow: 1.06 };
    targets.push(mesh);
  }

  // ---- the floor ----
  const floorTex = canvasTexture(1024, 1024, (g, w) => {
    const c = w / 2;
    g.strokeStyle = "rgba(154,166,220,.16)"; g.lineWidth = 2;
    for (let r = 60; r < c; r += 60) { g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.stroke(); }
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      g.beginPath(); g.moveTo(c + Math.cos(a) * 60, c + Math.sin(a) * 60); g.lineTo(c + Math.cos(a) * c, c + Math.sin(a) * c); g.stroke();
    }
    g.globalCompositeOperation = "destination-out";
    const hole = g.createRadialGradient(c, c, c * 0.5, c, c, c);
    hole.addColorStop(0, "rgba(0,0,0,0)"); hole.addColorStop(1, "rgba(0,0,0,1)");
    g.fillStyle = hole; g.fillRect(0, 0, w, w);
  });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(13, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: floorTex, transparent: true, depthWrite: false }));
  floor.position.z = -0.6;
  scene.add(floor);
  const glowTex = canvasTexture(128, 128, (g) => {
    const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, "rgba(255,255,255,.9)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  });
  function pool(x, z, color, size, opacity) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: glowTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.set(x, 0.01, z);
    scene.add(m);
  }

  // ---- the score contract ----
  const narrow = host.clientWidth < 560;
  // On a narrow screen the contract stands further back, clear of the two machines.
  const HOME = new THREE.Vector3(0, 0, narrow ? -5 : -2.6);
  const slab = new THREE.CylinderGeometry(0.72, 0.86, 3.2, 6);
  const contract = new THREE.Mesh(slab, new THREE.MeshStandardMaterial({ color: 0x18204c, emissive: 0x6fe5ea, emissiveIntensity: 0.03, roughness: 0.3, metalness: 0.6, flatShading: true }));
  contract.position.set(HOME.x, 1.6, HOME.z);

  contract.add(new THREE.LineSegments(new THREE.EdgesGeometry(slab), new THREE.LineBasicMaterial({ color: 0x6fe5ea, transparent: true, opacity: 0.8 })));
  scene.add(contract);
  pool(HOME.x, HOME.z, 0x6fe5ea, 7, 0.22);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x6fe5ea, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
  halo.position.set(HOME.x, 2.3, HOME.z - 1);
  halo.scale.set(8, 8, 1);
  scene.add(halo);
  target(contract, `<span class="sim-tip-addr">${X.esc(X.short(X.REPUTATION))}</span><br>The reputation contract, where scores are proposed.<br>Click to open it on the explorer.`,
    `${X.EXPLORER}/address/${X.REPUTATION}`);
  addLabel("<b>Score contract</b>", new THREE.Vector3(HOME.x, 3.42, HOME.z));

  // ---- the machines ----
  const ops = data.ops;
  const reach = ops.length < 2 ? 0 : Math.min(narrow ? 2 : 3.8, (narrow ? 2 : 3.8) * (ops.length - 1));
  const size = ops.length > 4 ? 4 / ops.length : 1;
  const bodyGeo = new THREE.BoxGeometry(BODY.w, BODY.h, BODY.d);
  const bodyEdges = new THREE.EdgesGeometry(bodyGeo);
  const visorGeo = new THREE.BoxGeometry(BODY.w * 0.74, 0.2, 0.03);
  const ledGeo = new THREE.BoxGeometry(0.07, 0.07, 0.03);
  const ventGeo = new THREE.BoxGeometry(BODY.w * 0.74, 0.035, 0.03);
  const capGeo = new THREE.BoxGeometry(BODY.w + 0.1, 0.07, BODY.d + 0.1);
  const linkOf = {};

  ops.forEach((op, i) => {
    const x = ops.length < 2 ? 0 : -reach + (2 * reach * i) / (ops.length - 1);
    const z = 1.3 - Math.abs(x) * 0.12;
    const on = op.status === 2;
    const color = !on ? COLOR.off : COLOR[op.name] ?? COLOR.other;
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.scale.setScalar(size);
    scene.add(group);

    // The bond: one slab a deposit when the deposits add up to it, one slab otherwise.
    const ratio = data.bondAmount > 0n ? Math.min(1.6, Number((op.bond * 1000n) / data.bondAmount) / 1000) : 0;
    const total = PLINTH * ratio;
    const mine = data.deposits.filter((d) => X.same(d.operator, op.address));
    const adds = mine.reduce((sum, d) => sum + d.amount, 0n) === op.bond && mine.length ? mine : null;
    const parts = adds ?? (op.bond > 0n ? [{ amount: op.bond }] : []);
    let y = 0;
    parts.forEach((d, n) => {
      const h = Math.max(0.035, total * (Number((d.amount * 10000n) / op.bond) / 10000));
      const geo = new THREE.BoxGeometry(1.8, h - 0.014, 1.6);
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: new THREE.Color(color).multiplyScalar(n % 2 ? 0.34 : 0.24), emissive: color, emissiveIntensity: on ? 0.05 : 0.01, roughness: 0.4, metalness: 0.5,
      }));
      m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: on ? 0.75 : 0.3 })));
      m.position.y = y + h / 2;
      group.add(m);
      target(m, d.tx
        ? `Deposited <b>${X.esc(X.fmtSvr(d.amount))}</b><br>${X.esc(X.fmtWhen(d.time))}<br>Click to open the transaction.`
        : `Bond <b>${X.esc(X.fmtSvr(op.bond))}</b>`,
      d.tx ? `${X.EXPLORER}/tx/${d.tx}` : null);
      y += h;
    });
    // The bond that makes an operator active, as a line round the slabs.
    const mark = new THREE.Line(new THREE.BufferGeometry().setFromPoints([[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([a, b]) => new THREE.Vector3(a * 0.93, PLINTH, b * 0.83))),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.1, gapSize: 0.07 }));
    mark.computeLineDistances();
    group.add(mark);

    const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({ color: on ? 0x2a315f : 0x23273f, roughness: 0.45, metalness: 0.55 }));
    body.position.y = y + BODY.h / 2;
    body.add(new THREE.LineSegments(bodyEdges, new THREE.LineBasicMaterial({ color, transparent: true, opacity: on ? 0.7 : 0.3 })));
    const cap = new THREE.Mesh(capGeo, new THREE.MeshStandardMaterial({ color: on ? 0x3b4480 : 0x2c304a, roughness: 0.4, metalness: 0.5 }));
    cap.position.y = BODY.h / 2 + 0.035;
    const visor = new THREE.Mesh(visorGeo, new THREE.MeshBasicMaterial({ color: on ? color : 0x343954 }));
    visor.position.set(0, 0.32, BODY.d / 2 + 0.01);
    body.add(cap, visor);
    for (let n = 0; n < 4; n++) {
      const led = new THREE.Mesh(ledGeo, new THREE.MeshBasicMaterial({ color: on ? 0xe9e5ff : 0x343954 }));
      led.position.set(-0.3 + n * 0.2, 0.05, BODY.d / 2 + 0.01);
      body.add(led);
      if (on) blinkers.push({ led, seed: i * 7 + n * 3.1 });
    }
    for (let n = 0; n < 3; n++) {
      const vent = new THREE.Mesh(ventGeo, new THREE.MeshBasicMaterial({ color: 0x151930 }));
      vent.position.set(0, -0.3 - n * 0.1, BODY.d / 2 + 0.01);
      body.add(vent);
    }
    group.add(body);
    if (on) {
      pool(x, z, color, 6 * size, 0.2);
      const lamp = new THREE.PointLight(color, 6, 6);
      lamp.position.set(x, (y + BODY.h + 0.6) * size, z + 1.2);
      scene.add(lamp);
    }

    const top = (y + BODY.h + 0.07) * size;
    const health = op.name ? data.health[op.name] : null;
    const title = op.name ? `${op.name} oracle` : X.short(op.address);
    const el = addLabel(`<b>${X.esc(title)}</b><span>bond ${X.esc(X.fmtSvr(op.bond))}</span><span class="op-next"></span>`, 
      // On a narrow screen the names would run into the lines and each other: they go on the floor in front.
      narrow ? new THREE.Vector3(x, 0, z + 1.25 * size) : new THREE.Vector3(x, top + 0.62, z), `${on ? "" : "off"} ${narrow ? "under" : ""}`);
    const next = el.querySelector(".op-next");
    if (!on) next.textContent = X.BOND_STATUS[op.status] ?? "";
    else if (op.name && !health) next.textContent = "health not read";

    // The epoch ring: empty just after a run, full when the next is due.
    if (on && health && CONFIG.clock) {
      const R = narrow ? 1.12 : 1.32;
      const track = new THREE.Mesh(new THREE.TorusGeometry(R, 0.012, 6, 96).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3 }));
      const arc = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color }));
      const ring = new THREE.Group();
      ring.position.y = y + BODY.h * 0.5;
      // Where the ring starts.
      const from = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.2, 0.035), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      from.position.z = R;
      ring.add(track, arc, from);
      group.add(ring);
      clocks.push({ health, arc, next, color, R, shown: -1, text: "" });
    }

    const tipHtml = () => {
      const lines = [`<span class="sim-tip-addr">${X.esc(X.short(op.address))}</span>${op.name ? ` the ${X.esc(op.name)} oracle` : ""}`,
        `${X.esc(X.BOND_STATUS[op.status] ?? "?")}, bond <b>${X.esc(X.fmtSvr(op.bond))}</b>`,
        `signs with ${op.signer ? X.esc(X.short(op.signer)) : "the operator address itself"}`];
      if (health) {
        lines.push(`runs ${/^[0-9a-f]{40}$/.test(health.commit || "") ? X.esc(health.commit.slice(0, 7)) : "an unknown commit"}${health.epochMs ? `, one epoch every ${minutes(health.epochMs)} min` : ""}`);
        lines.push(health.last ? `last completed ${X.esc(X.fmtWhen(Math.floor(health.last / 1000)))}` : "no epoch completed yet");
      }
      if (op.lastProposal) lines.push(`last proposal ${X.esc(X.fmtWhen(op.lastProposal.at))}`);
      lines.push("Click to open it on the explorer.");
      return lines.join("<br>");
    };
    target(body, tipHtml, `${X.EXPLORER}/address/${op.address}`);

    if (on && op.name && !linkOf[op.name]) linkOf[op.name] = { from: new THREE.Vector3(x - Math.sign(x) * 0.4 * size, top, z), color };
  });

  // ---- what the two named operators do ----
  const dashTex = canvasTexture(64, 8, (g, w, h) => {
    const run = g.createLinearGradient(0, 0, w, 0);
    run.addColorStop(0, "rgba(255,255,255,.12)"); run.addColorStop(0.7, "rgba(255,255,255,1)"); run.addColorStop(0.72, "rgba(255,255,255,.12)"); run.addColorStop(1, "rgba(255,255,255,.12)");
    g.fillStyle = run; g.fillRect(0, 0, w, h);
  });
  function link(name, text, toContract, side) {
    const l = linkOf[name];
    if (!l) return null;
    const end = new THREE.Vector3(HOME.x + side * 0.5, 2.9, HOME.z + 0.5);
    const mid = l.from.clone().lerp(end, 0.5); mid.y += 1.3;
    const curve = toContract ? new THREE.QuadraticBezierCurve3(l.from, mid, end) : new THREE.QuadraticBezierCurve3(end, mid, l.from);
    const map = dashTex.clone();
    map.wrapS = THREE.RepeatWrapping; map.repeat.set(14, 1); map.needsUpdate = true;
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, narrow ? 0.06 : 0.035, 8), new THREE.MeshBasicMaterial({ map, color: l.color, transparent: true, depthWrite: false }));
    scene.add(tube);
    flows.push(map);
    addLabel(text, curve.getPoint(toContract ? 0.42 : 0.58).add(new THREE.Vector3(side * -0.3, -0.5, 0)), "small under");
    return curve;
  }
  link("primary", "proposes scores", true, linkOf.primary && linkOf.checker && linkOf.primary.from.x > linkOf.checker.from.x ? 1 : -1);
  const checks = link("checker", "recomputes each one", false, linkOf.primary && linkOf.checker && linkOf.primary.from.x > linkOf.checker.from.x ? -1 : 1);

  // One marker a disagreement, along the checker's line.
  if (checks) {
    const gem = new THREE.OctahedronGeometry(narrow ? 0.2 : 0.13);
    (data.divergences ?? []).forEach((d, i, all) => {
      const at = checks.getPoint(0.86 - i * Math.min(narrow ? 0.17 : 0.075, 0.5 / all.length));
      const m = new THREE.Mesh(gem, new THREE.MeshStandardMaterial({ color: COLOR.bad, emissive: COLOR.bad, emissiveIntensity: 0.7, roughness: 0.3 }));
      m.position.copy(at);
      scene.add(m);
      bobbers.push({ m, seed: i * 1.7 });
      target(m, `Disagreement, ${X.esc(X.fmtWhen(Math.floor(d.at / 1000)))}<br>proposed <b>${d.pendingTotal}</b>, checker got <b>${d.ownTotal}</b>${d.addr ? `<br>agent <span class="sim-tip-addr">${X.esc(X.short(d.addr))}</span><br>Click to open its score epochs.` : ""}`,
        d.addr ? `epochs?a=${d.addr}` : null);
      m.userData.pick.grow = 1.7;
    });
  }

  let dust = null;
  if (CONFIG.dust) {
    const n = 140, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[i * 3] = (Math.random() - 0.5) * 16; pos[i * 3 + 1] = Math.random() * 6; pos[i * 3 + 2] = (Math.random() - 0.5) * 10 - 1; }
    dust = new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(pos, 3)),
      new THREE.PointsMaterial({ map: glowTex, color: 0xaab4ff, size: 0.09, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
    scene.add(dust);
  }

  const active = ops.filter((o) => o.status === 2).length;
  hud.innerHTML = `<b>${active} active operator${active === 1 ? "" : "s"}</b><span>bond to be active: ${X.esc(X.fmtSvr(data.bondAmount))}</span>`
    + (data.divergenceTotal === null ? "<span>disagreements not read</span>"
      : data.divergenceTotal ? `<span>${data.divergenceTotal} disagreement${data.divergenceTotal === 1 ? "" : "s"} recorded</span>` : "");

  // ---- the clock ----
  function tick() {
    const now = Date.now();
    for (const c of clocks) {
      const { last, epochMs } = c.health;
      let text = "no epoch completed yet", p = 0, late = false;
      if (last && epochMs) {
        const due = last + epochMs - now;
        p = Math.min(1, Math.max(0, (now - last) / epochMs));
        late = due < -epochMs * 0.1;
        text = due > 45000 ? `next run due in ${minutes(due)} min` : due > -45000 ? "next run due now" : `next run was due ${minutes(-due)} min ago`;
      } else if (last) text = `last ran ${X.fmtWhen(Math.floor(last / 1000))}`;
      if (text !== c.text) { c.next.textContent = c.text = text; c.next.classList.toggle("late", late); }
      if (Math.abs(p - c.shown) > 0.002) {
        c.shown = p;
        c.arc.geometry.dispose();
        // From the front of the machine, round to the right.
        c.arc.geometry = new THREE.TorusGeometry(c.R, 0.04, 8, 96, Math.max(0.02, p * Math.PI * 2)).rotateX(Math.PI / 2).rotateY(-Math.PI / 2);
        c.arc.material.color.set(late ? COLOR.late : c.color);
        dirty = true;
      }
    }
  }

  // ---- view ----
  const lean = { x: 0, y: 0, tx: 0, ty: 0 };
  let dist = 14, dirty = true, visible = true, hovered = null, held = null, touch = false;
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const half = Math.tan((camera.fov * Math.PI) / 360);
    // Far enough back for the machines side to side and the contract top to bottom.
    dist = Math.max((reach + (narrow ? 1.35 : 2)) / (half * camera.aspect), 2.95 / half) + 0.6;
    camera.updateProjectionMatrix();
    dirty = true;
  }
  const at = new THREE.Vector3();
  function place(el, point) {
    at.copy(point).project(camera);
    let left = ((at.x + 1) / 2) * host.clientWidth;
    // Kept inside the room, side to side.
    const half = el.offsetWidth / 2 + 6;
    left = Math.min(host.clientWidth - half, Math.max(half, left));
    el.style.left = `${left}px`;
    const top = ((1 - at.y) / 2) * host.clientHeight;
    el.style.top = `${top}px`;
  }
  function draw(t) {
    const drift = CONFIG.sway && !still ? Math.sin(t * 0.17) * 0.9 : 0;
    camera.position.set(drift + lean.x * 1.4, 3.6 - lean.y * 0.6, dist);
    camera.lookAt(0, narrow ? 1.3 : 1.55, -0.4);
    renderer.render(scene, camera);
    for (const l of labels) place(l.el, l.at);
    // What is pointed at is read at the foot of the room, where it covers nothing, and swells a little.
    const shown = hovered ?? held;
    tip.classList.toggle("u-hidden", !shown);
    for (const m of targets) {
      const p = m.userData.pick, lit = m === shown;
      m.scale.setScalar(lit ? p.grow : 1);
      // Its own glow, or none where the material had no glow to begin with.
      if (p.glow === undefined) {
        const dark = m.material.emissive.getHex() === 0;
        p.glow = dark ? 0 : m.material.emissiveIntensity;
        if (dark) m.material.emissive.set(0x6fe5ea);
      }
      m.material.emissiveIntensity = lit ? Math.max(0.3, p.glow * 2.5) : p.glow;
    }
  }

  // ---- pointer ----
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(ev) {
    const box = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - box.left) / box.width) * 2 - 1, -((ev.clientY - box.top) / box.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(targets, false)[0]?.object ?? null;
  }
  function show(mesh) {
    if (!mesh) return;
    const p = mesh.userData.pick;
    tip.innerHTML = typeof p.tip === "function" ? p.tip() : p.tip;
  }
  canvas.addEventListener("pointermove", (ev) => {
    const box = canvas.getBoundingClientRect();
    if (CONFIG.parallax) { lean.tx = ((ev.clientX - box.left) / box.width) * 2 - 1; lean.ty = ((ev.clientY - box.top) / box.height) * 2 - 1; }
    if (ev.pointerType === "mouse") {
      const m = pick(ev);
      if (m !== hovered) { hovered = m; show(m ?? held); canvas.classList.toggle("pick", Boolean(m?.userData.pick.href)); }
    }
    dirty = true;
  });
  canvas.addEventListener("pointerleave", () => { lean.tx = lean.ty = 0; hovered = null; show(held); canvas.classList.remove("pick"); dirty = true; });
  canvas.addEventListener("pointerdown", (ev) => { touch = ev.pointerType !== "mouse"; });
  canvas.addEventListener("click", (ev) => {
    const m = pick(ev);
    dirty = true;
    // A finger has no hover: the first tap names the thing, a second tap on it opens it.
    if (touch && m !== held) { held = m; show(m); return; }
    const href = m?.userData.pick.href;
    if (!href) { held = null; return; }
    if (href.startsWith("http")) window.open(href, "_blank", "noopener");
    else window.location.href = href;
  });

  // ---- frame ----
  let last = null, clockAt = 0;
  function frame(ms) {
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
      if (CONFIG.flow) for (const map of flows) map.offset.x -= dt * 0.9;
      if (CONFIG.blink) for (const b of blinkers) b.led.material.color.setScalar(Math.sin(t * (1.3 + (b.seed % 5) * 0.5) + b.seed) > 0.2 ? 1 : 0.25);
      for (const b of bobbers) b.m.rotation.y = t * 0.8 + b.seed;
      if (dust) dust.rotation.y = t * 0.012;
    }
    dirty = false;
    draw(t);
  }

  host.classList.add("ready");
  resize();
  tick();
  new ResizeObserver(resize).observe(host);
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(host);
  requestAnimationFrame(frame);
  return true;
}

function begin() {
  const host = document.getElementById("opScene"), data = window.SigvaraOperatorsData;
  if (!host || !data || host.classList.contains("ready")) return;
  // Shown first, so the room can be measured; hidden again if there is nothing to draw with.
  const card = document.getElementById("opSceneCard");
  card.classList.remove("u-hidden");
  if (!start(host, data)) card.classList.add("u-hidden");
}
document.addEventListener("sigvara-operators-data", begin);
begin();
