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
    var faceBaseColor = {};  /* { face_key_base: hex } — cor original da face */

    /* ── LOGO (estado global) ───────────────────────────────────────
       Dois logos independentes: front (exterior _outer) e back (interior _inner).
       Cada um tem dataUrl, posição dieline, tamanho, rotação e cache de imagem.
       logoSide controla qual está activo na vista 2D.
    ─────────────────────────────────────────────────────────────── */
    var logoSide = 'front'; /* 'front' | 'back' — qual está activo no 2D */

    /* Estado por lado — acedido via logoState[side] */
    var logoState = {
        front: { dataUrl: null, dieline: null, sizeMM: 80, rot: 0, img: null, stripped: null },
        back:  { dataUrl: null, dieline: null, sizeMM: 80, rot: 0, img: null, stripped: null },
    };

    /* Atalhos para o lado activo — lidos/escritos nas funções que só operam num lado */
    function ls() { return logoState[logoSide]; }

    /* Compatibilidade com código que usa as variáveis antigas directamente */
    Object.defineProperty(window, '_logoActiveState', { get: ls });

    /* Variáveis legadas (apontam para o lado activo — usadas em render2dLogo e drag) */
    var logoDataUrl, logoDieline, logoSizeMM, logoRot, _logoImg, _logoStripped;
    function syncLegacy() {
        var s = ls();
        logoDataUrl   = s.dataUrl;
        logoDieline   = s.dieline;
        logoSizeMM    = s.sizeMM;
        logoRot       = s.rot;
        _logoImg      = s.img;
        _logoStripped = s.stripped;
    }
    function saveLegacy() {
        var s = ls();
        s.dataUrl  = logoDataUrl;
        s.dieline  = logoDieline;
        s.sizeMM   = logoSizeMM;
        s.rot      = logoRot;
        s.img      = _logoImg;
        s.stripped = _logoStripped;
    }
    var meshMap = {};          /* faceKey → THREE.Mesh */
    var _currentGeo   = null;  /* geometria actual (para 2D Logo e rebuild 3D) */

    /* ── 2D Logo view state ─────────────────────────────────────── */
    var logo2dZoom    = 1;     /* factor de zoom do canvas 2D Logo */
    var logo2dPan     = { x: 0, y: 0 };  /* offset de pan em px do canvas */
    var logo2dScale   = 1;     /* mm → px do canvas (resolução do dieline renderizado) */
    var logo2dOffMM   = { x: 0, y: 0 };  /* origem do dieline em mm no canvas */

    /* centro/escala da cena (mm) para câmara e eixos */
    var sceneSize = 300;
    var sceneCenter = { x: 0, y: 0, z: 0 };

    /* Tons de cartão kraft — leitura natural de embalagem, sóbria e profissional
       (substitui o amarelo). base/parede/tampa com gradação subtil. */
    var COL_BASE = 0xd9c4a3;
    var COL_WALL = 0xe3d3b8;
    var COL_LID  = 0xc2a878;

    /* Espessura do material (mm). Lida da metadata do SVG (`thickness`) se
       existir; senão usa este default. Dá volume "sólido" às paredes: cada
       painel tem a face exterior e interior separadas por esta espessura, com
       a borda tapada. Atualizada por buildFromGeometry. */
    var THICKNESS_DEFAULT = 2;
    var matThickness = THICKNESS_DEFAULT;

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
        _currentGeo = geo;
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

        /* Espessura do material: da metadata se vier (mm), senão o default. */
        var metaThk = geo.meta && parseFloat(geo.meta.thickness);
        matThickness = (metaThk && metaThk > 0) ? metaThk : THICKNESS_DEFAULT;

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
                /* Root: SVG→local = só escala mm e offset. û=SVG-X, n̂=SVG-Y → ângulo=0. */
                node._svgToLocal = (function(captOff, captMm) {
                    return function(p) {
                        return { s: captMm(p.x - captOff.x), d: captMm(p.y - captOff.y) };
                    };
                }(off, mm));
                node._localAngle = 0;
                node._localPts = node.points.map(function(p) {
                    return { x: mm(p.x - off.x), y: mm(p.y - off.y) };
                });
                return;
            }

            var built = buildChild(node, parentAttach, off, mm, sceneOf, parent.restWorld, color);
            groups[node.key] = built;
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

        /* Guardar a transformação SVG→local deste painel para uso no logo.
           Também guardamos o ângulo de rotação do referencial local face ao SVG,
           para compensar na rotação do logo ao construir a textura.
           No SVG: X=direita, Y=baixo. No espaço local: s=û, d=n̂.
           û em termos de SVG: û.x (componente X do mundo) = -uHat.z (pela sceneOf: SVG_x→X, SVG_y→Z)
                                û.y (componente Y do mundo) = uHat.x  (=SVG_x direction)
           sceneOf: SVG(x,y) → (X=mm(x-off.x), Z=mm(y-off.y)), Y=0
           Então û em coords SVG: svgX dir = uHat.x component, svgY dir = uHat.z component.
           O ângulo de û em relação ao eixo SVG X: atan2(uHat.z, uHat.x). */
        var uSvgX = uHat.x;   /* componente do dieline SVG-X em û */
        var uSvgY = uHat.z;   /* componente do dieline SVG-Y em û (sceneOf faz Z=svgY) */
        var localAngle = Math.atan2(uSvgY, uSvgX); /* ângulo de û face ao eixo SVG-X */

        node._svgToLocal = (function(captA, captUHat, captNHat, captSceneOf) {
            return function(p) {
                var P = captSceneOf({ x: p.x, y: p.y });
                var rel = P.clone().sub(captA);
                return { s: rel.dot(captUHat), d: rel.dot(captNHat) };
            };
        }(A.clone(), uHat.clone(), nHat.clone(), sceneOf));
        node._localAngle = localAngle; /* ângulo de rotação do referencial local */
        node._localPts = pts2d.map(function(v) { return { x: v.x, y: v.y }; });

        /* A tampa (lid) e as suas peças (lid_*, roll) dobram POR ÚLTIMO — só
           depois de todo o resto estar montado. Identificadas pela key. */
        var isLid = /^lid(_|$)/.test(node.key) || /^roll(_|$)/.test(node.key);

        /* Ordem de SEQUÊNCIA dentro da fase do corpo (independente do depth):
           seq 0 — flaps de front/back fecham PRIMEIRO (dobram para dentro);
           seq 1 — paredes left/right fecham por cima DEPOIS.
           Tudo o resto fica em 0 (mantém o faseamento por depth de sempre). */
        var seq = 0;
        if (/^(left|right)(_|$)/.test(node.key)) seq = 1;
        else if (/^(front|back)_(top|bottom)_flap$/.test(node.key)) seq = 0;

        /* Abas de TOPO/FUNDO de uma caixa SEM lid (ex.: RSC: front_top, left_bottom…).
           Nestas caixas, primeiro fecha-se o tubo (paredes + glue) e só depois as
           abas. Marcadas aqui; o faseamento usa o flag só quando não há lid. */
        var isTopBottom = /_(top|bottom)$/.test(node.key);

        folds.push({
            pivot: foldGroup, angle: node.angle, sign: -1,
            depth: node.depth || 0, isLid: isLid, seq: seq,
            isTopBottom: isTopBottom,
        });

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

    /* Constrói a geometria da BORDA (paredes laterais da espessura) a partir do
       contorno do shape, ligando o anel em z=+t/2 ao anel em z=-t/2. Dá a
       aparência de material sólido sem extrudir as faces (que partiria os UVs
       do artwork). */
    function buildEdgeGeometry(shape, halfT) {
        var pts = shape.extractPoints().shape; /* contorno exterior, em ordem */
        var n = pts.length;
        if (n < 3 || halfT <= 0) return null;
        var positions = [];
        for (var i = 0; i < n; i++) {
            var a = pts[i], b = pts[(i + 1) % n];
            /* quad da aresta a→b: dois triângulos (a+, b+, b-) e (a+, b-, a-) */
            positions.push(
                a.x, a.y,  halfT,   b.x, b.y,  halfT,   b.x, b.y, -halfT,
                a.x, a.y,  halfT,   b.x, b.y, -halfT,   a.x, a.y, -halfT
            );
        }
        var g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        g.computeVertexNormals();
        return g;
    }

    /* Cria um Group com dois meshes — _outer (FrontSide) e _inner (BackSide) —
       separados pela espessura do material (`matThickness`), mais um mesh de
       BORDA a tapar a lateral. Dá volume "sólido" às paredes.
       Ambos os meshes de face são registados no meshMap com os sufixos.
       `order` = índice único do painel, usado no polygonOffset para empilhar
       abas coplanares numa ordem fixa (evita z-fighting).
       Devolve o Group para adicionar ao pai. */
    function makeFacePair(shape, color, key, order) {
        /* Geometrias independentes: normaliseFaceUVs numa não afecta a outra,
           permitindo texturas distintas em outer (exterior) e inner (interior). */
        var geoOuter = new THREE.ShapeGeometry(shape);
        var geoInner = new THREE.ShapeGeometry(shape);
        var halfT = matThickness / 2;

        var outer = new THREE.Mesh(geoOuter, makeMatSide(color, THREE.FrontSide, order));
        var inner = new THREE.Mesh(geoInner, makeMatSide(color, THREE.BackSide, order));
        /* Separar as duas faces pela espessura: exterior à frente (+z local),
           interior atrás (-z). O artwork e os UVs de cada face mantêm-se. */
        outer.position.z =  halfT;
        inner.position.z = -halfT;
        outer.name = key + '_outer';
        inner.name = key + '_inner';
        /* guardar a ordem no mesh para reaplicar o polygonOffset quando a
           face recebe ou perde textura de artwork */
        outer.userData.order = order || 0;
        inner.userData.order = order || 0;
        /* SELECIONÁVEL para artwork?
           TODAS as flaps (corpo + tampa) e o roll seguem a MESMA lógica:
           - caixa ABERTA → selecionáveis (o utilizador pode pôr logo nelas);
           - caixa FECHADA → ficam escondidas dentro/atrás das paredes e deixam
             de ser selecionáveis, para o clique apanhar sempre as paredes
             (left/right outer). O flag `isHidingFlap` é usado no raycast.
           Paredes/base/glue/lid: sempre selecionáveis. */
        var isFlap = /_flap$/.test(key) || /^roll(_|$)/.test(key);
        outer.userData.selectable = true;
        inner.userData.selectable = true;
        outer.userData.isHidingFlap = isFlap;
        inner.userData.isHidingFlap = isFlap;

        /* As flaps interiores ficam coplanares com as paredes quando a caixa
           fecha e, por terem `order` maior, o polygonOffset empurrava-as para
           a FRENTE — apareciam a tapar a parede numa faixa central. Forçamos
           um offset POSITIVO (para trás) para ficarem sempre atrás da parede.
           Aplica-se a TODAS as flaps + roll (independente de serem ou não
           selecionáveis) — é puramente visual. */
        if (isFlap) {
            [outer, inner].forEach(function (m) {
                m.material.polygonOffset = true;
                m.material.polygonOffsetFactor = 1;
                m.material.polygonOffsetUnits = 4;
                m.material.needsUpdate = true;
            });
        }
        meshMap[key + '_outer'] = outer;
        meshMap[key + '_inner'] = inner;
        var grp = new THREE.Group();
        grp.name = key;
        grp.add(outer);
        grp.add(inner);

        /* Borda lateral (a "grossura" do cartão). Cor um pouco mais escura para
           dar leitura de volume. Não-selecionável e fora do meshMap (puramente
           decorativa). */
        var edgeGeo = buildEdgeGeometry(shape, halfT);
        if (edgeGeo) {
            var edgeMat = new THREE.MeshLambertMaterial(applyPolyOffset({
                color: darken(color, 0.8), side: THREE.DoubleSide,
            }, order));
            var edge = new THREE.Mesh(edgeGeo, edgeMat);
            edge.name = key + '_edge';
            edge.userData.selectable = false;
            grp.add(edge);
        }
        return grp;
    }

    /* Escurece uma cor hex por um factor (0..1). */
    function darken(hex, f) {
        var r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
        return (Math.round(r * f) << 16) | (Math.round(g * f) << 8) | Math.round(b * f);
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
        return makeFacePair(shape, color, key, order);
    }

    /* Mesh de um painel-filho a partir de pontos 2D (s,d) já em mm. */
    function shapeMesh(pts2d, color, key, order) {
        var shape = new THREE.Shape();
        pts2d.forEach(function (p, i) {
            if (i === 0) shape.moveTo(p.x, p.y); else shape.lineTo(p.x, p.y);
        });
        shape.closePath();
        return makeFacePair(shape, color, key, order);
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
       Chamado uma vez por buildFromGeometry, logo depois de folds ser preenchido.

       SEAMLESS: em vez de fases fixas com gaps (que faziam a animação parar
       entre grupos), atribuímos a cada dobra uma CHAVE DE ORDEM e depois
       comprimimos os grupos REALMENTE existentes para fileiras CONSECUTIVAS
       (rank 0,1,2,…) — sem níveis vazios. As janelas são distribuídas
       uniformemente em [0,1] com OVERLAP, garantindo que cada grupo começa
       enquanto o anterior ainda dobra (nunca há um instante sem movimento).

       Ordem desejada (do mais cedo ao mais tarde):
         CORPO  — por (seq, depth): base → paredes front/back → flaps → left/right
         TAMPA  — depois do corpo: abas da tampa (depth maior) → lid (depth menor) */
    var OVERLAP_GROW = 1.6; /* largura da janela = passo · este factor (>1 ⇒ sobreposição) */

    function calcFoldWindows() {
        if (!folds.length) return;

        var hasLid = false;
        for (var k = 0; k < folds.length; k++) {
            if (folds[k].isLid) { hasLid = true; break; }
        }

        /* profundidade máxima do corpo, para compor a chave de ordem. */
        var maxBodyDepth = 0;
        for (var i = 0; i < folds.length; i++) {
            if (!folds[i].isLid) maxBodyDepth = Math.max(maxBodyDepth, folds[i].depth || 0);
        }
        var BODY_SPAN = (maxBodyDepth + 1);

        /* profundidade máxima da tampa (para inverter: abas antes da lid). */
        var maxLidDepth = 0;
        for (var l = 0; l < folds.length; l++) {
            if (folds[l].isLid) maxLidDepth = Math.max(maxLidDepth, folds[l].depth || 0);
        }

        /* Chave de ordem global (número crescente = dobra mais tardia). */
        var BODY_TOTAL = 2 * BODY_SPAN; /* seq 0..1 → largura do bloco "corpo" */
        function orderKey(f) {
            if (!f.isLid) {
                /* Caixa SEM lid (ex.: RSC): regra SIMPLES e robusta — primeiro
                   TODO o tubo (paredes + glue), por depth (a cadeia fecha em
                   ordem); só DEPOIS TODAS as abas de topo/fundo, por depth. O
                   `seq` (lógica left/right do rollover) NÃO se aplica aqui,
                   senão as abas de left/right separavam-se das de front/back e
                   a ordem partia-se quando os depths variam (no rebuild). */
                if (!hasLid) {
                    var block = f.isTopBottom ? BODY_TOTAL : 0;
                    return block + (f.depth || 0);
                }
                /* Caixa COM lid: corpo por (seq, depth) — left/right por cima. */
                return (f.seq || 0) * BODY_SPAN + (f.depth || 0);
            }
            /* tampa: começa depois de todo o corpo; abas (depth maior) primeiro,
               lid (depth menor) por último → invertemos o depth. */
            return BODY_TOTAL + (maxLidDepth - (f.depth || 0));
        }

        /* Comprimir as chaves distintas em ranks consecutivos 0,1,2,… (sem
           buracos) — é isto que elimina as pausas entre grupos. */
        var keys = [];
        for (var a = 0; a < folds.length; a++) {
            var kk = orderKey(folds[a]);
            folds[a]._ok = kk;
            if (keys.indexOf(kk) === -1) keys.push(kk);
        }
        keys.sort(function (x, y) { return x - y; });
        var rankOf = {};
        keys.forEach(function (kv, idx) { rankOf[kv] = idx; });
        var numRanks = keys.length;

        /* Distribuição contínua: passo entre ranks e largura de janela (com
           sobreposição). O último rank termina exactamente em 1. */
        var step = numRanks > 1 ? 1 / (numRanks - 1 + (OVERLAP_GROW - 1)) : 1;
        var winW = step * OVERLAP_GROW;

        for (var j = 0; j < folds.length; j++) {
            var rank = rankOf[folds[j]._ok];
            var tS = rank * step;
            var tE = tS + winW;
            if (tE > 1) tE = 1;
            if (numRanks === 1) { tS = 0; tE = 1; }
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
        updateArtworkPanel();
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
    /* Fração da área disponível ocupada pelo canvas 3D. <1 deixa margem à volta
       (look mais contido/profissional). 0.7 = canvas 30% menor. */
    var VIEWER_SCALE = 0.7;
    function getViewerSize() {
        var ctrl    = document.querySelector('.atp-dl-controls');
        var sidebar = document.querySelector('.atp-dl-sidebar');
        var nav     = document.querySelector('.o_main_navbar, header.o_header_standard, header') || { offsetHeight: 56 };
        var availW = window.innerWidth  - (sidebar ? sidebar.offsetWidth : 300);
        var availH = window.innerHeight - nav.offsetHeight - (ctrl ? ctrl.offsetHeight : 52);
        return {
            w: Math.max(200, Math.round(availW * VIEWER_SCALE)),
            h: Math.max(200, Math.round(availH * VIEWER_SCALE)),
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
        var is3d     = v === '3d';
        var is2d     = v === '2d';
        var isLogo2d = v === 'logo2d';
        var logoView = document.getElementById('atp-logo2d-view');
        if (c3)      c3.style.display      = is3d     ? 'block' : 'none';
        if (view2d)  view2d.style.display  = is2d     ? 'flex'  : 'none';
        if (logoView) logoView.style.display = isLogo2d ? 'flex'  : 'none';
        if (hint)    hint.style.display    = is3d     ? ''      : 'none';
        var b3 = document.getElementById('ctrl-3d');     if (b3) b3.classList.toggle('active', is3d);
        var b2 = document.getElementById('ctrl-2d');     if (b2) b2.classList.toggle('active', is2d);
        var bL = document.getElementById('ctrl-logo2d'); if (bL) bL.classList.toggle('active', isLogo2d);
        if (isLogo2d) {
            /* Renderizar quando a vista fica visível (canvas pode ter tamanho 0 antes) */
            setTimeout(function () {
                if (c2logo) {
                    var wrap = document.getElementById('atp-logo2d-wrap');
                    if (wrap) { c2logo.width = wrap.clientWidth || 800; c2logo.height = wrap.clientHeight || 600; }
                }
                render2dLogo();
            }, 50);
        }
    }

    /* ── INIT ───────────────────────────────────────────────────── */
    function initThree() {
        fitPageHeight();
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1e293b);

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
            /* Velocidade modulada: desacelera perto dos extremos (0 e 1) para
               não haver "snap" no fim nem na reversão. O factor vai de ~0.35
               nos extremos a 1.0 no meio (curva suave em sin). Mantém a duração
               total quase igual mas suaviza o arranque/fecho. */
            var EDGE = 0.35; /* fracção de velocidade mínima nos extremos */
            var ramp = EDGE + (1 - EDGE) * Math.sin(Math.PI * animT);
            animT += 0.0046 * ramp * animDir;
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

    /* ── LOGO — sistema baseado em coordenadas DIELINE (SVG px) ──────
       O logo é posicionado em logoDieline {x,y} no espaço do dieline.
       Na vista 2D Logo: drag direto no canvas → atualiza logoDieline.
       No 3D: cada painel que contenha logoDieline recebe uma textura com
       o logo mapeado (por painel — segue a dobra).
    ─────────────────────────────────────────────────────────────── */

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
                if (px[i] >= THRESHOLD && px[i + 1] >= THRESHOLD && px[i + 2] >= THRESHOLD) px[i + 3] = 0;
            }
            ctx.putImageData(data, 0, 0);
        } catch (e) {}
        return canvas;
    }

    /* Converte mm do dieline → px SVG (unidade raw do parser).
       O parser usa geo.unit = px/mm. Se não houver geo, usa 1:1. */
    function dielineMmToPx(mm_val) {
        var u = (_currentGeo && _currentGeo.unit) ? _currentGeo.unit : 1;
        return mm_val * u;
    }
    function dielinePxToMm(px_val) {
        var u = (_currentGeo && _currentGeo.unit) ? _currentGeo.unit : 1;
        return px_val / u;
    }

    /* Ray-casting point-in-polygon para polígono 2D arbitrário. */
    function pointInPolygon(px, py, poly) {
        var inside = false;
        var n = poly.length;
        for (var i = 0, j = n - 1; i < n; j = i++) {
            var xi = poly[i].x, yi = poly[i].y;
            var xj = poly[j].x, yj = poly[j].y;
            if (((yi > py) !== (yj > py)) &&
                (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    /* Constrói a textura de uma face com o logo mapeado no espaço LOCAL do shape.
       localPts: pontos do painel em coords locais do shape (mm, mesmas que a geometry Three.js).
       svgToLocal: função que converte um ponto SVG {x,y} → {s,d} em coords locais.
       logoDielineSVG: centro do logo em coords SVG absolutas.
       logoSizePx: largura do logo em px SVG.
    */
    function buildPanelLogoTexture(localPts, svgToLocal, localAngle, faceColor, logoImg, logoDielineSVG, logoSizePx, mirrorS) {
        var imgW = logoImg.naturalWidth  || logoImg.width  || 1;
        var imgH = logoImg.naturalHeight || logoImg.height || 1;
        var u = (_currentGeo && _currentGeo.unit) || 1;

        /* Converter centro e tamanho do logo para coords locais do shape */
        var logoCenter = svgToLocal(logoDielineSVG);       /* {s, d} em mm */
        var logoWmm = logoSizePx / u;                      /* mm */
        var logoHmm = logoWmm / (imgW / imgH);
        var halfW = logoWmm / 2, halfH = logoHmm / 2;
        var cx = logoCenter.s, cy = logoCenter.d;

        var rad = logoRot * Math.PI / 180 - localAngle;
        var cosR = Math.cos(rad), sinR = Math.sin(rad);

        /* bbox do painel em coords locais */
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        localPts.forEach(function(p) {
            minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        });
        var pw = maxX - minX || 1, ph = maxY - minY || 1;

        /* Intersecção: centro do logo dentro do polígono local? */
        var poly = localPts.map(function(p) { return { x: p.x, y: p.y }; });
        var hasHit = pointInPolygon(cx, cy, poly);

        /* Cantos do logo dentro do polígono? */
        if (!hasHit) {
            var corners = [
                { x: cx + (-halfW)*cosR - (-halfH)*sinR, y: cy + (-halfW)*sinR + (-halfH)*cosR },
                { x: cx + ( halfW)*cosR - (-halfH)*sinR, y: cy + ( halfW)*sinR + (-halfH)*cosR },
                { x: cx + ( halfW)*cosR - ( halfH)*sinR, y: cy + ( halfW)*sinR + ( halfH)*cosR },
                { x: cx + (-halfW)*cosR - ( halfH)*sinR, y: cy + (-halfW)*sinR + ( halfH)*cosR },
            ];
            for (var ci = 0; ci < 4 && !hasHit; ci++) {
                if (pointInPolygon(corners[ci].x, corners[ci].y, poly)) hasHit = true;
            }
        }

        /* Vértices do painel dentro do logo (logo cobre painel inteiro)? */
        if (!hasHit) {
            for (var pi = 0; pi < poly.length && !hasHit; pi++) {
                var dxv = poly[pi].x - cx, dyv = poly[pi].y - cy;
                var lxv = dxv * cosR + dyv * sinR, lyv = -dxv * sinR + dyv * cosR;
                if (Math.abs(lxv) <= halfW && Math.abs(lyv) <= halfH) hasHit = true;
            }
        }

        if (!hasHit) return null;

        /* Resolução do canvas: baseada no bbox local */
        var BASE = 512;
        var fcw, fch;
        if (pw >= ph) { fcw = BASE; fch = Math.max(1, Math.round(BASE * ph / pw)); }
        else           { fch = BASE; fcw = Math.max(1, Math.round(BASE * pw / ph)); }

        /* Preparar pixels do logo */
        var logoCanvas = document.createElement('canvas');
        logoCanvas.width = imgW; logoCanvas.height = imgH;
        var lctx = logoCanvas.getContext('2d');
        lctx.drawImage(_logoStripped || logoImg, 0, 0, imgW, imgH);
        var logoData;
        try { logoData = lctx.getImageData(0, 0, imgW, imgH); } catch(e) { return null; }
        var lpx = logoData.data;

        var fc = faceColor;
        var bgR = (fc >> 16) & 255, bgG = (fc >> 8) & 255, bgB = fc & 255;
        var outData = new Uint8ClampedArray(fcw * fch * 4);

        /* Para cada pixel do canvas (coords locais do shape):
           pixel (px,py) → posição local (lx_shape, ly_shape)
           → projectar no logo rodado → ler pixel */
        var stepX = pw / fcw, stepY = ph / fch;
        for (var py = 0; py < fch; py++) {
            var localY = minY + py * stepY;
            for (var px = 0; px < fcw; px++) {
                var localX = minX + px * stepX;
                /* coords relativas ao centro do logo, rodadas */
                var dx = localX - cx, dy = localY - cy;
                var lx = dx * cosR + dy * sinR;
                var ly = -dx * sinR + dy * cosR;
                var outIdx = (py * fcw + px) * 4;
                if (lx < -halfW || lx > halfW || ly < -halfH || ly > halfH) {
                    outData[outIdx] = bgR; outData[outIdx+1] = bgG;
                    outData[outIdx+2] = bgB; outData[outIdx+3] = 255;
                } else {
                    var ix = Math.round((lx / logoWmm + 0.5) * imgW - 0.5);
                    var iy = Math.round((ly / logoHmm + 0.5) * imgH - 0.5);
                    ix = Math.max(0, Math.min(imgW-1, ix));
                    iy = Math.max(0, Math.min(imgH-1, iy));
                    var srcIdx = (iy * imgW + ix) * 4;
                    var alpha = lpx[srcIdx+3] / 255;
                    outData[outIdx]   = Math.round(lpx[srcIdx]   * alpha + bgR * (1-alpha));
                    outData[outIdx+1] = Math.round(lpx[srcIdx+1] * alpha + bgG * (1-alpha));
                    outData[outIdx+2] = Math.round(lpx[srcIdx+2] * alpha + bgB * (1-alpha));
                    outData[outIdx+3] = 255;
                }
            }
        }
        var c = document.createElement('canvas');
        c.width = fcw; c.height = fch;
        c.getContext('2d').putImageData(new ImageData(outData, fcw, fch), 0, 0);
        return c;
    }

    /* Aplica o logo de um lado ('front'→_outer, 'back'→_inner) a todos os painéis. */
    function applyLogoForSide(side, callback) {
        if (!_currentGeo) return;
        var sf = logoState[side];
        if (!sf.dataUrl || !sf.dieline) {
            /* Sem logo neste lado — repor cor base nos meshes correspondentes */
            var suffix = side === 'front' ? '_outer' : '_inner';
            var threeSide = side === 'front' ? THREE.FrontSide : THREE.BackSide;
            Object.keys(meshMap).forEach(function(faceKey) {
                if (!faceKey.endsWith(suffix)) return;
                var baseKey = faceKey.replace(suffix, '');
                var fc = faceBaseColor[baseKey] || COL_WALL;
                meshMap[faceKey].material = makeMatSide(fc, threeSide, meshMap[faceKey].userData.order || 0);
            });
            if (callback) callback();
            return;
        }

        var u = _currentGeo.unit || 1;
        var logoPx = sf.sizeMM * u;
        var logoPosInDieline = sf.dieline;
        var savedRot = logoRot;
        var savedStripped = _logoStripped;
        logoRot = sf.rot;           /* buildPanelLogoTexture usa logoRot global */
        _logoStripped = sf.stripped; /* idem para _logoStripped */

        function doApply(img) {
            var nodeLocalMap = {};
            _currentGeo.nodes.forEach(function(node) {
                if (node._localPts && node._svgToLocal) {
                    nodeLocalMap[node.key] = {
                        localPts: node._localPts,
                        svgToLocal: node._svgToLocal,
                        localAngle: node._localAngle || 0,
                    };
                }
            });

            var suffix    = side === 'front' ? '_outer' : '_inner';
            var threeSide = side === 'front' ? THREE.FrontSide : THREE.BackSide;

            Object.keys(meshMap).forEach(function(faceKey) {
                if (!faceKey.endsWith(suffix)) return;
                var baseKey = faceKey.replace(suffix, '');
                var mesh = meshMap[faceKey];
                if (!mesh) return;

                if (faceBaseColor[baseKey] === undefined) {
                    var outerMesh = meshMap[baseKey + '_outer'];
                    faceBaseColor[baseKey] = outerMesh && outerMesh.material && outerMesh.material.color
                        ? outerMesh.material.color.getHex() : COL_WALL;
                }
                var fc = faceBaseColor[baseKey];
                var nodeLocal = nodeLocalMap[baseKey];
                if (!nodeLocal) {
                    mesh.material = makeMatSide(fc, threeSide, mesh.userData.order || 0);
                    return;
                }

                var texCanvas = buildPanelLogoTexture(nodeLocal.localPts, nodeLocal.svgToLocal, nodeLocal.localAngle, fc, img, logoPosInDieline, logoPx);
                if (texCanvas) {
                    var tex = new THREE.CanvasTexture(texCanvas);
                    tex.flipY = false;
                    if (side === 'front') {
                        /* _outer usa FrontSide: UVs crescem com s, mas o _inner com
                           BackSide vê o verso e des-espelha naturalmente. Para _outer
                           aplicar o mesmo efeito, espelhar a textura em U. */
                        tex.repeat.x = -1;
                        tex.offset.x = 1;
                    }
                    normaliseFaceUVs(mesh.geometry);
                    mesh.material = new THREE.MeshLambertMaterial(applyPolyOffset(
                        { map: tex, side: threeSide }, mesh.userData.order || 0));
                } else {
                    mesh.material = makeMatSide(fc, threeSide, mesh.userData.order || 0);
                }
            });

            logoRot = savedRot;
            _logoStripped = savedStripped;
            if (callback) callback();
        }

        if (sf.img && sf.img.complete && sf.img.src === sf.dataUrl) {
            doApply(sf.img);
        } else {
            sf.stripped = null;
            var img = new Image();
            img.onload = function() {
                sf.img = img;
                sf.stripped = stripWhiteBackground(img);
                doApply(img);
            };
            img.src = sf.dataUrl;
        }
    }

    function applyLogoToAllFaces() {
        applyLogoForSide('front');
        applyLogoForSide('back');
    }

    function clearLogo() {
        /* Limpa só o lado activo */
        var sf = ls();
        sf.dataUrl = null; sf.dieline = null; sf.img = null; sf.stripped = null;
        sf.sizeMM = 80; sf.rot = 0;
        syncLegacy();
        applyLogoForSide(logoSide);
        render2dLogo();
    }

    function updateArtworkPanel() {
        var sf = ls();
        var preview  = document.getElementById('atp-artwork-preview');
        var btnRemove = document.getElementById('atp-artwork-remove');
        var has = !!(sf.dataUrl);
        if (preview) {
            preview.src = has ? sf.dataUrl : '';
            preview.style.display = has ? 'block' : 'none';
        }
        if (btnRemove) btnRemove.style.display = has ? '' : 'none';
        var rotRow   = document.getElementById('atp-artwork-rot-row');
        var rotLabel = document.getElementById('atp-artwork-rot-label');
        if (rotRow) rotRow.style.display = has ? '' : 'none';
        if (rotLabel) rotLabel.textContent = (sf.rot || 0) + '°';
        var scaleRow = document.getElementById('atp-artwork-scale-row');
        var scaleLabel = document.getElementById('atp-artwork-scale-label');
        if (scaleRow) scaleRow.style.display = has ? '' : 'none';
        if (scaleLabel) scaleLabel.textContent = Math.round(sf.sizeMM || 80) + 'mm';
        var dragHint = document.getElementById('atp-artwork-drag-hint');
        if (dragHint) dragHint.style.display = has ? '' : 'none';
        var gotoBtn = document.getElementById('atp-goto-logo2d');
        if (gotoBtn) gotoBtn.style.display = has ? '' : 'none';
    }

    /* ── RAYCASTING (apenas hover highlight no 3D — sem drag) ────── */
    function initRaycasting() {
        var raycaster = new THREE.Raycaster();
        var mouse = new THREE.Vector2();
        var hoveredMesh = null;

        var COPLANAR_EPS = 0.5;

        function setEmissive(mesh, hex) {
            if (mesh && mesh.material && mesh.material.emissive) mesh.material.emissive.setHex(hex);
        }
        function hitOrder(h) { return (h.object && h.object.userData && h.object.userData.order) || 0; }
        function facesCamera(h) {
            if (!h.face) return true;
            var n = new THREE.Vector3().copy(h.face.normal).transformDirection(h.object.matrixWorld);
            return n.dot(camera.position.clone().sub(h.point)) > 0;
        }
        function pickVisibleHit(hits) {
            if (!hits.length) return null;
            var visible = hits.filter(facesCamera);
            if (!visible.length) visible = hits;
            var front = visible[0], best = front;
            for (var i = 1; i < visible.length; i++) {
                if (visible[i].distance - front.distance > COPLANAR_EPS) break;
                if (hitOrder(visible[i]) > hitOrder(best)) best = visible[i];
            }
            return best;
        }
        function selectableMeshes() {
            var boxClosed = animT >= 0.95;
            return Object.values(meshMap).filter(function (m) {
                if (m.userData.selectable === false) return false;
                if (boxClosed && m.userData.isHidingFlap) return false;
                return true;
            });
        }
        function getRayHit(e) {
            var rect = c3.getBoundingClientRect();
            mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
            mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
            raycaster.setFromCamera(mouse, camera);
            return pickVisibleHit(raycaster.intersectObjects(selectableMeshes(), false)) || null;
        }

        c3.addEventListener('mousemove', function (e) {
            var vh = getRayHit(e);
            var hit = vh ? vh.object : null;
            if (hit !== hoveredMesh) {
                setEmissive(hoveredMesh, 0x000000);
                hoveredMesh = hit;
                setEmissive(hoveredMesh, 0x1b3a5c);
            }
            c3.style.cursor = hit ? 'pointer' : 'default';
        });
        c3.addEventListener('mouseleave', function () {
            setEmissive(hoveredMesh, 0x000000);
            hoveredMesh = null;
            c3.style.cursor = 'default';
        });
    }

    /* ── VISTA 2D LOGO ──────────────────────────────────────────────
       Renderiza o dieline parametrizado num canvas 2D.
       O logo é arrastável directamente sobre o dieline (coords SVG px).
       Frente = dieline normal; Verso = espelhado horizontalmente.
    ─────────────────────────────────────────────────────────────── */
    var c2logo = null; /* canvas#canvas2dlogo */
    var ctx2logo = null;

    /* Cor do cartão em CSS para o canvas 2D */
    var CARD_FILL   = '#e3d3b8';
    var CARD_STROKE = '#a0895c';
    var FOLD_COLOR  = '#3b82f6';
    var CUT_COLOR   = '#ef4444';

    /* Desenha o dieline no canvas 2D Logo.
       O canvas usa coordenadas de ecrã; o dieline (em px SVG) é transformado
       por: ecrãX = panOffX + svgX * panScale * logo2dZoom
       Usa os nodes e as suas arestas do _currentGeo para desenhar os painéis.
    */
    function render2dLogo() {
        if (!c2logo || !ctx2logo) return;
        syncLegacy(); /* garantir que as vars legadas reflectem o lado activo */
        var cw = c2logo.width, ch = c2logo.height;
        ctx2logo.clearRect(0, 0, cw, ch);
        if (!_currentGeo || !_currentGeo.nodes || !_currentGeo.nodes.length) return;

        /* Calcular bbox total do dieline (todos os pontos) */
        var allMinX = Infinity, allMinY = Infinity, allMaxX = -Infinity, allMaxY = -Infinity;
        _currentGeo.nodes.forEach(function (node) {
            node.points.forEach(function (p) {
                allMinX = Math.min(allMinX, p.x); allMinY = Math.min(allMinY, p.y);
                allMaxX = Math.max(allMaxX, p.x); allMaxY = Math.max(allMaxY, p.y);
            });
        });
        var dlW = allMaxX - allMinX || 1, dlH = allMaxY - allMinY || 1;

        /* Escala base (fit no canvas com margem) */
        var MARGIN = 40;
        var baseScale = Math.min((cw - 2*MARGIN) / dlW, (ch - 2*MARGIN) / dlH);
        var scale = baseScale * logo2dZoom;
        logo2dScale = scale;

        /* Pan: centrado por default (logo2dPan = {0,0} → centrado) */
        var offX = (cw - dlW * scale) / 2 + logo2dPan.x;
        var offY = (ch - dlH * scale) / 2 + logo2dPan.y;
        logo2dOffMM = { x: allMinX - offX / scale, y: allMinY - offY / scale };

        /* Transformação SVG px → canvas px (sem espelho — igual para frente e verso) */
        function tx(svgX) { return offX + (svgX - allMinX) * scale; }
        function ty(svgY) { return offY + (svgY - allMinY) * scale; }

        /* Fundo */
        ctx2logo.fillStyle = '#f8fafc';
        ctx2logo.fillRect(0, 0, cw, ch);

        /* Desenhar cada painel */
        _currentGeo.nodes.forEach(function (node) {
            var pts = node.points;
            if (!pts || pts.length < 2) return;
            ctx2logo.beginPath();
            ctx2logo.moveTo(tx(pts[0].x), ty(pts[0].y));
            for (var i = 1; i < pts.length; i++) ctx2logo.lineTo(tx(pts[i].x), ty(pts[i].y));
            ctx2logo.closePath();
            ctx2logo.fillStyle = CARD_FILL;
            ctx2logo.fill();
            ctx2logo.strokeStyle = CUT_COLOR;
            ctx2logo.lineWidth = 1.5;
            ctx2logo.stroke();
        });

        /* Linhas de dobra (aresta de dobra de cada nó filho) */
        _currentGeo.nodes.forEach(function (node) {
            if (!node.edge) return;
            ctx2logo.beginPath();
            ctx2logo.moveTo(tx(node.edge.x1), ty(node.edge.y1));
            ctx2logo.lineTo(tx(node.edge.x2), ty(node.edge.y2));
            ctx2logo.strokeStyle = FOLD_COLOR;
            ctx2logo.lineWidth = 1.5;
            ctx2logo.setLineDash([6, 4]);
            ctx2logo.stroke();
            ctx2logo.setLineDash([]);
        });

        /* Labels das faces — comentado para não confundir o utilizador
        _currentGeo.nodes.forEach(function (node) {
            var pts = node.points;
            if (!pts || !pts.length) return;
            var cx = 0, cy = 0;
            pts.forEach(function (p) { cx += p.x; cy += p.y; });
            cx /= pts.length; cy /= pts.length;
            var label = node.key.replace(/_/g, ' ');
            ctx2logo.fillStyle = '#64748b';
            ctx2logo.font = Math.max(8, Math.round(scale * 8)) + 'px sans-serif';
            ctx2logo.textAlign = 'center';
            ctx2logo.textBaseline = 'middle';
            ctx2logo.fillText(label, tx(cx), ty(cy));
        });
        */

        /* Logo sobre o dieline */
        if (logoDataUrl && logoDieline) {
            var lx = tx(logoDieline.x), ly = ty(logoDieline.y);
            var u = _currentGeo.unit || 1;
            var lw = logoSizeMM * u * scale;
            var imgH2 = lw;
            if (_logoImg && _logoImg.complete) {
                imgH2 = lw / (_logoImg.naturalWidth / _logoImg.naturalHeight);
            }
            ctx2logo.save();
            ctx2logo.translate(lx, ly);
            ctx2logo.rotate(logoRot * Math.PI / 180);
            ctx2logo.globalAlpha = 0.9;
            if (_logoImg && _logoImg.complete) {
                ctx2logo.drawImage(_logoImg, -lw/2, -imgH2/2, lw, imgH2);
            }
            ctx2logo.globalAlpha = 1;
            /* bounding box do logo */
            ctx2logo.strokeStyle = '#1d4ed8';
            ctx2logo.lineWidth = 1.5;
            ctx2logo.setLineDash([4, 3]);
            ctx2logo.strokeRect(-lw/2, -imgH2/2, lw, imgH2);
            ctx2logo.setLineDash([]);
            /* handle de drag: círculo central */
            ctx2logo.beginPath();
            ctx2logo.arc(0, 0, 6, 0, Math.PI * 2);
            ctx2logo.fillStyle = '#1d4ed8';
            ctx2logo.fill();
            ctx2logo.restore();
        }
    }

    /* Inicializar o canvas 2D Logo e os seus eventos */
    function initLogo2dView() {
        c2logo = document.getElementById('canvas2dlogo');
        if (!c2logo) return;
        ctx2logo = c2logo.getContext('2d');

        /* Ajustar tamanho ao container */
        function resizeLogo2d() {
            var wrap = document.getElementById('atp-logo2d-wrap');
            if (!wrap) return;
            c2logo.width  = wrap.clientWidth  || 800;
            c2logo.height = wrap.clientHeight || 600;
            render2dLogo();
        }
        var resizeObs = window.ResizeObserver ? new ResizeObserver(resizeLogo2d) : null;
        if (resizeObs) resizeObs.observe(document.getElementById('atp-logo2d-wrap') || document.body);
        window.addEventListener('resize', resizeLogo2d);

        /* Converter coords do canvas → SVG px do dieline (frente/verso) */
        function canvasToSvg(canvasX, canvasY) {
            if (!_currentGeo) return { x: 0, y: 0 };
            var allMinX = Infinity, allMinY = Infinity, allMaxX = -Infinity, allMaxY = -Infinity;
            _currentGeo.nodes.forEach(function (node) {
                node.points.forEach(function (p) {
                    allMinX = Math.min(allMinX, p.x); allMinY = Math.min(allMinY, p.y);
                    allMaxX = Math.max(allMaxX, p.x); allMaxY = Math.max(allMaxY, p.y);
                });
            });
            var dlW = allMaxX - allMinX || 1, dlH = allMaxY - allMinY || 1;
            var MARGIN = 40;
            var baseScale = Math.min((c2logo.width - 2*MARGIN) / dlW, (c2logo.height - 2*MARGIN) / dlH);
            var scale = baseScale * logo2dZoom;
            var offX = (c2logo.width  - dlW * scale) / 2 + logo2dPan.x;
            var offY = (c2logo.height - dlH * scale) / 2 + logo2dPan.y;
            var svgX, svgY;
            svgX = allMinX + (canvasX - offX) / scale;
            svgY = allMinY + (canvasY - offY) / scale;
            return { x: svgX, y: svgY };
        }

        /* Detectar se o clique é sobre o logo (para drag vs. pan) */
        function isOverLogo(canvasX, canvasY) {
            var sf = ls();
            if (!sf.dieline || !sf.dataUrl) return false;
            var pt = canvasToSvg(canvasX, canvasY);
            var u = (_currentGeo && _currentGeo.unit) || 1;
            var halfW = ((sf.sizeMM || 80) * u) / 2;
            var halfH = halfW / ((sf.img && sf.img.naturalWidth / sf.img.naturalHeight) || 1);
            var dx = pt.x - sf.dieline.x, dy = pt.y - sf.dieline.y;
            var rad = (sf.rot || 0) * Math.PI / 180;
            var lx = dx * Math.cos(rad) + dy * Math.sin(rad);
            var ly = -dx * Math.sin(rad) + dy * Math.cos(rad);
            return Math.abs(lx) <= halfW * 1.3 && Math.abs(ly) <= halfH * 1.3;
        }

        var dragging = false; /* a arrastar o logo */
        var panning  = false; /* a fazer pan do canvas */
        var dragOff  = { x: 0, y: 0 }; /* offset logo → clique */
        var panStart = { x: 0, y: 0, px: 0, py: 0 };

        c2logo.addEventListener('mousedown', function (e) {
            var rect = c2logo.getBoundingClientRect();
            var cx = e.clientX - rect.left, cy = e.clientY - rect.top;
            if (isOverLogo(cx, cy)) {
                dragging = true;
                var pt = canvasToSvg(cx, cy);
                var sf = ls();
                dragOff.x = pt.x - sf.dieline.x;
                dragOff.y = pt.y - sf.dieline.y;
                c2logo.style.cursor = 'grabbing';
            } else {
                panning = true;
                panStart.x = e.clientX; panStart.y = e.clientY;
                panStart.px = logo2dPan.x; panStart.py = logo2dPan.y;
                c2logo.style.cursor = 'grabbing';
            }
        });

        window.addEventListener('mousemove', function (e) {
            if (!dragging && !panning) return;
            var rect = c2logo.getBoundingClientRect();
            var cx = e.clientX - rect.left, cy = e.clientY - rect.top;
            if (dragging && ls().dieline) {
                var pt = canvasToSvg(cx, cy);
                var sf = ls();
                sf.dieline.x = pt.x - dragOff.x;
                sf.dieline.y = pt.y - dragOff.y;
                syncLegacy();
                render2dLogo();
                applyLogoForSide(logoSide);
            } else if (panning) {
                logo2dPan.x = panStart.px + (e.clientX - panStart.x);
                logo2dPan.y = panStart.py + (e.clientY - panStart.y);
                render2dLogo();
            }
        });

        window.addEventListener('mouseup', function () {
            dragging = false; panning = false;
            if (c2logo) c2logo.style.cursor = ls().dieline ? 'grab' : 'crosshair';
        });

        c2logo.addEventListener('mousemove', function (e) {
            if (dragging || panning) return;
            var rect = c2logo.getBoundingClientRect();
            c2logo.style.cursor = isOverLogo(e.clientX - rect.left, e.clientY - rect.top)
                ? 'grab' : 'crosshair';
        });

        c2logo.addEventListener('wheel', function (e) {
            e.preventDefault();
            var factor = e.deltaY < 0 ? 1.1 : 0.9;
            logo2dZoom = Math.max(0.2, Math.min(8, logo2dZoom * factor));
            render2dLogo();
        }, { passive: false });

        /* Touch */
        var touchStartLogo = null, touchStartPan = null;
        c2logo.addEventListener('touchstart', function (e) {
            if (e.touches.length !== 1) return;
            e.preventDefault();
            var t = e.touches[0];
            var rect = c2logo.getBoundingClientRect();
            var cx = t.clientX - rect.left, cy = t.clientY - rect.top;
            if (isOverLogo(cx, cy)) {
                var pt = canvasToSvg(cx, cy);
                var sf = ls();
                touchStartLogo = { offX: pt.x - sf.dieline.x, offY: pt.y - sf.dieline.y };
            } else {
                touchStartPan = { ex: t.clientX, ey: t.clientY, px: logo2dPan.x, py: logo2dPan.y };
            }
        }, { passive: false });

        c2logo.addEventListener('touchmove', function (e) {
            if (e.touches.length !== 1) return;
            e.preventDefault();
            var t = e.touches[0];
            var rect = c2logo.getBoundingClientRect();
            var cx = t.clientX - rect.left, cy = t.clientY - rect.top;
            if (touchStartLogo && ls().dieline) {
                var pt = canvasToSvg(cx, cy);
                var sf = ls();
                sf.dieline.x = pt.x - touchStartLogo.offX;
                sf.dieline.y = pt.y - touchStartLogo.offY;
                syncLegacy();
                render2dLogo(); applyLogoForSide(logoSide);
            } else if (touchStartPan) {
                logo2dPan.x = touchStartPan.px + (t.clientX - touchStartPan.ex);
                logo2dPan.y = touchStartPan.py + (t.clientY - touchStartPan.ey);
                render2dLogo();
            }
        }, { passive: false });

        c2logo.addEventListener('touchend', function () {
            touchStartLogo = null; touchStartPan = null;
        });

        /* Botões da toolbar */
        var btnFront = document.getElementById('logo2d-side-front');
        var btnBack  = document.getElementById('logo2d-side-back');
        if (btnFront) btnFront.addEventListener('click', function () {
            logoSide = 'front';
            syncLegacy();
            btnFront.classList.add('active'); if (btnBack) btnBack.classList.remove('active');
            render2dLogo();
            updateArtworkPanel();
        });
        if (btnBack) btnBack.addEventListener('click', function () {
            logoSide = 'back';
            syncLegacy();
            btnBack.classList.add('active'); if (btnFront) btnFront.classList.remove('active');
            render2dLogo();
            updateArtworkPanel();
        });
        var btnZIn  = document.getElementById('logo2d-zoom-in');
        var btnZOut = document.getElementById('logo2d-zoom-out');
        var btnZFit = document.getElementById('logo2d-zoom-fit');
        if (btnZIn)  btnZIn.addEventListener('click',  function () { logo2dZoom = Math.min(8, logo2dZoom * 1.25); render2dLogo(); });
        if (btnZOut) btnZOut.addEventListener('click', function () { logo2dZoom = Math.max(0.2, logo2dZoom * 0.8); render2dLogo(); });
        if (btnZFit) btnZFit.addEventListener('click', function () { logo2dZoom = 1; logo2dPan.x = 0; logo2dPan.y = 0; render2dLogo(); });

        resizeLogo2d();
    }

    /* Carregar artwork guardado do backend */
    function loadArtwork(productId) {
        if (!productId) return;
        fetch('/dieline/artwork/load?product_id=' + productId)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                data = data || {};
                var pending = 0;
                ['front', 'back'].forEach(function(side) {
                    var key = side === 'front' ? '__logo__' : '__logo_back__';
                    var s = data[key];
                    if (!s || !s.dataUrl) return;
                    var sf = logoState[side];
                    sf.dataUrl = s.dataUrl;
                    sf.dieline = s.dielineX != null ? { x: s.dielineX, y: s.dielineY } : null;
                    sf.sizeMM  = s.sizeMM || 80;
                    sf.rot     = s.rot    || 0;
                    if (!sf.dieline && _currentGeo) {
                        var allMinX = Infinity, allMaxX = -Infinity, allMinY = Infinity, allMaxY = -Infinity;
                        _currentGeo.nodes.forEach(function (n) { n.points.forEach(function (p) {
                            allMinX = Math.min(allMinX, p.x); allMaxX = Math.max(allMaxX, p.x);
                            allMinY = Math.min(allMinY, p.y); allMaxY = Math.max(allMaxY, p.y);
                        }); });
                        sf.dieline = { x: (allMinX + allMaxX) / 2, y: (allMinY + allMaxY) / 2 };
                    }
                    pending++;
                    var img = new Image();
                    var capSide = side;
                    img.onload = function () {
                        logoState[capSide].img = img;
                        logoState[capSide].stripped = stripWhiteBackground(img);
                        applyLogoForSide(capSide, function() {
                            pending--;
                            if (pending === 0) {
                                syncLegacy();
                                render2dLogo();
                                updateArtworkPanel();
                            }
                        });
                    };
                    img.src = sf.dataUrl;
                });
            })
            .catch(function () {});
    }

    /* Guardar artwork no backend */
    function saveArtwork(productId) {
        if (!productId) return;
        var payload = {};
        var sf = logoState.front;
        if (sf.dataUrl && sf.dieline) {
            payload.__logo__ = {
                dataUrl: sf.dataUrl,
                dielineX: sf.dieline.x, dielineY: sf.dieline.y,
                sizeMM: sf.sizeMM || 80, rot: sf.rot || 0,
            };
        }
        var sb = logoState.back;
        if (sb.dataUrl && sb.dieline) {
            payload.__logo_back__ = {
                dataUrl: sb.dataUrl,
                dielineX: sb.dieline.x, dielineY: sb.dieline.y,
                sizeMM: sb.sizeMM || 80, rot: sb.rot || 0,
            };
        }
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

    /* Carrega artwork a partir de um objecto JSON (usado no preview de encomenda). */
    function loadArtworkFromJson(jsonObj) {
        var data = (typeof jsonObj === 'string') ? JSON.parse(jsonObj) : jsonObj;
        if (!data) return;
        var pending = 0;
        ['front', 'back'].forEach(function(side) {
            var key = side === 'front' ? '__logo__' : '__logo_back__';
            var s = data[key];
            if (!s || !s.dataUrl) return;
            var sf = logoState[side];
            sf.dataUrl = s.dataUrl;
            sf.dieline = s.dielineX != null ? { x: s.dielineX, y: s.dielineY } : null;
            sf.sizeMM  = s.sizeMM || 80;
            sf.rot     = s.rot    || 0;
            if (!sf.dieline && _currentGeo) {
                var allMinX = Infinity, allMaxX = -Infinity, allMinY = Infinity, allMaxY = -Infinity;
                _currentGeo.nodes.forEach(function(n) { n.points.forEach(function(p) {
                    allMinX = Math.min(allMinX, p.x); allMaxX = Math.max(allMaxX, p.x);
                    allMinY = Math.min(allMinY, p.y); allMaxY = Math.max(allMaxY, p.y);
                }); });
                sf.dieline = { x: (allMinX + allMaxX) / 2, y: (allMinY + allMaxY) / 2 };
            }
            pending++;
            var img = new Image();
            var capSide = side;
            img.onload = function() {
                logoState[capSide].img = img;
                logoState[capSide].stripped = stripWhiteBackground(img);
                applyLogoForSide(capSide, function() {
                    pending--;
                    if (pending === 0) { syncLegacy(); render2dLogo(); updateArtworkPanel(); }
                });
            };
            img.src = sf.dataUrl;
        });
    }

    /* Gera um SVG vectorial (string) do dieline com o logo do lado indicado.
       Coordenadas em mm reais. Logo embutido como <image> base64. */
    function exportDielineSVG(side) {
        if (!_currentGeo || !_currentGeo.nodes || !_currentGeo.nodes.length) return '';

        var geo = _currentGeo;
        var unit = geo.unit || 1; /* px por mm no SVG de origem */

        /* Bbox total em coords SVG (mm × unit) */
        var allMinX = Infinity, allMinY = Infinity, allMaxX = -Infinity, allMaxY = -Infinity;
        geo.nodes.forEach(function(node) {
            node.points.forEach(function(p) {
                allMinX = Math.min(allMinX, p.x); allMinY = Math.min(allMinY, p.y);
                allMaxX = Math.max(allMaxX, p.x); allMaxY = Math.max(allMaxY, p.y);
            });
        });
        var dlW = allMaxX - allMinX || 1;
        var dlH = allMaxY - allMinY || 1;

        /* SVG em mm: 1 unit SVG px = 1/unit mm */
        var scaleToMM = 1 / unit;
        var PAD = 5; /* mm de margem */
        var svgW = dlW * scaleToMM + PAD * 2;
        var svgH = dlH * scaleToMM + PAD * 2;

        function r2(n) { return Math.round(n * 100) / 100; }

        /* Converter coord SVG px → mm no output, com espelhamento para frente */
        function mx(svgX) {
            var rel = (svgX - allMinX) * scaleToMM;
            return side === 'front' ? r2(svgW - PAD - rel) : r2(PAD + rel);
        }
        function my(svgY) { return r2(PAD + (svgY - allMinY) * scaleToMM); }

        var lines = [];
        lines.push('<?xml version="1.0" encoding="UTF-8"?>');
        lines.push('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"');
        lines.push('     width="' + r2(svgW) + 'mm" height="' + r2(svgH) + 'mm"');
        lines.push('     viewBox="0 0 ' + r2(svgW) + ' ' + r2(svgH) + '">');

        /* Estilos */
        lines.push('<style>');
        lines.push('.panel{fill:#f0ede8;stroke:#cc2200;stroke-width:0.3}');
        lines.push('.fold{stroke:#0066cc;stroke-width:0.3;stroke-dasharray:2,1.5;fill:none}');
        lines.push('.label{font:2px sans-serif;fill:#64748b;text-anchor:middle;dominant-baseline:middle}');
        lines.push('</style>');

        /* Painéis */
        lines.push('<g id="panels">');
        geo.nodes.forEach(function(node) {
            var pts = node.points;
            if (!pts || pts.length < 2) return;
            var ptStr = pts.map(function(p) { return mx(p.x) + ',' + my(p.y); }).join(' ');
            lines.push('<polygon class="panel" points="' + ptStr + '"/>');
        });
        lines.push('</g>');

        /* Linhas de dobra */
        lines.push('<g id="folds">');
        geo.nodes.forEach(function(node) {
            if (!node.edge) return;
            lines.push('<line class="fold" x1="' + mx(node.edge.x1) + '" y1="' + my(node.edge.y1) +
                '" x2="' + mx(node.edge.x2) + '" y2="' + my(node.edge.y2) + '"/>');
        });
        lines.push('</g>');

        /* Labels */
        lines.push('<g id="labels">');
        geo.nodes.forEach(function(node) {
            var pts = node.points;
            if (!pts || !pts.length) return;
            var cx = 0, cy = 0;
            pts.forEach(function(p) { cx += p.x; cy += p.y; });
            cx /= pts.length; cy /= pts.length;
            var label = node.key.replace(/_/g, ' ');
            lines.push('<text class="label" x="' + mx(cx) + '" y="' + my(cy) + '">' +
                label.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</text>');
        });
        lines.push('</g>');

        /* Logo */
        var st = logoState[side];
        if (st && st.dataUrl && st.dieline) {
            var logoImg = st.img;
            var logoPosX = st.dieline.x; /* coords SVG px */
            var logoPosY = st.dieline.y;
            var logoSizePxMM = st.sizeMM || 80; /* mm */
            var logoAspect = (logoImg && logoImg.naturalWidth && logoImg.naturalHeight)
                ? (logoImg.naturalWidth / logoImg.naturalHeight) : 1;
            var logoWmm = logoSizePxMM;
            var logoHmm = logoSizePxMM / logoAspect;
            var logoXmm = mx(logoPosX);
            var logoYmm = my(logoPosY);
            var rot = st.rot || 0;
            lines.push('<image href="' + st.dataUrl + '"' +
                ' x="' + r2(logoXmm - logoWmm / 2) + '"' +
                ' y="' + r2(logoYmm - logoHmm / 2) + '"' +
                ' width="' + r2(logoWmm) + '"' +
                ' height="' + r2(logoHmm) + '"' +
                (rot ? ' transform="rotate(' + r2(rot) + ' ' + r2(logoXmm) + ' ' + r2(logoYmm) + ')"' : '') +
                '/>');
        }

        lines.push('</svg>');
        return lines.join('\n');
    }

    /* Grava a configuração actual na sale.order.dieline e devolve uma Promise
       com o ID do registo criado. Chamado antes do "Add to Cart". */
    function saveOrderDieline() {
        var artworkPayload = {};
        var sf = logoState.front;
        if (sf.dataUrl && sf.dieline) {
            artworkPayload.__logo__ = {
                dataUrl: sf.dataUrl,
                dielineX: sf.dieline.x, dielineY: sf.dieline.y,
                sizeMM: sf.sizeMM || 80, rot: sf.rot || 0,
            };
        }
        var sb = logoState.back;
        if (sb.dataUrl && sb.dieline) {
            artworkPayload.__logo_back__ = {
                dataUrl: sb.dataUrl,
                dielineX: sb.dieline.x, dielineY: sb.dieline.y,
                sizeMM: sb.sizeMM || 80, rot: sb.rot || 0,
            };
        }
        var iL = document.getElementById('iL');
        var iW = document.getElementById('iW');
        var iH = document.getElementById('iH');
        var svgF = exportDielineSVG('front');
        var svgB = exportDielineSVG('back');
        console.log('[dieline] svg_front len=' + svgF.length + ' svg_back len=' + svgB.length + ' geo nodes=' + (_currentGeo ? _currentGeo.nodes.length : 'null'));
        var params = {
            product_id:   _cfg.productId || 0,
            box_type:     _cfg.boxType   || '',
            box_l:        iL ? parseFloat(iL.value) || _cfg.L : _cfg.L,
            box_w:        iW ? parseFloat(iW.value) || _cfg.W : _cfg.W,
            box_h:        iH ? parseFloat(iH.value) || _cfg.H : _cfg.H,
            artwork_json: JSON.stringify(artworkPayload),
            svg_front:    svgF,
            svg_back:     svgB,
        };
        return fetch('/dieline/order/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: params }),
        })
        .then(function(r) { return r.json(); })
        .then(function(res) { return res.result || {}; });
    }


    /* ── WIRING ─────────────────────────────────────────────────── */
    function wire(id, fn) { var el = document.getElementById(id); if (el) el.addEventListener('click', fn); }

    wire('ctrl-3d',     function () { setView('3d'); });
    wire('ctrl-2d',     function () { setView('2d'); });
    wire('ctrl-logo2d', function () { setView('logo2d'); });
    wire('atp-goto-logo2d', function () { setView('logo2d'); });
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
        /* Garante o sufixo _panel SEM duplicar. As chamadas passam o id ora com
           _panel (ex.: 'lid_panel') ora sem ('front'); normalizamos aqui para o
           id final terminar EXACTAMENTE em '_panel'. Sem isto gerava-se
           'front_panel_panel', o parser só removia um '_panel' e as keys ficavam
           erradas (front_panel em vez de front) — partindo a deteção de flaps/
           abas/lid no rebuild. */
        function panelId(id) {
            return /_panel$/.test(id) ? id : (id + '_panel');
        }
        function rect(id, x, y, w, h, extra) {
            return '<rect id="' + panelId(id) + '" x="' + r2(x) + '" y="' + r2(y) + '" width="' + r2(w) + '" height="' + r2(h) + '" ' + (extra || '') + '/>';
        }
        function polygon(id, pts, extra) {
            var s = pts.map(function (p) { return r2(p.x) + ',' + r2(p.y); }).join(' ');
            return '<polygon id="' + panelId(id) + '" points="' + s + '" ' + (extra || '') + '/>';
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
            if (_cfg.boxType) svgText = _generators.generate(_cfg.boxType, L, W, H);
            if (!svgText) svgText = svgTextCache;
            if (!svgText) return;
            var geo = DielineParser.build(svgText);
            if (!geo.nodes || !geo.nodes.length) return;
            stopAnim(); animT = 0; animDir = 1; updateSlider(0);
            buildFromGeometry(geo);
            sph.r = Math.max(ZOOM_DEFAULT, sceneSize * 2.5);
            updateCam();
            render2dLogo();
            applyLogoToAllFaces();
        },
    };

    /* ── BOOT ───────────────────────────────────────────────────── */
    function boot() {
        if (typeof THREE === 'undefined') { console.error('Three.js não carregado'); return; }
        initThree();
        initLogo2dView();

        var btnApply = document.getElementById('btnApply');
        if (btnApply) {
            btnApply.addEventListener('click', function () {
                var L = parseFloat(document.getElementById('iL').value) || 0;
                var W = parseFloat(document.getElementById('iW').value) || 0;
                var H = parseFloat(document.getElementById('iH').value) || 0;
                window.ATP_DIELINE.rebuild(L, W, H);
            });
        }

        /* Upload de imagem — coloca logo centrado no dieline e muda para a vista 2D Logo */
        var fileArtwork = document.getElementById('fileArtwork');
        if (fileArtwork) {
            fileArtwork.addEventListener('change', function () {
                if (!this.files[0]) return;
                var reader = new FileReader();
                var fileName = this.files[0].name;
                reader.onload = function (ev) {
                    /* Guardar no estado do lado activo */
                    var sf = ls();
                    sf.dataUrl = ev.target.result;
                    sf.sizeMM  = 80;
                    sf.rot     = 0;
                    /* Centrar o logo no centro geométrico do dieline */
                    if (_currentGeo) {
                        var allMinX = Infinity, allMaxX = -Infinity, allMinY = Infinity, allMaxY = -Infinity;
                        _currentGeo.nodes.forEach(function (n) { n.points.forEach(function (p) {
                            allMinX = Math.min(allMinX, p.x); allMaxX = Math.max(allMaxX, p.x);
                            allMinY = Math.min(allMinY, p.y); allMaxY = Math.max(allMaxY, p.y);
                        }); });
                        sf.dieline = { x: (allMinX + allMaxX) / 2, y: (allMinY + allMaxY) / 2 };
                        /* tamanho proporcional ao dieline (≈20% da largura) */
                        var u = _currentGeo.unit || 1;
                        sf.sizeMM = Math.round((allMaxX - allMinX) * 0.20 / u);
                        sf.sizeMM = Math.max(10, Math.min(200, sf.sizeMM));
                    } else {
                        sf.dieline = { x: 0, y: 0 };
                    }
                    sf.img = null; sf.stripped = null;
                    var img = new Image();
                    img.onload = function () {
                        sf.img = img;
                        sf.stripped = stripWhiteBackground(img);
                        syncLegacy();
                        applyLogoForSide(logoSide);
                        render2dLogo();
                        updateArtworkPanel();
                    };
                    img.src = sf.dataUrl;
                    var name = document.getElementById('artworkName');
                    if (name) name.textContent = fileName;
                    /* Ir direto para a vista 2D Logo */
                    setView('logo2d');
                };
                reader.readAsDataURL(this.files[0]);
                this.value = '';
            });
        }

        var btnRemove = document.getElementById('atp-artwork-remove');
        if (btnRemove) {
            btnRemove.addEventListener('click', function () {
                clearLogo();
                updateArtworkPanel();
            });
        }

        function rotateArtwork(delta) {
            var sf = ls();
            if (!sf.dataUrl) return;
            sf.rot = (((sf.rot || 0) + delta) % 360 + 360) % 360;
            syncLegacy();
            render2dLogo();
            applyLogoForSide(logoSide);
            updateArtworkPanel();
        }

        var btnRotCCW = document.getElementById('atp-artwork-rot-ccw');
        if (btnRotCCW) btnRotCCW.addEventListener('click', function () { rotateArtwork(-90); });
        var btnRotCW = document.getElementById('atp-artwork-rot-cw');
        if (btnRotCW) btnRotCW.addEventListener('click', function () { rotateArtwork(90); });

        function scaleArtwork(factor) {
            var sf = ls();
            if (!sf.dataUrl) return;
            sf.sizeMM = Math.max(5, (sf.sizeMM || 80) * factor);
            syncLegacy();
            render2dLogo();
            applyLogoForSide(logoSide);
            updateArtworkPanel();
        }

        var btnScaleDown = document.getElementById('atp-artwork-scale-down');
        if (btnScaleDown) btnScaleDown.addEventListener('click', function () { scaleArtwork(0.9); });
        var btnScaleUp = document.getElementById('atp-artwork-scale-up');
        if (btnScaleUp) btnScaleUp.addEventListener('click', function () { scaleArtwork(1.1); });

        var btnSaveArtwork = document.getElementById('atp-artwork-save');
        if (btnSaveArtwork) {
            btnSaveArtwork.addEventListener('click', function () { saveArtwork(_cfg.productId); });
        }

        initRaycasting();

        /* Interceptar o Add to Cart — gravar config dieline antes de submeter */
        var cartForm = document.getElementById('atp-cart-form');
        if (cartForm) {
            cartForm.addEventListener('submit', function(e) {
                if (_cfg.readonlyMode) return; /* preview: submeter normalmente */
                e.preventDefault();
                var btn = document.getElementById('atp-btn-addcart');
                if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa fa-spinner fa-spin me-2"/>A guardar...'; }
                saveOrderDieline()
                    .then(function(res) {
                        var configInput = document.getElementById('cart-dieline-config-id');
                        if (configInput && res.dieline_config_id) {
                            configInput.value = res.dieline_config_id;
                        }
                        cartForm.submit();
                    })
                    .catch(function() {
                        /* Se falhar, submeter na mesma sem config */
                        cartForm.submit();
                    });
            });
        }

        var url = _cfg.dielineSvgUrl;
        if (!url) { showEmpty('Este produto não tem dieline SVG.'); return; }
        if (typeof DielineParser === 'undefined') { console.error('DielineParser não carregado'); return; }

        fetch(url)
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
            .then(function (text) {
                svgTextCache = text;
                var geo = DielineParser.build(text);
                if (!geo.nodes || !geo.nodes.length) { showEmpty('Dieline sem painéis válidos.'); return; }
                /* Em preview de encomenda as medidas vêm da order (já nos inputs via
                   t-att-value); não sobrescrever com os defaults do SVG do produto. */
                if (!_cfg.readonlyMode && geo.meta && geo.meta.length && geo.meta.width && geo.meta.height) {
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
                if (_cfg.orderArtworkJson) {
                    /* Modo preview de encomenda: carregar artwork da config guardada */
                    loadArtworkFromJson(_cfg.orderArtworkJson);
                } else {
                    loadArtwork(_cfg.productId);
                }
            })
            .catch(function (err) {
                console.error('[dieline] falha a carregar SVG:', err.message);
                showEmpty('Não foi possível carregar o dieline.');
            });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

})();
