/* ================================================================
   AllToPack — dieline_engine.js  (v3 — autocontido)

   Começa PLANIFICADO (t=0). Ao carregar Play, dobra para 3D.

   Hierarquia de dobras (cada painel dobra sobre a aresta partilhada
   com o seu "pai"):

       base (chão, fixo no plano XZ)
        ├── front  (dobra na aresta da frente)
        ├── back   (dobra na aresta de trás)
        │    └── lid (dobra no topo da parede de trás)
        ├── left   (dobra na aresta esquerda)
        └── right  (dobra na aresta direita)

   t=0.0 → tudo plano (rotações = 0)
   t=0.5 → 4 paredes verticais (caixa montada, tampa por cima fechada)
   t=1.0 → tampa aberta
   ================================================================ */
(function () {
    'use strict';

    const _cfg = window.ATP_CONFIG || {};

    /* dimensões em mm */
    let L = _cfg.L || 300;
    let W = _cfg.W || 200;
    let H = _cfg.H || 120;

    let animT = 0, animPlaying = false, animDir = 1, animRAF = null;
    let autoRotate = false, currentView = '3d';

    const ZOOM_MIN = 150, ZOOM_MAX = 5000, ZOOM_DEFAULT = 1400;

    /* DOM */
    const c3     = document.getElementById('canvas3d');
    const view2d = document.getElementById('atp-2d-view');
    const img2d  = document.getElementById('atp-2d-img');
    const hint   = document.getElementById('atp-viewer-hint');
    if (img2d && _cfg.dielineSvgUrl) img2d.src = _cfg.dielineSvgUrl;

    /* Three */
    let scene, camera, renderer, boxGroup, axesHelper;
    const sph = { theta: 0.9, phi: 1.0, r: ZOOM_DEFAULT };

    /* pivots das dobras */
    let pBase, pFront, pBack, pLeft, pRight, pLid;

    const COL_BASE  = 0xf5c842;
    const COL_WALL  = 0xf7d05a;
    const COL_LID   = 0xe8a020;

    function makeMat(color) {
        return new THREE.MeshLambertMaterial({
            color, side: THREE.DoubleSide,
            transparent: true, opacity: 0.95,
        });
    }

    /* Cria uma malha rectangular w×h cujo "fundo" (y=0 local) está na
       origem do grupo, de modo a que a aresta de baixo coincida com o
       eixo de rotação do pivot. */
    function panel(w, h, color) {
        const geo = new THREE.PlaneGeometry(w, h);
        geo.translate(0, h / 2, 0);          /* aresta de baixo em y=0 */
        return new THREE.Mesh(geo, makeMat(color));
    }

    function ease(t) { return t < 0.5 ? 2*t*t : -1+(4-2*t)*t; }

    /* ════════════════════════════════════════════════════════════
       CONSTRUÇÃO
       ════════════════════════════════════════════════════════════ */
    function buildBox() {
        if (boxGroup) scene.remove(boxGroup);
        boxGroup = new THREE.Group();
        scene.add(boxGroup);

        buildAxes();

        /* ── BASE: plano L×W deitado no chão (XZ) no PRIMEIRO OCTANTE ──
           Cantos de (0,0,0) a (L,0,W). Centro em (L/2, 0, W/2). */
        pBase = new THREE.Group();
        boxGroup.add(pBase);
        const baseGeo = new THREE.PlaneGeometry(L, W);
        const baseMesh = new THREE.Mesh(baseGeo, makeMat(COL_BASE));
        baseMesh.rotation.x = -Math.PI / 2;
        baseMesh.position.set(L / 2, 0, W / 2);
        pBase.add(baseMesh);

        /*
         * Cada parede é um pivot na aresta da base. A malha está DEITADA no
         * chão em t=0 (estende para fora da base). Ao dobrar, o pivot roda e
         * levanta a parede até à vertical.
         */

        /* ── FRONT: aresta z=W, estende para +z ── */
        pFront = new THREE.Group();
        pFront.position.set(L / 2, 0, W);
        pBase.add(pFront);
        const front = panel(L, H, COL_WALL);
        front.rotation.x = Math.PI / 2;
        pFront.add(front);

        /* ── BACK: aresta z=0, estende para -z ── */
        pBack = new THREE.Group();
        pBack.position.set(L / 2, 0, 0);
        pBase.add(pBack);
        const back = panel(L, H, COL_WALL);
        back.rotation.x = -Math.PI / 2;
        pBack.add(back);

        /* ── LID: filho do pBack, dobra na aresta de topo da parede de trás ──
           A malha do back está deitada (rotation.x=-π/2), levando o topo da
           parede (y=H local) para z=-H no espaço do grupo pBack. Por isso o
           pivot da tampa fica em (0,0,-H) — sempre na aresta de dobra. */
        pLid = new THREE.Group();
        pLid.position.set(0, 0, -H);
        pBack.add(pLid);
        const lid = panel(L, W, COL_LID);
        lid.rotation.x = -Math.PI / 2;
        pLid.add(lid);

        /* ── LEFT: aresta x=0; deitada estende para -x; pivot roda em -Z ──
           Malha panel(W,H): rotateY(π/2) põe a largura W ao longo de Z,
           rotateZ(π/2) deita a parede no chão a apontar -x. */
        pLeft = new THREE.Group();
        pLeft.position.set(0, 0, W / 2);
        pBase.add(pLeft);
        const left = panel(W, H, COL_WALL);
        left.rotation.y = Math.PI / 2;
        left.rotation.z = Math.PI / 2;
        pLeft.add(left);

        /* ── RIGHT: aresta x=L; deitada estende para +x; pivot roda em +Z ── */
        pRight = new THREE.Group();
        pRight.position.set(L, 0, W / 2);
        pBase.add(pRight);
        const right = panel(W, H, COL_WALL);
        right.rotation.y = Math.PI / 2;
        right.rotation.z = -Math.PI / 2;
        pRight.add(right);

        updateFolds(animT);
        updateInfo();
    }

    /* ════════════════════════════════════════════════════════════
       ANIMAÇÃO DAS DOBRAS
       ════════════════════════════════════════════════════════════ */
    function updateFolds(t) {
        if (!pFront) return;

        /* Fase 1 (0→0.5): paredes levantam de deitado (0) para vertical (π/2) */
        const ph1   = Math.min(1, t / 0.5);
        const a     = ease(ph1) * (Math.PI / 2);   /* 0 → π/2 */

        /* FRONT deitada aponta +z; rodar pivot em -X levanta-a */
        pFront.rotation.x = -a;
        /* BACK deitada aponta -z; rodar pivot em +X levanta-a */
        pBack.rotation.x  =  a;
        /* LEFT deitada aponta -x; rodar pivot em -Z levanta-a */
        pLeft.rotation.z  = -a;
        /* RIGHT deitada aponta +x; rodar pivot em +Z levanta-a */
        pRight.rotation.z =  a;

        /* Tampa (pLid é filho de pBack):
           Fase 1 (t=0→0.5): a tampa fecha em sincronia com a montagem.
             lidRot 0 → +π/2  → em t=0.5 fica horizontal sobre a caixa.
           Fase 2 (t=0.5→1): a tampa abre rodando mais π.
             lidRot +π/2 → +3π/2 → cai para trás/cima (aberta). */
        let lidRot;
        if (t <= 0.5) {
            lidRot = ease(ph1) * (Math.PI / 2);
        } else {
            const ph2 = (t - 0.5) / 0.5;
            lidRot = Math.PI / 2 + ease(ph2) * Math.PI;
        }
        pLid.rotation.x = lidRot;
    }

    /* ── AXES ───────────────────────────────────────────────────── */
    function buildAxes() {
        if (axesHelper) scene.remove(axesHelper);
        const maxD = Math.max(L, W, H);
        const len = maxD * 1.6, r = maxD * 0.01;
        const grp = new THREE.Group();
        function axis(dir, color) {
            const m  = new THREE.MeshBasicMaterial({ color });
            const sh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), m);
            const tp = new THREE.Mesh(new THREE.ConeGeometry(r*2.5, r*7, 8), m);
            tp.position.y = len/2 + r*3.5; sh.add(tp);
            if (dir==='x'){ sh.rotation.z=-Math.PI/2; sh.position.x=len/2; }
            if (dir==='y'){ sh.position.y=len/2; }
            if (dir==='z'){ sh.rotation.x= Math.PI/2; sh.position.z=len/2; }
            grp.add(sh);
        }
        axis('x',0xff3333); axis('y',0x33cc33); axis('z',0x3399ff);
        axesHelper = grp; scene.add(grp);
    }

    /* ── INFO / SLIDER ──────────────────────────────────────────── */
    function updateInfo() {
        const el = document.getElementById('infoBlank');
        if (el) el.textContent = `L=${Math.round(L)} × W=${Math.round(W)} × H=${Math.round(H)} mm`;
    }
    function updateSlider(pct) {
        const s = document.getElementById('animSlider');
        const p = document.getElementById('animPct');
        if (s) s.value = pct;
        if (p) p.textContent = Math.round(pct) + '%';
    }

    /* ── CAMERA ─────────────────────────────────────────────────── */
    function updateCam() {
        /* Orbita à volta do centro da caixa. A caixa está no primeiro octante
           (cantos 0..L, 0..W), com o eixo XYZ na origem a um dos cantos. */
        const cx = L / 2, cy = H / 2, cz = W / 2;
        camera.position.set(
            cx + sph.r * Math.sin(sph.phi) * Math.sin(sph.theta),
            cy + sph.r * Math.cos(sph.phi),
            cz + sph.r * Math.sin(sph.phi) * Math.cos(sph.theta)
        );
        camera.lookAt(cx, cy, cz);
    }

    /* ── LAYOUT ─────────────────────────────────────────────────── */
    function fitPageHeight() {
        const nav = document.querySelector('.o_main_navbar, header.o_header_standard, header') || { offsetHeight: 56 };
        const page = document.querySelector('.atp-dl-page');
        if (page) page.style.height = (window.innerHeight - nav.offsetHeight) + 'px';
    }
    function getViewerSize() {
        const ctrl    = document.querySelector('.atp-dl-controls');
        const sidebar = document.querySelector('.atp-dl-sidebar');
        const nav     = document.querySelector('.o_main_navbar, header.o_header_standard, header') || { offsetHeight: 56 };
        return {
            w: Math.max(200, window.innerWidth  - (sidebar ? sidebar.offsetWidth : 300)),
            h: Math.max(200, window.innerHeight - nav.offsetHeight - (ctrl ? ctrl.offsetHeight : 52)),
        };
    }
    function resizeRenderer() {
        if (!renderer || !camera) return;
        const { w, h } = getViewerSize();
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }

    /* ── VIEW TOGGLE ────────────────────────────────────────────── */
    function setView(v) {
        currentView = v;
        const is3d = v === '3d';
        c3.style.display = is3d ? 'block' : 'none';
        if (view2d) view2d.style.display = is3d ? 'none' : 'flex';
        if (hint)   hint.style.display   = is3d ? '' : 'none';
        document.getElementById('ctrl-3d') && document.getElementById('ctrl-3d').classList.toggle('active', is3d);
        document.getElementById('ctrl-2d') && document.getElementById('ctrl-2d').classList.toggle('active', !is3d);
    }

    /* ── INIT ───────────────────────────────────────────────────── */
    function initThree() {
        fitPageHeight();
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1a1a2e);

        const sz = getViewerSize();
        camera   = new THREE.PerspectiveCamera(45, sz.w/sz.h, 0.1, 12000);
        renderer = new THREE.WebGLRenderer({ canvas: c3, antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        scene.add(new THREE.AmbientLight(0xffffff, 0.8));
        const d1 = new THREE.DirectionalLight(0xffffff, 0.7); d1.position.set(300,500,300); scene.add(d1);
        const d2 = new THREE.DirectionalLight(0x88aaff, 0.3); d2.position.set(-250,150,-200); scene.add(d2);

        /* orbit */
        let drag=false, prev={x:0,y:0};
        c3.addEventListener('mousedown', e => { drag=true; prev={x:e.clientX,y:e.clientY}; });
        window.addEventListener('mouseup', () => drag=false);
        window.addEventListener('mousemove', e => {
            if (!drag) return;
            sph.theta -= (e.clientX-prev.x)*0.007;
            sph.phi = Math.max(0.05, Math.min(Math.PI-0.05, sph.phi+(e.clientY-prev.y)*0.007));
            prev={x:e.clientX,y:e.clientY}; updateCam();
        });
        c3.addEventListener('wheel', e => {
            e.preventDefault();
            sph.r = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, sph.r + e.deltaY*0.7));
            updateCam();
        }, { passive:false });

        buildBox();
        resizeRenderer();
        updateCam();

        (function loop(){
            requestAnimationFrame(loop);
            if (autoRotate && currentView==='3d'){ sph.theta+=0.005; updateCam(); }
            renderer.render(scene, camera);
        })();
    }

    /* ── ANIM ───────────────────────────────────────────────────── */
    function startAnim() {
        animPlaying = true;
        const icon = document.getElementById('ctrl-anim-icon');
        if (icon) icon.className = 'fa fa-stop';
        (function step(){
            if (!animPlaying) return;
            animT += 0.006 * animDir;
            if (animT >= 1){ animT=1; animDir=-1; }
            if (animT <= 0){ animT=0; animDir= 1; }
            updateSlider(Math.round(animT*100));
            updateFolds(animT);
            animRAF = requestAnimationFrame(step);
        })();
    }
    function stopAnim() {
        animPlaying = false;
        if (animRAF) cancelAnimationFrame(animRAF);
        const icon = document.getElementById('ctrl-anim-icon');
        if (icon) icon.className = 'fa fa-play';
    }

    /* ── WIRING ─────────────────────────────────────────────────── */
    function wire(id, fn){ const el=document.getElementById(id); if(el) el.addEventListener('click', fn); }
    wire('ctrl-3d', () => setView('3d'));
    wire('ctrl-2d', () => setView('2d'));
    wire('ctrl-anim', () => animPlaying ? stopAnim() : startAnim());
    wire('ctrl-rotate', () => { autoRotate=!autoRotate; document.getElementById('ctrl-rotate')?.classList.toggle('active', autoRotate); });
    wire('ctrl-zoom-in',  () => { sph.r=Math.max(ZOOM_MIN, sph.r-120); updateCam(); });
    wire('ctrl-zoom-out', () => { sph.r=Math.min(ZOOM_MAX, sph.r+120); updateCam(); });
    wire('ctrl-reset', () => { stopAnim(); animT=0; animDir=1; updateSlider(0); updateFolds(0); sph.theta=0.9; sph.phi=1.0; sph.r=ZOOM_DEFAULT; updateCam(); });

    document.getElementById('animSlider')?.addEventListener('input', function(){
        stopAnim();
        animT = parseInt(this.value)/100;
        updateSlider(this.value);
        updateFolds(animT);
    });

    document.getElementById('btnApply')?.addEventListener('click', () => {
        L = Math.max(40, parseInt(document.getElementById('iL')?.value) || L);
        W = Math.max(30, parseInt(document.getElementById('iW')?.value) || W);
        H = Math.max(30, parseInt(document.getElementById('iH')?.value) || H);
        stopAnim(); animT=0; animDir=1; updateSlider(0);
        buildBox(); updateCam();
    });

    window.addEventListener('resize', () => { fitPageHeight(); resizeRenderer(); updateCam(); });

    /* ── BOOT ───────────────────────────────────────────────────── */
    function applyMeta(meta) {
        if (!meta) return;
        if (!_cfg.L && meta.length) L = meta.length;
        if (!_cfg.W && meta.width)  W = meta.width;
        if (!_cfg.H && meta.height) H = meta.height;
        ['L','W','H'].forEach(k => {
            const el = document.getElementById('i'+k);
            if (el) el.value = Math.round(k==='L'?L:k==='W'?W:H);
        });
    }

    function boot() {
        if (typeof THREE === 'undefined') { console.error('Three.js não carregado'); return; }
        initThree();

        /* Caixa já está construída e PLANA (t=0). Tentar refinar dimensões
           a partir do SVG, mas sem bloquear nada se o fetch falhar. */
        const url = _cfg.dielineSvgUrl;
        if (url && /\.svg(\?|$)/i.test(url) && typeof DielineParser !== 'undefined') {
            DielineParser.parse(url)
                .then(geo => { applyMeta(geo.meta); buildBox(); updateCam(); })
                .catch(err => console.warn('[dieline] SVG não carregado, a usar defaults:', err.message));
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

})();
