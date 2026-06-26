# AllToPack — Odoo 18 Module

Módulo Odoo custom para o website e configurador 3D de embalagens da AllToPack.

## Estrutura do Módulo

```
AllToPack/
└── alltoppack_website/
    ├── models/
    │   ├── product_template.py      # Campos de caixa no produto
    │   ├── sale_order_dieline.py    # Config dieline por linha de encomenda
    │   └── partner_logo.py          # Galeria de logos por cliente
    ├── controllers/
    │   └── main.py                  # Todas as rotas HTTP (~5000 linhas)
    ├── views/
    │   ├── templates.xml            # Homepage
    │   ├── packaging_templates.xml  # /produtos
    │   ├── shop_templates.xml       # /shop (com BoxFinder)
    │   ├── product_templates.xml    # Página de produto
    │   ├── dieline_templates.xml    # Configurador 3D (49KB, template principal)
    │   ├── product_backend_views.xml
    │   └── sale_order_dieline_views.xml
    ├── static/src/
    │   ├── css/
    │   │   ├── style.css            # Classes globais .atp-*
    │   │   └── dieline.css          # Layout full-screen do configurador
    │   └── js/
    │       ├── main.js              # Interatividade geral (BoxFinder, view toggle)
    │       ├── dieline_engine.js    # Motor 3D Three.js (fold tree, animações)
    │       ├── dieline_parser.js    # Parser SVG → geometria DCEL
    │       ├── dieline_generators.js# Geração paramétrica de SVGs
    │       ├── dieline_logo2d.js    # Compositor 2D de logos
    │       └── OrbitControls.js    # Câmera Three.js (rbind)
    └── data/
        ├── product_data.xml
        └── website_logo_data.xml
```

## Modelos

### `product.template` (extended)
Campos adicionados ao produto Odoo:
- `box_type` — tipo FEFCO (FEFCO_0201, 0216, 0215, 0200, 0427, 04XX, 0422, 0425, GENERIC)
- `box_l`, `box_w`, `box_h` — dimensões base em mm
- `box_dieline_svg` — SVG base64 do dieline (Format B)
- `box_artwork` — JSON com logos aplicados (chaves `__logo__`, `__logo_back__`, etc.)
- `card_image_normal`, `card_image_hover` — imagens para o card de produto

### `sale.order.dieline`
Snapshot da configuração de embalagem no momento da encomenda:
- Ligado a `sale.order.line` via `order_line_id` (cascade delete)
- Guarda dimensões, tipo, SVG escalado, e `artwork_json`
- `artwork_json` suporta múltiplos logos por face, indexados: `__logo__`, `__logo__1`, `__logo__2`, … para frente; `__logo_back__`, `__logo_back__1`, … para verso

### `atp.partner.logo`
Galeria pessoal de logos por cliente:
- Campos: `partner_id`, `name`, `image`, `mimetype`
- Ordenado por `-create_date`

## Rotas HTTP (controllers/main.py)

| Rota | Método | Auth | Função |
|------|--------|------|--------|
| `/produtos` | GET | public | Lista categorias raiz |
| `/produtos/<slug>` | GET | public | Subcategorias ou redireciona para /shop |
| `/dieline` | GET | public | Configurador 3D (template principal) |
| `/dieline/svg/<product_id>` | GET | public | Serve SVG do produto |
| `/dieline/artwork/save` | POST JSON | user | Guarda artwork no produto |
| `/dieline/artwork/load` | GET | public | Carrega artwork do produto |
| `/dieline/order/save` | POST JSON | public | Cria/atualiza `sale.order.dieline` |
| `/dieline/order/preview/<id>` | GET | public | Preview read-only do dieline |
| `/dieline/order/<id>/svg/<side>` | GET | public | SVG com logos injetados (front/back) |
| `/dieline/logo/upload` | POST JSON | user | Upload logo para galeria |
| `/dieline/logo/list` | POST JSON | user | Lista logos do utilizador |
| `/dieline/logo/delete` | POST JSON | user | Remove logo da galeria |

### Funções auxiliares no controller
- `_scale_dieline_svg(svg, L0, W0, H0, L, W, H)` — escala SVG de dimensões originais para novas, incluindo texto verde de cotas
- `_inject_logos_into_svg(svg, artwork, prod, rec)` — injeta imagens de logo + linhas de cota (mm) no SVG para download

## Ficheiros JavaScript

