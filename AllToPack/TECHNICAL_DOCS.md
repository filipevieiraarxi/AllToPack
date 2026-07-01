# AllToPack — Documentação Técnica do Configurador 3D

> Última actualização: 2026-07-01

## Índice

1. [Arquitectura geral do sistema](#1-arquitectura-geral-do-sistema)
2. [Formato SVG de entrada (Format B)](#2-formato-svg-de-entrada-format-b)
3. [dieline_parser.js — Pipeline completa](#3-dieline_parserjs--pipeline-completa)
4. [TemplateMappers — Todos os tipos existentes](#4-templatemappers--todos-os-tipos-existentes)
5. [Guia: Criar uma nova caixa (passo a passo)](#5-guia-criar-uma-nova-caixa-passo-a-passo)
6. [dieline_engine.js — Motor 3D](#6-dieline_enginejs--motor-3d)
7. [Sistema de animação de dobras](#7-sistema-de-animação-de-dobras)
8. [dieline_logo2d.js — Compositor de logos](#8-dieline_logo2djs--compositor-de-logos)
9. [dieline_generators.js — SVGs paramétricos](#9-dieline_generatorsjs--svgs-paramétricos)
10. [Backend Odoo — Modelos e rotas](#10-backend-odoo--modelos-e-rotas)
11. [APIs públicas](#11-apis-públicas)
12. [Fluxo completo de dados](#12-fluxo-completo-de-dados)
13. [Convenções de código e nomenclatura](#13-convenções-de-código-e-nomenclatura)
14. [Cache-busting e deploy](#14-cache-busting-e-deploy)

---

## 1. Arquitectura geral do sistema

O configurador 3D é uma stack de **três camadas independentes** que comunicam através de contratos simples:

```
┌─ SVG Format B (entrada) ──────────────────────────────┐
│  rgb(255,0,0) = cortes   rgb(0,0,255) = vincos        │
│  <metadata> JSON com L/W/H/thickness/box_type          │
└──────────────────┬────────────────────────────────────┘
                   ▼
          [dieline_parser.js]
          Pipeline DCEL (7 etapas)
          + TemplateMapper por tipo FEFCO
                   │
                   │  geo = { meta, unit, rootKey, type, nodes[] }
                   ▼
          [dieline_engine.js]
          Motor 3D Three.js — completamente genérico
          Constrói meshes, anima dobras, aplica texturas
                   │
                   │  ATP_DIELINE API pública
                   ▼
          [dieline_logo2d.js]
          Compositor 2D de logos + sincronização 3D
```

**Princípio chave:** o engine 3D não tem qualquer conhecimento de topologia FEFCO. Toda a lógica específica de cada tipo de caixa vive exclusivamente no TemplateMapper do parser.

---

## 2. Formato SVG de entrada (Format B)

### Estrutura obrigatória

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H">
  <metadata>{"length":200,"width":150,"height":100,"thickness":2,"box_type":"FEFCO_0201"}</metadata>
  <g id="root_group">
    <line style="stroke:rgb(255,0,0)" x1="0" y1="0" x2="200" y2="0"/>
    <line style="stroke:rgb(0,0,255)" x1="100" y1="0" x2="100" y2="300"/>
    <path style="stroke:rgb(255,0,0)" d="M 0,0 L 200,0 L 200,300 Z"/>
  </g>
</svg>
```

### Cores rigorosas (exatas)

| Cor | RGB | Significado |
|-----|-----|-------------|
| Vermelho | `rgb(255,0,0)` | Linhas de corte (contorno) |
| Azul | `rgb(0,0,255)` | Linhas de vinco (dobras) |
| Verde | `rgb(0,128,0)` | Cotas dimensionais (ignoradas pelo parser) |

### Campos da metadata JSON

| Campo | Tipo | Unidade | Obrigatório |
|-------|------|---------|-------------|
| `length` | number | mm | Sim |
| `width` | number | mm | Sim |
| `height` | number | mm | Sim |
| `thickness` | number | mm | Não (default: 5) |
| `box_type` | string | — | Não (default: GENERIC) |

### Caixas de 2 peças (Format B2BA)

Para caixas com base e tampa separadas (ex: FEFCO_0330), o SVG contém **4 grupos** — base (vista cima + vista baixo) e tampa (vista cima + vista baixo). O parser detecta os 2 componentes conexos por `midX` e usa apenas o maior de cada lado.

### Elementos suportados

- `<line>` com atributos `x1, y1, x2, y2`
- `<path>` com comandos: `M, m, L, l, H, h, V, v, A, a, Z, z, C, S, Q, T` (beziers aproximados por segmento endpoint-to-endpoint)

---

## 3. dieline_parser.js — Pipeline completa

### Etapa 1: parseColoredLines

Percorre filhos de `#root_group`, extrai segmentos por cor. Arcos `A` são aproximados em 8 segmentos lineares (`ARC_STEPS = 8`). Segmentos com comprimento < 1e-4 são ignorados.

### Etapa 2: buildGraph — Snap adaptativo + T-junctions

**Snap adaptativo:**
```javascript
SNAP = min(6, max(0.5, min(spanX, spanY) * 0.002))
```
Pontos dentro deste raio são fundidos num único vértice (evita gaps de 1-2px entre linhas adjacentes do SVG).

**Colapso de short-cuts:** Arestas vermelhas muito curtas (`< FOLD_CORNER_SNAP = min(20, SNAP*5)`) entre dois endpoints de vinco são colapsadas via union-find, mantendo colinearidade dos vincos.

**Resolução de T-junctions:** Iteração até convergência (máx 10×): quando um vértice fica sobre o interior de uma aresta, essa aresta é partida em 2 segmentos.

### Etapa 3: buildHalfEdges (DCEL)

Por cada aresta `{a,b}` → duas meias-arestas opostas. O `next` de cada meia-aresta é calculado por **menor rotação à esquerda** (ângulo delta normalizado em [0, 2π)).

### Etapa 4: findFaces

Segue ligações `next` a partir de cada meia-aresta não visitada → ciclos fechados de ≥ 3 vértices = uma face. Cada face recebe flag `hasFold = true` se alguma aresta da face é azul.

### Etapa 5: filterFaces

Remove:
- **Face exterior** (maior por área)
- **Slivers** (área < `totalArea × 0.0008`)
- **Fantasmas** (sem arestas azuis e área maior que o maior painel real)
- **Quasi-totais** (bbox > 90% × 90% do SVG)

### Etapa 6: assignKeys

Ordena faces por área decrescente → `panel_0`, `panel_1`, …, `panel_N` (**temporário** — estas keys mudam após reorderPanelKeys).

### Etapa 7: buildFoldTree

BFS a partir de `panels[0]` (maior painel), priorizando arestas de vinco (fold queue antes de cut queue). Cada nó recebe:

```javascript
{
  key: 'panel_3',          // key temporária (área-ordem)
  parentKey: 'panel_0',   // null no root
  angle: 90,              // ângulo de dobra (sempre 90 nesta fase)
  points: [{x,y}, ...],  // polígono em SVG-px
  edge: {x1,y1,x2,y2},   // aresta de dobra; null no root
  isFoldEdge: true,       // true = vinco azul, false = corte vermelho
  foldSign: undefined,    // preenchido pelo TemplateMapper
  animGroup: undefined,   // preenchido pelo TemplateMapper
}
```

Painéis não alcançados no BFS são anexados por heurística de eixo partilhado ou como filhos do root.

### Etapa 8: TemplateMapper

Enriquece os nodes com `foldSign`, `animGroup`, e pode reorganizar `parentKey`/`edge`. Ver secção 4.

### Etapa 9: reorderPanelKeys

BFS a partir do root real (nó com `parentKey == null`). Para caixas de 2 peças prefere o root sem `_lidRoot = true` (a base). Renumera: `panel_0 = root`, `panel_1, panel_2, …` em ordem BFS. **Estas são as keys finais usadas pelo engine.**

---

## 4. TemplateMappers — Todos os tipos existentes

### Conceito central

O TemplateMapper é a **única parte com conhecimento de topologia FEFCO**. Recebe `nodes` (pós-buildFoldTree, keys por área) e pode:

1. Modificar `foldSign` — qual lado dobra para dentro (`-1`) ou fora (`+1`)
2. Modificar `animGroup` — fase de animação (grupos maiores fecham depois)
3. Modificar `parentKey` e `edge` — reorganizar a árvore de dobras
4. Adicionar flags privados — `_dvInverted`, `_isLid`, `_lidRoot`, etc.

**Atenção:** as keys usadas no mapper são as **pré-reorder** (por área), não as finais. O `reorderPanelKeys` corre depois.

### Função auxiliar: defaultFoldSign

```javascript
function defaultFoldSign(node, parentNode) {
    // Normal à aresta de dobra no plano SVG
    var nx = -dy/len, ny = dx/len;
    // Se centróide do nó e do pai estão em lados opostos → -1 (dobra para dentro)
    return (nodeDir * parDir < 0) ? -1 : 1;
}
```

### Função auxiliar: _rscAnimGroups

Para caixas RSC (tubo + abas topo/fundo):
```javascript
_rscAnimGroups(nodes, topFirst)
// Detecta "band Y" (vincos horizontais)
// ag=0: centróide no band (paredes)
// ag=1 ou 2: abas acima/abaixo (topFirst controla quem fecha primeiro)
```

### Tabela resumo de todos os mappers

| Tipo | Mapper | Estratégia base | AnimGroups | Notas especiais |
|------|--------|----------------|------------|----------------|
| `GENERIC` | `templateGeneric` | Depth BFS; isLid por área/fold | depth-based | Fallback universal |
| `FEFCO_0200` | `templateFEFCO_0200` | `_rscAnimGroups(true)` | 0=paredes, 1=topo, 2=fundo | RSC standard |
| `FEFCO_0201` | `templateFEFCO_0201` | Root = parede central; BFS completo | 0=raiz+paredes, 1=abas baixo, 2=abas cima | Root escolhido por grau+proximidade ao centro |
| `FEFCO_0215` | `templateFEFCO_0215` | `_rscAnimGroups(false)` + swap root | 0=paredes, 1=fundo, 2=topo, 3=tampa | `_dvInverted=true` na tampa; UV-v invertido |
| `FEFCO_0216` | `templateFEFCO_0216` | `_rscAnimGroups(false)` | 0=paredes, 1=fundo, 2=topo | RSC invertido |
| `FEFCO_0330` | `templateFEFCO_0330` | 2 componentes conexos; rewireGroup fold-first | 0=roots, 1=abas folha, 2=lados, 3=resto | Base+Tampa; `_lidRoot=true`, `_isLid=true` |
| `FEFCO_0422` | `templateFEFCO_0422` | BFS default + fullSharedEdge | 0=caixa, 1=abas | Remove painéis < 3% rootArea; corrige janela |
| `FEFCO_0425` | `templateFEFCO_0425` | Ajuste geométrico + animMap fixo | 0=corpo, 1=lados, 2=abas ext | panel_5/6 geometria forçada |
| `FEFCO_0426` | `templateFEFCO_0426` | `_foldTreeByConnectivity` | depth-based | Crash-lock (fundo automático) |
| `FEFCO_0427` | `templateFEFCO_0427` | animMap fixo + edges manuais | 0=corpo, 1=abas lat, 2=abas ext, 3=tampas | Keys pré-reorder fixas no animMap |
| `FEFCO_0473` | `templateFEFCO_0473` | `_foldTreeByConnectivity` | depth-based | Fita biadesiva; fold diagonal |
| `FEFCO_04XX` | `templateFEFCO_04XX` | `templateGeneric` | depth-based | Família 04 genérica |

---

## 5. Guia: Criar uma nova caixa (passo a passo)

### Pré-requisitos

- SVG em Format B com `<metadata>` contendo `box_type: "FEFCO_XXXX"`
- Conhecimento da topologia: quais painéis dobram primeiro, em que ordem, para que lado

### Passo 1 — Definir o tipo no Odoo

Em `product.template`, o campo `box_type` aceita os tipos mapeados. Se estás a criar `FEFCO_0999`, basta adicionar a string ao campo (sem alterações ao Python — o parser usa a string directamente).

### Passo 2 — Criar o SVG Format B

O SVG deve ter:
- `<g id="root_group">` com linhas coloridas
- `<metadata>` com `{"box_type":"FEFCO_0999","length":L,"width":W,"height":H}`
- Vincos (azul) em **todos** os locais de dobra
- Cortes (vermelho) no contorno e nas separações entre painéis

**Dica:** verifica o SVG no browser carregando a página do configurador com um produto de teste. O parser vai extrair as faces e podes ver no console o que foi detectado.

### Passo 3 — Perceber a ordem de keys pré-reorder

Abre a consola do browser e adiciona temporariamente ao início de `applyTemplateMapper`:

```javascript
function applyTemplateMapper(nodes, type) {
    console.table(nodes.map(function(n){
        return { key: n.key, parent: n.parentKey, area: Math.round(polyArea(n.points)) };
    }));
    // ... resto do código
```

Isto mostra os painéis **ordenados por área decrescente** (keys pré-reorder). Anota qual `panel_N` corresponde a cada peça física (parede frontal, lateral, aba topo, etc.).

### Passo 4 — Criar o TemplateMapper

Adiciona a função em `dieline_parser.js` antes do dispatcher `TEMPLATE_MAPPERS`:

```javascript
/* ── TemplateMapper FEFCO_0999 ─────────────────────────────── */
function templateFEFCO_0999(nodes) {
    var nodeByKey = {};
    nodes.forEach(function(n) { nodeByKey[n.key] = n; });

    // PASSO A: Definir foldSign para todos os painéis
    // -1 = dobra para dentro (standard); +1 = dobra para fora
    nodes.forEach(function(n) { n.foldSign = -1; });

    // PASSO B: Correcções pontuais de foldSign
    // (quando um painel específico dobra ao contrário do defaultFoldSign)
    var tampa = nodeByKey['panel_1'];  // exemplo: panel_1 é a tampa
    if (tampa) tampa.foldSign = 1;

    // PASSO C: Definir animGroups
    // ag=0 → fecha primeiro (ou simultaneamente com outros ag=0)
    // ag=1 → fecha depois de ag=0
    // ag=2 → fecha depois de ag=1
    // etc.
    var animMap = {
        'panel_0': 0,   // parede principal (root)
        'panel_2': 0,   // parede oposta
        'panel_4': 0,   // parede lateral
        'panel_6': 0,   // parede lateral oposta
        'panel_1': 1,   // abas fundo
        'panel_3': 1,
        'panel_5': 2,   // abas topo (fecham por último)
        'panel_7': 2,
    };
    nodes.forEach(function(n) {
        n.animGroup = animMap[n.key] !== undefined ? animMap[n.key] : 0;
    });

    // PASSO D (opcional): Reorganizar árvore de dobras
    // Útil quando o BFS escolheu um root errado ou parentKeys errados
    // Exemplo: forçar panel_3 a ser filho de panel_0 em vez de panel_2
    var p3 = nodeByKey['panel_3'];
    if (p3) {
        p3.parentKey = 'panel_0';
        // recalcular edge (aresta partilhada entre panel_3 e panel_0)
        p3.edge = sharedEdgeBetween(p3, nodeByKey['panel_0']); // ver abaixo
    }
}
```

### Passo 5 — Registar no dispatcher

```javascript
var TEMPLATE_MAPPERS = {
    // ... existentes ...
    'FEFCO_0999': templateFEFCO_0999,  // ← adicionar aqui
};
```

### Passo 6 — Testar iterativamente

**Ciclo de debug recomendado:**

1. Carrega a caixa no browser
2. Abre a consola, procura erros
3. Usa o slider de animação para ver como dobra
4. Ajusta `animGroup` se a ordem estiver errada
5. Ajusta `foldSign` se um painel dobrar no sentido errado
6. Se um painel aparece no sítio errado (planificado ou montado), pode ser o `parentKey` ou `edge` errado

**Verificar foldSign visualmente:**
- `foldSign = -1` → painel fecha para o interior da caixa ✓
- `foldSign = +1` → painel abre para o exterior (correcto para tampas roll-over, etc.)

### Passo 7 — Casos especiais

#### Caixa com 2 peças separadas (base + tampa)

Ver `templateFEFCO_0330` como referência. Pontos-chave:
- O SVG deve conter as 2 peças lado a lado (B2BA format)
- O mapper divide por `midX` em 2 componentes conexos
- A peça maior = tampa (lid); a peça menor = base
- A tampa recebe `_lidRoot = true` e `_isLid = true` em todos os seus nós
- O engine cria `lidGroup` separado e anima o encaixe (INSERT_START = 0.6)

#### Root errado (parede com mais vincos é tomada como root)

```javascript
// Refazer BFS a partir do root correcto
var newRoot = nodeByKey['panel_X']; // painel que deve ser root
var seen = {}, queue = [newRoot.key], adj = nodes._adj || {};
seen[newRoot.key] = true;
newRoot.parentKey = null; newRoot.edge = null;
while (queue.length) {
    var cur = queue.shift();
    (adj[cur] || []).forEach(function(link) {
        if (seen[link.otherKey]) return;
        seen[link.otherKey] = true;
        var child = nodeByKey[link.otherKey];
        if (child) { child.parentKey = cur; child.edge = link.edge; }
        queue.push(link.otherKey);
    });
}
```

#### Calcular aresta partilhada entre dois painéis

```javascript
function sharedEdgeBetween(nA, nB) {
    var ptsA = nA.points, ptsB = nB.points, EPS = 4, bestLen = 0, bestEdge = null;
    for (var i = 0; i < ptsA.length; i++) {
        var a1 = ptsA[i], a2 = ptsA[(i+1) % ptsA.length];
        var dx = a2.x-a1.x, dy = a2.y-a1.y, segLen = hypot(dx,dy) || 1;
        for (var j = 0; j < ptsB.length; j++) {
            var b1 = ptsB[j], b2 = ptsB[(j+1) % ptsB.length];
            if (Math.abs((b1.x-a1.x)*dy-(b1.y-a1.y)*dx)/segLen > EPS) continue;
            if (Math.abs((b2.x-a1.x)*dy-(b2.y-a1.y)*dx)/segLen > EPS) continue;
            var t1 = ((b1.x-a1.x)*dx+(b1.y-a1.y)*dy)/(segLen*segLen);
            var t2 = ((b2.x-a1.x)*dx+(b2.y-a1.y)*dy)/(segLen*segLen);
            var ov = (Math.min(Math.max(t1,t2),1) - Math.max(Math.min(t1,t2),0)) * segLen;
            if (ov > EPS && ov > bestLen) {
                bestLen = ov;
                bestEdge = { x1: a1.x, y1: a1.y, x2: a2.x, y2: a2.y };
            }
        }
    }
    return bestEdge;
}
```

#### animGroup com keys pré-reorder (FEFCO_0427 pattern)

Quando usas um `animMap` fixo com keys pré-reorder (`panel_0` = maior painel por área), as keys no map referem-se à **ordem por área** — não à ordem BFS final. Isto é intencional e correcto porque o mapper corre antes do reorder.

#### Painel com UV invertido (FEFCO_0215 pattern)

Se a textura do logo aparecer espelhada num painel específico:
```javascript
node._dvInverted = true;
// O engine inverte o eixo V da textura para este painel
```

### Passo 8 — Adicionar ao CLAUDE.md (memoria do projecto)

Documenta a decisão no ficheiro CLAUDE.md ou nas memórias para referência futura.

---

## 6. dieline_engine.js — Motor 3D

### Hierarquia de grupos Three.js

```
scene
└── boxPivot                ← recebe quaternion de rotação do utilizador
    ├── baseSpin            ← roda a BASE durante insert (FEFCO_0330)
    │   └── boxGroup        ← rotation.x = -π/2 (levanta para vertical)
    │       ├── [meshes do root]
    │       ├── pivot_N     ← um por filho directo do root
    │       │   └── foldGroup_N
    │       │       ├── meshGroup  (outer + inner + edge faces)
    │       │       └── pivot_N_M  ← netos (filhos de filhos)
    │       │           └── foldGroup_N_M
    │       └── axesHelper  ← eixos LWH (excepto 0330: vai para boxPivot)
    └── lidGroup            ← FEFCO_0330 only; mesmo rotation.x que boxGroup
        └── [meshes da tampa]
```

### Mapeamento de coordenadas

**Estado planificado (t=0) — dieline deitado no plano XZ:**
```
SVG (x, y)  →  Scene (X = mm(x - off.x),  Y = 0,  Z = mm(y - off.y))
```

Onde `off = {x: rb.minX, y: rb.minY}` do `geo.nodes[0]` (pré-reorder, maior painel).

**Centramento em world(0,0,0):**
```javascript
var actualRoot = geo.nodes.filter(n => n.parentKey == null)[0];
var ab = polyBBox(actualRoot.points);
var p0cx = mm((ab.minX + ab.maxX) / 2 - off.x);
var p0cy = mm((ab.minY + ab.maxY) / 2 - off.y);
boxGroup.position.set(-p0cx, -p0cy, 0);
```
O centro do painel p0 (root) fica em world (0,0,0).

**Eixos no canto BL de p0:**
```javascript
axesHelper.position.set(mm(ab.minX - off.x), 0, mm(ab.maxY - off.y));
```

### Sistema local de cada painel (buildChild)

Cada painel filho tem um sistema de coordenadas definido pela aresta de dobra:
- **û** — direcção ao longo da aresta (normalizado)
- **n̂** — perpendicular a û no plano XZ, apontando para o interior do painel
- Matriz `restWorld` transforma coords locais → coords de cena no estado planificado

O pivot de cada filho é posicionado usando `localM = inv(parentRest) · childRest` — rigoroso a qualquer profundidade.

### Meshes: face pairs + edge

Por cada painel:
1. `_outer` mesh (FrontSide): face exterior, z = +matThickness/2
2. `_inner` mesh (BackSide): face interior, z = -matThickness/2
3. `_edge` mesh (DoubleSide): borda lateral decorativa

Registados em `meshMap` como `'panel_N_outer'`, `'panel_N_inner'`.

**Flaps** (abas de cola): `polygonOffset` ligeiramente atrás das paredes para evitar z-fighting quando a caixa está montada.

**Face flip**: se `zHat.y < 0`, a meshGroup inverte Z para corrigir qual face fica exterior.

### Eixos LWH

Três setas coloridas a partir do canto BL de p0:
- **Vermelho** → L (comprimento, +X)
- **Azul** → W (largura, +Y local = profundidade)
- **Verde** → H (altura, -Z local = para cima no mundo)

Para FEFCO_0330: `axesHelper` vai para `boxPivot` (com `rotation.copy(boxGroup.rotation)`) para não rodar quando a base anima o insert.

---

## 7. Sistema de animação de dobras

### calcFoldWindows

Distribui os `animGroup` em janelas de tempo [0, 1] sem sobreposição:

```
numRanks = número de grupos distintos (0, 1, 2, …)
Cada grupo ocupa 1/numRanks do intervalo total
grupo 0 → [0,        1/N]
grupo 1 → [1/N,      2/N]
grupo 2 → [2/N,      3/N]
...
```

### animateTo(t)

Para cada dobra, calcula `tLocal` dentro da janela do seu `animGroup`:

```javascript
tLocal = (t - tStart) / (tEnd - tStart)   // [0, 1]
k = ease(tLocal)                            // suavização
rotation.x = k * angle * foldSign
```

**Ease function:**
```javascript
ease(t) = t < 0.5 ? 2*t² : -1 + (4-2*t)*t
```

### Campos que controlam a animação

| Campo | Tipo | Efeito |
|-------|------|--------|
| `animGroup` | number | Fase de animação (0 = primeiro) |
| `foldSign` | -1 ou 1 | Sentido da dobra |
| `angle` | number | Ângulo máximo de dobra (default: 90°) |
| `isFoldEdge` | bool | Se false, é aba de corte (comportamento ligeiramente diferente) |

### Insert animation (FEFCO_0330 only)

Timeline combinada com `INSERT_START = 0.6`:
- `t ∈ [0, 0.6]` → dobras normais (remapeadas para [0,1])
- `t ∈ [0.6, 1]` → encaixe base+tampa (base roda, depois lid fecha)

---

## 8. dieline_logo2d.js — Compositor de logos

### Estado de logos

```javascript
logos = {
    front: [  // face exterior (outer)
        {
            panelKey: 'panel_0',
            side: 'outer',      // 'outer' ou 'inner'
            s: 55.2,            // coord local ao longo da aresta (mm)
            d: 40.1,            // coord local perpendicular (mm)
            sizeMM: 80,         // largura do logo em mm
            rot: 0,             // rotação em graus
            dataUrl: '...',     // imagem PNG/JPG base64
            img: HTMLImageElement
        }
    ],
    back: []
}
```

### Coordenadas locais do painel (s, d)

- **s** — ao longo da aresta de dobra (û)
- **d** — perpendicular, para o interior do painel (n̂)
- Origem: extremo A da aresta de dobra

### Múltiplos logos por face

`placePanelCenter(node)` faz `.push()` — permite N logos por face.

Exportação via `exportLogoState()`:
```json
{
  "__logo__":    { "panelKey": "panel_0", "s": 55, "d": 40, ... },
  "__logo__1":   { "panelKey": "panel_0", "s": 90, "d": 40, ... },
  "__logo_back__": { "panelKey": "panel_0", "s": 55, "d": 40, ... }
}
```

### Sincronização 2D ↔ 3D

1. Logo posicionado/arrastado no canvas 2D
2. `applyLogoTexture(panelKey, side, canvas2d)` chamado pelo engine
3. `CanvasTexture` criada a partir do canvas 2D
4. Aplicada ao mesh `panel_N_outer` ou `panel_N_inner`
5. UVs normalizados pelo bounding box local do painel

### Trim automático de imagem

- **PNG/SVG com alpha:** corta pixels com `alpha ≤ 10`
- **JPEG/opaco:** detecta cor dos 4 cantos como fundo (tolerância dist² < 400)

---

## 9. dieline_generators.js — SVGs paramétricos

### RSC (Regular Slotted Container)

```javascript
rsc(L, W, H)
// Gera: glue | front | right | back | left
// Cada parede com abas topo e fundo (altura = W/2)
// box_type: "FEFCO_0216"
```

### Rollover Hinged Lid

```javascript
rolloverHingedLid(L, W, H)
// Gera: glue | front | base | back | lid | rollover
// Lid com canto arredondado (r = H*0.2)
// box_type: "FEFCO_0215"
```

Ambos os generators produzem SVG Format B completo com `<metadata>` e `<g id="root_group">`.

---

## 10. Backend Odoo — Modelos e rotas

### Modelos principais

#### `product.template` (extended)

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `box_type` | Char | Tipo FEFCO (FEFCO_0201, 0216, etc.) |
| `box_l`, `box_w`, `box_h` | Float | Dimensões em mm |
| `box_dieline_svg` | Text | SVG base64 (Format B) |
| `box_artwork` | Text | JSON com logos configurados |
| `card_image_normal`, `card_image_hover` | Binary | Imagens para card de produto |

#### `sale.order.dieline`

Snapshot da configuração no momento da encomenda:
- Ligado a `sale.order.line` (cascade delete)
- Campos: dimensões, tipo, SVG escalado, `artwork_json`

#### `atp.partner.logo`

Galeria pessoal de logos por cliente:
- Campos: `partner_id`, `name`, `image`, `mimetype`

### Rotas HTTP

| Rota | Método | Função |
|------|--------|--------|
| `/dieline` | GET | Configurador 3D (template principal) |
| `/dieline/svg/<product_id>` | GET | Serve SVG do produto (com scaling L/W/H) |
| `/dieline/artwork/save` | POST JSON | Guarda artwork no produto |
| `/dieline/artwork/load` | GET | Carrega artwork do produto |
| `/dieline/order/save` | POST JSON | Cria/actualiza `sale.order.dieline` |
| `/dieline/order/preview/<id>` | GET | Preview read-only |
| `/dieline/order/<id>/svg/<side>` | GET | SVG com logos injectados (front/back) |
| `/dieline/logo/upload` | POST JSON | Upload logo para galeria |
| `/dieline/logo/list` | POST JSON | Lista logos do utilizador |
| `/dieline/logo/delete` | POST JSON | Remove logo da galeria |

### Funções auxiliares

**`_scale_dieline_svg(svg, L0, W0, H0, L, W, H)`**
Escala SVG de dimensões originais para novas, actualizando texto de cotas verdes.

**`_inject_logos_into_svg(svg, artwork, prod, rec)`**
Para cada logo em `artwork_json`: converte `(s, d, sizeMM)` → coords SVG, injeta `<image>` + linhas `<line>` + `<text>` de cotas em mm.

---

## 11. APIs públicas

### `window.ATP_DIELINE`

```javascript
ATP_DIELINE.getGeo()                              // geo activo { meta, unit, rootKey, type, nodes[] }
ATP_DIELINE.getMeshMap()                          // { 'panel_0_outer': Mesh, ... }
ATP_DIELINE.applyLogoTexture(panelKey, side, canvas2d)  // aplica textura
ATP_DIELINE.clearLogoTexture(panelKey)            // remove textura, restaura cor kraft
ATP_DIELINE.rebuild(L, W, H)                      // re-parseia SVG com novas dimensões
ATP_DIELINE.animateTo(t)                          // t ∈ [0, 1]
ATP_DIELINE.setView(v)                            // '3d', '2d', 'logo2d'
```

### `window.ATP_LOGO2D`

```javascript
ATP_LOGO2D.onGeoReady(geo, svgText)               // chamado pelo engine após rebuild
ATP_LOGO2D.placeImage(dataUrl, initialRot)        // coloca logo no panel_0
ATP_LOGO2D.placePanelCenter(node)                 // coloca logo centrado num painel
ATP_LOGO2D.removeSelected()                       // remove logo seleccionado
ATP_LOGO2D.exportLogoState()                      // retorna artwork_json indexado
ATP_LOGO2D.rotateLogo(deltaDeg)                   // roda logo seleccionado
ATP_LOGO2D.scaleSelected(deltaMM)                 // altera sizeMM do logo seleccionado
```

### `window.ATP_CONFIG` (injectado pelo template Odoo)

```javascript
{
  dielineSvgUrl: '/dieline/svg/42',
  boxType: 'FEFCO_0201',
  artwork: { __logo__: { ... } },
  L: 200, W: 150, H: 100,
  productId: 42,
  readonlyMode: false
}
```

---

## 12. Fluxo completo de dados

```
1. Browser carrega /dieline?product_id=X
   └─ template Odoo injeta ATP_CONFIG

2. initThree() → Three.js scene + renderer

3. fetch(ATP_CONFIG.dielineSvgUrl)
   └─ DielineParser.build(svgText, boxType)
      └─ Pipeline DCEL (etapas 1–9)
      └─ retorna geo

4. buildFromGeometry(geo)
   └─ boxPivot / baseSpin / boxGroup / lidGroup criados
   └─ para cada node: buildChild (pivot + foldGroup + meshes)
   └─ calcFoldWindows()
   └─ updateFolds(0)  → estado planificado
   └─ buildAxes(L, W, H)

5. Utilizador ajusta L/W/H → ATP_DIELINE.rebuild(L, W, H)
   └─ fetch SVG escalado → re-parseia → buildFromGeometry

6. Logo upload → POST /dieline/logo/upload
   └─ base64 guardado em atp.partner.logo

7. Logo posicionado → placePanelCenter(node)
   └─ logos[activeSide].push(...)
   └─ applyLogoTexture() → CanvasTexture → mesh

8. "Adicionar ao carrinho"
   └─ POST /dieline/order/save { artwork_json, L, W, H, ... }
   └─ cria sale.order.dieline

9. Admin → Download SVG
   └─ GET /dieline/order/<id>/svg/front
   └─ _inject_logos_into_svg() → SVG com logos e cotas
```

---

## 13. Convenções de código e nomenclatura

### Keys de painéis

- **Pré-reorder** (dentro do TemplateMapper): `panel_0` = maior área, `panel_1` = 2.º maior, etc.
- **Pós-reorder** (engine + logo2d + artwork): `panel_0` = root BFS, `panel_1`, `panel_2`, … em BFS order

### Mesh names (Three.js)

| Nome | Descrição |
|------|-----------|
| `panel_N_outer` | Face exterior (FrontSide) |
| `panel_N_inner` | Face interior (BackSide) |
| `panel_N_edge` | Borda lateral decorativa |

### Artwork JSON

```json
{
  "__logo__":    { "panelKey": "panel_0", "side": "outer", "s": 55, "d": 40, "sizeMM": 80, "rot": 0, "dataUrl": "..." },
  "__logo__1":   { "panelKey": "panel_1", "side": "outer", "s": 30, "d": 25, "sizeMM": 60, "rot": 90, "dataUrl": "..." },
  "__logo_back__": { ... }
}
```

- Índice 0: sem sufixo numérico (`__logo__`, `__logo_back__`)
- Índices > 0: sufixo numérico (`__logo__1`, `__logo_back__1`, …)

### Espaços de coordenadas

| Nome | Espaço | Unidade | Descrição |
|------|--------|---------|-----------|
| SVG-px | SVG 2D entrada | pixels | Coordenadas directas do SVG |
| mm | Real | milímetros | Dimensão real do cartão |
| local (s, d) | Painel | mm | s=ao longo aresta, d=perpendicular |
| canvas-px | Canvas 2D | pixels lógicos | Viewport com pan/zoom |
| scene/world | Three.js | mm | Coordenadas da cena 3D |

### CSS classes

Prefixo `.atp-*` (BEM). Exemplos: `.atp-dl-page`, `.atp-dl-sidebar`, `.atp-logo2d-view`.

---

## 14. Cache-busting e deploy

Os ficheiros JS são carregados com `?v=N` em `dieline_templates.xml`:

```xml
<script src="/alltoppack_website/static/src/js/dieline_parser.js?v=8.5"/>
<script src="/alltoppack_website/static/src/js/dieline_engine.js?v=106"/>
<script src="/alltoppack_website/static/src/js/dieline_logo2d.js?v=2"/>
```

**Regra obrigatória:** sempre que modificares qualquer um destes ficheiros JS, incrementar o `?v=` correspondente. Sem isto o browser serve a versão em cache e as alterações não aparecem mesmo após hard refresh.

O utilizador gere o processo Odoo exclusivamente pelo VSCode — **nunca parar/iniciar/matar o processo manualmente**. Para aplicar alterações nos JS basta incrementar o `?v=` e fazer hard refresh no browser (Ctrl+Shift+R).
