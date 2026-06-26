/* ================================================================
   AllToPack — dieline_logo2d.js

   Compositor de logos no dieline 2D com reflexo exacto no 3D.

   Arquitectura:
     • Renderiza o SVG do dieline num <canvas> com zoom/pan.
     • O utilizador faz upload de uma imagem → a imagem fica
       associada a um painel específico do dieline (hit-test
       point-in-polygon) e pode ser arrastada dentro do painel.
     • Para cada logo guardamos coords em mm no espaço LOCAL do
       painel (s, d) — o mesmo sistema que o engine 3D usa.
     • No 3D, aplicamos uma CanvasTexture ao mesh do painel usando
       UV calculado a partir de (s, d) e do bbox local do painel.
     • Cotas: 4 linhas do centro do logo aos bordos do painel ativo,
       com valor em mm actualizado em tempo-real ao arrastar.

   Estado por face (front / back):
     logos: [{
       panelKey, side ('outer'|'inner'),
       s, d,          ← centro em coords locais do painel (mm)
       sizeMM,        ← largura do logo em mm
       rot,           ← rotação em graus
       dataUrl,       ← imagem original
       img,           ← HTMLImageElement carregado
     }]

   Integração com engine 3D via window.ATP_DIELINE:
     ATP_DIELINE.getGeo()    → geo com nodes (incluindo _localPts, etc.)
     ATP_DIELINE.getMeshMap() → meshMap { key_outer, key_inner → Mesh }
     ATP_DIELINE.applyLogoTexture(panelKey, side, canvas2d)
                             → aplica CanvasTexture ao mesh
   ================================================================ */
