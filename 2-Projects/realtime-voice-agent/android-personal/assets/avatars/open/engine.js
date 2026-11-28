/*!
 * NightAvatars Engine: open-bot-avatar (offline classic script bundle)
 * Upstream: open-bot-avatar@0.5.2 (https://github.com/DominikScholz/open-bot-avatar.git)
 * Commit:   e10afe49d46da8ffcc6545f5d6e8ba1de4ea8c5d
 * License:  MIT — Copyright (c) 2026 Dominik Scholz
 */
(function(global) {
  "use strict";
  var __modules = {
    "animator.ts": function(__req2, exports) {
      const { REST, followGaze, followStep } = __req2("follow.ts");
      const { lookOf, stateDefinition, stateId } = __req2("motion.ts");
      const { moodProgress, settleMood } = __req2("mood.ts");
      function createAnimator() {
        let follow = REST;
        let last = null;
        let shown = null;
        return {
          step({ now, target, hold = false, reducedMotion, ...given }) {
            const dt = last === null ? 0 : (now - last) / 1e3;
            last = now;
            let moving = false;
            if (!hold) ({ state: follow, moving } = followStep(follow, target, dt, reducedMotion));
            const { state, mood } = lookOf(given);
            const same = shown !== null && stateId(state) === stateId(shown.state);
            if (shown && same) shown.state = state;
            if (shown && (!same || mood !== shown.mood)) {
              const before = {
                state: shown.state,
                mood: shown.mood,
                age: (now - shown.began) / 1e3,
                blend: shown.blend && {
                  from: shown.blend.from,
                  t: moodProgress(now - shown.since)
                }
              };
              shown = {
                state,
                mood,
                blend: reducedMotion ? void 0 : {
                  from: settleMood(before),
                  t: 0
                },
                since: now,
                began: same ? shown.began : now
              };
            }
            const startAge = stateDefinition(state).startAge;
            shown ?? (shown = {
              state,
              mood,
              since: now,
              began: now - (Number.isFinite(startAge) ? Math.max(0, startAge) : 0) * 1e3
            });
            const t = reducedMotion ? 1 : moodProgress(now - shown.since);
            let motionBlend;
            if (shown.blend && t < 1) motionBlend = {
              from: shown.blend.from,
              t
            };
            else shown.blend = void 0;
            return {
              gaze: followGaze(follow),
              motionBlend,
              stateAge: (now - shown.began) / 1e3,
              moving: moving || motionBlend !== void 0
            };
          },
          reset() {
            follow = REST;
            last = null;
            shown = null;
          }
        };
      }
      exports.createAnimator = createAnimator;
    },
    "color.ts": function(__req2, exports) {
      function parseHex(input) {
        if (typeof input !== "string") return null;
        const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
        if (!m) return null;
        let h = m[1];
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        return [
          parseInt(h.slice(0, 2), 16),
          parseInt(h.slice(2, 4), 16),
          parseInt(h.slice(4, 6), 16)
        ];
      }
      function toHex([r, g, b]) {
        const c = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
        return `#${c(r)}${c(g)}${c(b)}`;
      }
      function mix(a, b, t) {
        return [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t
        ];
      }
      function shade(c, t) {
        const max = Math.max(...c);
        const deep = [
          c[0] * 0.35 - (max - c[0]) * 0.1,
          c[1] * 0.35 - (max - c[1]) * 0.1,
          c[2] * 0.35 - (max - c[2]) * 0.1
        ];
        return mix(c, deep, t);
      }
      function tint(c, t) {
        return mix(c, [
          255,
          255,
          255
        ], t);
      }
      function luminance([r, g, b]) {
        const ch = (v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
      }
      function contrast(a, b) {
        const la = luminance(a), lb = luminance(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      }
      const DARK_INK = [
        20,
        22,
        34
      ];
      const LIGHT_INK = [
        250,
        250,
        255
      ];
      function autoEyeColor(body) {
        return contrast(body, DARK_INK) >= contrast(body, LIGHT_INK) ? DARK_INK : LIGHT_INK;
      }
      const toLinear = (v) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const fromLinear = (v) => 255 * (v <= 31308e-7 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
      function toOklch(c) {
        const [r, g, b] = c.map(toLinear);
        const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
        const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
        const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
        const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
        const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
        const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
        const h = Math.atan2(B, A) * 180 / Math.PI;
        return [
          L,
          Math.hypot(A, B),
          h < 0 ? h + 360 : h
        ];
      }
      function oklchLinear(L, C, h) {
        const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
        const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
        const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
        const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
        return [
          4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
          -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
          -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
        ];
      }
      function oklch(L, C, h) {
        const fits = (c) => oklchLinear(L, c, h).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
        let lo = 0, hi = C;
        if (!fits(hi)) {
          for (let i = 0; i < 20; i++) {
            const mid = (lo + hi) / 2;
            if (fits(mid)) lo = mid;
            else hi = mid;
          }
          hi = lo;
        }
        return oklchLinear(L, hi, h).map(fromLinear);
      }
      exports.parseHex = parseHex;
      exports.toHex = toHex;
      exports.mix = mix;
      exports.shade = shade;
      exports.tint = tint;
      exports.luminance = luminance;
      exports.contrast = contrast;
      exports.DARK_INK = DARK_INK;
      exports.LIGHT_INK = LIGHT_INK;
      exports.autoEyeColor = autoEyeColor;
      exports.toOklch = toOklch;
      exports.oklch = oklch;
    },
    "contour.ts": function(__req2, exports) {
      const RUN = 8;
      const runsOf = (nx) => Math.ceil((nx - 1) / RUN);
      function runRange(values, nx, ny) {
        const runs = runsOf(nx);
        const lo = new Float64Array(runs * ny), hi = new Float64Array(runs * ny);
        for (let j = 0; j < ny; j++) {
          for (let r = 0; r < runs; r++) {
            let a = Infinity, b = -Infinity;
            for (let k = j * nx + r * RUN, end = j * nx + Math.min(nx - 1, (r + 1) * RUN); k <= end; k++) {
              const v = values[k];
              if (v < a) a = v;
              if (v > b) b = v;
            }
            lo[j * runs + r] = a;
            hi[j * runs + r] = b;
          }
        }
        const min = new Float64Array(runs * Math.max(0, ny - 1)), max = new Float64Array(min.length);
        for (let k = 0; k < min.length; k++) {
          min[k] = Math.min(lo[k], lo[k + runs]);
          max[k] = Math.max(hi[k], hi[k + runs]);
        }
        return {
          min,
          max
        };
      }
      let linkA = new Int32Array(0), linkB = new Int32Array(0);
      let passed = new Uint8Array(0);
      let order = new Int32Array(256);
      let traced = new Float64Array(1024);
      let ends = new Int32Array(16);
      function trace(field, level, flat) {
        const { values, nx, ny, x0, y0, step } = field;
        if (linkA.length < 2 * nx * ny) {
          linkA = new Int32Array(2 * nx * ny).fill(-1);
          linkB = new Int32Array(2 * nx * ny).fill(-1);
          passed = new Uint8Array(2 * nx * ny);
        }
        const a = linkA, b = linkB;
        let count = 0;
        const join = (p, q) => {
          if (a[p] < 0) {
            if (count === order.length) {
              const grown = new Int32Array(2 * count);
              grown.set(order);
              order = grown;
            }
            order[count++] = p;
            a[p] = q;
          } else b[p] = q;
        };
        const link = (p, q) => {
          join(p, q);
          join(q, p);
        };
        const runs = runsOf(nx);
        for (let j = 0; j < ny - 1; j++) {
          const row = j * nx;
          for (let r = 0; r < runs; r++) {
            if (flat && flat[j * runs + r]) continue;
            let i = r * RUN;
            const end = Math.min(nx - 1, i + RUN);
            let tl = values[row + i] - level >= 0, bl = values[row + nx + i] - level >= 0;
            for (; i < end; i++) {
              const tr = values[row + i + 1] - level >= 0, br = values[row + nx + i + 1] - level >= 0;
              if (tl !== tr || tr !== br || br !== bl) {
                const top = 2 * (row + i), bottom = 2 * (row + nx + i), left = top + 1, right = top + 3;
                if (tl === br && tr === bl) {
                  const center = (values[row + i] - level + (values[row + i + 1] - level) + (values[row + nx + i + 1] - level) + (values[row + nx + i] - level)) / 4 >= 0;
                  if (tl === center) {
                    link(top, right);
                    link(bottom, left);
                  } else {
                    link(left, top);
                    link(right, bottom);
                  }
                } else if (tl !== tr) link(top, tr !== br ? right : br !== bl ? bottom : left);
                else if (tr !== br) link(right, br !== bl ? bottom : left);
                else link(bottom, left);
              }
              tl = tr;
              bl = br;
            }
          }
        }
        if (traced.length < 2 * count) traced = new Float64Array(4 * count);
        const xy = traced;
        let n = 0, loops = 0;
        for (let k = 0; k < count; k++) {
          if (passed[order[k]]) continue;
          let prev = -1, cur = order[k];
          while (!passed[cur]) {
            passed[cur] = 1;
            const idx = cur >> 1, i = idx % nx, j = (idx - i) / nx;
            const v = values[idx] - level;
            if (cur & 1) {
              const t = v / (v - (values[idx + nx] - level));
              xy[n++] = x0 + i * step;
              xy[n++] = y0 + (j + t) * step;
            } else {
              const t = v / (v - (values[idx + 1] - level));
              xy[n++] = x0 + (i + t) * step;
              xy[n++] = y0 + j * step;
            }
            let next = a[cur];
            if (next === prev || passed[next]) {
              next = b[cur];
              if (next < 0 || next === prev || passed[next]) break;
            }
            prev = cur;
            cur = next;
          }
          if (loops === ends.length) {
            const grown = new Int32Array(2 * loops);
            grown.set(ends);
            ends = grown;
          }
          ends[loops++] = n;
        }
        for (let k = 0; k < count; k++) {
          a[order[k]] = b[order[k]] = -1;
          passed[order[k]] = 0;
        }
        return loops;
      }
      function pointsOf(xy, start, end, keep) {
        const loop = [];
        for (let k = start; k < end; k += 2) if (!keep || keep[k - start >> 1]) loop.push([
          xy[k],
          xy[k + 1]
        ]);
        return loop;
      }
      function contourLoops(field, level, flat) {
        const loops = [];
        for (let k = 0, n = trace(field, level, flat), start = 0; k < n; start = ends[k++]) {
          if (ends[k] - start >= 6) loops.push(pointsOf(traced, start, ends[k]));
        }
        return loops;
      }
      function contourOutlines(field, level, tolerance, flat) {
        const loops = [];
        for (let k = 0, n = trace(field, level, flat), start = 0; k < n; start = ends[k++]) {
          const points = ends[k] - start >> 1;
          if (points < 3) continue;
          if (points <= 8) {
            loops.push(pointsOf(traced, start, ends[k]));
            continue;
          }
          const keep = simplify(traced, start, points, tolerance);
          let kept2 = 0;
          for (let q = 0; q < points; q++) kept2 += keep[q];
          if (kept2 >= 3) loops.push(pointsOf(traced, start, ends[k], keep));
        }
        return loops;
      }
      const CLEAR = 1e-9;
      let kept = new Uint8Array(256);
      let chains = new Int32Array(64);
      function simplify(xy, start, n, tolerance) {
        if (kept.length < n) kept = new Uint8Array(2 * n);
        const keep = kept.fill(0, 0, n);
        const x0 = xy[start], y0 = xy[start + 1];
        let far = 0, top = -1, next = -1;
        for (let k = 1; k < n; k++) {
          const dx = xy[start + 2 * k] - x0, dy = xy[start + 2 * k + 1] - y0, d = dx * dx + dy * dy;
          if (d > top) {
            next = top;
            top = d;
            far = k;
          } else if (d > next) next = d;
        }
        if (next >= top * (1 - CLEAR)) {
          let best = -1;
          far = 0;
          for (let k = 1; k < n; k++) {
            const d = Math.hypot(xy[start + 2 * k] - x0, xy[start + 2 * k + 1] - y0);
            if (d > best) {
              best = d;
              far = k;
            }
          }
        }
        keep[0] = keep[far] = 1;
        let open = 0;
        chains[open++] = 0;
        chains[open++] = far;
        chains[open++] = far;
        chains[open++] = n;
        while (open) {
          const e = chains[--open], s = chains[--open];
          const ax = xy[start + 2 * s], ay = xy[start + 2 * s + 1];
          const dx = xy[start + 2 * (e % n)] - ax, dy = xy[start + 2 * (e % n) + 1] - ay;
          let idx = -1, lead = -1, second = -1;
          for (let k = s + 1; k < e; k++) {
            const d = Math.abs(dx * (ay - xy[start + 2 * k + 1]) - dy * (ax - xy[start + 2 * k]));
            if (d > lead) {
              second = lead;
              lead = d;
              idx = k;
            } else if (d > second) second = d;
          }
          const bar = tolerance * Math.sqrt(dx * dx + dy * dy);
          if (lead <= bar * (1 - CLEAR) && bar > 0) idx = -1;
          else if (!(lead > bar * (1 + CLEAR) && second < lead * (1 - CLEAR))) {
            const len = Math.hypot(dx, dy);
            let max = tolerance;
            idx = -1;
            for (let k = s + 1; k < e; k++) {
              const px = xy[start + 2 * k], py = xy[start + 2 * k + 1];
              const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dx * (ay - py) - dy * (ax - px)) / len;
              if (d > max) {
                max = d;
                idx = k;
              }
            }
          }
          if (idx >= 0) {
            keep[idx] = 1;
            if (open + 4 > chains.length) {
              const grown = new Int32Array(2 * chains.length);
              grown.set(chains);
              chains = grown;
            }
            chains[open++] = s;
            chains[open++] = idx;
            chains[open++] = idx;
            chains[open++] = e;
          }
        }
        return keep;
      }
      function simplifyLoop(loop, tolerance) {
        if (loop.length <= 8) return loop;
        const xy = new Float64Array(2 * loop.length);
        for (let k = 0; k < loop.length; k++) {
          xy[2 * k] = loop[k][0];
          xy[2 * k + 1] = loop[k][1];
        }
        const keep = simplify(xy, 0, loop.length, tolerance);
        return loop.filter((_, k) => keep[k]);
      }
      function simplifiedLoop(xy, n, tolerance) {
        return n <= 8 ? pointsOf(xy, 0, 2 * n) : pointsOf(xy, 0, 2 * n, simplify(xy, 0, n, tolerance));
      }
      const UNIT = 100;
      const write = (k) => {
        const a = Math.abs(k), whole = Math.floor(a / UNIT), frac = a % UNIT;
        const f = frac === 0 ? "" : frac % 10 === 0 ? `.${frac / 10}` : frac < 10 ? `.0${frac}` : `.${frac}`;
        return (k < 0 ? "-" : "") + (whole || !f ? whole : "") + f;
      };
      const NEAR = 4096;
      const written = new Array(2 * NEAR + 1);
      const num = (k) => {
        var _a;
        return Number.isInteger(k) && k >= -NEAR && k <= NEAR ? written[_a = k + NEAR] ?? (written[_a] = write(k)) : write(k);
      };
      const CORNER = 0.6;
      const SAG = 0.1;
      const TAN_CORNER = Math.tan(CORNER);
      let snapped = new Float64Array(512);
      let corners = new Uint8Array(256);
      function loopsToPath(loops) {
        let d = "", cmd = "", last = "";
        const emit = (c, x, y) => {
          if (c !== cmd) {
            d += c;
            cmd = c;
            last = "";
          }
          for (let k = 0; k < 2; k++) {
            const t = num(k ? y : x);
            if (last && t[0] !== "-" && !(t[0] === "." && last.includes("."))) d += " ";
            d += t;
            last = t;
          }
        };
        for (const loop of loops) {
          const n = loop.length;
          if (snapped.length < 2 * n) {
            snapped = new Float64Array(4 * n);
            corners = new Uint8Array(2 * n);
          }
          const v = snapped, corner = corners;
          for (let k = 0; k < n; k++) {
            const p = loop[k], a = loop[(k + n - 1) % n], b = loop[(k + 1) % n];
            v[2 * k] = 2 * Math.round(p[0] * UNIT / 2);
            v[2 * k + 1] = 2 * Math.round(p[1] * UNIT / 2);
            const cross = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
            const dot = (p[0] - a[0]) * (b[0] - p[0]) + (p[1] - a[1]) * (b[1] - p[1]);
            const turn = Math.abs(cross), steep = dot * TAN_CORNER;
            if (dot > 0 ? turn > steep * (1 + CLEAR) || turn >= steep * (1 - CLEAR) && Math.abs(Math.atan2(cross, dot)) > CORNER : Math.abs(Math.atan2(cross, dot)) > CORNER) {
              corner[k] = 1;
              continue;
            }
            const chord = (4 * SAG) ** 2 * ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
            corner[k] = turn * turn > chord * (1 + CLEAR) || turn * turn >= chord * (1 - CLEAR) && turn > 4 * SAG * Math.hypot(b[0] - a[0], b[1] - a[1]) ? 1 : 0;
          }
          let cx = (v[0] + v[2 * (1 % n)]) / 2, cy = (v[1] + v[2 * (1 % n) + 1]) / 2;
          emit("M", cx, cy);
          let smooth = false;
          for (let k = 1; k <= n; k++) {
            const at = 2 * (k % n), after = 2 * ((k + 1) % n);
            const px = v[at], py = v[at + 1];
            const mx = (px + v[after]) / 2, my = (py + v[after + 1]) / 2;
            if (corner[k % n]) {
              emit("l", px - cx, py - cy);
              cx = px;
              cy = py;
              if (k < n && !corner[(k + 1) % n]) {
                emit("l", mx - cx, my - cy);
                cx = mx;
                cy = my;
              }
              smooth = false;
            } else {
              if (smooth) emit("t", mx - cx, my - cy);
              else {
                emit("q", px - cx, py - cy);
                emit("q", mx - cx, my - cy);
              }
              cx = mx;
              cy = my;
              smooth = true;
            }
          }
          d += "Z";
          cmd = "Z";
          last = "";
        }
        return d;
      }
      exports.RUN = RUN;
      exports.runsOf = runsOf;
      exports.runRange = runRange;
      exports.contourLoops = contourLoops;
      exports.contourOutlines = contourOutlines;
      exports.simplifyLoop = simplifyLoop;
      exports.simplifiedLoop = simplifiedLoop;
      exports.loopsToPath = loopsToPath;
    },
    "distance.ts": function(__req2, exports) {
      const SLACK = 1e-6;
      const CELL = 4;
      const TILE = 16;
      function segDist2(px, py, ax, ay, bx, by) {
        const dx = bx - ax, dy = by - ay;
        const len = dx * dx + dy * dy;
        let t = len > 0 ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + t * dx - px, ey = ay + t * dy - py;
        return ex * ex + ey * ey;
      }
      let stamp = new Int32Array(0);
      let tags = 0;
      let lists = new Int32Array(0);
      let d2 = new Float64Array(0), vx = new Float64Array(0), vy = new Float64Array(0);
      class EdgeIndex {
        e;
        start;
        items;
        ox;
        oy;
        span;
        count;
        bx = 0;
        by = 0;
        x0 = 0;
        y0 = 0;
        step = 0;
        nx = 0;
        constructor(polys, b) {
          let count = 0;
          for (const poly of polys) count += poly.length;
          this.count = count;
          const e = this.e = new Float64Array(5 * count);
          this.ox = b.minX - 4;
          this.oy = b.minY - 4;
          const span = this.span = Math.ceil((Math.max(b.maxX - b.minX, b.maxY - b.minY) + 8) / CELL) + 1;
          const start = this.start = new Int32Array(span * span + 1);
          let items = this.items = new Int32Array(0), next = start;
          for (const place of [
            false,
            true
          ]) {
            if (place) {
              for (let q = 0; q < span * span; q++) start[q + 1] += start[q];
              items = this.items = new Int32Array(start[span * span]);
              next = start.slice(0, span * span);
            }
            let k = 0;
            for (const poly of polys) {
              for (let i = 0, j = poly.length - 1; i < poly.length; j = i++, k += 5) {
                const ax = poly[j][0], ay = poly[j][1], bx = poly[i][0], by = poly[i][1];
                const dx = bx - ax, dy = by - ay;
                e[k] = ax;
                e[k + 1] = ay;
                e[k + 2] = dx;
                e[k + 3] = dy;
                e[k + 4] = dx * dx + dy * dy;
                const cy0 = this.cy(Math.min(ay, by)), cy1 = this.cy(Math.max(ay, by));
                for (let cy = cy0; cy <= cy1; cy++) {
                  let x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
                  if (cy0 < cy1 && cy > 0 && cy < span - 1) {
                    const t0 = Math.min(1, Math.max(0, (this.oy + cy * CELL - SLACK - ay) / dy));
                    const t1 = Math.min(1, Math.max(0, (this.oy + (cy + 1) * CELL + SLACK - ay) / dy));
                    x0 = Math.min(ax + t0 * dx, ax + t1 * dx) - SLACK;
                    x1 = Math.max(ax + t0 * dx, ax + t1 * dx) + SLACK;
                  }
                  for (let cx = this.cx(x0), end = this.cx(x1); cx <= end; cx++) {
                    if (place) items[next[cy * span + cx]++] = k;
                    else start[cy * span + cx + 1]++;
                  }
                }
              }
            }
          }
        }
        ready() {
          if (stamp.length >= this.count) return;
          stamp = new Int32Array(2 * this.count);
          lists = new Int32Array((2 + Math.ceil(Math.log2(TILE))) * stamp.length);
          d2 = new Float64Array(stamp.length);
          vx = new Float64Array(stamp.length);
          vy = new Float64Array(stamp.length);
        }
        cx(x) {
          return Math.max(0, Math.min(this.span - 1, Math.floor((x - this.ox) / CELL)));
        }
        cy(y) {
          return Math.max(0, Math.min(this.span - 1, Math.floor((y - this.oy) / CELL)));
        }
        distance(x, y) {
          const { e, items, start, span } = this;
          const bx = this.cx(x), by = this.cy(y);
          let best = Infinity;
          for (let r = 0; r < span; r++) {
            for (let cy = by - r; cy <= by + r; cy++) {
              if (cy < 0 || cy >= span) continue;
              const edgeRow = cy === by - r || cy === by + r;
              for (let cx = bx - r; cx <= bx + r; cx += edgeRow ? 1 : 2 * r || 1) {
                if (cx < 0 || cx >= span) continue;
                const b = cy * span + cx;
                for (let q = start[b], end = start[b + 1]; q < end; q++) {
                  const k = items[q];
                  const ax = e[k], ay = e[k + 1], dx = e[k + 2], dy = e[k + 3], len = e[k + 4];
                  let t = len > 0 ? ((x - ax) * dx + (y - ay) * dy) / len : 0;
                  t = t < 0 ? 0 : t > 1 ? 1 : t;
                  const ex = ax + t * dx - x, ey = ay + t * dy - y;
                  const d = ex * ex + ey * ey;
                  if (d < best) best = d;
                }
              }
            }
            const reach = r * CELL - SLACK;
            if (reach > 0 && best <= reach * reach) break;
          }
          return Math.sqrt(best);
        }
        distances(g) {
          const out = new Float64Array(g.nx * g.ny);
          this.ready();
          this.x0 = g.x0;
          this.y0 = g.y0;
          this.step = g.step;
          this.nx = g.nx;
          for (let j0 = 0; j0 < g.ny; j0 += TILE) {
            for (let i0 = 0; i0 < g.nx; i0 += TILE) {
              const i1 = Math.min(g.nx, i0 + TILE) - 1, j1 = Math.min(g.ny, j0 + TILE) - 1;
              const im = i0 + i1 >> 1, jm = j0 + j1 >> 1;
              const x = g.x0 + im * g.step, y = g.y0 + jm * g.step;
              this.fill(out, i0, i1, j0, j1, 0, this.collect(x, y, this.distance(x, y) + 2 * radiusOf(g.step, i0, i1, j0, j1) + SLACK));
            }
          }
          return out;
        }
        widest(g, rows) {
          this.ready();
          this.x0 = g.x0;
          this.y0 = g.y0;
          this.step = g.step;
          this.nx = g.nx;
          const tiles = [];
          for (let j0 = 0; j0 < g.ny; j0 += TILE) {
            for (let i0 = 0; i0 < g.nx; i0 += TILE) tiles.push(i0, Math.min(g.nx, i0 + TILE) - 1, j0, Math.min(g.ny, j0 + TILE) - 1);
          }
          const middles = new Float64Array(tiles.length / 4);
          let best = 0;
          for (let k = 0; k < tiles.length; k += 4) {
            const x = g.x0 + (tiles[k] + tiles[k + 1] >> 1) * g.step, y = g.y0 + (tiles[k + 2] + tiles[k + 3] >> 1) * g.step;
            const d = middles[k / 4] = this.distance(x, y);
            if (d > best && rows.insideRowAt(x, y)) best = d;
          }
          for (let k = 0; k < tiles.length; k += 4) {
            const i0 = tiles[k], i1 = tiles[k + 1], j0 = tiles[k + 2], j1 = tiles[k + 3];
            const x = g.x0 + (i0 + i1 >> 1) * g.step, y = g.y0 + (j0 + j1 >> 1) * g.step;
            const d = middles[k / 4], radius = radiusOf(g.step, i0, i1, j0, j1);
            if (d + radius + SLACK < best) continue;
            const whole = d > radius + SLACK;
            if (whole && !rows.insideRowAt(x, y)) continue;
            best = this.peak(rows, best, whole, i0, i1, j0, j1, 0, this.collect(x, y, d + 2 * radius + SLACK));
          }
          return best;
        }
        collect(x, y, reach) {
          const { items, start, span } = this;
          if (tags >= 2147483392) {
            stamp.fill(0);
            tags = 0;
          }
          const tag = ++tags;
          let n = 0;
          const cx1 = this.cx(x + reach), cy1 = this.cy(y + reach);
          for (let cy = this.cy(y - reach); cy <= cy1; cy++) {
            for (let cx = this.cx(x - reach); cx <= cx1; cx++) {
              const b = cy * span + cx;
              for (let q = start[b], end = start[b + 1]; q < end; q++) {
                const k = items[q];
                if (stamp[k / 5] === tag) continue;
                stamp[k / 5] = tag;
                lists[n++] = k;
              }
            }
          }
          return n;
        }
        nearest(lo, hi, x, y) {
          const e = this.e;
          let best = Infinity;
          for (let q = lo; q < hi; q++) {
            const k = lists[q];
            const ax = e[k], ay = e[k + 1], dx = e[k + 2], dy = e[k + 3], len = e[k + 4];
            let t = len > 0 ? ((x - ax) * dx + (y - ay) * dy) / len : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = ax + t * dx - x, ey = ay + t * dy - y;
            const d = ex * ex + ey * ey;
            if (d < best) best = d;
          }
          return best;
        }
        survey(lo, hi, x, y) {
          const e = this.e;
          let best = Infinity;
          for (let q = lo; q < hi; q++) {
            const k = lists[q];
            const ax = e[k], ay = e[k + 1], dx = e[k + 2], dy = e[k + 3], len = e[k + 4];
            let t = len > 0 ? ((x - ax) * dx + (y - ay) * dy) / len : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = ax + t * dx - x, ey = ay + t * dy - y;
            const d = ex * ex + ey * ey;
            d2[q - lo] = d;
            vx[q - lo] = ex;
            vy[q - lo] = ey;
            if (d < best) {
              best = d;
              this.bx = ex;
              this.by = ey;
            }
          }
          return best;
        }
        narrow(lo, hi, d, radius) {
          const ball = d + 2 * radius + SLACK;
          const bend = d > 0 ? radius * radius / (2 * d) : Infinity;
          const ux = d > 0 ? this.bx / d : 0, uy = d > 0 ? this.by / d : 0;
          let end = hi;
          for (let q = lo; q < hi; q++) {
            const far2 = d2[q - lo];
            if (far2 > ball * ball) continue;
            if (bend < 2 * radius) {
              const far = Math.sqrt(far2);
              const wx = vx[q - lo] / far - ux, wy = vy[q - lo] / far - uy;
              if (far - d > Math.sqrt(wx * wx + wy * wy) * radius + bend + SLACK) continue;
            }
            lists[end++] = lists[q];
          }
          return end;
        }
        fill(out, i0, i1, j0, j1, lo, hi) {
          const { x0, y0, step, nx } = this;
          if (i1 - i0 < 2 && j1 - j0 < 2 || hi - lo < 2) {
            for (let j = j0; j <= j1; j++) {
              for (let i = i0; i <= i1; i++) out[j * nx + i] = Math.sqrt(this.nearest(lo, hi, x0 + i * step, y0 + j * step));
            }
            return;
          }
          const im = i0 + i1 >> 1, jm = j0 + j1 >> 1;
          const d = out[jm * nx + im] = Math.sqrt(this.survey(lo, hi, x0 + im * step, y0 + jm * step));
          const end = this.narrow(lo, hi, d, radiusOf(step, i0, i1, j0, j1));
          this.fill(out, i0, im, j0, jm, hi, end);
          if (im < i1) this.fill(out, im + 1, i1, j0, jm, hi, end);
          if (jm < j1) {
            this.fill(out, i0, im, jm + 1, j1, hi, end);
            if (im < i1) this.fill(out, im + 1, i1, jm + 1, j1, hi, end);
          }
        }
        peak(rows, best, whole, i0, i1, j0, j1, lo, hi) {
          const { x0, y0, step } = this;
          if (i1 - i0 < 2 && j1 - j0 < 2 || hi - lo < 2) {
            for (let j = j0; j <= j1; j++) {
              for (let i = i0; i <= i1; i++) {
                const x2 = x0 + i * step, y2 = y0 + j * step;
                const d3 = Math.sqrt(this.nearest(lo, hi, x2, y2));
                if (d3 > best && (whole || rows.insideRowAt(x2, y2))) best = d3;
              }
            }
            return best;
          }
          const im = i0 + i1 >> 1, jm = j0 + j1 >> 1;
          const x = x0 + im * step, y = y0 + jm * step;
          const d = Math.sqrt(this.survey(lo, hi, x, y)), radius = radiusOf(step, i0, i1, j0, j1);
          if (d + radius + SLACK < best) return best;
          if (!whole && d > radius + SLACK) {
            if (!rows.insideRowAt(x, y)) return best;
            whole = true;
          }
          if (d > best && (whole || rows.insideRowAt(x, y))) best = d;
          const end = this.narrow(lo, hi, d, radius);
          best = this.peak(rows, best, whole, i0, im, j0, jm, hi, end);
          if (im < i1) best = this.peak(rows, best, whole, im + 1, i1, j0, jm, hi, end);
          if (jm < j1) {
            best = this.peak(rows, best, whole, i0, im, jm + 1, j1, hi, end);
            if (im < i1) best = this.peak(rows, best, whole, im + 1, i1, jm + 1, j1, hi, end);
          }
          return best;
        }
      }
      function radiusOf(step, i0, i1, j0, j1) {
        const im = i0 + i1 >> 1, jm = j0 + j1 >> 1;
        return step * Math.hypot(Math.max(im - i0, i1 - im), Math.max(jm - j0, j1 - jm));
      }
      exports.segDist2 = segDist2;
      exports.EdgeIndex = EdgeIndex;
    },
    "dom/clock.ts": function(__req2, exports) {
      const subscribers = /* @__PURE__ */ new Set();
      const mayPark = /* @__PURE__ */ new WeakMap();
      const parked = /* @__PURE__ */ new Set();
      const ready = [];
      let frame = 0;
      let visibilityBound = false;
      const due = /* @__PURE__ */ new WeakMap();
      const DUE_TOLERANCE = 15e-4;
      let pointer = null;
      const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
      let lastTickNow = 0;
      let highRefresh = false;
      function isHidden() {
        return typeof document !== "undefined" && document.hidden === true;
      }
      function onVisibilityChange() {
        if (isHidden()) {
          if (frame) {
            cancelAnimationFrame(frame);
            frame = 0;
          }
          lastTickNow = 0;
        } else {
          requestFrame();
        }
      }
      function tick(now) {
        var _a, _b;
        frame = 0;
        if (isHidden()) return;
        if (lastTickNow > 0) {
          const dt = now - lastTickNow;
          if (dt > 1 && dt < 100) highRefresh = dt < 9.5;
        }
        lastTickNow = now;
        const time = (now - startedAt) / 1e3;
        let busy = false;
        ready.length = 0;
        for (const s of subscribers) {
          const at = due.get(s);
          if (at !== void 0 && at - time > DUE_TOLERANCE) busy = true;
          else ready.push(s);
        }
        for (let i = 0; i < ready.length; i++) {
          const s = ready[i];
          if (subscribers.has(s)) (_a = s.measure) == null ? void 0 : _a.call(s);
        }
        for (let i = 0; i < ready.length; i++) {
          const s = ready[i];
          if (!subscribers.has(s)) continue;
          const prevDue = due.get(s);
          const next = s.draw(time, pointer);
          if (typeof next === "number") {
            const carried = prevDue !== void 0 ? prevDue + next : time + next;
            due.set(s, carried > time + DUE_TOLERANCE ? carried : time + next);
          } else {
            due.delete(s);
            if (next === false && !frame && ((_b = mayPark.get(s)) == null ? void 0 : _b()) && subscribers.delete(s)) parked.add(s);
          }
          busy = next !== false || busy;
        }
        ready.length = 0;
        if (busy) wake();
        else lastTickNow = 0;
      }
      function wake() {
        if (!frame && subscribers.size > 0 && !isHidden() && typeof requestAnimationFrame !== "undefined") frame = requestAnimationFrame(tick);
      }
      function subscribeFrames(subscriber) {
        if (!visibilityBound && typeof document !== "undefined") {
          visibilityBound = true;
          document.addEventListener("visibilitychange", onVisibilityChange);
          if (typeof window !== "undefined") {
            let dpr = window.devicePixelRatio;
            window.addEventListener("resize", () => {
              if (dpr === window.devicePixelRatio) return;
              dpr = window.devicePixelRatio;
              if (parked.size) requestFrame();
            });
          }
        }
        subscribers.add(subscriber);
        wake();
        return () => {
          subscribers.delete(subscriber);
          parked.delete(subscriber);
          if (subscribers.size === 0) {
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
          }
        };
      }
      function subscribeMountFrames(subscriber, canPark) {
        mayPark.set(subscriber, canPark);
        const unsubscribe = subscribeFrames(subscriber);
        return {
          request() {
            if (parked.delete(subscriber)) subscribers.add(subscriber);
            wake();
          },
          unsubscribe
        };
      }
      function setPointer(next) {
        pointer = next;
        wake();
      }
      function isHighRefresh() {
        return highRefresh;
      }
      function currentPointer() {
        return pointer;
      }
      function requestFrame() {
        for (const s of parked) subscribers.add(s);
        parked.clear();
        wake();
      }
      exports.subscribeFrames = subscribeFrames;
      exports.subscribeMountFrames = subscribeMountFrames;
      exports.setPointer = setPointer;
      exports.isHighRefresh = isHighRefresh;
      exports.currentPointer = currentPointer;
      exports.requestFrame = requestFrame;
    },
    "dom/eye.ts": function(__req2, exports) {
      function eyeBox(mark) {
        if (mark.shape === "pill") return {
          x: mark.x,
          y: mark.y,
          w: mark.width,
          h: mark.height
        };
        const reach = mark.shape === "arc" ? mark.strokeWidth : 0;
        const n = (mark.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
        const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1);
        const x = Math.min(...xs) - reach, y = Math.min(...ys) - reach;
        return {
          x,
          y,
          w: Math.max(...xs) + reach - x,
          h: Math.max(...ys) + reach - y
        };
      }
      const eyePaths = /* @__PURE__ */ new Map();
      const MAX_EYE_PATHS = 64;
      function cachedEyePath(d) {
        let path = eyePaths.get(d);
        if (!path) {
          if (eyePaths.size >= MAX_EYE_PATHS) eyePaths.clear();
          path = new Path2D(d);
          eyePaths.set(d, path);
        }
        return path;
      }
      function paintEye(ctx, mark) {
        if (mark.shape === "path") {
          ctx.fill(cachedEyePath(mark.d));
          return;
        }
        if (mark.shape === "arc") {
          ctx.lineWidth = mark.strokeWidth;
          ctx.stroke(cachedEyePath(mark.d));
          return;
        }
        const { x, y, width: w, height: h, radius: r } = mark;
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
        else {
          ctx.moveTo(x + r, y);
          ctx.arcTo(x + w, y, x + w, y + h, r);
          ctx.arcTo(x + w, y + h, x, y + h, r);
          ctx.arcTo(x, y + h, x, y, r);
          ctx.arcTo(x, y, x + w, y, r);
          ctx.closePath();
        }
        ctx.fill();
      }
      exports.eyeBox = eyeBox;
      exports.paintEye = paintEye;
    },
    "dom/fluffy/dye.ts": function(__req2, exports) {
      const { oklch, toOklch } = __req2("color.ts");
      const DYE_RAMP_SIZE = 96;
      const DYE_RAMP_RANGE = 2.4;
      const ramps = /* @__PURE__ */ new Map();
      function shoulder(distance, room) {
        const knee = room / 2;
        return distance <= knee ? distance : room - knee * Math.exp((knee - distance) / knee);
      }
      function smoothstep(low, high, value) {
        const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
        return t * t * (3 - 2 * t);
      }
      function dyeRamp(rgb) {
        const key = rgb[0] << 16 | rgb[1] << 8 | rgb[2];
        const cached = ramps.get(key);
        if (cached) return cached;
        const [lightness, chroma, hue] = toOklch(rgb);
        const yellow = (1 - smoothstep(22, 32, Math.abs(hue - 90))) * smoothstep(0.025, 0.085, chroma) * smoothstep(0.54, 0.75, lightness);
        const value = Math.max(...rgb);
        const dye = rgb.map((channel) => value ? channel / value : 1);
        const weakest = Math.min(...dye);
        const peak = dye.map((channel) => 255 * (channel + (1 - channel) * (0.16 + 0.84 * (channel - weakest))));
        const [peakLightness] = toOklch(peak);
        const mid = Math.max(0.16, Math.min(lightness, peakLightness - 0.025));
        const midChroma = chroma * Math.min(1, mid / Math.max(1e-3, lightness));
        const headroom = peakLightness - mid;
        const row = new Uint8Array(DYE_RAMP_SIZE * 4);
        for (let i = 0; i < DYE_RAMP_SIZE; i++) {
          const exposure = (i + 0.5) * DYE_RAMP_RANGE / DYE_RAMP_SIZE;
          const delta = 0.82 * (Math.cbrt(exposure) - 1);
          const L = delta < 0 ? mid - shoulder(-delta, mid) : mid + shoulder(delta, headroom);
          const [r, g, b] = oklch(L, midChroma * Math.min(1, L / mid), hue);
          row.set([
            Math.round(r),
            Math.round(g),
            Math.round(b),
            Math.round(255 * yellow)
          ], i * 4);
        }
        if (ramps.size >= 64) ramps.delete(ramps.keys().next().value);
        ramps.set(key, row);
        return row;
      }
      exports.DYE_RAMP_SIZE = DYE_RAMP_SIZE;
      exports.DYE_RAMP_RANGE = DYE_RAMP_RANGE;
      exports.dyeRamp = dyeRamp;
    },
    "dom/fluffy/mesh.ts": function(__req2, exports) {
      const { EdgeIndex } = __req2("distance.ts");
      const { edgeBands } = __req2("path.ts");
      const { EYE_H, EYE_W, GAZE_X, GAZE_Y, HAPPY_ARC } = __req2("validate.ts");
      const { halfDepth } = __req2("dom/materials/shape.ts");
      const { SOCKET_PAD } = __req2("dom/materials/socket.ts");
      const isCapsule = (shape) => "radius" in shape;
      const STEP = 1.05;
      const PAD = 3 * STEP;
      const ROOT_PASSES = 8;
      function rootsIn(total, passes) {
        let count = 0;
        for (let pass = 0; pass < passes; pass++) count += Math.ceil((total - pass) / ROOT_PASSES);
        return count;
      }
      const ROOT_DENSITY = 3.3;
      const SOCKET_LEVELS = 2;
      function emptyGrid(shape) {
        const b = shape.bounds, half = halfDepth(shape);
        const nx = Math.ceil((b.maxX - b.minX + 2 * PAD) / STEP) + 1;
        const ny = Math.ceil((b.maxY - b.minY + 2 * PAD) / STEP) + 1;
        const nz = Math.ceil((2 * half + 2 * PAD) / STEP) + 1;
        return {
          x0: b.minX - PAD,
          y0: b.minY - PAD,
          z0: -half - PAD,
          nx,
          ny,
          nz,
          field: new Float32Array(nx * ny * nz).fill(-1e3)
        };
      }
      function addCapsule(g, { bounds, radius }) {
        const halfStem = bounds.maxY - radius;
        for (let j = 0; j < g.ny; j++) {
          const dy = Math.max(0, Math.abs(g.y0 + j * STEP) - halfStem);
          for (let i = 0; i < g.nx; i++) {
            const radial = (g.x0 + i * STEP) ** 2 + dy ** 2;
            for (let k = 0; k < g.nz; k++) g.field[i + j * g.nx + k * g.nx * g.ny] = radius - Math.sqrt(radial + (g.z0 + k * STEP) ** 2);
          }
        }
      }
      function addPart(g, part) {
        const { field, nx } = g, plane = nx * g.ny;
        const rounded = part.kind === "inflate" && part.rxy > 0 && part.rz > 0;
        const distances = new EdgeIndex(part.polys, part.bounds).distances({
          x0: g.x0,
          y0: g.y0,
          step: STEP,
          nx,
          ny: g.ny
        });
        const outline = edgeBands(part.polys);
        const zAt = Float64Array.from({
          length: g.nz
        }, (_, k) => Math.abs(g.z0 + k * STEP));
        const topAt = rounded ? zAt.map((z) => Math.max(0, (z - part.depth / 2 + part.rz) / part.rz)) : null;
        const scale = Math.min(part.rxy, part.rz);
        for (let j = 0; j < g.ny; j++) {
          const y = g.y0 + j * STEP;
          for (let i = 0; i < nx; i++) {
            const x = g.x0 + i * STEP;
            const inside = outline.winding(x, y) !== 0;
            const sd = inside ? distances[i + j * nx] : -distances[i + j * nx];
            const h = part.kind === "inflate" || !inside ? 0 : part.height(x, y);
            const side = rounded ? Math.max(0, (part.rxy - sd) / part.rxy) : 0;
            for (let k = 0; k < g.nz; k++) {
              let d;
              if (topAt) {
                const top = topAt[k];
                d = (1 - (side === 0 ? top : top === 0 ? side : Math.hypot(side, top))) * scale;
              } else d = Math.min(sd, Math.max(0.55, h) - zAt[k]);
              const at = i + j * nx + k * plane;
              if (d > field[at]) field[at] = d;
            }
          }
        }
      }
      function surfaceNets(g) {
        const { field, nx, ny, nz } = g, plane = nx * ny;
        const corners = [
          0,
          1,
          nx,
          nx + 1,
          plane,
          plane + 1,
          plane + nx,
          plane + nx + 1
        ];
        const strides = [
          1,
          nx,
          plane
        ];
        const ids = new Int32Array(field.length).fill(-1);
        const vertices = [], indices = [], turned = [];
        for (let k = 1; k < nz - 2; k++) for (let j = 1; j < ny - 2; j++) for (let i = 1; i < nx - 2; i++) {
          const cell = i + j * nx + k * plane, inside = field[cell] > 0;
          let crossed = false;
          for (let c = 1; c < 8 && !crossed; c++) crossed = field[cell + corners[c]] > 0 !== inside;
          if (!crossed) continue;
          let sx = 0, sy = 0, sz = 0, count = 0, gx = 0, gy = 0, gz = 0;
          for (let c = 0; c < 8; c++) {
            const a = cell + corners[c];
            for (let axis = 0; axis < 3; axis++) {
              if (c & 1 << axis) continue;
              const other = a + strides[axis];
              if (field[a] > 0 === field[other] > 0) continue;
              const t = field[a] / (field[a] - field[other]);
              sx += (c & 1) + (axis === 0 ? t : 0);
              sy += (c >> 1 & 1) + (axis === 1 ? t : 0);
              sz += (c >> 2 & 1) + (axis === 2 ? t : 0);
              gx += (field[a - 1] - field[a + 1]) * (1 - t) + (field[other - 1] - field[other + 1]) * t;
              gy += (field[a - nx] - field[a + nx]) * (1 - t) + (field[other - nx] - field[other + nx]) * t;
              gz += (field[a - plane] - field[a + plane]) * (1 - t) + (field[other - plane] - field[other + plane]) * t;
              count++;
            }
          }
          const norm = Math.hypot(gx, gy, gz) || 1;
          const id = vertices.length / 6;
          ids[cell] = id;
          vertices.push(g.x0 + (i + sx / count) * STEP, g.y0 + (j + sy / count) * STEP, g.z0 + (k + sz / count) * STEP, gx / norm, gy / norm, gz / norm);
          for (let axis = 0; axis < 3; axis++) {
            if (field[cell + strides[axis]] > 0 === inside) continue;
            const u = strides[(axis + 1) % 3], v = strides[(axis + 2) % 3];
            const p = ids[cell - u], q = ids[cell - u - v], r = ids[cell - v];
            if (Math.min(p, q, r) < 0) continue;
            if (!inside) turned.push(indices.length, indices.length + 3);
            indices.push(id, p, q, id, q, r);
          }
        }
        return {
          vertices,
          indices,
          turned
        };
      }
      function wind(indices, turned) {
        for (const t of turned) {
          const b = indices[t + 1];
          indices[t + 1] = indices[t + 2];
          indices[t + 2] = b;
        }
      }
      function fieldAt(g, x, y, z) {
        const fx = Math.min(g.nx - 1.001, Math.max(0, (x - g.x0) / STEP));
        const fy = Math.min(g.ny - 1.001, Math.max(0, (y - g.y0) / STEP));
        const fz = Math.min(g.nz - 1.001, Math.max(0, (z - g.z0) / STEP));
        const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz), u = fx - i, v = fy - j, w = fz - k;
        const f = g.field, plane = g.nx * g.ny, at = i + j * g.nx + k * plane;
        const a = f[at] * (1 - u) + f[at + 1] * u, b = f[at + g.nx] * (1 - u) + f[at + g.nx + 1] * u;
        const c = f[at + plane] * (1 - u) + f[at + plane + 1] * u, d = f[at + plane + g.nx] * (1 - u) + f[at + plane + g.nx + 1] * u;
        return (a * (1 - v) + b * v) * (1 - w) + (c * (1 - v) + d * v) * w;
      }
      function mergeMesh(g, vertices, indices, cell) {
        const count = vertices.length / 6;
        const across = Math.ceil(g.nx * STEP / cell) + 1, down = Math.ceil(g.ny * STEP / cell) + 1;
        const ids = new Int32Array(count), known = /* @__PURE__ */ new Map();
        const sums = [];
        for (let i = 0; i < count; i++) {
          const o = 6 * i, nx = vertices[o + 3], ny = vertices[o + 4], nz = vertices[o + 5];
          const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
          const facing = ax >= ay && ax >= az ? nx > 0 ? 0 : 1 : ay >= az ? ny > 0 ? 2 : 3 : nz > 0 ? 4 : 5;
          const at = Math.floor((vertices[o] - g.x0) / cell) + across * (Math.floor((vertices[o + 1] - g.y0) / cell) + down * Math.floor((vertices[o + 2] - g.z0) / cell));
          const key = at * 6 + facing;
          let id = known.get(key);
          if (id === void 0) {
            id = sums.length / 7;
            known.set(key, id);
            sums.push(0, 0, 0, 0, 0, 0, 0);
          }
          ids[i] = id;
          for (let k = 0; k < 6; k++) sums[7 * id + k] += vertices[o + k];
          sums[7 * id + 6]++;
        }
        const total = sums.length / 7, half = STEP / 2;
        const merged = [];
        for (let id = 0; id < total; id++) {
          const n = sums[7 * id + 6];
          let x = sums[7 * id] / n, y = sums[7 * id + 1] / n, z = sums[7 * id + 2] / n;
          let nx = sums[7 * id + 3], ny = sums[7 * id + 4], nz = sums[7 * id + 5];
          const length = Math.hypot(nx, ny, nz) || 1;
          nx /= length, ny /= length, nz /= length;
          for (let pass = 0; pass < 2; pass++) {
            const slope = (fieldAt(g, x - nx * half, y - ny * half, z - nz * half) - fieldAt(g, x + nx * half, y + ny * half, z + nz * half)) / STEP;
            if (slope < 0.3) break;
            const out = Math.max(-cell / 2, Math.min(cell / 2, fieldAt(g, x, y, z) / slope));
            x += nx * out, y += ny * out, z += nz * out;
          }
          merged.push(x, y, z, nx, ny, nz);
        }
        const seen = /* @__PURE__ */ new Set(), triangles = [];
        for (let t = 0; t < indices.length; t += 3) {
          const a = ids[indices[t]], b = ids[indices[t + 1]], c = ids[indices[t + 2]];
          if (a === b || b === c || a === c) continue;
          const low = Math.min(a, b, c), high = Math.max(a, b, c);
          const key = (low * total + (a + b + c - low - high)) * total + high;
          if (seen.has(key)) continue;
          seen.add(key);
          triangles.push(a, b, c);
        }
        return {
          vertices: merged,
          indices: triangles
        };
      }
      function randomFrom(seed) {
        return () => (seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296;
      }
      function scatterRoots(vertices, indices) {
        const random = randomFrom(51821);
        const perPass = 256, blockRoots = ROOT_PASSES * perPass;
        const blocks = [];
        let total = 0;
        for (let i = 0; i < indices.length; i += 3) {
          const a = indices[i] * 6, b = indices[i + 1] * 6, c = indices[i + 2] * 6;
          const abx = vertices[b] - vertices[a], aby = vertices[b + 1] - vertices[a + 1], abz = vertices[b + 2] - vertices[a + 2];
          const acx = vertices[c] - vertices[a], acy = vertices[c + 1] - vertices[a + 1], acz = vertices[c + 2] - vertices[a + 2];
          const area = 0.5 * Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx);
          const count = Math.floor(area * ROOT_DENSITY + random());
          for (let n = 0; n < count; n++) {
            const u = Math.sqrt(random()), v = u * random();
            const local = total++ % blockRoots;
            if (local === 0) blocks.push(new Float32Array(blockRoots * 8));
            const block = blocks[blocks.length - 1];
            const at2 = (local % ROOT_PASSES * perPass + Math.floor(local / ROOT_PASSES)) * 8;
            for (let k = 0; k < 6; k++) block[at2 + k] = (1 - u) * vertices[a + k] + (u - v) * vertices[b + k] + v * vertices[c + k];
            block[at2 + 6] = random();
            block[at2 + 7] = random();
          }
        }
        const passes = new Float32Array(total * 8);
        let at = 0;
        for (let pass = 0; pass < ROOT_PASSES; pass++) {
          const start = pass * perPass * 8;
          for (let i = 0; i < blocks.length; i++) {
            const count = Math.min(perPass, Math.ceil((total - i * blockRoots - pass) / ROOT_PASSES));
            passes.set(blocks[i].subarray(start, start + count * 8), at);
            at += count * 8;
          }
        }
        return passes;
      }
      function refineSockets(vertices, indices, vol, cell) {
        const pad = SOCKET_PAD + 2 * cell;
        const reachX = vol.eyeScale * (EYE_W * (HAPPY_ARC.halfWidth + HAPPY_ARC.stroke / 2) + GAZE_X) + pad;
        const reachY = vol.eyeScale * (EYE_H / 2 + GAZE_Y) + pad;
        const refined = [];
        const midpoints = /* @__PURE__ */ new Map();
        const midpoint = (a, b) => {
          const key = Math.min(a, b) * 2 ** 26 + Math.max(a, b);
          let id = midpoints.get(key);
          if (id === void 0) {
            id = vertices.length / 6;
            for (let k = 0; k < 6; k++) vertices.push((vertices[6 * a + k] + vertices[6 * b + k]) / 2);
            midpoints.set(key, id);
          }
          return id;
        };
        const split = (a, b, c, level) => {
          if (level === 0) {
            refined.push(a, b, c);
            return;
          }
          const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
          split(a, ab, ca, level - 1);
          split(ab, b, bc, level - 1);
          split(ca, bc, c, level - 1);
          split(ab, bc, ca, level - 1);
        };
        for (let i = 0; i < indices.length; i += 3) {
          const a = indices[i], x = vertices[6 * a], y = vertices[6 * a + 1], z = vertices[6 * a + 2];
          const near = z >= -2 * STEP && vol.eyePlanes.some((eye) => Math.abs(eye.x - x) <= reachX && Math.abs(eye.y - y) <= reachY);
          split(a, indices[i + 1], indices[i + 2], near ? SOCKET_LEVELS : 0);
        }
        return refined;
      }
      function buildMesh(shape, options = {}) {
        const cell = Math.max(STEP, options.cell ?? STEP);
        const grid = emptyGrid(shape);
        if (isCapsule(shape)) addCapsule(grid, shape);
        else for (const part of shape.parts) addPart(grid, part);
        const full = surfaceNets(grid);
        const roots = options.roots === false ? new Float32Array(0) : scatterRoots(full.vertices, full.indices);
        wind(full.indices, full.turned);
        const { vertices, indices } = cell > STEP ? mergeMesh(grid, full.vertices, full.indices, cell) : full;
        const coarse = {
          start: 0,
          count: indices.length
        };
        if (isCapsule(shape) || options.sockets === false) return {
          vertices: new Float32Array(vertices),
          indices: new Uint32Array(indices),
          coarse,
          fine: coarse,
          roots
        };
        const refined = refineSockets(vertices, indices, shape, cell);
        const all = new Uint32Array(indices.length + refined.length);
        all.set(indices);
        all.set(refined, indices.length);
        return {
          vertices: new Float32Array(vertices),
          indices: all,
          coarse,
          fine: {
            start: indices.length,
            count: refined.length
          },
          roots
        };
      }
      exports.STEP = STEP;
      exports.ROOT_PASSES = ROOT_PASSES;
      exports.rootsIn = rootsIn;
      exports.buildMesh = buildMesh;
    },
    "dom/fluffy/renderer.ts": function(__req2, exports) {
      const { requestFrame } = __req2("dom/clock.ts");
      const { invalidateMaterialCache } = __req2("dom/paint.ts");
      const { halfDepth } = __req2("dom/materials/shape.ts");
      const { DYE_RAMP_SIZE, dyeRamp } = __req2("dom/fluffy/dye.ts");
      const { ROOT_PASSES, STEP, buildMesh, rootsIn } = __req2("dom/fluffy/mesh.ts");
      const { PASS, fragmentShader, vertexShader } = __req2("dom/fluffy/shaders.ts");
      const { SOCKET_TILE, exposedHeight, socketKey, socketRegion, socketTile } = __req2("dom/materials/socket.ts");
      const SHELLS = 5;
      const FULL_DETAIL = 2.56;
      const MAX_PIXELS = 1024;
      const MIN_PIXELS = 32;
      const PILE_REACH = 4;
      const SOCKET_RISE = 0.8;
      const SAME_VIEW = 0.1;
      const KEPT_MESHES = 8;
      const IDLE_MS = 2e3;
      const MESH_CELLS = [
        [
          1.2,
          3
        ],
        [
          3.4,
          2
        ]
      ];
      function fluffyDetail(scale) {
        var _a;
        const detail = Math.min(1, scale / FULL_DETAIL);
        const shells = Math.max(2, Math.ceil(SHELLS * detail));
        return {
          shells,
          drawnShells: scale <= FULL_DETAIL ? shells - 1 : shells,
          strandPasses: Math.max(ROOT_PASSES / 4, Math.ceil(ROOT_PASSES * Math.sqrt(detail))),
          fineSockets: detail > 0.75,
          cell: ((_a = MESH_CELLS.find(([upTo]) => scale <= upTo)) == null ? void 0 : _a[1]) ?? STEP,
          fewerReads: detail <= 0.5
        };
      }
      function randomFrom(seed) {
        return () => (seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296;
      }
      function fiberTile() {
        const size = 128;
        const tile = document.createElement("canvas");
        tile.width = tile.height = size;
        const g = tile.getContext("2d");
        g.fillStyle = "#252525";
        g.fillRect(0, 0, size, size);
        g.lineCap = "round";
        const random = randomFrom(9213);
        for (let i = 0; i < 1400; i++) {
          const x = random() * size, y = random() * size;
          const angle = 2.4 * Math.sin(y * Math.PI / 32) + 1.4 * Math.cos(x * Math.PI / 32) + (random() - 0.5) * 3.3;
          const dx = Math.cos(angle), dy = Math.sin(angle), length = 3 + random() * 8, curl = (random() - 0.5) * length;
          const grey = Math.round(55 + 200 * random());
          g.strokeStyle = `rgb(${grey} ${grey} ${grey})`;
          g.lineWidth = 0.8 + random() * 1.5;
          for (const ox of [
            -size,
            0,
            size
          ]) for (const oy of [
            -size,
            0,
            size
          ]) {
            if (x + ox < -12 || x + ox > size + 12 || y + oy < -12 || y + oy > size + 12) continue;
            g.beginPath();
            g.moveTo(x + ox, y + oy);
            g.quadraticCurveTo(x + ox + dx * length * 0.5 - dy * curl, y + oy + dy * length * 0.5 + dx * curl, x + ox + dx * length, y + oy + dy * length);
            g.stroke();
          }
        }
        return tile;
      }
      function rootVolume(side) {
        const roots = new Uint8Array(side ** 3);
        let seed = 73021;
        for (let i = 0; i < roots.length; i++) {
          seed = Math.imul(seed, 1664525) + 1013904223 >>> 0;
          roots[i] = seed >>> 24;
        }
        return roots;
      }
      function link(gl, vertex, fragment) {
        const program = gl.createProgram();
        for (const [kind, source] of [
          [
            gl.VERTEX_SHADER,
            vertex
          ],
          [
            gl.FRAGMENT_SHADER,
            fragment
          ]
        ]) {
          const shader = gl.createShader(kind);
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader compilation failed");
          gl.attachShader(program, shader);
          gl.deleteShader(shader);
        }
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "shader linking failed");
        return program;
      }
      function colorReader() {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d", {
          willReadFrequently: true
        });
        const known = /* @__PURE__ */ new Map();
        return (color) => {
          let rgb = known.get(color);
          if (!rgb) {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = "#000";
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            rgb = [
              r,
              g,
              b
            ];
            if (known.size >= 64) known.clear();
            known.set(color, rgb);
          }
          return rgb;
        };
      }
      function createRenderer(onContextRestored) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = MIN_PIXELS;
        const gl = canvas.getContext("webgl2", {
          alpha: true,
          antialias: true,
          premultipliedAlpha: true,
          preserveDrawingBuffer: false
        });
        if (!gl) return null;
        canvas.addEventListener("webglcontextlost", (event) => event.preventDefault());
        canvas.addEventListener("webglcontextrestored", onContextRestored);
        const samplers = [
          "pile",
          "eyeField",
          "brushedPile",
          "dyeRamp"
        ];
        const programs = /* @__PURE__ */ new Map();
        const prepare = (fewerReads) => {
          const program = link(gl, vertexShader, fragmentShader(fewerReads));
          gl.useProgram(program);
          const uniform = (name) => gl.getUniformLocation(program, name);
          samplers.forEach((sampler, unit) => gl.uniform1i(uniform(sampler), unit));
          return {
            program,
            view: uniform("view"),
            pivot: uniform("pivot"),
            extent: uniform("extent"),
            radius: uniform("radius"),
            shell: uniform("shell"),
            strandWidth: uniform("strandWidth"),
            pass: uniform("pass"),
            color: uniform("color"),
            ink: uniform("ink"),
            eyeRegion: uniform("eyeRegion[0]"),
            eyeSize: uniform("eyeSize[0]")
          };
        };
        const programOf = (fewerReads) => {
          let program = programs.get(fewerReads);
          if (!program) programs.set(fewerReads, program = prepare(fewerReads));
          return program;
        };
        programOf(false);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.SCISSOR_TEST);
        gl.frontFace(gl.CW);
        const texture = (unit, target) => {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(target, gl.createTexture());
        };
        const clampLinear = () => {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        };
        texture(0, gl.TEXTURE_2D);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fiberTile());
        gl.generateMipmap(gl.TEXTURE_2D);
        texture(2, gl.TEXTURE_3D);
        const side = 64;
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, side, side, side, 0, gl.RED, gl.UNSIGNED_BYTE, rootVolume(side));
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.generateMipmap(gl.TEXTURE_3D);
        texture(3, gl.TEXTURE_2D);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, DYE_RAMP_SIZE, 1);
        clampLinear();
        texture(1, gl.TEXTURE_2D);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, 2 * SOCKET_TILE, SOCKET_TILE);
        clampLinear();
        const geometries = /* @__PURE__ */ new Map();
        let sweepPending = false;
        const buffer = (target, data) => {
          const b = gl.createBuffer();
          gl.bindBuffer(target, b);
          gl.bufferData(target, data, gl.STATIC_DRAW);
          return b;
        };
        const attributes = (stride, sizes2, perInstance) => {
          let offset = 0;
          sizes2.forEach((size, location) => {
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
            if (perInstance) gl.vertexAttribDivisor(location, 1);
            offset += 4 * size;
          });
        };
        const surface = (mesh) => {
          const vertexArray = gl.createVertexArray();
          gl.bindVertexArray(vertexArray);
          const vertices = buffer(gl.ARRAY_BUFFER, mesh.vertices);
          attributes(24, [
            3,
            3
          ], false);
          const indices = buffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices);
          return {
            vertexArray,
            buffers: [
              vertices,
              indices
            ],
            coarse: mesh.coarse,
            fine: mesh.fine
          };
        };
        const meshOptions = (cell) => ({
          cell,
          sockets: cell === STEP || MESH_CELLS.some(([upTo, width]) => width === cell && fluffyDetail(upTo).fineSockets)
        });
        const upload = (shape, cell) => {
          const mesh = buildMesh(shape, meshOptions(cell));
          const surfaces = /* @__PURE__ */ new Map([
            [
              cell,
              surface(mesh)
            ]
          ]);
          const strands = gl.createVertexArray();
          gl.bindVertexArray(strands);
          const roots = buffer(gl.ARRAY_BUFFER, mesh.roots);
          attributes(32, [
            3,
            3,
            2
          ], true);
          const b = shape.bounds, rx = (b.maxX - b.minX) / 2, ry = (b.maxY - b.minY) / 2, rz = halfDepth(shape);
          return {
            surfaces,
            strands,
            roots,
            strandCount: mesh.roots.length / 8,
            cx: b.minX + rx,
            cy: b.minY + ry,
            extent: [
              rx,
              ry,
              rz
            ],
            radius: Math.ceil(Math.hypot(rx, ry, rz) + PILE_REACH),
            usedAt: 0
          };
        };
        const sweep = () => {
          const now = performance.now();
          for (const [shape, geometry] of geometries) {
            if (geometries.size <= KEPT_MESHES) return;
            if (now - geometry.usedAt < IDLE_MS) continue;
            for (const { vertexArray, buffers } of geometry.surfaces.values()) {
              gl.deleteVertexArray(vertexArray);
              buffers.forEach((b) => gl.deleteBuffer(b));
            }
            gl.deleteVertexArray(geometry.strands);
            gl.deleteBuffer(geometry.roots);
            geometries.delete(shape);
          }
          if (!sweepPending) {
            sweepPending = true;
            setTimeout(() => {
              sweepPending = false;
              sweep();
            }, IDLE_MS);
          }
        };
        const geometryOf = (shape, cell) => {
          let geometry = geometries.get(shape);
          if (geometry) geometries.delete(shape);
          else geometry = upload(shape, cell);
          geometries.set(shape, geometry);
          geometry.usedAt = performance.now();
          if (geometries.size > KEPT_MESHES) sweep();
          return geometry;
        };
        const surfaceOf = (shape, geometry, cell) => {
          let found = geometry.surfaces.get(cell);
          if (!found) geometry.surfaces.set(cell, found = surface(buildMesh(shape, {
            ...meshOptions(cell),
            roots: false
          })));
          return found;
        };
        const regions = new Float32Array(8), sizes = new Float32Array(4);
        const scratch = document.createElement("canvas");
        scratch.width = scratch.height = SOCKET_TILE;
        const scratchCtx = scratch.getContext("2d", {
          willReadFrequently: true
        });
        const tiles = /* @__PURE__ */ new Map();
        const tileOf = (mark, key) => {
          let tile = tiles.get(key);
          if (!tile) {
            tile = socketTile(scratchCtx, mark);
            if (tiles.size >= 48) tiles.delete(tiles.keys().next().value);
            tiles.set(key, tile);
          }
          return tile;
        };
        const readColor = colorReader();
        const shown = {
          geometry: null,
          view: null,
          pixels: 0,
          color: "",
          ink: "",
          regions: new Float32Array(8),
          contours: [
            "",
            ""
          ]
        };
        let dye = "";
        let resetQueued = false;
        const invalidateAfterTurn = () => {
          if (resetQueued) return;
          resetQueued = true;
          queueMicrotask(() => {
            resetQueued = false;
            shown.view = null;
          });
        };
        return (shape, view, look, scale) => {
          if (gl.isContextLost()) return null;
          const { shells, drawnShells, strandPasses, fineSockets, cell, fewerReads } = fluffyDetail(scale);
          const geometry = geometryOf(shape, cell);
          const { cx, cy, radius } = geometry;
          const pixels = Math.min(MAX_PIXELS, Math.max(MIN_PIXELS, Math.ceil(2 * radius * scale)));
          if (canvas.width < pixels) canvas.width = canvas.height = pixels;
          const image = {
            canvas,
            x: 0,
            y: canvas.height - pixels,
            size: pixels,
            cx,
            cy,
            radius
          };
          const eyeZ = "eyeZ" in shape ? shape.eyeZ : [];
          regions.fill(0);
          const contours = [
            "",
            ""
          ];
          look.eyes.forEach(({ mark, dx, dy }, slot) => {
            const region = socketRegion(mark);
            regions.set([
              region.cx + dx,
              region.cy + dy,
              region.span,
              eyeZ[slot] + SOCKET_RISE
            ], 4 * slot);
            sizes.set([
              region.w,
              region.h * exposedHeight(region.w, region.h)
            ], 2 * slot);
            contours[slot] = socketKey(mark);
          });
          const turn = shown.view ? Math.abs(view.cY - shown.view.cY) + Math.abs(view.sY - shown.view.sY) + Math.abs(view.sP - shown.view.sP) + Math.abs(view.cP - shown.view.cP) : Infinity;
          if (shown.geometry === geometry && shown.pixels === pixels && shown.color === look.color && shown.ink === look.ink && contours.every((key, slot) => key === shown.contours[slot]) && regions.every((value, i) => value === shown.regions[i]) && turn < SAME_VIEW / (radius * scale)) {
            return image;
          }
          shown.geometry = geometry;
          shown.view = view;
          shown.pixels = pixels;
          shown.color = look.color;
          shown.ink = look.ink;
          shown.regions.set(regions);
          const u = programOf(fewerReads);
          gl.useProgram(u.program);
          look.eyes.forEach(({ mark }, slot) => {
            if (contours[slot] === shown.contours[slot]) return;
            gl.texSubImage2D(gl.TEXTURE_2D, 0, slot * SOCKET_TILE, 0, SOCKET_TILE, SOCKET_TILE, gl.RED, gl.UNSIGNED_BYTE, tileOf(mark, contours[slot]));
          });
          shown.contours = contours;
          gl.uniform4fv(u.eyeRegion, regions);
          gl.uniform2fv(u.eyeSize, sizes);
          const [r, g, b] = readColor(look.color);
          gl.uniform3f(u.color, r / 255, g / 255, b / 255);
          if (dye !== look.color) {
            gl.activeTexture(gl.TEXTURE3);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DYE_RAMP_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, dyeRamp([
              r,
              g,
              b
            ]));
            gl.activeTexture(gl.TEXTURE1);
            dye = look.color;
          }
          const [inkR, inkG, inkB] = readColor(look.ink);
          gl.uniform3f(u.ink, inkR / 255, inkG / 255, inkB / 255);
          gl.uniform3f(u.pivot, cx, cy, 0);
          gl.uniform3fv(u.extent, geometry.extent);
          gl.uniform1f(u.radius, radius);
          gl.uniformMatrix3fv(u.view, false, [
            view.cY,
            view.sY * view.sP,
            -view.sY * view.cP,
            0,
            view.cP,
            view.sP,
            view.sY,
            -view.cY * view.sP,
            view.facing
          ]);
          gl.viewport(0, 0, pixels, pixels);
          gl.scissor(0, 0, pixels, pixels);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          const { vertexArray, coarse, fine } = surfaceOf(shape, geometry, cell);
          const body = fineSockets ? fine : coarse;
          gl.bindVertexArray(vertexArray);
          gl.enable(gl.CULL_FACE);
          gl.uniform1i(u.pass, PASS.body);
          gl.drawElements(gl.TRIANGLES, body.count, gl.UNSIGNED_INT, 4 * body.start);
          gl.uniform1i(u.pass, PASS.shell);
          for (let layer = 1; layer <= drawnShells; layer++) {
            gl.uniform1f(u.shell, layer / shells);
            gl.drawElements(gl.TRIANGLES, coarse.count, gl.UNSIGNED_INT, 4 * coarse.start);
          }
          gl.disable(gl.CULL_FACE);
          gl.bindVertexArray(geometry.strands);
          gl.uniform1i(u.pass, PASS.strand);
          gl.uniform1f(u.strandWidth, ROOT_PASSES / strandPasses);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 8, rootsIn(geometry.strandCount, strandPasses));
          invalidateAfterTurn();
          return image;
        };
      }
      let renderer;
      function renderFluffy(shape, view, look, scale) {
        if (renderer === void 0) {
          renderer = null;
          try {
            renderer = createRenderer(() => {
              renderer = void 0;
              invalidateMaterialCache();
              requestFrame();
            });
          } catch (error) {
            console.warn("open-bot-avatar: fluffy is unavailable, drawing flat", error);
          }
        }
        return (renderer == null ? void 0 : renderer(shape, view, look, scale)) ?? null;
      }
      exports.fluffyDetail = fluffyDetail;
      exports.renderFluffy = renderFluffy;
    },
    "dom/fluffy/shaders.ts": function(__req2, exports) {
      const { DYE_RAMP_RANGE } = __req2("dom/fluffy/dye.ts");
      const { SOCKET_PAD } = __req2("dom/materials/socket.ts");
      const PASS = {
        body: 0,
        shell: 1,
        strand: 2
      };
      const float = (n) => Number.isInteger(n) ? `${n}.` : `${n}`;
      const passes = `const int BODY = ${PASS.body}, SHELL = ${PASS.shell}, STRAND = ${PASS.strand};`;
      const socketField = `
    uniform highp sampler2D eyeField;
    uniform vec4 eyeRegion[2]; // face-plane center, square span, maximum host depth
    uniform vec2 eyeSize[2];
    const float FAR = ${float(SOCKET_PAD)};

    float socketDistance(vec3 p, vec3 normal, out vec2 uv, out vec3 local) {
      uv = vec2(0.);
      local = vec3(0.);
      if (normal.z < .03 || p.z < -.05) return FAR;
      for (int i = 0; i < 2; i++) {
        vec4 e = eyeRegion[i];
        vec2 delta = p.xy - e.xy;
        if (e.z > 0. && p.z <= e.w && max(abs(delta.x), abs(delta.y)) < e.z * .49) {
          vec2 coords = delta / e.z;
          vec2 sampleUV = (coords + .5 + vec2(float(i), 0.)) * vec2(.5, 1.);
          float d = (textureLod(eyeField, sampleUV, 0.).r - .5) * ${float(2 * SOCKET_PAD)};
          if (d >= 3.77) continue;
          uv = sampleUV;
          local.xy = 2. * delta / max(eyeSize[i], vec2(.01));
          // As lids close, the pressed lip narrows with the expression.
          local.z = smoothstep(.35, 1.5, eyeSize[i].y / max(.01, eyeSize[i].x));
          return d * mix(1.5, 1., local.z);
        }
      }
      return FAR;
    }`;
      const vertexShader = `#version 300 es
    precision highp float;
    precision highp int;
    layout(location = 0) in vec3 position;
    layout(location = 1) in vec3 normal;
    layout(location = 2) in vec2 seed;
    uniform mat3 view;
    uniform vec3 pivot, extent;
    uniform float radius, shell;
    uniform float strandWidth; // 1 at full detail; wider where fewer strands are drawn
    uniform int pass;
    out vec3 P, N, V, pilePosition, lean;
    out float tip, variation, across, pocketDepth;
    ${passes}
    ${socketField}

    void main() {
      vec3 n = normalize(normal), p = position;
      vec3 rounded = (position - pivot) / extent;
      // Broadly bend the lighting normals across flat front faces of inflated paths.
      vec3 shadingNormal = normalize(n + .78 * rounded);
      pilePosition = position;
      // Sweep across the visible surface. A downwards bias keeps the front from parting at a point.
      // Project without normalizing, so foreshortened locks get shorter continuously at a grazing angle.
      float wave = .21 * sin(dot(position, vec3(.11, .045, .08))) + .14 * sin(.13 * position.y - .07 * position.z);
      float angle = .22 + .94 * (view * shadingNormal).x + wave;
      vec3 sweep = transpose(view) * vec3(sin(angle), cos(angle), .18);
      lean = sweep - n * dot(n, sweep);

      vec2 uv;
      vec3 local;
      float d = socketDistance(position, n, uv, local);
      float seat = min(1.55, max(0., position.z) * .40);
      // The rounded cap sits below the packed pile at the mouth of the socket. At grazing angles the
      // near lip progressively hides the bead.
      float dome = sqrt(max(0., 1. - dot(local.xy, local.xy)));
      float cap = mix(smoothstep(0., 1.3, -d), dome, local.z) * smoothstep(-.15, .38, -d);
      float floorDepth = 1. - smoothstep(-.15, 1.65, d);
      p.z += seat * (.56 * cap - .98 * floorDepth);
      // Compressed fibers lie along the lip. The packed undercoat fills most of their height here, so
      // the opening has a continuous, softly fuzzy edge.
      float loft = mix(.07, 1., smoothstep(.75, 3.7, d));
      float lip = smoothstep(-.10, 1., d) * (1. - smoothstep(1., 2.85, d));
      if (pass == BODY) p.z += seat * .15 * lip;
      pilePosition.z = p.z;

      tip = 0.;
      variation = .5;
      across = 0.;
      if (pass == SHELL) {
        p += n * shell * 1.10 * loft;
        p += lean * (1.05 * shell * loft);
      }
      if (pass == STRAND) {
        // Four cross-sections make a bent, tapered strand. Roots are fixed in model space.
        tip = float(gl_VertexID / 2) / 3.;
        across = float(gl_VertexID % 2) * 2. - 1.;
        vec3 tangent = normalize(cross(n, abs(n.y) < .93 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
        vec3 bitangent = cross(n, tangent);
        float flow = 2.3 * sin(.24 * p.x + .13 * p.z + sin(.22 * p.y)) + 1.3 * sin(.32 * p.y - .15 * p.x);
        float angle = flow + (seed.x - .5) * 2.6;
        vec3 comb = lean + .24 * (tangent * cos(angle) + bitangent * sin(angle));
        if (d < 3.5) {
          // Around a socket the strands lie along its edge.
          vec2 radial = normalize(local.xy * vec2(1.7, 1.) + vec2(.001));
          vec2 alongEdge = vec2(-radial.y, radial.x);
          comb.xy = mix(comb.xy, alongEdge * (dot(comb.xy, alongEdge) < 0. ? -1. : 1.), .88 * (1. - smoothstep(.4, 3.5, d)));
        }
        vec3 bend = cross(n, comb);
        float len = mix(1.6, 3.8, seed.y) * loft;
        vec3 direction = n * (.30 + .18 * tip) + comb * (.93 - .12 * tip) + bend * (seed.x - .5) * .45 * tip;
        pilePosition += comb * (.7 * len * tip);
        p += n * .52 * loft;
        float width = (.073 + .11 * seed.y) * strandWidth;
        p += .065 * n + len * tip * direction;
        vec3 screenDir = view * (direction + .06 * comb);
        vec2 widthDir = normalize(vec2(-screenDir.y, screenDir.x) + vec2(.0001, 0));
        p += transpose(view) * vec3(widthDir * across * width * (1. - .94 * tip), 0);
        shadingNormal = normalize(shadingNormal + .19 * comb);
        variation = seed.x;
      }

      vec3 projected = view * (p - pivot);
      pocketDepth = dot(position - p, n) / max(.01, seat);
      // Test displaced shells and strand tips in the socket's model-space footprint. Their visibility
      // against the bead follows actual depth.
      P = vec3(p.xy, position.z);
      N = view * shadingNormal;
      V = normal;
      gl_Position = vec4(projected.x, -projected.y, -projected.z, radius) / radius;
    }`;
      const fragmentShader = (fewerReads) => `#version 300 es
    precision highp float;
    precision highp int;
    uniform sampler2D pile;
    uniform sampler2D dyeRamp;
    uniform highp sampler3D brushedPile;
    uniform vec3 color, ink;
    uniform mat3 view;
    uniform int pass;
    uniform float shell;
    in vec3 P, N, V, pilePosition, lean;
    in float tip, variation, across, pocketDepth;
    out vec4 result;
    ${passes}
    ${socketField}

    float fiberMap(vec3 p, vec3 n) {
      vec3 w = pow(abs(n), vec3(5.));
      w /= max(.001, w.x + w.y + w.z);
      return dot(w, vec3(texture(pile, p.zy / 16.).r, texture(pile, p.xz / 16.).r, texture(pile, p.xy / 16.).r));
    }

    // Sample the same model-space roots at every view: only the direction of the short filter
    // changes. The solid coat, the shells and the strands all use this one field.
    float brushedHeight() {
      vec3 uvw = pilePosition / 15.;
      vec3 stepUV = lean * .019;
      float locks = 4. * texture(brushedPile, uvw).r;
      ${fewerReads ? `
      // The same tent as below: the reads at one and two steps, weighing 3 and 2, as one between them.
      locks += 5. * (texture(brushedPile, uvw + 1.4 * stepUV).r + texture(brushedPile, uvw - 1.4 * stepUV).r);
      locks += texture(brushedPile, uvw + 3. * stepUV).r + texture(brushedPile, uvw - 3. * stepUV).r;` : `
      for (int i = 1; i <= 3; i++) {
        vec3 delta = float(i) * stepUV;
        locks += (4. - float(i)) * (texture(brushedPile, uvw + delta).r + texture(brushedPile, uvw - delta).r);
      }`}
      float tuft = texture(brushedPile, uvw * .42).r;
      return clamp(.5 + 1.65 * (locks / 16. - .5) + .16 * (tuft - .5), 0., 1.);
    }

    void main() {
      vec3 n = normalize(N);
      vec3 light = normalize(vec3(-.52, -.83, .62));
      float diffuse = dot(n, light);
      float wrap = clamp((diffuse + .65) / 1.65, 0., 1.);
      float facingLight = clamp(.66 + .34 * diffuse, 0., 1.);
      float diffuseLevel = .87 + .13 * wrap;
      float sheen = .014 * wrap * wrap;
      float rimExposure = 1.;

      // Pile gives way to the eye.
      vec2 uv;
      vec3 local;
      float d = socketDistance(P, normalize(V), uv, local);
      if (pass == SHELL && d < .1) discard;
      if (pass == STRAND && d < .10 - .08 * variation) discard;

      float height = brushedHeight();
      // Density variation survives rim lighting even when the strongest dye channel is saturated.
      float pileFill = .925 + .075 * smoothstep(.22, .81, height);
      if (pass == STRAND) {
        // MSAA can evaluate a subpixel ribbon outside its edges at the pixel center.
        float edge = min(1., abs(across));
        float glint = smoothstep(.08, .82, tip) * (1. - .32 * edge * edge);
        diffuseLevel *= .935 + .11 * variation + .035 * clamp(tip, 0., 1.);
        sheen += (.012 + .20 * glint) * (.44 + .56 * variation) * facingLight;
      } else {
        float layer = pass == SHELL ? shell : 0.;
        // A shell keeps only the locks that reach its height.
        if (pass == SHELL && height < .21 + .59 * layer) discard;
        // The solid backing is dyed as brightly as the roots. Relief is mostly from the softly lit
        // crests of neighboring locks.
        diffuseLevel *= .895 + .16 * height + .035 * layer;
        sheen += (.012 + .13 * smoothstep(.41, .86, height) + .022 * layer) * facingLight;
        rimExposure = .80 + .34 * layer;
      }

      // A soft light behind the right shoulder grazes the pile. Weighting by view angle confines it
      // to the silhouette as the avatar turns.
      float grazing = 1. - smoothstep(.09, .83, abs(n.z));
      float backlit = smoothstep(-.20, .79, dot(n.xy, vec2(.66, -.75)));

      // Around a socket: a crease where the pile is pressed down, and light on its rolled lip.
      float upper = 0., crease = 0., pileRelief = 0., contact = 0., lipLight = 0.;
      if (d < 3.7) {
        vec2 texel = 1. / vec2(textureSize(eyeField, 0));
        vec2 g = vec2(texture(eyeField, uv + vec2(texel.x, 0)).r - texture(eyeField, uv - vec2(texel.x, 0)).r,
                      texture(eyeField, uv + vec2(0, texel.y)).r - texture(eyeField, uv - vec2(0, texel.y)).r);
        vec2 outward = g / max(length(g), .001);
        upper = dot(outward, normalize(vec2(.96, -.28)));
        float fibers = fiberMap(P, normalize(V));
        // Only material below the mouth picks up the deep socket color. Tips which cover the eye in
        // profile keep the dye of the exposed coat.
        float buried = smoothstep(-.12, .82, pocketDepth);
        crease = (1. - smoothstep(-.12, 1.65 + 1.30 * upper + .6 * (fibers - .5), d)) * mix(.24, 1., buried);
        if (pass == STRAND) {
          // The rolled lip reveals brighter tips above a darker, compressed undercoat.
          pileRelief = ((tip - .46) * .16 + (fibers - .48) * .11) * (1. - smoothstep(1.5, 3.65, d));
        }
        contact = (1. - smoothstep(-.04, .38, d)) * mix(.35, 1., buried);
        float lip = smoothstep(.03, .49, d) * (1. - smoothstep(1.10, 3.65, d));
        float gathered = clamp(.22 - .52 * outward.x + 1.14 * outward.y, 0., 1.22);
        float tipLight = .14 + .22 * fibers;
        lipLight = tipLight * gathered * lip * mix(.40, 1., local.z);
      }
      float occlusion = crease * (.76 + .18 * upper);
      float fiberLight = (sheen + .46 * grazing * backlit * rimExposure) * (1. - crease) + lipLight;
      diffuseLevel = (diffuseLevel * (1. - .48 * occlusion) + pileRelief) * (1. - (.36 + .04 * upper) * contact);

      // Light falling on the body reveals its curvature. Light caught by raised fibers can carry on
      // above the nominal exposure of the dye.
      float backing = diffuseLevel * pileFill;
      float exposure = backing * backing * (.72 + .39 * wrap) + 1.45 * fiberLight * pileFill;
      vec4 ramp = texture(dyeRamp, vec2(exposure / ${float(DYE_RAMP_RANGE)}, .5));
      vec3 base = ramp.rgb;
      if (ramp.a > 0.) {
        // On yellow, the dyed roots and the light scattered by the tips can have the same lightness
        // and still differ in color.
        float value = max(color.r, max(color.g, color.b));
        vec3 dye = color / max(value, .001);
        float weakest = min(dye.r, min(dye.g, dye.b));
        vec3 scatter = (1. - dye) * (.09 + .91 * (dye - weakest)) * clamp(1.85 * fiberLight, 0., 1.);
        float brightness = clamp(value * diffuseLevel + (.35 + .65 * value) * fiberLight, 0., 1.);
        base = mix(base, (dye + scatter) * brightness * pileFill, ramp.a);
      }

      if (pass == BODY && d < 3.7) {
        // The eye: a glossy bead in the socket.
        vec2 curve = local.xy * .94;
        vec3 dome = normalize(vec3(curve, sqrt(max(.02, 1. - dot(curve, curve)))));
        vec3 beadNormal = normalize(view * dome);
        // The high strip reflects mostly the light source. The softer side fill picks up more of the
        // nearby coat as the bead turns.
        vec2 key = beadNormal.xy - vec2(.59, -.865);
        key = vec2(key.x - .76 * key.y, key.y) / vec2(.55, .70);
        vec2 fill = beadNormal.xy - vec2(.61, -.195);
        fill = vec2(fill.x - .37 * fill.y, fill.y) / vec2(.47, 1.01);
        float stripLight = .38 * exp(-dot(key, key));
        float sideLight = .13 * exp(-dot(fill, fill));
        float coatBounce = .003 + .018 * pow(1. - clamp(beadNormal.z, 0., 1.), 1.6);
        float inkValue = max(ink.r, max(ink.g, ink.b));
        vec3 bead = ink * sqrt(inkValue) * (.40 + .24 * beadNormal.z + .24 * inkValue) + color * coatBounce;
        vec3 reflection = mix(vec3(1.), color, .28) * stripLight + mix(vec3(1.), color, .72) * sideLight;
        bead += reflection * smoothstep(-.12, .55, -d);
        float aa = max(.15, fwidth(d));
        base = mix(bead, base, smoothstep(-aa * .5, aa * .5, d));
      }
      result = vec4(base, 1.);
    }`;
      exports.PASS = PASS;
      exports.vertexShader = vertexShader;
      exports.fragmentShader = fragmentShader;
    },
    "dom/glass/renderer.ts": function(__req2, exports) {
      const { EdgeIndex } = __req2("distance.ts");
      const { edgeBands } = __req2("path.ts");
      const { requestFrame } = __req2("dom/clock.ts");
      const { invalidateMaterialCache } = __req2("dom/paint.ts");
      const { halfDepth } = __req2("dom/materials/shape.ts");
      const { SOCKET_TILE, exposedHeight, socketKey, socketRegion, socketTile } = __req2("dom/materials/socket.ts");
      const { fragmentShader, vertexShader } = __req2("dom/glass/shaders.ts");
      const isCapsule = (shape) => "radius" in shape;
      const MAX_PIXELS = 1024;
      const MIN_PIXELS = 32;
      const GRID_HI = {
        xy: 104,
        z: 36
      };
      const GRID_LO = {
        xy: 48,
        z: 18
      };
      const VOL_PAD = 4.5;
      const GLASS_REACH = 4;
      const SOCKET_RISE = 0.8;
      const SAME_VIEW = 0.06;
      const KEPT_SHAPES = 8;
      const IDLE_MS = 6e3;
      const f32 = new Float32Array(1);
      const u32 = new Uint32Array(f32.buffer);
      function toHalf(val) {
        f32[0] = val;
        const x = u32[0];
        const sign = x >> 16 & 32768;
        const exp = (x >> 23 & 255) - 127 + 15;
        const mant = x >> 13 & 1023;
        if (exp <= 0) return sign;
        if (exp >= 31) return sign | 31744;
        return sign | exp << 10 | mant;
      }
      function smax(a, b, k) {
        const h = Math.max(k - Math.abs(a - b), 0) / k;
        return Math.max(a, b) + h * h * k * 0.25;
      }
      function addGlassPart(field, part, x0, y0, z0, stepXY, stepZ, nxy, nz, firstPart) {
        const plane = nxy * nxy;
        const index = new EdgeIndex(part.polys, part.bounds);
        const bands = edgeBands(part.polys);
        const dist2d = index.distances({
          x0,
          y0,
          step: stepXY,
          nx: nxy,
          ny: nxy
        });
        const xs = Array.from({
          length: nxy
        }, (_, i) => x0 + i * stepXY);
        const row = new Uint8Array(nxy);
        const sd2d = new Float32Array(plane);
        for (let j = 0; j < nxy; j++) {
          bands.insideRow(y0 + j * stepXY, xs, row);
          const off = j * nxy;
          for (let i = 0; i < nxy; i++) {
            sd2d[off + i] = row[i] ? dist2d[off + i] : -dist2d[off + i];
          }
        }
        const joinK = 1.1;
        if ((part.kind === "revolve-x" || part.kind === "revolve-y") && part.axis !== void 0) {
          const aroundY = part.kind === "revolve-y";
          const axis = part.axis;
          const zScale = part.thickness > 0.01 ? part.depth / part.thickness : 1;
          const invZ = zScale > 0.01 ? 1 / zScale : 1;
          const scale2 = Math.min(1, zScale);
          const columns = new Int32Array(nxy);
          const weights = new Float64Array(nxy);
          for (let k = 0; k < nz; k++) {
            const z = Math.abs(z0 + k * stepZ) * invZ;
            if (aroundY || k === 0) {
              for (let i = 0; i < nxy; i++) {
                const px = aroundY ? axis + Math.hypot(xs[i] - axis, z) : xs[i];
                const fx = (px - x0) / stepXY;
                columns[i] = Math.max(0, Math.min(nxy - 2, Math.floor(fx)));
                weights[i] = Math.max(0, Math.min(1, fx - columns[i]));
              }
            }
            for (let j = 0; j < nxy; j++) {
              const y = y0 + j * stepXY;
              const py = aroundY ? y : axis + Math.hypot(y - axis, z);
              const fy = (py - y0) / stepXY;
              const iy = Math.max(0, Math.min(nxy - 2, Math.floor(fy)));
              const ty = Math.max(0, Math.min(1, fy - iy));
              const off = k * plane + j * nxy;
              for (let i = 0; i < nxy; i++) {
                const o = iy * nxy + columns[i];
                const tx = weights[i];
                const a = sd2d[o] * (1 - tx) + sd2d[o + 1] * tx;
                const b = sd2d[o + nxy] * (1 - tx) + sd2d[o + nxy + 1] * tx;
                const d = (a * (1 - ty) + b * ty) * scale2;
                const at = off + i;
                field[at] = firstPart ? d : smax(field[at], d, joinK);
              }
            }
          }
          return;
        }
        const half = part.depth / 2;
        const rxy = Math.max(1.2, part.rxy);
        const rz = Math.max(1.2, part.rz);
        const scale = Math.min(rxy, rz);
        const flatZ = Math.max(0, half - rz);
        const rCap = rxy * 1.08;
        const smoothL = Math.max(stepXY * 1.4, Math.min(rxy * 0.28, 3.4));
        const cLap = 2 * (smoothL / stepXY) * (smoothL / stepXY);
        const pb = part.bounds;
        const iMin = Math.max(1, Math.floor((pb.minX - x0) / stepXY) - 1);
        const iMax = Math.min(nxy - 2, Math.ceil((pb.maxX - x0) / stepXY) + 1);
        const jMin = Math.max(1, Math.floor((pb.minY - y0) / stepXY) - 1);
        const jMax = Math.min(nxy - 2, Math.ceil((pb.maxY - y0) / stepXY) + 1);
        const sSmooth = new Float32Array(plane);
        for (let j = jMin; j <= jMax; j++) {
          const off = j * nxy;
          for (let i = iMin; i <= iMax; i++) {
            const sd = sd2d[off + i];
            if (sd > 0) sSmooth[off + i] = Math.min(sd, rCap);
          }
        }
        const omega = 1.25;
        for (let iter = 0; iter < 16; iter++) {
          for (let j = jMin; j <= jMax; j++) {
            const off = j * nxy;
            for (let i = iMin; i <= iMax; i++) {
              const idx = off + i;
              const sd = sd2d[idx];
              if (sd <= 0) continue;
              const sdL = sd2d[idx - 1];
              const sdR = sd2d[idx + 1];
              const sdU = sd2d[idx - nxy];
              const sdD = sd2d[idx + nxy];
              const tL = sdL > 0 ? 1 : Math.max(0.15, sd / (sd - sdL));
              const tR = sdR > 0 ? 1 : Math.max(0.15, sd / (sd - sdR));
              const tU = sdU > 0 ? 1 : Math.max(0.15, sd / (sd - sdU));
              const tD = sdD > 0 ? 1 : Math.max(0.15, sd / (sd - sdD));
              const vL = sdL > 0 ? sSmooth[idx - 1] : 0;
              const vR = sdR > 0 ? sSmooth[idx + 1] : 0;
              const vU = sdU > 0 ? sSmooth[idx - nxy] : 0;
              const vD = sdD > 0 ? sSmooth[idx + nxy] : 0;
              const denom = 1 + cLap * (1 / (tL * tR) + 1 / (tU * tD));
              const numer = Math.min(sd, rCap) + cLap * (vL / (tL * (tL + tR)) + vR / (tR * (tL + tR)) + vU / (tU * (tU + tD)) + vD / (tD * (tU + tD)));
              const next = numer / denom;
              sSmooth[idx] += omega * (next - sSmooth[idx]);
            }
          }
        }
        for (let j = 0; j < nxy; j++) {
          const off = j * nxy;
          for (let i = 0; i < nxy; i++) {
            const sd = sd2d[off + i];
            const sdEff = sd > 0 ? sSmooth[off + i] : sd;
            const crown = sd > 0 ? 0.055 * sdEff : 0;
            const side = smax((rxy - sdEff) / rxy, 0, 0.28);
            for (let k = 0; k < nz; k++) {
              const z = Math.abs(z0 + k * stepZ);
              const top = Math.max(0, (z - (flatZ + crown)) / rz);
              const d = (1 - Math.hypot(side, top)) * scale;
              const at = off + i + k * plane;
              field[at] = firstPart ? d : smax(field[at], d, joinK);
            }
          }
        }
      }
      function bakeVolume3D(vol, nxy, nz) {
        const b = vol.bounds;
        const maxHalfZ = Math.max(2, ...vol.parts.map((p) => p.depth / 2)) + 1;
        const spanX = b.maxX - b.minX + 2 * VOL_PAD;
        const spanY = b.maxY - b.minY + 2 * VOL_PAD;
        const spanXY = Math.max(spanX, spanY);
        const cx = (b.minX + b.maxX) / 2;
        const cy = (b.minY + b.maxY) / 2;
        const x0 = cx - spanXY / 2;
        const y0 = cy - spanXY / 2;
        const stepXY = spanXY / (nxy - 1);
        const zMax = maxHalfZ + VOL_PAD;
        const stepZ = zMax / (nz - 2);
        const z0 = -stepZ;
        const spanZ = stepZ * (nz - 1);
        const plane = nxy * nxy;
        let field = new Float32Array(plane * nz).fill(-1e3);
        vol.parts.forEach((part, idx) => {
          addGlassPart(field, part, x0, y0, z0, stepXY, stepZ, nxy, nz, idx === 0);
        });
        let tmp = new Float32Array(field.length);
        for (let pass = 0; pass < 3; pass++) {
          for (let k = 0; k < nz; k++) {
            const ko = k * plane;
            for (let j = 0; j < nxy; j++) {
              const ro = ko + j * nxy;
              for (let i = 0; i < nxy; i++) {
                const im = i > 0 ? i - 1 : 0;
                const ip = i < nxy - 1 ? i + 1 : nxy - 1;
                tmp[ro + i] = 0.13 * field[ro + im] + 0.74 * field[ro + i] + 0.13 * field[ro + ip];
              }
            }
          }
          for (let k = 0; k < nz; k++) {
            const ko = k * plane;
            for (let j = 0; j < nxy; j++) {
              const jm = ko + (j > 0 ? j - 1 : 0) * nxy;
              const j0 = ko + j * nxy;
              const jp = ko + (j < nxy - 1 ? j + 1 : nxy - 1) * nxy;
              for (let i = 0; i < nxy; i++) {
                field[j0 + i] = 0.13 * tmp[jm + i] + 0.74 * tmp[j0 + i] + 0.13 * tmp[jp + i];
              }
            }
          }
          for (let k = 1; k < nz; k++) {
            const km = (k === 1 ? 2 : k - 1) * plane;
            const k0 = k * plane;
            const kp = (k < nz - 1 ? k + 1 : nz - 1) * plane;
            for (let p = 0; p < plane; p++) {
              tmp[k0 + p] = 0.13 * field[km + p] + 0.74 * field[k0 + p] + 0.13 * field[kp + p];
            }
          }
          for (let p = 0; p < plane; p++) tmp[p] = tmp[2 * plane + p];
          [field, tmp] = [
            tmp,
            field
          ];
        }
        const data = new Uint16Array(field.length);
        for (let i = 0; i < field.length; i++) data[i] = toHalf(field[i]);
        return {
          data,
          boxMin: [
            x0,
            y0,
            z0
          ],
          boxSpan: [
            spanXY,
            spanXY,
            spanZ
          ],
          voxelStep: [
            stepXY,
            stepZ
          ],
          halfDepth: maxHalfZ,
          bottomY: b.maxY
        };
      }
      function link(gl, vertex, fragment) {
        const program = gl.createProgram();
        for (const [kind, source] of [
          [
            gl.VERTEX_SHADER,
            vertex
          ],
          [
            gl.FRAGMENT_SHADER,
            fragment
          ]
        ]) {
          const shader = gl.createShader(kind);
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "glass shader compilation failed");
          gl.attachShader(program, shader);
          gl.deleteShader(shader);
        }
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "glass shader linking failed");
        return program;
      }
      function colorReader() {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d", {
          willReadFrequently: true
        });
        const known = /* @__PURE__ */ new Map();
        return (color) => {
          let rgb = known.get(color);
          if (!rgb) {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = "#000";
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            rgb = [
              r,
              g,
              b
            ];
            if (known.size >= 64) known.clear();
            known.set(color, rgb);
          }
          return rgb;
        };
      }
      function createRenderer(onContextRestored) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = MIN_PIXELS;
        const gl = canvas.getContext("webgl2", {
          alpha: true,
          antialias: false,
          premultipliedAlpha: true,
          preserveDrawingBuffer: false
        });
        if (!gl) return null;
        canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
        canvas.addEventListener("webglcontextrestored", onContextRestored);
        const program = link(gl, vertexShader, fragmentShader);
        gl.useProgram(program);
        const uniform = (name) => gl.getUniformLocation(program, name);
        const u = {
          volumeField: uniform("volumeField"),
          eyeField: uniform("eyeField"),
          boxMin: uniform("boxMin"),
          boxSpan: uniform("boxSpan"),
          voxelStep: uniform("voxelStep"),
          pivot: uniform("pivot"),
          radius: uniform("radius"),
          halfDepth: uniform("halfDepth"),
          bottomY: uniform("bottomY"),
          pixelSize: uniform("pixelSize"),
          isCapsule: uniform("isCapsule"),
          capsuleDims: uniform("capsuleDims"),
          view: uniform("view"),
          color: uniform("color"),
          ink: uniform("ink"),
          eyeRegion: uniform("eyeRegion[0]"),
          eyeSize: uniform("eyeSize[0]")
        };
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.enable(gl.SCISSOR_TEST);
        gl.uniform1i(u.volumeField, 0);
        gl.activeTexture(gl.TEXTURE1);
        const eyeTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, eyeTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, 2 * SOCKET_TILE, SOCKET_TILE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(u.eyeField, 1);
        const dummyTex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_3D, dummyTex);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.R16F, 1, 1, 1, 0, gl.RED, gl.HALF_FLOAT, new Uint16Array([
          0
        ]));
        const shapes = /* @__PURE__ */ new Map();
        let sweepPending = false;
        const upload = (shape, grid) => {
          const b = shape.bounds;
          const rx = (b.maxX - b.minX) / 2;
          const ry = (b.maxY - b.minY) / 2;
          const cx = b.minX + rx;
          const cy = b.minY + ry;
          if (isCapsule(shape)) {
            const rz = halfDepth(shape);
            const radius2 = Math.ceil(Math.hypot(rx, ry, rz) + GLASS_REACH);
            return {
              texture: null,
              gridXY: 1,
              boxMin: [
                0,
                0,
                0
              ],
              boxSpan: [
                1,
                1,
                1
              ],
              voxelStep: [
                1,
                1
              ],
              cx,
              cy,
              bottomY: b.maxY,
              radius: radius2,
              halfDepth: rz,
              capsule: true,
              capsuleDims: [
                shape.radius,
                Math.max(0, b.maxY - shape.radius)
              ],
              usedAt: 0
            };
          }
          const baked = bakeVolume3D(shape, grid.xy, grid.z);
          const radius = Math.ceil(Math.hypot(rx, ry, baked.halfDepth) + GLASS_REACH);
          const tex = gl.createTexture();
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_3D, tex);
          gl.texImage3D(gl.TEXTURE_3D, 0, gl.R16F, grid.xy, grid.xy, grid.z, 0, gl.RED, gl.HALF_FLOAT, baked.data);
          gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
          return {
            texture: tex,
            gridXY: grid.xy,
            boxMin: baked.boxMin,
            boxSpan: baked.boxSpan,
            voxelStep: baked.voxelStep,
            cx,
            cy,
            bottomY: baked.bottomY,
            radius,
            halfDepth: baked.halfDepth,
            capsule: false,
            capsuleDims: [
              0,
              0
            ],
            usedAt: 0
          };
        };
        const sweep = () => {
          const now = performance.now();
          for (const [shape, baked] of shapes) {
            if (shapes.size <= KEPT_SHAPES) return;
            if (now - baked.usedAt < IDLE_MS) continue;
            if (baked.texture) gl.deleteTexture(baked.texture);
            shapes.delete(shape);
          }
          if (!sweepPending) {
            sweepPending = true;
            setTimeout(() => {
              sweepPending = false;
              sweep();
            }, IDLE_MS);
          }
        };
        const shapeOf = (shape, wantHi) => {
          const desired = wantHi ? GRID_HI : GRID_LO;
          let baked = shapes.get(shape);
          if (baked && (!wantHi || baked.gridXY >= GRID_HI.xy || baked.capsule)) {
            shapes.delete(shape);
          } else {
            if (baked == null ? void 0 : baked.texture) gl.deleteTexture(baked.texture);
            baked = upload(shape, desired);
          }
          shapes.set(shape, baked);
          baked.usedAt = performance.now();
          if (shapes.size > KEPT_SHAPES) sweep();
          return baked;
        };
        const regions = new Float32Array(8);
        const sizes = new Float32Array(4);
        const scratch = document.createElement("canvas");
        scratch.width = scratch.height = SOCKET_TILE;
        const scratchCtx = scratch.getContext("2d", {
          willReadFrequently: true
        });
        const tiles = /* @__PURE__ */ new Map();
        const tileOf = (mark, key) => {
          let tile = tiles.get(key);
          if (!tile) {
            tile = socketTile(scratchCtx, mark);
            if (tiles.size >= 48) tiles.delete(tiles.keys().next().value);
            tiles.set(key, tile);
          }
          return tile;
        };
        const readColor = colorReader();
        const shown = {
          baked: null,
          view: null,
          pixels: 0,
          color: "",
          ink: "",
          regions: new Float32Array(8),
          contours: [
            "",
            ""
          ]
        };
        let resetQueued = false;
        const invalidateAfterTurn = () => {
          if (resetQueued) return;
          resetQueued = true;
          queueMicrotask(() => {
            resetQueued = false;
            shown.view = null;
          });
        };
        return (shape, view, look, scale) => {
          if (gl.isContextLost()) return null;
          const baked = shapeOf(shape, scale >= 1.4);
          const { cx, cy, radius } = baked;
          const pixels = Math.min(MAX_PIXELS, Math.max(MIN_PIXELS, Math.ceil(2 * radius * scale)));
          if (canvas.width < pixels) canvas.width = canvas.height = pixels;
          const image = {
            canvas,
            x: 0,
            y: canvas.height - pixels,
            size: pixels,
            cx,
            cy,
            radius
          };
          const eyeZ = "eyeZ" in shape ? shape.eyeZ : [];
          regions.fill(0);
          const contours = [
            "",
            ""
          ];
          look.eyes.forEach(({ mark, dx, dy }, slot) => {
            const region = socketRegion(mark);
            regions.set([
              region.cx + dx,
              region.cy + dy,
              region.span,
              (eyeZ[slot] ?? 0) + SOCKET_RISE
            ], 4 * slot);
            sizes.set([
              region.w,
              region.h * exposedHeight(region.w, region.h)
            ], 2 * slot);
            contours[slot] = socketKey(mark);
          });
          const turn = shown.view ? Math.abs(view.cY - shown.view.cY) + Math.abs(view.sY - shown.view.sY) + Math.abs(view.sP - shown.view.sP) + Math.abs(view.cP - shown.view.cP) : Infinity;
          if (shown.baked === baked && shown.pixels === pixels && shown.color === look.color && shown.ink === look.ink && contours.every((k, slot) => k === shown.contours[slot]) && regions.every((v, i) => v === shown.regions[i]) && turn < SAME_VIEW / (radius * scale)) {
            return image;
          }
          shown.baked = baked;
          shown.view = view;
          shown.pixels = pixels;
          shown.color = look.color;
          shown.ink = look.ink;
          shown.regions.set(regions);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, eyeTex);
          look.eyes.forEach(({ mark }, slot) => {
            if (contours[slot] === shown.contours[slot]) return;
            gl.texSubImage2D(gl.TEXTURE_2D, 0, slot * SOCKET_TILE, 0, SOCKET_TILE, SOCKET_TILE, gl.RED, gl.UNSIGNED_BYTE, tileOf(mark, contours[slot]));
          });
          shown.contours = contours;
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_3D, baked.texture ?? dummyTex);
          gl.uniform4fv(u.eyeRegion, regions);
          gl.uniform2fv(u.eyeSize, sizes);
          gl.uniform3fv(u.boxMin, baked.boxMin);
          gl.uniform3fv(u.boxSpan, baked.boxSpan);
          gl.uniform2fv(u.voxelStep, baked.voxelStep);
          gl.uniform3f(u.pivot, cx, cy, 0);
          gl.uniform1f(u.radius, radius);
          gl.uniform1f(u.halfDepth, baked.halfDepth);
          gl.uniform1f(u.bottomY, baked.bottomY);
          gl.uniform1f(u.pixelSize, 2 * radius / pixels);
          gl.uniform1i(u.isCapsule, baked.capsule ? 1 : 0);
          gl.uniform2fv(u.capsuleDims, baked.capsuleDims);
          const [r, g, b] = readColor(look.color);
          gl.uniform3f(u.color, r / 255, g / 255, b / 255);
          const [inkR, inkG, inkB] = readColor(look.ink);
          gl.uniform3f(u.ink, inkR / 255, inkG / 255, inkB / 255);
          gl.uniformMatrix3fv(u.view, false, [
            view.cY,
            view.sY * view.sP,
            -view.sY * view.cP,
            0,
            view.cP,
            view.sP,
            view.sY,
            -view.cY * view.sP,
            view.facing
          ]);
          gl.viewport(0, 0, pixels, pixels);
          gl.scissor(0, 0, pixels, pixels);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          invalidateAfterTurn();
          return image;
        };
      }
      let renderer;
      function renderGlass(shape, view, look, scale) {
        if (renderer === void 0) {
          renderer = null;
          try {
            renderer = createRenderer(() => {
              renderer = void 0;
              invalidateMaterialCache();
              requestFrame();
            });
          } catch (error) {
            console.warn("open-bot-avatar: glass is unavailable, drawing flat", error);
          }
        }
        return (renderer == null ? void 0 : renderer(shape, view, look, scale)) ?? null;
      }
      exports.renderGlass = renderGlass;
    },
    "dom/glass/shaders.ts": function(__req2, exports) {
      const { SOCKET_PAD } = __req2("dom/materials/socket.ts");
      const float = (n) => Number.isInteger(n) ? `${n}.` : `${n}`;
      const vertexShader = `#version 300 es
    precision highp float;
    const vec2 POS[3] = vec2[](vec2(-1., -1.), vec2(3., -1.), vec2(-1., 3.));
    out vec2 vNdc;
    void main() {
      gl_Position = vec4(POS[gl_VertexID], 0., 1.);
      vNdc = POS[gl_VertexID];
    }`;
      const fragmentShader = `#version 300 es
    precision highp float;
    precision highp int;

    in vec2 vNdc;
    out vec4 result;

    uniform highp sampler3D volumeField; // R16F 3D SDF (positive inside, z >= 0 mirrored)
    uniform highp sampler2D eyeField;    // socket.ts signed distance tiles
    uniform vec3 boxMin;                 // (x0, y0, z0) in viewBox units
    uniform vec3 boxSpan;                // (spanX, spanY, spanZ) in viewBox units
    uniform vec2 voxelStep;              // (stepXY, stepZ) for smooth normal gradients
    uniform vec3 pivot;                  // (cx, cy, 0) in viewBox units
    uniform float radius;                // half-size of orthographic render square, viewBox units
    uniform float halfDepth;             // max half depth, viewBox units
    uniform float bottomY;               // bottom of avatar bounds, viewBox units
    uniform float pixelSize;             // viewBox units per pixel
    uniform int isCapsule;               // 1 for state marks (thinking dots / blocked bar)
    uniform vec2 capsuleDims;            // (radius, halfStem) for capsule marks
    uniform mat3 view;                   // yaw-then-pitch rotation matrix (model -> screen, Y-down)
    uniform vec3 color;                  // glass tint color (0..1)
    uniform vec3 ink;                    // eye ink color (0..1)
    uniform vec4 eyeRegion[2];           // face-plane center, square span, max host depth
    uniform vec2 eyeSize[2];

    const float FAR = ${float(SOCKET_PAD)};
    const float IOR = 1.50;
    const float F0  = 0.04;

    // Exact 3D Signed Distance (negative inside, positive outside) directly from Volume.parts!
    float mapSDF(vec3 p) {
      if (isCapsule == 1) {
        vec3 q = p - pivot;
        q.y -= clamp(q.y, -capsuleDims.y, capsuleDims.y);
        return length(q) - capsuleDims.x;
      }
      vec3 q = vec3(p.x, p.y, abs(p.z));
      vec3 boxMax = boxMin + boxSpan;
      vec3 cl = clamp(q, boxMin, boxMax);
      vec3 outVec = q - cl;
      float outDist = length(outVec);

      // Sample 3D texture at clamped coordinates; map texel centers [0..N-1] accurately
      vec3 texSize = vec3(textureSize(volumeField, 0));
      vec3 norm = (cl - boxMin) / boxSpan;
      vec3 uvw = (norm * (texSize - 1.0) + 0.5) / texSize;
      float sdInsidePos = texture(volumeField, uvw).r;

      if (outDist > 0.0001) {
        return max(-sdInsidePos, 0.0) + outDist;
      }
      return -sdInsidePos;
    }

    // Exact 6-tap central-difference gradient over the 3D SDF (correctly scaled for anisotropic voxelStep,
    // zero mixed-derivative contamination at concave grooves/corners!).
    vec3 calcNormalStride(vec3 p, float mult) {
      if (isCapsule == 1) {
        const float e = 0.12;
        return normalize(vec3(
          mapSDF(p + vec3(e, 0., 0.)) - mapSDF(p - vec3(e, 0., 0.)),
          mapSDF(p + vec3(0., e, 0.)) - mapSDF(p - vec3(0., e, 0.)),
          mapSDF(p + vec3(0., 0., e)) - mapSDF(p - vec3(0., 0., e))
        ));
      }
      float hx = voxelStep.x * mult;
      float hz = voxelStep.y * mult;
      vec3 g = vec3(
        (mapSDF(p + vec3(hx, 0., 0.)) - mapSDF(p - vec3(hx, 0., 0.))) / hx,
        (mapSDF(p + vec3(0., hx, 0.)) - mapSDF(p - vec3(0., hx, 0.))) / hx,
        (mapSDF(p + vec3(0., 0., hz)) - mapSDF(p - vec3(0., 0., hz))) / hz
      );
      float len = length(g);
      return len > 1e-5 ? g / len : vec3(0.0, 0.0, 1.0);
    }

    vec3 calcNormal(vec3 p) {
      return calcNormalStride(p, 0.90);
    }

    // Eye socket distance field (same coordinates as fluffy/shaders.ts)
    float socketDistance(vec3 p, vec3 normal, out vec2 uv, out vec3 local) {
      uv = vec2(0.);
      local = vec3(0.);
      if (normal.z < 0.05 || p.z < 0.0) return FAR;
      for (int i = 0; i < 2; i++) {
        vec4 e = eyeRegion[i];
        vec2 delta = p.xy - e.xy;
        if (e.z > 0. && p.z <= e.w + 2.5 && max(abs(delta.x), abs(delta.y)) < e.z * 0.49) {
          vec2 coords = delta / e.z;
          vec2 sampleUV = (coords + 0.5 + vec2(float(i), 0.)) * vec2(0.5, 1.0);
          float d = (textureLod(eyeField, sampleUV, 0.).r - 0.5) * ${float(2 * SOCKET_PAD)};
          if (d >= 3.6) continue;
          uv = sampleUV;
          local.xy = 2.0 * delta / max(eyeSize[i], vec2(0.01));
          local.z = smoothstep(0.35, 1.5, eyeSize[i].y / max(0.01, eyeSize[i].x));
          return d;
        }
      }
      return FAR;
    }

    float softbox(vec3 dir, vec3 center, vec2 halfSize, float softness, float tilt) {
      vec3 c = normalize(center);
      float f = dot(dir, c);
      if (f <= 0.05) return 0.0;
      vec3 up = abs(c.y) < 0.92 ? vec3(0., -1., 0.) : vec3(1., 0., 0.);
      vec3 u = normalize(cross(up, c));
      vec3 v = cross(c, u);
      vec2 proj = vec2(dot(dir, u), dot(dir, v)) / max(f, 0.25);
      float ct = cos(tilt), st = sin(tilt);
      proj = mat2(ct, -st, st, ct) * proj;
      vec2 q = abs(proj) - halfSize;
      float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
      return 1.0 - smoothstep(-softness, softness, dist);
    }

    float fresnelSchlick(float cosTheta) {
      return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
    }

    // --- Smooth Dual-Roughness 3D Studio Environment ---
    vec3 sampleOuterStudio(vec3 dirS, vec3 jewelTint) {
      vec3 d = normalize(dirS);

      // Color-accurate quiet dark studio gradient
      float upFade = smoothstep(0.9, -0.9, d.y);
      vec3 baseRoom = mix(vec3(0.020), jewelTint * 0.14, 0.42) * (0.65 + 0.55 * upFade);
      float floorBounce = pow(clamp(d.y, 0.0, 1.0), 2.2);
      vec3 col = baseRoom + jewelTint * (0.42 * floorBounce);

      // Deliberate HDR White Studio Softboxes (exact convex-dome reflection angles, smoothly feathered borders)
      float keyMain      = softbox(d, vec3(-0.60, -0.74, -0.30), vec2(0.70, 0.155), 0.090, -0.52);
      float keyRim       = softbox(d, vec3(-0.24, -0.76, -0.60), vec2(0.70, 0.095), 0.075, -0.22);
      float leftShoulder = softbox(d, vec3(-0.94, -0.06, -0.32), vec2(0.105, 0.28), 0.078,  0.05);
      float leftHip      = softbox(d, vec3(-0.88,  0.42, -0.24), vec2(0.095, 0.18), 0.085, -0.18);
      float rightDome    = softbox(d, vec3( 0.56, -0.70, -0.44), vec2(0.46, 0.085), 0.080,  0.42);
      float rightStrip   = softbox(d, vec3( 0.84, -0.18, -0.50), vec2(0.095, 0.52), 0.080,  0.14);

      // Soft perimeter rim fill so curved bevels & cylindrical walls gleam smoothly at every rotation
      float sideGlow = pow(clamp(1.0 - abs(d.z), 0.0, 1.0), 1.8) * (0.55 + 0.45 * smoothstep(0.6, -0.7, d.y));
      col += vec3(1.0) * (keyMain * 13.0 + keyRim * 8.0 + leftShoulder * 7.0 + leftHip * 4.5 + rightDome * 7.2 + rightStrip * 7.8);
      col += mix(jewelTint, vec3(0.95, 1.0, 1.0), 0.48) * (sideGlow * 1.15);

      return col;
    }

    vec3 sampleInternalStudio(vec3 posS, vec3 dirS, vec3 jewelTint, float isTIR) {
      vec3 d = normalize(dirS);

      // Silky continuous studio cyclorama (color-accurate, zero hard horizon line)
      float upFade = smoothstep(1.0, -1.0, d.y);
      vec3 col = mix(vec3(0.022), jewelTint * 0.22, 0.55) * (0.65 + 0.50 * upFade);

      // Smoothly feathered caustic tabletop bounce beneath the figurine
      float floorRelY = (bottomY - pivot.y) + 2.8;
      if (d.y > -0.05) {
        float dySafe = max(d.y, 0.08);
        float tFloor = clamp((floorRelY - posS.y) / dySafe, 0.0, 260.0);
        vec3 fp = posS + d * tFloor;
        float r2 = dot(fp.xz, fp.xz) / (radius * radius * 0.60);
        float causticPool = exp(-r2 * 0.85);
        float hotCore     = exp(-r2 * 2.4);
        float floorFade   = smoothstep(-0.05, 0.42, d.y);
        col += jewelTint * (1.05 * causticPool + 0.48 * hotCore) * floorFade;
      }

      // Broad, ultra-soft studio light dome for luminous internal refraction & TIR
      float upperLeft = pow(max(0.0, dot(d, normalize(vec3(-0.55, -0.72, -0.42)))), 3.2);
      float rightRim  = pow(max(0.0, dot(d, normalize(vec3( 0.82, -0.25, -0.52)))), 3.6);
      float leftRim   = pow(max(0.0, dot(d, normalize(vec3(-0.88,  0.12, -0.46)))), 3.4);
      float topGlow   = pow(max(0.0, dot(d, normalize(vec3( 0.05, -0.92, -0.38)))), 3.0);

      float tirBoost = mix(0.92, 1.22, isTIR);
      col += mix(jewelTint, vec3(1.0), 0.52) * (upperLeft * 1.45 + rightRim * 1.15 + leftRim * 1.05 + topGlow * 1.10) * tirBoost;

      return col;
    }

    // Trace one ray through the exact 3D Volume SDF (front hit -> up to 3 internal bounces + Beer-Lambert!)
    vec4 traceRay(vec2 screenXY, mat3 invView, vec3 jewelTint, vec3 absorbSigma) {
      vec3 rdS = vec3(0.0, 0.0, -1.0);
      vec3 roS = vec3(screenXY, radius * 1.25);
      vec3 ro = pivot + invView * roS;
      vec3 rd = invView * rdS;

      vec3 oc = ro - pivot;
      float b = dot(oc, rd);
      float c = dot(oc, oc) - radius * radius;
      float disc = b * b - c;
      if (disc < 0.0) return vec4(0.0);

      float tMin = max(0.0, -b - sqrt(disc));
      float tMax = -b + sqrt(disc);
      float t = tMin;
      float tPrev = tMin;
      bool hit = false;

      for (int i = 0; i < 64; i++) {
        float d = mapSDF(ro + rd * t);
        if (d <= 0.004) {
          if (d <= 0.0) {
            hit = true;
            break;
          }
          // Verify genuine surface crossing (prevents midair false hits grazing flat parallel walls!)
          float tProbe = min(tMax, t + 0.06);
          if (mapSDF(ro + rd * tProbe) <= 0.0) {
            tPrev = t;
            t = tProbe;
            hit = true;
            break;
          }
        }
        tPrev = t;
        t += max(d * 0.82, 0.08);
        if (t > tMax) break;
      }
      if (!hit) return vec4(0.0);

      // 6-step bisection on strictly bracketed mapSDF = 0 crossing for razor-clean hit point & normals
      float lo = tPrev, hi = t;
      for (int i = 0; i < 6; i++) {
        float mid = 0.5 * (lo + hi);
        if (mapSDF(ro + rd * mid) <= 0.0) hi = mid;
        else lo = mid;
      }
      t = hi;

      vec3 p1 = ro + rd * t;
      vec3 n1 = calcNormal(p1);
      vec3 n1S = normalize(view * n1);
      vec3 p1S = view * (p1 - pivot);
      float cos1 = clamp(dot(-rd, n1), 0.0, 1.0);
      float F1 = fresnelSchlick(cos1);

      // --- Opaque Glossy Black Eyes seated cleanly on the front glass surface ---
      float eyeMask = 0.0;
      vec3 eyeColor = vec3(0.0);
      float eyeBezel = 0.0;
      if (isCapsule == 0) {
        vec2 eyeUV;
        vec3 local;
        float dEye = socketDistance(p1, n1, eyeUV, local);
        if (dEye < 1.8) {
          float lip = smoothstep(0.95, 0.04, dEye) * smoothstep(-0.06, 0.18, dEye);
          float lowerRight = smoothstep(-0.25, 0.85, local.y * 0.80 + local.x * 0.45);
          eyeBezel = lip * lowerRight;

          if (dEye < 0.35) {
            vec2 curve = clamp(local.xy * 0.90, vec2(-0.96), vec2(0.96));
            vec3 dome = normalize(vec3(curve, sqrt(max(0.04, 1.0 - dot(curve, curve)))));
            vec3 beadN = normalize(view * dome);
            vec3 beadRefl = reflect(rdS, beadN);
            float beadSpec = softbox(beadRefl, vec3(-0.52, -0.68, 0.52), vec2(0.22, 0.28), 0.10, -0.35);
            eyeColor = ink * 0.12 + vec3(1.0) * (beadSpec * 1.45);
            float aa = max(0.10, pixelSize * 1.2);
            eyeMask = 1.0 - smoothstep(-aa * 0.5, aa * 0.5, dEye);
          }
        }
      }

      // --- 1. External Fresnel Reflection (crisp un-tinted HDR studio softboxes) ---
      vec3 reflDirS = reflect(rdS, n1S);
      vec3 extRefl = sampleOuterStudio(reflDirS, jewelTint);
      vec3 accum = extRefl * F1;

      // --- 2. Physical Internal Glass Path (Snell Refraction + Back-Wall Exit + Continuous Maxwell TIR) ---
      vec3 rayPos = p1 - n1 * 0.05;
      vec3 rayDir = refract(rd, n1, 1.0 / IOR);
      float weight = 1.0 - F1;
      float directTrans = 0.0;
      float tirEnergy = 0.0;

      if (length(rayDir) < 0.001) {
        rayDir = reflect(rd, n1);
        accum += sampleOuterStudio(view * rayDir, jewelTint) * weight;
      } else {
        rayDir = normalize(rayDir);
        vec3 pStart = rayPos + rayDir * 0.05;

        if (mapSDF(pStart) > 0.0) {
          // Sub-pixel razor-thin grazing edge: clean pass-through with no false bounce
          vec3 exitDirS = normalize(view * rayDir);
          vec3 envOut = sampleInternalStudio(p1S, exitDirS, jewelTint, 0.0);
          accum += envOut * weight;
          directTrans = weight * smoothstep(0.10, -0.70, exitDirS.z);
        } else {
          float s = 0.0;
          float sPrev = 0.0;
          float maxDist = max(halfDepth * 4.5, radius * 2.4);
          bool exited = false;

          for (int stepIdx = 0; stepIdx < 64; stepIdx++) {
            vec3 q = pStart + rayDir * s;
            float d = mapSDF(q);
            if (d > 0.0) {
              exited = true;
              break;
            }
            sPrev = s;
            s += max(-d * 0.82, 0.12);
            if (s > maxDist) break;
          }

          if (exited) {
            float lo = sPrev, hi = s;
            for (int bStep = 0; bStep < 5; bStep++) {
              float mid = 0.5 * (lo + hi);
              if (mapSDF(pStart + rayDir * mid) > 0.0) hi = mid;
              else lo = mid;
            }
            s = hi;
          }

          float totalPath = s + 0.06;
          vec3 pExit = pStart + rayDir * s;
          vec3 pExitS = view * (pExit - pivot);

          // Smooth optical thickness compression so thick bodies stay just as crystal-clear as thin ears
          float refScale = max(halfDepth * 2.2, 14.0);
          float opticalDist = totalPath / (refScale + totalPath * 0.30);
          vec3 beer = exp(-absorbSigma * opticalDist);

          if (!exited) {
            vec3 exitDirS = normalize(view * rayDir);
            accum += sampleInternalStudio(pExitS, exitDirS, jewelTint, 0.0) * beer * weight;
            directTrans = weight * smoothstep(0.10, -0.70, exitDirS.z);
          } else {
            vec3 nOut = calcNormalStride(pExit, 1.15);
            vec3 nIn = -nOut;
            vec3 reflDir = normalize(reflect(rayDir, nIn));
            vec3 reflEnv = sampleInternalStudio(pExitS, view * reflDir, jewelTint, 1.0);
            vec3 beerTIR = exp(-absorbSigma * (opticalDist * 1.22));

            vec3 exitDir = refract(rayDir, nIn, IOR);
            if (length(exitDir) < 0.001) {
              // Pure Total Internal Reflection (smoothly joined with F_exit -> 1.0 below!)
              tirEnergy = weight * 0.65;
              accum += reflEnv * beerTIR * weight;
            } else {
              exitDir = normalize(exitDir);
              // Exact Maxwell/Schlick Fresnel for glass->air using transmitted air-side cosine (zero TIR cliff!)
              float cosTrans = clamp(dot(exitDir, nOut), 0.0, 1.0);
              float F_exit = fresnelSchlick(cosTrans);

              vec3 exitDirS = normalize(view * exitDir);
              vec3 envOut = sampleInternalStudio(pExitS, exitDirS, jewelTint, 0.0);
              float exitWeight = weight * (1.0 - F_exit);
              float reflWeight = weight * F_exit;

              accum += envOut * beer * exitWeight + reflEnv * beerTIR * reflWeight;
              directTrans = exitWeight * smoothstep(0.10, -0.70, exitDirS.z);
              tirEnergy = reflWeight * 0.65;
            }
          }
        }
      }

      accum += mix(jewelTint, vec3(1.0), 0.55) * (eyeBezel * 1.05);

      float peak = max(accum.r, max(accum.g, accum.b));
      vec3 col = accum;
      if (peak > 0.0001) {
        float mapped = peak / (1.0 + peak * 0.48);
        col = accum * (mapped / peak);
        float whiteRoll = smoothstep(2.2, 5.2, peak);
        col = mix(col, vec3(mapped), whiteRoll * 0.80);
      }

      float lum = max(col.r, max(col.g, col.b));
      float edgeTransparency = mix(0.36, 0.68, pow(1.0 - cos1, 1.55));
      float alpha = clamp(
        edgeTransparency
        - 0.12 * clamp(directTrans, 0.0, 1.0)
        + 0.52 * smoothstep(0.16, 0.90, lum)
        + 0.16 * clamp(tirEnergy, 0.0, 1.0),
        0.28,
        0.98
      );

      if (eyeMask > 0.001) {
        float ePeak = max(eyeColor.r, max(eyeColor.g, eyeColor.b));
        vec3 eMapped = ePeak > 0.0001 ? eyeColor * ((ePeak / (1.0 + ePeak * 0.4)) / ePeak) : vec3(0.0);
        col = mix(col, eMapped, eyeMask);
        alpha = mix(alpha, 1.0, eyeMask);
      }

      col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
      return vec4(col * alpha, alpha);
    }

    void main() {
      vec2 screenXY = vec2(vNdc.x, -vNdc.y) * radius;
      mat3 invView = transpose(view);

      float maxC = max(color.r, max(color.g, color.b));
      float minC = min(color.r, min(color.g, color.b));
      float sat = maxC > 0.001 ? (maxC - minC) / maxC : 0.0;
      vec3 pureHue = maxC > 0.05 ? (color / maxC) : vec3(0.88, 0.94, 0.97);
      vec3 jewelTint = mix(vec3(0.88, 0.94, 0.97), pureHue, clamp(sat * 1.08, 0.0, 1.0));
      vec3 transColor = mix(vec3(0.97), jewelTint, clamp(sat * 0.88, 0.0, 1.0));
      vec3 absorbSigma = -log(max(transColor, vec3(0.12))) * 0.62 + vec3(0.08);

      // Quick ray-probe near silhouette to trigger 2x2 rotated-grid supersampling (RGSS) on edges
      vec3 probePos = pivot + invView * vec3(screenXY, 0.0);
      float edgeDist = abs(mapSDF(probePos));

      if (pixelSize < 0.85 && edgeDist < max(2.2, pixelSize * 3.0)) {
        vec2 o1 = vec2( 0.375,  0.125) * pixelSize;
        vec2 o2 = vec2(-0.125,  0.375) * pixelSize;
        vec2 o3 = vec2(-0.375, -0.125) * pixelSize;
        vec2 o4 = vec2( 0.125, -0.375) * pixelSize;
        result = 0.25 * (
          traceRay(screenXY + o1, invView, jewelTint, absorbSigma) +
          traceRay(screenXY + o2, invView, jewelTint, absorbSigma) +
          traceRay(screenXY + o3, invView, jewelTint, absorbSigma) +
          traceRay(screenXY + o4, invView, jewelTint, absorbSigma)
        );
      } else {
        result = traceRay(screenXY, invView, jewelTint, absorbSigma);
      }
    }`;
      exports.vertexShader = vertexShader;
      exports.fragmentShader = fragmentShader;
    },
    "dom/index.ts": function(__req2, exports) {
      const __re_0 = __req2("dom/mount.ts");
      exports.mountAvatar = __re_0.mountAvatar;
      const __re_1 = __req2("dom/clock.ts");
      exports.requestFrame = __re_1.requestFrame;
      exports.setPointer = __re_1.setPointer;
      exports.subscribeFrames = __re_1.subscribeFrames;
      const __re_2 = __req2("dom/pointer.ts");
      exports.trackPointer = __re_2.trackPointer;
      const __re_3 = __req2("dom/reduced.ts");
      exports.prefersReducedMotion = __re_3.prefersReducedMotion;
    },
    "dom/materials/fluffy.ts": function(__req2, exports) {
      const { renderFluffy } = __req2("dom/fluffy/renderer.ts");
      const fluffy2 = {
        id: "fluffy",
        margin: 3,
        render: (...args) => renderFluffy(...args)
      };
      exports.fluffy = fluffy2;
    },
    "dom/materials/glass.ts": function(__req2, exports) {
      const { renderGlass } = __req2("dom/glass/renderer.ts");
      const glass2 = {
        id: "glass",
        margin: 3,
        render: (...args) => renderGlass(...args)
      };
      exports.glass = glass2;
    },
    "dom/materials/marks.ts": function(__req2, exports) {
      const { filledArea, flattenPath, parsePath, serializePath } = __req2("path.ts");
      const { viewBasis } = __req2("render.ts");
      const { analyzeBody } = __req2("validate.ts");
      const { buildVolume } = __req2("volume.ts");
      const RADIUS = 12;
      const FRONT = viewBasis(0, 0);
      const HEADROOM = 1.12;
      const models = /* @__PURE__ */ new Map();
      const sprites = /* @__PURE__ */ new WeakMap();
      const MAX_SPRITES = 32;
      function paintCapsule(material, ctx, box, scale, color) {
        const aspect = Math.round(1e3 * box.h / box.w) / 1e3;
        let model = models.get(aspect);
        if (!model) {
          const halfHeight = RADIUS * aspect;
          model = {
            radius: RADIUS,
            bounds: {
              minX: -RADIUS,
              maxX: RADIUS,
              minY: -halfHeight,
              maxY: halfHeight
            }
          };
          if (models.size >= MAX_OUTLINES) models.clear();
          models.set(aspect, model);
        }
        const unit = box.w / (2 * RADIUS);
        const density = Math.min(8, Math.max(0.5, 2 ** Math.ceil(Math.log2(HEADROOM * scale * unit))));
        const sprite = spriteOf(material, `${aspect}|${color}|${density}`, model, color, density);
        if (!sprite) return false;
        const radius = sprite.radius * unit;
        ctx.drawImage(sprite.canvas, -radius, -radius, 2 * radius, 2 * radius);
        return true;
      }
      function spriteOf(material, key, model, color, density) {
        let kept = sprites.get(material);
        if (!kept) sprites.set(material, kept = /* @__PURE__ */ new Map());
        let sprite = kept.get(key);
        if (sprite) return sprite;
        const image = material.render(model, FRONT, {
          color,
          ink: color,
          eyes: []
        }, density);
        if (!image) return null;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = image.size;
        const copy = canvas.getContext("2d");
        if (!copy) return null;
        copy.drawImage(image.canvas, image.x, image.y, image.size, image.size, 0, 0, image.size, image.size);
        sprite = {
          canvas,
          cx: image.cx,
          cy: image.cy,
          radius: image.radius
        };
        if (kept.size >= MAX_SPRITES) kept.delete(kept.keys().next().value);
        kept.set(key, sprite);
        return sprite;
      }
      const CENTRE = 50;
      const FIT = 84;
      const outlines = /* @__PURE__ */ new Map();
      const volumes = /* @__PURE__ */ new Map();
      const MAX_OUTLINES = 64;
      function outlineModel(d, box) {
        const name = `${d}|${box.x},${box.y},${box.w},${box.h}`;
        const known = outlines.get(name);
        if (known !== void 0) return known;
        let model = null;
        try {
          const segs = parsePath(d, false);
          const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
          const moved = (scale2) => {
            const X = (x) => CENTRE + (x - cx) * scale2, Y = (y) => CENTRE + (y - cy) * scale2;
            return segs.map((s) => {
              if (s.c === "Z") return s;
              if (s.c === "A") return {
                ...s,
                rx: s.rx * scale2,
                ry: s.ry * scale2,
                x: X(s.x),
                y: Y(s.y)
              };
              if (s.c === "C") return {
                ...s,
                x1: X(s.x1),
                y1: Y(s.y1),
                x2: X(s.x2),
                y2: Y(s.y2),
                x: X(s.x),
                y: Y(s.y)
              };
              if (s.c === "Q") return {
                ...s,
                x1: X(s.x1),
                y1: Y(s.y1),
                x: X(s.x),
                y: Y(s.y)
              };
              return {
                ...s,
                x: X(s.x),
                y: Y(s.y)
              };
            });
          };
          const fit = FIT / Math.max(box.w, box.h);
          const polys = flattenPath(moved(fit));
          let round = 0;
          for (const poly of polys) poly.forEach(([x, y], i) => round += Math.hypot(poly[(i + 1) % poly.length][0] - x, poly[(i + 1) % poly.length][1] - y));
          const stroke = 2 * filledArea(polys) / round;
          const scale = fit * Math.min(1, 2 * RADIUS / stroke);
          if (stroke > 0 && Number.isFinite(scale)) {
            const key = serializePath(moved(scale));
            let volume = volumes.get(key);
            if (!volume) {
              const def = {
                version: 1,
                id: "mark",
                name: "mark",
                body: {
                  path: key
                },
                eyes: {
                  x: CENTRE,
                  y: CENTRE,
                  spacing: 10,
                  scale: 1
                }
              };
              volume = buildVolume(def, 1, analyzeBody(key, false));
              if (volumes.size >= MAX_OUTLINES) volumes.delete(volumes.keys().next().value);
              volumes.set(key, volume);
            }
            model = {
              key,
              volume,
              scale,
              cx,
              cy
            };
          }
        } catch {
          model = null;
        }
        if (outlines.size >= MAX_OUTLINES) outlines.delete(outlines.keys().next().value);
        outlines.set(name, model);
        return model;
      }
      function paintOutline(material, ctx, d, box, scale, color) {
        const model = outlineModel(d, box);
        if (!model) return false;
        const density = Math.min(8, Math.max(0.5, 2 ** Math.ceil(Math.log2(HEADROOM * scale / model.scale))));
        const sprite = spriteOf(material, `${model.key}|${color}|${density}`, model.volume, color, density);
        if (!sprite) return false;
        const radius = sprite.radius / model.scale;
        ctx.drawImage(sprite.canvas, model.cx + (sprite.cx - CENTRE) / model.scale - radius, model.cy + (sprite.cy - CENTRE) / model.scale - radius, 2 * radius, 2 * radius);
        return true;
      }
      function paintMark(material, ctx, part, scale, color) {
        return part.round ? paintCapsule(material, ctx, part.box, scale, color) : paintOutline(material, ctx, part.d, part.box, scale, color);
      }
      exports.outlineModel = outlineModel;
      exports.paintMark = paintMark;
    },
    "dom/materials/material.ts": function(__req2, exports) {
      const ENTRIES = {
        fluffy: "open-bot-avatar/materials/fluffy",
        glass: "open-bot-avatar/materials/glass"
      };
      const warned = /* @__PURE__ */ new Set();
      function canvasMaterialOf(material) {
        if (material === void 0 || material === null || material === "flat") return null;
        if (typeof material === "object" && material !== null && typeof material.render === "function") return material;
        const name = typeof material === "string" ? JSON.stringify(material) : typeof material;
        if (!warned.has(name) && warned.size < 16) {
          warned.add(name);
          const entry = typeof material === "string" ? ENTRIES[material] : void 0;
          console.warn(`open-bot-avatar: material ${name} is not a material, drawing flat. ` + (entry ? `Import { ${material} } from "${entry}" and pass it as \`material\`.` : 'Pass "flat" or an imported material, such as { fluffy } from "open-bot-avatar/materials/fluffy".'));
        }
        return null;
      }
      exports.canvasMaterialOf = canvasMaterialOf;
    },
    "dom/materials/shape.ts": function(__req2, exports) {
      function halfDepth(shape) {
        return "radius" in shape ? shape.radius : Math.max(0.5, ...shape.parts.map((part) => part.depth / 2));
      }
      exports.halfDepth = halfDepth;
    },
    "dom/materials/socket.ts": function(__req2, exports) {
      const { eyeBox, paintEye } = __req2("dom/eye.ts");
      const SOCKET_TILE = 96;
      const SOCKET_PAD = 3.8;
      function exposedHeight(w, h) {
        const openness = Math.max(0, Math.min(1, h / w - 1));
        return 0.8 - 0.175 * openness;
      }
      function regionOf(mark) {
        const { x, y, w, h } = eyeBox(mark);
        return {
          cx: x + w / 2,
          cy: y + h / 2,
          w,
          h,
          span: Math.max(w, h) + 2 * SOCKET_PAD
        };
      }
      const outlineRegions = /* @__PURE__ */ new Map();
      function socketRegion(mark) {
        if (mark.shape === "pill") return regionOf(mark);
        const key = socketKey(mark);
        let region = outlineRegions.get(key);
        if (!region) {
          region = regionOf(mark);
          if (outlineRegions.size >= 16) outlineRegions.clear();
          outlineRegions.set(key, region);
        }
        return region;
      }
      function socketKey(mark) {
        if (mark.shape === "pill") return `${mark.width}|${mark.height}|${mark.radius}`;
        return mark.shape === "arc" ? `${mark.strokeWidth}|${mark.d}` : mark.d;
      }
      function socketTile(ctx, mark) {
        const size = SOCKET_TILE;
        const { cx, cy, span, w, h } = socketRegion(mark);
        const scale = size / span;
        const exposure = exposedHeight(w, h);
        ctx.resetTransform();
        ctx.clearRect(0, 0, size, size);
        ctx.setTransform(scale, 0, 0, scale, size / 2 - cx * scale, size / 2 - cy * scale);
        ctx.lineCap = "round";
        ctx.fillStyle = ctx.strokeStyle = "#fff";
        ctx.translate(cx, cy);
        ctx.scale(1, exposure);
        ctx.translate(-cx, -cy);
        paintEye(ctx, mark);
        const rgba = ctx.getImageData(0, 0, size, size).data;
        const coverage = new Uint8Array(size * size);
        const cap = Math.min(1, w / h);
        for (let y = 0; y < size; y++) {
          const v = Math.min(0.9999, Math.abs((y + 0.5 - size / 2) / (scale * h * exposure / 2)));
          const capY = Math.max(0, (v - 1 + cap) / cap);
          const stadium = Math.sqrt(1 - capY * capY);
          const oval = Math.pow(1 - Math.pow(v, 2.2), 1 / 2.2);
          const taper = h > w ? Math.min(1, oval / stadium) : 1;
          const cant = 0.04 * Math.max(0, 1 - cap) * (y + 0.5 - size / 2);
          for (let x = 0; x < size; x++) {
            const source = (x + 0.5 - size / 2 - cant) / taper + size / 2 - 0.5;
            const i = Math.floor(source);
            if (i < 0 || i + 1 >= size) continue;
            const offset = 4 * (y * size + i) + 3;
            coverage[y * size + x] = Math.round(rgba[offset] + (rgba[offset + 4] - rgba[offset]) * (source - i));
          }
        }
        const distance = new Float32Array(size * size).fill(size);
        for (let i = size + 1; i < distance.length - size - 1; i++) {
          const a = coverage[i] / 255;
          const inside = a >= 0.5;
          if (a > 0 && a < 1 || coverage[i - 1] >= 128 !== inside || coverage[i + 1] >= 128 !== inside || coverage[i - size] >= 128 !== inside || coverage[i + size] >= 128 !== inside) {
            distance[i] = Math.abs(a - 0.5);
          }
        }
        for (const step of [
          1,
          -1
        ]) {
          for (let j = 1; j < size - 1; j++) for (let k = 1; k < size - 1; k++) {
            const i = step === 1 ? j * size + k : (size - 1 - j) * size + size - 1 - k;
            const prev = i - size * step;
            distance[i] = Math.min(distance[i], distance[i - step] + 1, distance[prev] + 1, distance[prev - 1] + Math.SQRT2, distance[prev + 1] + Math.SQRT2);
          }
        }
        const tile = new Uint8Array(distance.length);
        for (let i = 0; i < tile.length; i++) {
          const signed = (coverage[i] >= 128 ? -1 : 1) * distance[i] / scale;
          tile[i] = Math.round(255 * Math.max(0, Math.min(1, 0.5 + signed / (2 * SOCKET_PAD))));
        }
        return tile;
      }
      exports.SOCKET_TILE = SOCKET_TILE;
      exports.SOCKET_PAD = SOCKET_PAD;
      exports.exposedHeight = exposedHeight;
      exports.socketRegion = socketRegion;
      exports.socketKey = socketKey;
      exports.socketTile = socketTile;
    },
    "dom/mount.ts": function(__req2, exports) {
      const { createAnimator } = __req2("animator.ts");
      const { pointerGaze } = __req2("follow.ts");
      const { lookOf } = __req2("motion.ts");
      const { DEFAULT_COLOR, DEFAULT_EYE_COLOR, liveFrame, liveTransform, renderAvatarScene, renderAvatarSvg, sceneFrame } = __req2("render.ts");
      const { currentPointer, isHighRefresh, subscribeMountFrames } = __req2("dom/clock.ts");
      const { canvasMaterialOf } = __req2("dom/materials/material.ts");
      const { cancelDeferredCoat, canvasSupported, currentMaterialEpoch, mountCanvas, paintCanvas, paintLiveCanvas, releaseCanvas } = __req2("dom/paint.ts");
      const { trackPointer } = __req2("dom/pointer.ts");
      const { prefersReducedMotion } = __req2("dom/reduced.ts");
      function mountScene(el, definition, depth) {
        el.innerHTML = renderAvatarScene(definition, {
          depth
        });
        const q = (s) => el.querySelector(s);
        const stacks = {
          z: q('[data-stack="z"]'),
          x: q('[data-stack="x"]')
        };
        return {
          key: q("[data-avatar-scene]").dataset.avatarScene ?? "",
          geometry: geometryKey(definition),
          motion: q("[data-motion]"),
          view: q("[data-view]"),
          stacks,
          slices: {
            z: [
              ...stacks.z.children
            ],
            x: [
              ...stacks.x.children
            ]
          },
          eyes: [
            0,
            1
          ].map((i) => {
            const root = q(`[data-eye="${i}"]`);
            const morph = root.querySelector("[data-morph]");
            return {
              root,
              pill: root.querySelector("i"),
              arc: root.querySelector("svg"),
              morph,
              path: morph.querySelector("path")
            };
          }),
          fx: {
            back: q('[data-fx="back"]'),
            front: q('[data-fx="front"]')
          },
          last: {}
        };
      }
      function put(m, key, el, prop, value) {
        if (m.last[key] === value) return;
        m.last[key] = value;
        el.style[prop] = value;
      }
      function apply(m, frame) {
        put(m, "motion", m.motion, "transform", frame.motion);
        put(m, "view", m.view, "transform", frame.view);
        put(m, "body", m.view, "display", frame.body > 0 ? "block" : "none");
        for (const side of [
          "back",
          "front"
        ]) {
          if (m.last[side] === frame[side]) continue;
          m.last[side] = frame[side];
          m.fx[side].innerHTML = frame[side];
        }
        put(m, "z", m.stacks.z, "display", frame.stack === "z" ? "block" : "none");
        put(m, "x", m.stacks.x, "display", frame.stack === "x" ? "block" : "none");
        const slices = m.slices[frame.stack];
        frame.slices.forEach((shown, i) => slices[i] && put(m, `${frame.stack}${i}`, slices[i], "display", shown ? "block" : "none"));
        frame.eyes.forEach((eye, i) => {
          const e = m.eyes[i];
          put(m, `e${i}`, e.root, "transform", eye.transform);
          put(m, `v${i}`, e.root, "visibility", eye.visible ? "visible" : "hidden");
          put(m, `p${i}`, e.pill, "transform", eye.pill);
          put(m, `ph${i}`, e.pill, "display", eye.happy || eye.d ? "none" : "block");
          put(m, `a${i}`, e.arc, "display", eye.happy && !eye.d ? "block" : "none");
          put(m, `m${i}`, e.morph, "display", eye.d ? "block" : "none");
          if (eye.d && m.last[`d${i}`] !== eye.d) {
            m.last[`d${i}`] = eye.d;
            e.path.setAttribute("d", eye.d);
          }
        });
      }
      const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
      const isHex = (c) => c === void 0 || HEX.test(c);
      const keys = /* @__PURE__ */ new WeakMap();
      function geometryKey(definition) {
        var _a;
        let key = keys.get(definition);
        if (key === void 0) {
          key = JSON.stringify([
            definition == null ? void 0 : definition.id,
            definition == null ? void 0 : definition.name,
            (_a = definition == null ? void 0 : definition.body) == null ? void 0 : _a.path,
            definition == null ? void 0 : definition.eyes
          ]);
          keys.set(definition, key);
        }
        return key;
      }
      function eyesOrigin(definition) {
        const { x, y } = definition.eyes ?? {};
        const at = (v) => typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 0.5;
        return {
          x: at(x),
          y: at(y)
        };
      }
      const SMALL_SIZE = 128;
      const SMALL_FPS = 30;
      const MAX_FPS = 60;
      const VIEW_MARGIN = 100;
      let materialStillAt = -1;
      function mountAvatar(host, initial) {
        let opts = {
          ...initial
        };
        const animator = createAnimator();
        let rect = null;
        let scene = null;
        let surface = null;
        let lastStill = "";
        let failed = false;
        let dirty = true;
        let releasePointer = null;
        let size = host.clientWidth;
        const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(([entry]) => {
          const next = entry.contentRect.width;
          if (next === size) return;
          size = next;
          dirty = true;
          frames.request();
        });
        let visible = true;
        const intersect = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
          const next = entries[entries.length - 1].isIntersecting;
          if (next === visible) return;
          visible = next;
          if (!visible && surface) cancelDeferredCoat(surface);
          if (visible) frames.request();
        }, {
          rootMargin: `${VIEW_MARGIN}px`
        });
        if (getComputedStyle(host).position === "static") host.style.position = "relative";
        const syncHost = () => {
          var _a;
          host.style.color = opts.color ?? DEFAULT_COLOR;
          host.style.setProperty("--avatar-ink", opts.eyeColor ?? DEFAULT_EYE_COLOR);
          const decorative = opts.label === "";
          if (decorative) {
            host.removeAttribute("role");
            host.removeAttribute("aria-label");
            host.setAttribute("aria-hidden", "true");
          } else {
            host.setAttribute("role", "img");
            host.setAttribute("aria-label", opts.label ?? ((_a = opts.definition) == null ? void 0 : _a.name) ?? "Avatar");
            host.removeAttribute("aria-hidden");
          }
          const wantsPointer = !!opts.followPointer && !opts.still;
          if (wantsPointer && !releasePointer) releasePointer = trackPointer();
          else if (!wantsPointer && releasePointer) {
            releasePointer();
            releasePointer = null;
          }
        };
        const clear = () => {
          if (surface) releaseCanvas(surface);
          host.textContent = "";
          scene = null;
          surface = null;
          lastStill = "";
        };
        const canvasMaterial = () => canvasMaterialOf(opts.material) !== null && opts.renderer !== "scene" && canvasSupported();
        let lastEyeKey = "";
        let calmFrame = false;
        let stillEpoch = -1;
        const ensureSurface = (p) => {
          if (scene || lastStill) clear();
          const key = `${geometryKey(p.definition)}|${p.depth}`;
          if (!surface || surface.key !== key || !host.contains(surface.canvas)) {
            if (surface) releaseCanvas(surface);
            surface = mountCanvas(host, key, p.definition, p.depth);
          }
          return surface;
        };
        const resolveColors = (p, fallbackFill, fallbackInk) => {
          const css = isHex(p.color) && isHex(p.eyeColor) ? null : getComputedStyle(host);
          return {
            fill: css && !isHex(p.color) ? css.color || fallbackFill : fallbackFill,
            ink: css && !isHex(p.eyeColor) ? css.getPropertyValue("--avatar-ink").trim() || fallbackInk : fallbackInk
          };
        };
        const paintStill = (p, options) => {
          const flat = liveFrame(p.definition, {
            ...options,
            color: p.color,
            eyeColor: p.eyeColor
          });
          const target = ensureSurface(p);
          const { fill, ink } = resolveColors(p, flat.color, flat.ink);
          paintCanvas(target, flat, size, fill, ink, p.material);
          stillEpoch = currentMaterialEpoch();
        };
        const draw = (time, pointer) => {
          const p = opts;
          const reducedMotion = p.reducedMotion === "system" || p.reducedMotion === void 0 ? prefersReducedMotion() : p.reducedMotion;
          const now = performance.now();
          const look = lookOf({
            state: p.state,
            mood: p.mood,
            motion: p.mood
          });
          try {
            if (p.still) {
              const options2 = {
                color: p.color,
                eyeColor: p.eyeColor,
                depth: p.depth,
                state: look.state,
                mood: look.mood,
                view: p.view,
                gaze: p.lookAt ?? void 0,
                reducedMotion: true
              };
              if (canvasMaterial()) {
                if (size > 0) paintStill(p, {
                  ...options2,
                  size
                });
                failed = false;
                return false;
              }
              if (scene || surface) clear();
              const svg = renderAvatarSvg(p.definition, options2);
              if (svg !== lastStill) {
                host.innerHTML = svg;
                lastStill = svg;
              }
              failed = false;
              return false;
            }
            if (lastStill) clear();
            const target = p.lookAt ? p.lookAt : p.followPointer && pointer && rect && rect.width > 0 ? pointerGaze(pointer, rect, eyesOrigin(p.definition)) : null;
            const step = animator.step({
              now,
              state: look.state,
              mood: look.mood,
              target,
              hold: p.holdGaze,
              reducedMotion
            });
            const options = {
              depth: p.depth,
              state: look.state,
              mood: look.mood,
              stateAge: step.stateAge,
              motionBlend: step.motionBlend,
              size: size || void 0,
              time,
              gaze: step.gaze,
              view: p.view,
              reducedMotion
            };
            const isCalmState = !step.moving && look.mood !== "happy" && (look.state === "idle" || look.state === "waiting" || look.state === "done");
            if (p.renderer !== "scene" && canvasSupported()) {
              const target2 = ensureSurface(p);
              const transform = liveTransform(p.definition, {
                ...options,
                color: p.color,
                eyeColor: p.eyeColor
              });
              const { fill, ink } = resolveColors(p, transform.color, transform.ink);
              const { eyesKey, deferred } = paintLiveCanvas(target2, transform, size, fill, ink, p.material, visible ? time : -1);
              calmFrame = !deferred && isCalmState && !transform.hasOverlay && eyesKey === lastEyeKey;
              lastEyeKey = eyesKey;
              failed = false;
              return !reducedMotion || step.moving || deferred;
            }
            if (surface) clear();
            const frame = sceneFrame(p.definition, {
              ...options,
              color: p.color
            });
            if (!scene || scene.key !== frame.scene || scene.geometry !== geometryKey(p.definition) || !host.contains(scene.view)) {
              scene = mountScene(host, p.definition, p.depth);
            }
            apply(scene, frame);
            calmFrame = isCalmState && frame.back === "" && frame.front === "";
            failed = false;
            return !reducedMotion || step.moving;
          } catch (error) {
            if (!failed) {
              clear();
              console.error("open-bot-avatar: render failed", error);
              failed = true;
            }
            return false;
          }
        };
        syncHost();
        const frames = subscribeMountFrames({
          measure: () => {
            rect = currentPointer() && visible && opts.followPointer && !opts.still && !opts.holdGaze && !opts.lookAt ? host.getBoundingClientRect() : null;
          },
          draw: (time, pointer) => {
            const materialStale = !!opts.still && size > 0 && canvasMaterial() && stillEpoch !== currentMaterialEpoch();
            if ((opts.still || !visible) && !dirty && !materialStale) return false;
            if (opts.still && size > 0 && canvasMaterial()) {
              if (materialStillAt === time) return true;
              materialStillAt = time;
            }
            dirty = false;
            calmFrame = false;
            const more = draw(time, pointer);
            if (!visible || !more) return false;
            if (size > 0 && size < SMALL_SIZE || calmFrame) return 1 / SMALL_FPS;
            return isHighRefresh() ? 1 / MAX_FPS : true;
          }
        }, () => {
          if (opts.still || !visible) return true;
          return !failed && !(opts.followPointer && !opts.holdGaze && !opts.lookAt) && isHex(opts.color) && isHex(opts.eyeColor) && typeof opts.state !== "object";
        });
        resize == null ? void 0 : resize.observe(host);
        intersect == null ? void 0 : intersect.observe(host);
        return {
          update(next) {
            opts = {
              ...opts,
              ...next
            };
            syncHost();
            dirty = true;
            frames.request();
          },
          destroy() {
            frames.unsubscribe();
            resize == null ? void 0 : resize.disconnect();
            intersect == null ? void 0 : intersect.disconnect();
            releasePointer == null ? void 0 : releasePointer();
            releasePointer = null;
            clear();
          }
        };
      }
      exports.mountAvatar = mountAvatar;
    },
    "dom/paint.ts": function(__req2, exports) {
      const { avatarExtent, preparedVolume, ribbonPointsOf } = __req2("render.ts");
      const { eyeBox, paintEye } = __req2("dom/eye.ts");
      const { paintMark } = __req2("dom/materials/marks.ts");
      const { canvasMaterialOf } = __req2("dom/materials/material.ts");
      const FIT_SLACK = 8;
      const FIT_PAD = 1;
      function fitSquare(prev, b, cap) {
        if (!(b.x0 <= b.x1 && b.y0 <= b.y1)) return prev ?? cap;
        if (prev && b.x0 - FIT_PAD >= prev.x && b.y0 - FIT_PAD >= prev.y && b.x1 + FIT_PAD <= prev.x + prev.size && b.y1 + FIT_PAD <= prev.y + prev.size) {
          return prev;
        }
        let x0 = b.x0 - FIT_SLACK, y0 = b.y0 - FIT_SLACK, x1 = b.x1 + FIT_SLACK, y1 = b.y1 + FIT_SLACK;
        if (prev) {
          x0 = Math.min(x0, prev.x);
          y0 = Math.min(y0, prev.y);
          x1 = Math.max(x1, prev.x + prev.size);
          y1 = Math.max(y1, prev.y + prev.size);
        }
        const size = Math.max(x1 - x0, y1 - y0);
        const inCap = b.x0 >= cap.x && b.y0 >= cap.y && b.x1 <= cap.x + cap.size && b.y1 <= cap.y + cap.size;
        if (size >= cap.size && inCap) return cap;
        return {
          x: (x0 + x1 - size) / 2,
          y: (y0 + y1 - size) / 2,
          size
        };
      }
      const MAX_SECTIONS = 1024;
      const sections = /* @__PURE__ */ new Map();
      let supported;
      function canvasSupported() {
        if (supported === void 0) {
          supported = typeof Path2D !== "undefined" && typeof document !== "undefined" && !!document.createElement("canvas").getContext("2d");
        }
        return supported;
      }
      const IDENTITY = [
        1,
        0,
        0,
        1,
        0,
        0
      ];
      function placementWith(frame, root) {
        const boxes = new Map(frame.paths.map((p) => [
          p.id,
          p.box
        ]));
        const [ra, rb, rc, rd, re, rf] = root;
        const bounds = {
          x0: Infinity,
          y0: Infinity,
          x1: -Infinity,
          y1: -Infinity
        };
        const add = (m, x, y) => {
          const X = m[0] * x + m[2] * y + m[4], Y = m[1] * x + m[3] * y + m[5];
          if (X < bounds.x0) bounds.x0 = X;
          if (X > bounds.x1) bounds.x1 = X;
          if (Y < bounds.y0) bounds.y0 = Y;
          if (Y > bounds.y1) bounds.y1 = Y;
        };
        const matrices = frame.shapes.map((shape) => {
          const [a, b, c, d, e, f] = shape.matrix;
          const m = [
            ra * a + rc * b,
            rb * a + rd * b,
            ra * c + rc * d,
            rb * c + rd * d,
            ra * e + rc * f + re,
            rb * e + rd * f + rf
          ];
          const box = shape.kind === "slice" ? boxes.get(shape.path) : shape.kind === "eye" ? eyeBox(shape.mark) : shape.box;
          if (box) {
            add(m, box.x, box.y);
            add(m, box.x + box.w, box.y);
            add(m, box.x, box.y + box.h);
            add(m, box.x + box.w, box.y + box.h);
          }
          return m;
        });
        return {
          matrices,
          bounds
        };
      }
      function framePlacement(frame) {
        return placementWith(frame, frame.root);
      }
      const VIEW_EPS_CSS_PX = 0.6;
      const COAT_STAGGER_PX = 2.5;
      const MAX_IDLE_COATS_PER_FRAME = 2;
      let coatFrameTime = -1;
      let coatFrameCount = 0;
      const deferredCoats = /* @__PURE__ */ new Set();
      const coatPriority = /* @__PURE__ */ new Set();
      let materialEpoch = 0;
      function currentMaterialEpoch() {
        return materialEpoch;
      }
      function invalidateMaterialCache() {
        materialEpoch++;
      }
      function cancelDeferredCoat(surface) {
        deferredCoats.delete(surface);
        coatPriority.delete(surface);
      }
      function releaseCanvas(surface) {
        cancelDeferredCoat(surface);
        surface.painted = null;
        surface.canvas.width = 0;
        surface.canvas.height = 0;
      }
      function viewShift(a, b, rx, ry, rz) {
        const dx = rx * Math.abs(a.cY - b.cY) + rz * Math.abs(a.sY - b.sY);
        const dy = ry * Math.abs(a.cP - b.cP) + rx * Math.abs(a.sY * a.sP - b.sY * b.sP) + rz * Math.abs(a.cY * a.sP - b.cY * b.sP);
        return Math.hypot(dx, dy);
      }
      function eyeMarkKey(m) {
        if (m.shape === "pill") return `p:${Math.round(m.width * 20)},${Math.round(m.height * 20)},${Math.round(m.radius * 20)}`;
        if (m.shape === "arc") return `a:${Math.round(m.strokeWidth * 20)}:${m.d}`;
        return `d:${m.d}`;
      }
      function eyesCacheKey(eyes) {
        let key = "";
        for (let i = 0; i < eyes.length; i++) {
          const e = eyes[i];
          if (i > 0) key += "|";
          key += `${Math.round(e.dx * 20)},${Math.round(e.dy * 20)},${eyeMarkKey(e.mark)}`;
        }
        return key;
      }
      const r4 = (n) => Math.round(n * 1e4) / 1e4;
      const r2 = (n) => Math.round(n * 100) / 100;
      function rootCss(root, size) {
        const [a, b, c, d, e, f] = root;
        if (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0) return "";
        const k = size / 100;
        return `matrix(${r4(a)},${r4(b)},${r4(c)},${r4(d)},${r2(e * k)},${r2(f * k)})`;
      }
      function setCanvasTransform(surface, next) {
        if (surface.transform === next) return;
        if (next && !surface.promoted) {
          surface.canvas.style.willChange = "transform";
          surface.promoted = true;
        }
        surface.transform = next;
        surface.canvas.style.transform = next;
      }
      function mountCanvas(el, key, definition, depth) {
        const cap = avatarExtent(definition, depth);
        const wrap = document.createElement("div");
        wrap.style.cssText = "position:relative;width:100%;height:100%;pointer-events:none";
        const canvas = document.createElement("canvas");
        canvas.setAttribute("aria-hidden", "true");
        canvas.style.cssText = "position:absolute";
        wrap.append(canvas);
        el.replaceChildren(wrap);
        let volume;
        return {
          key,
          wrap,
          canvas,
          ctx: canvas.getContext("2d"),
          cap,
          fit: null,
          layout: "",
          left: 0,
          top: 0,
          transform: "",
          promoted: false,
          volume: depth === 0 ? null : () => volume ?? (volume = preparedVolume(definition, depth).vol),
          painted: null
        };
      }
      const isMark = (shape) => shape.key.startsWith("mark-");
      function paintFrame(surface, frame, size, fill, ink, material, delegateRoot, eyesKey) {
        const { canvas, ctx } = surface;
        if (!ctx || size <= 0) return;
        cancelDeferredCoat(surface);
        const dpr = window.devicePixelRatio || 1;
        const scale = size / 100 * dpr;
        const layout = `${size}|${dpr}`;
        const finish = canvasMaterialOf(material);
        const { view, scale: bodyScale, eyes } = frame.surface;
        if (!delegateRoot) {
          surface.painted = null;
          setCanvasTransform(surface, "");
        }
        if (sections.size > MAX_SECTIONS) sections.clear();
        for (const { id, d, evenOdd, box, round } of frame.paths) {
          const known = sections.get(id);
          if (!known || known.d !== d || known.round !== (round === true)) sections.set(id, {
            d,
            box,
            path: new Path2D(d),
            rule: evenOdd ? "evenodd" : "nonzero",
            round: round === true
          });
        }
        const paintRoot = delegateRoot ? IDENTITY : frame.root;
        const { matrices, bounds } = placementWith(frame, paintRoot);
        const volume = finish ? surface.volume : null;
        if (finish) {
          const margin = finish.margin ?? 0;
          bounds.x0 -= margin;
          bounds.y0 -= margin;
          bounds.x1 += margin;
          bounds.y1 += margin;
        }
        const fit = fitSquare(surface.layout === layout ? surface.fit : null, bounds, surface.cap);
        if (surface.layout === layout && fit === surface.fit) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        } else {
          surface.layout = layout;
          surface.fit = fit;
          surface.left = Math.floor(fit.x * scale);
          surface.top = Math.floor(fit.y * scale);
          const bitmap = Math.ceil(fit.size * scale) + 1;
          canvas.width = canvas.height = bitmap;
          const leftPx = surface.left / dpr;
          const topPx = surface.top / dpr;
          canvas.style.left = `${leftPx}px`;
          canvas.style.top = `${topPx}px`;
          canvas.style.width = canvas.style.height = `${bitmap / dpr}px`;
          canvas.style.transformOrigin = `${-leftPx}px ${-topPx}px`;
        }
        const coat = finish && volume && bodyScale > 1e-3 ? finish.render(volume(), view, {
          color: fill,
          ink,
          eyes
        }, scale) : null;
        let coatPainted = false;
        ctx.lineCap = "round";
        ctx.strokeStyle = ink;
        ctx.fillStyle = fill;
        for (let i = 0; i < frame.shapes.length; i++) {
          const shape = frame.shapes[i], m = matrices[i];
          ctx.setTransform(scale * m[0], scale * m[1], scale * m[2], scale * m[3], scale * m[4] - surface.left, scale * m[5] - surface.top);
          if (shape.kind === "slice") {
            const section = sections.get(shape.path);
            if (isMark(shape)) {
              if (!finish || !paintMark(finish, ctx, section, scale, fill)) ctx.fill(section.path, section.rule);
            } else if (!coat) {
              ctx.fill(section.path, section.rule);
            } else if (!coatPainted) {
              coatPainted = true;
              const [a, b, c, d, e, f] = paintRoot;
              ctx.setTransform(scale * a, scale * b, scale * c, scale * d, scale * e - surface.left, scale * f - surface.top);
              const radius = coat.radius * bodyScale;
              ctx.drawImage(coat.canvas, coat.x, coat.y, coat.size, coat.size, coat.cx - radius, coat.cy - radius, 2 * radius, 2 * radius);
            }
          } else if (shape.kind === "eye") {
            if (coat) continue;
            ctx.fillStyle = ink;
            paintEye(ctx, shape.mark);
            ctx.fillStyle = fill;
          } else {
            const g = shape.gradient;
            const paint = ctx.createLinearGradient(g.x1, g.y1, g.x2, g.y2);
            const stops = g.stops;
            if (stops.length === 3) {
              paint.addColorStop(0, stops[0]);
              paint.addColorStop(0.5, stops[1]);
              paint.addColorStop(1, stops[2]);
            } else {
              for (let idx = 0; idx < stops.length; idx++) paint.addColorStop(idx / (stops.length - 1), stops[idx]);
            }
            ctx.fillStyle = paint;
            const pts = ribbonPointsOf(shape);
            if (pts && pts.length > 0) {
              ctx.beginPath();
              ctx.moveTo(pts[0][0], pts[0][1]);
              for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
              ctx.closePath();
              ctx.fill();
            } else {
              ctx.fill(new Path2D(shape.d));
            }
            ctx.fillStyle = fill;
          }
        }
        if (delegateRoot && bodyScale > 1e-3) {
          let rx = 35, ry = 35, rz = 12;
          if (surface.volume) {
            const vol = surface.volume();
            rx = (vol.bounds.maxX - vol.bounds.minX) / 2;
            ry = (vol.bounds.maxY - vol.bounds.minY) / 2;
            rz = 0;
            for (let i = 0; i < vol.parts.length; i++) if (vol.parts[i].depth / 2 > rz) rz = vol.parts[i].depth / 2;
          }
          surface.painted = {
            material: finish,
            epoch: materialEpoch,
            fill,
            ink,
            layout,
            bodyScale,
            eyesKey,
            view,
            rx,
            ry,
            rz
          };
          deferredCoats.delete(surface);
          coatPriority.delete(surface);
          setCanvasTransform(surface, rootCss(frame.root, size));
        }
      }
      function paintCanvas(surface, frame, size, fill = frame.color, ink = frame.ink, material = "flat") {
        paintFrame(surface, frame, size, fill, ink, material, false, "");
      }
      function paintLiveCanvas(surface, transform, size, fill, ink, material = "flat", frameTime = -1) {
        const eyesKey = eyesCacheKey(transform.eyes);
        if (!surface.ctx || size <= 0) return {
          eyesKey,
          reused: false,
          deferred: false
        };
        const finish = canvasMaterialOf(material);
        const dpr = window.devicePixelRatio || 1;
        const layout = `${size}|${dpr}`;
        if (!transform.hasOverlay) {
          const prev = surface.painted;
          if (prev && prev.material === finish && (finish === null || prev.epoch === materialEpoch) && prev.fill === fill && prev.ink === ink && prev.layout === layout && Math.abs(prev.bodyScale - 1) < 1e-4 && prev.eyesKey === eyesKey) {
            const shiftPx = viewShift(transform.view, prev.view, prev.rx, prev.ry, prev.rz) * (size / 100);
            if (shiftPx < VIEW_EPS_CSS_PX) {
              deferredCoats.delete(surface);
              coatPriority.delete(surface);
              setCanvasTransform(surface, rootCss(transform.root, size));
              return {
                eyesKey,
                reused: true,
                deferred: false
              };
            }
            if (finish && frameTime >= 0 && shiftPx < COAT_STAGGER_PX) {
              if (coatFrameTime !== frameTime) {
                for (const stale of coatPriority) deferredCoats.delete(stale);
                coatFrameTime = frameTime;
                coatFrameCount = 0;
                coatPriority.clear();
                for (const s of deferredCoats) {
                  if (coatPriority.size >= MAX_IDLE_COATS_PER_FRAME) break;
                  coatPriority.add(s);
                }
              }
              const slotsLeft = MAX_IDLE_COATS_PER_FRAME - coatFrameCount;
              if (slotsLeft <= 0 || !coatPriority.has(surface) && slotsLeft <= coatPriority.size) {
                deferredCoats.add(surface);
                setCanvasTransform(surface, rootCss(transform.root, size));
                return {
                  eyesKey,
                  reused: true,
                  deferred: true
                };
              }
              coatFrameCount++;
              deferredCoats.delete(surface);
              coatPriority.delete(surface);
            }
          }
        }
        paintFrame(surface, transform.buildFrame(), size, fill, ink, material, !transform.hasOverlay, eyesKey);
        return {
          eyesKey,
          reused: false,
          deferred: false
        };
      }
      exports.FIT_SLACK = FIT_SLACK;
      exports.FIT_PAD = FIT_PAD;
      exports.fitSquare = fitSquare;
      exports.canvasSupported = canvasSupported;
      exports.framePlacement = framePlacement;
      exports.currentMaterialEpoch = currentMaterialEpoch;
      exports.invalidateMaterialCache = invalidateMaterialCache;
      exports.cancelDeferredCoat = cancelDeferredCoat;
      exports.releaseCanvas = releaseCanvas;
      exports.eyesCacheKey = eyesCacheKey;
      exports.mountCanvas = mountCanvas;
      exports.paintCanvas = paintCanvas;
      exports.paintLiveCanvas = paintLiveCanvas;
    },
    "dom/pointer.ts": function(__req2, exports) {
      const { setPointer } = __req2("dom/clock.ts");
      let users = 0;
      let detach = null;
      function attach() {
        const move = (e) => setPointer({
          x: e.clientX,
          y: e.clientY
        });
        const leave = () => setPointer(null);
        const out = (e) => !e.relatedTarget && leave();
        const lift = (e) => e.pointerType !== "mouse" && leave();
        const hidden = () => document.hidden && leave();
        window.addEventListener("pointermove", move, {
          passive: true
        });
        window.addEventListener("pointerdown", move, {
          passive: true
        });
        window.addEventListener("pointerout", out);
        window.addEventListener("pointerup", lift);
        window.addEventListener("pointercancel", lift);
        window.addEventListener("blur", leave);
        document.addEventListener("visibilitychange", hidden);
        return () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerdown", move);
          window.removeEventListener("pointerout", out);
          window.removeEventListener("pointerup", lift);
          window.removeEventListener("pointercancel", lift);
          window.removeEventListener("blur", leave);
          document.removeEventListener("visibilitychange", hidden);
          setPointer(null);
        };
      }
      function trackPointer() {
        if (typeof window === "undefined") return () => {
        };
        if (users++ === 0) detach = attach();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          if (--users === 0) {
            detach == null ? void 0 : detach();
            detach = null;
          }
        };
      }
      exports.trackPointer = trackPointer;
    },
    "dom/reduced.ts": function(__req2, exports) {
      const { requestFrame } = __req2("dom/clock.ts");
      const QUERY = "(prefers-reduced-motion: reduce)";
      let mql;
      function media() {
        if (mql === void 0) {
          mql = typeof matchMedia === "undefined" ? null : matchMedia(QUERY);
          mql == null ? void 0 : mql.addEventListener("change", requestFrame);
        }
        return mql;
      }
      function prefersReducedMotion() {
        var _a;
        return ((_a = media()) == null ? void 0 : _a.matches) ?? false;
      }
      exports.prefersReducedMotion = prefersReducedMotion;
    },
    "effects.ts": function(__req2, exports) {
      const { markPartsOf } = __req2("marks.ts");
      const { noise } = __req2("motion.ts");
      const clamp2 = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      const smooth = (u) => {
        const x = clamp2(u, 0, 1);
        return x * x * (3 - 2 * x);
      };
      const f = (n) => {
        const r = Math.round(n * 100) / 100;
        return (Object.is(r, -0) ? 0 : r).toString();
      };
      const DESIGN = 228.541;
      const BODY = 80;
      const UNIT = BODY / DESIGN;
      const RIM_MARGIN = 2;
      const RING = 38.8 * (116 / 114.2705);
      const RIM_STEPS = 180;
      const RIM_FANS = 180;
      function reachFinder(outlines, cx, cy) {
        let count = 0;
        for (const outline of outlines) for (const poly of outline) count += poly.length;
        const e = new Float64Array(4 * count);
        const first = new Int32Array(count), more = new Int32Array(count);
        const start = new Int32Array(RIM_FANS + 1);
        let k = 0;
        for (const outline of outlines) {
          for (const poly of outline) {
            for (let i = 0; i < poly.length; i++, k++) {
              const p = poly[i], q = poly[(i + 1) % poly.length];
              e[4 * k] = p[0];
              e[4 * k + 1] = p[1];
              e[4 * k + 2] = q[0] - p[0];
              e[4 * k + 3] = q[1] - p[1];
              const px = p[0] - cx, py = p[1] - cy, qx = q[0] - cx, qy = q[1] - cy;
              const from = Math.atan2(py, px), turn = Math.atan2(px * qy - py * qx, px * qx + py * qy);
              const near = px * px + py * py < 1e-6 || qx * qx + qy * qy < 1e-6 || Math.abs(turn) > Math.PI - 0.1;
              const lo = Math.floor(Math.min(from, from + turn) / Math.PI * RIM_FANS) - 1;
              const hi = Math.floor(Math.max(from, from + turn) / Math.PI * RIM_FANS) + 1;
              first[k] = near ? 0 : (lo % RIM_FANS + RIM_FANS) % RIM_FANS;
              more[k] = near || !(hi - lo < RIM_FANS) ? RIM_FANS - 1 : hi - lo;
              for (let f2 = 0; f2 <= more[k]; f2++) start[(first[k] + f2) % RIM_FANS + 1]++;
            }
          }
        }
        for (let f2 = 0; f2 < RIM_FANS; f2++) start[f2 + 1] += start[f2];
        const items = new Int32Array(start[RIM_FANS]), next = start.slice(0, RIM_FANS);
        for (k = 0; k < count; k++) for (let f2 = 0; f2 <= more[k]; f2++) items[next[(first[k] + f2) % RIM_FANS]++] = 4 * k;
        return (a) => {
          const ux = Math.cos(a), uy = Math.sin(a);
          const turns = Math.atan2(uy, ux) / Math.PI;
          const fan = Math.floor((turns - Math.floor(turns)) * RIM_FANS);
          const known = fan >= 0 && fan < RIM_FANS;
          let far = 0;
          for (let n = known ? start[fan] : 0, end = known ? start[fan + 1] : count; n < end; n++) {
            const at = known ? items[n] : 4 * n;
            const x1 = e[at], y1 = e[at + 1], ex = e[at + 2], ey = e[at + 3], den = ux * ey - uy * ex;
            if (Math.abs(den) < 1e-12) continue;
            const t = ((x1 - cx) * ey - (y1 - cy) * ex) / den, s = ((x1 - cx) * uy - (y1 - cy) * ux) / den;
            if (s >= 0 && s <= 1) far = Math.max(far, Math.abs(t));
          }
          return far;
        };
      }
      function hoopRolls(seed) {
        return Array.from({
          length: HOOPS
        }, (_, i) => HOOP_ROLL + i * Math.PI / HOOPS + (noise(seed, 450 + i) - 0.5) * HOOP_JITTER);
      }
      function rimOf(outlines, cx, cy) {
        const at = reachFinder(outlines, cx, cy);
        const steps = Array.from({
          length: RIM_STEPS
        }, (_, k) => at(k * Math.PI / RIM_STEPS));
        return {
          cx,
          cy,
          at,
          max: Math.max(...steps) * 1.02
        };
      }
      const HOOP_TILT = 0.386;
      const HOOP_ROLL = 0.157;
      const HOOP_JITTER = 0.24;
      const HOOP_TILT_JITTER = 0.08;
      const LADDER = 38;
      const ARC = [
        2.2,
        3.4
      ];
      const FOLLOW = [
        0.74,
        0.94
      ];
      const DRIFT = [
        0.5,
        1.1
      ];
      const WIDEN = 2.5;
      const START = 0.18;
      const SIZE_FEW = [
        8,
        10.5
      ];
      const SIZE_FOUR = [
        6.6,
        8.6
      ];
      const SIZE_MANY = [
        5.6,
        7.4
      ];
      const WORK_LANES = [
        3,
        5
      ];
      const sizeFor = (count) => count <= 3 ? SIZE_FEW : count === 4 ? SIZE_FOUR : SIZE_MANY;
      const BRUSH = 1.7 * 1.98;
      const FAR = 0.72;
      const GROW_S = 0.34;
      const STAGGER = [
        0.055,
        0.105
      ];
      const SWEEP_RATE = [
        6.3,
        15
      ];
      const SWEEP_LONGEST = 4;
      const LANES = 3;
      const HOOPS = 3;
      const SAMPLES = 24;
      const uniformSamples = Array.from({
        length: SAMPLES + 1
      }, (_, j) => j / SAMPLES);
      const STRETCH = 6;
      const SLIVER = 0.02;
      const CAP = 7;
      const mix = (range, u) => range[0] + (range[1] - range[0]) * u;
      function ribbonReach(rimMax) {
        const width = SIZE_FEW[1] * BRUSH * UNIT;
        const ring = rimMax === void 0 ? RING : rimMax + RIM_MARGIN;
        return {
          radius: ring + (LADDER + WIDEN * SWEEP_LONGEST) * UNIT,
          width,
          band: width / 2
        };
      }
      function ribbonPieces(b, presence, seed, _time, sweep = 0, cage = 0, rim, needPath = true) {
        const k = clamp2(presence, 0, 1), more = cage >= 0.5 ? 1 : 0;
        if (k <= 0.01) return [];
        const cx = rim ? rim.cx : (b.minX + b.maxX) / 2, cy = rim ? rim.cy : (b.minY + b.maxY) / 2;
        const rolls = hoopRolls(seed), rollOf = (i) => rolls[i];
        const cageRing = more && rim ? Math.max(...rolls.map((angle) => rim.at(angle))) + RIM_MARGIN : RING;
        const unit = UNIT;
        const dir = sweep < 0 ? -1 : 1;
        const since = Math.abs(sweep) / mix(SWEEP_RATE, more);
        const pieces = [];
        for (let i = 0; i < (more ? HOOPS : 1); i++) {
          const hoopRoll = rollOf(i);
          const hoopTilt = HOOP_TILT + (noise(seed, 460 + i) - 0.5) * HOOP_TILT_JITTER;
          const ring = more ? cageRing : rim ? rim.at(hoopRoll) + RIM_MARGIN : RING;
          const lanes = i || more > 0 ? LANES : Math.round(mix(WORK_LANES, noise(seed, 47)));
          for (let l = 0; l < lanes; l++) {
            const n = (m) => noise(seed, 500 + (i * LANES + l) * 11 + m);
            const order = more > 0 ? l * HOOPS + i : l;
            const at = order * mix(STAGGER, n(7));
            const life = since - at;
            if (life <= 0) continue;
            const before = since > 0 ? Math.abs(sweep) * (at / since) : 0;
            const roll = hoopRoll;
            const tilt = hoopTilt;
            const flat = Math.sin(tilt), depth = Math.cos(tilt);
            const cr = Math.cos(roll), sr = Math.sin(roll);
            const r = ring + l * LADDER * unit / (lanes - 1) + mix([
              0,
              WIDEN
            ], n(2)) * unit * life;
            const travel = (Math.abs(sweep) - before) * mix(FOLLOW, n(3)) + mix(DRIFT, n(4)) * life;
            const head = dir * (before + travel - START * n(5));
            const ret = 1 - clamp2(k * 1.25, 0, 1);
            const length = Math.min(mix(ARC, n(6)), travel) * (1 - ret * ret * (3 - 2 * ret));
            if (length <= 0.02) continue;
            const size = mix(sizeFor(lanes), n(8)) * (1 - more) + mix(SIZE_MANY, n(8)) * more;
            const nearHead = clamp2(Math.cos(head) * depth, 0, 1);
            let full = size * BRUSH * unit * (FAR + (1 - FAR) * nearHead) * smooth(life / GROW_S) * (1 - 0.72 * ret * ret);
            const lamAt = (u) => head - dir * length * (1 - u);
            const along = (lam) => 1 - (head - lam) / (dir * length);
            const sliver = SLIVER / length;
            let ss = uniformSamples;
            const lo = Math.min(head, head - dir * length), hi = Math.max(head, head - dir * length);
            for (let side2 = Math.ceil((lo - Math.PI / 2) / Math.PI); Math.PI / 2 + side2 * Math.PI < hi; side2++) {
              const u = along(Math.PI / 2 + side2 * Math.PI);
              if (ss === uniformSamples) ss = uniformSamples.slice();
              for (const d of [
                -sliver,
                0,
                sliver
              ]) if (u + d > 0 && u + d < 1) ss.push(u + d);
            }
            if (ss !== uniformSamples) ss.sort((x, y) => x - y);
            const near = ss.map((u) => Math.cos(lamAt(u) + dir * 1e-6) > 0);
            const mid = [], halfs = [], norm = [], bend = [];
            for (const u of ss) {
              const lam = lamAt(u);
              const sn = Math.sin(lam), c = Math.cos(lam);
              const nx = sn * flat, ny = -c;
              const nl = Math.hypot(nx, ny) || 1;
              const ux = nx / nl, uy = ny / nl;
              const y = ny * flat;
              mid.push([
                cx + r * (sn * cr - y * sr),
                cy + r * (sn * sr + y * cr)
              ]);
              norm.push([
                ux * cr - uy * sr,
                ux * sr + uy * cr
              ]);
              halfs.push(0.5 + 0.5 * u);
              bend.push(r * (c * c + flat * flat * sn * sn) ** 1.5 / flat);
            }
            const last = ss.length - 1;
            let onScreen = 0;
            for (let j = 1; j <= last; j++) onScreen += Math.hypot(mid[j][0] - mid[j - 1][0], mid[j][1] - mid[j - 1][1]);
            full = Math.min(full, 0.34 * onScreen);
            for (let j = 0; j <= last; j++) halfs[j] = Math.min(halfs[j] * (full / 2), 0.9 * bend[j]);
            const side = (j, sign) => [
              mid[j][0] + sign * norm[j][0] * halfs[j],
              mid[j][1] + sign * norm[j][1] * halfs[j]
            ];
            const cap = (j, ahead) => {
              const o = ahead ? mid[j - 1] : mid[j + 1];
              let tx = ahead ? mid[j][0] - o[0] : o[0] - mid[j][0], ty = ahead ? mid[j][1] - o[1] : o[1] - mid[j][1];
              const tl = Math.hypot(tx, ty) || 1;
              tx /= tl;
              ty /= tl;
              const [nx, ny] = norm[j], h = halfs[j], out = [];
              for (let c = 1; c < CAP; c++) {
                const t = Math.PI * c / CAP;
                const e = ahead ? Math.cos(t) : -Math.cos(t), g = ahead ? Math.sin(t) : -Math.sin(t);
                out.push([
                  mid[j][0] + (nx * e + tx * g) * h,
                  mid[j][1] + (ny * e + ty * g) * h
                ]);
              }
              return out;
            };
            let from = 0;
            for (let j = 1; j <= last; j++) {
              const turns = j < last && near[j] !== near[from];
              if (j < last && !turns && j - from < STRETCH) continue;
              const to = j;
              const behind = !near[from];
              const end = to < last && (!turns || behind) ? to + 1 : to;
              const start = from > 0 && behind && near[from - 1] ? from - 1 : from;
              const pts = [];
              for (let q = start; q <= end; q++) pts.push(side(q, 1));
              if (end === last) pts.push(...cap(last, true));
              for (let q = end; q >= start; q--) pts.push(side(q, -1));
              if (start === 0) pts.push(...cap(0, false));
              let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
              for (let q = 0; q < pts.length; q++) {
                const px = pts[q][0], py = pts[q][1];
                if (px < minX) minX = px;
                if (px > maxX) maxX = px;
                if (py < minY) minY = py;
                if (py > maxY) maxY = py;
              }
              pieces.push({
                d: needPath ? `M${pts.map((p) => `${f(p[0])} ${f(p[1])}`).join("L")}Z` : "",
                points: pts,
                front: near[from],
                box: {
                  x: minX,
                  y: minY,
                  w: maxX - minX,
                  h: maxY - minY
                },
                ribbon: i * LANES + l,
                along: [
                  ss[from],
                  ss[to]
                ],
                from: mid[from],
                to: mid[to]
              });
              from = j;
            }
          }
        }
        return pieces;
      }
      const MARK_FROM = 0.45;
      const grown = (weight) => smooth((clamp2(weight, 0, 1) - MARK_FROM) / (1 - MARK_FROM));
      function markUnit(b) {
        return clamp2(Math.min(b.maxX - b.minX, b.maxY - b.minY), 34, 78);
      }
      function markParts(b, marks, seed, time, still) {
        const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
        const ctx = {
          unit: markUnit(b),
          time: still ? 0 : time + noise(seed, 9) * 10,
          still
        };
        return marks.flatMap(({ mark, weight }) => {
          const g = grown(weight);
          if (!(g > 0)) return [];
          return markPartsOf(mark.parts(ctx)).map((part) => ({
            ...part,
            x: cx + part.x * g,
            y: cy + part.y * g,
            scale: part.scale * g
          }));
        });
      }
      function bodyScale(marks) {
        const left = (weight) => 1 - smooth(clamp2(weight, 0, 1) / 0.55);
        const scale = left(marks.reduce((sum, m) => sum + m.weight, 0));
        return marks.some((m) => grown(m.weight) > 0) ? scale : Math.max(scale, left(MARK_FROM));
      }
      exports.rimOf = rimOf;
      exports.LANES = LANES;
      exports.HOOPS = HOOPS;
      exports.ribbonReach = ribbonReach;
      exports.ribbonPieces = ribbonPieces;
      exports.markParts = markParts;
      exports.bodyScale = bodyScale;
    },
    "examples.ts": function(__req2, exports) {
      const examples = [
        {
          version: 1,
          id: "controller",
          name: "Controller",
          body: {
            path: "M28 22C38 20 44 23 50 23C56 23 62 20 72 22C84 24 90 34 91 48C92 62 91 76 82 80C75 83 69 78 66 72C63 67 58 66 50 66C42 66 37 67 34 72C31 78 25 83 18 80C9 76 8 62 9 48C10 34 16 24 28 22Z"
          },
          eyes: {
            x: 50,
            y: 42,
            spacing: 16,
            scale: 1.05
          }
        },
        {
          version: 1,
          id: "barbell",
          name: "Barbell",
          body: {
            path: "M12 41H12A4 4 0 0 1 16 45V55A4 4 0 0 1 12 59H12A4 4 0 0 1 8 55V45A4 4 0 0 1 12 41ZM18 29H18A4 4 0 0 1 22 33V67A4 4 0 0 1 18 71H18A4 4 0 0 1 14 67V33A4 4 0 0 1 18 29ZM26 17H26A5 5 0 0 1 31 22V78A5 5 0 0 1 26 83H26A5 5 0 0 1 21 78V22A5 5 0 0 1 26 17ZM38 33H62A10 10 0 0 1 72 43V57A10 10 0 0 1 62 67H38A10 10 0 0 1 28 57V43A10 10 0 0 1 38 33ZM74 17H74A5 5 0 0 1 79 22V78A5 5 0 0 1 74 83H74A5 5 0 0 1 69 78V22A5 5 0 0 1 74 17ZM82 29H82A4 4 0 0 1 86 33V67A4 4 0 0 1 82 71H82A4 4 0 0 1 78 67V33A4 4 0 0 1 82 29ZM88 41H88A4 4 0 0 1 92 45V55A4 4 0 0 1 88 59H88A4 4 0 0 1 84 55V45A4 4 0 0 1 88 41Z"
          },
          eyes: {
            x: 50,
            y: 50,
            spacing: 15,
            scale: 1.05
          }
        },
        {
          version: 1,
          id: "mug",
          name: "Mug",
          body: {
            path: "M22 20H62C67 20 70 23 70 28V72C70 80 64 86 56 86H28C20 86 14 80 14 72V28C14 23 17 20 22 20ZM68 36C80 34 87 42 87 53C87 64 80 72 68 70ZM69 45L69 61C75.5 62 79 58.5 79 53C79 47.5 76 44 69 45Z"
          },
          eyes: {
            x: 42,
            y: 49,
            spacing: 16,
            scale: 1.15
          }
        },
        {
          version: 1,
          id: "lightbulb",
          name: "Lightbulb",
          body: {
            path: "M36 72V66C36 60 18 55 18 40A32 32 0 0 1 82 40C82 55 64 60 64 66V72ZM36 68H64V77A4 4 0 0 1 60 81H40A4 4 0 0 1 36 77ZM43 78H57V84A4 4 0 0 1 53 88H47A4 4 0 0 1 43 84Z"
          },
          eyes: {
            x: 50,
            y: 40,
            spacing: 17,
            scale: 1.2
          }
        },
        {
          version: 1,
          id: "chat",
          name: "Chat",
          body: {
            path: "M28 14H72C82 14 90 22 90 32V54C90 64 82 72 72 72H42L25 86C23.5 87.3 21.5 86 22.3 84L27 71.5C17 70 10 63 10 54V32C10 22 18 14 28 14Z"
          },
          eyes: {
            x: 50,
            y: 42,
            spacing: 18,
            scale: 1.25
          }
        },
        {
          version: 1,
          id: "sprout",
          name: "Sprout",
          body: {
            path: "M49.5 19H50.5A3 3 0 0 1 53.5 22V46H46.5V22A3 3 0 0 1 49.5 19ZM49 38C36 41 22.5 36 17.6 23.4A1.4 1.4 0 0 1 18.4 21.6C29 17.5 41.5 21.5 49 34ZM51 30C57 14.5 72 8.5 82.6 11.8A1.4 1.4 0 0 1 83.5 13.4C80.5 27.5 66 35.5 51 34ZM24 44H76A4 4 0 0 1 80 48V54A4 4 0 0 1 76 58H24A4 4 0 0 1 20 54V48A4 4 0 0 1 24 44ZM24 56H76L71 84C70.4 87.5 68 90 64.5 90H35.5C32 90 29.6 87.5 29 84Z"
          },
          eyes: {
            x: 50,
            y: 71,
            spacing: 16,
            scale: 1.05
          }
        },
        {
          version: 1,
          id: "watering-can",
          name: "Watering Can",
          body: {
            path: "M32 38H62C68 38 71 41 72 47L74 76C74.5 82 70 86 64 86H30C24 86 19.5 82 20 76L22 47C23 41 26 38 32 38ZM23 63C14 63 8.5 57 8.5 48C8.5 37 13 30.5 19 30.5C25 30.5 28.5 34 30 39.5L26 52ZM23.5 42C22 38 20 36 17.5 36C15 36 14 41 14 48C14 54 16 57.5 22 58L23.5 47ZM69 66C75 61 78 55 80 46.5L88 49.5C85 62 80 73 72 81ZM78.7 43A7 4.5 25 0 1 91.3 49A7 4.5 25 0 1 78.7 43Z"
          },
          eyes: {
            x: 47,
            y: 61,
            spacing: 16,
            scale: 1.15
          }
        }
      ];
      function getExample(id) {
        return examples.find((e) => e.id === id);
      }
      exports.examples = examples;
      exports.getExample = getExample;
    },
    "eyes.ts": function(__req2, exports) {
      const { HAPPY_ARC } = __req2("validate.ts");
      const STEPS = 40;
      const SLIT = {
        length: 1.9,
        thick: 0.5,
        tip: 0.2
      };
      const clamp2 = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      function resample(pts, count) {
        const n = pts.length;
        const at = [
          0
        ];
        for (let i2 = 0; i2 < n; i2++) {
          const a = pts[i2], b = pts[(i2 + 1) % n];
          at.push(at[i2] + Math.hypot(b[0] - a[0], b[1] - a[1]));
        }
        const total = at[n];
        const out = [];
        let i = 0;
        for (let k = 0; k < count; k++) {
          const s = k / count * total;
          while (i < n - 1 && at[i + 1] < s) i++;
          const a = pts[i], b = pts[(i + 1) % n];
          const u = at[i + 1] > at[i] ? (s - at[i]) / (at[i + 1] - at[i]) : 0;
          out.push([
            a[0] + (b[0] - a[0]) * u,
            a[1] + (b[1] - a[1]) * u
          ]);
        }
        return out;
      }
      function sweep(cx, cy, r, from, to, steps) {
        const pts = [];
        for (let i = 0; i <= steps; i++) {
          const a = from + (to - from) * i / steps;
          pts.push([
            cx + Math.cos(a) * r,
            cy + Math.sin(a) * r
          ]);
        }
        return pts;
      }
      function pill(cx, cy, w, h) {
        const r = Math.min(w, h) / 2;
        const fx = w / 2 - r, fy = h / 2 - r;
        const q = Math.PI / 2;
        return [
          [
            cx,
            cy - h / 2
          ],
          ...sweep(cx + fx, cy - fy, r, -q, 0, 6),
          ...sweep(cx + fx, cy + fy, r, 0, q, 6),
          ...sweep(cx - fx, cy + fy, r, q, 2 * q, 6),
          ...sweep(cx - fx, cy - fy, r, 2 * q, 3 * q, 6)
        ];
      }
      function arc(e) {
        const hw = e.w * HAPPY_ARC.halfWidth, base = e.y + e.h * HAPPY_ARC.base, peak = e.y - e.h * HAPPY_ARC.peak;
        const r = e.w * HAPPY_ARC.stroke / 2;
        const at = (s) => {
          const m = 1 - s;
          const x = e.x + hw * (2 * s - 1), y = (m * m + s * s) * base + 2 * m * s * peak;
          const tx = 2 * hw, ty = 2 * (2 * s - 1) * (base - peak);
          const len = Math.hypot(tx, ty);
          return {
            p: [
              x,
              y
            ],
            n: [
              ty / len,
              -tx / len
            ]
          };
        };
        const edge = (from, to, side) => {
          const pts = [];
          for (let i = 0; i <= 8; i++) {
            const { p, n } = at(from + (to - from) * i / 8);
            pts.push([
              p[0] + n[0] * r * side,
              p[1] + n[1] * r * side
            ]);
          }
          return pts;
        };
        const end = (s) => {
          const { p, n } = at(s);
          const up = Math.atan2(n[1], n[0]);
          return s === 1 ? sweep(p[0], p[1], r, up, up + Math.PI, 8) : sweep(p[0], p[1], r, up + Math.PI, up + 2 * Math.PI, 8);
        };
        return [
          ...edge(0.5, 1, 1),
          ...end(1),
          ...edge(1, 0, -1),
          ...end(0),
          ...edge(0, 0.5, 1)
        ];
      }
      function slit(e) {
        const length = e.w * SLIT.length, thick = e.w * SLIT.thick * clamp2(e.open / e.h, 0.3, 1);
        const cos = Math.cos(SLIT.tip), sin = Math.sin(SLIT.tip);
        return pill(0, 0, length, thick).map(([x, y]) => [
          e.x + x * cos - y * sin,
          e.y + x * sin + y * cos
        ]);
      }
      function plainLook(look) {
        if (look.arc >= 1) return "arc";
        return look.arc <= 0 && look.slit <= 0 ? "pill" : null;
      }
      function eyeOutline(look, e) {
        const a = clamp2(look.arc, 0, 1), s = clamp2(look.slit, 0, 1 - a);
        const shapes = [
          [
            1 - a - s,
            pill(e.x, e.y + e.shift, e.w, e.open)
          ],
          [
            a,
            arc(e)
          ],
          [
            s,
            slit(e)
          ]
        ];
        const out = Array.from({
          length: STEPS
        }, () => [
          0,
          0
        ]);
        for (const [weight, shape] of shapes) {
          if (weight <= 0) continue;
          resample(shape, STEPS).forEach(([x, y], i) => {
            out[i][0] += x * weight;
            out[i][1] += y * weight;
          });
        }
        return out;
      }
      const f = (n) => {
        const r = Math.round(n * 100) / 100;
        return (Object.is(r, -0) ? 0 : r).toString();
      };
      function outlinePath(pts) {
        const n = pts.length;
        const mid = (i) => {
          const a = pts[i % n], b = pts[(i + 1) % n];
          return [
            (a[0] + b[0]) / 2,
            (a[1] + b[1]) / 2
          ];
        };
        const start = mid(n - 1);
        let d = `M${f(start[0])} ${f(start[1])}`;
        for (let i = 0; i < n; i++) {
          const m = mid(i);
          d += `Q${f(pts[i][0])} ${f(pts[i][1])} ${f(m[0])} ${f(m[1])}`;
        }
        return `${d}Z`;
      }
      function eyePath(look, e) {
        return outlinePath(eyeOutline(look, e));
      }
      exports.plainLook = plainLook;
      exports.eyeOutline = eyeOutline;
      exports.outlinePath = outlinePath;
      exports.eyePath = eyePath;
    },
    "follow.ts": function(__req2, exports) {
      const REST = {
        x: 0,
        y: 0,
        attention: 0
      };
      const TAU = 0.12;
      const ATTEND_TAU = 0.3;
      const REACH = 1;
      const MIN_SIZE = 160;
      function pointerGaze(pointer, box, origin = {
        x: 0.5,
        y: 0.5
      }) {
        const reach = Math.max(box.width, box.height, MIN_SIZE) * REACH;
        const dx = (pointer.x - (box.left + box.width * origin.x)) / reach;
        const dy = (pointer.y - (box.top + box.height * origin.y)) / reach;
        const m = Math.hypot(dx, dy);
        if (!Number.isFinite(m) || m < 1e-9) return {
          x: 0,
          y: 0
        };
        const k = Math.tanh(m) / m;
        return {
          x: dx * k,
          y: dy * k
        };
      }
      function followStep(state, target, dt, reduced) {
        const goal = target ? {
          x: target.x,
          y: target.y,
          attention: 1
        } : REST;
        const step = Math.max(0, Math.min(dt, 0.1));
        const ease = (tau) => reduced ? 1 : 1 - Math.exp(-step / tau);
        const k = ease(target ? TAU : ATTEND_TAU);
        const next = {
          x: state.x + (goal.x - state.x) * k,
          y: state.y + (goal.y - state.y) * k,
          attention: state.attention + (goal.attention - state.attention) * ease(ATTEND_TAU)
        };
        const moving = Math.abs(goal.x - next.x) > 2e-3 || Math.abs(goal.y - next.y) > 2e-3 || Math.abs(goal.attention - next.attention) > 2e-3;
        return {
          state: moving ? next : goal,
          moving
        };
      }
      function followGaze(state) {
        const a = Math.min(1, Math.max(0, state.attention));
        return a > 0 ? {
          x: state.x,
          y: state.y,
          weight: a * a * (3 - 2 * a)
        } : void 0;
      }
      exports.REST = REST;
      exports.pointerGaze = pointerGaze;
      exports.followStep = followStep;
      exports.followGaze = followGaze;
    },
    "index.ts": function(__req2, exports) {
      const __re_0 = __req2("validate.ts");
      exports.validateAvatar = __re_0.validateAvatar;
      const __re_1 = __req2("render.ts");
      exports.avatarFrame = __re_1.avatarFrame;
      exports.renderAvatarSvg = __re_1.renderAvatarSvg;
      exports.renderAvatarScene = __re_1.renderAvatarScene;
      exports.sceneFrame = __re_1.sceneFrame;
      exports.DEFAULT_COLOR = __re_1.DEFAULT_COLOR;
      exports.DEFAULT_DEPTH = __re_1.DEFAULT_DEPTH;
      exports.DEFAULT_EYE_COLOR = __re_1.DEFAULT_EYE_COLOR;
      const __re_2 = __req2("motion.ts");
      exports.BASE_PITCH = __re_2.BASE_PITCH;
      exports.BASE_YAW = __re_2.BASE_YAW;
      exports.DONE_CYCLE_S = __re_2.DONE_CYCLE_S;
      exports.DONE_TURN_S = __re_2.DONE_TURN_S;
      exports.MOODS = __re_2.MOODS;
      exports.STATES = __re_2.STATES;
      exports.blendPoses = __re_2.blendPoses;
      exports.computePose = __re_2.computePose;
      exports.isMood = __re_2.isMood;
      exports.isState = __re_2.isState;
      exports.resolveLook = __re_2.resolveLook;
      exports.stateDefinition = __re_2.stateDefinition;
      const __re_3 = __req2("mood.ts");
      exports.MOOD_MS = __re_3.MOOD_MS;
      exports.moodProgress = __re_3.moodProgress;
      exports.settleMood = __re_3.settleMood;
      const __re_4 = __req2("follow.ts");
      exports.REST = __re_4.REST;
      exports.followGaze = __re_4.followGaze;
      exports.followStep = __re_4.followStep;
      exports.pointerGaze = __re_4.pointerGaze;
      const __re_5 = __req2("animator.ts");
      exports.createAnimator = __re_5.createAnimator;
      const __re_6 = __req2("examples.ts");
      exports.examples = __re_6.examples;
      exports.getExample = __re_6.getExample;
    },
    "marks.ts": function(__req2, exports) {
      const TAU = Math.PI * 2;
      const f = (n) => {
        const r = Math.round(n * 100) / 100;
        return (Object.is(r, -0) ? 0 : r).toString();
      };
      const circle = (r) => `M${f(r)} 0A${f(r)} ${f(r)} 0 1 1 ${f(-r)} 0A${f(r)} ${f(r)} 0 1 1 ${f(r)} 0Z`;
      const capsule = (w, h) => {
        const r = w / 2, y = h / 2 - r;
        return `M${f(-r)} ${f(-y)}A${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(-y)}L${f(r)} ${f(y)}A${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(y)}Z`;
      };
      const BANG = {
        id: "bang",
        parts({ unit: u, time: t, still }) {
          const barW = 0.21 * u, barH = 0.5 * u, dot = 0.115 * u, gap = 0.1 * u;
          const total = barH + gap + 2 * dot;
          const p = still ? 1 : (t % 2.6 + 2.6) % 2.6 / 2.6;
          const alarm = p < 0.3 ? p / 0.3 : 1;
          const jump = still ? 0 : Math.sin(Math.PI * alarm);
          const turn = still ? 0 : 0.2 * Math.sin(TAU * 3 * alarm) * (1 - alarm);
          const lift = -0.09 * u * jump;
          const barY = -total / 2 + barH / 2, dotY = total / 2 - dot;
          return [
            {
              shape: "bar",
              d: capsule(barW, barH),
              box: {
                x: -barW / 2,
                y: -barH / 2,
                w: barW,
                h: barH
              },
              x: 0,
              y: barY + lift,
              turn,
              scale: 1,
              round: true
            },
            {
              shape: "dot",
              d: circle(dot),
              box: {
                x: -dot,
                y: -dot,
                w: 2 * dot,
                h: 2 * dot
              },
              x: 0,
              y: dotY + lift * 0.45,
              turn,
              scale: 1,
              round: true
            }
          ];
        }
      };
      const DOTS = {
        id: "dots",
        parts({ unit: u, time: t, still }) {
          const r = 0.1 * u, step = 0.31 * u;
          return [
            0,
            1,
            2
          ].map((i) => {
            const p = still ? 0 : ((t - i * 0.17) % 1.25 + 1.25) % 1.25 / 1.25;
            const hop = p < 0.4 ? Math.sin(Math.PI * (p / 0.4)) : 0;
            return {
              shape: "dot3",
              d: circle(r),
              box: {
                x: -r,
                y: -r,
                w: 2 * r,
                h: 2 * r
              },
              x: (i - 1) * step,
              y: -0.16 * u * hop,
              turn: 0,
              scale: 1 + 0.12 * hop,
              round: true
            };
          });
        }
      };
      function blendMarks(a, b, mix) {
        const weight = (list, id) => {
          var _a;
          return ((_a = list.find((m) => m.mark.id === id)) == null ? void 0 : _a.weight) ?? 0;
        };
        const marks = [
          ...b,
          ...a.filter((m) => !b.some((n) => n.mark.id === m.mark.id))
        ].map((m) => m.mark);
        return marks.map((mark) => ({
          mark,
          weight: mix(weight(a, mark.id), weight(b, mark.id))
        })).filter((m) => m.weight > 0).sort((m, n) => m.mark.id < n.mark.id ? -1 : m.mark.id > n.mark.id ? 1 : 0);
      }
      function poseMarks(given) {
        if (!Array.isArray(given)) return [];
        const marks = [];
        for (const entry of given) {
          const mark = entry == null ? void 0 : entry.mark, weight = entry == null ? void 0 : entry.weight;
          if (typeof (mark == null ? void 0 : mark.id) !== "string" || typeof mark.parts !== "function") continue;
          if (typeof weight !== "number" || !(weight > 0) || marks.some((m) => m.mark.id === mark.id)) continue;
          marks.push({
            mark,
            weight: Math.min(1, weight)
          });
        }
        return marks.sort((m, n) => m.mark.id < n.mark.id ? -1 : m.mark.id > n.mark.id ? 1 : 0);
      }
      function markPartsOf(given) {
        if (!Array.isArray(given)) return [];
        const number = (v, or) => typeof v === "number" && Number.isFinite(v) ? v : or;
        const parts = [];
        for (const part of given) {
          if (typeof part !== "object" || part === null) continue;
          const { shape, d, box } = part;
          if (typeof shape !== "string" || typeof d !== "string" || d === "") continue;
          if (typeof box !== "object" || box === null || ![
            box.x,
            box.y,
            box.w,
            box.h
          ].every(Number.isFinite) || !(box.w > 0 && box.h > 0)) continue;
          parts.push({
            ...part,
            shape,
            d,
            box,
            x: number(part.x, 0),
            y: number(part.y, 0),
            turn: number(part.turn, 0),
            scale: number(part.scale, 1)
          });
        }
        return parts;
      }
      exports.circle = circle;
      exports.capsule = capsule;
      exports.BANG = BANG;
      exports.DOTS = DOTS;
      exports.blendMarks = blendMarks;
      exports.poseMarks = poseMarks;
      exports.markPartsOf = markPartsOf;
    },
    "mood.ts": function(__req2, exports) {
      const MOOD_MS = 420;
      const smooth = (t) => {
        const x = Math.min(1, Math.max(0, t));
        return x * x * (3 - 2 * x);
      };
      function moodProgress(elapsedMs) {
        return smooth(elapsedMs / MOOD_MS);
      }
      function settleMood(state, share = 1, depth = 0) {
        const b = state.blend;
        if (!b) return state;
        const { blend: _, ...settled } = state;
        const rest = share * (1 - b.t);
        if (rest < 0.02 || depth >= 3) return settled;
        return {
          ...settled,
          blend: {
            from: typeof b.from === "string" ? b.from : settleMood(b.from, rest, depth + 1),
            t: b.t
          }
        };
      }
      exports.MOOD_MS = MOOD_MS;
      exports.moodProgress = moodProgress;
      exports.settleMood = settleMood;
    },
    "motion.ts": function(__req2, exports) {
      const { BANG, DOTS, blendMarks, poseMarks } = __req2("marks.ts");
      const STATES = [
        "idle",
        "thinking",
        "working",
        "waiting",
        "blocked",
        "done"
      ];
      const MOODS = [
        "neutral",
        "happy"
      ];
      function isState(value) {
        return STATES.includes(value);
      }
      function isMood(value) {
        return MOODS.includes(value);
      }
      function resolveLook(given) {
        return {
          state: isState(given.state) ? given.state : given.motion === "thinking" ? "thinking" : "idle",
          mood: isMood(given.mood) ? given.mood : given.motion === "happy" ? "happy" : "neutral"
        };
      }
      const BASE_YAW = -0.3;
      const BASE_PITCH = 0.2;
      const LOOK_YAW = 0.32;
      const LOOK_PITCH = 0.18;
      const LOOK_EYES = 0.7;
      const TAU = Math.PI * 2;
      function hashString(s) {
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        return h >>> 0;
      }
      function noise(seed, n) {
        let h = (seed ^ Math.imul(n | 0, 2654435761)) >>> 0;
        h = Math.imul(h ^ h >>> 16, 2246822507);
        h = Math.imul(h ^ h >>> 13, 3266489909);
        h ^= h >>> 16;
        return (h >>> 0) / 4294967296;
      }
      const clamp2 = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      const smooth = (u) => {
        const x = clamp2(u, 0, 1);
        return x * x * (3 - 2 * x);
      };
      const mix = (a, b, k) => a + (b - a) * k;
      function blinkAt(seed, t) {
        const SLOT = 4.2, DUR = 0.19;
        const slot = Math.floor(t / SLOT);
        let closure = 0;
        for (const s of [
          slot - 1,
          slot
        ]) {
          const start = s * SLOT + 0.5 + noise(seed, s * 2) * 2.9;
          const starts = noise(seed, s * 2 + 1) > 0.8 ? [
            start,
            start + 0.34
          ] : [
            start
          ];
          for (const b of starts) {
            const u = (t - b) / DUR;
            if (u > 0 && u < 1) closure = Math.max(closure, Math.sin(Math.PI * u));
          }
        }
        return closure;
      }
      function wanderAt(seed, t) {
        const SLOT = 1.9;
        const s = Math.floor(t / SLOT);
        const target = (k) => {
          if (noise(seed, 1e3 + k * 3) < 0.4) return [
            0,
            0
          ];
          return [
            (noise(seed, 1001 + k * 3) * 2 - 1) * 0.6,
            (noise(seed, 1002 + k * 3) * 2 - 1) * 0.35
          ];
        };
        const a = target(s - 1), b = target(s);
        const e = smooth((t - s * SLOT) / 0.16);
        return [
          a[0] + (b[0] - a[0]) * e,
          a[1] + (b[1] - a[1]) * e
        ];
      }
      function dartAt(seed, t) {
        const SLOT = 0.62;
        const s = Math.floor(t / SLOT);
        const target = (k) => [
          (noise(seed, 2001 + k * 3) * 2 - 1) * 0.8,
          0.1 + noise(seed, 2002 + k * 3) * 0.5
        ];
        const a = target(s - 1), b = target(s);
        const e = smooth((t - s * SLOT) / 0.12);
        return [
          mix(a[0], b[0], e),
          mix(a[1], b[1], e)
        ];
      }
      function blendPoses(a, b, t) {
        const k = clamp2(t, 0, 1);
        const m = (x, y) => mix(x, y, k);
        const sweep = a.ribbons > 0 && b.ribbons > 0 ? m(a.sweep, b.sweep) : a.ribbons > 0 ? a.sweep : b.sweep;
        const cage = a.ribbons > 0 && b.ribbons > 0 ? m(a.cage, b.cage) : a.ribbons > 0 ? a.cage : b.cage;
        return {
          yaw: m(a.yaw, b.yaw),
          pitch: m(a.pitch, b.pitch),
          roll: m(a.roll, b.roll),
          lift: m(a.lift, b.lift),
          sx: m(a.sx, b.sx),
          sy: m(a.sy, b.sy),
          gazeX: m(a.gazeX, b.gazeX),
          gazeY: m(a.gazeY, b.gazeY),
          blink: m(a.blink, b.blink),
          squintL: m(a.squintL, b.squintL),
          squintR: m(a.squintR, b.squintR),
          eyes: {
            arc: m(a.eyes.arc, b.eyes.arc),
            slit: m(a.eyes.slit, b.eyes.slit)
          },
          ribbons: m(a.ribbons, b.ribbons),
          cage,
          sweep,
          marks: blendMarks(a.marks, b.marks, m)
        };
      }
      function computePose(input) {
        const pose = statePose(input);
        const blend = input.blend;
        if (!blend || !(blend.t < 1)) return pose;
        const from = typeof blend.from === "string" ? {
          motion: blend.from
        } : blend.from;
        const stateAge = stateId(lookOf(from).state) === stateId(lookOf(input).state) ? input.stateAge : from.age;
        const before = computePose({
          ...input,
          state: from.state,
          mood: from.mood,
          motion: from.motion,
          stateAge,
          blend: from.blend
        });
        return blendPoses(before, pose, Number.isFinite(blend.t) ? blend.t : 1);
      }
      const DONE_TURN_S = 3.87;
      const DONE_CYCLE_S = 6.2;
      const DONE_SWEEPS = 9;
      const DONE_DRAW_IN_S = 0.5;
      const WORK_FIRST_S = 1.2;
      const WORK_FIRST_JITTER_S = 1.2;
      const WORK_GAP_S = 7.5;
      const WORK_JITTER_S = 1.5;
      const WORK_TURN_S = 1.5;
      const WORK_EASE = 6.2;
      function workTurn(seed, age) {
        const first = WORK_FIRST_S + WORK_FIRST_JITTER_S * noise(seed, 41);
        if (age < first) return null;
        const n = Math.floor((age - first) / WORK_GAP_S);
        for (const k of [
          n,
          n - 1
        ]) {
          if (k < 0) continue;
          const start = first + k * WORK_GAP_S + (k ? WORK_JITTER_S * noise(seed, 60 + k) : 0);
          if (age >= start && age < start + WORK_TURN_S) return age - start;
        }
        return null;
      }
      const near = (angle) => angle - TAU * Math.round(angle / TAU);
      const CELEBRATION_END_S = 3.79;
      const CELEBRATION_SPEED = (DONE_SWEEPS * TAU + 0.5) / 2.4625;
      function celebration(t) {
        const v = CELEBRATION_SPEED;
        if (t <= 0) return 0;
        if (t < 0.24) return -0.25 * (1 - Math.cos(Math.PI * t / 0.24));
        if (t < 0.54) return -0.5 + v * (t - 0.24) ** 2 / 0.6;
        if (t < 2.54) return -0.5 + v * (t - 0.39);
        if (t < CELEBRATION_END_S) return -0.5 + v * 2.15 + 1.25 * v * (1 - (1 - (t - 2.54) / 1.25) ** 4) / 4;
        return DONE_SWEEPS * TAU;
      }
      function rest({ seed, t, reducedMotion, sway, wave, base }, pace) {
        const pose = {
          ...base
        };
        pose.yaw += 0.07 * sway * wave(6.1 * pace);
        pose.pitch += 0.04 * sway * wave(4.7 * pace, 1);
        pose.roll = 1.6 * wave(5.3 * pace, 2);
        pose.lift = reducedMotion ? 0 : -0.45 * (1 - Math.cos(TAU * t / (3.4 * pace)));
        const breath = wave(3.4 * pace, -Math.PI / 2);
        pose.sy = 1 + 0.012 * breath;
        pose.sx = 1 - 8e-3 * breath;
        if (!reducedMotion) {
          pose.blink = blinkAt(seed, t);
          [pose.gazeX, pose.gazeY] = wanderAt(seed, t);
        }
        return pose;
      }
      const STATE_DEFINITIONS = {
        idle: {
          id: "idle",
          pose(ctx) {
            if (ctx.mood !== "happy") return ctx.rest();
            const { t, reducedMotion, live, wave } = ctx;
            const pose = {
              ...ctx.base
            };
            const period = 0.92;
            const p = reducedMotion ? 0.5 : (t % period + period) % period / period;
            const air = 4 * p * (1 - p);
            const land = reducedMotion ? 0 : clamp2(1 - Math.min(p, 1 - p) / 0.12, 0, 1);
            pose.lift = reducedMotion ? 0 : -3.2 * air;
            pose.sy = 1 - 0.09 * land + 0.03 * air * live;
            pose.sx = 1 + 0.07 * land - 0.015 * air * live;
            pose.roll = 4.5 * wave(period * 2);
            pose.yaw += 0.1 * wave(period * 2, 0.6);
            return pose;
          }
        },
        thinking: {
          id: "thinking",
          pose({ seed, t, reducedMotion, live, sway, wave, base }) {
            const pose = {
              ...base
            };
            pose.yaw += 0.12 + 0.05 * sway * wave(7.3);
            pose.pitch += 0.08;
            pose.roll = -5 + 1.4 * wave(4.1);
            pose.lift = -0.5 * (1 - Math.cos(TAU * t / 5.2)) * live;
            pose.gazeX = 0.55 + 0.3 * wave(5.6);
            pose.gazeY = -0.8;
            pose.squintL = 0.22;
            pose.squintR = 0.32 + 0.1 * wave(3.1);
            if (!reducedMotion) pose.blink = blinkAt(seed, t * 0.7);
            pose.marks = [
              {
                mark: DOTS,
                weight: 1
              }
            ];
            return pose;
          }
        },
        working: {
          id: "working",
          pose({ seed, time, t, stateAge, reducedMotion, live, sway, wave, base }) {
            const pose = {
              ...base
            };
            const beat = wave(0.7);
            pose.yaw += 0.08 * sway * wave(2.3, 0.4);
            pose.pitch -= 0.05;
            pose.roll = 3 + 0.6 * beat;
            pose.lift = -0.3 * (0.5 + 0.5 * beat) * live;
            pose.sy = 0.99 - 8e-3 * beat;
            pose.sx = 1.005 + 5e-3 * beat;
            pose.squintL = 0.25;
            pose.squintR = 0.25;
            if (reducedMotion) {
              pose.gazeX = 0.15;
              pose.gazeY = 0.3;
            } else {
              [pose.gazeX, pose.gazeY] = dartAt(seed, t);
              pose.blink = blinkAt(seed, t * 1.3);
            }
            const age = Number.isFinite(stateAge) ? Math.max(0, stateAge) : Math.max(0, time);
            const into = reducedMotion ? null : workTurn(seed, age);
            if (into !== null) {
              const e = WORK_EASE * into;
              const turn = TAU * (1 - (1 + e) * Math.exp(-e));
              const swell = Math.sin(turn / 2);
              pose.ribbons = clamp2(into / 0.16, 0, 1) * clamp2((WORK_TURN_S - into) / 0.5, 0, 1);
              pose.sweep = turn;
              pose.yaw += 0.22 * swell;
              pose.roll += 3 * swell;
              pose.lift -= 1.2 * swell;
              pose.gazeX = clamp2(pose.gazeX * (1 - swell) - 0.85 * Math.sin(turn), -1, 1);
              pose.gazeY = pose.gazeY * (1 - swell) - 0.3 * swell;
            }
            return pose;
          }
        },
        waiting: {
          id: "waiting",
          pose({ seed, t, reducedMotion, live, sway, wave, base }) {
            const pose = {
              ...base
            };
            const p = reducedMotion ? 0 : (t % 6.5 + 6.5) % 6.5 / 6.5;
            const sigh = Math.sin(TAU * clamp2(p / 0.33, 0, 1));
            pose.yaw += 0.04 * sway * wave(7.4);
            pose.pitch += 0.02 + 0.03 * sigh;
            pose.roll = 7 + 1.2 * wave(6.4, 2);
            pose.lift = -0.3 * (1 - Math.cos(TAU * t / 6.5)) * live;
            pose.sy = 1 + 0.025 * sigh;
            pose.sx = 1 - 0.012 * sigh;
            pose.gazeX = 0.5 + 0.15 * wave(8.2);
            pose.gazeY = 0.1;
            pose.eyes = {
              arc: base.eyes.arc,
              slit: 1 - base.eyes.arc
            };
            if (!reducedMotion) pose.blink = blinkAt(seed, t * 0.6);
            return pose;
          }
        },
        blocked: {
          id: "blocked",
          pose: () => ({
            sy: 1.02,
            sx: 0.99,
            marks: [
              {
                mark: BANG,
                weight: 1
              }
            ]
          })
        },
        done: {
          id: "done",
          startAge: DONE_TURN_S,
          pose(ctx) {
            const { seed, stateAge, reducedMotion } = ctx;
            const pose = ctx.rest(1.25);
            const age = !reducedMotion && Number.isFinite(stateAge) ? Math.max(0, stateAge) : DONE_TURN_S;
            const length = DONE_CYCLE_S * (1 + 0.15 * noise(seed, 31));
            const cycle = Math.floor(age / length), since = age - cycle * length;
            if (since < DONE_TURN_S) {
              const swell = Math.sin(Math.PI * since / DONE_TURN_S);
              const way = cycle % 2 ? -1 : 1;
              const sweep = celebration(since) * way;
              pose.yaw += near(sweep / 3);
              pose.lift -= 2.2 * swell;
              pose.sy += 0.04 * swell;
              pose.ribbons = clamp2(since / 0.1, 0, 1) * clamp2((DONE_TURN_S - since) / DONE_DRAW_IN_S, 0, 1);
              pose.cage = 1;
              pose.sweep = way * Math.max(0, celebration(since));
            }
            return pose;
          }
        }
      };
      function isStateDefinition(value) {
        const v = value;
        return typeof v === "object" && v !== null && typeof v.id === "string" && typeof v.pose === "function";
      }
      function stateDefinition(state) {
        return typeof state === "string" ? STATE_DEFINITIONS[state] : state;
      }
      function stateId(state) {
        return typeof state === "string" ? state : state.id;
      }
      function lookOf(given) {
        const named = resolveLook(given);
        return isStateDefinition(given.state) ? {
          state: given.state,
          mood: named.mood
        } : named;
      }
      const POSE_NUMBERS = [
        "yaw",
        "pitch",
        "roll",
        "lift",
        "sx",
        "sy",
        "gazeX",
        "gazeY",
        "blink",
        "squintL",
        "squintR",
        "ribbons",
        "cage",
        "sweep"
      ];
      function laid(base, given) {
        var _a, _b;
        const pose = {
          ...base
        };
        if (typeof given !== "object" || given === null) return pose;
        const number = (v, or) => typeof v === "number" && Number.isFinite(v) ? v : or;
        for (const key of POSE_NUMBERS) pose[key] = number(given[key], base[key]);
        pose.eyes = {
          arc: number((_a = given.eyes) == null ? void 0 : _a.arc, base.eyes.arc),
          slit: number((_b = given.eyes) == null ? void 0 : _b.slit, base.eyes.slit)
        };
        if (given.marks !== void 0) pose.marks = poseMarks(given.marks);
        return pose;
      }
      function statePose(input) {
        const { seed, time, gaze, reducedMotion, view } = input;
        const { state, mood } = lookOf(input);
        const t = reducedMotion ? 0 : time + noise(seed, 7) * 10;
        const given = gaze && Number.isFinite(gaze.x) && Number.isFinite(gaze.y) ? [
          clamp2(gaze.x, -1, 1),
          clamp2(gaze.y, -1, 1)
        ] : null;
        const weight = given ? Number.isFinite(gaze == null ? void 0 : gaze.weight) ? clamp2(gaze == null ? void 0 : gaze.weight, 0, 1) : 1 : 0;
        const base = {
          yaw: BASE_YAW,
          pitch: BASE_PITCH,
          roll: 0,
          lift: 0,
          sx: 1,
          sy: 1,
          gazeX: 0,
          gazeY: 0,
          blink: 0,
          squintL: 0,
          squintR: 0,
          eyes: {
            arc: mood === "happy" ? 1 : 0,
            slit: 0
          },
          ribbons: 0,
          cage: 0,
          sweep: 0,
          marks: []
        };
        const ctx = {
          seed,
          time,
          t,
          stateAge: input.stateAge,
          mood,
          reducedMotion,
          live: reducedMotion ? 0 : 1,
          sway: 1 - 0.7 * weight,
          wave: (period, phase = 0) => reducedMotion ? 0 : Math.sin(TAU * t / period + phase),
          base
        };
        const pose = laid(base, stateDefinition(state).pose({
          ...ctx,
          rest: (pace = 1) => rest(ctx, pace)
        }));
        if (given && weight > 0) {
          const share = reducedMotion ? 1 : LOOK_EYES;
          const follow = weight * (1 - pose.eyes.arc);
          pose.gazeX = mix(pose.gazeX, given[0] * share, follow);
          pose.gazeY = mix(pose.gazeY, given[1] * share, follow);
          if (!reducedMotion) {
            pose.yaw += weight * (given[0] * LOOK_YAW - BASE_YAW);
            pose.pitch += weight * (-given[1] * LOOK_PITCH - BASE_PITCH / 2);
          }
        }
        if (view && Number.isFinite(view.yaw) && Number.isFinite(view.pitch)) {
          pose.yaw += view.yaw;
          pose.pitch += view.pitch;
        }
        return pose;
      }
      exports.STATES = STATES;
      exports.MOODS = MOODS;
      exports.isState = isState;
      exports.isMood = isMood;
      exports.resolveLook = resolveLook;
      exports.BASE_YAW = BASE_YAW;
      exports.BASE_PITCH = BASE_PITCH;
      exports.LOOK_YAW = LOOK_YAW;
      exports.LOOK_PITCH = LOOK_PITCH;
      exports.LOOK_EYES = LOOK_EYES;
      exports.hashString = hashString;
      exports.noise = noise;
      exports.blinkAt = blinkAt;
      exports.wanderAt = wanderAt;
      exports.blendPoses = blendPoses;
      exports.computePose = computePose;
      exports.DONE_TURN_S = DONE_TURN_S;
      exports.DONE_CYCLE_S = DONE_CYCLE_S;
      exports.isStateDefinition = isStateDefinition;
      exports.stateDefinition = stateDefinition;
      exports.stateId = stateId;
      exports.lookOf = lookOf;
    },
    "path.ts": function(__req2, exports) {
      const PATH_LIMITS = {
        maxChars: 6e3,
        maxSegments: 400,
        maxSubpaths: 16,
        coordMin: -20,
        coordMax: 120
      };
      const ARG_COUNT = {
        M: 2,
        L: 2,
        H: 1,
        V: 1,
        C: 6,
        S: 4,
        Q: 4,
        T: 2,
        A: 7,
        Z: 0
      };
      class PathError extends Error {
      }
      function tokenize(d) {
        if (/[^MmLlHhVvCcSsQqTtAaZz0-9.,eE+\-\s]/.test(d)) {
          const bad = d.match(/[^MmLlHhVvCcSsQqTtAaZz0-9.,eE+\-\s]/)[0];
          throw new PathError(`unsupported character ${JSON.stringify(bad)} (allowed commands: M L H V C S Q T A Z)`);
        }
        const tokens = [];
        const re = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([\s,]+)/y;
        let i = 0;
        while (i < d.length) {
          re.lastIndex = i;
          const m = re.exec(d);
          if (!m) throw new PathError(`cannot parse path near ${JSON.stringify(d.slice(i, i + 12))}`);
          if (m[1]) tokens.push(m[1]);
          else if (m[2]) tokens.push(Number(m[2]));
          i = re.lastIndex;
        }
        return tokens;
      }
      function parsePath(d, bounded = true) {
        if (typeof d !== "string" || d.trim() === "") throw new PathError("path is empty");
        if (d.length > PATH_LIMITS.maxChars) throw new PathError(`path longer than ${PATH_LIMITS.maxChars} characters`);
        const tokens = tokenize(d);
        const out = [];
        let i = 0;
        let cx = 0, cy = 0, sx = 0, sy = 0;
        let prevC = null;
        let prevQ = null;
        let cmd = "";
        let subpaths = 0;
        let open = false;
        while (i < tokens.length) {
          const t = tokens[i];
          if (typeof t === "string") {
            cmd = t;
            i++;
            if (cmd === "Z" || cmd === "z") {
              if (!open) throw new PathError("Z without an open subpath");
              out.push({
                c: "Z"
              });
              cx = sx;
              cy = sy;
              prevC = prevQ = null;
              open = false;
              continue;
            }
          } else if (!cmd) {
            throw new PathError("path must start with M");
          } else if (cmd === "Z" || cmd === "z") {
            throw new PathError("numbers after Z");
          }
          const up = cmd.toUpperCase();
          const rel = cmd !== up;
          if (out.length === 0 && up !== "M") throw new PathError("path must start with M");
          const n = ARG_COUNT[up];
          const args = [];
          for (let k = 0; k < n; k++) {
            const v = tokens[i + k];
            if (typeof v !== "number") throw new PathError(`command ${cmd} expects ${n} numbers`);
            if (!Number.isFinite(v)) throw new PathError("non-finite number");
            args.push(v);
          }
          i += n;
          const ox = rel ? cx : 0, oy = rel ? cy : 0;
          let nextC = null;
          let nextQ = null;
          switch (up) {
            case "M": {
              if (open) out.push({
                c: "Z"
              });
              cx = args[0] + ox;
              cy = args[1] + oy;
              sx = cx;
              sy = cy;
              out.push({
                c: "M",
                x: cx,
                y: cy
              });
              subpaths++;
              open = true;
              cmd = rel ? "l" : "L";
              break;
            }
            case "L":
              cx = args[0] + ox;
              cy = args[1] + oy;
              out.push({
                c: "L",
                x: cx,
                y: cy
              });
              break;
            case "H":
              cx = args[0] + ox;
              out.push({
                c: "L",
                x: cx,
                y: cy
              });
              break;
            case "V":
              cy = args[0] + oy;
              out.push({
                c: "L",
                x: cx,
                y: cy
              });
              break;
            case "C": {
              const s = {
                c: "C",
                x1: args[0] + ox,
                y1: args[1] + oy,
                x2: args[2] + ox,
                y2: args[3] + oy,
                x: args[4] + ox,
                y: args[5] + oy
              };
              out.push(s);
              nextC = [
                s.x2,
                s.y2
              ];
              cx = s.x;
              cy = s.y;
              break;
            }
            case "S": {
              const x1 = prevC ? 2 * cx - prevC[0] : cx, y1 = prevC ? 2 * cy - prevC[1] : cy;
              const s = {
                c: "C",
                x1,
                y1,
                x2: args[0] + ox,
                y2: args[1] + oy,
                x: args[2] + ox,
                y: args[3] + oy
              };
              out.push(s);
              nextC = [
                s.x2,
                s.y2
              ];
              cx = s.x;
              cy = s.y;
              break;
            }
            case "Q": {
              const s = {
                c: "Q",
                x1: args[0] + ox,
                y1: args[1] + oy,
                x: args[2] + ox,
                y: args[3] + oy
              };
              out.push(s);
              nextQ = [
                s.x1,
                s.y1
              ];
              cx = s.x;
              cy = s.y;
              break;
            }
            case "T": {
              const x1 = prevQ ? 2 * cx - prevQ[0] : cx, y1 = prevQ ? 2 * cy - prevQ[1] : cy;
              const s = {
                c: "Q",
                x1,
                y1,
                x: args[0] + ox,
                y: args[1] + oy
              };
              out.push(s);
              nextQ = [
                x1,
                y1
              ];
              cx = s.x;
              cy = s.y;
              break;
            }
            case "A": {
              const [rx, ry, rot, la, sw] = args;
              if (rx < 0 || ry < 0) throw new PathError("arc radii must be non-negative");
              if (la !== 0 && la !== 1 || sw !== 0 && sw !== 1) throw new PathError("arc flags must be 0 or 1, written as separate numbers");
              cx = args[5] + ox;
              cy = args[6] + oy;
              out.push({
                c: "A",
                rx,
                ry,
                rot,
                large: la,
                sweep: sw,
                x: cx,
                y: cy
              });
              break;
            }
            default:
              throw new PathError(`unsupported command ${cmd}`);
          }
          prevC = nextC;
          prevQ = nextQ;
          if (out.length > PATH_LIMITS.maxSegments) throw new PathError(`more than ${PATH_LIMITS.maxSegments} segments`);
        }
        if (open) out.push({
          c: "Z"
        });
        if (subpaths > PATH_LIMITS.maxSubpaths) throw new PathError(`more than ${PATH_LIMITS.maxSubpaths} subpaths`);
        for (const s of bounded ? out : []) {
          for (const [k, v] of Object.entries(s)) {
            if (k === "c" || typeof v !== "number") continue;
            if (k === "rot" || k === "large" || k === "sweep") continue;
            if (v < PATH_LIMITS.coordMin || v > PATH_LIMITS.coordMax) throw new PathError(`coordinate ${v} far outside the 0..100 viewBox`);
          }
        }
        return out;
      }
      function fmt(n) {
        const r = Math.round(n * 100) / 100;
        return (Object.is(r, -0) ? 0 : r).toString();
      }
      function serializePath(segs) {
        const parts = [];
        for (const s of segs) {
          switch (s.c) {
            case "M":
              parts.push(`M${fmt(s.x)} ${fmt(s.y)}`);
              break;
            case "L":
              parts.push(`L${fmt(s.x)} ${fmt(s.y)}`);
              break;
            case "C":
              parts.push(`C${fmt(s.x1)} ${fmt(s.y1)} ${fmt(s.x2)} ${fmt(s.y2)} ${fmt(s.x)} ${fmt(s.y)}`);
              break;
            case "Q":
              parts.push(`Q${fmt(s.x1)} ${fmt(s.y1)} ${fmt(s.x)} ${fmt(s.y)}`);
              break;
            case "A":
              parts.push(`A${fmt(s.rx)} ${fmt(s.ry)} ${fmt(s.rot)} ${s.large} ${s.sweep} ${fmt(s.x)} ${fmt(s.y)}`);
              break;
            case "Z":
              parts.push("Z");
              break;
          }
        }
        return parts.join("");
      }
      function sampleArc(x0, y0, s, out) {
        let { rx, ry } = s;
        const { x, y } = s;
        if (rx === 0 || ry === 0 || x0 === x && y0 === y) {
          out.push([
            x,
            y
          ]);
          return;
        }
        const phi = s.rot * Math.PI / 180;
        const cos = Math.cos(phi), sin = Math.sin(phi);
        const dx = (x0 - x) / 2, dy = (y0 - y) / 2;
        const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
        rx = Math.abs(rx);
        ry = Math.abs(ry);
        const lambda = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
        if (lambda > 1) {
          const k = Math.sqrt(lambda);
          rx *= k;
          ry *= k;
        }
        const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
        const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
        let coef = Math.sqrt(Math.max(0, num / den));
        if (s.large === s.sweep) coef = -coef;
        const cxp = coef * rx * y1p / ry, cyp = -coef * ry * x1p / rx;
        const cx = cos * cxp - sin * cyp + (x0 + x) / 2;
        const cy = sin * cxp + cos * cyp + (y0 + y) / 2;
        const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
        const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
        let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
        if (!s.sweep && dt > 0) dt -= 2 * Math.PI;
        if (s.sweep && dt < 0) dt += 2 * Math.PI;
        const step = 2 * Math.acos(Math.max(-1, 1 - FLATNESS / Math.max(rx, ry)));
        const steps = Math.min(256, Math.max(4, Math.ceil(Math.abs(dt) / step)));
        for (let k = 1; k <= steps; k++) {
          const t = t1 + dt * k / steps;
          const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
          out.push([
            cos * ex - sin * ey + cx,
            sin * ex + cos * ey + cy
          ]);
        }
      }
      const FLATNESS = 0.02;
      function flattenPath(segs) {
        const polys = [];
        let cur = [];
        let px = 0, py = 0;
        for (const s of segs) {
          switch (s.c) {
            case "M":
              if (cur.length) polys.push(cur);
              cur = [
                [
                  s.x,
                  s.y
                ]
              ];
              px = s.x;
              py = s.y;
              break;
            case "L":
              cur.push([
                s.x,
                s.y
              ]);
              px = s.x;
              py = s.y;
              break;
            case "C": {
              const m = Math.max(Math.hypot(px - 2 * s.x1 + s.x2, py - 2 * s.y1 + s.y2), Math.hypot(s.x1 - 2 * s.x2 + s.x, s.y1 - 2 * s.y2 + s.y));
              const n = Math.min(128, Math.max(2, Math.ceil(Math.sqrt(0.75 * m / FLATNESS))));
              for (let k = 1; k <= n; k++) {
                const t = k / n, u = 1 - t;
                cur.push([
                  u * u * u * px + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x,
                  u * u * u * py + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y
                ]);
              }
              px = s.x;
              py = s.y;
              break;
            }
            case "Q": {
              const n = Math.min(128, Math.max(2, Math.ceil(Math.sqrt(0.25 * Math.hypot(px - 2 * s.x1 + s.x, py - 2 * s.y1 + s.y) / FLATNESS))));
              for (let k = 1; k <= n; k++) {
                const t = k / n, u = 1 - t;
                cur.push([
                  u * u * px + 2 * u * t * s.x1 + t * t * s.x,
                  u * u * py + 2 * u * t * s.y1 + t * t * s.y
                ]);
              }
              px = s.x;
              py = s.y;
              break;
            }
            case "A":
              sampleArc(px, py, s, cur);
              px = s.x;
              py = s.y;
              break;
            case "Z":
              if (cur.length) {
                polys.push(cur);
                px = cur[0][0];
                py = cur[0][1];
              }
              cur = [];
              break;
          }
        }
        if (cur.length) polys.push(cur);
        return polys.filter((p) => p.length >= 3);
      }
      function winding(polys, x, y) {
        let w = 0;
        for (const poly of polys) {
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const [xi, yi] = poly[i];
            const [xj, yj] = poly[j];
            if (yj <= y) {
              if (yi > y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) > 0) w++;
            } else if (yi <= y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) < 0) w--;
          }
        }
        return w;
      }
      function isInside(polys, x, y) {
        return winding(polys, x, y) !== 0;
      }
      function insideRow(polys, y, xs, out) {
        const hits = [];
        for (const poly of polys) {
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const [xj, yj] = poly[j], [xi, yi] = poly[i];
            if (yj <= y && yi > y) hits.push([
              xj + (y - yj) * (xi - xj) / (yi - yj),
              1
            ]);
            else if (yi <= y && yj > y) hits.push([
              xj + (y - yj) * (xi - xj) / (yi - yj),
              -1
            ]);
          }
        }
        hits.sort((a, b) => a[0] - b[0]);
        let w = 0, h = 0;
        for (let k = 0; k < xs.length; k++) {
          while (h < hits.length && hits[h][0] < xs[k]) w += hits[h++][1];
          out[k] = w !== 0 ? 1 : 0;
        }
      }
      class EdgeBands {
        e;
        start;
        items;
        y0;
        inv;
        n;
        hitX = new Float64Array(16);
        hitDir = new Int8Array(16);
        constructor(polys) {
          let count = 0;
          for (const poly of polys) count += poly.length;
          const e = this.e = new Float64Array(4 * count);
          let k = 0, lo = Infinity, hi = -Infinity, climb = 0;
          for (const poly of polys) {
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              const yj = poly[j][1], yi = poly[i][1];
              e[k] = poly[j][0];
              e[k + 1] = yj;
              e[k + 2] = poly[i][0];
              e[k + 3] = yi;
              k += 4;
              if (yj < lo) lo = yj;
              if (yj > hi) hi = yj;
              climb += Math.abs(yi - yj);
            }
          }
          const tall = climb > 0 ? Math.floor(3 * count * (hi - lo) / climb) : Infinity;
          const n = this.n = Math.max(1, Math.min(512, Math.ceil(count / 4), tall));
          this.y0 = count ? lo : 0;
          this.inv = hi > lo ? n / (hi - lo) : 0;
          const start = this.start = new Int32Array(n + 1);
          for (k = 0; k < e.length; k += 4) {
            const a = this.band(Math.min(e[k + 1], e[k + 3])), b = this.band(Math.max(e[k + 1], e[k + 3]));
            for (let q = a; q <= b; q++) start[q + 1]++;
          }
          for (let q = 0; q < n; q++) start[q + 1] += start[q];
          const items = this.items = new Int32Array(start[n]);
          const next = start.slice(0, n);
          for (k = 0; k < e.length; k += 4) {
            const a = this.band(Math.min(e[k + 1], e[k + 3])), b = this.band(Math.max(e[k + 1], e[k + 3]));
            for (let q = a; q <= b; q++) items[next[q]++] = k;
          }
        }
        band(y) {
          const q = Math.floor((y - this.y0) * this.inv);
          return q >= this.n ? this.n - 1 : q > 0 ? q : 0;
        }
        winding(x, y) {
          const { e, items } = this;
          const b = this.band(y);
          let w = 0;
          for (let q = this.start[b], end = this.start[b + 1]; q < end; q++) {
            const k = items[q];
            const xj = e[k], yj = e[k + 1], xi = e[k + 2], yi = e[k + 3];
            if (yj <= y) {
              if (yi > y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) > 0) w++;
            } else if (yi <= y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) < 0) w--;
          }
          return w;
        }
        crossings(y) {
          const { e, items } = this;
          const b = this.band(y);
          const end = this.start[b + 1];
          if (end - this.start[b] > this.hitX.length) {
            this.hitX = new Float64Array(2 * (end - this.start[b]));
            this.hitDir = new Int8Array(this.hitX.length);
          }
          const hx = this.hitX, hd = this.hitDir;
          let n = 0;
          for (let q = this.start[b]; q < end; q++) {
            const k = items[q];
            const xj = e[k], yj = e[k + 1], xi = e[k + 2], yi = e[k + 3];
            let dir = 0;
            if (yj <= y && yi > y) dir = 1;
            else if (yi <= y && yj > y) dir = -1;
            else continue;
            const x = xj + (y - yj) * (xi - xj) / (yi - yj);
            let m = n++;
            for (; m > 0 && hx[m - 1] > x; m--) {
              hx[m] = hx[m - 1];
              hd[m] = hd[m - 1];
            }
            hx[m] = x;
            hd[m] = dir;
          }
          return n;
        }
        insideRow(y, xs, out) {
          const n = this.crossings(y);
          const hx = this.hitX, hd = this.hitDir;
          let w = 0, h = 0;
          for (let k = 0; k < xs.length; k++) {
            while (h < n && hx[h] < xs[k]) w += hd[h++];
            out[k] = w !== 0 ? 1 : 0;
          }
        }
        insideRowAt(x, y) {
          const n = this.crossings(y);
          let w = 0;
          for (let h = 0; h < n && this.hitX[h] < x; h++) w += this.hitDir[h];
          return w !== 0;
        }
      }
      const bands = /* @__PURE__ */ new WeakMap();
      function edgeBands(polys) {
        let index = bands.get(polys);
        if (!index) bands.set(polys, index = new EdgeBands(polys));
        return index;
      }
      function bounds(polys) {
        const b = {
          minX: Infinity,
          minY: Infinity,
          maxX: -Infinity,
          maxY: -Infinity
        };
        for (const p of polys) for (let k = 0; k < p.length; k++) {
          const x = p[k][0], y = p[k][1];
          if (x < b.minX) b.minX = x;
          if (y < b.minY) b.minY = y;
          if (x > b.maxX) b.maxX = x;
          if (y > b.maxY) b.maxY = y;
        }
        return b;
      }
      function filledArea(polys, b = bounds(polys)) {
        let n = 0;
        const xs = [];
        for (let x = Math.floor(b.minX) + 0.5; x < b.maxX; x += 1) xs.push(x);
        const row = new Uint8Array(xs.length);
        const index = edgeBands(polys);
        for (let y = Math.floor(b.minY) + 0.5; y < b.maxY; y += 1) {
          index.insideRow(y, xs, row);
          for (const v of row) n += v;
        }
        return n;
      }
      function splitSubpaths(segs) {
        var _a;
        const out = [];
        for (const s of segs) {
          if (s.c === "M") out.push([]);
          (_a = out[out.length - 1]) == null ? void 0 : _a.push(s);
        }
        return out;
      }
      exports.PATH_LIMITS = PATH_LIMITS;
      exports.PathError = PathError;
      exports.parsePath = parsePath;
      exports.serializePath = serializePath;
      exports.FLATNESS = FLATNESS;
      exports.flattenPath = flattenPath;
      exports.winding = winding;
      exports.isInside = isInside;
      exports.insideRow = insideRow;
      exports.EdgeBands = EdgeBands;
      exports.edgeBands = edgeBands;
      exports.bounds = bounds;
      exports.filledArea = filledArea;
      exports.splitSubpaths = splitSubpaths;
    },
    "render.ts": function(__req2, exports) {
      const { mix, oklch, parseHex, toHex, toOklch } = __req2("color.ts");
      const { bodyScale, markParts, ribbonPieces, ribbonReach, rimOf } = __req2("effects.ts");
      const { eyePath, plainLook } = __req2("eyes.ts");
      const { computePose, hashString, noise } = __req2("motion.ts");
      const { EYE_H, EYE_W, GAZE_X, GAZE_Y, HAPPY_ARC, analyzeBody, eyeCenters, gazeRange, validateAvatar } = __req2("validate.ts");
      const { buildVolume } = __req2("volume.ts");
      const DEFAULT_COLOR = "#ff6a1a";
      const DEFAULT_EYE_COLOR = "#151515";
      const DEFAULT_DEPTH = 6;
      const MAX_DEPTH = 14;
      const CSS_EYE_LIFT = 1.5;
      const cache = /* @__PURE__ */ new Map();
      const f = (n) => {
        const r = Math.round(n * 100) / 100;
        return (Object.is(r, -0) ? 0 : r).toString();
      };
      const clamp2 = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      function depthOption(options) {
        const d = clamp2(Number.isFinite(options.depth) ? options.depth : DEFAULT_DEPTH, 0, MAX_DEPTH);
        return Math.round(d * 2) / 2;
      }
      const lazy = (make) => {
        let value;
        return () => value ?? (value = make());
      };
      function ribbonRims(polys, b) {
        const [cx, cy] = pivotOf(b);
        const bx = (b.minX + b.maxX) / 2, by = b.maxY;
        const posed = (rolls, sys) => {
          const out = [];
          for (const roll of rolls) {
            const r = roll * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
            for (const k of sys) {
              out.push(polys.map((poly) => poly.map(([x, y]) => {
                const lx = bx + c * (x - bx) - sn * (y - by), ly = by + sn * (x - bx) + c * (y - by);
                return [
                  cx + 1.01 * (lx - cx),
                  cy + k * (ly - cy)
                ];
              })));
            }
          }
          return out;
        };
        return {
          work: rimOf(posed([
            2.4,
            4.5,
            6.6
          ], [
            0.98,
            1
          ]), cx, cy),
          cage: rimOf(posed([
            -1.7,
            0,
            1.7
          ], [
            0.99,
            1.055
          ]), cx, cy)
        };
      }
      function ribbonsFollow(rim, pose, b) {
        const bx = (b.minX + b.maxX) / 2, by = b.maxY;
        return {
          ...rim,
          cx: bx + pose.sx * (rim.cx - bx),
          cy: by + pose.sy * (rim.cy - by) + pose.lift
        };
      }
      let geometryHits = /* @__PURE__ */ new WeakMap();
      const emptyPrefix = "[null,null,null";
      function prepare(definition, depth) {
        var _a;
        const id = definition == null ? void 0 : definition.id, name = definition == null ? void 0 : definition.name, path = (_a = definition == null ? void 0 : definition.body) == null ? void 0 : _a.path, eyes = definition == null ? void 0 : definition.eyes;
        if (typeof definition === "object" && typeof id === "string" && typeof name === "string" && typeof path === "string" && !("toJSON" in Array.prototype)) {
          const tail = JSON.stringify([
            null,
            null,
            null,
            eyes,
            depth
          ]);
          const hit = geometryHits.get(definition);
          if (hit && hit.id === id && hit.name === name && hit.path === path && hit.tail === tail) return hit.prepared;
          const key = `[${JSON.stringify(id)},${JSON.stringify(name)},${JSON.stringify(path)}${tail.slice(emptyPrefix.length)}`;
          const prepared = prepareKey(definition, depth, key);
          geometryHits.set(definition, {
            id,
            name,
            path,
            tail,
            prepared
          });
          return prepared;
        }
        return prepareKey(definition, depth, JSON.stringify([
          id,
          name,
          path,
          eyes,
          depth
        ]));
      }
      function prepareKey(definition, depth, key) {
        const hit = cache.get(key);
        if (hit) return hit;
        const res = validateAvatar(definition);
        if (!res.ok) throw new Error(`Invalid avatar definition: ${res.errors.join("; ")}`);
        const def = res.value;
        const body = analyzeBody(def.body.path);
        const vol = buildVolume(def, depth / DEFAULT_DEPTH, body);
        const id = `oba-${hashString(`${def.id}|${def.body.path}|${depth}`).toString(36)}`;
        const ids = /* @__PURE__ */ new Map();
        for (const part of vol.parts) for (const s of [
          ...part.zSlices,
          ...part.xSlices
        ]) if (!ids.has(s.d)) ids.set(s.d, `${id}-${ids.size}`);
        const prepared = {
          def,
          vol,
          range: gazeRange(body.polys, {
            ...def.eyes,
            scale: vol.eyeScale
          }),
          seed: hashString(def.id),
          id,
          ids,
          detail: /* @__PURE__ */ new Map(),
          rims: lazy(() => ribbonRims(body.polys, vol.bounds))
        };
        if (cache.size >= 64) {
          cache.delete(cache.keys().next().value);
          geometryHits = /* @__PURE__ */ new WeakMap();
        }
        cache.set(key, prepared);
        return prepared;
      }
      function preparedVolume(definition, depth) {
        const p = prepare(definition, depthOption({
          depth
        }));
        return {
          def: p.def,
          vol: p.vol
        };
      }
      function poseOf(p, options) {
        return computePose({
          seed: p.seed,
          time: Number.isFinite(options.time) ? options.time : 0,
          state: options.state,
          mood: options.mood,
          motion: options.motion,
          stateAge: options.stateAge,
          gaze: options.gaze,
          reducedMotion: options.reducedMotion === true,
          view: options.view,
          blend: options.motionBlend
        });
      }
      function esc(s) {
        return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      }
      const mul = (m, n) => [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5]
      ];
      const translate = (x, y) => [
        1,
        0,
        0,
        1,
        x,
        y
      ];
      const about = (x, y, m) => mul(translate(x, y), mul(m, translate(-x, -y)));
      const invert = ([a, b, c, d, e, g]) => {
        const det = a * d - b * c;
        return [
          d / det,
          -b / det,
          -c / det,
          a / det,
          (c * g - d * e) / det,
          (b * e - a * g) / det
        ];
      };
      const mat = (m) => `matrix(${m.map((v, i) => i < 4 ? (Math.round(v * 1e4) / 1e4).toString() : f(v)).join(" ")})`;
      function viewBasis(yaw, pitch) {
        const cY = Math.cos(yaw), cP = Math.cos(pitch);
        return {
          cY,
          sY: Math.sin(yaw),
          cP,
          sP: Math.sin(pitch),
          facing: cY * cP
        };
      }
      function facingOf(v, [x, y, z]) {
        return v.sP * y + v.cP * (-v.sY * x + v.cY * z);
      }
      function eyeVisible(v, plane) {
        return facingOf(v, [
          -plane.dzdx,
          -plane.dzdy,
          1
        ]) > 1e-6;
      }
      function eyeMatrix(v, { x, y, z, dzdx, dzdy }, pivot) {
        const m = planeMatrix(v, z - x * dzdx - y * dzdy, pivot);
        m[0] += v.sY * dzdx;
        m[1] -= v.cY * v.sP * dzdx;
        m[2] += v.sY * dzdy;
        m[3] -= v.cY * v.sP * dzdy;
        return m;
      }
      function activeStack(v) {
        return Math.abs(v.cY) >= Math.abs(v.sY) ? "z" : "x";
      }
      function planeMatrix(v, z, pivot) {
        const [cx, cy] = pivot;
        return [
          v.cY,
          v.sY * v.sP,
          0,
          v.cP,
          cx - v.cY * cx + v.sY * z,
          cy - v.cP * cy - v.sY * v.sP * cx - v.cY * v.sP * z
        ];
      }
      function sidePlaneMatrix(v, x0, pivot) {
        const [cx, cy] = pivot;
        return [
          -v.sY,
          v.cY * v.sP,
          0,
          v.cP,
          cx + v.cY * (x0 - cx),
          cy - v.cP * cy + v.sY * v.sP * (x0 - cx)
        ];
      }
      function projectPoint(v, [x, y, z], pivot) {
        const m = planeMatrix(v, z, pivot);
        const X = x - pivot[0], Y = y - pivot[1];
        return [
          m[0] * x + m[2] * y + m[4],
          m[1] * x + m[3] * y + m[5],
          v.sP * Y + v.cP * (-v.sY * X + v.cY * z)
        ];
      }
      function rootMatrix(pose, b) {
        const bx = (b.minX + b.maxX) / 2, by = b.maxY;
        const r = pose.roll * Math.PI / 180;
        const rot = [
          Math.cos(r),
          Math.sin(r),
          -Math.sin(r),
          Math.cos(r),
          0,
          0
        ];
        return mul(translate(0, pose.lift), about(bx, by, mul(rot, [
          pose.sx,
          0,
          0,
          pose.sy,
          0,
          0
        ])));
      }
      const pivotOf = (b) => [
        (b.minX + b.maxX) / 2,
        (b.minY + b.maxY) / 2
      ];
      const POSE_LIFT = 4;
      const POSE_SWAY = 0.2;
      function avatarExtent(definition, depth) {
        const p = prepare(definition, depthOption({
          depth
        }));
        const { vol } = p;
        const b = vol.bounds;
        const [cx, cy] = pivotOf(b);
        const radius = Math.hypot(b.maxX - b.minX, b.maxY - b.minY, Math.max(...vol.parts.map((part) => part.depth)) + 2 * CSS_EYE_LIFT) / 2;
        const { work, cage } = p.rims();
        const reach = (rim) => {
          const r = ribbonReach(rim.max);
          return Math.hypot(rim.cx - cx, rim.cy - cy) + POSE_LIFT + POSE_SWAY * Math.abs(b.maxY - rim.cy) + r.radius + r.band + 1.2;
        };
        const half = Math.max(radius + POSE_LIFT + POSE_SWAY * (radius + b.maxY - cy), reach(work), reach(cage));
        return {
          x: cx - half,
          y: cy - half,
          size: 2 * half
        };
      }
      const SLICE_SCREEN_GAP_PX = 0.55;
      function drawnSlices(p, v, size, visit) {
        const { vol } = p;
        const stack = activeStack(v);
        const pivot = pivotOf(vol.bounds);
        const drawn = sliceCull(v);
        const kept = sliceDetail(p, stack, size);
        const px = Number.isFinite(size) && size > 0 ? size : 0;
        const sweep = stack === "z" ? Math.hypot(v.sY, v.cY * v.sP) : 0;
        const minShift = px && stack === "z" ? sweep > 1e-4 ? SLICE_SCREEN_GAP_PX * 100 / (px * sweep) : Infinity : 0;
        let k = 0;
        vol.parts.forEach((part, i) => {
          const slices = stack === "z" ? part.zSlices : part.xSlices;
          let lastAt = -Infinity;
          slices.forEach((s, j) => {
            if (!kept[k++] || !drawn(s)) return;
            if (minShift > 0) {
              const essential = s.at === 0 && s.inset === 0 || j === 0 || j === slices.length - 1;
              if (!essential && s.at - lastAt < minShift) return;
              lastAt = s.at;
            }
            visit(s, stack === "z" ? planeMatrix(v, s.at, pivot) : sidePlaneMatrix(v, s.at, pivot), i, j);
          });
        });
      }
      function sliceCull(v) {
        const sweep = Math.hypot(v.sY, v.cY * v.sP);
        const inset = Math.min(Math.abs(v.cY), Math.abs(v.cP));
        return (s) => s.axis !== "z" || s.inset <= 0 || Math.abs(s.at) * sweep > s.inset * inset;
      }
      function eyeStates(p, pose) {
        const s = p.vol.eyeScale;
        const w = EYE_W * s, h = EYE_H * s;
        const r = p.range;
        const dx = pose.gazeX * (pose.gazeX >= 0 ? r.right : r.left) * GAZE_X * s;
        const dy = pose.gazeY * (pose.gazeY >= 0 ? r.down : r.up) * GAZE_Y * s;
        const centers = eyeCenters(p.def.eyes);
        const plain = plainLook(pose.eyes);
        return [
          0,
          1
        ].map((i) => {
          const squint = i === 0 ? pose.squintL : pose.squintR;
          const open = Math.max(h * Math.max(0.09, (1 - pose.blink) * (1 - squint * 0.4)), w * 0.55);
          return {
            x: centers[i][0],
            y: centers[i][1],
            w,
            h,
            dx,
            dy,
            open,
            shift: (h - open) * 0.18,
            look: pose.eyes,
            plain
          };
        });
      }
      function eyeSpot(e, gaze) {
        return {
          x: e.x + (gaze ? e.dx : 0),
          y: e.y + (gaze ? e.dy : 0),
          w: e.w,
          h: e.h,
          open: e.open,
          shift: e.shift
        };
      }
      function happyArc(e) {
        const ex = e.x + e.dx, ey = e.y + e.dy;
        const hw = e.w * HAPPY_ARC.halfWidth, base = ey + e.h * HAPPY_ARC.base;
        return `M${f(ex - hw)} ${f(base)}Q${f(ex)} ${f(ey - e.h * HAPPY_ARC.peak)} ${f(ex + hw)} ${f(base)}`;
      }
      function eyeMark(e) {
        if (e.plain === "arc") return {
          shape: "arc",
          d: happyArc(e),
          strokeWidth: e.w * HAPPY_ARC.stroke
        };
        if (e.plain === null) return {
          shape: "path",
          d: eyePath(e.look, eyeSpot(e, true))
        };
        const cx = e.x + e.dx, cy = e.y + e.dy + e.shift;
        return {
          shape: "pill",
          x: cx - e.w / 2,
          y: cy - e.open / 2,
          width: e.w,
          height: e.open,
          radius: Math.min(e.w, e.open) / 2
        };
      }
      const normalized = /* @__PURE__ */ new Map();
      function normalizedColor(input, fallback) {
        if (!input) return fallback;
        const hit = normalized.get(input);
        if (hit !== void 0) return hit;
        const rgb = parseHex(input);
        if (!rgb) return fallback;
        const hex = toHex(rgb);
        if (normalized.size >= 64) normalized.clear();
        normalized.set(input, hex);
        return hex;
      }
      function colors(options) {
        return {
          color: normalizedColor(options.color, DEFAULT_COLOR),
          ink: normalizedColor(options.eyeColor, DEFAULT_EYE_COLOR)
        };
      }
      const ribbonPoints = /* @__PURE__ */ new WeakMap();
      function ribbonPointsOf(shape) {
        return ribbonPoints.get(shape);
      }
      function avatarFrame(definition, options = {}) {
        return flatFrame(definition, options, void 0);
      }
      function liveTransform(definition, options = {}) {
        const p = prepare(definition, depthOption(options));
        const pose = poseOf(p, options);
        const { color, ink } = colors(options);
        const v = viewBasis(pose.yaw, pose.pitch);
        const root = rootMatrix(pose, p.vol.bounds);
        const hasOverlay = pose.ribbons > 0.01 || pose.marks.length > 0;
        const states = eyeStates(p, pose);
        const eyes = states.map((e) => ({
          mark: eyeMark({
            ...e,
            dx: 0,
            dy: 0
          }),
          dx: e.dx,
          dy: e.dy
        }));
        return {
          view: v,
          root,
          eyes,
          color,
          ink,
          hasOverlay,
          buildFrame: () => flatFrameFrom(p, pose, v, root, states, eyes, color, ink, options, options.size)
        };
      }
      function liveFrame(definition, options = {}) {
        return flatFrame(definition, options, options.size);
      }
      const RAMP_LIGHT = 0.09;
      const RAMP_HUE = 14;
      const RAMP_RANGE = [
        0.36,
        0.9
      ];
      const WARM = 100;
      const palettes = /* @__PURE__ */ new Map();
      const GRADIENT_LIGHT = 0.13;
      const GRADIENT_HUE = 25;
      const GRADIENT_STOPS = 5;
      const NEUTRAL = 0.04;
      const NEUTRAL_TINT = 0.025;
      const BAND_SHADES = [
        [
          0,
          1,
          2
        ],
        [
          2,
          0,
          3
        ],
        [
          1,
          2,
          0
        ]
      ];
      function turnToward(h, to, by) {
        const d = (to - h + 540) % 360 - 180;
        return (h + Math.sign(d) * Math.min(Math.abs(d), by) + 360) % 360;
      }
      function runAt(run, t) {
        const x = clamp2(t, 0, 1) * (run.length - 1), n = Math.min(Math.floor(x), run.length - 2);
        return toHex(mix(run[n], run[n + 1], x - n));
      }
      function ribbonPalette(color, seed) {
        const key = `${color}|${seed}`;
        let palette = palettes.get(key);
        if (palette) return palette;
        const [light, chroma, hue] = toOklch(parseHex(color) ?? parseHex(DEFAULT_COLOR));
        const neutral = chroma < NEUTRAL;
        const base = neutral ? (130 + noise(seed, 500) * 310) % 360 : hue;
        const c = neutral ? NEUTRAL_TINT : Math.max(chroma, 0.17);
        const from = Math.min(RAMP_RANGE[1], Math.max(RAMP_RANGE[0], light));
        const steps = [];
        for (let k = 1; steps.length < 5 && k < 10; k++) {
          for (const step of [
            k,
            -k
          ]) {
            const l = from + step * RAMP_LIGHT;
            if (steps.length < 5 && l >= RAMP_RANGE[0] - 1e-9 && l <= RAMP_RANGE[1] + 1e-9) steps.push(step);
          }
        }
        while (steps.length < 5) steps.push(steps[steps.length - 1] ?? 1);
        const shades = steps.map((step) => {
          const l = from + step * RAMP_LIGHT;
          const h = turnToward(base, step > 0 ? WARM : WARM + 180, RAMP_HUE * Math.abs(step));
          const away = step > 0 ? 1 : -1;
          const run = Array.from({
            length: GRADIENT_STOPS
          }, (_, n) => {
            const t = n / (GRADIENT_STOPS - 1);
            const hue2 = turnToward(h, away > 0 ? WARM : WARM + 180, GRADIENT_HUE * t);
            return oklch(clamp2(l + away * GRADIENT_LIGHT * t, 0.26, 0.9), c, hue2);
          });
          return {
            step,
            run
          };
        });
        palette = BAND_SHADES.flatMap((pick) => pick.map((n) => shades[n]).sort((x, y) => y.step - x.step).map(({ run }) => run));
        if (palettes.size >= 64) palettes.clear();
        palettes.set(key, palette);
        return palette;
      }
      function markId(shape) {
        return /^[A-Za-z][A-Za-z0-9]*$/.test(shape) ? shape : `m-${hashString(String(shape)).toString(36)}`;
      }
      function effectsOf(p, pose, options, needRibbonPath = true) {
        const b = p.vol.bounds;
        const time = Number.isFinite(options.time) ? options.time : 0;
        const still = options.reducedMotion === true;
        const [cx, cy] = pivotOf(b);
        return {
          body: bodyScale(pose.marks),
          ribbons: still || pose.ribbons <= 0.01 ? [] : ribbonPieces(b, pose.ribbons, p.seed, time, pose.sweep, pose.cage, ribbonsFollow(pose.cage >= 0.5 ? p.rims().cage : p.rims().work, pose, b), needRibbonPath).map((r) => {
            const hue = ribbonPalette(options.color, p.seed)[r.ribbon];
            const [s0, s1] = r.along;
            const stops = [
              s0,
              (s0 + s1) / 2,
              s1
            ].map((t) => runAt(hue, t));
            const long = Math.hypot(r.to[0] - r.from[0], r.to[1] - r.from[1]) > 0.01;
            return {
              d: r.d,
              points: r.points,
              box: r.box,
              front: r.front,
              fill: stops[1],
              gradient: long ? {
                x1: r.from[0],
                y1: r.from[1],
                x2: r.to[0],
                y2: r.to[1],
                stops
              } : {
                x1: r.from[0],
                y1: r.from[1],
                x2: r.from[0] + 0.01,
                y2: r.from[1],
                stops: [
                  stops[1],
                  stops[1],
                  stops[1]
                ]
              }
            };
          }),
          marks: markParts(b, pose.marks, p.seed, time, still).map((part) => {
            const turn = [
              Math.cos(part.turn),
              Math.sin(part.turn),
              -Math.sin(part.turn),
              Math.cos(part.turn),
              0,
              0
            ];
            return {
              id: `${p.id}-${markId(part.shape)}`,
              d: part.d,
              box: part.box,
              round: part.round === true,
              matrix: mul(about(cx, cy, turn), mul(translate(part.x, part.y), [
                part.scale,
                0,
                0,
                part.scale,
                0,
                0
              ]))
            };
          })
        };
      }
      function flatFrame(definition, options, size) {
        const p = prepare(definition, depthOption(options));
        const { color, ink } = colors(options);
        const pose = poseOf(p, options);
        const v = viewBasis(pose.yaw, pose.pitch);
        const root = rootMatrix(pose, p.vol.bounds);
        const states = eyeStates(p, pose);
        const eyes = states.map((e) => ({
          mark: eyeMark({
            ...e,
            dx: 0,
            dy: 0
          }),
          dx: e.dx,
          dy: e.dy
        }));
        return flatFrameFrom(p, pose, v, root, states, eyes, color, ink, options, size);
      }
      function flatFrameFrom(p, pose, v, root, states, eyes, color, ink, options, size) {
        const { vol } = p;
        const b = vol.bounds;
        const pivot = pivotOf(b);
        const stack = activeStack(v);
        const fx = effectsOf(p, pose, options, size === void 0);
        const shrinkMatrix = fx.body > 0 && fx.body < 1 ? about(pivot[0], pivot[1], [
          fx.body,
          0,
          0,
          fx.body,
          0,
          0
        ]) : null;
        const shrink = (m) => shrinkMatrix ? mul(shrinkMatrix, m) : m;
        const paths = /* @__PURE__ */ new Map();
        const items = [];
        if (fx.body > 0) {
          drawnSlices(p, v, size, (s, m, i, j) => {
            let path = paths.get(s.d);
            if (!path) {
              path = {
                id: p.ids.get(s.d),
                d: s.d,
                evenOdd: s.evenOdd,
                box: {
                  ...s.box
                }
              };
              paths.set(s.d, path);
            }
            const depth = stack === "z" ? v.facing * s.at : -v.sY * v.cP * s.at;
            items.push({
              depth,
              shape: {
                kind: "slice",
                key: `${i}${stack}${j}`,
                path: path.id,
                matrix: shrink(m)
              }
            });
          });
          states.forEach((e, idx) => {
            const plane = vol.eyePlanes[idx];
            if (!eyeVisible(v, plane)) return;
            const halfW = e.w * (e.plain === "pill" ? 0.5 : HAPPY_ARC.halfWidth + 0.5 * HAPPY_ARC.stroke);
            const xDepth = -v.sY * v.cP;
            const z = plane.z + e.dx * plane.dzdx + e.dy * plane.dzdy;
            const depth = stack === "z" ? v.facing * z + Math.abs(v.facing) * (Math.abs(plane.dzdx) * halfW + Math.abs(plane.dzdy) * e.h / 2) : xDepth * (e.x + e.dx) + Math.abs(xDepth) * halfW;
            items.push({
              depth: depth + 1e-6,
              shape: {
                kind: "eye",
                key: idx === 0 ? "eye-0" : "eye-1",
                matrix: shrink(eyeMatrix(v, plane, pivot)),
                mark: eyeMark(e)
              }
            });
          });
          items.sort((a, c) => a.depth - c.depth);
        }
        const fixed = fx.ribbons.length || fx.marks.length ? invert(root) : null;
        const shapes = new Array(items.length + fx.ribbons.length + fx.marks.length);
        let back = 0;
        for (const r of fx.ribbons) if (!r.front) back++;
        for (let i = 0; i < items.length; i++) shapes[back + i] = items[i].shape;
        let backAt = 0, frontAt = back + items.length;
        fx.ribbons.forEach((r, i) => {
          const shape = {
            kind: "ribbon",
            key: `ribbon-${i}`,
            d: r.d,
            box: r.box,
            matrix: fixed,
            front: r.front,
            fill: r.fill,
            gradient: r.gradient
          };
          ribbonPoints.set(shape, r.points);
          shapes[r.front ? frontAt++ : backAt++] = shape;
        });
        fx.marks.forEach((mark, i) => {
          const taken = paths.get(mark.id);
          const id = taken && taken.d !== mark.d ? `${mark.id}-${hashString(mark.d).toString(36)}` : mark.id;
          if (!paths.has(id)) paths.set(id, {
            id,
            d: mark.d,
            evenOdd: false,
            box: mark.box,
            ...mark.round ? {
              round: true
            } : {}
          });
          shapes[frontAt++] = {
            kind: "slice",
            key: `mark-${i}`,
            path: id,
            matrix: mul(fixed, mark.matrix)
          };
        });
        return {
          name: p.def.name,
          color,
          ink,
          paths: [
            ...paths.values()
          ],
          root,
          shapes,
          surface: {
            view: v,
            scale: fx.body,
            eyes: fx.body > 0 ? eyes : []
          }
        };
      }
      function eyeSvg(mark, ink) {
        if (mark.shape === "path") return `<path d="${mark.d}" fill="${ink}"/>`;
        if (mark.shape === "arc") {
          return `<path d="${mark.d}" fill="none" stroke="${ink}" stroke-width="${f(mark.strokeWidth)}" stroke-linecap="round"/>`;
        }
        return `<rect x="${f(mark.x)}" y="${f(mark.y)}" width="${f(mark.width)}" height="${f(mark.height)}" rx="${f(mark.radius)}" fill="${ink}"/>`;
      }
      function ribbonSvg(d, g) {
        const id = `oba-g${hashString(`${f(g.x1)},${f(g.y1)},${f(g.x2)},${f(g.y2)},${g.stops.join()}`).toString(36)}`;
        const stops = g.stops.map((c, i) => `<stop offset="${f(i / (g.stops.length - 1))}" stop-color="${c}"/>`).join("");
        return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(g.x1)}" y1="${f(g.y1)}" x2="${f(g.x2)}" y2="${f(g.y2)}">${stops}</linearGradient><path d="${d}" fill="url(#${id})"/>`;
      }
      function renderAvatarSvg(definition, options = {}) {
        const frame = avatarFrame(definition, options);
        const defsMarkup = frame.paths.map((d) => `<path id="${d.id}" d="${esc(d.d)}"${d.evenOdd ? ' fill-rule="evenodd"' : ""}/>`).join("");
        const body = frame.shapes.map((s) => s.kind === "slice" ? `<use href="#${s.path}" transform="${mat(s.matrix)}"/>` : s.kind === "eye" ? `<g transform="${mat(s.matrix)}">${eyeSvg(s.mark, frame.ink)}</g>` : `<g transform="${mat(s.matrix)}">${ribbonSvg(s.d, s.gradient)}</g>`).join("");
        const size = Number.isFinite(options.size) && options.size > 0 ? f(clamp2(options.size, 8, 4096)) : null;
        const dims = size ? ` width="${size}" height="${size}"` : "";
        const label = esc(frame.name);
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"${dims} role="img" aria-label="${label}" overflow="visible"><title>${label}</title><defs>${defsMarkup}</defs><g transform="${mat(frame.root)}" fill="${frame.color}">` + body + `</g></svg>`;
      }
      const u = (n) => `${f(n)}cqw`;
      const eyePlaneCss = ({ z, dzdx, dzdy }) => `translateZ(${u(z + CSS_EYE_LIFT)}) matrix3d(1,0,${r4(dzdx)},0,0,1,${r4(dzdy)},0,0,0,1,0,0,0,0,1)`;
      const FILL = "position:absolute;left:0;top:0;width:100%;height:100%;";
      function sliceMarkup(s) {
        const pad = 0.3;
        const x = s.box.x - pad, y = s.box.y - pad, w = s.box.w + 2 * pad, h = s.box.h + 2 * pad;
        const rule = s.evenOdd ? ' fill-rule="evenodd"' : "";
        const place = s.axis === "z" ? `left:${u(x)};top:${u(y)};transform:translateZ(${u(s.at)})` : `left:${u(s.at + x)};top:${u(y)};transform-origin:${u(-x)} 50%;transform:rotateY(90deg)`;
        return `<svg viewBox="${f(x)} ${f(y)} ${f(w)} ${f(h)}" style="position:absolute;width:${u(w)};height:${u(h)};overflow:visible;${place}" aria-hidden="true"><path d="${s.d}"${rule} fill="currentColor"/></svg>`;
      }
      const overlay = (side) => `<svg data-fx="${side}" viewBox="0 0 100 100" style="${FILL}overflow:visible;pointer-events:none" fill="currentColor" aria-hidden="true"></svg>`;
      function renderAvatarScene(definition, options = {}) {
        const p = prepare(definition, depthOption(options));
        const { vol } = p;
        const b = vol.bounds;
        const [cx, cy] = pivotOf(b);
        const ink = `var(--avatar-ink,${DEFAULT_EYE_COLOR})`;
        const stack = (axis) => `<div data-stack="${axis}" style="${FILL}transform-style:preserve-3d">` + vol.parts.map((part) => (axis === "z" ? part.zSlices : part.xSlices).map(sliceMarkup).join("")).join("") + `</div>`;
        const eyes = eyeStates(p, poseOf(p, {
          reducedMotion: true
        })).map((e, i) => {
          const box = `left:${u(e.x - e.w / 2)};top:${u(e.y - e.h / 2)};width:${u(e.w)};height:${u(e.h)}`;
          return `<div data-eye="${i}" style="position:absolute;${box};backface-visibility:hidden;transform:${eyePlaneCss(vol.eyePlanes[i])}"><i style="position:absolute;top:0;right:0;bottom:0;left:0;border-radius:999px;background:${ink}"></i><svg viewBox="${f(e.x - e.w / 2)} ${f(e.y - e.h / 2)} ${f(e.w)} ${f(e.h)}" style="${FILL}overflow:visible;display:none" aria-hidden="true"><path d="${happyArc(e)}" fill="none" stroke="${ink}" stroke-width="${f(e.w * HAPPY_ARC.stroke)}" stroke-linecap="round"/></svg><svg data-morph viewBox="${f(e.x - e.w / 2)} ${f(e.y - e.h / 2)} ${f(e.w)} ${f(e.h)}" style="${FILL}overflow:visible;display:none" aria-hidden="true"><path fill="${ink}"/></svg></div>`;
        });
        return `<div data-avatar-scene="${p.id}" style="position:relative;width:100%;height:100%;container-type:size">` + overlay("back") + `<div data-motion style="${FILL}will-change:transform;transform-origin:${u((b.minX + b.maxX) / 2)} ${u(b.maxY)}"><div data-view style="${FILL}transform-style:preserve-3d;transform-origin:${u(cx)} ${u(cy)}">` + stack("z") + stack("x") + eyes.join("") + `</div></div>` + overlay("front") + `</div>`;
      }
      const r4 = (n) => Math.round(n * 1e4) / 1e4;
      const SLICE_GAP_PX = 0.75;
      function sliceDetail(p, stack, size) {
        const px = Number.isFinite(size) && size > 0 ? Math.round(size) : 0;
        const key = `${stack}${px}`;
        let keep = p.detail.get(key);
        if (keep) return keep;
        const gap = px ? SLICE_GAP_PX * 100 / px : 0;
        keep = p.vol.parts.flatMap((part) => {
          const slices = stack === "z" ? part.zSlices : part.xSlices;
          let last = -Infinity;
          return slices.map((s, j) => {
            const core2 = s.axis === "z" && s.at === 0 && s.inset === 0;
            const kept = core2 || j === 0 || j === slices.length - 1 || s.at - last >= gap;
            if (kept) last = s.at;
            return kept;
          });
        });
        if (p.detail.size >= 32) p.detail.clear();
        p.detail.set(key, keep);
        return keep;
      }
      function sceneFrame(definition, options = {}) {
        const p = prepare(definition, depthOption(options));
        const pose = poseOf(p, options);
        const v = viewBasis(pose.yaw, pose.pitch);
        const states = eyeStates(p, pose);
        const stack = activeStack(v);
        const drawn = sliceCull(v);
        const kept = sliceDetail(p, stack, options.size);
        const fx = effectsOf(p, pose, options);
        const piece = (front) => fx.ribbons.filter((r) => r.front === front).map((r) => ribbonSvg(r.d, r.gradient)).join("");
        let k = 0;
        return {
          scene: p.id,
          motion: `translate(0,${u(pose.lift)}) rotate(${f(pose.roll)}deg) scale(${r4(pose.sx)},${r4(pose.sy)})`,
          view: (fx.body < 1 ? `scale(${r4(fx.body)}) ` : "") + `rotateX(${r4(pose.pitch)}rad) rotateY(${r4(pose.yaw)}rad)`,
          body: fx.body,
          back: piece(false),
          front: piece(true) + fx.marks.map((mark) => `<path d="${esc(mark.d)}" transform="${mat(mark.matrix)}"/>`).join(""),
          stack,
          slices: p.vol.parts.flatMap((part) => (stack === "z" ? part.zSlices : part.xSlices).map((s) => kept[k++] && drawn(s))),
          eyes: states.map((e, i) => ({
            visible: eyeVisible(v, p.vol.eyePlanes[i]),
            happy: e.plain === "arc",
            transform: `${eyePlaneCss(p.vol.eyePlanes[i])} translate(${u(e.dx)},${u(e.dy)})`,
            pill: `translateY(${u(e.shift)}) scaleY(${r4(e.open / e.h)})`,
            d: e.plain === null ? eyePath(e.look, eyeSpot(e, false)) : ""
          }))
        };
      }
      exports.DEFAULT_COLOR = DEFAULT_COLOR;
      exports.DEFAULT_EYE_COLOR = DEFAULT_EYE_COLOR;
      exports.DEFAULT_DEPTH = DEFAULT_DEPTH;
      exports.ribbonRims = ribbonRims;
      exports.ribbonsFollow = ribbonsFollow;
      exports.preparedVolume = preparedVolume;
      exports.viewBasis = viewBasis;
      exports.facingOf = facingOf;
      exports.activeStack = activeStack;
      exports.planeMatrix = planeMatrix;
      exports.sidePlaneMatrix = sidePlaneMatrix;
      exports.projectPoint = projectPoint;
      exports.avatarExtent = avatarExtent;
      exports.ribbonPointsOf = ribbonPointsOf;
      exports.avatarFrame = avatarFrame;
      exports.liveTransform = liveTransform;
      exports.liveFrame = liveFrame;
      exports.renderAvatarSvg = renderAvatarSvg;
      exports.renderAvatarScene = renderAvatarScene;
      exports.sceneFrame = sceneFrame;
    },
    "validate.ts": function(__req2, exports) {
      const { bounds, edgeBands, filledArea, flattenPath, parsePath, PathError, serializePath, splitSubpaths } = __req2("path.ts");
      const EYE_W = 4;
      const EYE_H = 11;
      const BODY_MIN = 6;
      const BODY_MAX = 94;
      const EYE_MARGIN = 1.2;
      const GAZE_X = 1.5;
      const GAZE_Y = 1.1;
      const HAPPY_ARC = {
        halfWidth: 0.72,
        base: 0.1,
        peak: 0.42,
        stroke: 0.6
      };
      const EYE_CLEARANCE = 1.5;
      const TOP_KEYS = [
        "version",
        "id",
        "name",
        "body",
        "eyes"
      ];
      const EYE_KEYS = [
        "x",
        "y",
        "spacing",
        "scale"
      ];
      const RECESS_MAX_AREA = 110;
      function isRecord(v) {
        return typeof v === "object" && v !== null && !Array.isArray(v);
      }
      function num(v) {
        return typeof v === "number" && Number.isFinite(v);
      }
      function eyeOutline(cx, cy, scale, margin) {
        const hw = EYE_W * scale / 2 + margin;
        const hh = EYE_H * scale / 2 + margin;
        const pts = [];
        const straight = hh - hw;
        for (let k = 0; k < 16; k++) {
          const a = k / 16 * Math.PI * 2;
          const x = Math.cos(a) * hw;
          const y = Math.sin(a) * hw + Math.sign(Math.sin(a)) * Math.max(0, straight);
          pts.push([
            cx + x,
            cy + y
          ]);
        }
        for (const f of [
          -0.5,
          0,
          0.5
        ]) {
          pts.push([
            cx - hw,
            cy + f * straight
          ], [
            cx + hw,
            cy + f * straight
          ]);
        }
        pts.push([
          cx,
          cy
        ]);
        return pts;
      }
      function drawnEyeOutline(cx, cy, scale, margin) {
        const pts = eyeOutline(cx, cy, scale, margin);
        const w = EYE_W * scale, h = EYE_H * scale;
        const x0 = cx - HAPPY_ARC.halfWidth * w, x1 = cx + HAPPY_ARC.halfWidth * w;
        const yb = cy + HAPPY_ARC.base * h, yc = cy - HAPPY_ARC.peak * h;
        const r = HAPPY_ARC.stroke * w / 2 + margin;
        for (let i = 0; i <= 8; i++) {
          const t = i / 8, m = 1 - t;
          const x = m * m * x0 + 2 * m * t * cx + t * t * x1;
          const y = (m * m + t * t) * yb + 2 * m * t * yc;
          for (let k = 0; k < 8; k++) {
            const a = k / 8 * Math.PI * 2;
            pts.push([
              x + Math.cos(a) * r,
              y + Math.sin(a) * r
            ]);
          }
        }
        return pts;
      }
      function eyeCenters(eyes) {
        return [
          [
            eyes.x - eyes.spacing / 2,
            eyes.y
          ],
          [
            eyes.x + eyes.spacing / 2,
            eyes.y
          ]
        ];
      }
      function eyesFit(polys, eyes, dx, dy, margin) {
        const index = edgeBands(polys);
        for (const [cx, cy] of eyeCenters(eyes)) {
          for (const [x, y] of eyeOutline(cx + dx, cy + dy, eyes.scale, margin)) {
            if (index.winding(x, y) === 0) return [
              x,
              y
            ];
          }
        }
        return null;
      }
      function drawnEyesFit(polys, eyes, dx, dy, margin) {
        const index = edgeBands(polys);
        for (const [cx, cy] of eyeCenters(eyes)) {
          for (const [x, y] of drawnEyeOutline(cx + dx, cy + dy, eyes.scale, margin)) {
            if (index.winding(x, y) === 0) return [
              x,
              y
            ];
          }
        }
        return null;
      }
      function eyeClearance(polys, eyes) {
        if (drawnEyesFit(polys, eyes, 0, 0, 0)) return 0;
        let lo = 0, hi = 20;
        while (hi - lo > 0.05) {
          const mid = (lo + hi) / 2;
          if (drawnEyesFit(polys, eyes, 0, 0, mid)) hi = mid;
          else lo = mid;
        }
        return Math.floor(lo * 10) / 10;
      }
      function gazeRange(polys, eyes) {
        const reach = (ux, uy) => {
          for (const k of [
            1,
            0.8,
            0.6,
            0.4,
            0.2
          ]) {
            if (!drawnEyesFit(polys, eyes, ux * k * GAZE_X * eyes.scale, uy * k * GAZE_Y * eyes.scale, EYE_CLEARANCE)) return k;
          }
          return 0;
        };
        return {
          left: reach(-1, 0),
          right: reach(1, 0),
          up: reach(0, -1),
          down: reach(0, 1)
        };
      }
      function analyzeBody(path, bounded = true) {
        const segs = parsePath(path, bounded);
        const polys = flattenPath(segs);
        const b = bounds(polys);
        const whole = edgeBands(polys);
        const holes = [];
        const subpaths = [];
        for (const sub of splitSubpaths(segs)) {
          const own = flattenPath(sub);
          if (!own.length) continue;
          const ob = bounds(own);
          let inside = 0, cut = 0;
          let probe = null, cutProbe = null;
          const step = (ob.maxX - ob.minX) * (ob.maxY - ob.minY) < 900 ? 0.5 : 1;
          const alone = own.length === polys.length;
          const xs = [];
          for (let x = Math.floor(ob.minX) + step / 2; x < ob.maxX; x += step) xs.push(x);
          const mine = new Uint8Array(xs.length), all = new Uint8Array(xs.length);
          const self = edgeBands(own);
          for (let y = Math.floor(ob.minY) + step / 2; y < ob.maxY; y += step) {
            self.insideRow(y, xs, mine);
            if (!alone) whole.insideRow(y, xs, all);
            for (let k = 0; k < xs.length; k++) {
              if (!mine[k]) continue;
              inside++;
              probe ?? (probe = [
                xs[k],
                y
              ]);
              if (!alone && !all[k]) {
                cut++;
                cutProbe ?? (cutProbe = [
                  xs[k],
                  y
                ]);
              }
            }
          }
          cut *= step * step * 4;
          inside *= step * step * 4;
          const d = serializePath(sub);
          const hole = inside > 0 && cut / inside > 0.6;
          if (hole) holes.push({
            d,
            area: Math.round(cut / 4)
          });
          subpaths.push({
            d,
            polys: own,
            hole,
            probe: hole ? cutProbe : probe
          });
        }
        return {
          polys,
          bounds: b,
          area: filledArea(polys, b),
          holes,
          subpaths
        };
      }
      const r1 = (n) => Math.round(n * 10) / 10;
      function validateAvatar(input) {
        const errors = [];
        if (!isRecord(input)) return {
          ok: false,
          errors: [
            "definition must be a JSON object"
          ]
        };
        for (const k of Object.keys(input)) if (!TOP_KEYS.includes(k)) errors.push(`unknown field "${k}" (allowed: ${TOP_KEYS.join(", ")})`);
        if (input.version !== 1) errors.push("version must be 1");
        const id = input.id;
        if (typeof id !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(id)) {
          errors.push("id must be a lowercase slug of 1-40 chars [a-z0-9-]");
        }
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (!name || name.length > 40 || /[\u0000-\u001f<>]/.test(name)) {
          errors.push("name must be 1-40 printable characters without < or >");
        }
        let path = null;
        if (!isRecord(input.body)) errors.push('body must be an object { "path": "..." }');
        else {
          for (const k of Object.keys(input.body)) if (k !== "path") errors.push(`unknown field "body.${k}" (only "path" is allowed)`);
          if (typeof input.body.path !== "string") errors.push("body.path must be a string");
          else path = input.body.path;
        }
        let eyes = null;
        if (!isRecord(input.eyes)) errors.push("eyes must be an object { x, y, spacing, scale }");
        else {
          const e = input.eyes;
          for (const k of Object.keys(e)) if (!EYE_KEYS.includes(k)) errors.push(`unknown field "eyes.${k}" (allowed: ${EYE_KEYS.join(", ")})`);
          const bad = EYE_KEYS.filter((k) => !num(e[k]));
          if (bad.length) errors.push(`eyes.${bad.join(", eyes.")} must be finite numbers`);
          else {
            eyes = {
              x: e.x,
              y: e.y,
              spacing: e.spacing,
              scale: e.scale
            };
            if (eyes.scale < 0.6 || eyes.scale > 1.8) errors.push(`eyes.scale ${eyes.scale} out of range 0.6..1.8`);
            const minSpacing = EYE_W * eyes.scale * 1.75;
            if (eyes.spacing < minSpacing || eyes.spacing > 40) {
              errors.push(`eyes.spacing ${eyes.spacing} out of range ${r1(minSpacing)}..40 for scale ${eyes.scale}`);
            }
          }
        }
        let normalized = "";
        let body = null;
        if (path !== null) {
          try {
            const segs = parsePath(path);
            normalized = serializePath(segs);
            body = analyzeBody(normalized);
          } catch (err) {
            if (err instanceof PathError) errors.push(`body.path: ${err.message}`);
            else throw err;
          }
        }
        if (body) {
          const b = body.bounds;
          const out = [];
          if (b.minX < BODY_MIN) out.push(`left edge x=${r1(b.minX)}`);
          if (b.minY < BODY_MIN) out.push(`top edge y=${r1(b.minY)}`);
          if (b.maxX > BODY_MAX) out.push(`right edge x=${r1(b.maxX)}`);
          if (b.maxY > BODY_MAX) out.push(`bottom edge y=${r1(b.maxY)}`);
          if (out.length) errors.push(`body.path leaves the safe area (${out.join(", ")}); keep geometry within 8..92`);
          const w = b.maxX - b.minX, h = b.maxY - b.minY;
          if (Math.max(w, h) < 40 || Math.min(w, h) < 14) {
            errors.push(`body is too small (${r1(w)}x${r1(h)}); use at least 40 units on the long side and 14 on the short side`);
          }
          if (body.area < 600) errors.push(`body fill area ${body.area} is too thin to carry eyes; must be at least 600 units²`);
          if (eyes) {
            const miss = eyesFit(body.polys, eyes, 0, 0, EYE_MARGIN);
            if (miss) {
              errors.push(`eyes must sit inside the body with ${EYE_MARGIN} units margin; point (${r1(miss[0])}, ${r1(miss[1])}) is outside or in a hole. Move eyes.x/y toward the widest solid area, reduce spacing or scale.`);
            }
          }
        }
        if (errors.length || !eyes) return {
          ok: false,
          errors
        };
        return {
          ok: true,
          value: {
            version: 1,
            id,
            name,
            body: {
              path: normalized
            },
            eyes: {
              ...eyes
            }
          }
        };
      }
      exports.EYE_W = EYE_W;
      exports.EYE_H = EYE_H;
      exports.BODY_MIN = BODY_MIN;
      exports.BODY_MAX = BODY_MAX;
      exports.GAZE_X = GAZE_X;
      exports.GAZE_Y = GAZE_Y;
      exports.HAPPY_ARC = HAPPY_ARC;
      exports.EYE_CLEARANCE = EYE_CLEARANCE;
      exports.RECESS_MAX_AREA = RECESS_MAX_AREA;
      exports.eyeCenters = eyeCenters;
      exports.eyesFit = eyesFit;
      exports.drawnEyesFit = drawnEyesFit;
      exports.eyeClearance = eyeClearance;
      exports.gazeRange = gazeRange;
      exports.analyzeBody = analyzeBody;
      exports.validateAvatar = validateAvatar;
    },
    "volume.ts": function(__req2, exports) {
      const { RUN, contourOutlines, loopsToPath, runRange, runsOf, simplifiedLoop } = __req2("contour.ts");
      const { EdgeIndex, segDist2 } = __req2("distance.ts");
      const { bounds, edgeBands, isInside } = __req2("path.ts");
      const { EYE_H, EYE_W, GAZE_X, GAZE_Y, analyzeBody, drawnEyesFit, eyeCenters, eyeClearance, gazeRange } = __req2("validate.ts");
      const MAX_PART_DEPTH = 30;
      const EYE_BOOST = 1.45;
      const EYE_BOOST_PAD = 3;
      const FACE_ROOM_TARGET = 4.5;
      const MAX_X_SLICES = 40;
      const THIN = 4;
      const THIN_REACH = 5;
      const THIN_MARGIN = 2;
      const FINE_Z = 0.6;
      function edgeDistance(polys, x, y) {
        let best = Infinity;
        for (const poly of polys) {
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const d2 = segDist2(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]);
            if (d2 < best) best = d2;
          }
        }
        return Math.sqrt(best);
      }
      function insideDistance(polys, x, y) {
        return isInside(polys, x, y) ? edgeDistance(polys, x, y) : 0;
      }
      function erosionAt(part, z) {
        const half = part.depth / 2;
        if (part.rz <= 0) return 0;
        const u = (Math.abs(z) - (half - part.rz)) / part.rz;
        if (u <= 0) return 0;
        return part.rxy * (1 - Math.sqrt(Math.max(0, 1 - Math.min(1, u) ** 2)));
      }
      function insetAt(part, level) {
        const half = part.depth / 2;
        if (part.rxy <= 0 || part.rz <= 0 || level <= half - part.rz) return 0;
        if (level >= half) return part.rxy;
        const s = (level - (half - part.rz)) / part.rz;
        return part.rxy * (1 - Math.sqrt(Math.max(0, 1 - s * s)));
      }
      function surfaceZ(part, dist) {
        const half = part.depth / 2;
        if (part.rxy <= 0 || dist >= part.rxy) return half;
        const k = 1 - Math.max(0, dist) / part.rxy;
        return half - part.rz + Math.sqrt(Math.max(0, 1 - k * k)) * part.rz;
      }
      function partDepth(thickness, b, volume) {
        const long = Math.max(b.maxX - b.minX, b.maxY - b.minY);
        const raw = 0.8 * Math.max(thickness, Math.min(0.4 * long, 2.4 * thickness));
        return Math.min(MAX_PART_DEPTH, Math.max(3, raw)) * volume;
      }
      function crossings(polys, rows, s) {
        const out = [];
        const a = rows ? 1 : 0, b = rows ? 0 : 1;
        for (const poly of polys) {
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const p = poly[j], q = poly[i];
            if (p[a] <= s && q[a] > s || q[a] <= s && p[a] > s) out.push(p[b] + (s - p[a]) * (q[b] - p[b]) / (q[a] - p[a]));
          }
        }
        return out.sort((m, n) => m - n);
      }
      function revolveProfile(polys, rows, lo, hi, center) {
        const step = 0.2;
        const n = Math.max(2, Math.ceil((hi - lo) / step) + 1);
        const r = new Float64Array(n);
        let span = 0;
        const mids = [];
        for (let k = 0; k < n; k++) {
          const s = Math.min(hi - 0.01, Math.max(lo + 0.01, lo + k * step));
          const xs = crossings(polys, rows, s);
          if (xs.length === 0) continue;
          if (xs.length !== 2) return null;
          r[k] = (xs[1] - xs[0]) / 2;
          span = Math.max(span, xs[1] - xs[0]);
          mids.push((xs[0] + xs[1]) / 2);
        }
        const tol = Math.max(0.8, 0.04 * span);
        if (!mids.length || mids.some((m) => Math.abs(m - center) > tol)) return null;
        return {
          start: lo,
          step,
          r
        };
      }
      function radiusAt(p, s) {
        const t = (s - p.start) / p.step;
        if (t < 0 || t > p.r.length - 1) return 0;
        const k = Math.min(p.r.length - 2, Math.floor(t));
        return p.r[k] + (p.r[k + 1] - p.r[k]) * (t - k);
      }
      function surfaceHeight(s, x, y, sd) {
        if (s.kind === "inflate") return surfaceZ(s.fillet, sd);
        const p = s.profile;
        return s.kind === "revolve-x" ? s.v * Math.sqrt(Math.max(0, radiusAt(p, x) ** 2 - (y - s.axis) ** 2)) : s.v * Math.sqrt(Math.max(0, radiusAt(p, y) ** 2 - (x - s.axis) ** 2));
      }
      function revolveAxis(body) {
        const b = body.bounds;
        const outlines = body.subpaths.filter((s) => !s.hole);
        if (outlines.length < 2 || b.maxX - b.minX < 1.1 * (b.maxY - b.minY)) return null;
        const axis = (b.minY + b.maxY) / 2;
        for (const o of outlines) {
          const ob = bounds(o.polys);
          if (Math.abs((ob.minY + ob.maxY) / 2 - axis) > 1.5) return null;
        }
        let filled = 0, off = 0;
        const xs = [];
        for (let x = b.minX + 0.5; x < b.maxX; x += 1) xs.push(x);
        const top = new Uint8Array(xs.length), bottom = new Uint8Array(xs.length);
        const index = edgeBands(body.polys);
        for (let y = b.minY + 0.5; y < axis; y += 1) {
          index.insideRow(y, xs, top);
          index.insideRow(2 * axis - y, xs, bottom);
          for (let k = 0; k < xs.length; k++) {
            if (top[k] || bottom[k]) filled++;
            if (top[k] !== bottom[k]) off++;
          }
        }
        return filled > 0 && off / filled < 0.02 ? axis : null;
      }
      function sampleGrid(polys, b, step, index) {
        const pad = 1;
        const x0 = b.minX - pad, y0 = b.minY - pad;
        const nx = Math.ceil((b.maxX - b.minX + 2 * pad) / step) + 1;
        const ny = Math.ceil((b.maxY - b.minY + 2 * pad) / step) + 1;
        const sd = index.distances({
          x0,
          y0,
          step,
          nx,
          ny
        }), inside = new Uint8Array(nx * ny);
        const xs = Array.from({
          length: nx
        }, (_, i) => x0 + i * step);
        const row = new Uint8Array(nx);
        const rows = edgeBands(polys);
        for (let j = 0; j < ny; j++) {
          rows.insideRow(y0 + j * step, xs, row);
          inside.set(row, j * nx);
          for (let i = 0; i < nx; i++) if (!row[i]) sd[j * nx + i] = -sd[j * nx + i];
        }
        return {
          x0,
          y0,
          step,
          nx,
          ny,
          sd,
          h: new Float64Array(nx * ny),
          inside
        };
      }
      function gridThickness(polys, b, step, index) {
        const pad = 1;
        const nx = Math.ceil((b.maxX - b.minX + 2 * pad) / step) + 1;
        const ny = Math.ceil((b.maxY - b.minY + 2 * pad) / step) + 1;
        return 2 * index.widest({
          x0: b.minX - pad,
          y0: b.minY - pad,
          step,
          nx,
          ny
        }, edgeBands(polys));
      }
      function sampleHeights(g, surface) {
        for (let j = 0; j < g.ny; j++) {
          const y = g.y0 + j * g.step;
          for (let i = 0; i < g.nx; i++) {
            const k = j * g.nx + i;
            if (g.inside[k]) g.h[k] = surfaceHeight(surface, g.x0 + i * g.step, y, g.sd[k]);
          }
        }
      }
      function loopBox(loops) {
        const b = bounds(loops);
        return {
          x: b.minX,
          y: b.minY,
          w: b.maxX - b.minX,
          h: b.maxY - b.minY
        };
      }
      function insetCuts(g, fillet) {
        const whole = {
          values: g.sd,
          nx: g.nx,
          ny: g.ny,
          x0: g.x0,
          y0: g.y0,
          step: g.step
        };
        const range = runRange(g.sd, g.nx, g.ny);
        const flat = new Uint8Array(range.min.length);
        return (level, box) => {
          const drop = insetAt(fillet, level);
          if (!box) {
            for (let k = 0; k < flat.length; k++) flat[k] = range.min[k] - drop >= 0 || range.max[k] - drop < 0 ? 1 : 0;
            return contourOutlines(whole, drop, 0.04, flat);
          }
          const i0 = Math.max(0, box.i0 - 1), i1 = Math.min(g.nx - 1, box.i1 + 1);
          const j0 = Math.max(0, box.j0 - 1), j1 = Math.min(g.ny - 1, box.j1 + 1);
          const nx = i1 - i0 + 1, ny = j1 - j0 + 1;
          const values = new Float64Array(nx * ny);
          for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
              const sd = g.sd[(j + j0) * g.nx + i + i0];
              const v = Math.min(sd - drop, sd);
              values[j * nx + i] = Math.min(v, g.step * Math.min(i + i0 - box.i0, box.i1 - i - i0, j + j0 - box.j0, box.j1 - j - j0));
            }
          }
          return contourOutlines({
            values,
            nx,
            ny,
            x0: g.x0 + i0 * g.step,
            y0: g.y0 + j0 * g.step,
            step: g.step
          }, 0, 0.04);
        };
      }
      function revolveCuts(g, surface) {
        const { nx, ny } = g;
        const { v, axis } = surface, p = surface.profile, alongX = surface.kind === "revolve-x";
        const base = new Float64Array(nx * ny), over = new Float64Array(nx * ny);
        for (let j = 0; j < ny; j++) {
          const y = g.y0 + j * g.step;
          for (let i = 0; i < nx; i++) {
            const x = g.x0 + i * g.step;
            const r = radiusAt(p, alongX ? x : y), t = alongX ? y - axis : x - axis;
            base[j * nx + i] = r * r - t * t;
            over[j * nx + i] = 2 * Math.max(r, 0.5);
          }
        }
        const values = new Float64Array(nx * ny);
        const field = {
          values,
          nx,
          ny,
          x0: g.x0,
          y0: g.y0,
          step: g.step
        };
        const rise = runRange(base, nx, ny), edge = runRange(g.sd, nx, ny);
        const runs = runsOf(nx);
        const flat = new Uint8Array(rise.min.length);
        return (level) => {
          const drop = (level / Math.max(v, 1e-6)) ** 2;
          for (let k = 0; k < flat.length; k++) {
            const out = rise.max[k] - drop < 0 || edge.max[k] < 0, within = rise.min[k] - drop >= 0 && edge.min[k] >= 0;
            flat[k] = out || within ? 1 : 0;
            if (flat[k]) continue;
            const r = k % runs, j = (k - r) / runs;
            for (let q = j * nx + r * RUN, end = j * nx + Math.min(nx - 1, (r + 1) * RUN); q <= end; q++) {
              values[q] = Math.min((base[q] - drop) / over[q], g.sd[q]);
              values[q + nx] = Math.min((base[q + nx] - drop) / over[q + nx], g.sd[q + nx]);
            }
          }
          return contourOutlines(field, 0, 0.04, flat);
        };
      }
      function thinBoxes(g) {
        const { nx, ny } = g;
        const reach = Math.ceil(THIN_REACH / g.step);
        const wide = new Uint8Array(nx * ny), near = new Uint8Array(nx * ny);
        const count = new Int32Array(Math.max(nx, ny) + 1);
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) count[i + 1] = count[i] + (g.sd[j * nx + i] >= THIN ? 1 : 0);
          for (let i = 0; i < nx; i++) wide[j * nx + i] = count[Math.min(nx, i + reach + 1)] > count[Math.max(0, i - reach)] ? 1 : 0;
        }
        for (let i = 0; i < nx; i++) {
          for (let j = 0; j < ny; j++) count[j + 1] = count[j] + wide[j * nx + i];
          for (let j = 0; j < ny; j++) near[j * nx + i] = count[Math.min(ny, j + reach + 1)] > count[Math.max(0, j - reach)] ? 1 : 0;
        }
        const thin = (k) => g.sd[k] > 0 && !near[k];
        const seen = new Uint8Array(nx * ny);
        const grow = Math.ceil(THIN_MARGIN / g.step);
        const boxes = [];
        for (let start = 0; start < nx * ny; start++) {
          if (seen[start] || !thin(start)) continue;
          const box = {
            i0: nx,
            i1: -1,
            j0: ny,
            j1: -1,
            top: 0
          };
          let cells = 0;
          const stack = [
            start
          ];
          seen[start] = 1;
          while (stack.length) {
            const k = stack.pop();
            const i = k % nx, j = (k - i) / nx;
            cells++;
            box.top = Math.max(box.top, g.h[k]);
            box.i0 = Math.min(box.i0, i);
            box.i1 = Math.max(box.i1, i);
            box.j0 = Math.min(box.j0, j);
            box.j1 = Math.max(box.j1, j);
            for (const n of [
              i > 0 ? k - 1 : -1,
              i < nx - 1 ? k + 1 : -1,
              j > 0 ? k - nx : -1,
              j < ny - 1 ? k + nx : -1
            ]) {
              if (n >= 0 && !seen[n] && thin(n)) {
                seen[n] = 1;
                stack.push(n);
              }
            }
          }
          if (cells * g.step * g.step < 2) continue;
          boxes.push({
            i0: Math.max(0, box.i0 - grow),
            i1: Math.min(nx - 1, box.i1 + grow),
            j0: Math.max(0, box.j0 - grow),
            j1: Math.min(ny - 1, box.j1 + grow),
            top: box.top
          });
        }
        for (let a = 0; a < boxes.length; a++) {
          for (let b = a + 1; b < boxes.length; b++) {
            const p = boxes[a], q = boxes[b];
            if (p.i0 > q.i1 || q.i0 > p.i1 || p.j0 > q.j1 || q.j0 > p.j1) continue;
            boxes[a] = {
              i0: Math.min(p.i0, q.i0),
              i1: Math.max(p.i1, q.i1),
              j0: Math.min(p.j0, q.j0),
              j1: Math.max(p.j1, q.j1),
              top: Math.max(p.top, q.top)
            };
            boxes.splice(b, 1);
            b = a;
          }
        }
        return boxes;
      }
      function columnLoops(g, c0, c1, surface) {
        const loops = [];
        const sd = new Float64Array(g.ny).fill(-Infinity), h = new Float64Array(g.ny);
        for (let j2 = 0; j2 < g.ny; j2++) {
          for (let c = c0; c <= c1; c++) {
            const k = j2 * g.nx + c;
            if (g.sd[k] > sd[j2]) sd[j2] = g.sd[k];
            if (g.sd[k] > 0 && g.h[k] > h[j2]) h[j2] = g.h[k];
          }
        }
        const xy = new Float64Array(4 * (g.ny + 2));
        let j = 0;
        while (j < g.ny) {
          if (sd[j] <= 0) {
            j++;
            continue;
          }
          const j0 = j;
          while (j < g.ny && sd[j] > 0) j++;
          const j1 = j - 1;
          let n = 0;
          if (j0 > 0) n = rimPoint(g, c0, c1, surface, sd, h, j0, j0 - 1, xy, n);
          else {
            xy[n++] = h[j0];
            xy[n++] = g.y0 + j0 * g.step;
          }
          for (let k = j0; k <= j1; k++) {
            xy[n++] = h[k];
            xy[n++] = g.y0 + k * g.step;
          }
          if (j1 < g.ny - 1) n = rimPoint(g, c0, c1, surface, sd, h, j1, j1 + 1, xy, n);
          else {
            xy[n++] = h[j1];
            xy[n++] = g.y0 + j1 * g.step;
          }
          let top = -Infinity;
          for (let k = 0; k < n; k += 2) top = Math.max(top, xy[k]);
          if (top < 0.05) continue;
          for (let k = n - 2, m = n; k >= 0; k -= 2) {
            xy[m++] = -xy[k];
            xy[m++] = xy[k + 1];
          }
          loops.push(simplifiedLoop(xy, n, 0.04));
        }
        return loops;
      }
      function rimPoint(g, c0, c1, surface, sd, h, inside, outside, xy, n) {
        const yIn = g.y0 + inside * g.step;
        const y = yIn + (g.y0 + outside * g.step - yIn) * sd[inside] / (sd[inside] - sd[outside]);
        let top = 0;
        for (let c = c0; c <= c1; c++) top = Math.max(top, surfaceHeight(surface, g.x0 + c * g.step, y, 0));
        xy[n] = Math.min(h[inside], top);
        xy[n + 1] = y;
        return n + 2;
      }
      function levels(flat, round, steps) {
        const out = [];
        for (let k = 1; k < steps; k++) out.push(flat + round * Math.sin(k / steps * (Math.PI / 2)));
        return out;
      }
      function buildVolume(def, volume = 1, body = analyzeBody(def.body.path)) {
        const outlines = body.subpaths.filter((s) => !s.hole);
        const holes = body.subpaths.filter((s) => s.hole);
        const v = Number.isFinite(volume) ? Math.max(0, volume) : 1;
        const xAxis = revolveAxis(body);
        const parts = outlines.map((o) => {
          const cuts = holes.filter((h) => h.probe && isInside(o.polys, h.probe[0], h.probe[1]));
          const polys = [
            ...o.polys,
            ...cuts.flatMap((h) => h.polys)
          ];
          const b = bounds(o.polys);
          const center = [
            (b.minX + b.maxX) / 2,
            (b.minY + b.maxY) / 2
          ];
          const minDim = Math.min(b.maxX - b.minX, b.maxY - b.minY);
          const step = Math.max(0.25, Math.min(0.45, minDim / 24));
          let kind = "inflate";
          let profile = null;
          if (xAxis !== null) {
            profile = revolveProfile(polys, false, b.minX, b.maxX, xAxis);
            if (profile) kind = "revolve-x";
          } else if (outlines.length > 1 && cuts.length === 0) {
            profile = revolveProfile(polys, true, b.minY, b.maxY, center[0]);
            if (profile) kind = "revolve-y";
          }
          const index = new EdgeIndex(polys, b);
          let thickness, depth, rxy = 0, rz = 0, axis = 0;
          if (kind === "inflate" || !profile) {
            thickness = gridThickness(polys, b, Math.max(step, 0.6), index);
            depth = partDepth(thickness, b, v);
            rxy = Math.min(thickness / 2, depth / 2) * 0.9;
            rz = depth / 2 * 0.85;
          } else {
            axis = kind === "revolve-x" ? xAxis : center[0];
            const radius = Math.max(...profile.r);
            thickness = 2 * radius;
            depth = 2 * radius * v;
          }
          const surface = {
            kind,
            fillet: {
              depth,
              rxy,
              rz
            },
            profile,
            axis,
            v
          };
          const filled = edgeBands(polys);
          const height = (x, y) => filled.winding(x, y) !== 0 ? surfaceHeight(surface, x, y, kind === "inflate" ? index.distance(x, y) : 0) : 0;
          const core2 = {
            axis: "z",
            at: 0,
            d: o.d + cuts.map((h) => h.d).join(""),
            loops: polys,
            evenOdd: false,
            box: {
              x: b.minX,
              y: b.minY,
              w: b.maxX - b.minX,
              h: b.maxY - b.minY
            },
            inset: 0
          };
          const zSlices = [
            core2
          ];
          const xSlices = [];
          const half = depth / 2;
          if (half > 0.05) {
            const g = sampleGrid(polys, b, step, index);
            sampleHeights(g, surface);
            const steps = kind === "inflate" ? Math.max(4, Math.min(14, Math.round(rz / 0.8))) : Math.max(5, Math.min(18, Math.round(half / 1.1)));
            const ls = kind === "inflate" ? [
              half - rz,
              ...levels(half - rz, rz, steps)
            ] : levels(0, half, steps);
            const cut = kind === "inflate" ? insetCuts(g, surface.fillet) : revolveCuts(g, surface);
            const addLevel = (level, box) => {
              const loops = cut(level, box);
              if (!loops.length) return false;
              let inset = Infinity, k = 0;
              for (const loop of loops) for (const p of loop) if (k++ % 3 === 0) inset = Math.min(inset, index.distance(p[0], p[1]));
              const slice = {
                axis: "z",
                d: loopsToPath(loops),
                loops,
                evenOdd: true,
                box: loopBox(loops),
                inset
              };
              zSlices.push({
                ...slice,
                at: level
              }, {
                ...slice,
                at: -level
              });
              return true;
            };
            const used = [
              0
            ];
            for (const level of ls) if (level >= 0.02 && addLevel(level)) used.push(level);
            const thin = kind === "inflate" ? thinBoxes(g) : [];
            for (const box of thin) {
              for (let k = 1; k < used.length && used[k - 1] < box.top; k++) {
                const a = used[k - 1], gap = used[k] - a, m = Math.ceil(gap / FINE_Z - 1e-9);
                for (let q = 1; q < m && a + gap * q / m < box.top; q++) addLevel(a + gap * q / m, box);
              }
            }
            zSlices.sort((m, n) => m.at - n.at);
            const width = b.maxX - b.minX;
            const every = Math.max(1, Math.round(Math.max(1.1, width / MAX_X_SLICES) / g.step));
            const before = Math.floor((every - 1) / 2);
            for (let i = 1; i < g.nx - 1; i += every) {
              const loops = columnLoops(g, Math.max(0, i - before), Math.min(g.nx - 1, i - before + every - 1), surface);
              if (loops.length) xSlices.push({
                axis: "x",
                at: g.x0 + i * g.step,
                d: loopsToPath(loops),
                loops,
                evenOdd: true,
                box: loopBox(loops),
                inset: 0
              });
            }
          }
          return {
            kind,
            d: core2.d,
            polys,
            bounds: b,
            center,
            thickness,
            depth,
            rxy,
            rz,
            axis: kind === "revolve-x" ? xAxis : kind === "revolve-y" ? center[0] : void 0,
            zSlices,
            xSlices,
            height
          };
        });
        const eyeScale = boostedEyeScale(body, def.eyes);
        const centers = eyeCenters(def.eyes);
        let eyePart = 0, bestZ = -Infinity;
        parts.forEach((part, i) => {
          const zs = centers.map(([x, y]) => part.height(x, y));
          if (zs.some((z2) => z2 <= 0)) return;
          const z = Math.min(...zs);
          if (z > bestZ) {
            bestZ = z;
            eyePart = i;
          }
        });
        const host = parts[eyePart];
        const w = EYE_W * eyeScale / 2 + GAZE_X * eyeScale, hh = EYE_H * eyeScale / 2 + GAZE_Y * eyeScale;
        const eyeZ = centers.map(([x, y]) => {
          let top = 0;
          for (const fx of [
            -1,
            -0.5,
            0,
            0.5,
            1
          ]) for (const fy of [
            -1,
            -0.5,
            0,
            0.5,
            1
          ]) top = Math.max(top, host ? host.height(x + fx * w, y + fy * hh) : 0);
          return top;
        });
        const eyePlanes = centers.map(([x, y]) => {
          if (!host) return {
            x,
            y,
            z: 0,
            dzdx: 0,
            dzdy: 0
          };
          const e = 0.75;
          const dzdx = (host.height(x + e, y) - host.height(x - e, y)) / (2 * e);
          const dzdy = (host.height(x, y + e) - host.height(x, y - e)) / (2 * e);
          return {
            x,
            y,
            z: host.height(x, y),
            dzdx,
            dzdy
          };
        });
        return {
          parts,
          bounds: body.bounds,
          eyePart,
          eyeZ,
          eyeScale,
          eyePlanes
        };
      }
      function boostedEyeScale(body, eyes) {
        for (const k of [
          EYE_BOOST,
          1.38,
          1.3,
          1.22,
          1.15,
          1.08
        ]) {
          if (!drawnEyesFit(body.polys, {
            ...eyes,
            scale: eyes.scale * k
          }, 0, 0, EYE_BOOST_PAD)) return eyes.scale * k;
        }
        return eyes.scale;
      }
      function faceRoom(def, body = analyzeBody(def.body.path)) {
        const scale = boostedEyeScale(body, def.eyes);
        const eyes = {
          ...def.eyes,
          scale
        };
        const clearance = eyeClearance(body.polys, eyes);
        const gaze = gazeRange(body.polys, eyes);
        const boost = Math.round(scale / def.eyes.scale * 100) / 100;
        const ok = boost >= EYE_BOOST - 1e-9 && clearance >= FACE_ROOM_TARGET && Math.min(gaze.left, gaze.right, gaze.up, gaze.down) === 1;
        return {
          boost,
          clearance,
          gaze,
          ok
        };
      }
      exports.MAX_PART_DEPTH = MAX_PART_DEPTH;
      exports.EYE_BOOST = EYE_BOOST;
      exports.EYE_BOOST_PAD = EYE_BOOST_PAD;
      exports.FACE_ROOM_TARGET = FACE_ROOM_TARGET;
      exports.edgeDistance = edgeDistance;
      exports.insideDistance = insideDistance;
      exports.erosionAt = erosionAt;
      exports.insetAt = insetAt;
      exports.surfaceZ = surfaceZ;
      exports.partDepth = partDepth;
      exports.revolveAxis = revolveAxis;
      exports.buildVolume = buildVolume;
      exports.boostedEyeScale = boostedEyeScale;
      exports.faceRoom = faceRoom;
    }
  };
  var __cache = /* @__PURE__ */ Object.create(null);
  function __req(id) {
    if (__cache[id]) return __cache[id].exports;
    var factory = __modules[id];
    if (!factory) throw new Error("open-bot-avatar: missing bundled module " + id);
    var mod = __cache[id] = { exports: {} };
    factory(__req, mod.exports);
    return mod.exports;
  }
  var __gallery = [{ "version": 1, "id": "book", "name": "Book", "body": { "path": "M12 32C12 29 14 27 17 26C30 21.5 42 23 50 31C58 23 70 21.5 83 26C86 27 88 29 88 32V64H89C90.7 64 92 65.3 92 67V75C92 77 90.5 78 88.5 77.5C76 75 60 76 50 84C40 76 24 75 11.5 77.5C9.5 78 8 77 8 75V67C8 65.3 9.3 64 11 64H12Z" }, "eyes": { "x": 50, "y": 51, "spacing": 18, "scale": 1.1 } }, { "version": 1, "id": "brain", "name": "Brain", "body": { "path": "M14 50C10 42 14 32 22 30C24 21 34 17 41 21C46 15 56 15 61 20C68 16 78 20 79 28C87 30 91 39 88 47C92 54 89 64 81 66C80 71 76 74 71 73C67 75 64 74 62 72C61 74 61 76 61.5 78C62 81 59 82.5 57 81.5C55.5 80.5 55 78 54 76C53 74 50 72.5 47 72.5C42 74 38 72 36 70C30 73 20 71 18 64C12 62 10 56 14 50Z" }, "eyes": { "x": 50, "y": 45, "spacing": 17, "scale": 1.15 } }, { "version": 1, "id": "bull", "name": "Bull", "body": { "path": "M40 28L60 28C70 28 76 36 76 48L76 62C76 74 66 84 50 84C34 84 24 74 24 62L24 48C24 36 30 28 40 28ZM32 40C22 38 15 32 15 24C15 18 18 13 22 10C25 8 28 10 27 13C25 18 24 22 28 26C31 29 36 30 42 30ZM58 30C64 30 69 29 72 26C76 22 75 18 73 13C72 10 75 8 78 10C82 13 85 18 85 24C85 32 78 38 68 40ZM29 55C23 56 17 55 12 52C9 50 8 47 10 45C14 41 22 40 28 42ZM72 42C78 40 86 41 90 45C92 47 91 50 88 52C83 55 77 56 71 55Z" }, "eyes": { "x": 50, "y": 52, "spacing": 17, "scale": 1.15 } }, { "version": 1, "id": "bunny", "name": "Bunny", "body": { "path": "M50 40C68 40 80 50 80 64C80 78 68 86 50 86C32 86 20 78 20 64C20 50 32 40 50 40ZM30 46C26 36 24 24 26 16C28 10 34 10 37 15C40 22 42 34 42 44ZM58 44C58 34 61 22 66 15C69 10 76 11 76 17C76 25 74 36 70 46Z" }, "eyes": { "x": 50, "y": 62, "spacing": 17, "scale": 1.15 } }, { "version": 1, "id": "camera", "name": "Camera", "body": { "path": "M17 34H20V31C20 29 21 28 23 28H27C29 28 30 29 30 31V34H36L40 23C41 21 42 20 44 20H56C58 20 59 21 60 23L64 34H83C87.5 34 91 37.5 91 42V72C91 76.5 87.5 80 83 80H17C12.5 80 9 76.5 9 72V42C9 37.5 12.5 34 17 34Z" }, "eyes": { "x": 50, "y": 54, "spacing": 17, "scale": 1.1 } }, { "version": 1, "id": "cat", "name": "Cat", "body": { "path": "M50 23C68 23 82 30 82 45C82 58 68 65 50 65C32 65 18 58 18 45C18 30 32 23 50 23ZM24 42C21 32 20 22 22 15C23 11 26 10 29 12C34 16 39 21 44 28L36 42ZM64 42L56 28C61 21 66 16 71 12C74 10 77 11 78 15C80 22 79 32 76 42ZM38 56L62 56C70 56 74 66 74 76C74 83 70 86 63 86L37 86C30 86 26 83 26 76C26 66 30 56 38 56ZM70 72C77 74 81 70 80 64C79 60 81 57 84 58C87 59 88.5 63 88 68C87 77 80 83 70 81Z" }, "eyes": { "x": 50, "y": 43, "spacing": 17, "scale": 1.1 } }, { "version": 1, "id": "cloud", "name": "Cloud", "body": { "path": "M24 76C14 76 9 69 9 61C9 52 15 46 23 45.5C25 33 36 24 49 24C61 24 70 31 73 41C83 41 91 49 91 59C91 69 83 76 74 76Z" }, "eyes": { "x": 50, "y": 54, "spacing": 17, "scale": 1.15 } }, { "version": 1, "id": "egg", "name": "Egg", "body": { "path": "M50 10C66 10 82 34 82 58C82 76 68 88 50 88C32 88 18 76 18 58C18 34 34 10 50 10Z" }, "eyes": { "x": 50, "y": 54, "spacing": 17, "scale": 1.2 } }, { "version": 1, "id": "ghost", "name": "Ghost", "body": { "path": "M24 50C24 28 35 12 50 12C65 12 76 28 76 50L77 80C77 85 73 88 68 88C63 88 61 84 59 81C57 84 54 88 50 88C46 88 43 84 41 81C39 84 37 88 32 88C27 88 23 85 23 80Z" }, "eyes": { "x": 50, "y": 42, "spacing": 16, "scale": 1.15 } }, { "version": 1, "id": "magnifier", "name": "Magnifier", "body": { "path": "M41 12A29 29 0 0 1 64.44 58.08L68.50 62.13A8 8 0 0 1 75.65 64.33L87.67 76.36A8 8 0 0 1 76.36 87.67L64.33 75.65A8 8 0 0 1 62.13 68.50L58.08 64.44A29 29 0 1 1 41 12Z" }, "eyes": { "x": 41, "y": 40, "spacing": 17, "scale": 1.15 } }, { "version": 1, "id": "paint-brush", "name": "Paint Brush", "body": { "path": "M77.2 8.5C80.3 8.7 82.3 10.2 83.4 13.1C84 14.5 83.3 16.2 82.3 17.6L65.9 40.8L56.2 33.7L73.2 11C74.2 9.6 75.6 8.5 77.2 8.5ZM55.4 26.8L72.8 39.4C74.2 40.4 74.5 42.2 73.5 43.6L66.6 53C65.6 54.4 63.8 54.7 62.4 53.7L45.1 41C43.7 40 43.4 38.2 44.4 36.8L51.2 27.4C52.2 26 54 25.8 55.4 26.8ZM48.4 38.7L63.7 49.8C67.9 57.1 66.8 65.9 61.8 72.9C54.7 82.6 41.2 86.6 25.2 85.1C22.2 85 20 82.9 21 79.9C24.6 71.4 21.1 57.1 28.2 47.4C33.3 40.4 40.8 37.4 48.4 38.7Z" }, "eyes": { "x": 44, "y": 59, "spacing": 16, "scale": 1.05 } }, { "version": 1, "id": "palette", "name": "Palette", "body": { "path": "M46 18C70 16 90 28 90 48C90 68 74 84 52 84C42 84 36 80 34 74C32 68 36 64 32 60C28 56 22 62 16 58C10 54 10 46 12 40C16 26 30 19 46 18ZM20 42A6.5 8 0 1 0 33 42A6.5 8 0 1 0 20 42Z" }, "eyes": { "x": 58, "y": 46, "spacing": 17, "scale": 1.15 } }, { "version": 1, "id": "rocket", "name": "Rocket", "body": { "path": "M46 10C48 8.5 52 8.5 54 10C64 17 71 29 71 44V69C71 74 68 77 63 77H37C32 77 29 74 29 69V44C29 29 36 17 46 10ZM65 50L70.5 52C79 57 87 68 87 81C87 85.5 84 88 80.5 86.5L65 76ZM35 76L19.5 86.5C16 88 13 85.5 13 81C13 68 21 57 29.5 52L35 50ZM41 74H59C60 82 56 88 50 91C44 88 40 82 41 74Z" }, "eyes": { "x": 50, "y": 46, "spacing": 15, "scale": 1.05 } }, { "version": 1, "id": "shield", "name": "Shield", "body": { "path": "M50 14C60 18 72 18 82 16Q86 16 86 20L86 46C86 64 72 78 54 86.5Q50 88.5 46 86.5C28 78 14 64 14 46L14 20Q14 16 18 16C28 18 40 18 50 14Z" }, "eyes": { "x": 50, "y": 42, "spacing": 17, "scale": 1.15 } }, { "version": 1, "id": "star", "name": "Star", "body": { "path": "M53.7 17.95L62 31.2Q64.1 34.6 68 35.6L83.1 39.3Q89.9 41 85.4 46.4L75.4 58.3Q72.8 61.4 73.1 65.4L74.2 81Q74.7 88 68.2 85.4L53.7 79.5Q50 78 46.3 79.5L31.8 85.4Q25.3 88 25.8 81L26.9 65.4Q27.2 61.4 24.6 58.3L14.6 46.4Q10.1 41 16.9 39.3L32 35.6Q35.9 34.6 38 31.2L46.3 17.95Q50 12 53.7 17.95Z" }, "eyes": { "x": 50, "y": 52, "spacing": 16, "scale": 1.1 } }, { "version": 1, "id": "witch-hat", "name": "Witch Hat", "body": { "path": "M50 72C72 72 92 75 92 80C92 85 72 87 50 87C28 87 8 85 8 80C8 75 28 72 50 72ZM50 14.73C60.78 18.98 67.14 27.15 69.44 38L77.5 76Q78 80 74 80L26 80Q22 80 22.5 76L30.56 38C32.86 27.15 39.22 18.98 50 14.73ZM41.58 19.5C44.5 17.2 47.97 15.34 52 14C62 10.5 72 9 81 11A3.2 3.2 0 0 1 81 17.4C75.5 18.2 67.96 31 69.44 38L64 30L56 22L48 20Z" }, "eyes": { "x": 50, "y": 54, "spacing": 15, "scale": 1.05 } }];
  var __colors = { "controller": "#ff6a1a", "barbell": "#f2384b", "mug": "#f4f4f4", "lightbulb": "#f8a01c", "chat": "#8b5cf6", "sprout": "#1fbf68", "watering-can": "#14b3a5", "book": "#a8693f", "brain": "#ec4899", "bull": "#f2384b", "bunny": "#ec4899", "camera": "#7a7a7a", "cat": "#f8a01c", "cloud": "#14b3a5", "egg": "#f4f4f4", "ghost": "#f4f4f4", "magnifier": "#1f7cf2", "paint-brush": "#1fbf68", "palette": "#a8693f", "rocket": "#7a7a7a", "shield": "#1f7cf2", "star": "#ff6a1a", "witch-hat": "#8b5cf6" };
  var __upstream = { "name": "open-bot-avatar", "version": "0.5.2", "license": "MIT", "author": "Dominik Scholz", "repository": "https://github.com/DominikScholz/open-bot-avatar.git", "commit": "e10afe49d46da8ffcc6545f5d6e8ba1de4ea8c5d" };
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function clamp01(v) {
    return typeof v === "number" && Number.isFinite(v) ? clamp(v, 0, 1) : 0;
  }
  function clampSigned(v) {
    return typeof v === "number" && Number.isFinite(v) ? clamp(v, -1, 1) : 0;
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function perfNow() {
    return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
  }
  const VALID_UPSTREAM_STATES = /* @__PURE__ */ new Set(["idle", "thinking", "working", "waiting", "blocked", "done"]);
  const EXPRESSIONS = [
    { id: "idle", label: "Idle" },
    { id: "happy", label: "Happy" },
    { id: "thinking", label: "Thinking" },
    { id: "working", label: "Working" },
    { id: "waiting", label: "Waiting" },
    { id: "blocked", label: "Blocked" },
    { id: "done", label: "Done" },
    { id: "listening", label: "Listening" },
    { id: "speaking", label: "Speaking" },
    { id: "muted", label: "Muted" },
    { id: "curious", label: "Curious" },
    { id: "shy", label: "Shy" }
  ];
  const EXPRESSION_DURATION_MS = {
    idle: 3200,
    done: 4300,
    working: 4400,
    thinking: 3600,
    blocked: 3400,
    happy: 3400,
    waiting: 3600,
    listening: 3200,
    speaking: 3600,
    muted: 3200,
    curious: 3200,
    shy: 3200
  };
  function parseTone(rawMood) {
    const m = typeof rawMood === "string" ? rawMood.trim().toLowerCase() : "";
    if (!m || m === "neutral" || m === "default" || m === "normal") {
      return { baseMood: "neutral", tone: "neutral" };
    }
    if (m === "excited" || m === "delighted" || m === "ecstatic" || m === "energetic") {
      return { baseMood: "happy", tone: "excited" };
    }
    if (m === "happy" || m === "joy" || m === "cheerful" || m === "playful" || m === "warm" || m === "love" || m === "smile") {
      return { baseMood: "happy", tone: "happy" };
    }
    if (m === "calm" || m === "gentle" || m === "relaxed" || m === "sleepy" || m === "tired" || m === "bored") {
      return { baseMood: "neutral", tone: "calm" };
    }
    if (m === "curious" || m === "surprised" || m === "amazed" || m === "interested" || m === "attentive") {
      return { baseMood: "neutral", tone: "curious" };
    }
    if (m === "focused" || m === "serious" || m === "determined" || m === "working" || m === "concentrated") {
      return { baseMood: "neutral", tone: "focused" };
    }
    if (m === "shy" || m === "bashful" || m === "embarrassed") {
      return { baseMood: "neutral", tone: "shy" };
    }
    if (m === "sad" || m === "sorry" || m === "apologetic" || m === "worried" || m === "anxious") {
      return { baseMood: "neutral", tone: "sad" };
    }
    if (m === "angry" || m === "frustrated" || m === "annoyed" || m === "stern") {
      return { baseMood: "neutral", tone: "angry" };
    }
    return { baseMood: "neutral", tone: "neutral" };
  }
  function applyToneOverlay(pose, tone, ctx, strength) {
    if (!tone || tone === "neutral" || strength <= 0) return pose;
    const k = clamp01(strength);
    const live = ctx.live;
    switch (tone) {
      case "excited":
        pose.sy += 0.025 * k;
        pose.sx -= 0.015 * k;
        pose.lift -= 0.7 * k * live;
        pose.eyes = { arc: Math.max(pose.eyes.arc, 0.9 * k), slit: pose.eyes.slit * (1 - k) };
        break;
      case "happy":
        pose.eyes = { arc: Math.max(pose.eyes.arc, 0.85 * k), slit: pose.eyes.slit * (1 - k) };
        break;
      case "calm":
        pose.eyes = { arc: pose.eyes.arc, slit: Math.max(pose.eyes.slit, 0.42 * k * (1 - pose.eyes.arc)) };
        pose.roll += 1.5 * k;
        break;
      case "curious":
        pose.roll += 7.5 * k;
        pose.pitch += 0.06 * k;
        pose.sy += 0.02 * k;
        pose.squintL *= 1 - 0.6 * k;
        pose.squintR *= 1 - 0.6 * k;
        break;
      case "focused":
        pose.pitch -= 0.05 * k;
        pose.squintL = Math.max(pose.squintL, 0.24 * k);
        pose.squintR = Math.max(pose.squintR, 0.24 * k);
        break;
      case "shy":
        pose.roll -= 6.5 * k;
        pose.pitch -= 0.08 * k;
        pose.yaw -= 0.14 * k;
        pose.gazeX = clamp(pose.gazeX - 0.35 * k, -1, 1);
        pose.gazeY = clamp(pose.gazeY + 0.28 * k, -1, 1);
        pose.eyes = { arc: Math.max(pose.eyes.arc, 0.35 * k), slit: Math.max(pose.eyes.slit, 0.3 * k) };
        break;
      case "sad":
        pose.pitch -= 0.09 * k;
        pose.roll -= 4.5 * k;
        pose.sy -= 0.025 * k;
        pose.sx += 0.02 * k;
        pose.squintL = Math.max(pose.squintL, 0.22 * k);
        pose.squintR = Math.max(pose.squintR, 0.22 * k);
        pose.eyes = { arc: pose.eyes.arc * (1 - k), slit: Math.max(pose.eyes.slit, 0.35 * k) };
        break;
      case "angry":
        pose.pitch -= 0.08 * k;
        pose.squintL = Math.max(pose.squintL, 0.46 * k);
        pose.squintR = Math.max(pose.squintR, 0.36 * k);
        pose.sy -= 0.015 * k;
        pose.sx += 0.02 * k;
        break;
      default:
        break;
    }
    return pose;
  }
  function createOpenBotAvatarEngine(deps) {
    const { core: core2, colorMod: colorMod2, dom: dom2, fluffy: fluffy2, glass: glass2, gallery, colors, thumbBase = "avatars/open/thumbs" } = deps;
    const { examples, stateDefinition, DEFAULT_COLOR, DEFAULT_EYE_COLOR } = core2;
    const { parseHex, luminance, autoEyeColor, toHex } = colorMod2;
    const { mountAvatar } = dom2;
    const allDefinitions = [...examples, ...gallery];
    const byId = /* @__PURE__ */ new Map();
    for (const def of allDefinitions) {
      byId.set(def.id, def);
    }
    const materialMap = {
      fluffy: fluffy2,
      glass: glass2,
      flat: "flat"
    };
    function resolveVariant(variantId) {
      const raw = typeof variantId === "string" ? variantId.trim().toLowerCase() : "";
      let avatarId = raw;
      let materialName = "fluffy";
      const colon = raw.indexOf(":");
      if (colon !== -1) {
        avatarId = raw.slice(0, colon);
        const suffix = raw.slice(colon + 1);
        if (suffix === "fluffy" || suffix === "glass" || suffix === "flat") {
          materialName = suffix;
        }
      }
      const definition = byId.get(avatarId) || allDefinitions[0];
      const defaultColor = colors && colors[definition.id] || DEFAULT_COLOR;
      return {
        id: `${definition.id}${materialName === "fluffy" ? "" : ":" + materialName}`,
        definition,
        materialName,
        material: materialMap[materialName] || fluffy2,
        defaultColor
      };
    }
    const variants = [];
    for (const def of allDefinitions) {
      variants.push({
        id: def.id,
        label: def.name,
        thumb: "avatars/open/fluffy.webp",
        tile: deps.atlasKeys.findIndex((key) => key.slice(0, key.lastIndexOf("-")) === def.id),
        side: Math.ceil(Math.sqrt(deps.atlasKeys.length))
      });
    }
    for (const id of byId.keys()) {
      const def = byId.get(id);
      if (!def) continue;
      variants.push({
        id: `${id}:glass`,
        label: `${def.name} · Glass`,
        thumb: `${thumbBase}/${id}-glass.svg`
      });
    }
    for (const id of byId.keys()) {
      const def = byId.get(id);
      if (!def) continue;
      variants.push({
        id: `${id}:flat`,
        label: `${def.name} · Flat`,
        thumb: `${thumbBase}/${id}.svg`
      });
    }
    function resolveEyeColor(bodyColor) {
      const rgb = parseHex(bodyColor);
      if (!rgb) return DEFAULT_EYE_COLOR;
      return luminance(rgb) < 0.08 ? toHex(autoEyeColor(rgb)) : DEFAULT_EYE_COLOR;
    }
    function mount(host, variantId) {
      if (!host || typeof host.appendChild !== "function") {
        throw new Error("open-bot-avatar: mount(host) requires a valid DOM element");
      }
      const resolved = resolveVariant(variantId);
      const stage = host.ownerDocument.createElement("div");
      stage.className = "oba-night-stage";
      stage.style.width = "100%";
      stage.style.height = "100%";
      stage.style.position = "relative";
      stage.style.display = "block";
      stage.style.pointerEvents = "none";
      stage.style.userSelect = "none";
      host.appendChild(stage);
      let destroyed = false;
      let exprSeq = 0;
      const live = {
        phase: "idle",
        explicitState: null,
        level: 0,
        localLevel: 0,
        remoteLevel: 0,
        smoothSpeak: 0,
        smoothListen: 0,
        cadence: 0,
        baseMood: "neutral",
        tone: "neutral",
        gazeX: 0,
        gazeY: 0,
        hasGaze: false,
        dragging: false,
        dragYaw: 0,
        dragPitch: 0,
        reduced: void 0,
        // undefined -> 'system', boolean -> explicit
        color: resolved.defaultColor,
        eyeColor: resolveEyeColor(resolved.defaultColor),
        lastFrameTime: null,
        // Temporary expression override triggered by express(id) (measured on perfNow() clock)
        exprId: null,
        exprUntil: 0,
        exprDef: null,
        // Touch / poke reaction (measured on perfNow() clock)
        touchUntil: 0,
        touchAt: 0,
        touchX: 0,
        touchY: 0,
        tapCombo: 0,
        lastTapAt: 0
      };
      let exprTimer = null;
      let touchTimer = null;
      let pokeRaf = 0;
      function isReducedNow() {
        if (typeof live.reduced === "boolean") return live.reduced;
        return dom2.prefersReducedMotion ? dom2.prefersReducedMotion() : false;
      }
      const idleTonedDef = {
        id: "oba:idle-toned",
        pose(ctx) {
          const base = stateDefinition("idle").pose(ctx);
          const pose = { ...ctx.base, ...base, eyes: { ...ctx.base.eyes, ...base.eyes || {} } };
          return applyToneOverlay(pose, live.tone, ctx, 1);
        }
      };
      const connectingDef = {
        id: "oba:connecting",
        pose(ctx) {
          const pose = ctx.rest(1.05);
          if (ctx.reducedMotion) {
            pose.roll = 4;
            pose.pitch += 0.03;
            return applyToneOverlay(pose, live.tone, ctx, 0.5);
          }
          pose.roll = 4.5 * ctx.wave(2.8);
          pose.yaw += 0.14 * ctx.sway * ctx.wave(3.4);
          pose.pitch += 0.04 + 0.03 * ctx.wave(2.2, 0.7);
          pose.lift = -0.8 * (0.5 + 0.5 * ctx.wave(1.9));
          pose.gazeX = 0.45 * ctx.wave(2.6);
          pose.gazeY = -0.15 + 0.12 * ctx.wave(1.8, 1.1);
          pose.ribbons = 0.38;
          pose.cage = 0;
          pose.sweep = ctx.t * 2.2;
          return applyToneOverlay(pose, live.tone, ctx, 0.5);
        }
      };
      const listeningDef = {
        id: "oba:listening",
        pose(ctx) {
          const pose = ctx.rest(1.1);
          const amp = live.exprId === "listening" ? ctx.reducedMotion ? 0 : 0.28 + 0.22 * (0.5 + 0.5 * ctx.wave(1.3)) : live.smoothListen;
          if (ctx.reducedMotion) {
            pose.roll = 5;
            pose.pitch += 0.05;
            pose.sy = 1.015;
            return applyToneOverlay(pose, live.tone, ctx, 0.7);
          }
          const nod = Math.sin(ctx.t * 7.5) * amp;
          pose.roll = 5.5 + 2.2 * ctx.wave(3.8) + 3.2 * amp * ctx.wave(1.7);
          pose.pitch += 0.06 + 0.09 * amp + 0.035 * nod;
          pose.yaw += 0.06 * ctx.sway * ctx.wave(4.6);
          pose.lift -= 1.3 * amp;
          pose.sy = 1 + 0.045 * amp;
          pose.sx = 1 - 0.025 * amp;
          pose.squintL = Math.max(pose.squintL, 0.08 + 0.12 * amp);
          pose.squintR = Math.max(pose.squintR, 0.08 + 0.12 * amp);
          if (amp > 0.45 && live.baseMood === "happy") {
            pose.eyes = { arc: Math.max(pose.eyes.arc, clamp01((amp - 0.35) * 1.1)), slit: 0 };
          }
          return applyToneOverlay(pose, live.tone, ctx, 0.75);
        }
      };
      const speakingDef = {
        id: "oba:speaking",
        pose(ctx) {
          const pose = ctx.rest(0.95);
          const isDemo = live.exprId === "speaking";
          const amp = isDemo ? ctx.reducedMotion ? 0.25 : 0.22 + 0.52 * (0.5 + 0.5 * Math.sin(ctx.t * 8.4)) * (0.55 + 0.45 * Math.sin(ctx.t * 2.7)) : live.smoothSpeak;
          const energyBoost = live.tone === "excited" ? 1.25 : live.tone === "calm" || live.tone === "sad" ? 0.72 : 1;
          const e = clamp01(amp * energyBoost);
          if (ctx.reducedMotion) {
            pose.pitch += 0.04;
            pose.sy = 1.02;
            pose.sx = 0.99;
            return applyToneOverlay(pose, live.tone, ctx, 0.85);
          }
          const syll = Math.sin(live.cadence + ctx.t * 11.5);
          const phrase = ctx.wave(2.1);
          const pulse = e * (0.65 + 0.35 * (0.5 + 0.5 * syll));
          pose.lift = -0.35 - 2.9 * pulse;
          pose.sy = 1 + 0.105 * pulse - 0.015 * e * Math.cos(ctx.t * 11.5);
          pose.sx = 1 - 0.06 * pulse + 0.012 * e * Math.cos(ctx.t * 11.5);
          pose.pitch += 0.04 + 0.11 * e * (0.4 + 0.6 * syll);
          pose.roll = 2.6 * phrase + 5.2 * e * ctx.wave(1.45, 0.5);
          pose.yaw += 0.09 * ctx.sway * ctx.wave(3.1) + 0.08 * e * ctx.wave(1.9, 1.2);
          if (e > 0.22) pose.blink *= clamp01(1 - e * 1.4);
          if (live.baseMood === "happy") {
            pose.eyes = { arc: clamp01(0.45 + 0.55 * e), slit: 0 };
          } else if (live.tone === "focused" || live.tone === "angry") {
            pose.squintL = Math.max(pose.squintL, 0.15 + 0.18 * e);
            pose.squintR = Math.max(pose.squintR, 0.15 + 0.18 * e);
          } else {
            pose.squintL = Math.max(pose.squintL, 0.14 * e);
            pose.squintR = Math.max(pose.squintR, 0.14 * e);
          }
          return applyToneOverlay(pose, live.tone, ctx, 0.85);
        }
      };
      const mutedDef = {
        id: "oba:muted",
        pose(ctx) {
          const pose = ctx.rest(1.6);
          pose.pitch -= 0.07;
          pose.roll = -4 + 0.8 * ctx.wave(6.8);
          pose.sy = 0.985 + 0.01 * ctx.wave(4.8);
          pose.sx = 1.01 - 6e-3 * ctx.wave(4.8);
          pose.gazeX *= 0.3;
          pose.gazeY = 0.25;
          pose.eyes = { arc: 0, slit: 0.86 };
          return pose;
        }
      };
      const curiousDef = {
        id: "oba:curious",
        pose(ctx) {
          const pose = ctx.rest(0.95);
          pose.roll = 10 + 1.8 * ctx.wave(3.4);
          pose.pitch += 0.07;
          pose.yaw += 0.12 * ctx.sway;
          pose.sy = 1.03;
          pose.sx = 0.985;
          pose.gazeX = 0.35 * ctx.wave(3.6);
          pose.gazeY = -0.2;
          return pose;
        }
      };
      const shyDef = {
        id: "oba:shy",
        pose(ctx) {
          const pose = ctx.rest(1.2);
          pose.roll = -8 + 1.2 * ctx.wave(4.4);
          pose.pitch -= 0.1;
          pose.yaw -= 0.18 * ctx.sway;
          pose.gazeX = -0.45;
          pose.gazeY = 0.32;
          pose.eyes = { arc: 0.45, slit: 0.25 };
          return pose;
        }
      };
      function makeFreshUpstreamExpr(upstreamName, startAge) {
        exprSeq += 1;
        const baseDef = stateDefinition(upstreamName);
        return {
          id: `oba:expr:${upstreamName}:${exprSeq}`,
          startAge,
          pose: (ctx) => baseDef.pose(ctx)
        };
      }
      function computeTouchView(now) {
        if (isReducedNow() || live.touchAt <= 0) return { yaw: 0, pitch: 0, active: false };
        const elapsed = (now - live.touchAt) / 1e3;
        if (elapsed < 0 || elapsed > 0.85) return { yaw: 0, pitch: 0, active: false };
        const decay = Math.exp(-elapsed * 5.2);
        const spring = Math.sin(elapsed * 16.5) * decay;
        const push = Math.exp(-elapsed * 8.5) * 0.28;
        const centerWeight = clamp01(1 - Math.hypot(live.touchX, live.touchY));
        const nod = centerWeight * (-0.16 * push + 0.09 * spring);
        const yaw = clamp(live.touchX * (push + 0.16 * spring), -0.55, 0.55);
        const pitch = clamp(-live.touchY * (push + 0.13 * spring) + nod, -0.42, 0.42);
        return { yaw, pitch, active: decay > 0.015 };
      }
      function resolveActiveLook(now) {
        if (live.exprId && now < live.exprUntil) {
          switch (live.exprId) {
            case "idle":
              return { state: "idle", mood: "neutral" };
            case "happy":
              return { state: "idle", mood: "happy" };
            case "thinking":
              return { state: "thinking", mood: "neutral" };
            case "working":
              return { state: live.exprDef || "working", mood: live.baseMood };
            case "waiting":
              return { state: "waiting", mood: "neutral" };
            case "blocked":
              return { state: "blocked", mood: "neutral" };
            case "done":
              return { state: live.exprDef || "done", mood: "happy" };
            case "listening":
              return { state: listeningDef, mood: live.baseMood };
            case "speaking":
              return { state: speakingDef, mood: live.baseMood };
            case "muted":
              return { state: mutedDef, mood: "neutral" };
            case "curious":
              return { state: curiousDef, mood: "neutral" };
            case "shy":
              return { state: shyDef, mood: "neutral" };
            default:
              break;
          }
        } else if (live.exprId && now >= live.exprUntil) {
          live.exprId = null;
          live.exprDef = null;
        }
        switch (live.phase) {
          case "connecting":
            return { state: connectingDef, mood: live.baseMood };
          case "listening":
            return { state: listeningDef, mood: live.baseMood };
          case "thinking":
            return { state: "thinking", mood: live.baseMood };
          case "speaking":
            return { state: speakingDef, mood: live.baseMood };
          case "muted":
            return { state: mutedDef, mood: "neutral" };
          case "error":
            return { state: "blocked", mood: "neutral" };
          case "idle":
          default: {
            if (live.explicitState && VALID_UPSTREAM_STATES.has(live.explicitState)) {
              return { state: live.explicitState, mood: live.baseMood };
            }
            if (live.tone === "neutral" || live.tone === "happy") {
              return { state: "idle", mood: live.baseMood };
            }
            return { state: idleTonedDef, mood: live.baseMood };
          }
        }
      }
      function resolveLookAt(now) {
        if (!live.dragging && now < live.touchUntil) {
          return { x: live.touchX, y: live.touchY };
        }
        if (live.hasGaze) {
          return { x: live.gazeX, y: live.gazeY };
        }
        return null;
      }
      let lastSig = "";
      let renderedId = "idle";
      const mounted = mountAvatar(stage, {
        definition: resolved.definition,
        color: live.color,
        eyeColor: live.eyeColor,
        material: resolved.material,
        state: "idle",
        mood: "neutral",
        followPointer: false,
        lookAt: null,
        view: { yaw: 0, pitch: 0 },
        reducedMotion: "system",
        label: resolved.definition.name
      });
      function syncMount(now, force) {
        if (destroyed) return;
        const look = resolveActiveLook(now);
        const lookAt = resolveLookAt(now);
        const touchView = computeTouchView(now);
        const reducedOpt = typeof live.reduced === "boolean" ? live.reduced : "system";
        const stateKey = typeof look.state === "string" ? look.state : look.state.id;
        const lookAtKey = lookAt ? `${lookAt.x.toFixed(3)},${lookAt.y.toFixed(3)}` : "null";
        const yaw = live.dragYaw + touchView.yaw, pitch = live.dragPitch + touchView.pitch;
        const viewKey = `${yaw.toFixed(4)},${pitch.toFixed(4)}`;
        const sig = `${stateKey}|${look.mood}|${live.color}|${live.eyeColor}|${lookAtKey}|${viewKey}|${reducedOpt}`;
        if (!force && sig === lastSig) return;
        lastSig = sig;
        const namedPose = stateKey.replace(/^oba:/, "");
        renderedId = live.exprId || (look.state === connectingDef ? "waiting" : look.state === idleTonedDef || stateKey === "idle" ? look.mood === "happy" ? "happy" : "idle" : namedPose);
        mounted.update({
          state: look.state,
          mood: look.mood,
          color: live.color,
          eyeColor: live.eyeColor,
          lookAt,
          view: { yaw, pitch },
          reducedMotion: reducedOpt
        });
      }
      function startPokeLoop() {
        if (pokeRaf || destroyed || isReducedNow()) return;
        if (typeof requestAnimationFrame !== "function") return;
        const step = () => {
          pokeRaf = 0;
          if (destroyed) return;
          const now = perfNow();
          const tv = computeTouchView(now);
          syncMount(now, false);
          if (tv.active) {
            pokeRaf = requestAnimationFrame(step);
          }
        };
        pokeRaf = requestAnimationFrame(step);
      }
      function stopPokeLoop() {
        if (pokeRaf && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(pokeRaf);
        }
        pokeRaf = 0;
      }
      function scheduleExprReset(delayMs) {
        if (exprTimer !== null) clearTimeout(exprTimer);
        exprTimer = setTimeout(() => {
          exprTimer = null;
          if (destroyed) return;
          const now = perfNow();
          if (live.exprId && now >= live.exprUntil - 10) {
            live.exprId = null;
            live.exprDef = null;
            syncMount(now, false);
          }
        }, Math.max(0, delayMs));
      }
      function scheduleTouchReset(delayMs) {
        if (touchTimer !== null) clearTimeout(touchTimer);
        touchTimer = setTimeout(() => {
          touchTimer = null;
          if (destroyed) return;
          syncMount(perfNow(), false);
        }, Math.max(0, delayMs));
      }
      return {
        update(frame) {
          if (destroyed || !frame || typeof frame !== "object") return;
          const now = perfNow();
          const frameClock = typeof frame.time === "number" && Number.isFinite(frame.time) ? frame.time : now;
          const dt = live.lastFrameTime === null ? 1 / 60 : clamp((frameClock - live.lastFrameTime) / 1e3, 1e-3, 0.2);
          live.lastFrameTime = frameClock;
          const nextPhase = typeof frame.phase === "string" && frame.phase.trim() ? frame.phase.trim().toLowerCase() : "idle";
          if (nextPhase !== live.phase && live.exprId && !live.voiceExpression && nextPhase !== "idle") {
            live.exprId = null;
            live.exprDef = null;
            if (exprTimer !== null) {
              clearTimeout(exprTimer);
              exprTimer = null;
            }
          }
          live.phase = nextPhase;
          if (typeof frame.state === "string" && VALID_UPSTREAM_STATES.has(frame.state.trim().toLowerCase())) {
            live.explicitState = frame.state.trim().toLowerCase();
          } else {
            live.explicitState = null;
          }
          live.level = clamp01(frame.level);
          live.localLevel = clamp01(frame.localLevel);
          live.remoteLevel = clamp01(frame.remoteLevel);
          const targetSpeak = live.remoteLevel > 0 ? live.remoteLevel : live.level;
          const targetListen = live.localLevel > 0 ? live.localLevel : live.level;
          const atk = 1 - Math.exp(-dt * 26);
          const rel = 1 - Math.exp(-dt * 11);
          live.smoothSpeak = lerp(live.smoothSpeak, targetSpeak, targetSpeak > live.smoothSpeak ? atk : rel);
          live.smoothListen = lerp(live.smoothListen, targetListen, targetListen > live.smoothListen ? atk : rel);
          live.cadence += dt * (2.5 + 9.5 * live.smoothSpeak);
          const parsedTone = parseTone(frame.mood);
          live.baseMood = parsedTone.baseMood;
          live.tone = parsedTone.tone;
          const gx = typeof frame.gazeX === "number" && Number.isFinite(frame.gazeX) ? clampSigned(frame.gazeX) : 0;
          const gy = typeof frame.gazeY === "number" && Number.isFinite(frame.gazeY) ? clampSigned(frame.gazeY) : 0;
          live.dragging = frame.pointerActive === true;
          if (live.dragging || Math.abs(gx) > 0.015 || Math.abs(gy) > 0.015) {
            live.gazeX = gx;
            live.gazeY = gy;
            live.hasGaze = true;
          } else {
            live.gazeX = 0;
            live.gazeY = 0;
            live.hasGaze = false;
          }
          if (typeof frame.reduced === "boolean") {
            live.reduced = frame.reduced;
            if (frame.reduced) stopPokeLoop();
          }
          const reduced = isReducedNow();
          const ease = 1 - Math.exp(-dt * (live.dragging ? 12 : 9));
          live.dragYaw = reduced ? 0 : lerp(live.dragYaw, live.dragging ? gx * 0.5 : 0, ease);
          live.dragPitch = reduced ? 0 : lerp(live.dragPitch, live.dragging ? -gy * 0.33 : 0, ease);
          const nextColor = typeof frame.color === "string" && frame.color.trim() ? frame.color.trim() : resolved.defaultColor;
          if (nextColor !== live.color) {
            live.color = nextColor;
            live.eyeColor = resolveEyeColor(nextColor);
          }
          syncMount(now, false);
        },
        touch(x, y) {
          if (destroyed) return;
          const now = perfNow();
          let nx = 0;
          let ny = 0;
          if (typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) {
            if (Math.abs(x) > 1 || Math.abs(y) > 1) {
              const w = host.clientWidth || stage.clientWidth || 100;
              const h = host.clientHeight || stage.clientHeight || 100;
              nx = clamp(x / w * 2 - 1, -1, 1);
              ny = clamp(y / h * 2 - 1, -1, 1);
            } else if (x >= 0 && y >= 0) {
              nx = clamp(x * 2 - 1, -1, 1);
              ny = clamp(y * 2 - 1, -1, 1);
            } else {
              nx = clamp(x, -1, 1);
              ny = clamp(y, -1, 1);
            }
          }
          live.touchX = nx;
          live.touchY = ny;
          live.touchAt = now;
          live.touchUntil = now + 1150;
          if (now - live.lastTapAt < 1400) {
            live.tapCombo += 1;
          } else {
            live.tapCombo = 1;
          }
          live.lastTapAt = now;
          if (live.tapCombo >= 3 && !isReducedNow() && live.phase === "idle") {
            live.tapCombo = 0;
            live.exprId = "happy";
            live.exprUntil = now + 2200;
            live.exprDef = null;
            scheduleExprReset(2250);
          }
          syncMount(now, true);
          startPokeLoop();
          scheduleTouchReset(1200);
        },
        currentExpression() {
          return renderedId;
        },
        endVoiceExpression() {
          if (live.voiceExpression) this.express("reset");
        },
        express(id, voice = false) {
          if (destroyed) return;
          const now = perfNow();
          const key = typeof id === "string" ? id.trim().toLowerCase() : "";
          live.voiceExpression = voice;
          if (!key || key === "reset" || key === "clear" || key === "idle" && !voice) {
            live.exprId = null;
            live.exprDef = null;
            if (exprTimer !== null) {
              clearTimeout(exprTimer);
              exprTimer = null;
            }
            syncMount(now, true);
            return;
          }
          const canonical = key === "error" ? "blocked" : key === "celebrate" ? "done" : key;
          if (!Object.prototype.hasOwnProperty.call(EXPRESSION_DURATION_MS, canonical)) {
            return;
          }
          const duration = EXPRESSION_DURATION_MS[canonical];
          live.exprId = canonical;
          live.exprUntil = now + duration;
          if (canonical === "done") {
            live.exprDef = makeFreshUpstreamExpr("done", 0);
          } else if (canonical === "working") {
            live.exprDef = makeFreshUpstreamExpr("working", 1.1);
          } else {
            live.exprDef = null;
          }
          syncMount(now, true);
          scheduleExprReset(duration + 40);
        },
        destroy() {
          if (destroyed) return;
          destroyed = true;
          stopPokeLoop();
          if (exprTimer !== null) {
            clearTimeout(exprTimer);
            exprTimer = null;
          }
          if (touchTimer !== null) {
            clearTimeout(touchTimer);
            touchTimer = null;
          }
          mounted.destroy();
          if (stage.parentNode === host) {
            host.removeChild(stage);
          }
        }
      };
    }
    return {
      id: "open",
      title: "open-bot-avatar",
      variants,
      expressions: EXPRESSIONS.map((e) => ({ id: e.id, label: e.label })),
      mount
    };
  }
  var core = __req("index.ts");
  var colorMod = __req("color.ts");
  var dom = __req("dom/index.ts");
  var fluffy = __req("dom/materials/fluffy.ts").fluffy;
  var glass = __req("dom/materials/glass.ts").glass;
  var engine = createOpenBotAvatarEngine({
    core,
    colorMod,
    dom,
    fluffy,
    glass,
    atlasKeys: ["barbell-1gchura", "book-a8n2ek", "brain-qc3r2u", "bull-1t2twau", "bunny-1wr35pa", "camera-1sry23t", "cat-1bjzgwy", "chat-1ni0gqx", "cloud-51p98k", "controller-o5vcn6", "egg-1tdbxmq", "ghost-567g17", "lightbulb-xxw68r", "magnifier-f31q0p", "mug-14tmkrh", "paint-brush-1urwl4o", "palette-pvqbd4", "rocket-qcd5oq", "shield-lx5g4b", "sprout-yspst5", "star-1hsmtxa", "watering-can-1e687xp", "witch-hat-axefpm"],
    gallery: __gallery,
    colors: __colors,
    upstream: __upstream,
    thumbBase: "avatars/open/thumbs"
  });
  if (global && global.NightAvatars && typeof global.NightAvatars.register === "function") {
    global.NightAvatars.register(engine);
  }
})(typeof window !== "undefined" ? window : globalThis);
