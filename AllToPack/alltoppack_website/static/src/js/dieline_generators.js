/* ================================================================
   AllToPack — dieline_generators.js
   Gera SVG de dieline parametrico a partir de L, W, H (mm).
   Cada funcao devolve uma string SVG pronta para DielineParser.build().
   ================================================================ */
(function (root) {
    'use strict';

    /* ── RSC Regular Slotted Container ──────────────────────────── */
    function rsc(L, W, H) {
        /* Planificacao: glue | front | right | back | left
           Abas de topo e fundo com altura W/2.
           Margem de 20px em torno. */
        var G  = 30;          /* glue flap */
        var T  = W / 2;       /* altura das abas topo/fundo */
        var mx = 20, my = 20; /* margens */

        /* posicoes X de cada parede */
        var x0 = mx + G;           /* front */
        var x1 = x0 + L;           /* right */
        var x2 = x1 + W;           /* back  */
        var x3 = x2 + L;           /* left  */
        var x4 = x3 + W;           /* fim   */

        var yTop  = my;
        var yWall = my + T;
        var yBot  = my + T + H;
        var yEnd  = my + T + H + T;

        var vw = x4 + mx;
        var vh = yEnd + my;

        var lines = [
            /* paredes */
            rect('front_panel',        x0,      yWall, L, H, 'data-root="1"'),
            rect('right_panel',        x1,      yWall, W, H, 'data-fold-angle="90"'),
            rect('back_panel',         x2,      yWall, L, H, 'data-fold-angle="90"'),
            rect('left_panel',         x3,      yWall, W, H, 'data-fold-angle="90"'),
            /* abas topo */
            rect('front_top_panel',    x0,      yTop,  L, T, 'data-fold-angle="90"'),
            rect('right_top_panel',    x1,      yTop,  W, T, 'data-fold-angle="90"'),
            rect('back_top_panel',     x2,      yTop,  L, T, 'data-fold-angle="90"'),
            rect('left_top_panel',     x3,      yTop,  W, T, 'data-fold-angle="90"'),
            /* abas fundo */
            rect('front_bottom_panel', x0,      yBot,  L, T, 'data-fold-angle="90"'),
            rect('right_bottom_panel', x1,      yBot,  W, T, 'data-fold-angle="90"'),
            rect('back_bottom_panel',  x2,      yBot,  L, T, 'data-fold-angle="90"'),
            rect('left_bottom_panel',  x3,      yBot,  W, T, 'data-fold-angle="90"'),
            /* glue */
            rect('glue_panel',         mx,      yWall, G, H, 'data-fold-angle="90"'),
        ];

        var folds = [
            line(x0, yWall, x0, yBot),   /* glue <-> front  */
            line(x1, yWall, x1, yBot),   /* front <-> right */
            line(x2, yWall, x2, yBot),   /* right <-> back  */
            line(x3, yWall, x3, yBot),   /* back  <-> left  */
            /* topo */
            line(x0, yWall, x1, yWall),
            line(x1, yWall, x2, yWall),
            line(x2, yWall, x3, yWall),
            line(x3, yWall, x4, yWall),
            /* fundo */
            line(x0, yBot,  x1, yBot),
            line(x1, yBot,  x2, yBot),
            line(x2, yBot,  x3, yBot),
            line(x3, yBot,  x4, yBot),
        ];

        return svg(vw, vh, 'rsc_regular_slotted', L, W, H, lines, folds);
    }

    /* ── Rollover Hinged Lid ─────────────────────────────────────── */
    function rolloverHingedLid(L, W, H) {
        /* Espinha horizontal: glue | front | base | back | lid | rollover
           base e o root (largura L, altura W).
           front/back = H; lid = L + arredondamento; roll = ~H*0.45 */
        var G    = Math.max(10, Math.round(H * 0.3));  /* glue flap */
        var ROLL = Math.max(8,  Math.round(H * 0.45)); /* rollover  */
        var FLAP = H;                                   /* abas laterais */
        var r    = Math.min(10, Math.round(H * 0.2));  /* raio arred. lid */
        var mx   = 20, my = 20;

        var xGlue  = mx;
        var xFront = xGlue  + G;
        var xBase  = xFront + H;
        var xBack  = xBase  + L;
        var xLid   = xBack  + H;
        var xRoll  = xLid   + L;
        var xEnd   = xRoll  + ROLL;

        var yTop  = my;
        var yWall = my + FLAP;
        var yBot  = my + FLAP + W;
        var yEnd  = my + FLAP + W + FLAP;

        var vw = xEnd + mx;
        var vh = yEnd + my;

        /* lid com canto arredondado no lado direito */
        var lidPts = roundedRightEdge(xLid, yWall, L, W, r);
        /* rollover: strip estreito com canto arredondado */
        var rollPts = roundedRightEdge(xRoll, yWall + r, ROLL, W - 2 * r, r * 0.5);

        var lines = [
            rect('base_panel',              xBase,  yWall, L, W, 'data-root="1"'),
            rect('front_panel',             xFront, yWall, H, W, 'data-fold-angle="90"'),
            rect('back_panel',              xBack,  yWall, H, W, 'data-fold-angle="90"'),
            rect('left_panel',              xBase,  yTop,  L, FLAP, 'data-fold-angle="90"'),
            rect('right_panel',             xBase,  yBot,  L, FLAP, 'data-fold-angle="90"'),
            rect('glue_panel',              xGlue,  yWall, G, W, 'data-fold-angle="90"'),
            polygon('lid_panel',            lidPts,  'data-fold-angle="90"'),
            polygon('roll_panel',           rollPts, 'data-fold-angle="90"'),
            rect('front_top_flap_panel',    xFront, yTop,  H, FLAP, 'data-fold-angle="90"'),
            rect('front_bottom_flap_panel', xFront, yBot,  H, FLAP, 'data-fold-angle="90"'),
            rect('back_top_flap_panel',     xBack,  yTop,  H, FLAP, 'data-fold-angle="90"'),
            rect('back_bottom_flap_panel',  xBack,  yBot,  H, FLAP, 'data-fold-angle="90"'),
            rect('lid_top_flap_panel',      xLid,   yTop,  L, FLAP, 'data-fold-angle="90"'),
            rect('lid_bottom_flap_panel',   xLid,   yBot,  L, FLAP, 'data-fold-angle="90"'),
        ];

        var folds = [
            line(xFront, yWall, xFront, yBot),
            line(xBase,  yWall, xBase,  yBot),
            line(xBack,  yWall, xBack,  yBot),
            line(xLid,   yWall, xLid,   yBot),
            line(xRoll,  yWall, xRoll,  yBot),
            line(xBase,  yWall, xBack,  yWall),   /* base <-> left  */
            line(xBase,  yBot,  xBack,  yBot),    /* base <-> right */
            line(xFront, yWall, xBase,  yWall),   /* front <-> front_top */
            line(xFront, yBot,  xBase,  yBot),
            line(xBack,  yWall, xLid,   yWall),   /* back <-> back_top */
            line(xBack,  yBot,  xLid,   yBot),
            line(xLid,   yWall, xRoll,  yWall),   /* lid <-> lid_top */
            line(xLid,   yBot,  xRoll,  yBot),
        ];

        return svg(vw, vh, 'rollover_hinged_lid', L, W, H, lines, folds);
    }

    /* ── helpers ─────────────────────────────────────────────────── */
    function r2(n) { return Math.round(n * 100) / 100; }

    function rect(id, x, y, w, h, extra) {
        return '<rect id="' + id + '_panel" x="' + r2(x) + '" y="' + r2(y) +
               '" width="' + r2(w) + '" height="' + r2(h) + '" ' + (extra || '') + '/>';
    }
    function polygon(id, pts, extra) {
        var s = pts.map(function (p) { return r2(p.x) + ',' + r2(p.y); }).join(' ');
        return '<polygon id="' + id + '" points="' + s + '" ' + (extra || '') + '/>';
    }
    function line(x1, y1, x2, y2) {
        return '<line x1="' + r2(x1) + '" y1="' + r2(y1) + '" x2="' + r2(x2) + '" y2="' + r2(y2) + '"/>';
    }

    /* retangulo com o lado direito arredondado (aproximacao com 8 pontos) */
    function roundedRightEdge(x, y, w, h, r) {
        r = Math.min(r, h / 2, w / 2);
        var pts = [
            { x: x,         y: y },
            { x: x + w - r, y: y },
        ];
        /* arco superior-direito: 3 pontos */
        for (var i = 1; i <= 3; i++) {
            var a = -Math.PI / 2 + (Math.PI / 2) * (i / 3);
            pts.push({ x: x + w - r + r * Math.cos(a), y: y + r + r * Math.sin(a) });
        }
        /* arco inferior-direito: 3 pontos */
        for (var j = 0; j <= 3; j++) {
            var b = (Math.PI / 2) * (j / 3);
            pts.push({ x: x + w - r + r * Math.cos(b), y: y + h - r + r * Math.sin(b) });
        }
        pts.push({ x: x + w - r, y: y + h });
        pts.push({ x: x,         y: y + h });
        return pts;
    }

    function svg(vw, vh, boxType, L, W, H, cutLines, foldLines) {
        return [
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + r2(vw) + ' ' + r2(vh) + '">',
            '  <metadata>' + JSON.stringify({ box_type: boxType, length: L, width: W, height: H }) + '</metadata>',
            '  <g id="cut_lines" stroke="#ff0000" fill="rgba(245,200,66,0.15)" stroke-width="2">',
            cutLines.map(function (l) { return '    ' + l; }).join('\n'),
            '  </g>',
            '  <g id="fold_lines" stroke="#0000ff" fill="none" stroke-dasharray="6,4" stroke-width="1.5">',
            foldLines.map(function (l) { return '    ' + l; }).join('\n'),
            '  </g>',
            '</svg>',
        ].join('\n');
    }

    root.DielineGenerators = {
        rsc_regular_slotted:  rsc,
        rollover_hinged_lid:  rolloverHingedLid,
        generate: function (boxType, L, W, H) {
            if (boxType === 'rsc_regular_slotted')  return rsc(L, W, H);
            if (boxType === 'rollover_hinged_lid')   return rolloverHingedLid(L, W, H);
            return null;
        },
    };

}(window));
