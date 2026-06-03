/* ================================================================
   AllToPack — dieline_parser.js   (v2 — arquitectura genérica)

   Lê um SVG de dieline com a seguinte convenção:
     <g id="cut_lines">   → <rect id="XXX_panel"> define cada painel
     <g id="fold_lines">  → <line> define cada linha de dobra
     <metadata>           → JSON com box_type, length, width, height

   Devolve:
   {
     meta: { box_type, length, width, height },
     panels: { base, front, back, left, right, lid, ... }
               cada painel: { id, x, y, w, h }
     folds:  [{ x1,y1,x2,y2 }]
   }
   ================================================================ */
(function (root) {
    'use strict';

    function parse(url) {
        return fetch(url)
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
            .then(text => {
                const doc   = new DOMParser().parseFromString(text, 'image/svg+xml');
                const svgEl = doc.documentElement;
                if (svgEl.querySelector('parsererror')) throw new Error('SVG inválido');

                /* ── metadata ── */
                const metaEl = doc.querySelector('metadata');
                let meta = {};
                if (metaEl) {
                    try { meta = JSON.parse(metaEl.textContent.trim()); } catch (_) {}
                }

                /* ── painéis: todos os <rect> dentro de #cut_lines ── */
                const panels = {};
                const cutGroup = doc.getElementById('cut_lines');
                if (cutGroup) {
                    cutGroup.querySelectorAll('rect').forEach(el => {
                        const id  = el.getAttribute('id') || '';
                        /* normalizar: "base_panel" → "base" */
                        const key = id.replace(/_panel$/, '');
                        panels[key] = {
                            id,
                            x: parseFloat(el.getAttribute('x')      || 0),
                            y: parseFloat(el.getAttribute('y')       || 0),
                            w: parseFloat(el.getAttribute('width')   || 0),
                            h: parseFloat(el.getAttribute('height')  || 0),
                        };
                    });
                }

                /* ── linhas de dobra ── */
                const folds = [];
                const foldGroup = doc.getElementById('fold_lines');
                if (foldGroup) {
                    foldGroup.querySelectorAll('line').forEach(el => {
                        folds.push({
                            x1: parseFloat(el.getAttribute('x1') || 0),
                            y1: parseFloat(el.getAttribute('y1') || 0),
                            x2: parseFloat(el.getAttribute('x2') || 0),
                            y2: parseFloat(el.getAttribute('y2') || 0),
                        });
                    });
                }

                if (!panels.base) throw new Error('base_panel não encontrado no SVG');

                return { meta, panels, folds };
            });
    }

    root.DielineParser = { parse };

}(window));
