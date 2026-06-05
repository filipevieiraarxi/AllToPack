/* ================================================================
   AllToPack — dieline_parser.js   (v4 — polígonos genéricos)

   Lê um SVG de dieline e INFERE a árvore de dobras. Cada painel é um
   POLÍGONO 2D (lista de pontos). Um <rect> é só um polígono de 4 cantos,
   por isso a v4 é retro-compatível com os dieline rectangulares.

   Convenção do SVG:
     <metadata>           → JSON opcional { box_type, length, width, height }
     <g id="cut_lines">   → cada painel (face). Aceita:
                              <rect id="XXX_panel" .../>
                              <polygon id="XXX_panel" points="x,y x,y ..."/>
                            attrs opcionais:
                              data-root="1"        → marca o painel base
                              data-fold-angle="90" → ângulo da dobra sobre o pai
     <g id="fold_lines">  → cada <line> é uma aresta de dobra. O parser
                            descobre, por adjacência geométrica, que dois
                            painéis essa linha liga (um LADO de cada polígono
                            coincide com a linha).

   Devolve:
   {
     meta, unit, rootKey,
     nodes: [{
       key, id, parentKey|null, angle,
       points: [{x,y}, ...],      // polígono em coords SVG
       edge:   {x1,y1,x2,y2}|null // aresta de dobra com o pai (coords SVG)
     }]
   }
   ================================================================ */
