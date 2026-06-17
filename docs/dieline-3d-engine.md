# Dieline 3D Engine

O configurador 3D de caixas é o subsistema mais complexo do projeto. Transforma
um **SVG-dieline anotado** (a planificação 2D da caixa) num **modelo 3D dobrável**
em Three.js, permite aplicar **artwork (logos) por face** e exportar/guardar essa
personalização.

Princípio central: **não há lógica específica por tipo de caixa**. Toda a
geometria 3D é *derivada* do SVG. Um RSC e uma Rollover Hinged Lid são apenas
SVGs diferentes; o código é o mesmo.

## 1. Ficheiros e responsabilidades

| Ficheiro | Papel |
|----------|-------|
| [`dieline_parser.js`](../AllToPack/alltoppack_website/static/src/js/dieline_parser.js) | Lê o SVG e **infere a árvore de painéis/dobras** (pai→filhos). Saída: lista de nós com polígonos e arestas de dobra. |
| [`dieline_engine.js`](../AllToPack/alltoppack_website/static/src/js/dieline_engine.js) | Constrói a cena Three.js a partir da árvore, anima as dobras, gere câmara, raycasting (seleção de faces) e artwork. |
| [`dieline_generators.js`](../AllToPack/alltoppack_website/static/src/js/dieline_generators.js) | Gera SVGs paramétricos para tipos de caixa conhecidos (rebuild ao mudar L/W/H). *(Há também um gerador embutido no engine — ver §7.)* |
| `OrbitControls.js` | Controlo de câmara Three.js (incluído mas o engine usa rotação por quaternion própria). |
| `dieline_templates.xml` | A página `/dieline`: canvas, sidebar de cards (dimensões, artwork…), injeta `ATP_CONFIG` e carrega os scripts por ordem. |

## 2. Formato do SVG-dieline (o contrato)

O SVG é a **única fonte de verdade**. Convenção (ver cabeçalho do parser):

```xml
<svg viewBox="0 0 W H">
  <metadata>{"box_type":"...","length":L,"width":W,"height":H}</metadata>

  <g id="cut_lines">              <!-- cada painel = uma face -->
    <rect    id="base_panel"  ... data-root="1"/>          <!-- a base/raiz -->
    <rect    id="front_panel" ... data-fold-angle="90"/>   <!-- dobra 90° sobre o pai -->
    <polygon id="lid_panel"   points="..." data-fold-angle="90"/>
  </g>

  <g id="fold_lines">            <!-- cada <line> = uma aresta de dobra -->
    <line x1="..." y1="..." x2="..." y2="..."/>
  </g>
</svg>
```

Regras:
- **Painel** = `<rect>` ou `<polygon>` em `#cut_lines`, com `id` terminado em `_panel`.
  Um `<rect>` é tratado como polígono de 4 cantos (retrocompatível).
- `data-root="1"` marca a face base. Se ausente, o parser usa o painel `base`,
  senão o de **maior área**.
- `data-fold-angle` (default 90) = ângulo a que a face dobra sobre o pai.
- **Dobras** = `<line>` em `#fold_lines`. O parser descobre por **adjacência
  geométrica** que dois painéis cada linha liga (um lado de cada polígono
  coincide com a linha).
- `<metadata>` é opcional mas dá as dimensões reais (mm) → usado para calcular a
  escala px→mm.

## 3. Parser: SVG → árvore (`dieline_parser.js`)

Saída de `DielineParser.build(svgText)`:
```js
{
  meta,            // metadata JSON
  unit,            // px por mm (escala)
  rootKey,
  nodes: [{
    key, id, parentKey|null, angle,
    points: [{x,y}, ...],       // polígono em coords SVG
    edge:   {x1,y1,x2,y2}|null  // aresta de dobra partilhada com o pai
  }]
}
```

Algoritmo:
1. **Parse** dos painéis (`rect`/`polygon`) e das linhas de dobra.
2. **Raiz**: `data-root` → `base` → maior área.
3. **Grafo de adjacência**: para cada `<line>` de dobra, encontra os painéis cujo
   lado coincide com ela (`sameEdge`, com tolerância `EPS = 1.5px` e teste de
   colinearidade + sobreposição) e liga-os.
4. **BFS a partir da raiz** → atribui `parentKey` e a `edge` partilhada a cada nó.
   Painéis sem ligação à raiz são ignorados (com `console.warn`).
5. **Escala** (`estimateUnit`): empareja o maior lado do bbox da raiz (px) com a
   maior dimensão em mm da metadata. Sem metadata, assume 1:1.

## 4. Engine: árvore → 3D (`dieline_engine.js`)

### Mapeamento de coordenadas
- SVG `(x,y)` → cena `(X=x, Y=0, Z=y)`: o dieline assenta **deitado** no plano XZ.
- `boxGroup` é rodado **-90° em X** para levantar a caixa para a vertical e
  centrado na origem (a rotação do utilizador é sobre o próprio centro).

