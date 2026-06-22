/* ================================================================
   AllToPack — dieline_parser.js   (v8.3 — DCEL + TemplateMapper por tipo)

   Pipeline:
     SVG + Type
      ↓ parseColoredLines   — extrai segmentos por cor de <line>/<path>
      ↓ buildGraph          — snap adaptativo de vértices + T-junctions
      ↓ buildHalfEdges      — construção DCEL
      ↓ findFaces           — extracção de faces planas
      ↓ filterFaces         — remove face exterior + slivers + fantasmas
      ↓ assignKeys          — panel_0…panel_N ordenado por área
      ↓ buildFoldTree       — BFS via twins DCEL, isFoldEdge de linhas azuis
      ↓ TemplateMapper      — enriquece nodes com foldSign + animGroup por tipo

   Formato SVG aceite (Format B):
     <g id="root_group">  ← flat list de <line> e <path>
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
       foldSign: -1|1,      ← added by TemplateMapper
       animGroup: number,   ← ordering key for fold animation (lower = folds first)
     }]
   }
   ================================================================ */

/* ----------------------------------------------------------------
   v4 (formato A — <rect>/<polygon> em #cut_lines) — COMENTADO
   ----------------------------------------------------------------
(function (root) {
    'use strict';
    var EPS = 1.5;
    function num(el, attr, def) { var v = el.getAttribute(attr); return v === null || v === '' ? (def || 0) : parseFloat(v); }
    function near(a, b) { return Math.abs(a - b) <= EPS; }
    function rectPoints(el) { var x = num(el,'x'), y = num(el,'y'), w = num(el,'width'), h = num(el,'height'); return [{x:x,y:y},{x:x+w,y:y},{x:x+w,y:y+h},{x:x,y:y+h}]; }
    function polygonPoints(el) { var raw=(el.getAttribute('points')||'').trim(); if(!raw)return[]; var nums=raw.split(/[\s,]+/).map(parseFloat).filter(function(n){return !isNaN(n);}); var pts=[]; for(var i=0;i+1<nums.length;i+=2)pts.push({x:nums[i],y:nums[i+1]}); return pts; }
    function polyEdges(points) { var edges=[]; for(var i=0;i<points.length;i++){var a=points[i],b=points[(i+1)%points.length]; edges.push({x1:a.x,y1:a.y,x2:b.x,y2:b.y});} return edges; }
    function cross(ax,ay,bx,by){return ax*by-ay*bx;}
    function colinear(seg,px,py){var dx=seg.x2-seg.x1,dy=seg.y2-seg.y1; return Math.abs(cross(dx,dy,px-seg.x1,py-seg.y1))<=EPS*Math.max(1,Math.hypot(dx,dy));}
    function projT(seg,px,py){var dx=seg.x2-seg.x1,dy=seg.y2-seg.y1; var len2=dx*dx+dy*dy||1; return((px-seg.x1)*dx+(py-seg.y1)*dy)/len2;}
    function sameEdge(a,b){if(!colinear(a,b.x1,b.y1)||!colinear(a,b.x2,b.y2))return false; var tb1=projT(a,b.x1,b.y1),tb2=projT(a,b.x2,b.y2); var lo=Math.max(0,Math.min(tb1,tb2)),hi=Math.min(1,Math.max(tb1,tb2)); return(hi-lo)>(EPS/Math.max(1,Math.hypot(a.x2-a.x1,a.y2-a.y1)));}
    function foldTouchesPanel(fold,panel){var edges=polyEdges(panel.points); for(var i=0;i<edges.length;i++){if(sameEdge(fold,edges[i]))return edges[i];} return null;}
    function sharedEdge(child,parent){var ce=polyEdges(child.points),pe=polyEdges(parent.points); for(var i=0;i<ce.length;i++){for(var j=0;j<pe.length;j++){if(sameEdge(ce[i],pe[j]))return ce[i];}} return null;}
    function bbox(points){var minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity; points.forEach(function(p){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}); return{minX:minX,minY:minY,maxX:maxX,maxY:maxY,w:maxX-minX,h:maxY-minY};}
    function area(points){var a=0; for(var i=0;i<points.length;i++){var p=points[i],q=points[(i+1)%points.length]; a+=p.x*q.y-q.x*p.y;} return Math.abs(a)/2;}
    function parse(url){return fetch(url).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.text();}).then(function(text){return build(text);});}
    function build(text){
        var doc=new DOMParser().parseFromString(text,'image/svg+xml');
        if(doc.querySelector('parsererror'))throw new Error('SVG inválido');
        var meta={};
        var metaEl=doc.querySelector('metadata');
        if(metaEl){try{meta=JSON.parse(metaEl.textContent.trim());}catch(e){meta={};}}
        var panels=[];
        var cut=doc.getElementById('cut_lines');
        if(cut){var els=cut.querySelectorAll('rect, polygon'); for(var i=0;i<els.length;i++){var el=els[i]; var id=el.getAttribute('id')||('panel_'+i); var pts=el.tagName.toLowerCase()==='polygon'?polygonPoints(el):rectPoints(el); if(pts.length<3)continue; panels.push({key:id.replace(/_panel$/,''),id:id,points:pts,angle:num(el,'data-fold-angle',90),isRoot:el.getAttribute('data-root')==='1'});}}
        if(!panels.length)throw new Error('Nenhum painel (<rect>/<polygon>) em #cut_lines');
        var folds=[];
        var foldGroup=doc.getElementById('fold_lines');
        if(foldGroup){var fl=foldGroup.querySelectorAll('line'); for(var j=0;j<fl.length;j++){folds.push({x1:num(fl[j],'x1'),y1:num(fl[j],'y1'),x2:num(fl[j],'x2'),y2:num(fl[j],'y2')});}}
        var rootPanel=panels.filter(function(p){return p.isRoot;})[0]||panels.filter(function(p){return p.key==='base';})[0]||panels.slice().sort(function(a,b){return area(b.points)-area(a.points);})[0];
        var byKey={};
        panels.forEach(function(p){byKey[p.key]=p;});
        var adj={};
        panels.forEach(function(p){adj[p.key]=[];});
        folds.forEach(function(fold){var hits=[]; panels.forEach(function(p){var e=foldTouchesPanel(fold,p); if(e)hits.push({p:p,edge:e});}); for(var a=0;a<hits.length;a++){for(var b=a+1;b<hits.length;b++){adj[hits[a].p.key].push({otherKey:hits[b].p.key});adj[hits[b].p.key].push({otherKey:hits[a].p.key});}}});
        var nodes=[];
        var seen={};
        var queue=[rootPanel.key];
        seen[rootPanel.key]=true;
        nodes.push(nodeOf(rootPanel,null,null));
        while(queue.length){var curKey=queue.shift();(adj[curKey]||[]).forEach(function(link){if(seen[link.otherKey])return;seen[link.otherKey]=true;var childPanel=byKey[link.otherKey];var childEdge=sharedEdge(childPanel,byKey[curKey]);nodes.push(nodeOf(childPanel,curKey,childEdge));queue.push(link.otherKey);});}
        panels.forEach(function(p){if(!seen[p.key]&&window.console)console.warn('[dieline] painel "'+p.key+'" sem dobra ligada à raiz — ignorado');});
        var unit=estimateUnit(meta,rootPanel);
        return{meta:meta,unit:unit,rootKey:rootPanel.key,nodes:nodes};
        function nodeOf(p,parentKey,edge){return{key:p.key,id:p.id,parentKey:parentKey,angle:p.angle,points:p.points,edge:edge};}
    }
    function estimateUnit(meta,rootPanel){if(meta&&meta.length&&rootPanel){var bb=bbox(rootPanel.points);var pxBig=Math.max(bb.w,bb.h);var mmBig=Math.max(meta.length,meta.width||meta.length);if(pxBig>0&&mmBig>0)return pxBig/mmBig;}return 1;}
    root.DielineParser={parse:parse,build:build,_bbox:bbox};
}(window));
   ---------------------------------------------------------------- END v4 */

/* ================================================================
   v7 — DCEL genérico (Format B)
   ================================================================ */