Os ficheiros de dieline **não estão no manifesto** — são carregados inline no template `dieline_page`. Isso permite-lhes aceder ao contexto do template (dimensões, artwork JSON inicial) antes de inicializar.

### `dieline_engine.js`
Motor 3D baseado em Three.js.
- `rebuildFrom(geo)` — constrói modelo 3D a partir da geometria parseada
- `animateTo(t)` — anima fold tree de t=0 (plano) a t=1 (montado)
- `applyLogoTexture(panelKey, side, canvas)` — aplica canvas 2D como textura numa mesh 3D
- Estado global exposto via `window.ATP_DIELINE`

### `dieline_parser.js`
Parser SVG → árvore de painéis (DCEL).
- `build(svgText)` — retorna `{ meta, unit, rootKey, type, nodes }` onde cada node tem `{ key, id, parentKey, angle, points, foldSign, animGroup }`
- Cores do SVG: vermelho = corte, azul = vinco, verde = cotas
- `TemplateMapper` — enriquece a geometria com metadados FEFCO específicos por tipo de caixa

### `dieline_generators.js`
Geração paramétrica de SVGs.
- `rsc(L, W, H)` — RSC (Regular Slotted Container), 5 painéis + abas
- `rolloverHingedLid(L, W, H)` — Tampa rollover com aba articulada

### `dieline_logo2d.js`
Compositor 2D de logos. Renderiza o SVG dieline em canvas e permite posicionar logos por arrastar.
- `logos = { front: [], back: [] }` — múltiplos logos por face (array)
- `placePanelCenter(node)` — adiciona novo logo centrado num painel (não substitui)
- `placeImage(dataUrl, rot)` — adiciona logo no painel maior (panel_0)
- `removeSelected()` — remove apenas o logo selecionado
- `exportLogoState()` — exporta todos os logos como artwork JSON com chaves indexadas
- Coords armazenadas em espaço local do painel (mm), convertidas para SVG/canvas conforme necessário

## Fluxo: Configuração e Encomenda

```
1. /dieline?product_id=X
   → carrega produto, SVG, artwork JSON existente

2. Parser SVG → árvore de painéis
   → Engine 3D constrói modelo e anima

3. Utilizador ajusta L/W/H
   → engine regenera geometria
   → SVG re-escalado via _scale_dieline_svg()

4. Utilizador posiciona logo(s)
   → upload ou galeria → _atpArtworkDataUrl
   → placePanelCenter() / placeImage() → logos[side].push()
   → applyLogoTexture() sincroniza com 3D

5. "Adicionar ao carrinho"
   → POST /dieline/order/save → cria sale.order.dieline
   → cart_update() associa dieline_config_id à order line

6. Admin abre encomenda → tab "Detalhes do Produto"
   → Download SVG frente/verso com logos injetados
```

## Formato artwork_json

```json
{
  "__logo__":   { "panelKey": "panel_0", "side": "outer", "s": 55.2, "d": 40.1, "sizeMM": 80, "rot": 0, "dataUrl": "data:image/png;base64,..." },
  "__logo__1":  { "panelKey": "panel_1", "side": "outer", "s": 30.0, "d": 25.0, "sizeMM": 60, "rot": 90, "dataUrl": "..." },
  "__logo_back__": { ... }
}
```

- Índice 0: chave sem sufixo numérico (`__logo__`, `__logo_back__`)
- Índices > 0: sufixo numérico (`__logo__1`, `__logo__2`, `__logo_back__1`, …)
- `s` / `d` — coordenadas locais do painel em mm (centro do logo)
- `side` — `'outer'` (frente) ou `'inner'` (verso)

## Convenções de Código

- Classes CSS: prefixo `.atp-*` (BEM)
- IDs de painéis: `panel_0`, `panel_1`, … ordenados por área decrescente
- Chaves FEFCO: `FEFCO_0201`, `FEFCO_0216`, etc.
- SVG Format B: linhas coloridas (vermelho corte, azul vinco, verde cotas)

## Dependências Odoo

`website`, `website_sale`, `sale`

## Alterações Notáveis (não no git history)

### Múltiplos logos por face (2026-06-25)
`dieline_logo2d.js` — `placePanelCenter()` passou de substituir para adicionar logo:
- Antes: limpava `logos[activeSide]` e substituía com novo logo
- Depois: faz `.push()`, permitindo N logos por face
- O restante da stack (export, inject, backend) já suportava múltiplos logos via chaves indexadas