### Hierarquia de grupos (a chave das dobras)
Cada nó-filho vive num **pivot** colocado no início da sua aresta de dobra,
encadeado no `foldGroup` do pai. Assim, dobrar o pai arrasta os filhos.

O posicionamento usa **matrizes de repouso** (`restWorld`): cada painel tem uma
matriz mundo-de-repouso (estado planificado, no chão). O transform local do pivot
do filho é `inv(restWorld_pai) · restWorld_filho` — rigoroso a qualquer
profundidade da árvore. A base é ortonormal direita `{û (aresta), n̂ (perp. p/
dentro), ẑ=û×n̂}` (det=+1, senão a decomposição em quaternion dá lixo).

### Animação das dobras (faseada, seamless)
- `animT ∈ [0,1]`: 0 = planificado, 1 = montado.
- Cada dobra tem uma **janela** `[tStart, tEnd]` calculada em `calcFoldWindows`.
  A cada dobra é atribuída uma **chave de ordem global** (`orderKey`); as chaves
  distintas são depois **comprimidas em ranks consecutivos** (0,1,2,…) e
  distribuídas continuamente em `[0,1]` com sobreposição (`OVERLAP_GROW = 1.6`).
  Esta compressão é o que torna a animação **seamless**: não há ranks vazios nem
  pausas entre grupos (cada grupo arranca enquanto o anterior ainda dobra).
  `ease()` suaviza cada dobra.
- **Ordem de montagem** (do mais cedo ao mais tarde), codificada em `orderKey`:
  - **Caixa COM lid** (rollover):
    1. **Corpo**, por `(seq, depth)`: base → paredes front/back → flaps de
       front/back → paredes **left/right** (fecham por cima, `seq = 1`).
    2. **Tampa** (`isLid`: keys `^lid` ou `^roll`), sempre **depois** do corpo e
       por `depth` **invertido**: abas da tampa (`lid_*_flap`, `roll` — depth
       maior) dobram primeiro, e a **`lid` fecha por último** sobre a caixa.
  - **Caixa SEM lid** (ex.: RSC): primeiro fecha-se o **tubo** (paredes + glue),
    e só **depois** as abas de **topo/fundo** (`*_top`, `*_bottom`). Implementado
    com o flag `isTopBottom` (key termina em `_top`/`_bottom`): quando `!hasLid`,
    a sua `orderKey` leva `+BODY_TOTAL`, empurrando-as para depois das paredes.
    Nas caixas com lid este desvio **não se aplica** (comportamento inalterado).
  > Regras por `key` (genéricas, sem lógica por tipo de caixa): `seq`, `isLid` e
  > `isTopBottom` são atribuídos em `buildChild`. Mudar a nomenclatura do SVG
  > implica rever estes regex.
- **Velocidade do play** (`startAnim`): o incremento base de `animT` por frame
  (~`0.0046`) é **modulado por uma rampa `sin`** — ~35% nos extremos (0 e 1) e
  100% no meio. Isto **desacelera o fecho e a reversão**, evitando o "snap"
  abrupto no fim da animação. Parâmetro `EDGE = 0.35` controla a velocidade
  mínima nos extremos.

### Câmara e interação
- Rotação livre por **quaternion** acumulado no `boxPivot` (sem gimbal lock).
- Zoom por `wheel` (raio da câmara). Auto-rotação opcional.
- Toggle 2D/3D (a vista 2D mostra o SVG diretamente).

## 5. Faces: dois lados e seleção (raycasting)

Cada painel gera um **par de meshes**: `_outer` (FrontSide) e `_inner`
(BackSide), registados em `meshMap` por `face_key`. Isto permite artwork
diferente por lado.

### Problema das abas coplanares e a sua solução
Quando a caixa está fechada, várias abas ficam **exatamente no mesmo plano**
(ex.: flaps de cima que se encontram ao meio). Isto causava:
- **z-fighting** (piscar no render);
- **seleção instável** (o cursor saltava entre abas do mesmo lado).

Solução (ver também a nota de memória do projeto):
- **Render** — `applyPolyOffset(matOpts, order)` dá a cada painel um
  `polygonOffset` único e de magnitude mínima (`units = -(order+1)*0.05`), onde
  `order = node.stackOrder` (índice único do nó). Magnitude pequena de propósito:
  valores grandes faziam os lados parecer "afundados" ao rodar.
- **Raycast** — `pickVisibleHit(hits)` replica a mesma regra: filtra back-faces
  (só faces viradas à câmara) e, entre hits coplanares (dentro de `COPLANAR_EPS =
  0.5mm`), escolhe o de **maior `order`** (o que o offset renderizou à frente).

