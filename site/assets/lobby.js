"use strict";
// The lobby on the Agents page. Decoration, kept from saying anything it should not: a look and a
// nickname come only from the address, a mood only from the status on chain, and a prop only from
// how the agent is labelled. No score reaches this file, so a friendly face cannot read as a good one.
//
// The drawings are plain SVG with presentation attributes, since the site's Content-Security-Policy
// refuses style attributes. Animation is by the classes in lobby.css.
(function (root) {
  const ADJECTIVES = ("Mossy Velvet Copper Lunar Pocket Tidal Paper Amber Cobalt Pepper Thimble Tawny Marble Juniper Static Biscuit "
    + "Saffron Walnut Indigo Clover Harbor Ember Pewter Quartz Willow Tangerine Basil Coral Flannel Gravel Hazel Ivory "
    + "Jasper Kelp Lilac Maple Nutmeg Olive Pebble Quince Russet Sable Thistle Umber Violet Wicker Yarrow Zinc "
    + "Alder Birch Cedar Dune Fennel Ginger Heather Inky Jade Kettle Linen Mica Nickel Onyx Plum Rye").split(" ");
  const NOUNS = ("Otter Kettle Lantern Moth Pigeon Walnut Teapot Badger Comet Radish Spanner Newt Pretzel Gecko Button Anchor "
    + "Acorn Beetle Candle Dumpling Earwig Falcon Gopher Heron Iguana Jackdaw Kiwi Lemur Marmot Nautilus Owl Puffin "
    + "Quokka Robin Salmon Thimble Urchin Vole Wombat Yak Zebra Abacus Barnacle Compass Doorknob Eggcup Funnel Gizmo "
    + "Hinge Inkwell Jigsaw Kazoo Ladle Muffin Nozzle Oyster Pickle Quill Ratchet Saucer Trowel Ukulele Whistle Yoyo").split(" ");
  const COLOURS = ["#9b7cff", "#6fe5ea", "#a3f1c6", "#ffbf7a", "#f5a3c7", "#8fb4ff", "#e6d36f", "#ff9d85"];
  const INK = "#15182b";
  const ASLEEP_COLOUR = "#6d7691";

  const byteOf = (address, i) => parseInt(String(address).slice(2 + i * 2, 4 + i * 2), 16);

  // A name to tell agents apart by, made from the address. Two agents can share one, so the address
  // stays the identity.
  function nickname(address) {
    return `${ADJECTIVES[byteOf(address, 6) & 63]} ${NOUNS[byteOf(address, 7) & 63]}`;
  }

  const BODIES = [
    '<rect x="17" y="20" width="30" height="30" rx="9"/>',
    '<circle cx="32" cy="35" r="16"/>',
    '<rect x="20" y="17" width="24" height="33" rx="12"/>',
    '<rect x="13" y="24" width="38" height="26" rx="13"/>',
    '<path d="M17 50V34a15 15 0 0 1 30 0v16z"/>',
    '<path d="M32 18l15 9v15l-15 9-15-9V27z"/>',
  ];
  const tops = (c) => [
    `<path d="M32 21V11" stroke="${c}" stroke-width="2"/><circle cx="32" cy="9" r="2.8" fill="${c}"/>`,
    `<path d="M26 22l-5-11M38 22l5-11" stroke="${c}" stroke-width="2"/><circle cx="21" cy="10" r="2.5" fill="${c}"/><circle cx="43" cy="10" r="2.5" fill="${c}"/>`,
    `<path d="M20 25l-2-13 10 7zM44 25l2-13-10 7z" fill="${c}"/>`,
    `<path d="M28 21l-2-7M32 20v-8M36 21l2-7" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`,
    `<path d="M32 21v-8" stroke="${c}" stroke-width="2"/><ellipse cx="32" cy="12" rx="10" ry="2" fill="${c}"/>`,
    `<path d="M23 23q-6-4-5-12q5 3 9 9zM41 23q6-4 5-12q-5 3-9 9z" fill="${c}"/>`,
    "",
  ];
  const MARKINGS = [
    "",
    '<ellipse cx="32" cy="44" rx="8" ry="4" fill="#fff" opacity=".22"/>',
    '<rect x="24" y="43" width="16" height="2" fill="#fff" opacity=".25"/><rect x="24" y="47" width="16" height="1.5" fill="#fff" opacity=".2"/>',
    '<circle cx="25" cy="44" r="1.5" fill="#fff" opacity=".3"/><circle cx="32" cy="46" r="1.5" fill="#fff" opacity=".3"/><circle cx="39" cy="44" r="1.5" fill="#fff" opacity=".3"/>',
  ];
  const feet = (c) => [
    `<rect x="23" y="49" width="5" height="8" rx="2" fill="${c}"/><rect x="36" y="49" width="5" height="8" rx="2" fill="${c}"/>`,
    `<circle cx="25" cy="54" r="4" fill="${INK}" stroke="${c}" stroke-width="2"/><circle cx="39" cy="54" r="4" fill="${INK}" stroke="${c}" stroke-width="2"/>`,
    `<ellipse cx="32" cy="57" rx="11" ry="1.8" fill="${c}" opacity=".5"/>`,
  ];
  const eyes = (dots) => [
    `<circle cx="26" cy="33" r="2.8" fill="${dots}"/><circle cx="38" cy="33" r="2.8" fill="${dots}"/>`,
    `<circle cx="25" cy="33" r="5" fill="#fff"/><circle cx="39" cy="33" r="5" fill="#fff"/><circle cx="26" cy="33" r="2.4" fill="${INK}"/><circle cx="40" cy="33" r="2.4" fill="${INK}"/>`,
    `<rect x="19" y="29" width="26" height="8" rx="4" fill="${INK}"/><circle cx="26" cy="33" r="1.8" fill="#6fe5ea"/><circle cx="38" cy="33" r="1.8" fill="#6fe5ea"/>`,
    `<circle cx="32" cy="33" r="7" fill="#fff"/><circle cx="33" cy="33" r="3.2" fill="${INK}"/>`,
    `<circle cx="25" cy="33" r="5" fill="#fff"/><circle cx="39" cy="34" r="3.2" fill="#fff"/><circle cx="26" cy="33" r="2.4" fill="${INK}"/><circle cx="39" cy="34" r="1.6" fill="${INK}"/>`,
  ];
  const MOUTHS = [
    `<path d="M28 43h8" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`,
    `<circle cx="32" cy="43" r="2" fill="${INK}"/>`,
    `<rect x="27" y="41" width="10" height="4" rx="1" fill="#fff" stroke="${INK}"/>`,
    `<path d="M28 42q4 3 8 0" stroke="${INK}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
  ];
  const PROPS = {
    steady: '<rect x="48" y="43" width="12" height="9" rx="1.5" fill="#ffbf7a"/><path d="M51 43v-2.5h6V43" stroke="#ffbf7a" stroke-width="1.5" fill="none"/>',
    mediocre: '<path d="M49 39h10l-1.5 13h-7z" fill="#c4cbe0"/><path d="M52 36q1-2 0-4M56 36q1-2 0-4" stroke="#c4cbe0" fill="none"/>',
    failing: '<circle class="ag-smoke" cx="46" cy="16" r="3" fill="#9ca5bf"/><circle class="ag-smoke ag-d2" cx="50" cy="12" r="2.2" fill="#9ca5bf"/><circle class="ag-smoke ag-d4" cx="43" cy="11" r="1.8" fill="#9ca5bf"/>',
    outside: '<rect x="47" y="41" width="14" height="11" rx="2" fill="#a3f1c6"/><path d="M51 41v-3h6v3M47 46h14" stroke="#0f1221" stroke-width="1" fill="none"/>',
    demo: '<path d="M50 34V12" stroke="#c4cbe0" stroke-width="1.5"/><path d="M50 12l11 4-11 4z" fill="#6fe5ea"/>',
  };
  const HARD_HAT = '<path d="M17 24a15 13 0 0 1 30 0z" fill="#ffbf7a"/><rect x="14" y="23" width="36" height="3" rx="1.5" fill="#ffbf7a"/>';
  const SYBIL_HOOP = '<ellipse cx="32" cy="40" rx="26" ry="7" fill="none" stroke="#ff8585" stroke-width="2.5"/>';
  const SYBIL_MASK = '<rect x="18" y="27" width="28" height="12" rx="6" fill="#20243d"/>';
  const SIMULATED_RING = '<ellipse cx="32" cy="59.5" rx="19" ry="3.6" fill="none" stroke="#9ca5bf" stroke-width="1.2" stroke-dasharray="3 2.5"/>';

  // One agent's drawing, for a viewBox of 0 0 64 64. `mood` is "awake", "asleep" or "ghost".
  function drawing({ address, kind, simulated = false, mood = "awake" }) {
    const b = (i) => byteOf(address, i);
    const ring = simulated ? SIMULATED_RING : "";
    if (mood === "ghost") {
      return `${ring}<g class="ag-bob"><path d="M16 56V30a16 16 0 0 1 32 0v26l-5.3-5-5.4 5-5.3-5-5.3 5-5.4-5z" fill="#cfd5ea" opacity=".6"/>`
        + `<path d="M23 27l6 6m0-6l-6 6M35 27l6 6m0-6l-6 6" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/><circle cx="32" cy="41" r="2.5" fill="${INK}"/></g>`;
    }
    const asleep = mood === "asleep";
    const c = asleep ? ASLEEP_COLOUR : COLOURS[b(0) % COLOURS.length];
    const sybil = kind === "ring";
    const delay = `ag-d${b(9) % 8}`;
    const top = kind === "drill" ? HARD_HAT : tops(c)[b(2) % 7];
    const face = asleep
      ? `<path d="M22 33q4 3 8 0M34 33q4 3 8 0" stroke="${INK}" stroke-width="2" fill="none" stroke-linecap="round"/>`
      : `<g class="ag-blink ${delay}">${eyes(sybil ? "#fff" : INK)[b(5) % 5]}</g>`;
    const snore = asleep ? '<text x="48" y="17" font-size="12" fill="#c4cbe0">z</text><text x="54" y="9" font-size="9" fill="#c4cbe0">z</text>' : "";
    return `${ring}<g class="${asleep ? "" : `ag-bob ${delay}`}">${top}${feet(c)[b(4) % 3]}<g fill="${c}">${BODIES[b(1) % 6]}</g>${MARKINGS[b(3) % 4]}`
      + `${sybil ? SYBIL_MASK : ""}${face}${MOUTHS[b(8) % 4]}${sybil ? SYBIL_HOOP : ""}${PROPS[kind] ?? ""}${snore}</g>`;
  }

  const svg = (agent, size) => `<svg class="ag-char" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">${drawing(agent)}</svg>`;

  // Sets the people loose in a room inside `host`. Each is { address, kind, simulated, mood, waiting }:
  // a ghost floats by the ceiling, a sleeper sits on the bench, an agent still awaiting its bond waits at
  // the door, the Sybil ring goes around together, an agent from outside stays near the door, and the rest
  // wander. `onPick(person)` runs on a click. Where someone stands means nothing, so the start comes from the
  // address and the wandering from Math.random.
  function startLobby(host, people, onPick) {
    const wide = host.clientWidth >= 560;
    const W = wide ? 860 : 400;
    const H = wide ? 340 : 300;
    const SIZE = wide ? 56 : 46;
    const FEET = SIZE * 0.89; // how far down a drawing its feet are, to stand it on something
    const FLOOR = 110;
    const BENCH = W - 116;
    host.innerHTML = `<svg class="ag-room" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      <rect width="${W}" height="${H}" fill="#121629"/><rect width="${W}" height="${FLOOR - 6}" fill="#0f1221"/>
      <rect x="16" y="26" width="52" height="78" rx="3" fill="#181c31" stroke="#2a2f4c"/><circle cx="58" cy="68" r="2" fill="#9ca5bf"/>
      <text x="42" y="20" font-size="11" fill="#9ca5bf" text-anchor="middle">Way in</text>
      <rect x="${BENCH}" y="88" width="96" height="7" rx="2" fill="#2a2f4c"/><rect x="${BENCH + 8}" y="95" width="5" height="10" fill="#2a2f4c"/><rect x="${BENCH + 83}" y="95" width="5" height="10" fill="#2a2f4c"/>
      <text x="${BENCH + 48}" y="24" font-size="11" fill="#9ca5bf" text-anchor="middle">Suspended bench</text>
      <g class="ag-people"></g><text class="ag-tag" font-size="12" fill="#f5f7ff" text-anchor="middle"></text></svg>`;
    const group = host.querySelector(".ag-people");
    const tag = host.querySelector(".ag-tag");
    const span = (from, to) => from + Math.random() * (to - from);
    const counts = { asleep: 0, ghost: 0, ring: 0 };
    const rings = people.filter((p) => p.kind === "ring" && p.mood === "awake").length;
    let picked = null;

    const walkers = people.map((person) => {
      const a = person.address;
      const near = person.kind === "outside";
      const x = near ? 78 + byteOf(a, 10) % 110 : 80 + (byteOf(a, 10) * 256 + byteOf(a, 11)) % (W - SIZE - 90);
      const y = FLOOR + (byteOf(a, 12) * 256 + byteOf(a, 13)) % (H - SIZE - FLOOR - 6);
      const w = { person, x, y, tx: x, ty: y, pause: span(0, 3), near, how: "walk", slot: 0 };
      if (person.mood === "ghost") { w.how = "float"; w.slot = counts.ghost++; }
      else if (person.mood === "asleep") { w.how = "sit"; w.x = BENCH + 2 + (counts.asleep++ % 3) * SIZE * 0.65; w.y = 88 - FEET; }
      else if (person.waiting) { w.how = "sit"; w.x = 42 - SIZE / 2; w.y = 104 - FEET; }
      else if (person.kind === "ring") { w.how = "ring"; w.slot = counts.ring++; }
      const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      el.setAttribute("class", "ag-walker");
      el.setAttribute("width", SIZE);
      el.setAttribute("height", SIZE);
      el.setAttribute("viewBox", "0 0 64 64");
      el.innerHTML = `<title>${nickname(a)}</title>${drawing(person)}`;
      el.addEventListener("click", () => { picked = w; onPick(person); place(w); });
      group.appendChild(el);
      w.el = el;
      return w;
    });

    let hoopX = W / 2;
    let hoopY = (FLOOR + H) / 2;
    let hoopToX = hoopX;
    let hoopToY = hoopY;
    const step = (from, to, by) => (Math.abs(to - from) <= by ? to : from + Math.sign(to - from) * by);

    function place(w) {
      w.el.setAttribute("x", w.x);
      w.el.setAttribute("y", w.y);
      if (w === picked) {
        tag.setAttribute("x", w.x + SIZE / 2);
        tag.setAttribute("y", Math.max(13, w.y - 4));
        tag.textContent = nickname(w.person.address);
      }
    }

    function move(t, dt) {
      const walk = 0.025 * dt;
      if (Math.hypot(hoopToX - hoopX, hoopToY - hoopY) < 2) {
        hoopToX = span(120, W - 120);
        hoopToY = span(FLOOR + SIZE, H - SIZE);
      }
      hoopX = step(hoopX, hoopToX, walk * 0.6);
      hoopY = step(hoopY, hoopToY, walk * 0.6);
      for (const w of walkers) {
        if (w.how === "float") {
          w.x = W / 2 - SIZE / 2 + W * 0.2 * Math.sin(t / 8000 + w.slot * 1.9);
          w.y = 16 + 6 * Math.sin(t / 1300 + w.slot);
        } else if (w.how === "ring") {
          const angle = t / 2600 + (w.slot * 2 * Math.PI) / Math.max(1, rings);
          w.x = hoopX + SIZE * 0.7 * Math.cos(angle) - SIZE / 2;
          w.y = hoopY + SIZE * 0.33 * Math.sin(angle) - SIZE / 2;
        } else if (w.how === "walk") {
          const far = Math.hypot(w.tx - w.x, w.ty - w.y);
          if (far < 2) {
            w.pause -= dt / 1000;
            if (w.pause <= 0) {
              w.tx = w.near ? span(78, 200) : span(10, W - SIZE - 10);
              w.ty = span(FLOOR, H - SIZE - 6);
              w.pause = span(1, 4.5);
            }
          } else {
            w.x += ((w.tx - w.x) / far) * walk;
            w.y += ((w.ty - w.y) / far) * walk;
          }
        }
        place(w);
      }
    }

    move(0, 0);
    if (root.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let visible = true;
    let last = null;
    let frame = 0;
    const tick = (t) => {
      frame = 0;
      if (!visible) { last = null; return; }
      move(t, last === null ? 0 : Math.min(50, t - last));
      last = t;
      frame = requestAnimationFrame(tick);
    };
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !frame) frame = requestAnimationFrame(tick);
    }).observe(host);
    frame = requestAnimationFrame(tick);
  }

  const api = { ADJECTIVES, NOUNS, nickname, drawing, svg, startLobby };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SigvaraLobby = api;
})(typeof window !== "undefined" ? window : globalThis);
