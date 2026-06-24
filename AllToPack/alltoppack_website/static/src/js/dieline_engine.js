/* ================================================================
   AllToPack — dieline_engine.js  (v6 — 3D Solver genérico por tipo)

   A geometria 3D é DERIVADA inteiramente do SVG-dieline do produto:
   o parser (+ TemplateMapper) entrega uma árvore de painéis com
   foldSign e animGroup já calculados por tipo FEFCO. O engine é
   puramente genérico: não tem lógica específica de caixa.

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
    var flatSize = ZOOM_DEFAULT;
    /* Rotação livre sem gimbal lock: quaternion acumulado no boxPivot (inicializado em initThree) */
    var rotQuat = null;

    /* árvore de dobras montada: lista de { node, pivot, foldSign, axis } */
    var folds = [];
    var svgTextCache = null;
    var meshMap = {};
    var _currentGeo = null;

    /* geo activo — necessário para o Logo2D e para o rebuild */
    var _activeGeo = null;

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
        _activeGeo = geo;
        clearScene();

        /* boxPivot: fica na ORIGEM, só recebe a rotação do utilizador.
           boxGroup: filho do pivot, deslocado para que o centro geométrico
           da caixa coincida com a origem — assim a rotação é sobre si próprio. */
        boxPivot = new THREE.Group();
        boxGroup = new THREE.Group();
        boxPivot.add(boxGroup);
        scene.add(boxPivot);

        /* Rotação inicial: 90° em X para que a dieline planificada fique de frente
           para a câmara (igual à vista SVG 2D: X=direita, Y=baixo). */
        if (rotQuat) {
            rotQuat.setFromEuler(new THREE.Euler(Math.PI, 0, 0));
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
        var rootArea = polyArea(rootNode.points);

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

        /* flatSize = bounding box de todos os nodes no plano planificado.
           Usado para o zoom inicial mostrar a dieline completa. */
        var fxMin=Infinity,fxMax=-Infinity,fyMin=Infinity,fyMax=-Infinity;
        geo.nodes.forEach(function(n){ n.points.forEach(function(p){
            var sx=mm(p.x-off.x), sy=mm(p.y-off.y);
            if(sx<fxMin)fxMin=sx; if(sx>fxMax)fxMax=sx;
            if(sy<fyMin)fyMin=sy; if(sy>fyMax)fyMax=sy;
        }); });
        flatSize = Math.max(fxMax-fxMin, fyMax-fyMin, sceneSize);

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

        /* Ordenar nodes em ordem topológica — pai antes de filho.
           O TemplateMapper pode mudar parentKey, quebrando a ordem original. */
        var _topoSorted = (function(nodes) {
            var byKey = {};
            nodes.forEach(function(n) { byKey[n.key] = n; });
            var result = [], visited = {};
            function visit(n) {
                if (visited[n.key]) return;
                visited[n.key] = true;
                if (n.parentKey && byKey[n.parentKey]) visit(byKey[n.parentKey]);
                result.push(n);
            }
            nodes.forEach(function(n) { visit(n); });
            return result;
        })(geo.nodes);

        _topoSorted.forEach(function (node) {
            /* Os filhos penduram no FOLDGROUP do pai (para acompanharem a
               dobra do pai). groups[key] = { attach, restWorld }. */
            var parent = node.parentKey ? groups[node.parentKey] : null;
            var parentAttach = parent ? parent.attach : boxGroup;

            var color = node.angle >= 135 ? COL_LID : COL_WALL;

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
                /* local(s,d) → SVG(x,y): inversa trivial */
                node._localToSvg = (function(captOff, captMm) {
                    var invMm = 1 / captMm(1);
                    return function(s, d) {
                        return { x: s * invMm + captOff.x, y: d * invMm + captOff.y };
                    };
                }(off, mm));
                node._localAngle = 0;
                node._localPts = node.points.map(function(p) {
                    return { x: mm(p.x - off.x), y: mm(p.y - off.y) };
                });
                node._texYInvert = true; /* root: rotation.x=PI/2 inverte UV-v */
                return;
            }

            var built = buildChild(node, parentAttach, off, mm, sceneOf, parent.restWorld, color, rootArea);
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
    function buildChild(node, parentAttach, off, mm, sceneOf, parentRestWorld, color, rootArea) {
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

        /* foldSign vem do TemplateMapper no parser — não recalculado aqui. */
        var foldSign = (node.foldSign !== undefined) ? node.foldSign : -1;

        /* restWorld do FILHO (no chão): mapeia o SHAPE (s,d,0) → mundo.
           s → û ; d → n̂. Base ORTONORMAL DIREITA { X=û, Y=n̂, Z=û×n̂ }
           (det=+1, senão setFromRotationMatrix devolve lixo). */
        var zHat = new THREE.Vector3().crossVectors(uHat, nHat);
        /* faceFlipped = true quando a face _outer (FrontSide, z=+halfT) ficaria
           virada para o interior. Dois factores contribuem:
           1. zHat.y < 0 → o normal do mesh aponta para baixo (interior)
           2. foldSign === 1 → a dobra é para dentro, invertendo qual face fica exposta
           Os dois efeitos são independentes e combinam por XOR. */
        var faceFlipped = (zHat.y < 0);
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
        /* Se faceFlipped, inverter Z do grupo do mesh para que _outer (FrontSide)
           fique do lado correcto sem alterar a base, o pivot ou a animação. */
        var meshGroup = new THREE.Group();
        if (faceFlipped) meshGroup.scale.z = -1;
        foldGroup.add(meshGroup);
        var mesh = shapeMesh(pts2d, color, node.key, node.stackOrder || 0);
        meshGroup.add(mesh);

        /* label de debug — número do painel centrado na face */
        (function() {
            var cv = document.createElement('canvas'); cv.width = 256; cv.height = 256;
            var ctx = cv.getContext('2d');
            ctx.fillStyle = 'rgba(255,230,0,0.92)'; ctx.fillRect(0,0,256,256);
            ctx.fillStyle = '#000'; ctx.font = 'bold 160px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText(node.key.replace('panel_','p'), 128, 190);
            var lbl = new THREE.Mesh(
                new THREE.PlaneGeometry(30, 30),
                new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true, side: THREE.DoubleSide })
            );
            var cx = 0, cy = 0;
            pts2d.forEach(function(p){ cx+=p.x; cy+=p.y; });
            lbl.position.set(cx/pts2d.length, cy/pts2d.length, 3);
            lbl.renderOrder = 999;
            foldGroup.add(lbl);
        })();

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
        /* local(s,d) → SVG(x,y): world = A + s*û + d*n̂; svgX = world.x/mm(1)+off.x, svgY = world.z/mm(1)+off.y */
        node._localToSvg = (function(captA, captUHat, captNHat, captOff, captMm) {
            var invMm = 1 / captMm(1);
            return function(s, d) {
                return {
                    x: (captA.x + s * captUHat.x + d * captNHat.x) * invMm + captOff.x,
                    y: (captA.z + s * captUHat.z + d * captNHat.z) * invMm + captOff.y
                };
            };
        }(A.clone(), uHat.clone(), nHat.clone(), off, mm));
        node._localAngle = localAngle;
        node._localPts = pts2d.map(function(v) { return { x: v.x, y: v.y }; });
        node._texYInvert = false; /* filhos: referencial correcto, sem inversão UV-v */

        /* animGroup vem do TemplateMapper — não há heurísticas aqui. */
        folds.push({
            pivot: foldGroup, angle: node.angle, sign: foldSign,
            depth: node.depth || 0,
            animGroup: (node.animGroup !== undefined) ? node.animGroup : 0,
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

    /* shoelace — área assinada em coords SVG (Y-down). */
    function polySignedArea(pts) {
        var a = 0;
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i], q = pts[(i + 1) % pts.length];
            a += p.x * q.y - q.x * p.y;
        }
        return a / 2;
    }
    function polyArea(pts) { return Math.abs(polySignedArea(pts)); }

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

       Usa node.animGroup (vem do TemplateMapper no parser) como chave de ordem.
       Grupos com animGroup menor dobram primeiro; grupos iguais animam juntos.
       As janelas são distribuídas uniformemente em [0,1] com OVERLAP para que
       cada grupo comece enquanto o anterior ainda dobra (animação contínua). */
    var OVERLAP_GROW = 1.6;

    function calcFoldWindows() {
        if (!folds.length) return;

        /* Comprimir os valores de animGroup em ranks consecutivos 0,1,2,…
           eliminando gaps (evita pausas entre grupos). */
        var groups = [];
        for (var i = 0; i < folds.length; i++) {
            var g = folds[i].animGroup || 0;
            if (groups.indexOf(g) === -1) groups.push(g);
        }
        groups.sort(function (a, b) { return a - b; });
        var rankOf = {};
        groups.forEach(function (g, idx) { rankOf[g] = idx; });
        var numRanks = groups.length;

        var step = numRanks > 1 ? 1 / (numRanks - 1 + (OVERLAP_GROW - 1)) : 1;
        var winW = step * OVERLAP_GROW;

        for (var j = 0; j < folds.length; j++) {
            var rank = rankOf[folds[j].animGroup || 0];
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
        var is3d    = v === '3d';
        var is2d    = v === '2d';
        var isLogo  = v === 'logo2d';
        var logo2dEl = document.getElementById('atp-logo2d-view');
        if (c3)       c3.style.display       = is3d   ? 'block' : 'none';
        if (view2d)   view2d.style.display   = is2d   ? 'flex'  : 'none';
        if (logo2dEl) logo2dEl.style.display = isLogo ? 'flex'  : 'none';
        if (hint)     hint.style.display     = is3d   ? ''      : 'none';
        var b3 = document.getElementById('ctrl-3d');     if (b3) b3.classList.toggle('active', is3d);
        var b2 = document.getElementById('ctrl-2d');     if (b2) b2.classList.toggle('active', is2d);
        var bL = document.getElementById('ctrl-logo2d'); if (bL) bL.classList.toggle('active', isLogo);
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
        c3.addEventListener('mousedown', function (e) {
            drag = true; prev = { x: e.clientX, y: e.clientY };
        });
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



    /* Grava a configuração actual na sale.order.dieline e devolve uma Promise
       com o ID do registo criado. Chamado antes do "Add to Cart". */
    function saveOrderDieline() {
        var artworkPayload = (window.ATP_LOGO2D && window.ATP_LOGO2D.exportLogoState)
            ? window.ATP_LOGO2D.exportLogoState()
            : {};
        var iL = document.getElementById('iL');
        var iW = document.getElementById('iW');
        var iH = document.getElementById('iH');
        var params = {
            product_id:   _cfg.productId || 0,
            box_type:     _cfg.type      || '',
            box_l:        iL ? parseFloat(iL.value) || _cfg.L : _cfg.L,
            box_w:        iW ? parseFloat(iW.value) || _cfg.W : _cfg.W,
            box_h:        iH ? parseFloat(iH.value) || _cfg.H : _cfg.H,
            artwork_json: JSON.stringify(artworkPayload),
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
    wire('ctrl-anim', function () { animPlaying ? stopAnim() : startAnim(); });
    wire('ctrl-rotate', function () { autoRotate = !autoRotate; var el = document.getElementById('ctrl-rotate'); if (el) el.classList.toggle('active', autoRotate); });
    wire('ctrl-zoom-in',  function () { sph.r = Math.max(ZOOM_MIN, sph.r - sceneSize * 0.08); updateCam(); });
    wire('ctrl-zoom-out', function () { sph.r = Math.min(ZOOM_MAX, sph.r + sceneSize * 0.08); updateCam(); });
    wire('ctrl-reset', function () {
        stopAnim(); animT = 0; animDir = 1; updateSlider(0); updateFolds(0);
        if (rotQuat && boxPivot) {
            rotQuat.setFromEuler(new THREE.Euler(Math.PI, 0, 0));
            boxPivot.quaternion.copy(rotQuat);
        }
        sph.r = (flatSize / 2) / Math.tan((45 / 2) * Math.PI / 180) * 1.7; updateCam();
    });

    var slider = document.getElementById('animSlider');
    if (slider) slider.addEventListener('input', function () {
        stopAnim();
        animT = parseInt(this.value, 10) / 100;
        updateSlider(this.value);
        updateFolds(animT);
    });

    window.addEventListener('resize', function () { fitPageHeight(); resizeRenderer(); updateCam(); });


    /* ── Texturas de logo no 3D ─────────────────────────────────────
       Aplica/remove um canvas 2D como textura num mesh específico.
       meshKey = 'panel_X_outer' ou 'panel_X_inner'
       ─────────────────────────────────────────────────────────────── */
    /* Normaliza os UVs de um BufferGeometry para [0,1]×[0,1] com base no bbox actual.
       ShapeGeometry r128 gera UVs em coordenadas locais (mm) — não normalizados. */
    function normaliseUVs(geometry) {
        var uvAttr = geometry.attributes.uv;
        if (!uvAttr) return;
        var uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (var i = 0; i < uvAttr.count; i++) {
            var u = uvAttr.getX(i), v = uvAttr.getY(i);
            if (u < uMin) uMin = u; if (u > uMax) uMax = u;
            if (v < vMin) vMin = v; if (v > vMax) vMax = v;
        }
        var uRange = uMax - uMin || 1, vRange = vMax - vMin || 1;
        for (var j = 0; j < uvAttr.count; j++) {
            uvAttr.setXY(j,
                (uvAttr.getX(j) - uMin) / uRange,
                (uvAttr.getY(j) - vMin) / vRange
            );
        }
        uvAttr.needsUpdate = true;
    }

    /* O root usa rotation.x=PI/2 dentro do boxGroup (rotation.x=-PI/2) +
       boxPivot(PI) — a combinação faz _outer ficar na face exterior, ao
       contrário dos filhos onde _inner é o exterior. Corrigir aqui. */
    function _resolveRootSuffix(meshKey) {
        if (!_activeGeo) return meshKey;
        var rootKey = _activeGeo.rootKey;
        if (!rootKey) return meshKey;
        /* meshKey = 'panel_X_inner' ou 'panel_X_outer' */
        var innerSuffix = '_inner', outerSuffix = '_outer';
        if (meshKey === rootKey + innerSuffix) return rootKey + outerSuffix;
        if (meshKey === rootKey + outerSuffix) return rootKey + innerSuffix;
        return meshKey;
    }

    function applyLogoTexture(meshKey, sourceCanvas) {
        meshKey = _resolveRootSuffix(meshKey);
        var mesh = meshMap[meshKey];
        if (!mesh || !mesh.material) return;
        /* Normalizar UVs na primeira vez (ShapeGeometry r128 gera UVs em mm, não [0,1]) */
        if (!mesh._uvsNormalised) {
            normaliseUVs(mesh.geometry);
            mesh._uvsNormalised = true;
        }
        /* Descartar textura anterior */
        if (mesh._logoTex) { mesh._logoTex.dispose(); mesh._logoTex = null; }
        var tex = new THREE.CanvasTexture(sourceCanvas);
        tex.flipY = false;
        tex.needsUpdate = true;
        mesh._logoTex = tex;
        var side = mesh.material.side;
        mesh.material.dispose();
        mesh.material = new THREE.MeshLambertMaterial(applyPolyOffset({
            map: tex, side: side,
        }, mesh.userData.order || 0));
    }

    function clearLogoTexture(meshKey) {
        meshKey = _resolveRootSuffix(meshKey);
        var mesh = meshMap[meshKey];
        if (!mesh || !mesh.material) return;
        if (mesh._logoTex) { mesh._logoTex.dispose(); mesh._logoTex = null; }
        /* Restaurar material base (cor kartão) */
        var color  = (mesh.name && /_outer$/.test(mesh.name)) ? COL_WALL : COL_WALL;
        mesh.material = makeMatSide(color, mesh.material.side, mesh.userData.order || 0);
        mesh.material.needsUpdate = true;
    }

    /* API mínima exposta (debug / testes headless) */
    window.ATP_DIELINE = {
        get scene() { return scene; },
        get folds() { return folds; },
        getGeo:     function () { return _activeGeo; },
        getMeshMap: function () { return meshMap; },
        setView:    setView,
        applyLogoTexture: applyLogoTexture,
        clearLogoTexture: clearLogoTexture,
        setFold: function (t) { animT = t; updateFolds(t); },
        rebuild: function (L, W, H) {
            var svgText = svgTextCache;
            if (!svgText) return;
            var geo = DielineParser.build(svgText, _cfg.type || 'GENERIC');
            if (!geo.nodes || !geo.nodes.length) return;
            /* SVGs da BD estão em escala real (1 px = 1 mm, geo.unit=1).
               Referência original: maior dimensão do panel_0 em px (= mm).
               Se _cfg.L/W/H estiverem preenchidos usa-os; senão usa bbox do panel_0. */
            var userMax = Math.max(L || 0, W || 0, H || 0);
            if (userMax > 0) {
                var origMax = Math.max(_cfg.L || 0, _cfg.W || 0, _cfg.H || 0);
                if (origMax <= 0 && geo.nodes[0]) {
                    var rbb = DielineParser._bbox(geo.nodes[0].points);
                    origMax = Math.max(rbb.w, rbb.h);
                }
                if (origMax > 0) {
                    geo.unit = origMax / userMax;
                }
            }
            stopAnim(); animT = 0; animDir = 1; updateSlider(0);
            buildFromGeometry(geo);
            /* não resetar sph.r — o utilizador vê a diferença de tamanho */
            updateCam();
            if (window.ATP_LOGO2D && window.ATP_LOGO2D.onGeoReady) {
                window.ATP_LOGO2D.onGeoReady(geo, svgText);
            }
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
                var geo = DielineParser.build(text, _cfg.type || 'GENERIC');
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
                sph.r = (flatSize / 2) / Math.tan((45 / 2) * Math.PI / 180) * 1.7;
                updateCam();
                /* Notificar o Logo2D após o geo estar montado */
                if (window.ATP_LOGO2D && window.ATP_LOGO2D.onGeoReady) {
                    window.ATP_LOGO2D.onGeoReady(geo, text);
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