> **Invariante a preservar:** render (`applyPolyOffset`) e seleção
> (`pickVisibleHit`) têm de partilhar a mesma regra de `order`. Se só se mexer
> num, o utilizador vê uma aba à frente mas o clique apanha outra. O `order` é
> guardado em `mesh.userData.order`. Comportamento pretendido: clique em abas
> empilhadas seleciona **sempre a de cima**.

### Flaps interiores: render atrás das paredes
As flaps (abas) e o `roll` dobram para **dentro** da caixa e, quando fechada,
ficam coplanares com as paredes. Por terem `order` maior, o `polygonOffset` base
empurrava-as para a **frente**, aparecendo a tapar a parede numa faixa central.
Correção (em `makeFacePair`): a todas as flaps + roll é forçado um
`polygonOffset` **positivo** (`factor = 1`, `units = 4`) que as renderiza sempre
**atrás** das paredes — sem deslocamento físico (não há folga visível). Marcadas
por `key`: `/_flap$/` ou `/^roll(_|$)/`.

### Selecionabilidade para artwork (dinâmica)
Nem todas as faces devem ser selecionáveis para logo, e isso **depende do estado
de fecho**:
- Paredes, `base`, `glue` e `lid` → **sempre** selecionáveis.
- Todas as **flaps** (corpo + tampa) e o `roll` → marcadas com
  `userData.isHidingFlap = true`. São selecionáveis com a caixa **aberta** (para
  lhes pôr logo), mas **excluídas do raycast quando a caixa está fechada**
  (`animT >= 0.95`) — assim, com a caixa montada, o clique de lado apanha sempre
  `left`/`right` (outer) e nunca uma flap que está escondida atrás.

Implementação: `makeFacePair` define `userData.selectable` e
`userData.isHidingFlap`; `selectableMeshes()` (no raycasting) filtra a lista
antes do `intersectObjects`, aplicando a regra dinâmica em cada hover/clique.

Materiais são **opacos** (sem `transparent/opacity`) — senão o z-fighting volta
a ser visível.

## 6. Artwork (logos por face)

Fluxo (no engine):
1. Utilizador seleciona uma face (raycast) → upload de imagem.
2. `buildCompositeTexture` compõe um canvas com a cor base da face + o logo
   centrado (object-fit:contain), proporcional ao aspect-ratio **real** da face
   (em mm) para não distorcer. Suporta rotação 0/90/180/270.
3. `stripWhiteBackground` remove o fundo (quase-)branco do logo (threshold 235)
   para a cor da face aparecer por trás.
4. UVs da face são normalizados para `[0,1]²` sobre o bbox; a textura é aplicada
   ao material (mantendo o `polygonOffset` por `order`).

Persistência:
- Estado local: `artwork = {face_key: data_url}` e `artworkRot = {face_key: deg}`.
- **Guardar:** `POST /dieline/artwork/save` (JSON-RPC, auth=user) →
  `product.box_artwork` (Text com JSON). As rotações vão sob a chave reservada
  `__rot__` no mesmo payload.
- **Carregar:** `GET /dieline/artwork/load?product_id=N` → reaplica a cada face.

## 7. Rebuild paramétrico (mudar dimensões)

A página tem inputs L/W/H. Ao aplicar, `ATP_DIELINE.rebuild(L,W,H)`:
1. Se `ATP_CONFIG.boxType` for conhecido, **gera um novo SVG** paramétrico
   (geradores `rsc_regular_slotted` e `rollover_hinged_lid`) e reconstrói.
2. Caso contrário, re-parseia o SVG original em cache (`svgTextCache`).

> Nota: existem geradores **em dois sítios** — `dieline_generators.js` e um IIFE
> `_generators` embutido no `dieline_engine.js`. O engine usa o embutido. Vale a
> pena consolidar num só para evitar divergência.

## 8. Configuração injetada (`ATP_CONFIG`)

Definida em `dieline_templates.xml` antes dos scripts:
```js
window.ATP_CONFIG = {
  boxType, L, W, H,
  dielineSvgUrl,        // /dieline/svg/<id>
  productId, productVariantId, productPrice
};
```

## 9. Fluxo ponta-a-ponta

```
product.box_dieline_svg (Binary, attachment)
        │  GET /dieline/svg/<id>
        ▼
DielineParser.build(svgText)  ──►  árvore {nodes:[{points, edge, angle, parent}]}
        │
        ▼
buildFromGeometry(geo)  ──►  Three.js (pivots encadeados, par outer/inner por face)
        │                         │
   updateFolds(animT)        raycasting → seleção de face
        │                         │
   animação montar/desmontar  artwork por face ──► POST /dieline/artwork/save
```

## 10. API de debug

`window.ATP_DIELINE` expõe `scene`, `folds`, `setFold(t)`, `rebuild(L,W,H)` —
útil para testes headless e inspeção na consola.
