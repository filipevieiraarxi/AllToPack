# AllToPack — Documentação Técnica do Configurador 3D

## Índice

1. [Visão geral do sistema](#1-visão-geral-do-sistema)
2. [Formato SVG de entrada (Format B)](#2-formato-svg-de-entrada-format-b)
3. [dieline_parser.js — Pipeline completa](#3-dieline_parserjs--pipeline-completa)
4. [TemplateMapper — Como funciona e como adicionar uma nova caixa](#4-templatemapper--como-funciona-e-como-adicionar-uma-nova-caixa)
5. [dieline_engine.js — Motor 3D](#5-dieline_enginejs--motor-3d)
6. [dieline_logo2d.js — Compositor de logos](#6-dieline_logo2djs--compositor-de-logos)
7. [Integração backend Odoo](#7-integração-backend-odoo)
8. [Fluxo completo de dados](#8-fluxo-completo-de-dados)
9. [Referência rápida de depuração](#9-referência-rápida-de-depuração)

---

## 1. Visão geral do sistema

O configurador 3D é composto por três camadas JavaScript independentes que comunicam através de objetos simples:

```
SVG (Format B)
    │
    ▼
dieline_parser.js          ← extrai geometria DCEL + aplica TemplateMapper
    │  output: geo { meta, unit, rootKey, type, nodes[] }
    ▼
dieline_engine.js          ← constrói modelo Three.js e anima dobras
    │  output: meshMap { panel_0_outer, panel_0_inner, … }
    ▼
dieline_logo2d.js          ← compositor 2D de logos sobre o SVG
       usa: ATP_DIELINE.getGeo() + ATP_DIELINE.applyLogoTexture()
```

Nenhuma das três camadas conhece os detalhes das outras. O parser não sabe o que é o Three.js; o engine não sabe o que é um SVG. O objeto `geo` é a fronteira de contrato entre elas.

---

## 2. Formato SVG de entrada (Format B)

### Estrutura obrigatória

O SVG deve ter um elemento raiz com `id="root_group"`. Todos os elementos gráficos relevantes (linhas de corte e vinco) são filhos directos deste grupo.

```xml
<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>{"length":200,"width":150,"height":100,"thickness":2}</metadata>
  <g id="root_group">
    <line style="stroke:rgb(255,0,0)" x1="0" y1="0" x2="200" y2="0"/>
    <line style="stroke:rgb(0,0,255)" x1="0" y1="100" x2="200" y2="100"/>
    <path style="stroke:rgb(255,0,0)" d="M 0,0 L 200,0 L 200,300 Z"/>
  </g>
</svg>
```

### Convenção de cores

| Cor CSS | Código RGB | Significado |
|---------|-----------|-------------|
| Vermelho | `rgb(255,0,0)` | Linha de corte (contorno exterior) |
| Azul | `rgb(0,0,255)` | Vinco / linha de dobra |
| Verde | `rgb(0,128,0)` | Cotas dimensionais — **ignorado** pelo parser |

Apenas elementos `<line>` e `<path>` são processados. Todos os outros elementos são ignorados.

### Metadata

O bloco `<metadata>` é JSON com os campos:

| Campo | Tipo | Unidade | Descrição |
|-------|------|---------|-----------|
| `length` | number | mm | Comprimento interno da caixa |
| `width` | number | mm | Largura interna |
| `height` | number | mm | Altura interna |
| `thickness` | number | mm | Espessura do cartão (default: 2) |
| `box_type` | string | — | Tipo FEFCO (ex: `FEFCO_0201`) |

O campo `box_type` na metadata é sobreposto pelo parâmetro `type` passado a `build(text, type)`.

### Caixas de 2 peças (Format B2BA)

Para caixas como a FEFCO_0330 (base + tampa separadas), o SVG contém 4 grupos:
- Cada peça (base e tampa) aparece duas vezes no SVG — uma vista de cima e outra de baixo.
- O parser separa automaticamente as cópias usando conectividade dos painéis via grafo DCEL.
- O TemplateMapper específico (ex: `templateFEFCO_0330`) usa `midX` para distinguir esquerda (tampa) de direita (base) e selecciona o componente conexo maior de cada lado.

---

## 3. dieline_parser.js — Pipeline completa

### Etapas sequenciais

```
parseColoredLines → buildGraph → buildHalfEdges → findFaces
    → filterFaces → assignKeys → buildFoldTree → TemplateMapper
    → reorderPanelKeys
```

#### 3.1 parseColoredLines

Percorre todos os filhos de `#root_group` e classifica os segmentos por cor:
- `red[]` — segmentos de corte
- `blue[]` — segmentos de vinco

Suporta elementos `<line>` (directamente) e `<path>` (parser de comandos SVG: M, L, H, V, A, Z, C, S, Q, T — curvas cúbicas/quadráticas são aproximadas pelo seu ponto final).

Arcos (`A`) são convertidos em segmentos lineares por `arcToSegments` com `ARC_STEPS=8` pontos.

#### 3.2 buildGraph

Converte segmentos soltos num grafo de vértices + arestas.

**Snap adaptativo:** calcula `SNAP = min(6, max(0.5, min(spanX, spanY) * 0.002))` em função das dimensões do SVG. Dois pontos dentro deste raio são fundidos num único vértice.

**Colapso de shorts fold:** arestas vermelhas muito curtas (`< FOLD_CORNER_SNAP = min(20, SNAP*5)`) entre dois pontos que são endpoints de vincos são colapsadas via union-find, mantendo a colinearidade dos vincos.

**T-junctions (`resolveT`):** quando um vértice fica sobre o interior de uma aresta (dentro de `SNAP`), essa aresta é partida em dois segmentos. Iterado até convergência (máx. 10 iterações).

#### 3.3 buildHalfEdges (DCEL)

Constrói a estrutura de meias-arestas (Doubly Connected Edge List):
- Por cada aresta `{a,b}` são criadas duas meias-arestas opostas.
- `next`: a meia-aresta seguinte em sentido **anti-horário** em torno de cada face, calculada encontrando o ângulo de menor rotação à esquerda a partir da chegada.
- `twin`: a meia-aresta oposta.

#### 3.4 findFaces

Segue as ligações `next` a partir de cada meia-aresta não visitada para extrair todas as faces (ciclos fechados de ≥ 3 vértices).

#### 3.5 filterFaces

Remove:
- **Face exterior** — a face de maior área (envolvente do diagrama inteiro).
- **Slivers** — faces com área < `totalArea * SLIVER_RATIO` (0.0008).
- **Fantasmas** — faces sem nenhuma aresta azul (`hasFold=false`) maiores que o maior painel real com vinco.
- **Faces quasi-totais** — bounding box > 90% do SVG em largura E altura.

#### 3.6 assignKeys

Ordena as faces remanescentes por **área decrescente** e atribui `panel_0`, `panel_1`, … , `panel_N`. Esta numeração é **temporária** — é renumerada no final em BFS order.

#### 3.7 buildFoldTree

Constrói uma árvore de painéis por BFS, priorizando arestas de vinco (azuis) sobre arestas de corte.

Dois passes:
1. Primeiro BFS: apenas arestas de vinco (`foldQueue`).
2. Segundo BFS: arestas de corte para os painéis ainda não visitados (`cutQueue`).

Painéis não alcançados são anexados ao root com `edge=null`.

Cada nó da árvore tem:
```js
{
  key: 'panel_3',           // temporário, renumerado depois
  parentKey: 'panel_0',     // null no root
  angle: 90,                // ângulo de dobra (graus)
  points: [{x,y}, ...],     // polígono em coordenadas SVG (px)
  edge: {x1,y1,x2,y2},      // aresta de dobra em coords SVG; null no root
  isFoldEdge: true,          // true se a aresta partilhada era azul
}
```

O resultado `nodes._adj` contém o grafo de adjacência completo para uso pelos TemplateMappers.

#### 3.8 TemplateMapper

Ver secção 4.

#### 3.9 reorderPanelKeys

Após o TemplateMapper (que pode mudar `parentKey`), o root real é determinado:
- `roots = nodes.filter(n => n.parentKey == null)`
- Para caixas de 2 peças: prefere o root sem `_lidRoot=true` (a base).

BFS a partir do root real → atribui `panel_0` ao root, `panel_1`, `panel_2`, … em ordem de descoberta.

### Output do parser

```js
{
  meta: { length, width, height, thickness, ... },  // da <metadata> do SVG
  unit: number,           // px por mm (calculado a partir de meta.length e bbox do panel_0)
  rootKey: 'panel_0',     // sempre panel_0 após reorder
  type: 'FEFCO_0201',     // tipo passado a build() ou meta.box_type
  nodes: [
    {
      key: 'panel_0',
      id: 'panel_0',
      parentKey: null,
      angle: 90,
      points: [{x,y}, ...],
      edge: null,
      isFoldEdge: false,
      foldSign: -1,         // -1 ou 1; adicionado pelo TemplateMapper
      animGroup: 0,         // inteiro ≥ 0; adicionado pelo TemplateMapper
      // opcionais adicionados por alguns mappers:
      _dvInverted: true,    // (FEFCO_0215 p0) inverte UV-v na textura
      _isLid: true,         // (FEFCO_0330) marca painéis da tampa
      _lidRoot: true,       // (FEFCO_0330) marca o root da tampa
    },
    ...
  ]
}
```

---

## 4. TemplateMapper — Como funciona e como adicionar uma nova caixa

### Conceito

O TemplateMapper é a única parte do sistema com conhecimento da topologia específica de cada tipo de caixa FEFCO. O engine 3D é completamente genérico; toda a semântica está aqui.

Cada mapper é uma função que recebe `nodes` (a lista de nós após `buildFoldTree`) e pode:
1. **Modificar `foldSign`** — qual lado dobra para dentro (-1) ou para fora (+1).
2. **Modificar `animGroup`** — em que fase da animação este painel dobra.
3. **Modificar `parentKey` e `edge`** — reorganizar a árvore de dobras.
4. **Adicionar flags privados** (`_dvInverted`, `_isLid`, etc.) — para uso no engine.

Os mappers recebem `nodes._adj` (grafo de adjacência original) para navegar a topologia.

### Campos adicionados por cada mapper

| Campo | Tipo | Significado |
|-------|------|-------------|
| `foldSign` | -1 \| 1 | Direcção de dobra. **-1** = dobra "para fora" (padrão, a aba levanta-se do plano). **+1** = dobra "para dentro". |
| `animGroup` | inteiro ≥ 0 | Grupos com valor menor animam primeiro. Painéis com o mesmo valor animam em paralelo. |

### Como o engine usa estes campos

**`foldSign`:** no engine, cada dobra roda o `foldGroup` em torno do eixo local û (ao longo da aresta). O ângulo final é `angle * foldSign * (π/180)`. Com `-1` o painel levanta-se para o exterior; com `+1` dobra para o interior.

**`animGroup`:** `calcFoldWindows()` agrupa as dobras por `animGroup`, ordena por valor crescente e distribui janelas de tempo `[tStart, tEnd]` sem sobreposição dentro do intervalo `[0, 1]`. Dobras do grupo 0 ocupam os primeiros `1/N` do timeline, grupo 1 os seguintes, etc.

### Função auxiliar `defaultFoldSign`

Calcula o foldSign geometricamente: compara o centróide do nó com o centróide do pai em relação ao normal da aresta de dobra. Se estão do mesmo lado → `+1`; lados opostos → `-1`.

```js
function defaultFoldSign(node, parentNode) {
    // normal à aresta de dobra (perpendicular no plano SVG)
    var nx = -dy/len, ny = dx/len;
    // dot product com vector nó→aresta e pai→aresta
    return (nodeDir * parDir < 0) ? -1 : 1;
}
```

### Função auxiliar `_rscAnimGroups`

Para caixas RSC (tubo retangular com abas em cima e em baixo), determina automaticamente quais painéis são paredes (animGroup=0) e quais são abas de topo/fundo (1 ou 2) pela posição Y do centróide em relação ao band Y das arestas horizontais.

```js
_rscAnimGroups(nodes, topFirst);
// topFirst=true  → abas de topo=ag1, fundo=ag2
// topFirst=false → fundo=ag1, topo=ag2
```

---

### Guia: adicionar suporte a um novo tipo de caixa

#### Passo 1 — Criar a função mapper

```js
function templateFEFCO_XXXX(nodes) {
    var nodeByKey = {};
    nodes.forEach(function(n) { nodeByKey[n.key] = n; });
    var adj = nodes._adj || {};  // grafo de adjacência

    // 1. Definir foldSign para todos
    nodes.forEach(function(n) { n.foldSign = -1; });

    // 2. Definir animGroup para todos
    //    animGroup=0 → primeira fase (paredes principais)
    //    animGroup=1 → segunda fase (abas laterais)
    //    animGroup=2 → terceira fase (tampa/fundo)
    var animMap = {
        'panel_0': 0,  // root (parede principal)
        'panel_1': 0,  // parede oposta
        'panel_2': 0,  // parede lateral
        'panel_3': 0,  // parede lateral oposta
        'panel_4': 1,  // aba de fundo
        'panel_5': 1,  // aba de fundo
        'panel_6': 2,  // aba de tampa
        'panel_7': 2,  // aba de tampa
    };
    nodes.forEach(function(n) {
        n.animGroup = animMap[n.key] !== undefined ? animMap[n.key] : 0;
    });

    // 3. Ajustes de parentKey/edge se necessário
    // (apenas se a árvore do buildFoldTree não for correcta)
}
```

#### Passo 2 — Registar no dispatcher

```js
var TEMPLATE_MAPPERS = {
    // ... mappers existentes ...
    'FEFCO_XXXX': templateFEFCO_XXXX,
};
```

#### Passo 3 — Configurar o produto no Odoo

No produto, definir `box_type = 'FEFCO_XXXX'`. O parser lê este valor e invoca o mapper correcto.

#### Passo 4 — Descobrir as keys dos painéis

A chave dos painéis (`panel_0`, `panel_1`, …) depende da ordem de área **antes** do reorder. A forma mais rápida de os mapear:

1. Usar o mapper `GENERIC` temporariamente.
2. No browser, abrir a consola e inspecionar `window._lastGeo.nodes.map(n => ({key:n.key, area: Math.round(polyArea(n.points)), parent: n.parentKey}))`.
3. Os labels amarelos sobrepostos no 3D mostram o número de cada painel.

Após o reorder, `panel_0` é sempre o root BFS. As keys no `animMap` devem corresponder às keys **antes do reorder** (porque o mapper corre antes do reorder). Para descobri-las, é necessário desativar o reorder temporariamente ou ler `nodes` logo após `buildFoldTree`.

**Nota importante:** o `animMap` no `templateFEFCO_0427` usa as keys **pré-reorder** (ordem por área). O reorder acontece depois, mas os `animGroup` e `foldSign` ficam associados aos nós por referência e são preservados.

#### Exemplos de padrões comuns

**Caixa RSC simples (4 paredes + abas):**
```js
function templateFEFCO_MINHA_CAIXA(nodes) {
    _rscAnimGroups(nodes, true); // topo fecha primeiro
}
```

**Caixa com topologia de fold não óbvia:**
```js
function templateFEFCO_MINHA_CAIXA(nodes) {
    _foldTreeByConnectivity(nodes); // reconstrói árvore pelo grau de fold
}
```

**Caixa com painel que dobra no sentido errado:**
```js
function templateFEFCO_MINHA_CAIXA(nodes) {
    templateGeneric(nodes); // base
    var nodeByKey = {};
    nodes.forEach(function(n) { nodeByKey[n.key] = n; });
    // corrigir só o painel que dobra ao contrário
    if (nodeByKey['panel_3']) nodeByKey['panel_3'].foldSign = 1;
}
```

**Caixa com aba que deve dobrar como filha de outra aba (não do root):**
```js
// Mover panel_5 para ser filho de panel_2 em vez do root
var p5 = nodeByKey['panel_5'], p2 = nodeByKey['panel_2'];
if (p5 && p2) {
    p5.parentKey = 'panel_2';
    p5.edge = sharedEdge(p5, p2); // calcular aresta partilhada
}
```

#### Função utilitária: calcular aresta partilhada entre dois painéis

Vários mappers incluem versões locais desta função. A lógica é a mesma em todos:

```js
function sharedEdge(nA, nB) {
    var ptsA = nA.points, ptsB = nB.points, EPS = 4, bestLen = 0, bestEdge = null;
    for (var i = 0; i < ptsA.length; i++) {
        var a1 = ptsA[i], a2 = ptsA[(i+1) % ptsA.length];
        var dx = a2.x - a1.x, dy = a2.y - a1.y, segLen = Math.hypot(dx, dy) || 1;
        // verificar se pontos de ptsB estão sobre este segmento
        var tsB = ptsB.map(function(p) {
            var d = Math.abs((p.x-a1.x)*dy - (p.y-a1.y)*dx) / segLen;
            if (d > EPS) return null;
            return ((p.x-a1.x)*dx + (p.y-a1.y)*dy) / (segLen*segLen);
        }).filter(function(t) { return t !== null; });
        if (!tsB.length) continue;
        // sobreposição entre [0,1] e [min(tsB), max(tsB)]
        var oMin = Math.max(0, Math.min.apply(null, tsB));
        var oMax = Math.min(1, Math.max.apply(null, tsB));
        var ov = (oMax - oMin) * segLen;
        if (ov > EPS && ov > bestLen) {
            bestLen = ov;
            var ux = dx/segLen, uy = dy/segLen;
            var p1 = {x: a1.x + ux*oMin*segLen, y: a1.y + uy*oMin*segLen};
            var p2 = {x: a1.x + ux*oMax*segLen, y: a1.y + uy*oMax*segLen};
            bestEdge = {x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y};
        }
    }
    return bestEdge;
}
```

A aresta devolvida é orientada pelo polígono A. A orientação importa para o `foldSign` geométrico (o normal da aresta aponta de A para B ou o contrário).

---

### Tabela de mappers existentes

| Mapper | Tipo de caixa | Estratégia |
|--------|-------------|-----------|
| `templateGeneric` | Genérico | Depth na árvore BFS; isLid por área/foldEdge |
| `templateFEFCO_0200` | RSC standard | `_rscAnimGroups(true)` |
| `templateFEFCO_0201` | RSC com abas cola | Root = parede central; abas por posição Y |
| `templateFEFCO_0215` | Caixa com tampa deslizante | RSC + p0 torna filho de p2; `_dvInverted=true` |
| `templateFEFCO_0216` | RSC invertido | `_rscAnimGroups(false)` |
| `templateFEFCO_0330` | Base + tampa separadas (B2BA) | Divide SVG em 2 componentes por midX; BFS por grupo |
| `templateFEFCO_0422` | Caixa com janela | BFS default + animMap fixo |
| `templateFEFCO_0425` | Caixa complexa multi-aba | animMap fixo + correções de edge |
| `templateFEFCO_0426` | Crash-lock | `_foldTreeByConnectivity` |
| `templateFEFCO_0427` | Caixa com inserção | animMap fixo pré-reorder |
| `templateFEFCO_0473` | Fita biadesiva | `_foldTreeByConnectivity` |
| `templateFEFCO_04XX` | Família 04 genérica | `templateGeneric` |

---

## 5. dieline_engine.js — Motor 3D

### Arquitectura de cena Three.js

```
scene
└── boxPivot          ← recebe a quaternion de rotação do utilizador
    ├── baseSpin      ← roda a BASE 90° sobre si própria (animação insert FEFCO_0330)
    │   └── boxGroup  ← -90° em X (levanta o dieline do chão para vertical)
    │       ├── [mesh root]
    │       └── [pivot + foldGroup por cada painel filho]
    └── lidGroup      ← só existe em caixas de 2 peças; mesma rotação que boxGroup
        └── [mesh lidRoot + painéis da tampa]
```

### Mapeamento de coordenadas

**SVG → Cena (estado planificado):**
```
SVG (x, y)  →  Three.js (X = mm(x - off.x),  Y = 0,  Z = mm(y - off.y))
```
O dieline assenta no plano XZ (chão). `off` é o canto superior esquerdo do bounding box do root.

**Estado planificado → montado:**
`boxGroup.rotation.x = -π/2` levanta a caixa para a vertical. O `boxGroup.position` é ajustado para que o centro geométrico coincida com a origem.

### Sistema local de cada painel (buildChild)

Cada painel filho tem um sistema de coordenadas locais definido pela sua aresta de dobra:
- **û** — direcção ao longo da aresta (normalizado)
- **n̂** — perpendicular a û no plano SVG, apontando para o centróide do painel
- **ẑ** = û × n̂ — normal da face

A matriz `restWorld` do painel transforma coords locais `(s, d, 0)` para coords de cena no estado planificado (deitado).

O pivot de dobra é posicionado em `A` (extremo da aresta) com orientação dada por `localM = inv(parentRest) · childRest`. O `foldGroup` interno roda em torno de `X local = û`, produzindo a dobra.

### Animação por fases

```
t = 0.0  →  planificado (todos os ângulos a 0°)
t = 1.0  →  montado     (cada painel ao seu angle * foldSign)
```

`calcFoldWindows()` distribui janelas `[tStart, tEnd]` em `[0, 1]` pelo `animGroup`:
- Grupo 0 → `[0, 1/N]`
- Grupo 1 → `[1/N, 2/N]`
- etc.

Dentro de cada janela, a interpolação usa `ease(t) = t < 0.5 ? 2t² : -1 + (4-2t)t` (suavização quadrática).

**Caixas de 2 peças (FEFCO_0330):** a timeline é dividida em duas fases:
- `t ∈ [0, INSERT_START=0.6]` → dobras normais (remapeadas para `[0,1]`)
- `t ∈ [0.6, 1]` → animação de encaixe: base roda 90°, tampa desce

### Espessura do material

Cada painel tem duas faces (`_outer` e `_inner`) afastadas `matThickness/2` em Z local, mais um mesh de borda lateral. `matThickness` é lido de `geo.meta.thickness` (mm) ou usa o default de 2 mm.

### Z-fighting (polygonOffset)

Abas coplanares (ex: flaps que se encontram ao meio da tampa) usariam o mesmo plano depth. `applyPolyOffset(opts, order)` aplica `polygonOffsetUnits = -(order+1)*0.05` por nó, garantindo uma ordem determinística sem deslocar geometria visivelmente.

Flaps (painéis cujo key termina em `_flap` ou começa por `roll`) recebem `polygonOffsetFactor=1, Units=4` (offset positivo = empurrados para trás) para não aparecerem sobre as paredes quando fechados.

### API pública (`window.ATP_DIELINE`)

```js
ATP_DIELINE.getGeo()                              // retorna o geo activo
ATP_DIELINE.getMeshMap()                          // { 'panel_0_outer': Mesh, ... }
ATP_DIELINE.applyLogoTexture(panelKey, side, canvas2d)  // aplica canvas como textura
ATP_DIELINE.rebuild(svgText, type)               // re-parseia e reconstrói
ATP_DIELINE.animateTo(t)                         // move animação para t ∈ [0,1]
```

---

## 6. dieline_logo2d.js — Compositor de logos

### Estado

```js
logos = {
    front: [   // logos na face exterior
        {
            panelKey: 'panel_0',
            side: 'outer',
            s: 55.2,       // centro horizontal em mm no espaço local do painel
            d: 40.1,       // centro vertical em mm no espaço local do painel
            sizeMM: 80,    // largura do logo em mm
            rot: 0,        // rotação em graus
            dataUrl: '...', // imagem original
            img: HTMLImageElement,
        }
    ],
    back: [...] // logos na face interior
}
```

### Coordenadas locais do painel (s, d)

O sistema de coordenadas local de cada painel é definido pelo engine:
- `s` → ao longo da aresta de dobra (û)
- `d` → perpendicular à aresta, para o interior do painel (n̂)
- Origem: extremo A da aresta de dobra

Para o root (sem aresta), `s = mm(x - off.x)`, `d = mm(y - off.y)`.

A conversão é feita via `node._svgToLocal(p)` e `node._localToSvg(s, d)` calculadas pelo engine e expostas no geo.

### Sincronização 2D ↔ 3D

1. Logo posicionado/arrastado no canvas 2D.
2. `applyLogoTexture(panelKey, side, canvas2d)` chamado.
3. Engine cria `CanvasTexture` e aplica ao mesh `panel_N_outer` ou `panel_N_inner`.
4. UV do mesh é normalizado pelo bounding box local do painel (normaliseFaceUVs).

### Formato de exportação (artwork_json)

```json
{
  "__logo__":      { "panelKey": "panel_0", "side": "outer", "s": 55, "d": 40, "sizeMM": 80, "rot": 0, "dataUrl": "..." },
  "__logo__1":     { "panelKey": "panel_2", "side": "outer", "s": 30, "d": 25, "sizeMM": 60, "rot": 0, "dataUrl": "..." },
  "__logo_back__": { "panelKey": "panel_0", "side": "inner", "s": 55, "d": 40, "sizeMM": 80, "rot": 0, "dataUrl": "..." }
}
```

- Índice 0: chave sem sufixo (`__logo__`, `__logo_back__`)
- Índices > 0: sufixo numérico (`__logo__1`, `__logo__2`, …)

---

## 7. Integração backend Odoo

### `_scale_dieline_svg(svg, L0, W0, H0, L, W, H)`

Escala o SVG das dimensões originais `(L0, W0, H0)` para novas dimensões `(L, W, H)`. Aplica transformações afins separadas para X e Y dependendo da direcção de cada segmento. Actualiza também o texto das cotas verdes.

### `_inject_logos_into_svg(svg, artwork, prod, rec)`

Para download do SVG com logos:
1. Lê o artwork_json da encomenda.
2. Para cada logo, converte `(s, d, sizeMM)` para coordenadas SVG usando a inversa do sistema local do painel.
3. Injeta `<image>` no SVG na posição correcta com rotação.
4. Injeta `<line>` e `<text>` de cotas (distâncias do logo ao bordo do painel em mm).

### Modelo `sale.order.dieline`

Campos relevantes para a pipeline:
- `artwork_json` — JSON com todos os logos (frente + verso)
- `svg_data` — SVG escalado nas dimensões da encomenda
- `box_type` — tipo FEFCO para re-parsear se necessário

---

## 8. Fluxo completo de dados

```
1. Browser carrega /dieline?product_id=X
   └── template Odoo injeta: ATP_CONFIG = { dielineSvgUrl, boxType, artwork, L, W, H }

2. dieline_engine.js inicializa Three.js
   └── fetcha SVG via ATP_CONFIG.dielineSvgUrl

3. DielineParser.parse(url, type)
   └── build(svgText, type) → geo

4. buildFromGeometry(geo) → constrói cena Three.js
   └── calcFoldWindows() → janelas de animação
   └── updateFolds(0) → estado planificado inicial

5. Utilizador ajusta L/W/H
   └── _scale_dieline_svg() no controller Odoo → novo SVG
   └── fetch novo SVG → rebuildFrom(geo) → resets animação

6. Utilizador faz upload de logo
   └── placeImage(dataUrl) ou placePanelCenter(node)
   └── logos[side].push({...})
   └── applyLogoTexture() → CanvasTexture no mesh 3D

7. "Adicionar ao carrinho"
   └── exportLogoState() → artwork_json
   └── POST /dieline/order/save → sale.order.dieline criado
   └── cart_update(product_id, qty, { dieline_config_id })

8. Admin abre encomenda
   └── GET /dieline/order/<id>/svg/front → SVG com logos injetados
```

---

## 9. Referência rápida de depuração

### Ver keys dos painéis no 3D

Os labels amarelos sobrepostos em cada painel mostram o número (`p0`, `p1`, etc.) correspondente a `panel_0`, `panel_1`, etc. após o reorder.

Para ver a estrutura completa antes do reorder (útil ao escrever um novo mapper):
```js
// Na consola do browser, depois de parsear
window._lastGeo.nodes.forEach(n => console.log(n.key, n.parentKey, n.animGroup, n.foldSign));
```

### Problema: painel dobra no sentido errado

Verificar `foldSign` do nó. `-1` = exterior (normal), `+1` = interior (invertido). Corrigir no mapper:
```js
nodeByKey['panel_X'].foldSign = 1; // forçar dobra interior
```

### Problema: painel anima na fase errada

Verificar `animGroup`. Grupos menores animam primeiro. Corrigir no `animMap` do mapper.

### Problema: aresta de dobra errada (painel prende a partir do sítio errado)

O `edge` do nó determina o eixo de rotação. Recalcular com `sharedEdge(nA, nB)` ou forçar via bbox:
```js
var b = bbox(node.points);
node.edge = {x1: b.x0, y1: b.y0, x2: b.x0, y2: b.y1}; // lado esquerdo do painel
```

### Problema: painéis não detectados (SVG sem painéis)

Verificar se o SVG tem `id="root_group"` no grupo raiz. Confirmar cores: vermelho exactamente `rgb(255,0,0)` e azul `rgb(0,0,255)`. Verificar se existem segmentos azuis (vincos) — sem eles, todos os painéis são filtrados.

### Cache do browser (JS não actualiza)

Incrementar o parâmetro `?v=` nos `<script>` tags em [dieline_templates.xml](AllToPack/alltoppack_website/views/dieline_templates.xml):
```xml
<script src="/web/static/src/js/dieline_parser.js?v=10"/>
```

### Problema: logo aparece invertido no 3D

O painel tem `_texYInvert=true` (root) ou a face está `faceFlipped`. Verificar se o campo `_dvInverted` está a ser usado correctamente no logo2d para compensar a inversão UV-v.