(function (root) {
    'use strict';

    var EPS = 1.5; /* tolerância (px) para pontos/arestas coincidentes */

    function num(el, attr, def) {
        var v = el.getAttribute(attr);
        return v === null || v === '' ? (def || 0) : parseFloat(v);
    }

    function near(a, b) { return Math.abs(a - b) <= EPS; }

    /* ── pontos de um painel (rect ou polygon) ── */
    function rectPoints(el) {
        var x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
        return [
            { x: x,     y: y },
            { x: x + w, y: y },
            { x: x + w, y: y + h },
            { x: x,     y: y + h },
        ];
    }
    function polygonPoints(el) {
        var raw = (el.getAttribute('points') || '').trim();
        if (!raw) return [];
        /* "x1,y1 x2,y2" ou "x1 y1 x2 y2" */
        var nums = raw.split(/[\s,]+/).map(parseFloat).filter(function (n) { return !isNaN(n); });
        var pts = [];
        for (var i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
        return pts;
    }

    /* lados (arestas) de um polígono, como segmentos {x1,y1,x2,y2} */
    function polyEdges(points) {
        var edges = [];
        for (var i = 0; i < points.length; i++) {
            var a = points[i], b = points[(i + 1) % points.length];
            edges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        }
        return edges;
    }

    /* colinearidade ponto-segmento e sobreposição → "a mesma aresta" */
    function cross(ax, ay, bx, by) { return ax * by - ay * bx; }
    function colinear(seg, px, py) {
        var dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
        return Math.abs(cross(dx, dy, px - seg.x1, py - seg.y1)) <= EPS * Math.max(1, Math.hypot(dx, dy));
    }
    function projT(seg, px, py) {
        var dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
        var len2 = dx * dx + dy * dy || 1;
        return ((px - seg.x1) * dx + (py - seg.y1) * dy) / len2;
    }
    /* Dois segmentos coincidem (mesma reta + sobreposição não-trivial). */
    function sameEdge(a, b) {
        if (!colinear(a, b.x1, b.y1) || !colinear(a, b.x2, b.y2)) return false;
        var tb1 = projT(a, b.x1, b.y1), tb2 = projT(a, b.x2, b.y2);
        var lo = Math.max(0, Math.min(tb1, tb2));
        var hi = Math.min(1, Math.max(tb1, tb2));
        return (hi - lo) > (EPS / Math.max(1, Math.hypot(a.x2 - a.x1, a.y2 - a.y1)));
    }

    /* O lado do polígono que coincide com a linha de dobra. */
    function foldTouchesPanel(fold, panel) {
        var edges = polyEdges(panel.points);
        for (var i = 0; i < edges.length; i++) {
            if (sameEdge(fold, edges[i])) return edges[i];
        }
        return null;
    }
    /* aresta partilhada entre dois painéis (o lado do "child") */
    function sharedEdge(child, parent) {
        var ce = polyEdges(child.points), pe = polyEdges(parent.points);
        for (var i = 0; i < ce.length; i++) {
            for (var j = 0; j < pe.length; j++) {
                if (sameEdge(ce[i], pe[j])) return ce[i];
            }
        }
        return null;
    }

    function bbox(points) {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        points.forEach(function (p) {
            minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        });
        return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: maxX - minX, h: maxY - minY };
    }
    function area(points) {
        var a = 0;
        for (var i = 0; i < points.length; i++) {
            var p = points[i], q = points[(i + 1) % points.length];
            a += p.x * q.y - q.x * p.y;
        }
        return Math.abs(a) / 2;
    }

    function parse(url) {
        return fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.text();
            })
            .then(function (text) { return build(text); });
    }

    function build(text) {
        var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        if (doc.querySelector('parsererror')) throw new Error('SVG inválido');

        /* ── metadata ── */
        var meta = {};
        var metaEl = doc.querySelector('metadata');
        if (metaEl) {
            try { meta = JSON.parse(metaEl.textContent.trim()); } catch (e) { meta = {}; }
        }

        /* ── painéis (rect + polygon) ── */
        var panels = [];
        var cut = doc.getElementById('cut_lines');
        if (cut) {
            var els = cut.querySelectorAll('rect, polygon');
            for (var i = 0; i < els.length; i++) {
                var el = els[i];
                var id = el.getAttribute('id') || ('panel_' + i);
                var pts = el.tagName.toLowerCase() === 'polygon' ? polygonPoints(el) : rectPoints(el);
                if (pts.length < 3) continue;
                panels.push({
                    key: id.replace(/_panel$/, ''),
                    id: id,
                    points: pts,
                    angle: num(el, 'data-fold-angle', 90),
                    isRoot: el.getAttribute('data-root') === '1',
                });
            }
        }
        if (!panels.length) throw new Error('Nenhum painel (<rect>/<polygon>) em #cut_lines');

        /* ── linhas de dobra ── */
        var folds = [];
        var foldGroup = doc.getElementById('fold_lines');
        if (foldGroup) {
            var fl = foldGroup.querySelectorAll('line');
            for (var j = 0; j < fl.length; j++) {
                folds.push({
                    x1: num(fl[j], 'x1'), y1: num(fl[j], 'y1'),
                    x2: num(fl[j], 'x2'), y2: num(fl[j], 'y2'),
                });
            }
        }

        /* ── raiz: data-root, senão "base", senão o painel de maior área ── */
        var rootPanel = panels.filter(function (p) { return p.isRoot; })[0]
            || panels.filter(function (p) { return p.key === 'base'; })[0]
            || panels.slice().sort(function (a, b) { return area(b.points) - area(a.points); })[0];

        /* ── grafo de adjacência via folds ── */
        var byKey = {};
        panels.forEach(function (p) { byKey[p.key] = p; });
        var adj = {};
        panels.forEach(function (p) { adj[p.key] = []; });

        folds.forEach(function (fold) {
            var hits = [];
            panels.forEach(function (p) {
                var e = foldTouchesPanel(fold, p);
                if (e) hits.push({ p: p, edge: e });
            });
            for (var a = 0; a < hits.length; a++) {
                for (var b = a + 1; b < hits.length; b++) {
                    adj[hits[a].p.key].push({ otherKey: hits[b].p.key });
                    adj[hits[b].p.key].push({ otherKey: hits[a].p.key });
                }
            }
        });

        /* ── BFS a partir da raiz → árvore pai/filho ── */
        var nodes = [];
        var seen = {};
        var queue = [rootPanel.key];
        seen[rootPanel.key] = true;
        nodes.push(nodeOf(rootPanel, null, null));

        while (queue.length) {
            var curKey = queue.shift();
            (adj[curKey] || []).forEach(function (link) {
                if (seen[link.otherKey]) return;
                seen[link.otherKey] = true;
                var childPanel = byKey[link.otherKey];
                var childEdge = sharedEdge(childPanel, byKey[curKey]);
                nodes.push(nodeOf(childPanel, curKey, childEdge));
                queue.push(link.otherKey);
            });
        }

        panels.forEach(function (p) {
            if (!seen[p.key] && window.console) {
                console.warn('[dieline] painel "' + p.key + '" sem dobra ligada à raiz — ignorado');
            }
        });

        var unit = estimateUnit(meta, rootPanel);
        return { meta: meta, unit: unit, rootKey: rootPanel.key, nodes: nodes };

        function nodeOf(p, parentKey, edge) {
            return {
                key: p.key, id: p.id,
                parentKey: parentKey,
                angle: p.angle,
                points: p.points,
                edge: edge,
            };
        }
    }

    /* px-por-mm: o bbox do root (em px) corresponde a length×width (mm), em
       qualquer orientação. Emparelhamos {maior px ↔ maior mm} para não
       depender de qual eixo é L ou W. Se não houver metadata, assume 1:1. */
    function estimateUnit(meta, rootPanel) {
        if (meta && meta.length && rootPanel) {
            var bb = bbox(rootPanel.points);
            var pxBig = Math.max(bb.w, bb.h);
            var mmBig = Math.max(meta.length, meta.width || meta.length);
            if (pxBig > 0 && mmBig > 0) return pxBig / mmBig;
        }
        return 1;
    }

    root.DielineParser = { parse: parse, build: build, _bbox: bbox };

}(window));