(function (root) {
    'use strict';

    /* ── constantes ── */
    var ARC_STEPS = 8;   /* segmentos para aproximar arcos */
    var SLIVER_RATIO = 0.0008; /* faces < 0.08% da bbox total são slivers */

    /* ── utilitários ── */
    function hypot(dx, dy) { return Math.sqrt(dx * dx + dy * dy); }

    function polySignedArea(pts) {
        var a = 0;
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i], q = pts[(i + 1) % pts.length];
            a += p.x * q.y - q.x * p.y;
        }
        return a / 2; /* positivo = CCW em coords matemáticas / CW em SVG Y-down */
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

    /* ── 1. parseColoredLines ──────────────────────────────────── */
    /*  Devolve { red: [{x1,y1,x2,y2}, ...], blue: [...] }         */
    function parseColoredLines(doc) {
        var red = [], blue = [];
        var root_group = doc.getElementById('root_group');
        if (!root_group) throw new Error('SVG sem #root_group');

        var children = root_group.children;
        for (var i = 0; i < children.length; i++) {
            var el = children[i];
            var style = el.getAttribute('style') || '';
            var isRed  = style.indexOf('rgb(255,0,0)')   >= 0;
            var isBlue = style.indexOf('rgb(0,0,255)')   >= 0;
            if (!isRed && !isBlue) continue; /* verde ou outro — ignorar */

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

    /* ── parseia um atributo d de <path> em segmentos de linha ── */
    function pathToSegments(d) {
        var segs = [];
        /* tokenize */
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
                /* M pode ser seguido de coordenadas implícitas de linha */
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
                /* C, S, Q, T — skip parameters (3, 2, 2, 1 pares) */
                var skipPairs = { c: 3, s: 2, q: 2, t: 1 }[cmd.toLowerCase()];
                if (skipPairs) {
                    var abs3 = cmd === cmd.toUpperCase();
                    var pairs = skipPairs;
                    var lastX = cx, lastY = cy;
                    for (var p = 0; p < pairs && i < tokens.length && !isNaN(parseFloat(tokens[i])); p++) {
                        lastX = abs3 ? nextNum() : cx + nextNum();
                        lastY = abs3 ? nextNum() : cy + nextNum();
                    }
                    /* linha directa ao ponto final como aproximação */
                    if (hypot(lastX - cx, lastY - cy) > 1e-4)
                        segs.push({ x1: cx, y1: cy, x2: lastX, y2: lastY });
                    cx = lastX; cy = lastY;
                }
            }
        }
        return segs;
    }

    /* ── arco SVG → segmentos rectos ── */
    function arcToSegments(x1, y1, rx, ry, xRot, lgArc, sweep, x2, y2) {
        var segs = [];
        if (hypot(x2 - x1, y2 - y1) < 1e-4) return segs;
        if (rx < 1e-4 || ry < 1e-4) {
            segs.push({ x1: x1, y1: y1, x2: x2, y2: y2 });
            return segs;
        }
        /* conversão endpoint → centro (SVG spec §B.2.4) */
        var phi = xRot * Math.PI / 180;
        var cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
        var mx = (x1 - x2) / 2, my = (y1 - y2) / 2;
        var x1p =  cosPhi * mx + sinPhi * my;
        var y1p = -sinPhi * mx + cosPhi * my;
        var x1p2 = x1p * x1p, y1p2 = y1p * y1p;
        var rx2 = rx * rx, ry2 = ry * ry;
        /* ajustar raios se necessário */
        var lambda = x1p2 / rx2 + y1p2 / ry2;
        if (lambda > 1) { lambda = Math.sqrt(lambda); rx *= lambda; ry *= lambda; rx2 = rx * rx; ry2 = ry * ry; }
        var num = Math.max(0, rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2);
        var den = rx2 * y1p2 + ry2 * x1p2;
        var sq = (lgArc === sweep ? -1 : 1) * Math.sqrt(num / (den || 1));
        var cxp =  sq * rx * y1p / ry;
        var cyp = -sq * ry * x1p / rx;
        var cx0 = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
        var cy0 = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
        /* ângulos de início e fim */
        function angle(ux, uy, vx, vy) {
            var d = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
            if (d < 1e-10) return 0;
            var c = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / d));
            return (ux * vy - uy * vx < 0 ? -1 : 1) * Math.acos(c);
        }
        var theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
        var dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
        if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
        if ( sweep && dTheta < 0) dTheta += 2 * Math.PI;

        var steps = Math.max(2, ARC_STEPS);
        var px = x1, py = y1;
        for (var s = 1; s <= steps; s++) {
            var t = theta1 + dTheta * s / steps;
            /* no último step usar o endpoint exacto declarado no SVG para evitar
               acumulação de erros de floating-point que quebram o DCEL */
            var nx = (s === steps) ? x2 : cosPhi * rx * Math.cos(t) - sinPhi * ry * Math.sin(t) + cx0;
            var ny = (s === steps) ? y2 : sinPhi * rx * Math.cos(t) + cosPhi * ry * Math.sin(t) + cy0;
            if (hypot(nx - px, ny - py) > 1e-4) segs.push({ x1: px, y1: py, x2: nx, y2: ny });
            px = nx; py = ny;
        }
        return segs;
    }

    /* ── 2. buildGraph ─────────────────────────────────────────── */
    /*  snap adaptativo + resolução de T-junctions                  */
    function buildGraph(coloredSegs) {
        var allSegs = [];
        coloredSegs.red.forEach(function (s) { allSegs.push({ seg: s, isFold: false }); });
        coloredSegs.blue.forEach(function (s) { allSegs.push({ seg: s, isFold: true }); });

        /* calcular snap a partir do bbox global */
        var allPts = [];
        allSegs.forEach(function (e) {
            allPts.push(e.seg.x1, e.seg.y1, e.seg.x2, e.seg.y2);
        });
        var xs = allPts.filter(function (_, i) { return i % 2 === 0; });
        var ys = allPts.filter(function (_, i) { return i % 2 === 1; });
        var spanX = Math.max.apply(null, xs) - Math.min.apply(null, xs);
        var spanY = Math.max.apply(null, ys) - Math.min.apply(null, ys);
        var SNAP = Math.min(6, Math.max(0.5, Math.min(spanX, spanY) * 0.002));

        /* ── snap de vértices ── */
        var verts = [];
        function snapVert(x, y) {
            for (var i = 0; i < verts.length; i++) {
                if (hypot(verts[i].x - x, verts[i].y - y) <= SNAP) return i;
            }
            verts.push({ x: x, y: y });
            return verts.length - 1;
        }

        /* edges: { a: idxV, b: idxV, isFold: bool } */
        var edges = [];
        allSegs.forEach(function (e) {
            var a = snapVert(e.seg.x1, e.seg.y1);
            var b = snapVert(e.seg.x2, e.seg.y2);
            if (a !== b) edges.push({ a: a, b: b, isFold: e.isFold });
        });

        /* ── colapso de CUTs muito curtos nos cantos dos folds ──────
           Segmentos vermelhos (CUT) curtos cujos dois endpoints são
           exclusivamente endpoints de folds (azuis) são artefactos de
           digitalização. Colapsamos esses CUTs unindo os vértices. */
        var FOLD_CORNER_SNAP = Math.min(20, SNAP * 5);
        (function collapseShortCutsBetweenFoldEndpoints() {
            var foldEndpts = {};
            edges.forEach(function (e) {
                if (e.isFold) { foldEndpts[e.a] = true; foldEndpts[e.b] = true; }
            });
            /* union-find acumulativo — uma única passagem */
            var parent = [];
            for (var i = 0; i < verts.length; i++) parent[i] = i;
            function find(v) {
                while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v]; }
                return v;
            }
            var merged = false;
            edges.forEach(function (e) {
                if (e.isFold) return;
                var len = hypot(verts[e.a].x - verts[e.b].x, verts[e.a].y - verts[e.b].y);
                if (len > FOLD_CORNER_SNAP) return;
                var ra = find(e.a), rb = find(e.b);
                if (ra === rb) return;
                if (!foldEndpts[e.a] || !foldEndpts[e.b]) return;
                /* Desempate geométrico: manter o vértice que, como endpoint das
                   arestas de fold adjacentes da OUTRA ponta, produz linhas mais
                   rectas. Medimos o erro como a distância perpendicular acumulada
                   dos outros endpoints à direcção do fold se fosse um segmento
                   puro do outro endpoint ao candidato. Mínimo erro → ganha. */
                function foldErrorAt(v, candidateIdx) {
                    var err = 0;
                    edges.forEach(function(x) {
                        if (!x.isFold) return;
                        var atV = (x.a === v || x.b === v);
                        if (!atV) return;
                        var other = (x.a === v) ? x.b : x.a;
                        /* Ao mover v para candidateIdx, a aresta vai de verts[other] a verts[candidateIdx].
                           Comparar com a direcção da aresta original (other→v). */
                        var dx1 = verts[v].x - verts[other].x, dy1 = verts[v].y - verts[other].y;
                        var dx2 = verts[candidateIdx].x - verts[other].x, dy2 = verts[candidateIdx].y - verts[other].y;
                        var l1 = hypot(dx1, dy1) || 1;
                        /* cross product / l1 = distância lateral */
                        err += Math.abs(dx1 * dy2 - dy1 * dx2) / l1;
                    });
                    return err;
                }
                var errA = foldErrorAt(e.a, e.b) + foldErrorAt(e.b, e.a);  /* se mantivermos ra */
                var errB = foldErrorAt(e.b, e.a) + foldErrorAt(e.a, e.b);  /* se mantivermos rb */
                /* manter ra: os folds de e.b passam a usar ra → erro foldErrorAt(e.b, ra=e.a)
                   manter rb: os folds de e.a passam a usar rb=e.b → erro foldErrorAt(e.a, e.b) */
                var errKeepA = foldErrorAt(e.b, e.a); /* erro de mover e.b → posição de ra=e.a */
                var errKeepB = foldErrorAt(e.a, e.b); /* erro de mover e.a → posição de rb=e.b */
                var keep = (errKeepA <= errKeepB) ? ra : rb;
                var drop = (errKeepA <= errKeepB) ? rb : ra;
                parent[drop] = keep;
                merged = true;
            });
            if (!merged) return;
            edges = edges.map(function (e) {
                return { a: find(e.a), b: find(e.b), isFold: e.isFold };
            }).filter(function (e) { return e.a !== e.b; });
        })();

        /* ── T-junction: vértice sobre aresta ── */
        edges = resolveT(edges, verts, SNAP);

        /* ── remover duplicados ── */
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
        var changed = true;
        var maxIter = 10;
        while (changed && maxIter-- > 0) {
            changed = false;
            var newEdges = [];
            for (var i = 0; i < edges.length; i++) {
                var e = edges[i];
                var va = verts[e.a], vb = verts[e.b];
                var dx = vb.x - va.x, dy = vb.y - va.y;
                var len = hypot(dx, dy);
                if (len < 1e-6) { newEdges.push(e); continue; }
                /* encontrar vértices que caem sobre esta aresta */
                var splits = [];
                for (var j = 0; j < verts.length; j++) {
                    if (j === e.a || j === e.b) continue;
                    var vj = verts[j];
                    /* distância ponto-reta */
                    var t = ((vj.x - va.x) * dx + (vj.y - va.y) * dy) / (len * len);
                    if (t <= 0 || t >= 1) continue;
                    var px = va.x + t * dx, py = va.y + t * dy;
                    if (hypot(vj.x - px, vj.y - py) <= SNAP) {
                        splits.push({ t: t, idx: j });
                    }
                }
                if (!splits.length) { newEdges.push(e); continue; }
                /* ordenar por t e dividir aresta */
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
        var halfEdges = []; /* [{vert, twin, next, face, isFold}] */

        /* construir adjacência por vértice */
        var adjV = []; /* adjV[v] = [idx_halfedge saindo de v] */
        for (var i = 0; i < verts.length; i++) adjV.push([]);

        edges.forEach(function (e) {
            var h1 = halfEdges.length;
            var h2 = h1 + 1;
            halfEdges.push({ vert: e.b, twin: h2, next: -1, face: -1, isFold: e.isFold });
            halfEdges.push({ vert: e.a, twin: h1, next: -1, face: -1, isFold: e.isFold });
            adjV[e.a].push(h1); /* h1: a→b */
            adjV[e.b].push(h2); /* h2: b→a */
        });

        /* ── ligar next: para cada half-edge h (u→v), next = half-edge
           saindo de v com o menor ângulo no sentido horário (SVG Y-down) ── */
        for (var h = 0; h < halfEdges.length; h++) {
            var v = halfEdges[h].vert;          /* chegamos a v */
            var twin = halfEdges[h].twin;        /* h vai de u→v, twin vai de v→u */
            var uVert = halfEdges[twin].vert;    /* u */
            /* ângulo de chegada (de u para v) */
            var arrAng = Math.atan2(verts[v].y - verts[uVert].y, verts[v].x - verts[uVert].x);

            var candidates = adjV[v]; /* half-edges que partem de v */
            var best = -1, bestDelta = Infinity;
            for (var k = 0; k < candidates.length; k++) {
                var cIdx = candidates[k];
                if (cIdx === twin) continue; /* não voltar para u imediatamente */
                var w = halfEdges[cIdx].vert;
                var depAng = Math.atan2(verts[w].y - verts[v].y, verts[w].x - verts[v].x);
                /* delta em sentido anti-horário relativo à chegada invertida */
                var delta = depAng - (arrAng + Math.PI);
                /* normalizar para (0, 2π] — DCEL face do lado esquerdo */
                delta = ((delta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
                if (delta < bestDelta) { bestDelta = delta; best = cIdx; }
            }
            /* se não houver outro candidato (aresta terminal), liga a si próprio
               via twin para garantir que a travessia não fica presa */
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
            /* percorrer ciclo next */
            var pts = [], foldFlags = [];
            var h = start;
            var count = 0;
            while (!visited[h] && count < halfEdges.length) {
                visited[h] = true;
                pts.push(verts[halfEdges[h].vert]);
                foldFlags.push(halfEdges[h].isFold);
                halfEdges[h].face = faces.length;
                h = halfEdges[h].next;
                count++;
            }
            if (pts.length >= 3) {
                var hasFold = foldFlags.some(function (f) { return f; });
                faces.push({ points: pts, halfEdgeStart: start, hasFold: hasFold });
            }
        }
        return faces;
    }

    /* ── 5. filterFaces ────────────────────────────────────────── */
    function filterFaces(faces, globalBB) {
        var totalArea = globalBB.w * globalBB.h;
        var sliverThresh = totalArea * SLIVER_RATIO;

        /* A face exterior tem área assinada positiva em coords SVG (Y-down, CW = outer)
           e é também a face com o maior bbox. */
        var sorted = faces.slice().sort(function (a, b) { return polyArea(b.points) - polyArea(a.points); });

        /* A maior face por área é quase sempre a exterior */
        var outerFace = sorted[0];

        return faces.filter(function (f) {
            if (f === outerFace) return false;
            var a = polyArea(f.points);
            if (a < sliverThresh) return false;
            /* remover faces "fantasma" que abrangem a maioria do bbox global */
            var bb = bbox(f.points);
            if (bb.w > globalBB.w * 0.9 && bb.h > globalBB.h * 0.9) return false;
            return true;
        });
    }

    /* ── 6. assignKeys ─────────────────────────────────────────── */
    function assignKeys(faces) {
        /* ordenar por área decrescente → panel_0 é o maior */
        var sorted = faces.slice().sort(function (a, b) { return polyArea(b.points) - polyArea(a.points); });
        sorted.forEach(function (f, i) { f.key = 'panel_' + i; });
        return sorted;
    }

    /* ── 7. buildFoldTree ──────────────────────────────────────── */
    /*  Usa adjacência DCEL (twin crossing uma aresta azul) para     */
    /*  construir a árvore pai→filho.                                */
    function buildFoldTree(panels, halfEdges, verts) {
        /* mapear face id → panel */
        var faceToPanel = {};
        panels.forEach(function (p) {
            /* p.halfEdgeStart pertence à face do painel */
            faceToPanel[halfEdges[p.halfEdgeStart].face] = p;
        });

        /* construir grafo de adjacência entre painéis via half-edges */
        /* adj[key] = [{otherKey, edge, isFold}] */
        var adj = {};
        panels.forEach(function (p) { adj[p.key] = []; });

        /* Para cada half-edge h que pertence a uma face de painel,
           o twin pertence à face adjacente. Se isFold → vinco. */
        for (var h = 0; h < halfEdges.length; h++) {
            var he = halfEdges[h];
            if (he.face < 0) continue;
            var pA = faceToPanel[he.face];
            if (!pA) continue;
            var twin = halfEdges[he.twin];
            if (twin.face < 0) continue;
            var pB = faceToPanel[twin.face];
            if (!pB || pB === pA) continue;

            var va = verts[twin.vert]; /* he: a→b, so he.vert = b */
            var vb = verts[he.vert];
            var isFold = he.isFold;

            /* Se já existe ligação pA→pB, tentar estender a aresta de fold
               caso a nova aresta seja colinear (fold line partido pelo gap de corte). */
            var existingLink = null;
            for (var li = 0; li < adj[pA.key].length; li++) {
                if (adj[pA.key][li].otherKey === pB.key) { existingLink = adj[pA.key][li]; break; }
            }
            if (existingLink) {
                /* Só estender se ambas as arestas são fold e colineares */
                if (isFold && existingLink.isFold) {
                    var ex = existingLink.edge;
                    var edx = ex.x2 - ex.x1, edy = ex.y2 - ex.y1;
                    var elen = Math.sqrt(edx*edx + edy*edy) || 1;
                    /* distância perpendicular dos novos pontos à linha existente */
                    var d1 = Math.abs((va.x-ex.x1)*edy - (va.y-ex.y1)*edx) / elen;
                    var d2 = Math.abs((vb.x-ex.x1)*edy - (vb.y-ex.y1)*edx) / elen;
                    if (d1 <= 4 && d2 <= 4) {
                        /* Colinear — estender o span projectando todos os 4 pts na direcção da aresta */
                        var pts4 = [
                            {x: ex.x1, y: ex.y1}, {x: ex.x2, y: ex.y2},
                            {x: va.x,  y: va.y},  {x: vb.x,  y: vb.y}
                        ];
                        var tMin = Infinity, tMax = -Infinity;
                        var tMinPt, tMaxPt;
                        pts4.forEach(function(p) {
                            var t = ((p.x-ex.x1)*edx + (p.y-ex.y1)*edy) / (elen*elen);
                            if (t < tMin) { tMin = t; tMinPt = p; }
                            if (t > tMax) { tMax = t; tMaxPt = p; }
                        });
                        existingLink.edge = { x1: tMinPt.x, y1: tMinPt.y, x2: tMaxPt.x, y2: tMaxPt.y };
                        /* actualizar a ligação inversa também */
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

        /* BFS a partir do maior painel (panel_0).
           Arestas fold (azuis) têm prioridade: processam-se antes das não-fold.
           Isto garante que um painel adjacente a dois vizinhos — um via fold e
           outro via corte — é descoberto pelo caminho correcto (fold). */
        var root = panels[0]; /* já ordenado por área */
        var nodes = [];
        var seen = {};
        /* foldQueue: arestas isFold=true; cutQueue: isFold=false */
        var foldQueue = [{ parentKey: null, key: root.key, edge: null, isFold: false }];
        var cutQueue  = [];
        seen[root.key] = true;

        nodes.push({
            key: root.key, id: root.key,
            parentKey: null, angle: 90,
            points: root.points, edge: null,
            isFoldEdge: false
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
                var item = { parentKey: entry.key, key: link.otherKey, edge: link.edge, isFold: link.isFold };
                if (link.isFold) foldQueue.push(item); else cutQueue.push(item);
            }
        }

        while (foldQueue.length || cutQueue.length) {
            var next = foldQueue.length ? foldQueue.shift() : cutQueue.shift();
            processEntry(next);
        }

        /* painéis não alcançados pela BFS (disconnected) ─────────────────────────
           Estratégia: em vez de fixar sempre na raiz com edge=null, tentamos
           encontrar um painel já conectado adjacente cuja aresta de dobra (fold axis)
           seja colinear com o bordo partilhado entre os dois painéis. Quando isso
           acontece, o painel desligado é um "tab" ou "aba" que deve dobrar em torno
           do mesmo eixo que o irmão vizinho (ex.: abas M422 que partilham o eixo
           x=991.47 com o painel lateral pequeno).

           Colinearidade: dois segmentos são colineares se jazem na mesma linha
           infinita (mesma direcção e intercepto). Para segmentos axis-aligned
           (vertical dx≈0 ou horizontal dy≈0) a verificação é simples. */
        function segAxisKey(e) {
            /* Devolve uma string que identifica a linha infinita do segmento.
               Segmentos verticais: "V:x"; horizontais: "H:y"; outros: "A:slope:intercept" */
            var dx = e.x2 - e.x1, dy = e.y2 - e.y1;
            var ELIN = 0.5; /* tolerância em px para eixo alinhado */
            if (Math.abs(dx) < ELIN) return 'V:' + Math.round((e.x1 + e.x2) / 2 * 10);
            if (Math.abs(dy) < ELIN) return 'H:' + Math.round((e.y1 + e.y2) / 2 * 10);
            var slope = dy / dx;
            var intercept = e.y1 - slope * e.x1;
            return 'A:' + slope.toFixed(4) + ':' + intercept.toFixed(2);
        }

        /* Mapear key → nó já inserido para lookup rápido */
        var nodeByKey = {};
        nodes.forEach(function (n) { nodeByKey[n.key] = n; });

        panels.forEach(function (p) {
            if (seen[p.key]) return;

            /* Tentar attach inteligente ─────────────────────────────── */
            var links = adj[p.key] || [];
            var attached = false;

            for (var li = 0; li < links.length && !attached; li++) {
                var link = links[li];
                if (!seen[link.otherKey]) continue; /* vizinho também desligado */

                var sibNode = nodeByKey[link.otherKey];
                if (!sibNode || sibNode.parentKey === null) continue; /* vizinho é raiz */

                /* A aresta de dobra do irmão (sibling → seu pai) */
                var sibFoldEdge = sibNode.edge;
                if (!sibFoldEdge) continue;

                /* Verificar colinearidade: bordo partilhado e eixo de dobra do irmão */
                var sharedAxisKey = segAxisKey(link.edge);
                var sibFoldAxisKey = segAxisKey(sibFoldEdge);

                if (sharedAxisKey === sibFoldAxisKey) {
                    /* ✓ Colinear: o painel desligado deve dobrar em torno do mesmo eixo
                       que o irmão → attachar ao PAI do irmão com a aresta partilhada */
                    var parentKey = sibNode.parentKey;
                    seen[p.key] = true;
                    attached = true;
                    nodeByKey[p.key] = {
                        key: p.key, id: p.key,
                        parentKey: parentKey, angle: 90,
                        points: p.points, edge: link.edge,
                        isFoldEdge: true
                    };
                    nodes.push(nodeByKey[p.key]);
                }
            }

            if (!attached) {
                /* Fallback: attachar à raiz sem dobra (comportamento anterior) */
                console.warn('[dieline] painel ' + p.key + ' desconectado — attachando à raiz');
                nodeByKey[p.key] = {
                    key: p.key, id: p.key,
                    parentKey: root.key, angle: 90,
                    points: p.points, edge: null,
                    isFoldEdge: false
                };
                nodes.push(nodeByKey[p.key]);
            }
        });

        /* Guardar grafo de adjacência nos nodes para uso no TemplateMapper */
        nodes._adj = adj;

        return nodes;
    }

    /* ══════════════════════════════════════════════════════════════
       FORMAT A — parser para SVGs com #cut_lines / #fold_lines
       (formato gerado pelos generators internos e pelos SVGs estáticos)
       ══════════════════════════════════════════════════════════════ */

    function num(el, attr, def) {
        var v = el.getAttribute(attr);
        return (v === null || v === '') ? (def || 0) : parseFloat(v);
    }

    function rectPoints(el) {
        var x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
        return [{ x: x, y: y }, { x: x + w, y: y }, { x: x + w, y: y + h }, { x: x, y: y + h }];
    }

    function polygonPointsFromEl(el) {
        var raw = (el.getAttribute('points') || '').trim();
        if (!raw) return [];
        var nums = raw.split(/[\s,]+/).map(parseFloat).filter(function (n) { return !isNaN(n); });
        var pts = [];
        for (var i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
        return pts;
    }

    function polyEdgesA(points) {
        var edges = [];
        for (var i = 0; i < points.length; i++) {
            var a = points[i], b = points[(i + 1) % points.length];
            edges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        }
        return edges;
    }

    function cross2(ax, ay, bx, by) { return ax * by - ay * bx; }

    function colinearA(seg, px, py) {
        var dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
        return Math.abs(cross2(dx, dy, px - seg.x1, py - seg.y1)) <= 2 * Math.max(1, Math.hypot(dx, dy));
    }

    function projT(seg, px, py) {
        var dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
        var len2 = dx * dx + dy * dy || 1;
        return ((px - seg.x1) * dx + (py - seg.y1) * dy) / len2;
    }

    function sameEdgeA(a, b) {
        if (!colinearA(a, b.x1, b.y1) || !colinearA(a, b.x2, b.y2)) return false;
        var tb1 = projT(a, b.x1, b.y1), tb2 = projT(a, b.x2, b.y2);
        var lo = Math.max(0, Math.min(tb1, tb2)), hi = Math.min(1, Math.max(tb1, tb2));
        return (hi - lo) > (2 / Math.max(1, Math.hypot(a.x2 - a.x1, a.y2 - a.y1)));
    }

    function sharedEdgeA(child, parent) {
        var ce = polyEdgesA(child.points), pe = polyEdgesA(parent.points);
        for (var i = 0; i < ce.length; i++) {
            for (var j = 0; j < pe.length; j++) {
                if (sameEdgeA(ce[i], pe[j])) return ce[i];
            }
        }
        return null;
    }

    function foldTouchesA(fold, panel) {
        var edges = polyEdgesA(panel.points);
        for (var i = 0; i < edges.length; i++) {
            if (sameEdgeA(fold, edges[i])) return edges[i];
        }
        return null;
    }

    function buildFormatA(doc, meta, type) {
        var panels = [];
        var cut = doc.getElementById('cut_lines');
        if (!cut) throw new Error('Format A: sem #cut_lines');

        var els = cut.querySelectorAll('rect, polygon');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            var id = el.getAttribute('id') || ('panel_' + i);
            var pts = el.tagName.toLowerCase() === 'polygon' ? polygonPointsFromEl(el) : rectPoints(el);
            if (pts.length < 3) continue;
            panels.push({
                key: id.replace(/_panel$/, ''),
                id: id,
                points: pts,
                angle: num(el, 'data-fold-angle', 90),
                isRoot: el.getAttribute('data-root') === '1',
            });
        }
        if (!panels.length) throw new Error('Format A: nenhum painel em #cut_lines');

        /* linhas de dobra */
        var foldLines = [];
        var foldGroup = doc.getElementById('fold_lines');
        if (foldGroup) {
            var fl = foldGroup.querySelectorAll('line');
            for (var j = 0; j < fl.length; j++) {
                foldLines.push({
                    x1: num(fl[j], 'x1'), y1: num(fl[j], 'y1'),
                    x2: num(fl[j], 'x2'), y2: num(fl[j], 'y2'),
                });
            }
        }

        /* root: marcado, ou "base", ou maior área */
        var rootPanel = panels.filter(function (p) { return p.isRoot; })[0]
            || panels.filter(function (p) { return p.key === 'base'; })[0]
            || panels.slice().sort(function (a, b) { return polyArea(b.points) - polyArea(a.points); })[0];

        var byKey = {};
        panels.forEach(function (p) { byKey[p.key] = p; });

        /* adjacência via linhas de dobra */
        var adj = {};
        panels.forEach(function (p) { adj[p.key] = []; });
        foldLines.forEach(function (fold) {
            var hits = [];
            panels.forEach(function (p) {
                var e = foldTouchesA(fold, p);
                if (e) hits.push({ p: p, edge: e });
            });
            for (var a = 0; a < hits.length; a++) {
                for (var b = a + 1; b < hits.length; b++) {
                    adj[hits[a].p.key].push({ otherKey: hits[b].p.key, edge: hits[a].edge });
                    adj[hits[b].p.key].push({ otherKey: hits[a].p.key, edge: hits[b].edge });
                }
            }
        });

        /* BFS */
        var nodes = [];
        var seen = {};
        var queue = [rootPanel.key];
        seen[rootPanel.key] = true;
        nodes.push({
            key: rootPanel.key, id: rootPanel.id,
            parentKey: null, angle: rootPanel.angle,
            points: rootPanel.points, edge: null,
            isFoldEdge: true,
        });
        while (queue.length) {
            var curKey = queue.shift();
            (adj[curKey] || []).forEach(function (link) {
                if (seen[link.otherKey]) return;
                seen[link.otherKey] = true;
                var child = byKey[link.otherKey];
                var edge = sharedEdgeA(child, byKey[curKey]) || link.edge;
                nodes.push({
                    key: child.key, id: child.id,
                    parentKey: curKey, angle: child.angle,
                    points: child.points, edge: edge,
                    isFoldEdge: true,
                });
                queue.push(link.otherKey);
            });
        }

        /* painéis desconectados */
        panels.forEach(function (p) {
            if (!seen[p.key]) {
                nodes.push({
                    key: p.key, id: p.id,
                    parentKey: rootPanel.key, angle: p.angle,
                    points: p.points, edge: null,
                    isFoldEdge: false,
                });
            }
        });

        /* unidade */
        var unit = 1;
        if (meta.length && rootPanel) {
            var bb = bbox(rootPanel.points);
            var pxBig = Math.max(bb.w, bb.h);
            var mmBig = Math.max(meta.length, meta.width || meta.length);
            if (pxBig > 0 && mmBig > 0) unit = pxBig / mmBig;
        }

        /* Template Mapper para Format A — type explícito tem prioridade sobre meta */
        var typeA = type || meta.box_type || 'GENERIC';
        applyTemplateMapper(nodes, typeA);

        return { meta: meta, unit: unit, rootKey: nodes[0].key, type: typeA, nodes: nodes };
    }

    /* ══════════════════════════════════════════════════════════════
       TEMPLATE MAPPER — enriquece nodes com foldSign e animGroup
       baseado no tipo FEFCO da caixa.

       Cada TemplateMapper recebe o array de nodes já ordenados (root
       primeiro) e enriquece CADA node com:
         node.foldSign  = -1 (dobra normal para fora) | +1 (dobra para dentro)
         node.animGroup = inteiro — grupo de animação (0 = primeiro)

       A lógica de foldSign GENÉRICA compara o centróide do filho com o
       do pai relativamente ao eixo de dobra — exactamente o que o engine
       fazia com parentNode. Mantemos isso como base e tipos específicos
       podem sobrescrever para certos painéis.

       animGroup GENÉRICO: baseado na profundidade da árvore (depth) e
       na direcção do eixo de dobra — painéis de "tubo" (paredes) dobram
       antes das abas de topo/fundo.
       ══════════════════════════════════════════════════════════════ */

    /* Utilitário: centróide de um polígono em pixels SVG */
    function polyCentroid(points) {
        var sx = 0, sy = 0, n = points.length || 1;
        for (var i = 0; i < points.length; i++) { sx += points[i].x; sy += points[i].y; }
        return { x: sx / n, y: sy / n };
    }

    /* Calcula foldSign padrão comparando centróides de filho e pai
       relativamente ao eixo de dobra (edge). Devolve -1 ou +1. */
    function defaultFoldSign(node, parentNode) {
        if (!node.edge || !parentNode || !parentNode.points) return -1;
        var e = node.edge;
        var dx = e.x2 - e.x1, dy = e.y2 - e.y1;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        /* normal perpendicular ao eixo (no plano SVG Y-down) */
        var nx = -dy / len, ny = dx / len;
        var cc = polyCentroid(node.points);
        var cp = polyCentroid(parentNode.points);
        /* lado do centróide do filho */
        var childSide  = (cc.x - e.x1) * nx + (cc.y - e.y1) * ny;
        var parentSide = (cp.x - e.x1) * nx + (cp.y - e.y1) * ny;
        /* se o pai estiver no mesmo lado → tab invertida */
        if (childSide >= 0) nx = -nx; /* reorientar nHat para apontar para o filho */
        var parentSideNew = (cp.x - e.x1) * nx + (cp.y - e.y1) * ny;
        return (parentSideNew > 0) ? 1 : -1;
    }

    /* ── TemplateMapper GENÉRICO ──────────────────────────────────
       Funciona para qualquer SVG sem tipo específico.
       animGroup: painéis de depth=1 com eixo maioritariamente vertical
       (tubo lateral) dobram no grupo 0; outros depth=1 no grupo 1;
       depth>=2 no grupo 2. Lid (painel grande sem vinco) fica por último. */
    function templateGeneric(nodes) {
        var nodeByKey = {};
        nodes.forEach(function (n) { nodeByKey[n.key] = n; });

        /* calcular depth de cada node */
        nodes.forEach(function (n) {
            if (n.parentKey == null) {
                n._depth = 0;
            } else {
                var parent = nodeByKey[n.parentKey];
                n._depth = parent ? (parent._depth || 0) + 1 : 1;
            }
        });

        var rootArea = nodes[0] ? polyArea(nodes[0].points) : 1;

        nodes.forEach(function (n) {
            /* root: sem dobra */
            if (n.parentKey == null) {
                n.foldSign  = -1;
                n.animGroup = 0;
                return;
            }

            var parentNode = nodeByKey[n.parentKey] || null;
            n.foldSign = defaultFoldSign(n, parentNode);

            /* eixo de dobra em SVG: û = (dx, dy) normalizado */
            var e = n.edge;
            var dx = e ? (e.x2 - e.x1) : 0;
            var dy = e ? (e.y2 - e.y1) : 0;
            var len = Math.sqrt(dx * dx + dy * dy) || 1;
            var uY = dy / len; /* componente Y de û — se |uY| > 0.7 → eixo vertical */

            var areaRatio = polyArea(n.points) / (rootArea || 1);
            var isLid       = (!n.isFoldEdge) && (areaRatio > 0.30);
            var isVertAxis  = Math.abs(uY) > 0.7;
            var isTopBottom = (n._depth >= 2) && !isLid && (areaRatio < 0.55);

            if (isLid) {
                n.animGroup = 100; /* tampa: sempre por último */
            } else if (isTopBottom) {
                n.animGroup = 50;  /* abas topo/fundo: depois das paredes */
            } else if (n._depth === 1 && n.isFoldEdge && isVertAxis) {
                n.animGroup = 1;   /* paredes laterais (left/right): ligeiramente depois */
            } else {
                n.animGroup = 0;   /* paredes principais (front/back) + glue */
            }
        });
    }

    /* ── TemplateMapper FEFCO_0427 ────────────────────────────────
       Caixa telescópica de encaixe: tampa (lid) separada do corpo.
       A tampa é o maior painel sem vinco de profundidade 1.
       Painéis com profundidade ≥ 2: abas de fixação (fecham antes da tampa).
       Painéis de profundidade 1 com vinco: paredes do corpo/tampa.

       animGroup:
         0  — paredes do corpo (depth=1, isFoldEdge, eixo vertical)
         1  — paredes laterais (depth=1, isFoldEdge, eixo horizontal)
         2  — abas de fixação (depth>=2)
         10 — tampa (lid, depth=1, sem vinco)
    ─────────────────────────────────────────────────────────────── */
    function templateFEFCO_0427(nodes) {
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

            var areaRatio = polyArea(n.points) / (rootArea || 1);
            var e = n.edge;
            var dx = e ? (e.x2 - e.x1) : 0, dy = e ? (e.y2 - e.y1) : 0;
            var len = Math.sqrt(dx * dx + dy * dy) || 1;
            var isVertAxis = Math.abs(dy / len) > 0.7;

            var isLid = (!n.isFoldEdge) && (areaRatio > 0.25);

            if (isLid) {
                n.animGroup = 10;
            } else if (n._depth >= 2) {
                n.animGroup = 2;  /* abas */
            } else if (n._depth === 1 && isVertAxis) {
                n.animGroup = 0;  /* paredes corpo, eixo vertical */
            } else {
                n.animGroup = 1;  /* paredes laterais */
            }
        });
    }

    /* ── TemplateMapper FEFCO_0201 / FEFCO_0200 ──────────────────────
       RSC — todos os folds vão para dentro: foldSign = -1 sempre.
       Única classificação necessária: parede (ag=0) | topo (ag=1) | fundo (ag=2).

       O corpo do tubo é delimitado pelo bbox Y dos painéis com arestas
       verticais longas (as 4 paredes reais). Tudo o que cai dentro desse
       intervalo Y é parede (ag=0); acima é topo (ag=1); abaixo é fundo (ag=2).
    ─────────────────────────────────────────────────────────────── */
    function templateFEFCO_0201(nodes) {
        /* Encontrar os painéis de parede: arestas verticais com comprimento
           próximo do máximo (altura da caixa). Tabs e flanges têm arestas
           verticais mais curtas e são excluídas pelo limiar de 70%. */
        var vertNodes = [];
        nodes.forEach(function (n) {
            if (!n.edge) return;
            var dx = n.edge.x2 - n.edge.x1, dy = n.edge.y2 - n.edge.y1;
            var len = Math.sqrt(dx * dx + dy * dy) || 1;
            if (Math.abs(dy / len) > 0.85) {
                vertNodes.push({ len: len, node: n });
            }
        });
        var maxVertLen = 0;
        vertNodes.forEach(function (v) { if (v.len > maxVertLen) maxVertLen = v.len; });
        var wallNodes = vertNodes.filter(function (v) { return v.len >= maxVertLen * 0.7; });

        /* Delimitar o tubo pelo bbox Y dos painéis de parede. */
        var tubeYmin = 1e9, tubeYmax = -1e9;
        wallNodes.forEach(function (v) {
            v.node.points.forEach(function (p) {
                if (p.y < tubeYmin) tubeYmin = p.y;
                if (p.y > tubeYmax) tubeYmax = p.y;
            });
        });
        if (wallNodes.length === 0) { tubeYmin = 0; tubeYmax = 1e9; }
        var tubeYmid = (tubeYmin + tubeYmax) / 2;

        var nodeByKey = {};
        nodes.forEach(function (n) { nodeByKey[n.key] = n; });
        var adj = nodes._adj || {};

        nodes.forEach(function (n) {
            n.foldSign = -1;
            if (n.parentKey == null) { n.animGroup = 0; return; }
            var cen = polyCentroid(n.points);
            if (cen.y >= tubeYmin && cen.y <= tubeYmax) {
                n.animGroup = 0;
            } else if (cen.y < tubeYmid) {
                n.animGroup = 1;
            } else {
                n.animGroup = 2;
            }
        });

        /* Para cada aba (ag>0), verificar se no grafo DCEL existe uma fold edge
           para uma parede (ag=0). Se sim, o BFS escolheu o pai errado — corrigir
           o parentKey e a edge geometricamente (aresta partilhada nos pontos). */
        function sharedEdge0201(nA, nB) {
            /* Aresta partilhada entre nA e nB — o segmento de nA que é colinear
               com um segmento de nB com maior sobreposição. */
            var ptsA = nA.points, ptsB = nB.points, EPS = 4;
            var bestLen = 0, bestEdge = null;
            for (var i = 0; i < ptsA.length; i++) {
                var a1 = ptsA[i], a2 = ptsA[(i + 1) % ptsA.length];
                var dx = a2.x - a1.x, dy = a2.y - a1.y;
                var segLen = Math.sqrt(dx*dx + dy*dy) || 1;
                for (var j = 0; j < ptsB.length; j++) {
                    var b1 = ptsB[j], b2 = ptsB[(j + 1) % ptsB.length];
                    var c1 = Math.abs((b1.x-a1.x)*dy - (b1.y-a1.y)*dx) / segLen;
                    var c2 = Math.abs((b2.x-a1.x)*dy - (b2.y-a1.y)*dx) / segLen;
                    if (c1 > EPS && c2 > EPS) continue;
                    var t1 = ((b1.x-a1.x)*dx + (b1.y-a1.y)*dy) / (segLen*segLen);
                    var t2 = ((b2.x-a1.x)*dx + (b2.y-a1.y)*dy) / (segLen*segLen);
                    var overlap = (Math.min(Math.max(t1,t2),1) - Math.max(Math.min(t1,t2),0)) * segLen;
                    if (overlap > EPS && overlap > bestLen) {
                        bestLen = overlap;
                        /* Orientar a aresta de modo que o centróide de nA fique
                           do mesmo lado que nos outros nodes (lado positivo da normal).
                           Normal: n = (-dy, dx) / segLen.
                           Se centróide de nA está do lado negativo, inverter. */
                        var nx = -dy / segLen, ny = dx / segLen;
                        var cen = polyCentroid(nA.points);
                        var side = (cen.x - a1.x) * nx + (cen.y - a1.y) * ny;
                        if (side >= 0) {
                            bestEdge = { x1: a1.x, y1: a1.y, x2: a2.x, y2: a2.y };
                        } else {
                            bestEdge = { x1: a2.x, y1: a2.y, x2: a1.x, y2: a1.y };
                        }
                    }
                }
            }
            return bestEdge;
        }

        nodes.forEach(function (n) {
            if (n.animGroup === 0) return;
            var links = adj[n.key] || [];
            for (var i = 0; i < links.length; i++) {
                var link = links[i];
                if (!link.isFold) continue;
                var neighbor = nodeByKey[link.otherKey];
                if (!neighbor || neighbor.animGroup !== 0 || neighbor.parentKey === null) continue;
                if (n.parentKey !== neighbor.key) {
                    n.parentKey = neighbor.key;
                    n.edge = sharedEdge0201(n, neighbor) || link.edge;
                    n.isFoldEdge = true;
                }
                break;
            }
        });
    }

    /* ── TemplateMapper FEFCO_0200 ────────────────────────────────
       Full-overlap: mesma estrutura que 0201, lógica idêntica. */
    function templateFEFCO_0200(nodes) {
        templateFEFCO_0201(nodes);
    }

    /* ── TemplateMapper FEFCO_0216 ────────────────────────────────
       Igual a 0201 mas ag=1 e ag=2 invertidos: fundo fecha antes do topo. */
    function templateFEFCO_0216(nodes) {
        templateFEFCO_0201(nodes);
        nodes.forEach(function(n) {
            if (n.animGroup === 1) n.animGroup = 2;
            else if (n.animGroup === 2) n.animGroup = 1;
        });
    }

    /* ── TemplateMapper FEFCO_0215 ────────────────────────────────
       Igual a 0216 mas p2 é o root — fecha para o lado oposto a p0. */
    function templateFEFCO_0215(nodes) {
        templateFEFCO_0216(nodes);
        var nodeByKey = {};
        nodes.forEach(function(n) { nodeByKey[n.key] = n; });
        var p0 = nodeByKey['panel_0'], p2 = nodeByKey['panel_2'];
        if (p0 && p2) {
            /* calcular aresta partilhada entre p0 e p2 antes de mudar hierarquia */
            var sharedEdge = (function(ptsA, ptsB) {
                var EPS = 4, bestLen = 0, bestEdge = null;
                for (var i = 0; i < ptsA.length; i++) {
                    var a1 = ptsA[i], a2 = ptsA[(i+1) % ptsA.length];
                    var dx = a2.x-a1.x, dy = a2.y-a1.y;
                    var segLen = Math.sqrt(dx*dx+dy*dy) || 1;
                    for (var j = 0; j < ptsB.length; j++) {
                        var b1 = ptsB[j], b2 = ptsB[(j+1) % ptsB.length];
                        var c1 = Math.abs((b1.x-a1.x)*dy-(b1.y-a1.y)*dx)/segLen;
                        var c2 = Math.abs((b2.x-a1.x)*dy-(b2.y-a1.y)*dx)/segLen;
                        if (c1>EPS && c2>EPS) continue;
                        var t1 = ((b1.x-a1.x)*dx+(b1.y-a1.y)*dy)/(segLen*segLen);
                        var t2 = ((b2.x-a1.x)*dx+(b2.y-a1.y)*dy)/(segLen*segLen);
                        var ov = (Math.min(Math.max(t1,t2),1)-Math.max(Math.min(t1,t2),0))*segLen;
                        if (ov > EPS && ov > bestLen) {
                            bestLen = ov;
                            bestEdge = {x1:a1.x,y1:a1.y,x2:a2.x,y2:a2.y};
                        }
                    }
                }
                return bestEdge;
            })(p0.points, p2.points);

            /* p2 torna-se root */
            p2.parentKey = null;
            p2.edge = null;
            /* p11 fica filho de p0 — acompanha p0 */
            /* p0 passa a filho de p2 com a aresta correcta */
            p0.parentKey = 'panel_2';
            p0.edge = sharedEdge;
            p0.angle = 90;
            p0.foldSign = 1;
            p0.animGroup = 3;
        }
    }

    /* ── TemplateMapper FEFCO_04XX ────────────────────────────────
       Família 04XX (caixas telescópicas / display / wrap-around).
       Tampa e corpo são peças separadas geralmente no mesmo SVG.
       Tratar como GENERIC mas com tampa por último. */
    function templateFEFCO_04XX(nodes) {
        templateGeneric(nodes); /* reutilizar lógica genérica */
    }

    /* ── TemplateMapper FEFCO_0422 ────────────────────────────────
       Caixa de uma peça com half-lids horizontais (landscape).
       Estrutura:
         - root: painel base central (L×W)
         - paredes W: depth=1, eixo vertical, área ~25%
         - half-lids ×4: depth=1, eixo horizontal, área ~16%
         - slot-tabs: micro-painéis parasitas (<3%) eliminados
         - abas pontiagudas: polígono >4 vértices, depth≥2

       animGroup:
         0  — root + paredes W (depth=1, eixo vertical)
         2  — tabs (depth≥2, ≤4 vértices)
         3  — abas pontiagudas (depth≥2, >4 vértices)
         10 — half-lids / tampas (depth=1, eixo horizontal, área≥12%)

       foldSign = -1 sempre (todas as dobras para dentro).
    ─────────────────────────────────────────────────────────────── */
    function templateFEFCO_0422(nodes) {
        var nodeByKey = {};
        nodes.forEach(function (n) { nodeByKey[n.key] = n; });

        /* calcular depth */
        nodes.forEach(function (n) {
            n._depth = (n.parentKey == null) ? 0
                     : ((nodeByKey[n.parentKey] || {})._depth || 0) + 1;
        });

        var rootArea = nodes[0] ? polyArea(nodes[0].points) : 1;

        /* Identificar painéis que têm filhos (para proteger tabs funcionais) */
        var hasChildren = {};
        nodes.forEach(function (n) {
            if (n.parentKey != null) hasChildren[n.parentKey] = true;
        });

        /* Remover micro-painéis parasitas: área < 3% do root, sem filhos, depth≥1.
           Estes são criados pelas linhas azuis dos slot-tabs que subdividem
           os painéis W em faces DCEL indesejadas. */
        var kept = nodes.filter(function (n) {
            if (n.parentKey == null) return true; /* nunca remover root */
            var aRatio = polyArea(n.points) / (rootArea || 1);
            if (aRatio < 0.03 && !hasChildren[n.key]) return false;
            return true;
        });
        /* Reescrever nodes in-place */
        nodes.length = 0;
        kept.forEach(function (n) { nodes.push(n); });
        /* Reconstruir nodeByKey após filtragem */
        nodeByKey = {};
        nodes.forEach(function (n) { nodeByKey[n.key] = n; });

        /* Corrigir arestas de dobra fragmentadas: os painéis W têm múltiplos
           segmentos azuis paralelos no eixo x=991/2165 — o BFS escolhe um
           fragmento. Aqui encontramos a aresta de dobra mais longa por eixo:
           projectamos todos os pontos de ambos os polígonos sobre o eixo do
           segmento original e usamos o intervalo de sobreposição completo. */
        function fullSharedEdge(nA, nB) {
            var ptsA = nA.points, ptsB = nB.points, EPS = 4;
            var bestLen = 0, bestEdge = null;

            for (var i = 0; i < ptsA.length; i++) {
                var a1 = ptsA[i], a2 = ptsA[(i + 1) % ptsA.length];
                var dx = a2.x - a1.x, dy = a2.y - a1.y;
                var segLen = Math.sqrt(dx*dx + dy*dy) || 1;
                var ux = dx/segLen, uy = dy/segLen;

                /* Verificar se algum ponto de ptsB está colinear com este segmento */
                var hasColinear = false;
                for (var j = 0; j < ptsB.length; j++) {
                    var b = ptsB[j];
                    var dist = Math.abs((b.x-a1.x)*dy - (b.y-a1.y)*dx) / segLen;
                    if (dist < EPS) { hasColinear = true; break; }
                }
                if (!hasColinear) continue;

                /* Projectar todos os pontos de ambos os polígonos sobre este eixo
                   e encontrar o intervalo de sobreposição */
                var tsA = ptsA.map(function(p) {
                    return (p.x-a1.x)*ux + (p.y-a1.y)*uy;
                });
                var tsB = ptsB.map(function(p) {
                    var dist = Math.abs((p.x-a1.x)*dy - (p.y-a1.y)*dx) / segLen;
                    if (dist < EPS) return (p.x-a1.x)*ux + (p.y-a1.y)*uy;
                    return null;
                }).filter(function(t) { return t !== null; });

                if (tsB.length === 0) continue;

                var minA = Math.min.apply(null, tsA), maxA = Math.max.apply(null, tsA);
                var minB = Math.min.apply(null, tsB), maxB = Math.max.apply(null, tsB);
                var overlapMin = Math.max(minA, minB), overlapMax = Math.min(maxA, maxB);
                var overlap = overlapMax - overlapMin;
                if (overlap <= EPS) continue;

                if (overlap > bestLen) {
                    bestLen = overlap;
                    var p1 = { x: a1.x + ux*overlapMin, y: a1.y + uy*overlapMin };
                    var p2 = { x: a1.x + ux*overlapMax, y: a1.y + uy*overlapMax };
                    /* Orientar para que o centróide de nA fique do lado positivo da normal */
                    var nx = -uy, ny = ux;
                    var cen = polyCentroid(nA.points);
                    var side = (cen.x - p1.x) * nx + (cen.y - p1.y) * ny;
                    bestEdge = side >= 0
                        ? { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }
                        : { x1: p2.x, y1: p2.y, x2: p1.x, y2: p1.y };
                }
            }
            return bestEdge;
        }

        nodes.forEach(function (n) {
            if (n.parentKey == null) return;
            var parentNode = nodeByKey[n.parentKey];
            if (!parentNode) return;
            var better = fullSharedEdge(n, parentNode);
            if (better) n.edge = better;
        });

        /* panel_8 e panel_10 estão ligados a panel_3/panel_4 com aresta horizontal
           em y≈1247 — devem estar ligados a panel_1 (half-lid bottom) exactamente
           como panel_7/panel_9 estão ligados a panel_2 (half-lid top).
           Detectar por: filho de panel_3 ou panel_4, cuja aresta é horizontal
           e partilhada com panel_1. */
        var p1node = nodeByKey['panel_1'];
        if (p1node && p1node.edge) {
            var lidBotY = (p1node.edge.y1 + p1node.edge.y2) / 2;
            nodes.forEach(function(n) {
                if (n.parentKey !== 'panel_3' && n.parentKey !== 'panel_4') return;
                var e = n.edge; if (!e) return;
                var edgeMidY = (e.y1 + e.y2) / 2;
                var isHoriz = Math.abs(e.x2 - e.x1) > Math.abs(e.y2 - e.y1);
                if (!isHoriz) return;
                if (Math.abs(edgeMidY - lidBotY) > 10) return;
                /* esta aresta está na junção com panel_1 → reparentar */
                n.parentKey = 'panel_1';
                n.edge = fullSharedEdge(n, p1node) || e;
            });
        }

        nodes.forEach(function (n) {
            n.foldSign = -1;
        });

        var animMap0422 = {
            'panel_0':  0,
            'panel_1':  0, 'panel_2':  0,
            'panel_7':  0, 'panel_9':  0,
            'panel_8':  0, 'panel_10': 0,
            'panel_3':  1, 'panel_4':  1,
            'panel_11': 1, 'panel_12': 1,
            'panel_5':  1, 'panel_6':  1,
        };
        nodes.forEach(function(n) {
            n.animGroup = animMap0422[n.key] !== undefined ? animMap0422[n.key] : 0;
        });
    }

    /* ── TemplateMapper FEFCO_0425 ────────────────────────────────
       A implementar após validação do M422. */
    function templateFEFCO_0425(nodes) {
        var nodeByKey = {};
        nodes.forEach(function(n) { nodeByKey[n.key] = n; });

        /* panel_6 e panel_5 têm edge de ~13px (arco residual do canto arredondado).
           Corrigir para a sobreposição vertical real entre cada painel e panel_0. */
        function fullSharedEdge0425(nA, nB) {
            var ptsA = nA.points, ptsB = nB.points, EPS = 4;
            var bestLen = 0, bestEdge = null;
            for (var i = 0; i < ptsA.length; i++) {
                var a1 = ptsA[i], a2 = ptsA[(i + 1) % ptsA.length];
                var dx = a2.x - a1.x, dy = a2.y - a1.y;
                var segLen = Math.sqrt(dx*dx + dy*dy) || 1;
                var ux = dx/segLen, uy = dy/segLen;
                var hasColinear = false;
                for (var j = 0; j < ptsB.length; j++) {
                    var b = ptsB[j];
                    if (Math.abs((b.x-a1.x)*dy - (b.y-a1.y)*dx) / segLen < EPS) { hasColinear = true; break; }
                }
                if (!hasColinear) continue;
                var tsA = ptsA.map(function(p) { return (p.x-a1.x)*ux + (p.y-a1.y)*uy; });
                var tsB = ptsB.map(function(p) {
                    if (Math.abs((p.x-a1.x)*dy - (p.y-a1.y)*dx) / segLen >= EPS) return null;
                    return (p.x-a1.x)*ux + (p.y-a1.y)*uy;
                }).filter(function(t) { return t !== null; });
                if (!tsB.length) continue;
                var minA = Math.min.apply(null,tsA), maxA = Math.max.apply(null,tsA);
                var minB = Math.min.apply(null,tsB), maxB = Math.max.apply(null,tsB);
                var oMin = Math.max(minA,minB), oMax = Math.min(maxA,maxB);
                if (oMax - oMin <= EPS) continue;
                if (oMax - oMin > bestLen) {
                    bestLen = oMax - oMin;
                    var p1 = {x: a1.x+ux*oMin, y: a1.y+uy*oMin};
                    var p2 = {x: a1.x+ux*oMax, y: a1.y+uy*oMax};
                    var nx = -uy, ny = ux;
                    var cen = (function(pts){ var sx=0,sy=0; pts.forEach(function(p){sx+=p.x;sy+=p.y;}); return {x:sx/pts.length,y:sy/pts.length}; })(ptsA);
                    var side = (cen.x-p1.x)*nx + (cen.y-p1.y)*ny;
                    bestEdge = side >= 0 ? {x1:p1.x,y1:p1.y,x2:p2.x,y2:p2.y} : {x1:p2.x,y1:p2.y,x2:p1.x,y2:p1.y};
                }
            }
            return bestEdge;
        }

        var root0 = nodeByKey['panel_0'];
        /* p6 e p5 têm pontos sujos (arcos SVG). Substituir por bbox rectangular limpo.
           p6: edge em yMax (y=735, lado que toca o corpo). Orientação direita→esquerda (igual ao DCEL original).
           p5: edge em yMin (y=1892, lado que toca o corpo). Orientação esquerda→direita. */
        var n6 = nodeByKey['panel_6'];
        if (n6) {
            var xMin=Infinity,xMax=-Infinity,yMin=Infinity,yMax=-Infinity;
            n6.points.forEach(function(p){if(p.x<xMin)xMin=p.x;if(p.x>xMax)xMax=p.x;if(p.y<yMin)yMin=p.y;if(p.y>yMax)yMax=p.y;});
            /* yMin real de p6 é 440 (abaixo de p20 que ocupa y=423→440) */
            n6.points = [{x:xMin,y:440},{x:xMax,y:440},{x:xMax,y:yMax},{x:xMin,y:yMax}];
            n6.edge = {x1:xMax, y1:yMax, x2:xMin, y2:yMax};
        }
        var n5 = nodeByKey['panel_5'];
        if (n5) {
            var xMin=Infinity,xMax=-Infinity,yMin=Infinity,yMax=-Infinity;
            n5.points.forEach(function(p){if(p.x<xMin)xMin=p.x;if(p.x>xMax)xMax=p.x;if(p.y<yMin)yMin=p.y;if(p.y>yMax)yMax=p.y;});
            /* yMax real de p5 é 2187 (acima de p19 que ocupa y=2187→2204) */
            n5.points = [{x:xMin,y:yMin},{x:xMax,y:yMin},{x:xMax,y:2187},{x:xMin,y:2187}];
            n5.edge = {x1:xMin, y1:yMin, x2:xMax, y2:yMin};
        }

        /* panel_12 e panel_11 devem seguir panel_1 (parede dir), não panel_6/panel_5.
           Mudar parentKey para panel_1 e corrigir o edge para a sobreposição real. */
        var p1node = nodeByKey['panel_1'];
        ['panel_12', 'panel_11'].forEach(function(key) {
            var n = nodeByKey[key];
            if (!n || !p1node) return;
            n.parentKey = 'panel_1';
            var better = fullSharedEdge0425(n, p1node);
            if (better) n.edge = better;
        });

        /* p19 e p20 são faixas entre linhas azuis duplas horizontais — devem ser
           rectângulos. O DCEL produz pontos degenerados por causa dos arcos.
           Rectificar: bbox limpo nos points + edge horizontal correcto (lado
           do rectângulo mais próximo do centróide do pai). */
        ['panel_19', 'panel_20'].forEach(function(key) {
            var n = nodeByKey[key];
            if (!n || n.points.length < 3) return;
            var pts = n.points;
            var xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
            pts.forEach(function(p) {
                if (p.x < xMin) xMin = p.x;
                if (p.x > xMax) xMax = p.x;
                if (p.y < yMin) yMin = p.y;
                if (p.y > yMax) yMax = p.y;
            });
            n.points = [
                {x: xMin, y: yMin},
                {x: xMax, y: yMin},
                {x: xMax, y: yMax},
                {x: xMin, y: yMax}
            ];
            /* edge = lado horizontal do rectângulo mais próximo do pai */
            var parentNode = nodeByKey[n.parentKey];
            if (parentNode) {
                var pCen = polyCentroid(parentNode.points);
                var distToTop = Math.abs(pCen.y - yMin);
                var distToBot = Math.abs(pCen.y - yMax);
                var edgeY = (distToTop < distToBot) ? yMin : yMax;
                n.edge = {x1: xMin, y1: edgeY, x2: xMax, y2: edgeY};
            }
        });

        templateGeneric(nodes);
        nodes.forEach(function(n) { n.foldSign = -1; });

        /* animGroup — ordem de fecho (após templateGeneric para não ser sobrescrito):
           0: p1, p2 levantam + abas directas
           1: p5, p6 levantam + tudo o que fecham
           2: abas finais de p1/p2 */
        var animMap = {
            'panel_0':  0,
            'panel_1':  0, 'panel_2':  0,
            'panel_9':  0, 'panel_10': 0,
            'panel_12': 0, 'panel_11': 0,
            'panel_5':  1, 'panel_6':  1,
            'panel_19': 1, 'panel_20': 1,
            'panel_7':  1, 'panel_8':  1,
            'panel_13': 1, 'panel_14': 1, 'panel_15': 1, 'panel_16': 1,
            'panel_17': 2, 'panel_18': 2,
            'panel_3':  2, 'panel_4':  2,
        };
        nodes.forEach(function(n) { n.animGroup = animMap[n.key] !== undefined ? animMap[n.key] : 0; });
        /* p13-p16: abas laterais que fecham para dentro */
        ['panel_13', 'panel_14', 'panel_15', 'panel_16'].forEach(function(key) {
            var n = nodeByKey[key];
            if (n) n.foldSign = 1;
        });
        /* p7 e p8 fecham ambos para dentro. O reset global já pôs -1 em todos,
           que é o correcto para p8. p7 tem edge com orientação oposta (DCEL),
           por isso mantém também -1 — o efeito visual é simétrico. */
        var p7n = nodeByKey['panel_7'];
        if (p7n) p7n.foldSign = -1;
        /* p20 dobra para dentro (oposto ao p19) */
        var p20n = nodeByKey['panel_20'];
        if (p20n) p20n.foldSign = 1;
    }

    /* ── dispatcher ───────────────────────────────────────────────── */
    var TEMPLATE_MAPPERS = {
        'FEFCO_0427': templateFEFCO_0427,
        'FEFCO_0201': templateFEFCO_0201,
        'FEFCO_0216': templateFEFCO_0216,
        'FEFCO_0215': templateFEFCO_0215,
        'FEFCO_0200': templateFEFCO_0200,
        'FEFCO_04XX': templateFEFCO_04XX,
        'FEFCO_0422': templateFEFCO_0422,
        'FEFCO_0425': templateFEFCO_0425,
        'GENERIC':    templateGeneric,
    };

    function applyTemplateMapper(nodes, type) {
        var mapper = TEMPLATE_MAPPERS[type] || templateGeneric;
        mapper(nodes);
        /* garantir que todo o node tem os campos, mesmo que o mapper tenha falhado */
        nodes.forEach(function (n) {
            if (n.foldSign  === undefined) n.foldSign  = -1;
            if (n.animGroup === undefined) n.animGroup = 0;
        });
    }

    /* ── entrada pública ────────────────────────────────────────── */
    function build(text, type) {
        var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        if (doc.querySelector('parsererror')) throw new Error('SVG inválido');

        /* metadata opcional */
        var meta = {};
        var metaEl = doc.querySelector('metadata');
        if (metaEl) { try { meta = JSON.parse(metaEl.textContent.trim()); } catch (e) { meta = {}; } }

        /* Detectar formato: A (#cut_lines) vs B (#root_group) */
        if (doc.getElementById('cut_lines')) {
            return buildFormatA(doc, meta, type);
        }

        /* Format B: segmentos coloridos em #root_group */
        var coloredSegs;
        try {
            coloredSegs = parseColoredLines(doc);
        } catch (e) {
            throw new Error('Formato SVG não suportado: ' + e.message);
        }

        if (coloredSegs.red.length + coloredSegs.blue.length === 0)
            throw new Error('SVG sem segmentos coloridos (red/blue)');

        /* 2. grafo */
        var graph = buildGraph(coloredSegs);

        /* bbox global para filtragem */
        var allPts = graph.verts;
        var gb = bbox(allPts);

        /* 3–4. DCEL + faces */
        var halfEdges = buildHalfEdges(graph);
        var rawFaces = findFaces(halfEdges, graph.verts);

        /* 5. filtragem */
        var goodFaces = filterFaces(rawFaces, gb);
        if (!goodFaces.length) throw new Error('Nenhum painel extraído pelo DCEL');

        /* 6. keys */
        var panels = assignKeys(goodFaces);

        /* 7. fold tree */
        var nodes = buildFoldTree(panels, halfEdges, graph.verts);

        /* 8. Template Mapper — foldSign + animGroup por tipo */
        var boxType = type || (meta && meta.box_type) || 'GENERIC';
        applyTemplateMapper(nodes, boxType);

        /* estimativa de unidade px/mm */
        var unit = 1;
        if (meta.length && nodes.length) {
            var rootNode = nodes[0];
            var bb = bbox(rootNode.points);
            var pxBig = Math.max(bb.w, bb.h);
            var mmBig = Math.max(meta.length, meta.width || meta.length);
            if (pxBig > 0 && mmBig > 0) unit = pxBig / mmBig;
        }

        return { meta: meta, unit: unit, rootKey: nodes[0].key, type: boxType, nodes: nodes };
    }

    function parse(url, type) {
        return fetch(url)
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
            .then(function (text) { return build(text, type); });
    }

    root.DielineParser = { parse: parse, build: build, _bbox: bbox };

}(window));