(function () {
    'use strict';

    /* ── DOM ──────────────────────────────────────────────────────── */
    var wrap    = document.getElementById('atp-logo2d-wrap');
    var canvas  = document.getElementById('canvas2dlogo');
    if (!canvas || !wrap) return; /* view não carregada */
    var ctx     = canvas.getContext('2d');

    /* ── Estado ───────────────────────────────────────────────────── */
    var geo      = null;  /* árvore de painéis do parser */
    var svgImg   = null;  /* SVG renderizado como Image para drawImage */
    var svgScale = 1;     /* px-SVG por mm (geo.unit) */

    /* Viewport: pan + zoom sobre o canvas */
    var vp = { ox: 0, oy: 0, scale: 1 };

    /* Face activa: 'front' (outer) ou 'back' (inner) */
    var activeSide = 'front';

    /* Logos por face: { front: [...], back: [...] } */
    var logos = { front: [], back: [] };

    /* Logo seleccionado/arrastado */
    var selected = null;  /* referência ao objecto logo */
    var dragState = null; /* { logo, startCanvasX, startCanvasY, startS, startD } */

    /* Número de mm por unidade SVG-px */
    function pxToMm(px) { return geo ? px / (geo.unit || 1) : px; }
    function mmToPx(mm) { return geo ? mm * (geo.unit || 1) : mm; }

    /* ── Inicialização ────────────────────────────────────────────── */
    function init() {
        setupEvents();
        wireToolbar();
        /* Resize ao mostrar a vista — o wrap está display:none no arranque,
           por isso getBoundingClientRect() devolve 0. Usamos ResizeObserver
           para reagir quando o wrap ganha dimensões reais. */
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(function () { resizeCanvas(); }).observe(wrap);
        } else {
            window.addEventListener('resize', resizeCanvas);
        }
    }

    /* Sincroniza o canvas (px lógicos) com o tamanho CSS actual do wrap.
       CSS diz width:100%; height:100% — o canvas preenche o wrap.
       Chamado pelo ResizeObserver sempre que o wrap muda de tamanho
       (incluindo a primeira vez que a vista fica visível). */
    function resizeCanvas() {
        var w = wrap.offsetWidth;
        var h = wrap.offsetHeight;
        if (w < 4 || h < 4) return; /* wrap ainda não visível */
        if (canvas.width === w && canvas.height === h) return; /* sem mudança */
        canvas.width  = w;
        canvas.height = h;
        fitView();
        draw();
    }

    /* ── Dados do engine 3D ───────────────────────────────────────── */
    /* Chamada pelo engine depois de buildFromGeometry() */
    function onGeoReady(newGeo, svgText) {
        geo = newGeo;
        svgScale = geo.unit || 1;

        /* Criar imagem a partir do SVG text para drawImage */
        var blob = new Blob([svgText], { type: 'image/svg+xml' });
        var url  = URL.createObjectURL(blob);
        var img  = new Image();
        img.onload = function () {
            svgImg = img;
            fitView();
            draw();
            URL.revokeObjectURL(url);
        };
        img.onerror = function () {
            svgImg = null;
            fitView();
            draw();
            URL.revokeObjectURL(url);
        };
        img.src = url;

        /* Limpar logos antigos (rebuild com novas dimensões) */
        logos = { front: [], back: [] };
        selected = null;
        updateLogoInfoPanel();
        applyAllTextures();
    }

    /* Ajustar viewport ao SVG — replica object-fit:contain com padding 24px,
       igual à vista 2D estática para que zoom e posição sejam idênticos. */
    function fitView() {
        if (!canvas.width || !canvas.height) return;
        var svgW, svgH;
        if (svgImg && svgImg.naturalWidth && svgImg.naturalHeight) {
            svgW = svgImg.naturalWidth;
            svgH = svgImg.naturalHeight;
        } else if (geo && geo.nodes && geo.nodes.length) {
            /* fallback: bbox dos nodes antes do SVG carregar */
            var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            geo.nodes.forEach(function (n) {
                n.points.forEach(function (p) {
                    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
                });
            });
            svgW = maxX - minX; svgH = maxY - minY;
        } else { return; }
        if (svgW <= 0 || svgH <= 0) return;
        var pad = 24; /* igual ao padding da .atp-dl-2dview */
        var scaleX = (canvas.width  - pad * 2) / svgW;
        var scaleY = (canvas.height - pad * 2) / svgH;
        vp.scale = Math.min(scaleX, scaleY);
        /* centrar igual ao object-fit:contain */
        vp.ox = (canvas.width  - svgW * vp.scale) / 2;
        vp.oy = (canvas.height - svgH * vp.scale) / 2;
    }

    /* ── Transformações viewport ──────────────────────────────────── */
    /* canvas px → SVG px */
    function canvasToSvg(cx, cy) {
        return { x: (cx - vp.ox) / vp.scale, y: (cy - vp.oy) / vp.scale };
    }
    /* SVG px → canvas px */
    function svgToCanvas(sx, sy) {
        return { x: sx * vp.scale + vp.ox, y: sy * vp.scale + vp.oy };
    }

    /* ── Hit test ─────────────────────────────────────────────────── */
    /* Verifica se ponto (x,y) em SVG-px está dentro do polígono pts */
    function pointInPolygon(x, y, pts) {
        var inside = false;
        for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            var xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    /* Painel sob ponto SVG-px; null se nenhum.
       geo.nodes está ordenado por área DECRESCENTE (panel_0 = maior).
       Percorremos do menor para o maior para que painéis pequenos (abas)
       tenham prioridade sobre os grandes que os cobrem. */
    function panelAtSvg(sx, sy) {
        if (!geo) return null;
        for (var i = geo.nodes.length - 1; i >= 0; i--) {
            var n = geo.nodes[i];
            if (pointInPolygon(sx, sy, n.points)) return n;
        }
        return null;
    }

    /* Logo (da face activa) sob ponto SVG-px; null se nenhum */
    function logoAtSvg(sx, sy) {
        var list = logos[activeSide];
        for (var i = list.length - 1; i >= 0; i--) {
            var lg = list[i];
            if (!lg.img) continue;
            /* centro do logo em SVG-px */
            var ctr = localToSvgPx(lg);
            if (!ctr) continue;
            var halfw = mmToPx(lg.sizeMM) / 2 * vp.scale;   /* metade em canvas px — usamos SVG px */
            var halfwSvg = mmToPx(lg.sizeMM) / 2;
            var aspect = lg.img.naturalHeight / (lg.img.naturalWidth || 1);
            var halfhSvg = halfwSvg * aspect;
            /* teste simplificado: bbox AABB rotacionada — para drag é suficiente */
            var dx = sx - ctr.x, dy = sy - ctr.y;
            var rad = -lg.rot * Math.PI / 180;
            var rx =  dx * Math.cos(rad) - dy * Math.sin(rad);
            var ry =  dx * Math.sin(rad) + dy * Math.cos(rad);
            if (Math.abs(rx) <= halfwSvg * 1.1 && Math.abs(ry) <= halfhSvg * 1.1) return lg;
        }
        return null;
    }

    /* Move um logo para um ponto SVG-px num painel específico.
       Reconverte as coords locais correctamente independentemente de o painel
       ser o mesmo ou diferente — resolve o drag entre painéis e entre faces. */
    function moveLogoToSvgPt(lg, node, svgX, svgY) {
        if (!node || !node._svgToLocal || !node._localPts) return;
        var loc = node._svgToLocal({ x: svgX, y: svgY });
        /* Bbox local do painel (em mm) para clamp */
        var pts = node._localPts;
        var minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
        pts.forEach(function (p) {
            if (p.x < minS) minS = p.x; if (p.x > maxS) maxS = p.x;
            if (p.y < minD) minD = p.y; if (p.y > maxD) maxD = p.y;
        });
        /* Mudar de painel se necessário */
        lg.panelKey = node.key;
        lg.s = Math.max(minS, Math.min(maxS, loc.s));
        lg.d = Math.max(minD, Math.min(maxD, loc.d));
    }

    /* Centro do logo em coords SVG-px (via _localToSvg do painel) */
    function localToSvgPx(lg) {
        if (!geo) return null;
        var node = geo.nodes.filter(function (n) { return n.key === lg.panelKey; })[0];
        if (!node || !node._localToSvg) return null;
        return node._localToSvg(lg.s, lg.d);
    }

    /* ── Desenho ──────────────────────────────────────────────────── */
    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        ctx.save();
        ctx.translate(vp.ox, vp.oy);
        ctx.scale(vp.scale, vp.scale);

        /* SVG de fundo */
        if (svgImg) {
            ctx.drawImage(svgImg, 0, 0);
        } else {
            drawPanelsFallback();
        }

        /* Logos da face activa */
        var list = logos[activeSide];
        for (var i = 0; i < list.length; i++) {
            drawLogo(list[i]);
        }

        ctx.restore();

        /* Cotas para todos os logos da face activa */
        var list = logos[activeSide];
        for (var i = 0; i < list.length; i++) {
            drawDimensions(list[i]);
        }
    }

    /* Fallback: painéis a cinzento claro quando o SVG não carregou */
    function drawPanelsFallback() {
        if (!geo) return;
        geo.nodes.forEach(function (n) {
            if (!n.points || !n.points.length) return;
            ctx.beginPath();
            n.points.forEach(function (p, i) { i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); });
            ctx.closePath();
            ctx.fillStyle = '#e2e8f0';
            ctx.fill();
            ctx.strokeStyle = '#94a3b8';
            ctx.lineWidth = 1 / vp.scale;
            ctx.stroke();
        });
    }

    function drawPanelHighlight(key, fill, stroke, lw) {
        if (!geo) return;
        var node = geo.nodes.filter(function (n) { return n.key === key; })[0];
        if (!node) return;
        ctx.save();
        ctx.beginPath();
        node.points.forEach(function (p, i) { i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); });
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = (lw || 2) / vp.scale;
        ctx.stroke();
        ctx.restore();
    }

    function drawLogo(lg) {
        if (!lg.img) return;
        var ctr = localToSvgPx(lg);
        if (!ctr) return;
        var wPx = mmToPx(lg.sizeMM);
        var aspect = lg.img.naturalHeight / (lg.img.naturalWidth || 1);
        var hPx = wPx * aspect;

        ctx.save();
        ctx.translate(ctr.x, ctr.y);
        ctx.rotate(lg.rot * Math.PI / 180);

        /* Sombra subtil */
        ctx.shadowColor = 'rgba(0,0,0,0.3)';
        ctx.shadowBlur  = 6 / vp.scale;

        ctx.drawImage(lg.img, -wPx / 2, -hPx / 2, wPx, hPx);
        ctx.shadowBlur = 0;

        /* Borda de selecção */
        if (lg === selected) {
            ctx.strokeStyle = '#0d9488';
            ctx.lineWidth   = 2 / vp.scale;
            ctx.strokeRect(-wPx / 2 - 2 / vp.scale, -hPx / 2 - 2 / vp.scale,
                           wPx + 4 / vp.scale, hPx + 4 / vp.scale);

            /* Handles de canto */
            var hw = 6 / vp.scale;
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = '#0d9488';
            ctx.lineWidth = 1.5 / vp.scale;
            [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(function (c) {
                var hx = c[0] * (wPx / 2 + 2 / vp.scale);
                var hy = c[1] * (hPx / 2 + 2 / vp.scale);
                ctx.fillRect(hx - hw/2, hy - hw/2, hw, hw);
                ctx.strokeRect(hx - hw/2, hy - hw/2, hw, hw);
            });
        }
        ctx.restore();
    }

    /* ── Cotas (em canvas px, fora do ctx.scale) ──────────────────── */
    /* Retorna todos os painéis que intersectam a bbox (não-rotacionada) do logo */
    function panelsForLogo(lg) {
        var ctr = localToSvgPx(lg);
        if (!ctr || !lg.img) return [];
        var halfW = mmToPx(lg.sizeMM) / 2;
        var aspect = lg.img.naturalHeight / (lg.img.naturalWidth || 1);
        var halfH = halfW * aspect;
        /* 4 cantos da bbox axis-aligned em SVG-px */
        var corners = [
            { x: ctr.x - halfW, y: ctr.y - halfH },
            { x: ctr.x + halfW, y: ctr.y - halfH },
            { x: ctr.x + halfW, y: ctr.y + halfH },
            { x: ctr.x - halfW, y: ctr.y + halfH },
            ctr, /* centro também */
        ];
        var seen = {};
        var result = [];
        corners.forEach(function (c) {
            var n = panelAtSvg(c.x, c.y);
            if (n && !seen[n.key]) {
                seen[n.key] = true;
                result.push(n);
            }
        });
        /* Garantir que o painel primário do logo está sempre incluído */
        if (!seen[lg.panelKey]) {
            var primary = geo.nodes.filter(function (n) { return n.key === lg.panelKey; })[0];
            if (primary) result.unshift(primary);
        }
        return result;
    }

    /* Tight bounding box axis-aligned (SVG-px) do logo rotacionado */
    function logoBboxSvg(lg) {
        var ctr = localToSvgPx(lg);
        if (!ctr || !lg.img) return null;
        var halfW = mmToPx(lg.sizeMM) / 2;
        var aspect = lg.img.naturalHeight / (lg.img.naturalWidth || 1);
        var halfH = halfW * aspect;
        var rad = lg.rot * Math.PI / 180;
        var cos = Math.cos(rad), sin = Math.sin(rad);
        var corners = [
            { x:  halfW, y:  halfH }, { x: -halfW, y:  halfH },
            { x: -halfW, y: -halfH }, { x:  halfW, y: -halfH },
        ].map(function (c) {
            return { x: ctr.x + c.x * cos - c.y * sin,
                     y: ctr.y + c.x * sin + c.y * cos };
        });
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        corners.forEach(function (c) {
            if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
            if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y;
        });
        return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    }

    /* Bbox global (SVG-px) de todos os painéis da caixa */
    function globalDielineBbox() {
        if (!geo) return null;
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        geo.nodes.forEach(function (n) {
            n.points.forEach(function (p) {
                if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
            });
        });
        return (minX === Infinity) ? null : { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    }

    /* Bbox (SVG-px) apenas do painel indicado */
    function panelBboxSvg(panelKey) {
        if (!geo) return null;
        var node = geo.nodes.filter(function (n) { return n.key === panelKey; })[0];
        if (!node || !node.points || !node.points.length) return null;
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        node.points.forEach(function (p) {
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        });
        return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    }

    /* Calcula os 4 extremos direcionais para as cotas do logo.
       Para cada direção, considera apenas painéis cuja banda perpendicular
       ao eixo se sobrepõe ao bbox do logo — assim cotas horizontais só
       alcançam painéis que estão na mesma faixa vertical, e vice-versa.
       A sobreposição exige pelo menos 1px para evitar painéis adjacentes a tocar. */
    function cotaExtremes(logoBbox) {
        if (!geo) return null;
        var EPS = 1; /* px mínimo de sobreposição */
        var extMinX = logoBbox.minX, extMaxX = logoBbox.maxX;
        var extMinY = logoBbox.minY, extMaxY = logoBbox.maxY;

        geo.nodes.forEach(function (n) {
            var pMinX = Infinity, pMinY = Infinity, pMaxX = -Infinity, pMaxY = -Infinity;
            n.points.forEach(function (p) {
                if (p.x < pMinX) pMinX = p.x; if (p.x > pMaxX) pMaxX = p.x;
                if (p.y < pMinY) pMinY = p.y; if (p.y > pMaxY) pMaxY = p.y;
            });
            /* Sobreposição vertical (para cotas esq/dir) */
            var overlapV = Math.min(pMaxY, logoBbox.maxY) - Math.max(pMinY, logoBbox.minY) > EPS;
            /* Sobreposição horizontal (para cotas cima/baixo) */
            var overlapH = Math.min(pMaxX, logoBbox.maxX) - Math.max(pMinX, logoBbox.minX) > EPS;

            if (overlapV) {
                if (pMinX < extMinX) extMinX = pMinX;
                if (pMaxX > extMaxX) extMaxX = pMaxX;
            }
            if (overlapH) {
                if (pMinY < extMinY) extMinY = pMinY;
                if (pMaxY > extMaxY) extMaxY = pMaxY;
            }
        });
        return { minX: extMinX, minY: extMinY, maxX: extMaxX, maxY: extMaxY };
    }

    function drawDimensions(lg) {
        var bbox   = logoBboxSvg(lg);
        if (!bbox) return;
        var ext = cotaExtremes(bbox);
        if (!ext) return;

        var u = geo ? (geo.unit || 1) : 1;
        var dLeft   = Math.max(0, (bbox.minX - ext.minX) / u);
        var dRight  = Math.max(0, (ext.maxX - bbox.maxX) / u);
        var dTop    = Math.max(0, (bbox.minY - ext.minY) / u);
        var dBottom = Math.max(0, (ext.maxY - bbox.maxY) / u);

        var midY = (bbox.minY + bbox.maxY) / 2;
        var midX = (bbox.minX + bbox.maxX) / 2;

        function cp(sx, sy) { return svgToCanvas(sx, sy); }

        /* seta aponta para o logo (from = extremo direcional, to = borde bbox logo) */
        drawDimLine(ctx, cp(ext.minX, midY), cp(bbox.minX, midY), dLeft,   'mm', 'left');
        drawDimLine(ctx, cp(ext.maxX, midY), cp(bbox.maxX, midY), dRight,  'mm', 'right');
        drawDimLine(ctx, cp(midX, ext.minY), cp(midX, bbox.minY), dTop,    'mm', 'top');
        drawDimLine(ctx, cp(midX, ext.maxY), cp(midX, bbox.maxY), dBottom, 'mm', 'bottom');
    }

    function drawDimLine(ctx2, from, to, valueMm, unit, side) {
        var dx = to.x - from.x, dy = to.y - from.y;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len < 8) return;
        var ux = dx / len, uy = dy / len;

        ctx2.save();
        ctx2.setLineDash([4, 3]);
        ctx2.strokeStyle = '#0d9488';
        ctx2.lineWidth = 1.5;
        ctx2.beginPath();
        ctx2.moveTo(from.x, from.y);
        ctx2.lineTo(to.x, to.y);
        ctx2.stroke();
        ctx2.setLineDash([]);

        /* Seta no destino */
        var ar = 7;
        ctx2.beginPath();
        ctx2.moveTo(to.x, to.y);
        ctx2.lineTo(to.x - ar * ux + ar * 0.4 * uy, to.y - ar * uy - ar * 0.4 * ux);
        ctx2.lineTo(to.x - ar * ux - ar * 0.4 * uy, to.y - ar * uy + ar * 0.4 * ux);
        ctx2.closePath();
        ctx2.fillStyle = '#0d9488';
        ctx2.fill();

        /* Label com valor */
        var label = Math.round(valueMm) + ' mm';
        var mx = (from.x + to.x) / 2;
        var my = (from.y + to.y) / 2;
        /* Offset perpendicular para não sobrepor a linha */
        var px = -uy * 14, py = ux * 14;
        ctx2.font = 'bold 11px system-ui,sans-serif';
        ctx2.textAlign = 'center';
        ctx2.textBaseline = 'middle';
        ctx2.fillStyle = '#fff';
        ctx2.fillRect(mx + px - 18, my + py - 9, 36, 18);
        ctx2.fillStyle = '#0f766e';
        ctx2.fillText(label, mx + px, my + py);

        ctx2.restore();
    }

    /* ── Eventos de interacção ────────────────────────────────────── */
    function setupEvents() {
        /* Pan com botão do meio ou arrasto fora dos logos */
        var panning = false, panStart = { x: 0, y: 0 }, panOrig = { ox: 0, oy: 0 };

        canvas.addEventListener('mousedown', function (e) {
            var rect = canvas.getBoundingClientRect();
            var cx = e.clientX - rect.left, cy = e.clientY - rect.top;
            var sp = canvasToSvg(cx, cy);

            /* 1. Logo sob cursor? → iniciar drag */
            var lg = logoAtSvg(sp.x, sp.y);
            if (lg) {
                selected = lg;
                /* Guardar posição SVG-px do centro no início do drag.
                   Durante o drag seguimos o cursor em SVG-px e reconvertemos
                   para o painel que estiver sob o cursor nesse instante. */
                var ctr0 = localToSvgPx(lg);
                dragState = {
                    logo: lg,
                    /* offset do cursor face ao centro do logo em SVG-px */
                    offX: sp.x - (ctr0 ? ctr0.x : sp.x),
                    offY: sp.y - (ctr0 ? ctr0.y : sp.y),
                };
                draw();
                e.preventDefault();
                return;
            }

            /* 2. Clique num painel sem logo */
            var node = panelAtSvg(sp.x, sp.y);
            if (node) {
                if (selected) {
                    /* Limpar todos os painéis pintados antes de mover */
                    clearLogoTexture(selected);
                    moveLogoToSvgPt(selected, node, sp.x, sp.y);
                    updateLogoInfoPanel();
                    applyLogoTexture(selected);
                    draw();
                } else if (window._atpArtworkDataUrl) {
                    /* Sem logo seleccionado mas com imagem carregada → criar aqui */
                    placePanelCenter(node);
                }
                e.preventDefault();
                return;
            }

            /* 3. Clique fora de qualquer painel → deselect */
            if (selected) {
                selected = null;
                updateLogoInfoPanel();
                draw();
            }

            /* 4. Pan */
            if (e.button === 0) {
                panning = true;
                panStart = { x: e.clientX, y: e.clientY };
                panOrig  = { ox: vp.ox, oy: vp.oy };
                canvas.style.cursor = 'grabbing';
            }
        });

        window.addEventListener('mousemove', function (e) {
            if (dragState) {
                var rect = canvas.getBoundingClientRect();
                var cx = e.clientX - rect.left, cy = e.clientY - rect.top;
                var sp = canvasToSvg(cx, cy);
                /* Posição pretendida para o CENTRO do logo em SVG-px */
                var targetX = sp.x - dragState.offX;
                var targetY = sp.y - dragState.offY;
                /* Painel sob o centro pretendido */
                var node = panelAtSvg(targetX, targetY);
                if (node) {
                    moveLogoToSvgPt(dragState.logo, node, targetX, targetY);
                    draw();
                }
                return;
            }
            if (panning) {
                vp.ox = panOrig.ox + (e.clientX - panStart.x);
                vp.oy = panOrig.oy + (e.clientY - panStart.y);
                draw();
            }
        });

        window.addEventListener('mouseup', function () {
            if (dragState) {
                /* Limpar todos os painéis que foram pintados antes do drag e reaplicar */
                clearLogoTexture(dragState.logo);
                updateLogoInfoPanel();
                applyLogoTexture(dragState.logo);
            }
            dragState = null;
            panning = false;
            canvas.style.cursor = 'crosshair';
        });

        /* Zoom com scroll */
        canvas.addEventListener('wheel', function (e) {
            e.preventDefault();
            var rect = canvas.getBoundingClientRect();
            var cx = e.clientX - rect.left, cy = e.clientY - rect.top;
            var factor = e.deltaY < 0 ? 1.12 : 0.89;
            var newScale = Math.max(0.1, Math.min(20, vp.scale * factor));
            /* zoom centrado no cursor */
            vp.ox = cx - (cx - vp.ox) * (newScale / vp.scale);
            vp.oy = cy - (cy - vp.oy) * (newScale / vp.scale);
            vp.scale = newScale;
            draw();
        }, { passive: false });

        /* Click simples: seleccionar painel (sem logo ainda) para mostrar info */
        canvas.addEventListener('click', function (e) {
            /* logoAtSvg tratado no mousedown; aqui só lidamos com click em painel vazio */
            var rect = canvas.getBoundingClientRect();
            var sp = canvasToSvg(e.clientX - rect.left, e.clientY - rect.top);
            var lg = logoAtSvg(sp.x, sp.y);
            if (!lg) {
                /* mostrar qual painel foi clicado para debug / info */
                var node = panelAtSvg(sp.x, sp.y);
                if (node) {
                    /* futuro: highlight informativo */
                }
            }
        });

        window.addEventListener('resize', function () { resizeCanvas(); });
    }

    /* ── Toolbar (frente/verso + zoom) ───────────────────────────── */
    function wireToolbar() {
        function btn(id, fn) { var el = document.getElementById(id); if (el) el.addEventListener('click', fn); }

        btn('logo2d-side-front', function () {
            activeSide = 'front';
            document.getElementById('logo2d-side-front').classList.add('active');
            document.getElementById('logo2d-side-back').classList.remove('active');
            selected = null;
            updateLogoInfoPanel();
            draw();
        });
        btn('logo2d-side-back', function () {
            activeSide = 'back';
            document.getElementById('logo2d-side-back').classList.add('active');
            document.getElementById('logo2d-side-front').classList.remove('active');
            selected = null;
            updateLogoInfoPanel();
            draw();
        });
        btn('logo2d-zoom-in',  function () {
            vp.scale = Math.min(20, vp.scale * 1.2);
            /* re-centrar */
            vp.ox = canvas.width  / 2 - (canvas.width  / 2 - vp.ox) * 1.2;
            vp.oy = canvas.height / 2 - (canvas.height / 2 - vp.oy) * 1.2;
            draw();
        });
        btn('logo2d-zoom-out', function () {
            vp.scale = Math.max(0.1, vp.scale / 1.2);
            vp.ox = canvas.width  / 2 - (canvas.width  / 2 - vp.ox) / 1.2;
            vp.oy = canvas.height / 2 - (canvas.height / 2 - vp.oy) / 1.2;
            draw();
        });
        btn('logo2d-zoom-fit', function () { fitView(); draw(); });
    }

    /* Calcula centro e tamanho inicial para um logo num node específico */
    function logoDefaultForNode(node, img, rot, dataUrl) {
        var pts = node._localPts;
        if (!pts || !pts.length) return null;
        var minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
        pts.forEach(function (p) {
            if (p.x < minS) minS = p.x; if (p.x > maxS) maxS = p.x;
            if (p.y < minD) minD = p.y; if (p.y > maxD) maxD = p.y;
        });
        /* Tamanho inicial: 30% da menor dimensão do painel em mm */
        var panelMinDim = Math.min(maxS - minS, maxD - minD); /* já em mm (localPts em mm) */
        var sizeMM = Math.max(20, Math.round(panelMinDim * 0.3));
        return {
            panelKey: node.key,
            side: activeSide === 'front' ? 'outer' : 'inner',
            s: (minS + maxS) / 2,
            d: (minD + maxD) / 2,
            sizeMM: sizeMM,
            rot: rot || 0,
            dataUrl: dataUrl,
            img: img,
        };
    }

    /* Remove margens transparentes ou de fundo sólido à volta do logo.
       PNG/SVG: corta pixels com alpha ≤ 10.
       JPEG/opaco: detecta cor dos 4 cantos como fundo, tolerância dist² < 400. */
    function trimImage(img, callback) {
        var tw = img.naturalWidth  || img.width;
        var th = img.naturalHeight || img.height;
        if (!tw || !th) { callback(img); return; }
        var tc = document.createElement('canvas');
        tc.width = tw; tc.height = th;
        var tc2 = tc.getContext('2d');
        tc2.drawImage(img, 0, 0);
        var data = tc2.getImageData(0, 0, tw, th).data;
        var hasAlpha = false;
        for (var i = 3; i < data.length; i += 4) {
            if (data[i] < 250) { hasAlpha = true; break; }
        }
        function cval(x, y, ch) { return data[(y * tw + x) * 4 + ch]; }
        var bgR = (cval(0,0,0) + cval(tw-1,0,0) + cval(0,th-1,0) + cval(tw-1,th-1,0)) / 4;
        var bgG = (cval(0,0,1) + cval(tw-1,0,1) + cval(0,th-1,1) + cval(tw-1,th-1,1)) / 4;
        var bgB = (cval(0,0,2) + cval(tw-1,0,2) + cval(0,th-1,2) + cval(tw-1,th-1,2)) / 4;
        function isBg(idx) {
            if (hasAlpha) return data[idx + 3] <= 10;
            var dr = data[idx]-bgR, dg = data[idx+1]-bgG, db = data[idx+2]-bgB;
            return data[idx+3] > 200 && (dr*dr + dg*dg + db*db) < 400;
        }
        var minX = tw, minY = th, maxX = 0, maxY = 0, found = false;
        for (var y = 0; y < th; y++) {
            for (var x = 0; x < tw; x++) {
                if (!isBg((y * tw + x) * 4)) {
                    if (x < minX) minX = x; if (x > maxX) maxX = x;
                    if (y < minY) minY = y; if (y > maxY) maxY = y;
                    found = true;
                }
            }
        }
        if (!found || (minX === 0 && minY === 0 && maxX === tw-1 && maxY === th-1)) {
            callback(img); return;
        }
        var cw = maxX - minX + 1, ch = maxY - minY + 1;
        var out = document.createElement('canvas');
        out.width = cw; out.height = ch;
        out.getContext('2d').drawImage(tc, minX, minY, cw, ch, 0, 0, cw, ch);
        var trimmed = new Image();
        trimmed.onload = function () { callback(trimmed); };
        trimmed.src = out.toDataURL('image/png');
    }

    /* Coloca o logo carregado centrado num node específico.
       Se já existe um logo na face activa, substitui-o (um logo por face). */
    function placePanelCenter(node) {
        if (!window._atpArtworkDataUrl) return;
        var rotEl = document.getElementById('atp-artwork-rot-label');
        var rot = rotEl ? parseInt(rotEl.textContent, 10) || 0 : 0;
        var img = new Image();
        img.onload = function () {
            trimImage(img, function (trimmed) {
                var lg = logoDefaultForNode(node, trimmed, rot, window._atpArtworkDataUrl);
                if (!lg) return;
                /* Remover logos anteriores desta face do 3D e do array */
                logos[activeSide].forEach(function (old) { clearLogoTexture(old); });
                logos[activeSide] = [];
                logos[activeSide].push(lg);
                selected = lg;
                updateLogoInfoPanel();
                applyLogoTexture(lg);
                draw();
            });
        };
        img.src = window._atpArtworkDataUrl;
    }

    /* Coloca uma nova imagem no painel de maior área (panel_0) por omissão.
       Chamado pelo botão "Posicionar no Dieline" no card Artwork. */
    function placeImage(dataUrl, initialRot) {
        if (!geo || !geo.nodes || !geo.nodes.length) return;

        var img = new Image();
        img.onload = function () {
            trimImage(img, function (trimmed) {
                var rootNode = geo.nodes[0];
                var lg = logoDefaultForNode(rootNode, trimmed, initialRot, dataUrl);
                if (!lg) return;
                logos[activeSide].push(lg);
                selected = lg;
                updateLogoInfoPanel();
                applyLogoTexture(lg);
                draw();
            });
        };
        img.src = dataUrl;
    }

    /* Mover logo para o painel mais adequado após arrastar sobre outro painel */
    function reassignPanel(lg) {
        var svgCtr = localToSvgPx(lg);
        if (!svgCtr) return;
        var node = panelAtSvg(svgCtr.x, svgCtr.y);
        if (node && node.key !== lg.panelKey) {
            /* converter coords locais antigas para SVG e depois para o novo painel */
            var newLoc = node._svgToLocal(svgCtr);
            lg.panelKey = node.key;
            lg.s = newLoc.s;
            lg.d = newLoc.d;
        }
    }

    /* ── Remover logo seleccionado (chamado pelo template via removeBtn) ── */
    function removeSelected() {
        if (!selected) return;
        var list = logos[activeSide];
        var idx = list.indexOf(selected);
        if (idx >= 0) {
            clearLogoTexture(selected);
            list.splice(idx, 1);
        }
        selected = null;
        updateLogoInfoPanel();
        draw();
    }

    /* ── Painel de info do logo (cotas numéricas na sidebar) ──────── */
    function updateLogoInfoPanel() {
        var panel = document.getElementById('atp-logo-info-panel');
        var card  = document.getElementById('atp-logo-info-card');
        if (!panel) return;
        if (!selected || !geo) {
            if (card) card.style.display = 'none';
            return;
        }
        if (card) card.style.display = '';
        var node = geo.nodes.filter(function (n) { return n.key === selected.panelKey; })[0];
        if (!node) { if (card) card.style.display = 'none'; return; }

        var bbox   = logoBboxSvg(selected);
        var ext    = bbox ? cotaExtremes(bbox) : null;
        var u = geo ? (geo.unit || 1) : 1;
        var dLeft   = (bbox && ext) ? Math.max(0, (bbox.minX - ext.minX) / u) : 0;
        var dRight  = (bbox && ext) ? Math.max(0, (ext.maxX - bbox.maxX) / u) : 0;
        var dTop    = (bbox && ext) ? Math.max(0, (bbox.minY - ext.minY) / u) : 0;
        var dBottom = (bbox && ext) ? Math.max(0, (ext.maxY - bbox.maxY) / u) : 0;

        panel.innerHTML =
            '<div class="atp-logo-info-cotas">' +
            '<span title="Cima">↑ ' + Math.round(dTop) + ' mm</span>' +
            '<span title="Baixo">↓ ' + Math.round(dBottom) + ' mm</span>' +
            '<span title="Esq.">← ' + Math.round(dLeft)  + ' mm</span>' +
            '<span title="Dir.">→ ' + Math.round(dRight) + ' mm</span>' +
            '</div>';

        /* Sincronizar scaleLabel externo com o tamanho do logo seleccionado */
        var scaleLabel = document.getElementById('atp-artwork-scale-label');
        if (scaleLabel) scaleLabel.textContent = selected.sizeMM + 'mm';
    }

    /* ── Texturas 3D ──────────────────────────────────────────────── */
    /* Gera e aplica texturas para TODOS os painéis que o logo interseta.
       Para cada painel, calcula onde o logo cai nas coords locais desse
       painel e corrige a orientação pelo ângulo relativo entre referenciais. */
    function applyLogoTexture(lg) {
        if (!geo || !window.ATP_DIELINE || !lg.img) return;

        /* Centro do logo em SVG-px — referência partilhada entre painéis */
        var svgCtr = localToSvgPx(lg);
        if (!svgCtr) return;

        var PPM = 4;
        var meshSuffix = (lg.side === 'inner') ? '_inner' : '_outer';
        var logoW = lg.sizeMM * PPM;
        var aspect = lg.img.naturalHeight / (lg.img.naturalWidth || 1);
        var logoH = logoW * aspect;

        /* Todos os painéis que o logo toca (primário + secundários) */
        var nodes = panelsForLogo(lg);
        lg._paintedPanels = {};

        nodes.forEach(function (node) {
            if (!node._localPts || !node._svgToLocal) return;

            var pts = node._localPts;
            var minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
            pts.forEach(function (p) {
                if (p.x < minS) minS = p.x; if (p.x > maxS) maxS = p.x;
                if (p.y < minD) minD = p.y; if (p.y > maxD) maxD = p.y;
            });
            var panelW = maxS - minS;
            var panelH = maxD - minD;
            if (panelW <= 0 || panelH <= 0) return;

            var texW = Math.round(panelW * PPM);
            var texH = Math.round(panelH * PPM);
            var tc = document.createElement('canvas');
            tc.width  = texW;
            tc.height = texH;
            var tc2 = tc.getContext('2d');

            tc2.fillStyle = '#e3d3b8';
            tc2.fillRect(0, 0, texW, texH);

            /* Centro do logo em coords locais DESTE painel */
            var loc = node._svgToLocal(svgCtr);

            /* UV-v do ShapeGeometry (r128, flipY=false):
               u = (s - minS) / panelW  →  canvasX = (s - minS) * PPM
               v = (d - minD) / panelH  →  canvasY = (d - minD) * PPM
               Esta relação é idêntica para root e filhos — os UVs são sempre
               gerados a partir das coords do Shape antes de qualquer rotação.
               Não há inversão de eixo. */
            var logoX = (loc.s - minS) * PPM;
            var logoY = (loc.d - minD) * PPM;
            /* _dvInverted: nHat aponta SVG-cima → UV-v e canvas-Y ficam invertidos.
               A imagem ficaria de cabeça para baixo — scale(1,-1) corrige a orientação
               sem alterar a posição. */
            var totalRot = node._dvInverted
                ? -((lg.rot * Math.PI / 180) - (node._localAngle || 0))
                : (lg.rot * Math.PI / 180) - (node._localAngle || 0);

            tc2.save();
            tc2.translate(logoX, logoY);
            if (node._dvInverted) tc2.scale(1, -1);
            tc2.rotate(totalRot);
            tc2.drawImage(lg.img, -logoW / 2, -logoH / 2, logoW, logoH);
            tc2.restore();

            if (window.ATP_DIELINE.applyLogoTexture) {
                /* Sufixo correcto por painel: depende de qual face é exterior neste painel */
                window.ATP_DIELINE.applyLogoTexture(node.key + meshSuffix, tc);
                lg._paintedPanels[node.key] = meshSuffix;
            }
        });
    }

    function clearLogoTexture(lg) {
        if (!window.ATP_DIELINE || !window.ATP_DIELINE.clearLogoTexture) return;
        /* _paintedPanels: { panelKey: meshSuffix } — sufixo guardado por painel */
        if (lg._paintedPanels) {
            Object.keys(lg._paintedPanels).forEach(function (key) {
                window.ATP_DIELINE.clearLogoTexture(key + lg._paintedPanels[key]);
            });
        } else {
            /* fallback: sufixo genérico pelo lado do logo */
            var wantExterior = (lg.side === 'inner');
            var primaryNode = geo ? geo.nodes.filter(function(n) { return n.key === lg.panelKey; })[0] : null;
            var faceFlipped = primaryNode ? !!primaryNode._faceFlipped : false;
            var meshSuffix = (wantExterior === faceFlipped) ? '_outer' : '_inner';
            window.ATP_DIELINE.clearLogoTexture(lg.panelKey + meshSuffix);
        }
        lg._paintedPanels = {};
    }

    function applyAllTextures() {
        ['front', 'back'].forEach(function (face) {
            logos[face].forEach(function (lg) { applyLogoTexture(lg); });
        });
    }

    /* ── Exportar estado para saveOrderDieline ────────────────────── */
    function exportLogoState() {
        var result = {};
        ['front', 'back'].forEach(function (face) {
            logos[face].forEach(function (lg, idx) {
                var key = (face === 'front' ? '__logo__' : '__logo_back__') + (idx > 0 ? idx : '');

                var aspect = 1;
                if (lg.img && lg.img.naturalWidth) {
                    aspect = lg.img.naturalHeight / lg.img.naturalWidth;
                }

                var entry = {
                    dataUrl:  lg.dataUrl,
                    panelKey: lg.panelKey,
                    side:     lg.side,
                    s:        lg.s,
                    d:        lg.d,
                    sizeMM:   lg.sizeMM,
                    rot:      lg.rot,
                    aspect:   aspect,
                };

                /* Converter coords locais (s,d) → coords SVG-px para o backend.
                   Tenta _localToSvg do node; fallback via geo.unit se disponível. */
                var svgPt = localToSvgPx(lg);
                if (!svgPt && geo && geo.unit) {
                    /* Fallback: recalcular manualmente usando o node do geo */
                    var node = geo.nodes.filter(function(n) { return n.key === lg.panelKey; })[0];
                    if (node && node._localToSvg) {
                        svgPt = node._localToSvg(lg.s, lg.d);
                    }
                }
                if (svgPt && isFinite(svgPt.x) && isFinite(svgPt.y)) {
                    entry.dielineX = svgPt.x;
                    entry.dielineY = svgPt.y;
                    /* Dimensões do logo em SVG-px (sem rotação) para cotas no backend */
                    var u = geo ? (geo.unit || 1) : 1;
                    entry.svgW = lg.sizeMM * u;
                    entry.svgH = lg.sizeMM * aspect * u;
                }
                result[key] = entry;
            });
        });
        return result;
    }

    /* ── API pública ──────────────────────────────────────────────── */
    /* Roda o logo seleccionado (ou todos os logos da face activa se não houver
       selecção) pelo delta em graus. Chamado pelos botões CCW/CW do template. */
    function rotateLogo(deltaDeg) {
        var targets = selected ? [selected] : logos[activeSide];
        if (!targets.length) return;
        targets.forEach(function (lg) {
            lg.rot = ((lg.rot || 0) + deltaDeg + 360) % 360;
        });
        draw();
        targets.forEach(function (lg) { applyLogoTexture(lg); });
    }

    function scaleSelected(deltaMM) {
        if (!selected) return;
        selected.sizeMM = Math.max(5, Math.min(500, selected.sizeMM + deltaMM));
        updateLogoInfoPanel();
        applyLogoTexture(selected);
        draw();
    }

    window.ATP_LOGO2D = {
        onGeoReady:      onGeoReady,
        placeImage:      placeImage,
        removeSelected:  removeSelected,
        exportLogoState: exportLogoState,
        redraw:          draw,
        resizeCanvas:    resizeCanvas,
        rotateLogo:      rotateLogo,
        scaleSelected:   scaleSelected,
    };

    /* Boot imediato */
    init();

})();
