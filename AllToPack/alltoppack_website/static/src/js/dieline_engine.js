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
    var scene, camera, renderer, boxPivot, boxGroup, axesHelper;
    var sph = { r: ZOOM_DEFAULT };
    /* Rotação livre sem gimbal lock: quaternion acumulado no boxPivot (inicializado em initThree) */
    var rotQuat = null;

    /* árvore de dobras montada: lista de { node, pivot, foldSign, axis } */
    var folds = [];
    var svgTextCache = null;
    var artwork = {};        /* { face_key: data_url } — estado local do artwork */
    var artworkRot = {};     /* { face_key: degrees } — rotação do logo por face (0/90/180/270) */
    var faceBaseColor = {};  /* { face_key: hex } — cor original da face, antes de qualquer textura */
    var selectedFace = null; /* face_key seleccionada pelo raycasting */
    var meshMap = {};        /* { face_key: mesh } para aplicar texturas */
    /* centro/escala da cena (mm) para câmara e eixos */
    var sceneSize = 300;
    var sceneCenter = { x: 0, y: 0, z: 0 };

    var COL_BASE = 0xf5c842;
    var COL_WALL = 0xf7d05a;
    var COL_LID  = 0xe8a020;

    /* polygonOffset empurra ligeiramente cada polígono em profundidade,
       eliminando o z-fighting entre abas coplanares (várias abas no mesmo
       lado da caixa fechada piscavam por estarem exactamente no mesmo plano). */
    function applyPolyOffset(matOpts, order) {
        matOpts.polygonOffset = true;
        /* Desempate de z-fighting entre painéis coplanares (ex.: as flaps da
           tampa que se encontram ao meio). Cada painel recebe um offset
           ÚNICO mas de magnitude MÍNIMA: só a parte fracionária do `units`
           varia com o índice. Assim a ordem no depth buffer é determinística
           sem deslocar a geometria de forma percetível — valores grandes
           faziam os lados parecer "afundados" ao rodar. */
        var o = order || 0;
        matOpts.polygonOffsetFactor = 0;
        matOpts.polygonOffsetUnits = -(o + 1) * 0.05;
        return matOpts;
    }

    function makeMat(color) {
        return new THREE.MeshLambertMaterial(applyPolyOffset({
            color: color, side: THREE.DoubleSide,
        }));
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

        /* boxPivot: fica na ORIGEM, só recebe a rotação do utilizador.
           boxGroup: filho do pivot, deslocado para que o centro geométrico
           da caixa coincida com a origem — assim a rotação é sobre si próprio. */
        boxPivot = new THREE.Group();
        boxGroup = new THREE.Group();
        boxPivot.add(boxGroup);
        scene.add(boxPivot);

        /* Rotação inicial: nenhuma — caixa de frente para a câmara */
        if (rotQuat) {
            rotQuat.set(0, 0, 0, 1);
            boxPivot.quaternion.copy(rotQuat);
        }

        var u = geo.unit || 1;
        function mm(px) { return px / u; }
        var rootNode = geo.nodes[0];
        var rb = polyBBox(rootNode.points);
        var off = { x: rb.minX, y: rb.minY };
        var baseL = mm(rb.w), baseW = mm(rb.h);

        /* SVG (x,y) → cena (X=x, Y=0, Z=y): base no plano XZ (deitada).
           boxGroup é rodado -90° em X para levantar a caixa para a vertical. */
        function sceneOf(p) {
            return new THREE.Vector3(mm(p.x - off.x), 0, mm(p.y - off.y));
        }

        var maxH = 0;
        geo.nodes.forEach(function (n) {
            if (n.parentKey != null && n.edge) {
                maxH = Math.max(maxH, mm(panelDepth(n.points, n.edge)));
            }
        });
        sceneSize = Math.max(baseL, baseW, maxH, 50);

        /* Levantar a caixa: rodar boxGroup -90° em X → base no plano XY, paredes em Z/Y.
           Após esta rotação: X=L, Y=W(profundidade), Z=H(altura visual).
           Centro geométrico: (-L/2, -W/2, -H/2) antes da rotação → centrado na origem. */
        boxGroup.rotation.x = -Math.PI / 2;
        boxGroup.position.set(-baseL / 2, -baseW / 2, maxH / 2);
        sceneCenter = { x: 0, y: 0, z: 0 };

        var groups = {};
        folds = [];

        /* Calcular profundidade de cada node na árvore (root=0, filhos=1, netos=2…).
           Usado para escalonar a animação por fases. */
        var nodeDepth = {};
        geo.nodes.forEach(function (node, idx) {
            if (node.parentKey == null) {
                nodeDepth[node.key] = 0;
            } else {
                nodeDepth[node.key] = (nodeDepth[node.parentKey] || 0) + 1;
            }
            node.depth = nodeDepth[node.key];
            /* Ordem de empilhamento ÚNICA por nó (índice na lista). Usada no
               polygonOffset para que abas COPLANARES com o mesmo depth (ex.: as
               flaps front_top e back_top da tampa, que se encontram ao meio)
               recebam offsets distintos e não pisquem (z-fighting). */
            node.stackOrder = idx;
        });

        geo.nodes.forEach(function (node) {
            /* Os filhos penduram no FOLDGROUP do pai (para acompanharem a
               dobra do pai). groups[key] = { attach, restWorld }. */
            var parent = node.parentKey ? groups[node.parentKey] : null;
            var parentAttach = parent ? parent.attach : boxGroup;

            var color = node.parentKey == null ? COL_BASE
                      : node.angle >= 135 ? COL_LID : COL_WALL;

            if (node.parentKey == null) {
                var mesh = polyMesh(node.points, off, mm, color, node.key, node.stackOrder || 0);
                mesh.rotation.x = Math.PI / 2;
                boxGroup.add(mesh);
                groups[node.key] = { attach: boxGroup, restWorld: new THREE.Matrix4() };
                return;
            }

            groups[node.key] = buildChild(node, parentAttach, off, mm, sceneOf, parent.restWorld, color);
        });

        calcFoldWindows();
        updateFolds(animT);
        buildAxes();
        updateInfo(geo);
        /* Recalcular tamanho do canvas após construção — sidebar pode ter mudado */
        resizeRenderer();
        updateCam();
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

        /* û = direção da aresta no plano XZ; n̂ = perpendicular no plano XZ, p/ dentro. */
        var uHat = B.clone().sub(A);
        var edgeLen = uHat.length() || 1;
        uHat.multiplyScalar(1 / edgeLen);
        var nHat = new THREE.Vector3(-uHat.z, 0, uHat.x);
        var cen = polyCentroidScene(node.points, sceneOf);
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
        var mesh = shapeMesh(pts2d, color, node.key, node.stackOrder || 0);
        foldGroup.add(mesh);

        folds.push({ pivot: foldGroup, angle: node.angle, sign: -1, depth: node.depth || 0 });

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

    function makeMatSide(color, side, order) {
        return new THREE.MeshLambertMaterial(applyPolyOffset({
            color: color, side: side,
        }, order));
    }

    /* Cria um Group com dois meshes — _outer (FrontSide) e _inner (BackSide).
       Ambos são registados no meshMap com os sufixos correspondentes.
       `order` = índice único do painel, usado no polygonOffset para empilhar
       abas coplanares numa ordem fixa (evita z-fighting).
       Devolve o Group para adicionar ao pai. */
    function makeFacePair(geo, color, key, order) {
        var outer = new THREE.Mesh(geo, makeMatSide(color, THREE.FrontSide, order));
        var inner = new THREE.Mesh(geo, makeMatSide(color, THREE.BackSide, order));
        outer.name = key + '_outer';
        inner.name = key + '_inner';
        /* guardar a ordem no mesh para reaplicar o polygonOffset quando a
           face recebe ou perde textura de artwork */
        outer.userData.order = order || 0;
        inner.userData.order = order || 0;
        meshMap[key + '_outer'] = outer;
        meshMap[key + '_inner'] = inner;
        var grp = new THREE.Group();
        grp.name = key;
        grp.add(outer);
        grp.add(inner);
        return grp;
    }

    /* Mesh do ROOT: shape a partir dos pontos SVG (deslocados por off,
       escalados para mm). Fica no plano XY local (depois rodado p/ XZ). */
    function polyMesh(points, off, mm, color, key, order) {
        var shape = new THREE.Shape();
        points.forEach(function (p, i) {
            var x = mm(p.x - off.x), y = mm(p.y - off.y);
            if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
        });
        shape.closePath();
        return makeFacePair(new THREE.ShapeGeometry(shape), color, key, order);
    }

    /* Mesh de um painel-filho a partir de pontos 2D (s,d) já em mm. */
    function shapeMesh(pts2d, color, key, order) {
        var shape = new THREE.Shape();
        pts2d.forEach(function (p, i) {
            if (i === 0) shape.moveTo(p.x, p.y); else shape.lineTo(p.x, p.y);
        });
        shape.closePath();
        return makeFacePair(new THREE.ShapeGeometry(shape), color, key, order);
    }

    function polyBBox(points) {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        points.forEach(function (p) {
            minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        });
        return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: maxX - minX, h: maxY - minY };
    }

    /* centroide do polígono em coords de CENA, usando sceneOf para o mapeamento correto */
    function polyCentroidScene(points, sceneOf) {
        var sx = 0, sy = 0;
        points.forEach(function (p) { sx += p.x; sy += p.y; });
        var n = points.length || 1;
        return sceneOf({ x: sx / n, y: sy / n });
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
       ANIMAÇÃO DAS DOBRAS — faseada por profundidade na árvore
       ════════════════════════════════════════════════════════════

       Cada dobra tem uma janela [tStart, tEnd] dentro do animT global
       (0→1). As dobras de menor profundidade (paredes principais)
       começam primeiro; as de maior profundidade (abas, tampas)
       arrancam com um ligeiro delay mas sobrepõem-se às anteriores,
       dando uma sensação orgânica de construção progressiva.

       OVERLAP = fracção de sobreposição entre fases adjacentes (0=sem
       sobreposição, 1=tudo ao mesmo tempo). 0.35 é um bom ponto de
       partida: cada grupo começa enquanto o anterior ainda está a dobrar.
       ════════════════════════════════════════════════════════════ */
    var OVERLAP = 0.35;

    /* Calcula as janelas de tempo para cada dobra após buildFromGeometry.
       Chamado uma vez por buildFromGeometry, logo depois de folds ser preenchido. */
    function calcFoldWindows() {
        if (!folds.length) return;

        /* Determinar profundidade máxima */
        var maxDepth = 0;
        for (var i = 0; i < folds.length; i++) {
            maxDepth = Math.max(maxDepth, folds[i].depth || 0);
        }
        var numLevels = maxDepth + 1; /* 0 … maxDepth */

        /* Largura de cada "fase" no espaço [0,1].
           Com OVERLAP, cada fase começa antes da anterior terminar.
           tStart[d] = d * step_nooverlap * (1 - OVERLAP)
           Garantir que a última fase termina exactamente em 1. */
        var stepBase = 1 / Math.max(numLevels, 1);
        var stepShift = stepBase * (1 - OVERLAP);
        var windowW   = stepBase * (1 + OVERLAP * (numLevels - 1) / numLevels);
        /* simplificação mais robusta: janela fixa por nível */
        var winW = stepBase + OVERLAP * stepBase;

        for (var j = 0; j < folds.length; j++) {
            var d = folds[j].depth || 0;
            var tS = d * stepShift;
            var tE = tS + winW;
            /* Clamp para não ultrapassar 1 */
            if (tE > 1) { tE = 1; }
            folds[j].tStart = tS;
            folds[j].tEnd   = tE;
        }
    }

    function updateFolds(t) {
        for (var i = 0; i < folds.length; i++) {
            var f = folds[i];
            /* mapear t global para t local [0,1] dentro da janela desta dobra */
            var tS = f.tStart !== undefined ? f.tStart : 0;
            var tE = f.tEnd   !== undefined ? f.tEnd   : 1;
            var tLocal = tE > tS ? (t - tS) / (tE - tS) : t;
            tLocal = Math.max(0, Math.min(1, tLocal));
            var k = ease(tLocal);
            f.pivot.rotation.x = k * deg2rad(f.angle) * f.sign;
        }
    }

    function clearScene() {
        if (boxPivot) { scene.remove(boxPivot); boxPivot = null; }
        boxGroup = null;
        folds = [];
        meshMap = {};
        faceBaseColor = {};
        selectedFace = null;
        updateArtworkPanel(null);
    }

    /* ── AXES ───────────────────────────────────────────────────── */
    function buildAxes() {
        if (axesHelper) { scene.remove(axesHelper); axesHelper = null; }
        /* eixos removidos — não têm utilidade para o utilizador final */
    }

    /* ── INFO / SLIDER ──────────────────────────────────────────── */
    function updateInfo(geo) {
        var el = document.getElementById('infoBlank');
        if (!el) return;
        /* Mostrar sempre os valores dos inputs — são os que o utilizador
           vê e usa para o rebuild. Os metadados do SVG externo podem ter
           unidades ou mapeamentos diferentes. */
        var iL = document.getElementById('iL');
        var iW = document.getElementById('iW');
        var iH = document.getElementById('iH');
        if (iL && iW && iH && iL.value && iW.value && iH.value) {
            el.textContent = 'L=' + Math.round(iL.value) + ' × W=' + Math.round(iW.value) + ' × H=' + Math.round(iH.value) + ' mm';
        } else {
            var m = (geo && geo.meta) || {};
            if (m.length && m.width && m.height) {
                el.textContent = 'L=' + Math.round(m.length) + ' × W=' + Math.round(m.width) + ' × H=' + Math.round(m.height) + ' mm';
            } else {
                el.textContent = (geo ? geo.nodes.length + ' panels' : '');
            }
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
        camera.position.set(0, 0, sph.r);
        camera.lookAt(0, 0, 0);
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

        /* inicializar quaternion de rotação */
        rotQuat = new THREE.Quaternion();

        /* rotação livre por quaternion — sem gimbal lock */
        var drag = false, prev = { x: 0, y: 0 };
        c3.addEventListener('mousedown', function (e) { drag = true; prev = { x: e.clientX, y: e.clientY }; });
        window.addEventListener('mouseup', function () { drag = false; });
        window.addEventListener('mousemove', function (e) {
            if (!drag) return;
            var dx = (e.clientX - prev.x) * 0.007;
            var dy = (e.clientY - prev.y) * 0.007;
            prev = { x: e.clientX, y: e.clientY };
            if (!boxPivot) return;
            /* drag direita → roda para a direita; drag baixo → roda para baixo */
            var qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx);
            var qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy);
            rotQuat.premultiply(qY).premultiply(qX);
            boxPivot.quaternion.copy(rotQuat);
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
            if (autoRotate && currentView === '3d' && boxPivot) {
                var qAuto = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.005);
                rotQuat.premultiply(qAuto);
                boxPivot.quaternion.copy(rotQuat);
            }
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

    /* ── ARTWORK ────────────────────────────────────────────────── */

    /* Lê o bounding box 2D dos vértices de uma ShapeGeometry. */
    function faceBBox(geometry) {
        var pos = geometry.attributes.position;
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (var i = 0; i < pos.count; i++) {
            var x = pos.getX(i), y = pos.getY(i);
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        return { minX: minX, minY: minY, w: maxX - minX || 1, h: maxY - minY || 1 };
    }

    /* Normaliza os UVs de uma ShapeGeometry para [0,1]×[0,1] sobre o bbox. */
    function normaliseFaceUVs(geometry) {
        var bb = faceBBox(geometry);
        var pos = geometry.attributes.position;
        var uv = geometry.attributes.uv;
        if (!uv) return;
        for (var j = 0; j < uv.count; j++) {
            uv.setXY(j, (pos.getX(j) - bb.minX) / bb.w, (pos.getY(j) - bb.minY) / bb.h);
        }
        uv.needsUpdate = true;
    }

    /* Compõe um canvas com a cor base da face e o logo centrado (object-fit:contain).
       O canvas tem a mesma proporção da face para que a textura não distorça.
       rotDeg: rotação do logo em graus (0/90/180/270). */
    /* Remove o fundo (quase-)branco de uma imagem, devolvendo um canvas com
       esses pixels transparentes. Assim a cor da face do modelo 3D aparece
       por trás do logo em vez de uma caixa branca.
       THRESHOLD: quão claro tem de ser o pixel (0-255 por canal) para ser
       considerado "branco" e removido. 235 apanha brancos e quase-brancos
       sem comer demasiado de logos com tons claros legítimos. */
    function stripWhiteBackground(img) {
        var THRESHOLD = 235;
        var canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        try {
            var data = ctx.getImageData(0, 0, canvas.width, canvas.height);
            var px = data.data;
            for (var i = 0; i < px.length; i += 4) {
                if (px[i] >= THRESHOLD && px[i + 1] >= THRESHOLD && px[i + 2] >= THRESHOLD) {
                    px[i + 3] = 0; /* alpha → transparente */
                }
            }
            ctx.putImageData(data, 0, 0);
        } catch (e) {
            /* getImageData pode falhar por CORS — devolve a imagem intacta */
        }
        return canvas;
    }

    function buildCompositeTexture(faceColor, img, faceW, faceH, rotDeg) {
        var BASE = 1024;
        var rot = ((rotDeg || 0) % 360 + 360) % 360;
        var swapped = (rot === 90 || rot === 270);

        /* Canvas proporcional à face — evita distorção nas faces não-quadradas.
           Se o logo está rodado 90/270°, trocar w/h para o cálculo do aspect-ratio. */
        var cw, ch;
        if (faceW >= faceH) {
            cw = BASE; ch = Math.max(1, Math.round(BASE * faceH / faceW));
        } else {
            ch = BASE; cw = Math.max(1, Math.round(BASE * faceW / faceH));
        }
        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        var ctx = canvas.getContext('2d');

        /* Fundo com a cor da face */
        var hex = '#' + ('000000' + faceColor.toString(16)).slice(-6);
        ctx.fillStyle = hex;
        ctx.fillRect(0, 0, cw, ch);

        /* Remover o fundo branco do logo antes de o desenhar */
        var logo = stripWhiteBackground(img);

        /* Dimensões disponíveis para o logo após a rotação */
        var maxW = swapped ? ch * 0.8 : cw * 0.8;
        var maxH = swapped ? cw * 0.8 : ch * 0.8;
        var iAR = img.width / img.height;
        var drawW = maxW, drawH = maxW / iAR;
        if (drawH > maxH) { drawH = maxH; drawW = maxH * iAR; }

        /* Flipar verticalmente (correção eixo Y canvas↔UVs) + rotação do logo */
        ctx.save();
        ctx.translate(cw / 2, ch / 2);
        ctx.scale(1, -1);
        ctx.rotate(rot * Math.PI / 180);
        ctx.drawImage(logo, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();

        return new THREE.CanvasTexture(canvas);
    }

    function applyArtworkToFace(faceKey, dataUrl) {
        var mesh = meshMap[faceKey];
        if (!mesh) return;
        var side = faceKey.endsWith('_outer') ? THREE.FrontSide : THREE.BackSide;

        /* Cor base da face. Memorizada na primeira aplicação para que
           re-aplicações (ex.: ao rodar) não herdem o branco da textura
           anterior — uma material com `map` reporta color = 0xffffff. */
        if (faceBaseColor[faceKey] === undefined) {
            faceBaseColor[faceKey] = (mesh.material && mesh.material.map)
                ? COL_WALL
                : (mesh.material && mesh.material.color ? mesh.material.color.getHex() : COL_WALL);
        }
        var faceColor = faceBaseColor[faceKey];

        /* Normalizar UVs para que a textura cubra exactamente a face */
        if (mesh.geometry) normaliseFaceUVs(mesh.geometry);

        /* Calcular aspect ratio real da face em mm */
        var faceW = 1, faceH = 1;
        if (mesh.geometry) {
            var bb = faceBBox(mesh.geometry);
            faceW = bb.w; faceH = bb.h;
        }

        var img = new Image();
        img.onload = function () {
            var tex = buildCompositeTexture(faceColor, img, faceW, faceH, artworkRot[faceKey] || 0);
            tex.flipY = false;
            mesh.material = new THREE.MeshLambertMaterial(applyPolyOffset({
                map: tex, side: side,
            }, mesh.userData.order || 0));
        };
        img.src = dataUrl;
        artwork[faceKey] = dataUrl;
    }

    function removeArtworkFromFace(faceKey) {
        var mesh = meshMap[faceKey];
        if (!mesh) return;
        var side = faceKey.endsWith('_outer') ? THREE.FrontSide : THREE.BackSide;
        mesh.material = makeMatSide(COL_WALL, side, mesh.userData.order || 0);
        delete artwork[faceKey];
        delete artworkRot[faceKey];
        delete faceBaseColor[faceKey];
    }

    /* Painel lateral que aparece quando uma face está seleccionada */
    function updateArtworkPanel(faceKey) {
        var panel = document.getElementById('atp-artwork-panel');
        var label = document.getElementById('atp-artwork-face-label');
        var preview = document.getElementById('atp-artwork-preview');
        var btnRemove = document.getElementById('atp-artwork-remove');
        if (!panel) return;
        if (!faceKey) {
            panel.style.display = 'none';
            return;
        }
        panel.style.display = '';
        if (label) label.textContent = faceKey.replace(/_outer$/, ' (outer)').replace(/_inner$/, ' (inner)').replace(/_/g, ' ');
        if (preview) {
            if (artwork[faceKey]) {
                preview.src = artwork[faceKey];
                preview.style.display = 'block';
            } else {
                preview.src = '';
                preview.style.display = 'none';
            }
        }
        if (btnRemove) btnRemove.style.display = artwork[faceKey] ? '' : 'none';
        var rotRow = document.getElementById('atp-artwork-rot-row');
        var rotLabel = document.getElementById('atp-artwork-rot-label');
        if (rotRow) rotRow.style.display = artwork[faceKey] ? '' : 'none';
        if (rotLabel) rotLabel.textContent = (artworkRot[faceKey] || 0) + '°';
    }

    /* Raycasting — hover highlight + clique selecciona face */
    function initRaycasting() {
        var raycaster = new THREE.Raycaster();
        var mouse = new THREE.Vector2();
        var clickStart = { x: 0, y: 0 };
        var hoveredMesh = null;

        function setEmissive(mesh, hex) {
            if (mesh && mesh.material && mesh.material.emissive) {
                mesh.material.emissive.setHex(hex);
            }
        }

        /* Quando a caixa está fechada, várias abas ficam coplanares no mesmo
           lado e o raycaster devolve-as todas praticamente à mesma distância.
           A ordem dos hits é então instável → o cursor "salta" entre abas.

           Para que a SELEÇÃO concorde com o que está RENDERIZADO à frente,
           replicamos aqui a regra do polygonOffset: entre os hits virados
           para a câmara, escolhemos o de MAIOR `order` (= o que o offset
           empurrou para a frente), dentro de um grupo coplanar (mesma
           distância dentro de um epsilon). Assim seleciona-se sempre a aba
           de cima e o cursor é determinístico. */
        var COPLANAR_EPS = 0.5; /* mm: hits dentro disto são "mesmo plano" */

        function hitOrder(h) {
            var o = h.object && h.object.userData ? h.object.userData.order : 0;
            return o || 0;
        }

        function facesCamera(h) {
            if (!h.face) return true;
            var n = new THREE.Vector3()
                .copy(h.face.normal)
                .transformDirection(h.object.matrixWorld);
            var toCam = camera.position.clone().sub(h.point);
            return n.dot(toCam) > 0;
        }

        function pickVisibleHit(hits) {
            if (!hits.length) return null;
            /* só hits virados para o observador (descarta back-faces atrás) */
            var visible = hits.filter(facesCamera);
            if (!visible.length) visible = hits;

            /* O 1.º hit visível define o plano da frente; juntamos todos os
               coplanares a esse e escolhemos o de maior `order` (o de cima). */
            var front = visible[0];
            var best = front;
            for (var i = 1; i < visible.length; i++) {
                var h = visible[i];
                if (h.distance - front.distance > COPLANAR_EPS) break; /* já é mais fundo */
                if (hitOrder(h) > hitOrder(best)) best = h;
            }
            return best;
        }

        c3.addEventListener('mousemove', function (e) {
            var rect = c3.getBoundingClientRect();
            mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
            mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
            raycaster.setFromCamera(mouse, camera);
            var meshes = Object.values(meshMap);
            var hits = raycaster.intersectObjects(meshes, false);
            var vh = pickVisibleHit(hits);
            var hit = vh ? vh.object : null;
            if (hit !== hoveredMesh) {
                setEmissive(hoveredMesh, 0x000000);
                hoveredMesh = hit;
                /* Tom subtil em vez do branco forte: realça a face sem a
                   clarear ao ponto de expor as abas coplanares por baixo. */
                setEmissive(hoveredMesh, 0x1b3a5c);
                c3.style.cursor = hit ? 'pointer' : 'default';
            }
        });

        c3.addEventListener('mouseleave', function () {
            setEmissive(hoveredMesh, 0x000000);
            hoveredMesh = null;
            c3.style.cursor = 'default';
        });

        c3.addEventListener('mousedown', function (e) {
            clickStart.x = e.clientX; clickStart.y = e.clientY;
        });

        c3.addEventListener('mouseup', function (e) {
            if (Math.abs(e.clientX - clickStart.x) > 4 || Math.abs(e.clientY - clickStart.y) > 4) return;
            var rect = c3.getBoundingClientRect();
            mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
            mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
            raycaster.setFromCamera(mouse, camera);
            var meshes = Object.values(meshMap);
            var hits = raycaster.intersectObjects(meshes, false);
            var vh = pickVisibleHit(hits);
            if (vh) {
                selectedFace = vh.object.name;
                updateArtworkPanel(selectedFace);
                /* Abrir o card de artwork automaticamente */
                var acc = document.getElementById('acc-upload');
                if (acc && !acc.classList.contains('atp-scard--open')) {
                    var btn = acc.querySelector('[data-atp-toggle]');
                    if (btn) btn.click();
                }
            } else {
                selectedFace = null;
                updateArtworkPanel(null);
            }
        });
    }

    /* Carregar artwork guardado do backend */
    function loadArtwork(productId) {
        if (!productId) return;
        fetch('/dieline/artwork/load?product_id=' + productId)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                data = data || {};
                /* Rotações guardadas sob a chave reservada __rot__ */
                artworkRot = data.__rot__ || {};
                delete data.__rot__;
                artwork = data;
                Object.keys(artwork).forEach(function (k) { applyArtworkToFace(k, artwork[k]); });
            })
            .catch(function () {});
    }

    /* Guardar artwork no backend */
    function saveArtwork(productId) {
        if (!productId) return;
        /* Incluir as rotações sob a chave reservada __rot__ no mesmo payload */
        var payload = {};
        Object.keys(artwork).forEach(function (k) { payload[k] = artwork[k]; });
        payload.__rot__ = artworkRot;
        fetch('/dieline/artwork/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { product_id: productId, artwork: payload } }),
        })
        .then(function (r) { return r.json(); })
        .then(function (res) {
            var ok = res.result && res.result.ok;
            var msg = document.getElementById('atp-artwork-save-msg');
            if (msg) { msg.textContent = ok ? 'Guardado!' : 'Erro ao guardar'; msg.style.display = ''; setTimeout(function () { msg.style.display = 'none'; }, 2000); }
        })
        .catch(function () {});
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
        if (rotQuat && boxPivot) {
            rotQuat.set(0, 0, 0, 1);
            boxPivot.quaternion.copy(rotQuat);
        }
        sph.r = Math.max(ZOOM_DEFAULT, sceneSize * 2.5); updateCam();
    });

    var slider = document.getElementById('animSlider');
    if (slider) slider.addEventListener('input', function () {
        stopAnim();
        animT = parseInt(this.value, 10) / 100;
        updateSlider(this.value);
        updateFolds(animT);
    });

    window.addEventListener('resize', function () { fitPageHeight(); resizeRenderer(); updateCam(); });


    /* ── GERADORES SVG PARAMETRICOS ─────────────────────────────── */
    var _generators = (function () {
        function r2(n) { return Math.round(n * 100) / 100; }
        function rect(id, x, y, w, h, extra) {
            return '<rect id="' + id + '_panel" x="' + r2(x) + '" y="' + r2(y) + '" width="' + r2(w) + '" height="' + r2(h) + '" ' + (extra || '') + '/>';
        }
        function polygon(id, pts, extra) {
            var s = pts.map(function (p) { return r2(p.x) + ',' + r2(p.y); }).join(' ');
            return '<polygon id="' + id + '" points="' + s + '" ' + (extra || '') + '/>';
        }
        function fline(x1, y1, x2, y2) {
            return '<line x1="' + r2(x1) + '" y1="' + r2(y1) + '" x2="' + r2(x2) + '" y2="' + r2(y2) + '"/>';
        }
        function roundedRightEdge(x, y, w, h, r) {
            r = Math.min(r, h / 2, w / 2);
            var pts = [{ x: x, y: y }, { x: x + w - r, y: y }];
            for (var i = 1; i <= 3; i++) {
                var a = -Math.PI / 2 + (Math.PI / 2) * (i / 3);
                pts.push({ x: x + w - r + r * Math.cos(a), y: y + r + r * Math.sin(a) });
            }
            for (var j = 0; j <= 3; j++) {
                var b = (Math.PI / 2) * (j / 3);
                pts.push({ x: x + w - r + r * Math.cos(b), y: y + h - r + r * Math.sin(b) });
            }
            pts.push({ x: x + w - r, y: y + h }, { x: x, y: y + h });
            return pts;
        }
        function buildSvg(vw, vh, boxType, L, W, H, cutLines, foldLines) {
            var nl = '\n';
            return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + r2(vw) + ' ' + r2(vh) + '">' + nl +
                '  <metadata>' + JSON.stringify({ box_type: boxType, length: L, width: W, height: H }) + '</metadata>' + nl +
                '  <g id="cut_lines" stroke="#ff0000" fill="rgba(245,200,66,0.15)" stroke-width="2">' + nl +
                cutLines.join(nl) + nl +
                '  </g>' + nl +
                '  <g id="fold_lines" stroke="#0000ff" fill="none" stroke-dasharray="6,4" stroke-width="1.5">' + nl +
                foldLines.join(nl) + nl +
                '  </g>' + nl +
                '</svg>';
        }
        function rsc(L, W, H) {
            var G = 30, T = W / 2, mx = 20, my = 20;
            var x0 = mx + G, x1 = x0 + L, x2 = x1 + W, x3 = x2 + L, x4 = x3 + W;
            var yTop = my, yWall = my + T, yBot = my + T + H;
            var cuts = [
                rect('front_panel',        x0, yWall, L, H, 'data-root="1"'),
                rect('right_panel',        x1, yWall, W, H, 'data-fold-angle="90"'),
                rect('back_panel',         x2, yWall, L, H, 'data-fold-angle="90"'),
                rect('left_panel',         x3, yWall, W, H, 'data-fold-angle="90"'),
                rect('front_top_panel',    x0, yTop,  L, T, 'data-fold-angle="90"'),
                rect('right_top_panel',    x1, yTop,  W, T, 'data-fold-angle="90"'),
                rect('back_top_panel',     x2, yTop,  L, T, 'data-fold-angle="90"'),
                rect('left_top_panel',     x3, yTop,  W, T, 'data-fold-angle="90"'),
                rect('front_bottom_panel', x0, yBot,  L, T, 'data-fold-angle="90"'),
                rect('right_bottom_panel', x1, yBot,  W, T, 'data-fold-angle="90"'),
                rect('back_bottom_panel',  x2, yBot,  L, T, 'data-fold-angle="90"'),
                rect('left_bottom_panel',  x3, yBot,  W, T, 'data-fold-angle="90"'),
                rect('glue_panel',         mx, yWall, G, H, 'data-fold-angle="90"'),
            ];
            var folds = [
                fline(x0, yWall, x0, yBot), fline(x1, yWall, x1, yBot),
                fline(x2, yWall, x2, yBot), fline(x3, yWall, x3, yBot),
                fline(x0, yWall, x1, yWall), fline(x1, yWall, x2, yWall),
                fline(x2, yWall, x3, yWall), fline(x3, yWall, x4, yWall),
                fline(x0, yBot,  x1, yBot),  fline(x1, yBot,  x2, yBot),
                fline(x2, yBot,  x3, yBot),  fline(x3, yBot,  x4, yBot),
            ];
            return buildSvg(x4 + mx, yBot + T + my, 'rsc_regular_slotted', L, W, H, cuts, folds);
        }
        function rolloverHingedLid(L, W, H) {
            var G = Math.max(10, Math.round(H * 0.3));
            var ROLL = Math.max(8, Math.round(H * 0.45));
            var FLAP = H, r = Math.min(10, Math.round(H * 0.2));
            var mx = 20, my = 20;
            var xGlue = mx, xFront = xGlue + G, xBase = xFront + H;
            var xBack = xBase + L, xLid = xBack + H, xRoll = xLid + L, xEnd = xRoll + ROLL;
            var yTop = my, yWall = my + FLAP, yBot = my + FLAP + W;
            var cuts = [
                rect('base_panel',              xBase,  yWall, L,    W,    'data-root="1"'),
                rect('front_panel',             xFront, yWall, H,    W,    'data-fold-angle="90"'),
                rect('back_panel',              xBack,  yWall, H,    W,    'data-fold-angle="90"'),
                rect('left_panel',              xBase,  yTop,  L,    FLAP, 'data-fold-angle="90"'),
                rect('right_panel',             xBase,  yBot,  L,    FLAP, 'data-fold-angle="90"'),
                rect('glue_panel',              xGlue,  yWall, G,    W,    'data-fold-angle="90"'),
                polygon('lid_panel',            roundedRightEdge(xLid, yWall, L, W, r), 'data-fold-angle="90"'),
                polygon('roll_panel',           roundedRightEdge(xRoll, yWall + r, ROLL, W - 2 * r, r * 0.5), 'data-fold-angle="90"'),
                rect('front_top_flap_panel',    xFront, yTop,  H,    FLAP, 'data-fold-angle="90"'),
                rect('front_bottom_flap_panel', xFront, yBot,  H,    FLAP, 'data-fold-angle="90"'),
                rect('back_top_flap_panel',     xBack,  yTop,  H,    FLAP, 'data-fold-angle="90"'),
                rect('back_bottom_flap_panel',  xBack,  yBot,  H,    FLAP, 'data-fold-angle="90"'),
                rect('lid_top_flap_panel',      xLid,   yTop,  L,    FLAP, 'data-fold-angle="90"'),
                rect('lid_bottom_flap_panel',   xLid,   yBot,  L,    FLAP, 'data-fold-angle="90"'),
            ];
            var folds = [
                fline(xFront, yWall, xFront, yBot), fline(xBase, yWall, xBase, yBot),
                fline(xBack,  yWall, xBack,  yBot), fline(xLid,  yWall, xLid,  yBot),
                fline(xRoll,  yWall, xRoll,  yBot),
                fline(xBase, yWall, xBack, yWall), fline(xBase, yBot, xBack, yBot),
                fline(xFront, yWall, xBase, yWall), fline(xFront, yBot, xBase, yBot),
                fline(xBack, yWall, xLid, yWall),  fline(xBack, yBot, xLid, yBot),
                fline(xLid, yWall, xRoll, yWall),  fline(xLid, yBot, xRoll, yBot),
            ];
            return buildSvg(xEnd + mx, yBot + FLAP + my, 'rollover_hinged_lid', L, W, H, cuts, folds);
        }
        return {
            generate: function (boxType, L, W, H) {
                if (boxType === 'rsc_regular_slotted') return rsc(L, W, H);
                if (boxType === 'rollover_hinged_lid')  return rolloverHingedLid(L, W, H);
                return null;
            },
        };
    }());

    /* API mínima exposta (debug / testes headless) */
    window.ATP_DIELINE = {
        get scene() { return scene; },
        get folds() { return folds; },
        setFold: function (t) { animT = t; updateFolds(t); },
        rebuild: function (L, W, H) {
            var svgText = null;
            /* Tentar gerar SVG parametrico para o tipo de caixa actual. */
            if (_cfg.boxType) {
                svgText = _generators.generate(_cfg.boxType, L, W, H);
            }
            /* Fallback: re-parsear o SVG original se nao houver gerador. */
            if (!svgText) svgText = svgTextCache;
            if (!svgText) return;
            var geo = DielineParser.build(svgText);
            if (!geo.nodes || !geo.nodes.length) return;
            stopAnim(); animT = 0; animDir = 1; updateSlider(0);
            buildFromGeometry(geo);
            sph.r = Math.max(ZOOM_DEFAULT, sceneSize * 2.5);
            updateCam();
        },
    };

    /* ── BOOT ───────────────────────────────────────────────────── */
    function boot() {
        if (typeof THREE === 'undefined') { console.error('Three.js não carregado'); return; }
        initThree();

        var btnApply = document.getElementById('btnApply');
        if (btnApply) {
            btnApply.addEventListener('click', function () {
                var L = parseFloat(document.getElementById('iL').value) || 0;
                var W = parseFloat(document.getElementById('iW').value) || 0;
                var H = parseFloat(document.getElementById('iH').value) || 0;
                window.ATP_DIELINE.rebuild(L, W, H);
            });
        }

        /* Artwork: upload de imagem para a face seleccionada */
        var fileArtwork = document.getElementById('fileArtwork');
        if (fileArtwork) {
            fileArtwork.addEventListener('change', function () {
                if (!selectedFace || !this.files[0]) return;
                var reader = new FileReader();
                var fileName = this.files[0].name;
                reader.onload = function (e) {
                    applyArtworkToFace(selectedFace, e.target.result);
                    updateArtworkPanel(selectedFace);
                    var name = document.getElementById('artworkName');
                    if (name) name.textContent = fileName;
                };
                reader.readAsDataURL(this.files[0]);
                /* Limpar o valor para permitir seleccionar o mesmo ficheiro noutra face */
                this.value = '';
            });
        }

        var btnRemove = document.getElementById('atp-artwork-remove');
        if (btnRemove) {
            btnRemove.addEventListener('click', function () {
                if (!selectedFace) return;
                removeArtworkFromFace(selectedFace);
                updateArtworkPanel(selectedFace);
            });
        }

        function rotateArtwork(delta) {
            if (!selectedFace || !artwork[selectedFace]) return;
            artworkRot[selectedFace] = (((artworkRot[selectedFace] || 0) + delta) % 360 + 360) % 360;
            applyArtworkToFace(selectedFace, artwork[selectedFace]);
            var rotLabel = document.getElementById('atp-artwork-rot-label');
            if (rotLabel) rotLabel.textContent = artworkRot[selectedFace] + '°';
        }

        var btnRotCCW = document.getElementById('atp-artwork-rot-ccw');
        if (btnRotCCW) btnRotCCW.addEventListener('click', function () { rotateArtwork(-90); });

        var btnRotCW = document.getElementById('atp-artwork-rot-cw');
        if (btnRotCW) btnRotCW.addEventListener('click', function () { rotateArtwork(90); });

        var btnSaveArtwork = document.getElementById('atp-artwork-save');
        if (btnSaveArtwork) {
            btnSaveArtwork.addEventListener('click', function () {
                saveArtwork(_cfg.productId);
            });
        }

        initRaycasting();

        var url = _cfg.dielineSvgUrl;
        if (!url) { showEmpty('Este produto não tem dieline SVG.'); return; }
        if (typeof DielineParser === 'undefined') { console.error('DielineParser não carregado'); return; }

        fetch(url)
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
            .then(function (text) {
                svgTextCache = text;
                var geo = DielineParser.build(text);
                if (!geo.nodes || !geo.nodes.length) { showEmpty('Dieline sem painéis válidos.'); return; }
                /* Sincronizar inputs com as dimensões reais do SVG armazenado,
                   para que o infoBlank e os inputs reflictam o que está no modelo. */
                if (geo.meta && geo.meta.length && geo.meta.width && geo.meta.height) {
                    var iL = document.getElementById('iL');
                    var iW = document.getElementById('iW');
                    var iH = document.getElementById('iH');
                    if (iL) iL.value = Math.round(geo.meta.length);
                    if (iW) iW.value = Math.round(geo.meta.width);
                    if (iH) iH.value = Math.round(geo.meta.height);
                }
                buildFromGeometry(geo);
                sph.r = Math.max(ZOOM_DEFAULT, sceneSize * 2.5);
                updateCam();
                loadArtwork(_cfg.productId);
            })
            .catch(function (err) {
                console.error('[dieline] falha a carregar SVG:', err.message);
                showEmpty('Não foi possível carregar o dieline.');
            });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

})();
