/* ================================================================
   AllToPack — dieline_parser.js   (v9 — DCEL + TemplateMapper por tipo FEFCO)

   Pipeline:
     SVG (Format B) + Type
      ↓ parseColoredLines   — extrai segmentos por cor de <line>/<path>
      ↓ buildGraph          — snap adaptativo de vértices + T-junctions
      ↓ buildHalfEdges      — construção DCEL
      ↓ findFaces           — extracção de faces planas
      ↓ filterFaces         — remove face exterior + slivers + fantasmas
      ↓ assignKeys          — panel_0…panel_N ordenado por área
      ↓ buildFoldTree       — BFS via twins DCEL, isFoldEdge de linhas azuis
      ↓ TemplateMapper      — enriquece nodes com foldSign + animGroup por tipo FEFCO
      ↓ reorderPanelKeys    — renumera panel_N em BFS order (panel_0 = root)

   Formato SVG:
     <g id="root_group">
       rgb(255,0,0) = cut (exterior/contorno)
       rgb(0,0,255) = fold (vincos)
       rgb(0,128,0) = dimensões (IGNORAR)
     </g>

   Output:
   {
     meta, unit, rootKey, type,
     nodes: [{
       key, id, parentKey|null, angle,
       points: [{x,y}, ...],
       edge: {x1,y1,x2,y2}|null,
       isFoldEdge: bool,
       foldSign: -1|1,
       animGroup: number,
     }]
   }
   ================================================================ */
