/* ================================================================
   AllToPack — dieline_engine.js  (v5 — polígonos genéricos)

   A geometria 3D é DERIVADA inteiramente do SVG-dieline do produto:
   o parser entrega uma árvore de painéis (root → filhos). Cada painel é
   um POLÍGONO 2D; o engine constrói-o como THREE.Shape e dobra-o sobre a
   aresta partilhada com o pai. Retângulos são polígonos de 4 pontos, por
   isso continua a montar as caixas rectangulares como antes.

   Não há lógica específica por tipo de caixa.

   t=0.0 → planificado (todas as dobras a 0°)
   t=1.0 → montado     (cada painel dobrado ao seu ângulo)
   ================================================================ */
(function () {
    'use strict';

    var _cfg = window.ATP_CONFIG || {};

    var animT = 0, animPlaying = false, animDir = 1, animRAF = null;
    var autoRotate = false, currentView = '3d';

    var ZOOM_MIN = 50, ZOOM_MAX = 8000, ZOOM_DEFAULT = 900;

    /* DOM */
    var c3     = document.getElementById('canvas3d');
    var view2d = document.getElementById('atp-2d-view');
    var img2d  = document.getElementById('atp-2d-img');
    var hint   = document.getElementById('atp-viewer-hint');
    if (img2d && _cfg.dielineSvgUrl) img2d.src = _cfg.dielineSvgUrl;

    /* Three */
    var scene, camera, renderer, boxGroup, axesHelper;
    var sph = { theta: 0.9, phi: 1.0, r: ZOOM_DEFAULT };

    /* árvore de dobras montada: lista de { node, pivot, foldSign, axis } */
    var folds = [];
    /* centro/escala da cena (mm) para câmara e eixos */
    var sceneSize = 300;
    var sceneCenter = { x: 0, y: 0, z: 0 };

    var COL_BASE = 0xf5c842;
    var COL_WALL = 0xf7d05a;
    var COL_LID  = 0xe8a020;

    function makeMat(color) {
        return new THREE.MeshLambertMaterial({
            color: color, side: THREE.DoubleSide,
            transparent: true, opacity: 0.95,
        });
    }

    function ease(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }
    function deg2rad(d) { return d * Math.PI / 180; }

    /* ════════════════════════════════════════════════════════════
       CONSTRUÇÃO A PARTIR DA GEOMETRIA DO PARSER  (polígonos)
       ════════════════════════════════════════════════════════════

       Mapeamento 2D(SVG)→3D no estado PLANIFICADO:
         SVG (x,y) → cena (X=x, Z=y, Y=0).  O dieline assenta no chão (XZ).

       ROOT: polígono deitado no chão.
       FILHO: vive num pivot colocado no início da aresta de dobra (A),
         orientado por um referencial { û (ao longo da aresta), n̂ (perp.
         no chão, p/ dentro do painel), ŷ (cima) }. Em repouso o painel
         deita no chão; ao dobrar, o pivot roda `angle` em torno de û (X
         local) e o painel levanta-se. O encadeamento de grupos faz os
         filhos acompanharem o pai.
       ════════════════════════════════════════════════════════════ */
    function buildFromGeometry(geo) {
        clearScene();
        boxGroup = new THREE.Group();
        boxGroup.rotation.y = Math.PI; // girar a caixa 180° em torno do eixo vertical
        scene.add(boxGroup);

        var u = geo.unit || 1;
        function mm(px) { return px / u; }
        /* Ancorar a caixa junto aos eixos: bbox do root → canto em (0,0). */
        var rootNode = geo.nodes[0];
        var rb = polyBBox(rootNode.points);
        var off = { x: rb.minX, y: rb.minY };       /* subtrair p/ 1º octante */
        var baseL = mm(rb.w), baseW = mm(rb.h);

        /* Após giro Y=180°, o boxGroup fica em x/z negativos; trazê-lo de volta.
           Isso faz o ponto de fechamento do box ficar em 0,0 do sistema de eixos. */
        boxGroup.position.set(baseL, 0, baseW);

        /* ponto SVG → vetor de cena no chão (Y=0), já deslocado p/ 1º octante.
           TODOS os painéis (root e filhos) usam o mesmo off, p/ ficarem no
           mesmo referencial. */
        function sceneOf(p) { return new THREE.Vector3(mm(p.x - off.x), 0, mm(p.y - off.y)); }

        var maxH = 0;
        geo.nodes.forEach(function (n) {
            if (n.parentKey != null && n.edge) {
                maxH = Math.max(maxH, mm(panelDepth(n.points, n.edge)));
            }
        });
        sceneSize = Math.max(baseL, baseW, maxH, 50);
        sceneCenter = { x: baseL * 1.5, y: maxH / 2, z: baseW * 1.5 };

        var groups = {};
        folds = [];

        geo.nodes.forEach(function (node) {
            /* Os filhos penduram no FOLDGROUP do pai (para acompanharem a
               dobra do pai). groups[key] = { attach, restWorld }. */
            var parent = node.parentKey ? groups[node.parentKey] : null;
            var parentAttach = parent ? parent.attach : boxGroup;

            var color = node.parentKey == null ? COL_BASE
                      : node.angle >= 135 ? COL_LID : COL_WALL;

            if (node.parentKey == null) {
                /* ROOT deitado no chão: shape (x,y,0)→cena (x,0,y) via +90° X.
                   restWorld do root = essa rotação (sem translação). */
                var mesh = polyMesh(node.points, off, mm, color);
                mesh.rotation.x = Math.PI / 2;
                mesh.name = node.key;
                boxGroup.add(mesh);
                /* Os filhos do root penduram no boxGroup (identidade). A
                   rotação π/2 do mesh é só para desenhar a base; NÃO entra
                   no referencial dos filhos. Logo rootRest = identidade. */
                groups[node.key] = { attach: boxGroup, restWorld: new THREE.Matrix4() };
                return;
            }

            groups[node.key] = buildChild(node, parentAttach, off, mm, sceneOf, parent.restWorld, color);
        });

        updateFolds(animT);
        buildAxes();
        updateInfo(geo);
    }

    /* Constrói o pivot+foldGroup de um filho na aresta de dobra.

       O posicionamento usa MATRIZES DE REPOUSO (estado planificado): cada
       painel tem uma matriz mundial-de-repouso (restWorld) que leva coords
       locais → mundo no chão. Para colocar o pivot do filho no espaço local
       do pai, multiplicamos por inv(restWorld do pai). Isto é rigoroso a
       qualquer profundidade (ao contrário de um "frame de chão" simplista).

       parentAttach:    foldGroup do pai (onde pendurar).
       parentRestWorld: matriz mundial-de-repouso do pai.
       Devolve { attach, restWorld } para os filhos deste nó. */
    function buildChild(node, parentAttach, off, mm, sceneOf, parentRestWorld, color) {
        var e = node.edge;
        var A = sceneOf({ x: e.x1, y: e.y1 });
        var B = sceneOf({ x: e.x2, y: e.y2 });

        /* û = direção da aresta no chão; n̂ = perpendicular no chão, p/ dentro */
        var uHat = B.clone().sub(A);
        var edgeLen = uHat.length() || 1;
        uHat.multiplyScalar(1 / edgeLen);
        var nHat = new THREE.Vector3(-uHat.z, 0, uHat.x);
        var cen = polyCentroidScene(node.points, off, mm);
        if (cen.clone().sub(A).dot(nHat) < 0) nHat.multiplyScalar(-1);

        /* restWorld do FILHO (no chão): mapeia o SHAPE (s,d,0) → mundo.
           s → û ; d → n̂. Base ORTONORMAL DIREITA { X=û, Y=n̂, Z=û×n̂ }
           (det=+1, senão setFromRotationMatrix devolve lixo). */
        var zHat = new THREE.Vector3().crossVectors(uHat, nHat);
        var childRestWorld = new THREE.Matrix4().makeBasis(uHat, nHat, zHat);
        childRestWorld.elements[12] = A.x;
        childRestWorld.elements[13] = A.y;
        childRestWorld.elements[14] = A.z;

        /* transform LOCAL do pivot (relativo ao pai) = inv(parentRest)·childRest */
        var parentInv = new THREE.Matrix4().copy(parentRestWorld).invert();
        var localM = new THREE.Matrix4().multiplyMatrices(parentInv, childRestWorld);

        var pivot = new THREE.Group();
        decomposeInto(localM, pivot);
        parentAttach.add(pivot);

        /* foldGroup interno: roda em torno de X local (= û). */
        var foldGroup = new THREE.Group();
        pivot.add(foldGroup);

        /* shape (s,d): s ao longo de û, d ao longo de n̂. Sem rotação extra —
           o childRestWorld já coloca (s,d,0) no chão na orientação certa. */
        var pts2d = node.points.map(function (p) {
            var P = sceneOf({ x: p.x, y: p.y });
            var rel = P.clone().sub(A);
            return new THREE.Vector2(rel.dot(uHat), rel.dot(nHat));
        });
        var mesh = shapeMesh(pts2d, color);
        mesh.name = node.key;
        foldGroup.add(mesh);

        folds.push({ pivot: foldGroup, angle: node.angle, sign: -1 });

        return { attach: foldGroup, restWorld: childRestWorld };
    }

    /* Decompõe uma Matrix4 (rotação+translação, sem escala) em
       position+quaternion de um Object3D. */
    function decomposeInto(m, obj) {
        var pos = new THREE.Vector3();
        var quat = new THREE.Quaternion();
        var scl = new THREE.Vector3();
        m.decompose(pos, quat, scl);
        obj.position.copy(pos);
        obj.quaternion.copy(quat);
    }

    /* ── GEOMETRIA DE POLÍGONOS ──────────────────────────────────── */

    /* Mesh do ROOT: shape a partir dos pontos SVG (deslocados por off,
       escalados para mm). Fica no plano XY local (depois rodado p/ XZ). */
    function polyMesh(points, off, mm, color) {
        var shape = new THREE.Shape();
        points.forEach(function (p, i) {
            var x = mm(p.x - off.x), y = mm(p.y - off.y);
            if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
        });
        shape.closePath();
        return new THREE.Mesh(new THREE.ShapeGeometry(shape), makeMat(color));
    }

    /* Mesh de um painel-filho a partir de pontos 2D (s,d) já em mm. */
    function shapeMesh(pts2d, color) {
        var shape = new THREE.Shape();
        pts2d.forEach(function (p, i) {
            if (i === 0) shape.moveTo(p.x, p.y); else shape.lineTo(p.x, p.y);
        });
        shape.closePath();
        return new THREE.Mesh(new THREE.ShapeGeometry(shape), makeMat(color));
    }

    function polyBBox(points) {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        points.forEach(function (p) {
            minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        });
        return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: maxX - minX, h: maxY - minY };
    }

    /* centroide do polígono em coords de CENA (chão, Y=0) */
    function polyCentroidScene(points, off, mm) {
        var sx = 0, sy = 0;
        points.forEach(function (p) { sx += p.x; sy += p.y; });
        var n = points.length || 1;
        return new THREE.Vector3(mm(sx / n - off.x), 0, mm(sy / n - off.y));
    }

    /* "profundidade" do painel = distância máx. dos seus pontos à aresta
       de dobra (em px). Usada só para enquadrar a câmara. */
    function panelDepth(points, edge) {
        var x1 = edge.x1, y1 = edge.y1, x2 = edge.x2, y2 = edge.y2;
        var dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
        var nx = -dy / len, ny = dx / len;
        var maxd = 0;
        points.forEach(function (p) {
            maxd = Math.max(maxd, Math.abs((p.x - x1) * nx + (p.y - y1) * ny));
        });
        return maxd;
    }

    /* ════════════════════════════════════════════════════════════
       ANIMAÇÃO DAS DOBRAS — genérica
       ════════════════════════════════════════════════════════════ */
    function updateFolds(t) {
        var k = ease(Math.max(0, Math.min(1, t)));
        for (var i = 0; i < folds.length; i++) {
            var f = folds[i];
            /* dobra em torno de X local do foldGroup (= û da aresta) */
            f.pivot.rotation.x = k * deg2rad(f.angle) * f.sign;
        }
    }

    function clearScene() {
        if (boxGroup) { scene.remove(boxGroup); boxGroup = null; }
        folds = [];
    }

    /* ── AXES ───────────────────────────────────────────────────── */
    function buildAxes() {
        if (axesHelper) { scene.remove(axesHelper); axesHelper = null; }
        var maxD = sceneSize;
        var len = maxD * 1.4, rad = maxD * 0.008;
        var grp = new THREE.Group();
        function axis(dir, color) {
            var m  = new THREE.MeshBasicMaterial({ color: color });
            var sh = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len, 8), m);
            var tp = new THREE.Mesh(new THREE.ConeGeometry(rad * 2.5, rad * 7, 8), m);
            tp.position.y = len / 2 + rad * 3.5; sh.add(tp);
            if (dir === 'x') { sh.rotation.z = -Math.PI / 2; sh.position.x = len / 2; }
            if (dir === 'y') { sh.position.y = len / 2; }
            if (dir === 'z') { sh.rotation.x =  Math.PI / 2; sh.position.z = len / 2; }
            grp.add(sh);
        }
        axis('x', 0xff3333); axis('y', 0x33cc33); axis('z', 0x3399ff);
        axesHelper = grp; scene.add(grp);
    }

    /* ── INFO / SLIDER ──────────────────────────────────────────── */
    function updateInfo(geo) {
        var el = document.getElementById('infoBlank');
        if (!el) return;
        var m = (geo && geo.meta) || {};
        if (m.length && m.width && m.height) {
            el.textContent = 'L=' + Math.round(m.length) + ' × W=' + Math.round(m.width) + ' × H=' + Math.round(m.height) + ' mm';
        } else {
            el.textContent = (geo ? geo.nodes.length + ' painéis' : '');
        }
    }
    function updateSlider(pct) {
        var s = document.getElementById('animSlider');
        var p = document.getElementById('animPct');
        if (s) s.value = pct;
        if (p) p.textContent = Math.round(pct) + '%';
    }

    function showEmpty(msg) {
        if (hint) { hint.textContent = msg || 'Sem dieline para este produto'; hint.style.display = ''; }
    }

    /* ── CAMERA ─────────────────────────────────────────────────── */
    function updateCam() {
        var c = sceneCenter;
        camera.position.set(
            c.x + sph.r * Math.sin(sph.phi) * Math.sin(sph.theta),
            c.y + sph.r * Math.cos(sph.phi),
            c.z + sph.r * Math.sin(sph.phi) * Math.cos(sph.theta)
        );
        camera.lookAt(c.x, c.y, c.z);
    }

    /* ── LAYOUT ─────────────────────────────────────────────────── */
    function fitPageHeight() {
        var nav = document.querySelector('.o_main_navbar, header.o_header_standard, header') || { offsetHeight: 56 };
        var page = document.querySelector('.atp-dl-page');
        if (page) page.style.height = (window.innerHeight - nav.offsetHeight) + 'px';
    }
    function getViewerSize() {
        var ctrl    = document.querySelector('.atp-dl-controls');
        var sidebar = document.querySelector('.atp-dl-sidebar');
        var nav     = document.querySelector('.o_main_navbar, header.o_header_standard, header') || { offsetHeight: 56 };
        return {
            w: Math.max(200, window.innerWidth  - (sidebar ? sidebar.offsetWidth : 300)),
            h: Math.max(200, window.innerHeight - nav.offsetHeight - (ctrl ? ctrl.offsetHeight : 52)),
        };
    }
    function resizeRenderer() {
        if (!renderer || !camera) return;
        var s = getViewerSize();
        renderer.setSize(s.w, s.h);
        camera.aspect = s.w / s.h;
        camera.updateProjectionMatrix();
    }

    /* ── VIEW TOGGLE ────────────────────────────────────────────── */
    function setView(v) {
        currentView = v;
        var is3d = v === '3d';
        if (c3) c3.style.display = is3d ? 'block' : 'none';
        if (view2d) view2d.style.display = is3d ? 'none' : 'flex';
        if (hint)   hint.style.display   = is3d ? '' : 'none';
        var b3 = document.getElementById('ctrl-3d'); if (b3) b3.classList.toggle('active', is3d);
        var b2 = document.getElementById('ctrl-2d'); if (b2) b2.classList.toggle('active', !is3d);
    }

    /* ── INIT ───────────────────────────────────────────────────── */
    function initThree() {
        fitPageHeight();
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1a1a2e);

        var sz = getViewerSize();
        camera   = new THREE.PerspectiveCamera(45, sz.w / sz.h, 0.1, 50000);
        renderer = new THREE.WebGLRenderer({ canvas: c3, antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        scene.add(new THREE.AmbientLight(0xffffff, 0.8));
        var d1 = new THREE.DirectionalLight(0xffffff, 0.7); d1.position.set(300, 500, 300); scene.add(d1);
        var d2 = new THREE.DirectionalLight(0x88aaff, 0.3); d2.position.set(-250, 150, -200); scene.add(d2);

        /* orbit */
        var drag = false, prev = { x: 0, y: 0 };
        c3.addEventListener('mousedown', function (e) { drag = true; prev = { x: e.clientX, y: e.clientY }; });
        window.addEventListener('mouseup', function () { drag = false; });
        window.addEventListener('mousemove', function (e) {
            if (!drag) return;
            sph.theta -= (e.clientX - prev.x) * 0.007;
            sph.phi = Math.max(0.05, Math.min(Math.PI - 0.05, sph.phi + (e.clientY - prev.y) * 0.007));
            prev = { x: e.clientX, y: e.clientY }; updateCam();
        });
        c3.addEventListener('wheel', function (e) {
            e.preventDefault();
            sph.r = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, sph.r + e.deltaY * 0.7));
            updateCam();
        }, { passive: false });

        resizeRenderer();
        updateCam();

        (function loop() {
            requestAnimationFrame(loop);
            if (autoRotate && currentView === '3d') { sph.theta += 0.005; updateCam(); }
            renderer.render(scene, camera);
        })();
    }

    /* ── ANIM ───────────────────────────────────────────────────── */
    function startAnim() {
        if (!folds.length) return;
        animPlaying = true;
        var icon = document.getElementById('ctrl-anim-icon');
        if (icon) icon.className = 'fa fa-stop';
        (function step() {
            if (!animPlaying) return;
            animT += 0.006 * animDir;
            if (animT >= 1) { animT = 1; animDir = -1; }
            if (animT <= 0) { animT = 0; animDir =  1; }
            updateSlider(Math.round(animT * 100));
            updateFolds(animT);
            animRAF = requestAnimationFrame(step);
        })();
    }
    function stopAnim() {
        animPlaying = false;
        if (animRAF) cancelAnimationFrame(animRAF);
        var icon = document.getElementById('ctrl-anim-icon');
        if (icon) icon.className = 'fa fa-play';
    }

    /* ── WIRING ─────────────────────────────────────────────────── */
    function wire(id, fn) { var el = document.getElementById(id); if (el) el.addEventListener('click', fn); }
    wire('ctrl-3d', function () { setView('3d'); });
    wire('ctrl-2d', function () { setView('2d'); });
    wire('ctrl-anim', function () { animPlaying ? stopAnim() : startAnim(); });
    wire('ctrl-rotate', function () { autoRotate = !autoRotate; var el = document.getElementById('ctrl-rotate'); if (el) el.classList.toggle('active', autoRotate); });
    wire('ctrl-zoom-in',  function () { sph.r = Math.max(ZOOM_MIN, sph.r - sceneSize * 0.08); updateCam(); });
    wire('ctrl-zoom-out', function () { sph.r = Math.min(ZOOM_MAX, sph.r + sceneSize * 0.08); updateCam(); });
    wire('ctrl-reset', function () {
        stopAnim(); animT = 0; animDir = 1; updateSlider(0); updateFolds(0);
        sph.theta = 0.9; sph.phi = 1.0; sph.r = Math.max(ZOOM_DEFAULT, sceneSize * 2.5); updateCam();
    });

    var slider = document.getElementById('animSlider');
    if (slider) slider.addEventListener('input', function () {
        stopAnim();
        animT = parseInt(this.value, 10) / 100;
        updateSlider(this.value);
        updateFolds(animT);
    });

    window.addEventListener('resize', function () { fitPageHeight(); resizeRenderer(); updateCam(); });

    /* API mínima exposta (debug / testes headless) */
    window.ATP_DIELINE = {
        get scene() { return scene; },
        get folds() { return folds; },
        setFold: function (t) { animT = t; updateFolds(t); },
    };

    /* ── BOOT ───────────────────────────────────────────────────── */
    function boot() {
        if (typeof THREE === 'undefined') { console.error('Three.js não carregado'); return; }
        initThree();

        var url = _cfg.dielineSvgUrl;
        if (!url) { showEmpty('Este produto não tem dieline SVG.'); return; }
        if (typeof DielineParser === 'undefined') { console.error('DielineParser não carregado'); return; }

        DielineParser.parse(url)
            .then(function (geo) {
                if (!geo.nodes || !geo.nodes.length) { showEmpty('Dieline sem painéis válidos.'); return; }
                buildFromGeometry(geo);
                sph.r = Math.max(ZOOM_DEFAULT, sceneSize * 2.5);
                updateCam();
            })
            .catch(function (err) {
                console.error('[dieline] falha a carregar SVG:', err.message);
                showEmpty('Não foi possível carregar o dieline.');
            });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

})();
