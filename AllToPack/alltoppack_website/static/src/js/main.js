/** @odoo-module **/
// AllToPack — main.js

// ── Scroll suave para âncoras internas ──────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener("click", function (e) {
        const hash = this.getAttribute("href");
        if (!hash || hash === "#") return;
        const target = document.querySelector(hash);
        if (target) {
            e.preventDefault();
            target.scrollIntoView({ behavior: "smooth" });
        }
    });
});

// ── Highlight do item de menu activo ────────────────────────────
(function highlightActiveMenu() {
    const currentPath = window.location.pathname;
    document.querySelectorAll(".navbar-nav .nav-link").forEach(link => {
        if (link.getAttribute("href") === currentPath) {
            link.classList.add("active");
        }
    });
})();

// ── Toggle 2D / 3D vista na shop ─────────────────────────────────
(function initViewToggle() {
    const grid   = document.getElementById('products_grid');
    const radio2d = document.getElementById('atp-radio-2d');
    const radio3d = document.getElementById('atp-radio-3d');
    if (!grid || !radio2d || !radio3d) return;

    radio2d.addEventListener('change', () => {
        if (radio2d.checked) grid.classList.add('atp-view-2d');
    });
    radio3d.addEventListener('change', () => {
        if (radio3d.checked) grid.classList.remove('atp-view-2d');
    });
})();

// ── BoxFinder — filtra produtos por dimensões ────────────────────
(function initBoxFinder() {
    const btnFind  = document.getElementById('atp-bf-find');
    const btnReset = document.getElementById('atp-bf-reset');
    const noResult = document.getElementById('atp-bf-noresult');
    if (!btnFind) return; // só existe na página /shop

    function getCards() {
        return document.querySelectorAll('.oe_product_cart[data-box-type]');
    }

    function getCol(card) {
        // Sobe até ao col pai (Bootstrap col-*)
        let el = card.parentElement;
        while (el && !Array.from(el.classList).some(c => c.startsWith('col'))) {
            el = el.parentElement;
        }
        return el;
    }

    function applyFilter() {
        const l = parseFloat(document.getElementById('atp-bf-l').value) || 0;
        const w = parseFloat(document.getElementById('atp-bf-w').value) || 0;
        const h = parseFloat(document.getElementById('atp-bf-h').value) || 0;
        const filtering = l > 0 || w > 0 || h > 0;

        let visible = 0;
        getCards().forEach(card => {
            const col = getCol(card);
            if (!col) return;
            if (!filtering) {
                col.style.display = '';
                visible++;
                return;
            }
            const bL = parseFloat(card.dataset.boxL) || 0;
            const bW = parseFloat(card.dataset.boxW) || 0;
            const bH = parseFloat(card.dataset.boxH) || 0;
            const fits = (!l || bL >= l) && (!w || bW >= w) && (!h || bH >= h);
            col.style.display = fits ? '' : 'none';
            if (fits) visible++;
        });

        if (noResult)  noResult.style.display  = filtering && visible === 0 ? '' : 'none';
        if (btnReset)  btnReset.style.display   = filtering ? '' : 'none';
    }

    function resetFilter() {
        ['atp-bf-l', 'atp-bf-w', 'atp-bf-h'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        getCards().forEach(card => {
            const col = getCol(card);
            if (col) col.style.display = '';
        });
        if (noResult) noResult.style.display = 'none';
        if (btnReset) btnReset.style.display  = 'none';
    }

    btnFind.addEventListener('click', applyFilter);
    if (btnReset) btnReset.addEventListener('click', resetFilter);

    // Filtra também ao pressionar Enter nos inputs
    ['atp-bf-l', 'atp-bf-w', 'atp-bf-h'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') applyFilter(); });
    });
})();
