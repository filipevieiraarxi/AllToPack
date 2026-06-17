# AllToPack — Documentação de Arquitetura

Documentação técnica do projeto **AllToPack**, um Odoo 18 com um módulo custom
de website/e-commerce de embalagens, cujo destaque é um **configurador 3D de
caixas (dieline engine)** que deriva a geometria 3D de um SVG-dieline anotado.

> Estado: documentação gerada a partir do código em `AllToPack/alltoppack_website`
> e da configuração da instância (BD `teste`). Datada de 2026-06-15.

## Índice

| Documento | Conteúdo |
|-----------|----------|
| [architecture-overview.md](architecture-overview.md) | Visão de sistema: stack, módulo custom, como assenta no Odoo, pipeline de assets, ambiente de execução. |
| [dieline-3d-engine.md](dieline-3d-engine.md) | O subsistema 3D: do SVG-dieline ao modelo dobrável. Parser → engine → render, raycasting, artwork, geradores paramétricos. |
| [ecommerce-payments.md](ecommerce-payments.md) | Fluxo de e-commerce e pagamentos: catálogo → carrinho → checkout Stripe → confirmação da sale order. Pontos de configuração e armadilhas. |
| [data-model.md](data-model.md) | Modelos de dados, campos custom, controladores HTTP/JSON e rotas. |

## Resumo em 30 segundos

- **Plataforma:** Odoo 18 (`odoo/`), com um módulo custom `alltoppack_website` (`AllToPack/`).
- **Depende de:** `website`, `website_sale` (e, por arrasto, `sale`, `payment`, `account`).
- **Páginas custom:** landing (`/`), `/packaging` (categorias), loja (`/shop` via website_sale,
  com customizações), página de produto, e o **configurador 3D** (`/dieline`).
- **Configurador 3D:** lê um SVG-dieline anexado a cada produto (`box_dieline_svg`),
  infere a árvore de painéis/dobras e monta/desmonta a caixa em Three.js. Permite
  aplicar artwork (logos) por face e guardá-lo no produto.
- **Pagamentos:** Stripe (sandbox), via `payment_stripe`. A `sale.order` é criada
  como carrinho e confirmada ao concluir o pagamento (lógica nativa do `website_sale`).

## Estrutura do repositório (relevante)

```
odoo18/
├── odoo/                       # core Odoo 18 + addons oficiais (não modificar)
│   └── addons/
│       ├── website_sale/       # e-commerce
│       ├── payment_stripe/     # integração Stripe
│       └── sale/               # vendas (confirma SO ao pagar)
├── AllToPack/
│   └── alltoppack_website/     # ÚNICO módulo custom — ver data-model.md
├── docs/                       # esta documentação
├── tools/
│   └── set_stripe_keys.py      # script dev: escreve chaves Stripe na BD (ver ecommerce-payments.md)
├── .local/                     # segredos locais (gitignored)
└── odoo18.conf                 # config da instância (db, addons_path, http_port=8090)
```
