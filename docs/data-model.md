# Data Model, Controllers & Routes

Referência dos modelos de dados custom, campos, controladores HTTP/JSON e rotas
do módulo `alltoppack_website`.

## 1. Modelo: `product.template` (estendido)

[`models/product_template.py`](../AllToPack/alltoppack_website/models/product_template.py) — `_inherit = 'product.template'`.

### Campos de caixa / dieline

| Campo | Tipo | Default | Descrição |
|-------|------|---------|-----------|
| `box_type` | Selection | `rollover_hinged_lid` | Rótulo informativo (`rollover_hinged_lid`, `rsc_regular_slotted`). **Não** determina a geometria 3D — é só categoria. |
| `box_l` | Float | 120.0 | Comprimento (mm) |
| `box_w` | Float | 80.0 | Largura (mm) |
| `box_h` | Float | 100.0 | Altura (mm) |
| `box_dieline_svg` | Binary (attachment) | — | **SVG-dieline anotado: a ÚNICA fonte da geometria 3D.** |
| `box_dieline_svg_fname` | Char | — | Nome do ficheiro SVG |
| `box_artwork` | Text | `{}` | JSON `{face_key: base64_data_url}` com o artwork por face (rotações sob `__rot__`). |

> **Invariante de design:** `box_type`, `box_l/w/h` são metadados/labels e valores
> iniciais dos inputs. A geometria 3D vem do `box_dieline_svg`. Se o produto não
> tiver SVG, o engine mostra "sem dieline". Ver [dieline-3d-engine.md](dieline-3d-engine.md).

### Campos de apresentação (cards da loja)

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `card_image_normal` | Binary (attachment) | Imagem do card (estado normal) |
| `card_image_normal_fname` | Char | Nome do ficheiro |
| `card_image_hover` | Binary (attachment) | Imagem do card (hover) |
| `card_image_hover_fname` | Char | Nome do ficheiro |

### Métodos

| Método | Tipo | Função |
|--------|------|--------|
| `action_open_dieline_3d()` | action | Abre `/dieline?product_id=<id>` em nova aba (botão no backend). |

## 2. Vista backend

[`views/product_backend_views.xml`](../AllToPack/alltoppack_website/views/product_backend_views.xml)
herda `product.product_template_form_view` e acrescenta a tab **"Dieline 3D"**
com: tipo/dimensões, imagens de card, upload do SVG (com instruções de anotação)
e o botão "Ver Dieline 3D".

## 3. Controladores e rotas

### `PackagingController` ([controllers/main.py](../AllToPack/alltoppack_website/controllers/main.py))

| Rota | Método | Auth | Descrição |
|------|--------|------|-----------|
| `/packaging` | `packaging_index` | public | Renderiza a grelha de 4 categorias (Caixas, Sacos, Etiquetas, Outros). Resolve o slug de cada `product.public.category` numa única query e gera o link `/shop/category/<slug>`. |

As categorias e ícones estão hard-coded em `_CATEG_DEFS` (nome, ícone FA, descrição).

### `DielineController`

| Rota | Tipo | Auth | Descrição |
|------|------|------|-----------|
| `/dieline` | http | public | Página do configurador 3D. Lê o produto por `product_id`, monta os `values` (box_type, L/W/H, URL do SVG, variante, preço) e renderiza `dieline_page`. |
| `/dieline/svg/<int:product_id>` | http | public | Serve o conteúdo do `box_dieline_svg` (base64-decoded) como `image/svg+xml`, `Cache-Control: no-cache`. 404 se não existir. |
| `/dieline/artwork/load` | http | public | Devolve `product.box_artwork` (JSON) ou `{}`. |
| `/dieline/artwork/save` | **json** | **user** | `POST` — grava `artwork` (dict) em `product.box_artwork` (via `json.dumps`). Devolve `{ok: bool}`. |

> Notas de segurança/uso:
> - `save_artwork` exige `auth='user'` (só utilizadores autenticados gravam).
>   Todas as outras são `public`.
> - Os controladores usam `sudo()` para ler/escrever no produto — adequado para
>   leitura pública do SVG/artwork, mas a gravação fica protegida pelo `auth=user`.

## 4. Dados-semente (`data/product_data.xml`, `noupdate="1"`)

- **4 categorias públicas:** Caixas (10), Sacos (20), Etiquetas (30), Outros (40).
- **2 produtos-demo** com o SVG-dieline **embutido em base64** no próprio XML:
  - `Caixa Rollover Hinged Lid` — `box_type=rollover_hinged_lid`, 100×150×40,
    SVG com painéis incl. `lid`/`roll` em `<polygon>` (cantos arredondados).
  - `RSC Regular Slotted Container` — `box_type=rsc_regular_slotted`, 290×200×150,
    SVG com 4 paredes em cadeia + abas topo/fundo + glue flap.

Ambos `type=consu`, `is_published=True`, na categoria "Caixas".

## 5. Segurança

[`security/ir.model.access.csv`](../AllToPack/alltoppack_website/security/ir.model.access.csv)
está vazio (só cabeçalho) — o módulo não define modelos novos, apenas estende
`product.template`, cujas ACLs vêm dos módulos base.

## 6. Templates QWeb (views)

| Ficheiro | Conteúdo |
|----------|----------|
| `templates.xml` | Landing page (`/`). |
| `packaging_templates.xml` | Grelha de categorias (`/packaging`). |
| `shop_templates.xml` | Customização da loja: cards, toggle 2D/3D, BoxFinder. |
| `product_templates.xml` | Página de produto (liga ao `/dieline`). |
| `dieline_templates.xml` | Página do configurador 3D: canvas, sidebar de cards, `ATP_CONFIG`, carregamento ordenado dos scripts 3D. |
| `product_backend_views.xml` | Tab "Dieline 3D" no formulário de produto (backend). |

## 7. Persistência do artwork (resumo do contrato)

```
Frontend (engine)                         Backend
─────────────────                         ───────
artwork    = {face_key: data_url}   ──┐
artworkRot = {face_key: degrees}    ──┤ POST /dieline/artwork/save
                                       │  payload = {...artwork, __rot__: artworkRot}
                                       └─► product.box_artwork (Text, JSON)

product.box_artwork ──► GET /dieline/artwork/load ──► engine reaplica por face
```

`face_key` tem o formato `<panelKey>_outer` ou `<panelKey>_inner` (lado externo /
interno da face). Ver [dieline-3d-engine.md](dieline-3d-engine.md) §5–6.