(function (root) {
    'use strict';

    /* ── constantes ── */
    var ARC_STEPS = 8;
    var SLIVER_RATIO = 0.0008;

    /* ── utilitários ── */
    function hypot(dx, dy) { return Math.sqrt(dx * dx + dy * dy); }

    function polySignedArea(pts) {
        var a = 0;
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i], q = pts[(i + 1) % pts.length];
            a += p.x * q.y - q.x * p.y;
        }
        return a / 2;
    }

    function polyArea(pts) { return Math.abs(polySignedArea(pts)); }

    function bbox(pts) {
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (var i = 0; i < pts.length; i++) {
            if (pts[i].x < x0) x0 = pts[i].x;
            if (pts[i].y < y0) y0 = pts[i].y;
            if (pts[i].x > x1) x1 = pts[i].x;
            if (pts[i].y > y1) y1 = pts[i].y;
        }
        return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0, h: y1 - y0 };
    }

    function polyCentroid(pts) {
        var sx = 0, sy = 0;
        for (var i = 0; i < pts.length; i++) { sx += pts[i].x; sy += pts[i].y; }
        return { x: sx / pts.length, y: sy / pts.length };
    }

    /* ── 1. parseColoredLines ──────────────────────────────────── */
    function parseColoredLines(doc) {
        var red = [], blue = [];
        var root_group = doc.getElementById('root_group');
        if (!root_group) throw new Error('SVG sem #root_group');

        var children = root_group.children;
        for (var i = 0; i < children.length; i++) {
            var el = children[i];
            var style = el.getAttribute('style') || '';
            var isRed  = style.indexOf('rgb(255,0,0)') >= 0;
            var isBlue = style.indexOf('rgb(0,0,255)') >= 0;
            if (!isRed && !isBlue) continue;

            var tag = el.tagName.toLowerCase();
            var segs = [];

            if (tag === 'line') {
                var x1 = parseFloat(el.getAttribute('x1') || 0);
                var y1 = parseFloat(el.getAttribute('y1') || 0);
                var x2 = parseFloat(el.getAttribute('x2') || 0);
                var y2 = parseFloat(el.getAttribute('y2') || 0);
                if (hypot(x2 - x1, y2 - y1) > 1e-4) segs.push({ x1: x1, y1: y1, x2: x2, y2: y2 });
            } else if (tag === 'path') {
                segs = pathToSegments(el.getAttribute('d') || '');
            }

            for (var s = 0; s < segs.length; s++) {
                (isBlue ? blue : red).push(segs[s]);
            }
        }
        return { red: red, blue: blue };
    }

    function pathToSegments(d) {
        var segs = [];
        var tokens = d.match(/[MmAaLlHhVvZzCcSsQqTt]|[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g);
        if (!tokens) return segs;

        var i = 0, cx = 0, cy = 0, startX = 0, startY = 0;
        function nextNum() { return parseFloat(tokens[i++]); }

        while (i < tokens.length) {
            var cmd = tokens[i++];
            if (cmd === 'M' || cmd === 'm') {
                var abs = cmd === 'M';
                var nx = abs ? nextNum() : cx + nextNum();
                var ny = abs ? nextNum() : cy + nextNum();
                cx = nx; cy = ny; startX = cx; startY = cy;
                while (i < tokens.length && !isNaN(parseFloat(tokens[i]))) {
                    var lx = abs ? nextNum() : cx + nextNum();
                    var ly = abs ? nextNum() : cy + nextNum();
                    if (hypot(lx - cx, ly - cy) > 1e-4) segs.push({ x1: cx, y1: cy, x2: lx, y2: ly });
                    cx = lx; cy = ly;
                }
            } else if (cmd === 'L' || cmd === 'l') {
                var abs2 = cmd === 'L';
                while (i < tokens.length && !isNaN(parseFloat(tokens[i]))) {
                    var lx2 = abs2 ? nextNum() : cx + nextNum();
                    var ly2 = abs2 ? nextNum() : cy + nextNum();
                    if (hypot(lx2 - cx, ly2 - cy) > 1e-4) segs.push({ x1: cx, y1: cy, x2: lx2, y2: ly2 });
                    cx = lx2; cy = ly2;
                }
            } else if (cmd === 'H' || cmd === 'h') {
                while (i < tokens.length && !isNaN(parseFloat(tokens[i]))) {
                    var hx = cmd === 'H' ? nextNum() : cx + nextNum();
                    if (Math.abs(hx - cx) > 1e-4) segs.push({ x1: cx, y1: cy, x2: hx, y2: cy });
                    cx = hx;
                }
            } else if (cmd === 'V' || cmd === 'v') {
                while (i < tokens.length && !isNaN(parseFloat(tokens[i]))) {
                    var vy = cmd === 'V' ? nextNum() : cy + nextNum();
                    if (Math.abs(vy - cy) > 1e-4) segs.push({ x1: cx, y1: cy, x2: cx, y2: vy });
                    cy = vy;
                }
            } else if (cmd === 'A' || cmd === 'a') {
                while (i < tokens.length && !isNaN(parseFloat(tokens[i]))) {
                    var rx = nextNum(), ry = nextNum();
                    var xRot = nextNum(), lgArc = nextNum(), sweep = nextNum();
                    var ex = cmd === 'A' ? nextNum() : cx + nextNum();
                    var ey = cmd === 'A' ? nextNum() : cy + nextNum();
                    var arcSegs = arcToSegments(cx, cy, rx, ry, xRot, lgArc, sweep, ex, ey);
                    for (var k = 0; k < arcSegs.length; k++) segs.push(arcSegs[k]);
                    cx = ex; cy = ey;
                }
            } else if (cmd === 'Z' || cmd === 'z') {
                if (hypot(startX - cx, startY - cy) > 1e-4)
                    segs.push({ x1: cx, y1: cy, x2: startX, y2: startY });
                cx = startX; cy = startY;
            } else {
                var skipPairs = { c: 3, s: 2, q: 2, t: 1 }[cmd.toLowerCase()];
                if (skipPairs) {
                    var abs3 = cmd === cmd.toUpperCase();
                    var lastX = cx, lastY = cy;
                    for (var p = 0; p < skipPairs && i < tokens.length && !isNaN(parseFloat(tokens[i])); p++) {
                        lastX = abs3 ? nextNum() : cx + nextNum();
                        lastY = abs3 ? nextNum() : cy + nextNum();
                    }
                    if (hypot(lastX - cx, lastY - cy) > 1e-4)
                        segs.push({ x1: cx, y1: cy, x2: lastX, y2: lastY });
                    cx = lastX; cy = lastY;
                }
            }
        }
        return segs;
    }

    function arcToSegments(x1, y1, rx, ry, xRot, lgArc, sweep, x2, y2) {
        var segs = [];
        if (hypot(x2 - x1, y2 - y1) < 1e-4) return segs;
        if (rx < 1e-4 || ry < 1e-4) { segs.push({ x1: x1, y1: y1, x2: x2, y2: y2 }); return segs; }
        var phi = xRot * Math.PI / 180;
        var cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
        var mx = (x1 - x2) / 2, my = (y1 - y2) / 2;
        var x1p =  cosPhi * mx + sinPhi * my;
        var y1p = -sinPhi * mx + cosPhi * my;
        var x1p2 = x1p * x1p, y1p2 = y1p * y1p;
        var rx2 = rx * rx, ry2 = ry * ry;
        var lambda = x1p2 / rx2 + y1p2 / ry2;
        if (lambda > 1) { lambda = Math.sqrt(lambda); rx *= lambda; ry *= lambda; rx2 = rx * rx; ry2 = ry * ry; }
        var num = Math.max(0, rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2);
        var den = rx2 * y1p2 + ry2 * x1p2;
        var sq = (lgArc === sweep ? -1 : 1) * Math.sqrt(num / (den || 1));
        var cxp =  sq * rx * y1p / ry;
        var cyp = -sq * ry * x1p / rx;
        var cx0 = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
        var cy0 = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
        function angle(ux, uy, vx, vy) {
            var d = Math.sqrt((ux*ux+uy*uy)*(vx*vx+vy*vy));
            if (d < 1e-10) return 0;
            var c = Math.max(-1, Math.min(1, (ux*vx+uy*vy)/d));
            return (ux*vy-uy*vx < 0 ? -1 : 1) * Math.acos(c);
        }
        var theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
        var dTheta = angle((x1p-cxp)/rx, (y1p-cyp)/ry, (-x1p-cxp)/rx, (-y1p-cyp)/ry);
        if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
        if ( sweep && dTheta < 0) dTheta += 2 * Math.PI;
        var steps = Math.max(2, ARC_STEPS);
        var px = x1, py = y1;
        for (var s = 1; s <= steps; s++) {
            var t = theta1 + dTheta * s / steps;
            var nx2 = (s === steps) ? x2 : cosPhi * rx * Math.cos(t) - sinPhi * ry * Math.sin(t) + cx0;
            var ny2 = (s === steps) ? y2 : sinPhi * rx * Math.cos(t) + cosPhi * ry * Math.sin(t) + cy0;
            if (hypot(nx2 - px, ny2 - py) > 1e-4) segs.push({ x1: px, y1: py, x2: nx2, y2: ny2 });
            px = nx2; py = ny2;
        }
        return segs;
    }

    /* ── 2. buildGraph ─────────────────────────────────────────── */
    function buildGraph(coloredSegs) {
        var allSegs = [];
        coloredSegs.red.forEach(function (s) { allSegs.push({ seg: s, isFold: false }); });
        coloredSegs.blue.forEach(function (s) { allSegs.push({ seg: s, isFold: true }); });

        var allPts = [];
        allSegs.forEach(function (e) { allPts.push(e.seg.x1, e.seg.y1, e.seg.x2, e.seg.y2); });
        var xs = allPts.filter(function (_, i) { return i % 2 === 0; });
        var ys = allPts.filter(function (_, i) { return i % 2 === 1; });
        var spanX = Math.max.apply(null, xs) - Math.min.apply(null, xs);
        var spanY = Math.max.apply(null, ys) - Math.min.apply(null, ys);
        var SNAP = Math.min(6, Math.max(0.5, Math.min(spanX, spanY) * 0.002));

        var verts = [];
        function snapVert(x, y) {
            for (var i = 0; i < verts.length; i++) {
                if (hypot(verts[i].x - x, verts[i].y - y) <= SNAP) return i;
            }
            verts.push({ x: x, y: y });
            return verts.length - 1;
        }

        var edges = [];
        allSegs.forEach(function (e) {
            var a = snapVert(e.seg.x1, e.seg.y1);
            var b = snapVert(e.seg.x2, e.seg.y2);
            if (a !== b) edges.push({ a: a, b: b, isFold: e.isFold });
        });

        var FOLD_CORNER_SNAP = Math.min(20, SNAP * 5);
        (function collapseShortCuts() {
            var foldEndpts = {};
            edges.forEach(function (e) {
                if (e.isFold) { foldEndpts[e.a] = true; foldEndpts[e.b] = true; }
            });
            var parent = [];
            for (var i = 0; i < verts.length; i++) parent[i] = i;
            function find(v) { while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v]; } return v; }
            var merged = false;
            edges.forEach(function (e) {
                if (e.isFold) return;
                var len = hypot(verts[e.a].x - verts[e.b].x, verts[e.a].y - verts[e.b].y);
                if (len > FOLD_CORNER_SNAP) return;
                var ra = find(e.a), rb = find(e.b);
                if (ra === rb || !foldEndpts[e.a] || !foldEndpts[e.b]) return;
                function foldErr(v, cand) {
                    var err = 0;
                    edges.forEach(function(x) {
                        if (!x.isFold || (x.a !== v && x.b !== v)) return;
                        var other = (x.a === v) ? x.b : x.a;
                        var dx1 = verts[v].x - verts[other].x, dy1 = verts[v].y - verts[other].y;
                        var dx2 = verts[cand].x - verts[other].x, dy2 = verts[cand].y - verts[other].y;
                        err += Math.abs(dx1 * dy2 - dy1 * dx2) / (hypot(dx1, dy1) || 1);
                    });
                    return err;
                }
                var keep = (foldErr(e.b, e.a) <= foldErr(e.a, e.b)) ? ra : rb;
                var drop = (keep === ra) ? rb : ra;
                parent[drop] = keep;
                merged = true;
            });
            if (!merged) return;
            edges = edges.map(function (e) {
                return { a: find(e.a), b: find(e.b), isFold: e.isFold };
            }).filter(function (e) { return e.a !== e.b; });
        })();

        edges = resolveT(edges, verts, SNAP);

        var seen = {};
        edges = edges.filter(function (e) {
            var key = Math.min(e.a, e.b) + '_' + Math.max(e.a, e.b);
            if (seen[key]) return false;
            seen[key] = true;
            return true;
        });

        return { verts: verts, edges: edges, SNAP: SNAP };
    }

    function resolveT(edges, verts, SNAP) {
        var changed = true, maxIter = 10;
        while (changed && maxIter-- > 0) {
            changed = false;
            var newEdges = [];
            for (var i = 0; i < edges.length; i++) {
                var e = edges[i];
                var va = verts[e.a], vb = verts[e.b];
                var dx = vb.x - va.x, dy = vb.y - va.y;
                var len = hypot(dx, dy);
                if (len < 1e-6) { newEdges.push(e); continue; }
                var splits = [];
                for (var j = 0; j < verts.length; j++) {
                    if (j === e.a || j === e.b) continue;
                    var vj = verts[j];
                    var t = ((vj.x - va.x) * dx + (vj.y - va.y) * dy) / (len * len);
                    if (t <= 0 || t >= 1) continue;
                    var px = va.x + t * dx, py = va.y + t * dy;
                    if (hypot(vj.x - px, vj.y - py) <= SNAP) splits.push({ t: t, idx: j });
                }
                if (!splits.length) { newEdges.push(e); continue; }
                splits.sort(function (a, b) { return a.t - b.t; });
                changed = true;
                var prev = e.a;
                for (var s = 0; s < splits.length; s++) {
                    newEdges.push({ a: prev, b: splits[s].idx, isFold: e.isFold });
                    prev = splits[s].idx;
                }
                newEdges.push({ a: prev, b: e.b, isFold: e.isFold });
            }
            edges = newEdges;
        }
        return edges;
    }

    /* ── 3. buildHalfEdges ─────────────────────────────────────── */
    function buildHalfEdges(graph) {
        var verts = graph.verts, edges = graph.edges;
        var halfEdges = [];
        var adjV = [];
        for (var i = 0; i < verts.length; i++) adjV.push([]);

        edges.forEach(function (e) {
            var h1 = halfEdges.length, h2 = h1 + 1;
            halfEdges.push({ vert: e.b, twin: h2, next: -1, face: -1, isFold: e.isFold });
            halfEdges.push({ vert: e.a, twin: h1, next: -1, face: -1, isFold: e.isFold });
            adjV[e.a].push(h1);
            adjV[e.b].push(h2);
        });

        for (var h = 0; h < halfEdges.length; h++) {
            var v = halfEdges[h].vert;
            var twin = halfEdges[h].twin;
            var uVert = halfEdges[twin].vert;
            var arrAng = Math.atan2(verts[v].y - verts[uVert].y, verts[v].x - verts[uVert].x);
            var candidates = adjV[v];
            var best = -1, bestDelta = Infinity;
            for (var k = 0; k < candidates.length; k++) {
                var cIdx = candidates[k];
                if (cIdx === twin) continue;
                var w = halfEdges[cIdx].vert;
                var depAng = Math.atan2(verts[w].y - verts[v].y, verts[w].x - verts[v].x);
                var delta = depAng - (arrAng + Math.PI);
                delta = ((delta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
                if (delta < bestDelta) { bestDelta = delta; best = cIdx; }
            }
            halfEdges[h].next = (best >= 0) ? best : twin;
        }

        return halfEdges;
    }

    /* ── 4. findFaces ──────────────────────────────────────────── */
    function findFaces(halfEdges, verts) {
        var faces = [];
        var visited = new Array(halfEdges.length).fill(false);

        for (var start = 0; start < halfEdges.length; start++) {
            if (visited[start]) continue;
            var pts = [], foldFlags = [];
            var h = start, count = 0;
            while (!visited[h] && count < halfEdges.length) {
                visited[h] = true;
                pts.push(verts[halfEdges[h].vert]);
                foldFlags.push(halfEdges[h].isFold);
                halfEdges[h].face = faces.length;
                h = halfEdges[h].next;
                count++;
            }
            if (pts.length >= 3) {
                faces.push({ points: pts, halfEdgeStart: start, hasFold: foldFlags.some(function(f){return f;}) });
            }
        }
        return faces;
    }

    /* ── 5. filterFaces ────────────────────────────────────────── */
    function filterFaces(faces, globalBB) {
        var totalArea = globalBB.w * globalBB.h;
        var sliverThresh = totalArea * SLIVER_RATIO;
        var sorted = faces.slice().sort(function (a, b) { return polyArea(b.points) - polyArea(a.points); });
        var outerFace = sorted[0];

        /* Maior face com hasFold = maior painel real.
           Faces sem hasFold maiores que este valor são outer faces de grupos
           isolados (ex: B2BA com múltiplos dielines) e devem ser removidas. */
        var maxFoldArea = 0;
        faces.forEach(function(f) {
            if (f.hasFold) maxFoldArea = Math.max(maxFoldArea, polyArea(f.points));
        });

        return faces.filter(function (f) {
            if (f === outerFace) return false;
            if (!f.hasFold && polyArea(f.points) > maxFoldArea) return false;
            if (polyArea(f.points) < sliverThresh) return false;
            var bb = bbox(f.points);
            if (bb.w > globalBB.w * 0.9 && bb.h > globalBB.h * 0.9) return false;
            return true;
        });
    }

    /* ── 6. assignKeys ─────────────────────────────────────────── */
    function assignKeys(faces) {
        var sorted = faces.slice().sort(function (a, b) { return polyArea(b.points) - polyArea(a.points); });
        sorted.forEach(function (f, i) { f.key = 'panel_' + i; });
        return sorted;
    }

    /* ── 7. buildFoldTree ──────────────────────────────────────── */
    function buildFoldTree(panels, halfEdges, verts) {
        var faceToPanel = {};
        panels.forEach(function (p) { faceToPanel[halfEdges[p.halfEdgeStart].face] = p; });

        var adj = {};
        panels.forEach(function (p) { adj[p.key] = []; });

        for (var h = 0; h < halfEdges.length; h++) {
            var he = halfEdges[h];
            if (he.face < 0) continue;
            var pA = faceToPanel[he.face];
            if (!pA) continue;
            var twin = halfEdges[he.twin];
            if (twin.face < 0) continue;
            var pB = faceToPanel[twin.face];
            if (!pB || pB === pA) continue;

            var va = verts[twin.vert];
            var vb = verts[he.vert];
            var isFold = he.isFold;

            var existingLink = null;
            for (var li = 0; li < adj[pA.key].length; li++) {
                if (adj[pA.key][li].otherKey === pB.key) { existingLink = adj[pA.key][li]; break; }
            }
            if (existingLink) {
                if (isFold && existingLink.isFold) {
                    var ex = existingLink.edge;
                    var edx = ex.x2 - ex.x1, edy = ex.y2 - ex.y1;
                    var elen = Math.sqrt(edx*edx + edy*edy) || 1;
                    var d1 = Math.abs((va.x-ex.x1)*edy - (va.y-ex.y1)*edx) / elen;
                    var d2 = Math.abs((vb.x-ex.x1)*edy - (vb.y-ex.y1)*edx) / elen;
                    if (d1 <= 4 && d2 <= 4) {
                        var pts4 = [{x:ex.x1,y:ex.y1},{x:ex.x2,y:ex.y2},{x:va.x,y:va.y},{x:vb.x,y:vb.y}];
                        var tMin = Infinity, tMax = -Infinity, tMinPt, tMaxPt;
                        pts4.forEach(function(pt) {
                            var t = ((pt.x-ex.x1)*edx + (pt.y-ex.y1)*edy) / (elen*elen);
                            if (t < tMin) { tMin = t; tMinPt = pt; }
                            if (t > tMax) { tMax = t; tMaxPt = pt; }
                        });
                        existingLink.edge = { x1: tMinPt.x, y1: tMinPt.y, x2: tMaxPt.x, y2: tMaxPt.y };
                        for (var lj = 0; lj < adj[pB.key].length; lj++) {
                            if (adj[pB.key][lj].otherKey === pA.key) {
                                adj[pB.key][lj].edge = { x1: tMaxPt.x, y1: tMaxPt.y, x2: tMinPt.x, y2: tMinPt.y };
                                break;
                            }
                        }
                    }
                }
                continue;
            }

            var edge = { x1: va.x, y1: va.y, x2: vb.x, y2: vb.y };
            adj[pA.key].push({ otherKey: pB.key, edge: edge, isFold: isFold });
            adj[pB.key].push({ otherKey: pA.key, edge: { x1: vb.x, y1: vb.y, x2: va.x, y2: va.y }, isFold: isFold });
        }

        var root = panels[0];
        var nodes = [];
        var seen = {};
        var foldQueue = [{ key: root.key, edge: null }];
        var cutQueue = [];
        seen[root.key] = true;

        nodes.push({
            key: root.key, id: root.key, parentKey: null, angle: 90,
            points: root.points, edge: null, isFoldEdge: false
        });

        function processEntry(entry) {
            var links = adj[entry.key] || [];
            for (var i = 0; i < links.length; i++) {
                var link = links[i];
                if (seen[link.otherKey]) continue;
                seen[link.otherKey] = true;
                var childPanel = panels.filter(function (p) { return p.key === link.otherKey; })[0];
                nodes.push({
                    key: childPanel.key, id: childPanel.key,
                    parentKey: entry.key, angle: 90,
                    points: childPanel.points, edge: link.edge,
                    isFoldEdge: link.isFold
                });
                var item = { key: link.otherKey, edge: link.edge };
                if (link.isFold) foldQueue.push(item); else cutQueue.push(item);
            }
        }

        while (foldQueue.length || cutQueue.length) {
            processEntry(foldQueue.length ? foldQueue.shift() : cutQueue.shift());
        }

        function segAxisKey(e) {
            var dx = e.x2 - e.x1, dy = e.y2 - e.y1, ELIN = 0.5;
            if (Math.abs(dx) < ELIN) return 'V:' + Math.round((e.x1 + e.x2) / 2 * 10);
            if (Math.abs(dy) < ELIN) return 'H:' + Math.round((e.y1 + e.y2) / 2 * 10);
            var slope = dy / dx;
            return 'A:' + slope.toFixed(4) + ':' + (e.y1 - slope * e.x1).toFixed(2);
        }

        var nodeByKey = {};
        nodes.forEach(function (n) { nodeByKey[n.key] = n; });

        panels.forEach(function (p) {
            if (seen[p.key]) return;
            var links = adj[p.key] || [], attached = false;
            for (var li = 0; li < links.length && !attached; li++) {
                var link = links[li];
                if (!seen[link.otherKey]) continue;
                var sibNode = nodeByKey[link.otherKey];
                if (!sibNode || sibNode.parentKey === null || !sibNode.edge) continue;
                if (segAxisKey(link.edge) === segAxisKey(sibNode.edge)) {
                    seen[p.key] = true;
                    attached = true;
                    nodeByKey[p.key] = {
                        key: p.key, id: p.key, parentKey: sibNode.parentKey, angle: 90,
                        points: p.points, edge: link.edge, isFoldEdge: true
                    };
                    nodes.push(nodeByKey[p.key]);
                }
            }
            if (!attached) {
                nodeByKey[p.key] = {
                    key: p.key, id: p.key, parentKey: root.key, angle: 90,
                    points: p.points, edge: null, isFoldEdge: false
                };
                nodes.push(nodeByKey[p.key]);
            }
        });

        nodes._adj = adj;
        return nodes;
    }

    /* ══════════════════════════════════════════════════════════════
       TEMPLATE MAPPERS — foldSign + animGroup por tipo FEFCO
       Cada mapper recebe nodes com keys panel_0…panel_N (ordem área)
       e pode modificar parentKey, edge, foldSign, animGroup.
    ══════════════════════════════════════════════════════════════ */

    function defaultFoldSign(node, parentNode) {
        if (!node.edge || !parentNode) return -1;
        var dx = node.edge.x2 - node.edge.x1, dy = node.edge.y2 - node.edge.y1;
        var len = hypot(dx, dy) || 1;
        var nx = -dy / len, ny = dx / len;
        var nodeCen = polyCentroid(node.points);
        var parCen  = polyCentroid(parentNode.points);
        var nodeDir = (nodeCen.x - node.edge.x1) * nx + (nodeCen.y - node.edge.y1) * ny;
        var parDir  = (parCen.x  - node.edge.x1) * nx + (parCen.y  - node.edge.y1) * ny;
        return (nodeDir * parDir < 0) ? -1 : 1;
    }

    /* ── TemplateMapper GENÉRICO ────────────────────────────────── */
    function templateGeneric(nodes) {
        var nodeByKey = {};
        nodes.forEach(function (n) { nodeByKey[n.key] = n; });

        nodes.forEach(function (n) {
            n._depth = (n.parentKey == null) ? 0 : ((nodeByKey[n.parentKey] || {})._depth || 0) + 1;
        });

        var rootArea = nodes[0] ? polyArea(nodes[0].points) : 1;

        nodes.forEach(function (n) {
            if (n.parentKey == null) { n.foldSign = -1; n.animGroup = 0; return; }
            var parentNode = nodeByKey[n.parentKey] || null;
            n.foldSign = defaultFoldSign(n, parentNode);
            var e = n.edge;
            var dx = e ? (e.x2 - e.x1) : 0, dy = e ? (e.y2 - e.y1) : 0;
            var len = Math.sqrt(dx*dx+dy*dy) || 1;
            var uY = dy / len;
            var areaRatio = polyArea(n.points) / (rootArea || 1);
            var isLid      = (!n.isFoldEdge) && (areaRatio > 0.30);
            var isVertAxis = Math.abs(uY) > 0.7;
            var isTopBot   = (n._depth >= 2) && !isLid && (areaRatio < 0.55);
            if (isLid)            n.animGroup = 100;
            else if (isTopBot)    n.animGroup = 50;
            else if (n._depth === 1 && n.isFoldEdge && isVertAxis) n.animGroup = 1;
            else                  n.animGroup = 0;
        });
    }

    /* ── Utilitário RSC: calcula band Y do tubo e classifica animGroups ──
       ag=0 paredes (centróide no band), ag=1 abas topo, ag=2 abas fundo.
       topFirst=true → topo=1/fundo=2; topFirst=false → topo=2/fundo=1. */
    function _rscAnimGroups(nodes, topFirst) {
        /* band Y = bbox de todos os nós que têm fold edges horizontais */
        var hFoldYs = [];
        nodes.forEach(function(n) {
            if (!n.edge) return;
            var dx = n.edge.x2 - n.edge.x1, dy = n.edge.y2 - n.edge.y1;
            var len = hypot(dx, dy) || 1;
            if (Math.abs(dx / len) > 0.7) hFoldYs.push((n.edge.y1 + n.edge.y2) / 2);
        });
        hFoldYs.sort(function(a, b) { return a - b; });
        var tubeYmin = hFoldYs.length ? hFoldYs[0]                   : 0;
        var tubeYmax = hFoldYs.length ? hFoldYs[hFoldYs.length - 1]  : 1e9;
        var tubeYmid = (tubeYmin + tubeYmax) / 2;

        var agTop = topFirst ? 1 : 2;
        var agBot = topFirst ? 2 : 1;

        nodes.forEach(function(n) {
            n.foldSign = -1;
            if (n.parentKey == null) { n.animGroup = 0; return; }
            var cen = polyCentroid(n.points);
            if (cen.y >= tubeYmin && cen.y <= tubeYmax) {
                n.animGroup = 0;
            } else if (cen.y < tubeYmid) {
                n.animGroup = agTop;
            } else {
                n.animGroup = agBot;
            }
        });
    }

    /* ── TemplateMapper FEFCO_0201 ─────────────────────────────── */
    function templateFEFCO_0201(nodes) {
        var adj = nodes._adj || {};

        /* Raiz = parede do tubo (grau máximo) mais próxima do centro do SVG */
        var maxDeg = 0;
        nodes.forEach(function(n) { var d=(adj[n.key]||[]).length; if(d>maxDeg) maxDeg=d; });
        var walls = nodes.filter(function(n) { return (adj[n.key]||[]).length === maxDeg; });

        /* Centro global do dieline */
        var gMinX=Infinity, gMaxX=-Infinity, gMinY=Infinity, gMaxY=-Infinity;
        nodes.forEach(function(n) { var b=bbox(n.points); if(b.x0<gMinX)gMinX=b.x0; if(b.x1>gMaxX)gMaxX=b.x1; if(b.y0<gMinY)gMinY=b.y0; if(b.y1>gMaxY)gMaxY=b.y1; });
        var gcx = (gMinX+gMaxX)/2, gcy = (gMinY+gMaxY)/2;

        /* Parede mais próxima do centro */
        var newRoot = walls.slice().sort(function(a,b) {
            var ca=polyCentroid(a.points), cb=polyCentroid(b.points);
            var da=(ca.x-gcx)*(ca.x-gcx)+(ca.y-gcy)*(ca.y-gcy);
            var db=(cb.x-gcx)*(cb.x-gcx)+(cb.y-gcy)*(cb.y-gcy);
            return da-db;
        })[0];

        if (newRoot) {
            /* Filho da parede central mais próximo do centro Y do dieline → panel_0 */
            var rootChildren = (adj[newRoot.key] || []).map(function(link) {
                return nodes.filter(function(n){ return n.key===link.otherKey; })[0];
            }).filter(Boolean);
            if (rootChildren.length) {
                var bestChild = rootChildren.slice().sort(function(a, b) {
                    var ca = polyCentroid(a.points), cb = polyCentroid(b.points);
                    var da = Math.abs(ca.y - gcy), db = Math.abs(cb.y - gcy);
                    if (Math.abs(da - db) > 10) return da - db; /* mais próximo do centro Y */
                    return ca.y - cb.y; /* desempate: cy menor (mais acima) */
                })[0];
                if (bestChild) newRoot = bestChild;
            }

            /* Refazer BFS a partir da raiz correcta */
            var newParent = {}, newEdge = {};
            newParent[newRoot.key] = null;
            newEdge[newRoot.key]   = null;
            var queue = [newRoot.key], seen = {};
            seen[newRoot.key] = true;
            while (queue.length) {
                var cur = queue.shift();
                (adj[cur] || []).forEach(function(link) {
                    if (seen[link.otherKey]) return;
                    seen[link.otherKey] = true;
                    newParent[link.otherKey] = cur;
                    newEdge[link.otherKey]   = link.edge;
                    queue.push(link.otherKey);
                });
            }
            nodes.forEach(function(n) {
                if (newParent[n.key] === undefined) { newParent[n.key] = newRoot.key; newEdge[n.key] = null; }
                n.parentKey = newParent[n.key];
                n.edge = newEdge[n.key] !== undefined ? newEdge[n.key] : n.edge;
            });
        }

        /* ag=0 raiz + paredes, ag=1 abas de baixo, ag=2 abas de cima */
        var tubeYmin = Infinity, tubeYmax = -Infinity;
        nodes.forEach(function(n) {
            if ((adj[n.key]||[]).length >= 3) {
                var b = bbox(n.points);
                if (b.y0 < tubeYmin) tubeYmin = b.y0;
                if (b.y1 > tubeYmax) tubeYmax = b.y1;
            }
        });
        var tubeYmid = (tubeYmin + tubeYmax) / 2;
        nodes.forEach(function(n) {
            n.foldSign = -1;
            if (n.parentKey == null)               n.animGroup = 0;
            else if ((adj[n.key]||[]).length >= 3) n.animGroup = 0;
            else if (polyCentroid(n.points).y > tubeYmid) n.animGroup = 1; /* baixo primeiro */
            else                                   n.animGroup = 2; /* cima depois */
        });
    }

    /* ── TemplateMapper FEFCO_0200 ─────────────────────────────── */
    function templateFEFCO_0200(nodes) {
        _rscAnimGroups(nodes, true);
    }

    /* ── TemplateMapper FEFCO_0216 ─────────────────────────────── */
    function templateFEFCO_0216(nodes) {
        _rscAnimGroups(nodes, false); /* fundo=ag1, topo=ag2 — animGroups por posição Y */
    }


    /* ── TemplateMapper FEFCO_0215 ─────────────────────────────── */
    function templateFEFCO_0215(nodes) {
        _rscAnimGroups(nodes, false); /* mesma ordem que 0216 */

        var nodeByKey = {};
        nodes.forEach(function(n) { nodeByKey[n.key] = n; });
        var p0 = nodeByKey['panel_0'], p2 = nodeByKey['panel_2'];
        if (!p0 || !p2) return;

        /* aresta partilhada entre p0 e p2 */
        var sharedEdge = (function(ptsA, ptsB) {
            var EPS = 4, bestLen = 0, bestEdge = null;
            for (var i = 0; i < ptsA.length; i++) {
                var a1 = ptsA[i], a2 = ptsA[(i+1)%ptsA.length];
                var dx = a2.x-a1.x, dy = a2.y-a1.y, segLen = hypot(dx,dy)||1;
                for (var j = 0; j < ptsB.length; j++) {
                    var b1 = ptsB[j], b2 = ptsB[(j+1)%ptsB.length];
                    if (Math.abs((b1.x-a1.x)*dy-(b1.y-a1.y)*dx)/segLen > 4) continue;
                    if (Math.abs((b2.x-a1.x)*dy-(b2.y-a1.y)*dx)/segLen > 4) continue;
                    var t1 = ((b1.x-a1.x)*dx+(b1.y-a1.y)*dy)/(segLen*segLen);
                    var t2 = ((b2.x-a1.x)*dx+(b2.y-a1.y)*dy)/(segLen*segLen);
                    var ov = (Math.min(Math.max(t1,t2),1)-Math.max(Math.min(t1,t2),0))*segLen;
                    if (ov > EPS && ov > bestLen) { bestLen = ov; bestEdge = {x1:a1.x,y1:a1.y,x2:a2.x,y2:a2.y}; }
                }
            }
            return bestEdge;
        })(p0.points, p2.points);

        if (sharedEdge) {
            var edgeDx = sharedEdge.x2 - sharedEdge.x1, edgeDy = sharedEdge.y2 - sharedEdge.y1;
            var isVert = Math.abs(edgeDy) > Math.abs(edgeDx);
            if (isVert ? (edgeDy < 0) : (edgeDx < 0))
                sharedEdge = { x1: sharedEdge.x2, y1: sharedEdge.y2, x2: sharedEdge.x1, y2: sharedEdge.y1 };
        }

        p2.parentKey = null; p2.edge = null;
        p0.parentKey = 'panel_2'; p0.edge = sharedEdge;
        p0.angle = 90; p0.foldSign = 1; p0.animGroup = 3;
        p0._dvInverted = true;
    }

    /* ── TemplateMapper FEFCO_0427 ─────────────────────────────── */
    function templateFEFCO_0427(nodes) {
        var nodeByKey = {};
        nodes.forEach(function (n) { nodeByKey[n.key] = n; });

        var animMap = {
            'panel_0': 0, 'panel_2': 0, 'panel_4': 0,
            'panel_13': 0, 'panel_14': 0, 'panel_11': 0, 'panel_12': 0,
            'panel_5': 1, 'panel_6': 1, 'panel_17': 1, 'panel_18': 1, 'panel_7': 1, 'panel_8': 1,
            'panel_9': 2, 'panel_10': 2, 'panel_15': 2, 'panel_16': 2, 'panel_1': 3, 'panel_3': 3,
        };
        nodes.forEach(function (n) { n.animGroup = animMap[n.key] !== undefined ? animMap[n.key] : 0; n.foldSign = -1; });

        function sharedEdge427(nA, nB) {
            var ptsA = nA.points, ptsB = nB.points, EPS = 6, bestLen = 0, bestEdge = null;
            for (var i = 0; i < ptsA.length; i++) {
                var a1=ptsA[i], a2=ptsA[(i+1)%ptsA.length], dx=a2.x-a1.x, dy=a2.y-a1.y, segLen=hypot(dx,dy)||1;
                for (var j = 0; j < ptsB.length; j++) {
                    var b1=ptsB[j], b2=ptsB[(j+1)%ptsB.length];
                    if (Math.abs((b1.x-a1.x)*dy-(b1.y-a1.y)*dx)/segLen>EPS) continue;
                    if (Math.abs((b2.x-a1.x)*dy-(b2.y-a1.y)*dx)/segLen>EPS) continue;
                    var t1=((b1.x-a1.x)*dx+(b1.y-a1.y)*dy)/(segLen*segLen);
                    var t2=((b2.x-a1.x)*dx+(b2.y-a1.y)*dy)/(segLen*segLen);
                    var ov=(Math.min(Math.max(t1,t2),1)-Math.max(Math.min(t1,t2),0))*segLen;
                    if (ov>EPS && ov>bestLen) { bestLen=ov; bestEdge={x1:a1.x,y1:a1.y,x2:a2.x,y2:a2.y}; }
                }
            }
            return bestEdge;
        }

        var p5=nodeByKey['panel_5'], p6=nodeByKey['panel_6'];
        if (p5) { var b5=bbox(p5.points); p5.edge={x1:b5.x1,y1:b5.y0,x2:b5.x1,y2:b5.y1}; }
        if (p6) { var b6=bbox(p6.points); p6.edge={x1:b6.x0,y1:b6.y1,x2:b6.x0,y2:b6.y0}; }
        var p2=nodeByKey['panel_2'];
        if (p2) { var b2=bbox(p2.points); p2.edge={x1:b2.x0,y1:b2.y1,x2:b2.x1,y2:b2.y1}; p2.foldSign=1; }
        var p4=nodeByKey['panel_4'], p13=nodeByKey['panel_13'], p14=nodeByKey['panel_14'];
        if (p13&&p4) { p13.parentKey='panel_4'; p13.edge=sharedEdge427(p13,p4)||p13.edge; p13.foldSign=1; }
        if (p14&&p4) { p14.parentKey='panel_4'; p14.edge=sharedEdge427(p14,p4)||p14.edge; p14.foldSign=1; }
        var p1=nodeByKey['panel_1'], p3=nodeByKey['panel_3'];
        if (p1) { var b1=bbox(p1.points); p1.edge={x1:b1.x1,y1:b1.y1,x2:b1.x0,y2:b1.y1}; p1.foldSign=-1; }
        if (p3) { var b3=bbox(p3.points); p3.edge={x1:b3.x1,y1:b3.y1,x2:b3.x0,y2:b3.y1}; p3.foldSign=defaultFoldSign(p3,nodeByKey[p3.parentKey]); }
    }

    /* ── TemplateMapper FEFCO_04XX ─────────────────────────────── */
    function templateFEFCO_04XX(nodes) { templateGeneric(nodes); }

    /* ── Mapper genérico por conectividade de FOLD ─────────────────
       Para caixas onde o DCEL escolhe um root errado (ex.: a tampa em vez do
       tubo). Escolhe o root pela MAIOR conectividade de fold edges, refaz a
       árvore por BFS priorizando folds (1º passe folds, 2º passe cuts), e
       deriva foldSign (geometria) + animGroup (profundidade). */
    function _foldTreeByConnectivity(nodes) {
        var nodeByKey = {};
        nodes.forEach(function (n) { nodeByKey[n.key] = n; });
        var adj = nodes._adj || {};

        function foldDegree(k) {
            return (adj[k] || []).filter(function (l) { return l.isFold; }).length;
        }
        var root = nodes[0];
        nodes.forEach(function (n) {
            var d = foldDegree(n.key), dr = foldDegree(root.key);
            if (d > dr || (d === dr && polyArea(n.points) > polyArea(root.points))) root = n;
        });

        var seen = {}, foldQ = [root.key], cutQ = [];
        seen[root.key] = true;
        root.parentKey = null; root.edge = null;

        function processQueue(q, foldOnly) {
            while (q.length) {
                var cur = q.shift();
                (adj[cur] || []).forEach(function (lk) {
                    if (seen[lk.otherKey]) return;
                    if (foldOnly && !lk.isFold) { cutQ.push({ from: cur, lk: lk }); return; }
                    seen[lk.otherKey] = true;
                    var child = nodeByKey[lk.otherKey];
                    if (child) { child.parentKey = cur; child.edge = lk.edge; child.isFoldEdge = lk.isFold; }
                    if (lk.isFold) foldQ.push(lk.otherKey); else cutQ.push(lk.otherKey);
                });
            }
        }
        processQueue(foldQ, true);
        var cutKeys = [];
        cutQ.forEach(function (item) {
            if (typeof item === 'string') { cutKeys.push(item); return; }
            if (!seen[item.lk.otherKey]) {
                seen[item.lk.otherKey] = true;
                var child = nodeByKey[item.lk.otherKey];
                if (child) { child.parentKey = item.from; child.edge = item.lk.edge; child.isFoldEdge = false; }
                cutKeys.push(item.lk.otherKey);
            }
        });
        processQueue(cutKeys, false);
        nodes.forEach(function (n) { if (!seen[n.key]) { n.parentKey = root.key; n.edge = null; } });

        var depth = {}, dq = [root.key];
        depth[root.key] = 0;
        while (dq.length) {
            var cur = dq.shift();
            nodes.forEach(function (n) {
                if (n.parentKey === cur && depth[n.key] === undefined) {
                    depth[n.key] = depth[cur] + 1; dq.push(n.key);
                }
            });
        }

        nodes.forEach(function (n) {
            if (n.parentKey == null) { n.foldSign = -1; n.animGroup = 0; return; }
            n.foldSign = defaultFoldSign(n, nodeByKey[n.parentKey] || null);
            n.animGroup = depth[n.key] !== undefined ? depth[n.key] : 1;
        });
    }

    /* ── TemplateMapper FEFCO_0426 ─────────────────────────────────
       Caixa com fundo automático (crash-lock) + tampa com aba de fecho. */
    function templateFEFCO_0426(nodes) { _foldTreeByConnectivity(nodes); }

    /* ── TemplateMapper FEFCO_0473 ─────────────────────────────────
       Caixa com fita biadesiva (montagem rápida). Tem uma aba de canto que
       dobra na diagonal — daí a topologia de fold ser pouco intuitiva. Usa o
       mapper genérico por conectividade de fold; afinar foldSign/animGroup
       depois de ver no 3D. */
    function templateFEFCO_0473(nodes) { _foldTreeByConnectivity(nodes); }

    /* ── TemplateMapper FEFCO_0422 ─────────────────────────────── */
    function templateFEFCO_0422(nodes) {
        var nodeByKey = {};
        nodes.forEach(function (n) { nodeByKey[n.key] = n; });
        nodes.forEach(function (n) {
            n._depth = (n.parentKey==null) ? 0 : ((nodeByKey[n.parentKey]||{})._depth||0)+1;
        });
        var rootArea = nodes[0] ? polyArea(nodes[0].points) : 1;
        var hasChildren = {};
        nodes.forEach(function(n) { if (n.parentKey!=null) hasChildren[n.parentKey]=true; });
        var kept = nodes.filter(function(n) {
            if (n.parentKey==null) return true;
            return polyArea(n.points)/(rootArea||1) >= 0.03 || hasChildren[n.key];
        });
        nodes.length=0; kept.forEach(function(n){nodes.push(n);}); nodeByKey={};
        nodes.forEach(function(n){nodeByKey[n.key]=n;});

        function fullSharedEdge(nA, nB) {
            var ptsA=nA.points, ptsB=nB.points, EPS=4, bestLen=0, bestEdge=null;
            for (var i=0;i<ptsA.length;i++) {
                var a1=ptsA[i],a2=ptsA[(i+1)%ptsA.length],dx=a2.x-a1.x,dy=a2.y-a1.y,segLen=hypot(dx,dy)||1,ux=dx/segLen,uy=dy/segLen;
                var hasCol=false;
                for(var j=0;j<ptsB.length;j++){if(Math.abs((ptsB[j].x-a1.x)*dy-(ptsB[j].y-a1.y)*dx)/segLen<EPS){hasCol=true;break;}}
                if(!hasCol)continue;
                var tsA=ptsA.map(function(p){return(p.x-a1.x)*ux+(p.y-a1.y)*uy;});
                var tsB=ptsB.map(function(p){var d=Math.abs((p.x-a1.x)*dy-(p.y-a1.y)*dx)/segLen;return d<EPS?(p.x-a1.x)*ux+(p.y-a1.y)*uy:null;}).filter(function(t){return t!==null;});
                if(!tsB.length)continue;
                var minA=Math.min.apply(null,tsA),maxA=Math.max.apply(null,tsA),minB=Math.min.apply(null,tsB),maxB=Math.max.apply(null,tsB);
                var oMin=Math.max(minA,minB),oMax=Math.min(maxA,maxB);
                if(oMax-oMin<=EPS)continue;
                if(oMax-oMin>bestLen){
                    bestLen=oMax-oMin;
                    var p1={x:a1.x+ux*oMin,y:a1.y+uy*oMin},p2={x:a1.x+ux*oMax,y:a1.y+uy*oMax};
                    var nx=-uy,ny=ux,cen=polyCentroid(nA.points),side=(cen.x-p1.x)*nx+(cen.y-p1.y)*ny;
                    bestEdge=side>=0?{x1:p1.x,y1:p1.y,x2:p2.x,y2:p2.y}:{x1:p2.x,y1:p2.y,x2:p1.x,y2:p1.y};
                }
            }
            return bestEdge;
        }

        nodes.forEach(function(n){if(n.parentKey==null)return;var pn=nodeByKey[n.parentKey];if(!pn)return;var b=fullSharedEdge(n,pn);if(b)n.edge=b;});
        var p1node=nodeByKey['panel_1'];
        if(p1node&&p1node.edge){
            var lidBotY=(p1node.edge.y1+p1node.edge.y2)/2;
            nodes.forEach(function(n){
                if(n.parentKey!=='panel_3'&&n.parentKey!=='panel_4')return;
                var e=n.edge; if(!e)return;
                if(Math.abs((e.y1+e.y2)/2-lidBotY)>10)return;
                if(Math.abs(e.x2-e.x1)<=Math.abs(e.y2-e.y1))return;
                n.parentKey='panel_1'; n.edge=fullSharedEdge(n,p1node)||e;
            });
        }
        nodes.forEach(function(n){n.foldSign=-1;});
        var animMap={'panel_0':0,'panel_1':0,'panel_2':0,'panel_7':0,'panel_9':0,'panel_8':0,'panel_10':0,'panel_3':1,'panel_4':1,'panel_11':1,'panel_12':1,'panel_5':1,'panel_6':1};
        nodes.forEach(function(n){n.animGroup=animMap[n.key]!==undefined?animMap[n.key]:0;});
    }

    /* ── TemplateMapper FEFCO_0425 ─────────────────────────────── */
    function templateFEFCO_0425(nodes) {
        var nodeByKey = {};
        nodes.forEach(function(n){nodeByKey[n.key]=n;});

        function fullSharedEdge0425(nA,nB){
            var ptsA=nA.points,ptsB=nB.points,EPS=4,bestLen=0,bestEdge=null;
            for(var i=0;i<ptsA.length;i++){
                var a1=ptsA[i],a2=ptsA[(i+1)%ptsA.length],dx=a2.x-a1.x,dy=a2.y-a1.y,segLen=hypot(dx,dy)||1,ux=dx/segLen,uy=dy/segLen;
                var hasCol=false;
                for(var j=0;j<ptsB.length;j++){if(Math.abs((ptsB[j].x-a1.x)*dy-(ptsB[j].y-a1.y)*dx)/segLen<EPS){hasCol=true;break;}}
                if(!hasCol)continue;
                var tsA=ptsA.map(function(p){return(p.x-a1.x)*ux+(p.y-a1.y)*uy;});
                var tsB=ptsB.map(function(p){var d=Math.abs((p.x-a1.x)*dy-(p.y-a1.y)*dx)/segLen;return d<EPS?(p.x-a1.x)*ux+(p.y-a1.y)*uy:null;}).filter(function(t){return t!==null;});
                if(!tsB.length)continue;
                var minA=Math.min.apply(null,tsA),maxA=Math.max.apply(null,tsA),minB=Math.min.apply(null,tsB),maxB=Math.max.apply(null,tsB);
                var oMin=Math.max(minA,minB),oMax=Math.min(maxA,maxB);
                if(oMax-oMin<=EPS)continue;
                if(oMax-oMin>bestLen){
                    bestLen=oMax-oMin;
                    var p1={x:a1.x+ux*oMin,y:a1.y+uy*oMin},p2={x:a1.x+ux*oMax,y:a1.y+uy*oMax};
                    var nx=-uy,ny=ux,cen=polyCentroid(nA.points),side=(cen.x-p1.x)*nx+(cen.y-p1.y)*ny;
                    bestEdge=side>=0?{x1:p1.x,y1:p1.y,x2:p2.x,y2:p2.y}:{x1:p2.x,y1:p2.y,x2:p1.x,y2:p1.y};
                }
            }
            return bestEdge;
        }

        var n6=nodeByKey['panel_6'];
        if(n6){var b6={xMin:Infinity,xMax:-Infinity,yMax:-Infinity};n6.points.forEach(function(p){if(p.x<b6.xMin)b6.xMin=p.x;if(p.x>b6.xMax)b6.xMax=p.x;if(p.y>b6.yMax)b6.yMax=p.y;});n6.points=[{x:b6.xMin,y:440},{x:b6.xMax,y:440},{x:b6.xMax,y:b6.yMax},{x:b6.xMin,y:b6.yMax}];n6.edge={x1:b6.xMax,y1:b6.yMax,x2:b6.xMin,y2:b6.yMax};}
        var n5=nodeByKey['panel_5'];
        if(n5){var b5={xMin:Infinity,xMax:-Infinity,yMin:Infinity};n5.points.forEach(function(p){if(p.x<b5.xMin)b5.xMin=p.x;if(p.x>b5.xMax)b5.xMax=p.x;if(p.y<b5.yMin)b5.yMin=p.y;});n5.points=[{x:b5.xMin,y:b5.yMin},{x:b5.xMax,y:b5.yMin},{x:b5.xMax,y:2187},{x:b5.xMin,y:2187}];n5.edge={x1:b5.xMin,y1:b5.yMin,x2:b5.xMax,y2:b5.yMin};}
        var p1node=nodeByKey['panel_1'];
        ['panel_12','panel_11'].forEach(function(key){var n=nodeByKey[key];if(!n||!p1node)return;n.parentKey='panel_1';var b=fullSharedEdge0425(n,p1node);if(b)n.edge=b;});
        ['panel_19','panel_20'].forEach(function(key){
            var n=nodeByKey[key];if(!n||n.points.length<3)return;
            var xMin=Infinity,xMax=-Infinity,yMin=Infinity,yMax=-Infinity;
            n.points.forEach(function(p){if(p.x<xMin)xMin=p.x;if(p.x>xMax)xMax=p.x;if(p.y<yMin)yMin=p.y;if(p.y>yMax)yMax=p.y;});
            n.points=[{x:xMin,y:yMin},{x:xMax,y:yMin},{x:xMax,y:yMax},{x:xMin,y:yMax}];
            var pn=nodeByKey[n.parentKey];
            if(pn){var pCen=polyCentroid(pn.points),edgeY=Math.abs(pCen.y-yMin)<Math.abs(pCen.y-yMax)?yMin:yMax;n.edge={x1:xMin,y1:edgeY,x2:xMax,y2:edgeY};}
        });
        templateGeneric(nodes);
        nodes.forEach(function(n){n.foldSign=-1;});
        var animMap={'panel_0':0,'panel_1':0,'panel_2':0,'panel_9':0,'panel_10':0,'panel_12':0,'panel_11':0,'panel_5':1,'panel_6':1,'panel_19':1,'panel_20':1,'panel_7':1,'panel_8':1,'panel_13':1,'panel_14':1,'panel_15':1,'panel_16':1,'panel_17':2,'panel_18':2,'panel_3':2,'panel_4':2};
        nodes.forEach(function(n){n.animGroup=animMap[n.key]!==undefined?animMap[n.key]:0;});
        ['panel_13','panel_14','panel_15','panel_16'].forEach(function(key){var n=nodeByKey[key];if(n)n.foldSign=1;});
        var p20n=nodeByKey['panel_20'];if(p20n)p20n.foldSign=1;
    }

    /* ── TemplateMapper FEFCO_0330 ─────────────────────────────── */
    function templateFEFCO_0330(nodes) {
        /* O SVG "B2BA" contém 4 grupos: cada peça (base e lid) aparece duas vezes
           — uma vista em cima e outra em baixo, separadas pelo midY do SVG.
           Dividimos por midX (esquerda=lid, direita=base) e por midY (cima/baixo),
           e usamos apenas os painéis do quadrante superior (y < midY) de cada lado,
           pois são o conjunto geometricamente conectado por vincos. */
        var nodeByKey = {};
        nodes.forEach(function(n) { nodeByKey[n.key] = n; });

        /* midX divide esquerda (lid) de direita (base) */
        var sumX = 0;
        nodes.forEach(function(n) { sumX += polyCentroid(n.points).x; });
        var midX = sumX / nodes.length;

        var adj = nodes._adj || {};

        /* Para cada lado (X), encontrar todos os componentes conexos via adj.
           O SVG B2BA tem 2 cópias de cada peça — ficam em 2 componentes distintos.
           Usamos apenas o componente do maior painel (maior área) de cada lado. */
        function connectedComponent(startKey, allowedKeys) {
            var comp = {}, queue = [startKey];
            comp[startKey] = true;
            while (queue.length) {
                var cur = queue.shift();
                (adj[cur] || []).forEach(function(lk) {
                    if (allowedKeys[lk.otherKey] && !comp[lk.otherKey]) {
                        comp[lk.otherKey] = true;
                        queue.push(lk.otherKey);
                    }
                });
            }
            return comp;
        }

        function pickLargestComponent(sideNodes) {
            var byKey = {};
            sideNodes.forEach(function(n) { byKey[n.key] = true; });
            var remaining = sideNodes.slice(), result = [];
            while (remaining.length) {
                /* componente a partir do maior restante */
                var start = remaining[0];
                remaining.forEach(function(n) { if (polyArea(n.points) > polyArea(start.points)) start = n; });
                var comp = connectedComponent(start.key, byKey);
                var compNodes = remaining.filter(function(n) { return comp[n.key]; });
                if (compNodes.length > result.length) result = compNodes;
                remaining = remaining.filter(function(n) { return !comp[n.key]; });
            }
            return result;
        }

        var leftSide  = nodes.filter(function(n) { return polyCentroid(n.points).x <= midX; });
        var rightSide = nodes.filter(function(n) { return polyCentroid(n.points).x >  midX; });

        var leftNodes  = pickLargestComponent(leftSide);
        var rightNodes = pickLargestComponent(rightSide);

        /* Raiz de cada grupo = painel de maior área */
        function largestPanel(list) {
            var best = list[0];
            list.forEach(function(n) { if (polyArea(n.points) > polyArea(best.points)) best = n; });
            return best;
        }
        var leftRoot  = largestPanel(leftNodes);
        var rightRoot = largestPanel(rightNodes);

        /* LID = peça MAIOR (root de maior área); BASE = peça menor.
           A distinção é por TAMANHO, não pela posição esquerda/direita. */
        var lidNodes, baseNodes, lidRoot, baseRoot;
        if (polyArea(leftRoot.points) >= polyArea(rightRoot.points)) {
            lidNodes = leftNodes;  lidRoot = leftRoot;
            baseNodes = rightNodes; baseRoot = rightRoot;
        } else {
            lidNodes = rightNodes; lidRoot = rightRoot;
            baseNodes = leftNodes;  baseRoot = leftRoot;
        }

        /* Reconectar cada grupo à sua própria raiz via BFS prioritizando fold edges.
           Dois passes: 1º só fold edges, 2º cut edges para os não visitados.
           Isto garante que abas ligadas por fold a um lado (ex: panel_9) ficam
           como filhas desse lado e não do root — mesmo que o root as toque por cut. */
        function rewireGroup(groupNodes, root) {
            var byKey = {};
            groupNodes.forEach(function(n) { byKey[n.key] = true; });
            var seen = {}, foldQ = [root.key], cutQ = [];
            seen[root.key] = true;
            root.parentKey = null;

            function processQueue(q, foldOnly) {
                while (q.length) {
                    var cur = q.shift();
                    (adj[cur] || []).forEach(function(lk) {
                        if (!byKey[lk.otherKey] || seen[lk.otherKey]) return;
                        if (foldOnly && !lk.isFold) { cutQ.push({from: cur, lk: lk}); return; }
                        seen[lk.otherKey] = true;
                        var child = nodeByKey[lk.otherKey];
                        if (child) { child.parentKey = cur; child.edge = lk.edge; child.isFoldEdge = lk.isFold; }
                        if (lk.isFold) foldQ.push(lk.otherKey); else cutQ.push(lk.otherKey);
                    });
                }
            }

            /* 1º passe: só fold edges */
            processQueue(foldQ, true);
            /* 2º passe: cut edges pendentes (só os não visitados) */
            var cutKeys = [];
            cutQ.forEach(function(item) {
                if (typeof item === 'string') { cutKeys.push(item); return; }
                if (!seen[item.lk.otherKey]) {
                    seen[item.lk.otherKey] = true;
                    var child = nodeByKey[item.lk.otherKey];
                    if (child) { child.parentKey = item.from; child.edge = item.lk.edge; child.isFoldEdge = false; }
                    cutKeys.push(item.lk.otherKey);
                }
            });
            processQueue(cutKeys, false);

            groupNodes.forEach(function(n) {
                if (!seen[n.key]) { n.parentKey = root.key; n.edge = null; }
            });
        }

        rewireGroup(baseNodes, baseRoot);
        rewireGroup(lidNodes,  lidRoot);

        /* Para cada grupo: filhos directos do root ligados por cut que têm
           vizinhos fold dentro do grupo → esses vizinhos devem ser filhos
           deste nó (lado), não do root. Corrigir parentKey + edge. */
        [baseNodes, lidNodes].forEach(function(groupNodes) {
            var root = groupNodes.filter(function(n) { return n.parentKey === null; })[0];
            if (!root) return;
            var byKey = {};
            groupNodes.forEach(function(n) { byKey[n.key] = true; });

            /* Lados com cut ao root mas com filhos fold */
            groupNodes.forEach(function(side) {
                if (side.parentKey !== root.key || side.isFoldEdge) return;
                /* filhos fold deste lado que estão actualmente sob root */
                (adj[side.key] || []).forEach(function(lk) {
                    if (!lk.isFold || !byKey[lk.otherKey]) return;
                    var child = nodeByKey[lk.otherKey];
                    if (!child || child.parentKey !== root.key) return;
                    /* re-parentar para o lado */
                    child.parentKey = side.key;
                    child.edge = lk.edge;
                    child.isFoldEdge = true;
                });
            });

            /* Corrigir edge do lado → root usando bbox (distância mínima de lado) */
            groupNodes.forEach(function(n) {
                if (n.parentKey !== root.key) return;
                var rb = bbox(root.points);
                var nb = bbox(n.points);
                var dR = Math.abs(nb.x0 - rb.x1), dL = Math.abs(nb.x1 - rb.x0);
                var dB = Math.abs(nb.y0 - rb.y1), dT = Math.abs(nb.y1 - rb.y0);
                var dMin = Math.min(dR, dL, dB, dT);
                if (dMin > 20) return;
                if (dMin === dR) n.edge = {x1: rb.x1, y1: rb.y1, x2: rb.x1, y2: rb.y0};
                else if (dMin === dL) n.edge = {x1: rb.x0, y1: rb.y0, x2: rb.x0, y2: rb.y1};
                else if (dMin === dB) n.edge = {x1: rb.x0, y1: rb.y1, x2: rb.x1, y2: rb.y1};
                else                 n.edge = {x1: rb.x1, y1: rb.y0, x2: rb.x0, y2: rb.y0};
            });
        });

        baseRoot.parentKey = null;
        lidRoot.parentKey  = null;
        lidRoot._lidRoot   = true;
        lidNodes.forEach(function(n) { n._isLid = true; });

        /* Remover os painéis da cópia duplicada (outro componente de cada lado) */
        var activeKeys = {};
        baseNodes.forEach(function(n) { activeKeys[n.key] = true; });
        lidNodes.forEach(function(n)  { activeKeys[n.key] = true; });
        for (var i = nodes.length - 1; i >= 0; i--) {
            if (!activeKeys[nodes[i].key]) nodes.splice(i, 1);
        }

        /* foldSign para todos */
        nodes.forEach(function(n) { n.foldSign = -1; });

        /* animGroups: base e lid usam os mesmos números para animarem em paralelo.
           ag 0 — fundos (roots, estáticos)
           ag 1 — lados de ambas as peças
           ag 2 — abas de ambas as peças */
        function assignAnimGroupsForGroup(groupNodes, root) {
            var depth = {}, queue2 = [root.key];
            depth[root.key] = 0;
            while (queue2.length) {
                var cur2 = queue2.shift();
                groupNodes.forEach(function(n) {
                    if (n.parentKey === cur2 && depth[n.key] === undefined) {
                        depth[n.key] = depth[cur2] + 1;
                        queue2.push(n.key);
                    }
                });
            }
            var hasChildren = {};
            groupNodes.forEach(function(n) { if (n.parentKey) hasChildren[n.parentKey] = true; });
            groupNodes.forEach(function(n) {
                var d = depth[n.key] !== undefined ? depth[n.key] : 1;
                if (d === 0) n.animGroup = 0;
                else if (d === 2 && !hasChildren[n.key]) n.animGroup = 1;           /* abas folha — fecham primeiro */
                else if (d === 1 && hasChildren[n.key]) n.animGroup = 2;           /* lados com filhos — fecham depois */
                else n.animGroup = 3;                                                /* resto — último */
            });
        }

        assignAnimGroupsForGroup(baseNodes, baseRoot);
        assignAnimGroupsForGroup(lidNodes,  lidRoot);
    }

    /* ── dispatcher ─────────────────────────────────────────────── */
    var TEMPLATE_MAPPERS = {
        'FEFCO_0200': templateFEFCO_0200,
        'FEFCO_0201': templateFEFCO_0201,
        'FEFCO_0215': templateFEFCO_0215,
        'FEFCO_0216': templateFEFCO_0216,
        'FEFCO_0330': templateFEFCO_0330,
        'FEFCO_0422': templateFEFCO_0422,
        'FEFCO_0425': templateFEFCO_0425,
        'FEFCO_0426': templateFEFCO_0426,
        'FEFCO_0427': templateFEFCO_0427,
        'FEFCO_0473': templateFEFCO_0473,
        'FEFCO_04XX': templateFEFCO_04XX,
        'GENERIC':    templateGeneric,
    };

    function applyTemplateMapper(nodes, type) {
        var mapper = TEMPLATE_MAPPERS[type] || templateGeneric;
        mapper(nodes);
        nodes.forEach(function (n) {
            if (n.foldSign  === undefined) n.foldSign  = -1;
            if (n.animGroup === undefined) n.animGroup = 0;
        });
    }

    /* ── entrada pública ────────────────────────────────────────── */
    function build(text, type) {
        var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        if (doc.querySelector('parsererror')) throw new Error('SVG inválido');

        var meta = {};
        var metaEl = doc.querySelector('metadata');
        if (metaEl) { try { meta = JSON.parse(metaEl.textContent.trim()); } catch (e) { meta = {}; } }

        var coloredSegs;
        try { coloredSegs = parseColoredLines(doc); }
        catch (e) { throw new Error('Formato SVG não suportado: ' + e.message); }

        if (coloredSegs.red.length + coloredSegs.blue.length === 0)
            throw new Error('SVG sem segmentos coloridos (red/blue)');

        var graph    = buildGraph(coloredSegs);
        var gb       = bbox(graph.verts);
        var hEdges   = buildHalfEdges(graph);
        var rawFaces = findFaces(hEdges, graph.verts);
        var good     = filterFaces(rawFaces, gb);
        if (!good.length) throw new Error('Nenhum painel extraído pelo DCEL');

        var panels = assignKeys(good);
        var nodes  = buildFoldTree(panels, hEdges, graph.verts);

        var boxType = type || (meta && meta.box_type) || 'GENERIC';
        applyTemplateMapper(nodes, boxType);

        /* unidade px/mm */
        var unit = 1;
        if (meta.length && nodes.length) {
            var bb = bbox(nodes[0].points);
            var pxBig = Math.max(bb.w, bb.h);
            var mmBig = Math.max(meta.length, meta.width || meta.length);
            if (pxBig > 0 && mmBig > 0) unit = pxBig / mmBig;
        }

        /* root = nó com parentKey==null após TemplateMapper.
           Para caixas de 2 peças (_lidRoot), preferir a base (sem _lidRoot). */
        var roots = nodes.filter(function(n) { return n.parentKey == null; });
        var trueRoot = roots.filter(function(n) { return !n._lidRoot; })[0] || roots[0] || nodes[0];

        /* Renumerar panel_N em BFS order — panel_0 = root */
        (function reorder() {
            var oldToNew = {}, counter = 0, queue = [trueRoot.key], vis = {};
            vis[trueRoot.key] = true;
            while (queue.length) {
                var cur = queue.shift();
                oldToNew[cur] = 'panel_' + (counter++);
                nodes.forEach(function(n) {
                    if (n.parentKey === cur && !vis[n.key]) { vis[n.key] = true; queue.push(n.key); }
                });
            }
            nodes.forEach(function(n) { if (!oldToNew[n.key]) oldToNew[n.key] = 'panel_' + (counter++); });
            nodes.forEach(function(n) {
                n.key = oldToNew[n.key];
                if (n.parentKey !== null) n.parentKey = oldToNew[n.parentKey] || n.parentKey;
            });
            trueRoot = nodes.filter(function(n) { return n.parentKey == null; })[0] || nodes[0];
        }());

        return { meta: meta, unit: unit, rootKey: trueRoot.key, type: boxType, nodes: nodes };
    }

    function parse(url, type) {
        return fetch(url)
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
            .then(function (text) { return build(text, type); });
    }

    root.DielineParser = { parse: parse, build: build, _bbox: bbox };

}(window));
