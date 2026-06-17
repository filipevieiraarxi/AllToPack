# Architecture Overview

## 1. Stack

| Camada | Tecnologia |
|--------|-----------|
| Plataforma | Odoo 18.0 (Python, ORM, QWeb) |
| E-commerce | `website_sale` (addon oficial) |
| Pagamentos | `payment_stripe` (addon oficial) + Stripe (sandbox/test) |
| Módulo custom | `alltoppack_website` (v18.0.1.0.0) |
| 3D no browser | Three.js r128 (via CDN) + engine próprio em JS vanilla |
| Base de dados | PostgreSQL (host 127.0.0.1:5432, user `odoo18`) |
| Servidor HTTP | Odoo embutido, `http_port = 8090` |

## 2. O módulo custom `alltoppack_website`

É o **único** módulo custom do projeto. Tudo o resto é Odoo oficial.

```
alltoppack_website/
├── __manifest__.py            # depends: website, website_sale ; assets frontend
├── __init__.py                # post_init_hook
├── controllers/main.py        # rotas /packaging e /dieline/*
├── models/product_template.py # extende product.template (campos de caixa + artwork)
├── data/product_data.xml      # categorias públicas + 2 produtos-demo com SVG embutido
├── security/ir.model.access.csv
├── views/                     # templates QWeb (landing, packaging, shop, product, dieline) + vista backend
└── static/src/
    ├── css/   (style.css, dieline.css)
    └── js/    (main.js, dieline_parser.js, dieline_engine.js, dieline_generators.js, OrbitControls.js)
```

### Dependências declaradas

```python
'depends': ['website', 'website_sale']
```

Por arrasto, isto traz `sale`, `payment`, `account`, `website`. O módulo é
`application = True` e tem `post_init_hook`.

### post_init_hook

Em [`__init__.py`](../AllToPack/alltoppack_website/__init__.py): após instalar, garante que todos os
produtos com `box_type` definido ficam associados à categoria pública **"Caixas"**.

## 3. Como assenta no Odoo

O módulo **não substitui** o e-commerce — estende-o:

- **Modelo:** `product.template` é herdado (`_inherit`) para acrescentar campos
  de caixa (dimensões, SVG-dieline, artwork, imagens de card). Ver [data-model.md](data-model.md).
- **Views:** templates QWeb herdam/estendem layouts do `website`/`website_sale`
  (ex.: `shop_templates.xml` customiza a grelha da loja; `product_templates.xml`
  a página de produto).
- **Controladores:** acrescentam rotas próprias (`/packaging`, `/dieline`, `/dieline/svg/...`,
  `/dieline/artwork/...`) sem tocar nas do `website_sale`.
- **Pagamentos & vendas:** delegados inteiramente ao `website_sale` + `payment_stripe`.
  Ver [ecommerce-payments.md](ecommerce-payments.md).

## 4. Mapa de páginas / rotas

| Rota | Tipo | Auth | Origem | Função |
|------|------|------|--------|--------|
| `/` | QWeb | public | custom (`templates.xml`) | Landing page |
| `/packaging` | http | public | custom (`PackagingController`) | Grelha de categorias de embalagem |
| `/shop` | http | public | `website_sale` (+ custom views) | Catálogo / loja |
| `/shop/cart`, `/shop/checkout`, `/shop/payment` | http | public | `website_sale` | Carrinho e checkout |
| `/dieline?product_id=N` | http | public | custom (`DielineController`) | Configurador 3D |
| `/dieline/svg/<id>` | http | public | custom | Serve o SVG-dieline do produto |
| `/dieline/artwork/load` | http | public | custom | Lê artwork guardado (JSON) |
| `/dieline/artwork/save` | json | **user** | custom | Grava artwork no produto |

> Nota: o menu "Shop" do website aponta para `/packaging` nesta instância
> (alterado em `website.menu`), não para `/shop`.

## 5. Pipeline de assets

Há **dois** mecanismos de carregamento de JS/CSS, deliberadamente separados:

### a) Assets globais do frontend (bundle Odoo)
Declarados no manifest, entram no bundle `web.assets_frontend` (todas as páginas):
```python
'web.assets_frontend': [
    'alltoppack_website/static/src/css/style.css',
    'alltoppack_website/static/src/css/dieline.css',
    'alltoppack_website/static/src/js/main.js',
]
```
`main.js` é um módulo Odoo (`/** @odoo-module **/`) com utilidades de UI
(scroll suave, highlight de menu, toggle 2D/3D na loja, BoxFinder por dimensões).

### b) Scripts da página do configurador 3D (carregados à mão)
A página `/dieline` **não** usa o bundle para o 3D. Em [`dieline_templates.xml`](../AllToPack/alltoppack_website/views/dieline_templates.xml)
os scripts são incluídos por `<script src>` directos, com ordem garantida e
`defer_scripts: False`:
```
three.min.js (CDN r128)  →  OrbitControls.js  →  dieline_parser.js  →  dieline_engine.js
```
Razão: o engine 3D é JS vanilla (IIFE, não um módulo Odoo) e depende de `THREE`
global e do `DielineParser` global, carregados por ordem. A configuração da
página é injetada antes via `window.ATP_CONFIG` (boxType, L/W/H, URLs, productId).

> ⚠️ Three.js vem de CDN externo (cloudflare). Em produção/offline convém
> servir localmente.

## 6. Ambiente de execução

- **Config:** `odoo18.conf` (`addons_path` inclui `odoo/addons` e `AllToPack`;
  `db_host/port/user/password`; `http_port = 8090`).
- **Base de dados de trabalho:** `teste`.
- **Arranque do shell** (usado para scripts de manutenção):
  ```bash
  ./odoo/odoo-bin shell --config odoo18.conf -d teste --no-http
  ```
- **wkhtmltopdf:** necessário para relatórios/faturas PDF. Ver
  [ecommerce-payments.md](ecommerce-payments.md#wkhtmltopdf) — a sua ausência
  bloqueava a confirmação de sale orders.

## 7. Diagrama de alto nível

```
                         Browser
   ┌───────────────────────────────────────────────────┐
   │  Landing (/)   Packaging (/packaging)   Shop (/shop)│
   │                                              │       │
   │                                       carrinho/checkout
   │   Configurador 3D (/dieline)                 │       │
   │   ├─ THREE.js (CDN)                          │       │
   │   ├─ dieline_parser.js  (SVG → árvore)       │       │
   │   └─ dieline_engine.js  (árvore → 3D)        │       │
   └───────┬──────────────────────────────────────┬──────┘
           │ fetch SVG / artwork                   │ JSON-RPC
   ┌───────▼───────────────────────────────────────▼──────┐
   │                    Odoo 18 (HTTP :8090)               │
   │  alltoppack_website          website_sale + payment  │
   │  ├─ DielineController        ├─ carrinho = sale.order │
   │  ├─ PackagingController      ├─ checkout              │
   │  └─ product.template (ext.)  └─ payment_stripe ──────────► Stripe API
   └───────────────────────┬──────────────────────────────┘
                           │ ORM
                    ┌──────▼──────┐
                    │ PostgreSQL  │
                    └─────────────┘
```

Para os fluxos internos de cada subsistema, ver os documentos dedicados.
