# Melhorias de Dragging de Logo - Geometria e Restrições

## Resumo das Alterações

Implementação de restrições geométricas avançadas para o sistema de dragging de logos nas caixas 3D. O utilizador pode agora arrastar o logo para qualquer lado da caixa com total respeito pelos limites geométricos.

## Funcionalidades Implementadas

### 1. **Constraining Geométrico Inteligente**
- O logo não pode sair dos limites da caixa
- Respeita automaticamente a geometria da bbox consolidada
- Permite movimento suave entre faces adjacentes

#### Função Principal
```javascript
function constrainLogoCenterToBounds(cx, cy)
```

**Características:**
- Calcula half-dimensions do logo (hw, hh)
- Ajusta para rotações (90°/270°) 
- Permite até 10% do logo sair (margem de visibilidade)
- Garante pelo menos 50% do logo fica dentro dos limites

### 2. **Suporte para Rotação**
- Quando o logo está rotacionado a 90° ou 270°, as dimensões efetivas são trocadas
- O constraining automático se ajusta à rotação aplicada

### 3. **Validação de Posição**
```javascript
function validateLogoPosition()
```

**Verifica:**
- Se o logo está visível em pelo menos 5% da área
- Se há interseção com a bbox da caixa
- Cálculo da percentagem de área visível

### 4. **Feedback Visual**
```javascript
function updateLogoPositionWarning()
```

**Mostra:**
- Aviso quando o logo sai dos limites
- Elemento HTML com ID `atp-artwork-position-warning`
- Atualizado em tempo real durante drag, rotação e escala

## Eventos Integrados

O constraining é ativado em:

1. **Mouse Move** - Durante drag com rato
2. **Touch Move** - Durante drag com toque
3. **Após Rotação** - Quando utilizador roda o logo (±90°)
4. **Após Escala** - Quando utilizador altera tamanho do logo
5. **Ao Carregar** - Quando artwork é carregado do backend
6. **Ao Fazer Upload** - Quando novo logo é enviado
7. **Ao Remover** - Limpa avisos quando logo é removido

## Parametrização

### Constantes Ajustáveis

```javascript
// Percentagem do logo que pode sair (0.1 = 10%)
MARGEM_VISIBILIDADE = 0.1

// Mínimo de área visível para validar posição (5%)
visiblePercent >= 0.05
```

## Compatibilidade

- ✅ Mouse e toque (eventos `mousemove`, `touchmove`)
- ✅ Desktop e mobile
- ✅ Todas as faces da caixa (multi-face support)
- ✅ Logos com qualquer rotação
- ✅ Caixas com geometria complexa (polígonos genéricos)

## Exemplo de Uso

```javascript
// O utilizador clica e arrasta o logo
// → eventToDieline() converte posição do rato
// → constrainLogoCenterToBounds() ajusta para limites
// → applyLogoToAllFaces() renderiza
// → updateLogoPositionWarning() mostra aviso se necessário

// Se tentar sair dos limites:
// → Função retém o logo dentro da bbox
// → Aviso é exibido
// → Drag continua suave até ao limite
```

## Melhorias Futuras Possíveis

1. **Constraining per-face** - Respeitar geometria de cada face individualmente
2. **Visual feedback adicional** - Highlight da área válida enquanto arrasta
3. **Snap-to-edges** - Logo "cola" às bordas quando próximo
4. **Magnetic zones** - Posições pré-definidas (centros de faces)
5. **Animação de retorno** - Logo volta suavemente se foi solto fora dos limites

## Testes Recomendados

- [ ] Drag logo para todos os lados da caixa
- [ ] Rotacionar logo e depois fazer drag
- [ ] Escalar logo muito grande
- [ ] Tentar arrastar logo para fora - deve ser restringido
- [ ] Carregar logo guardado - deve validar posição
- [ ] Remover logo - aviso deve desaparecer
- [ ] Mobile/touch - deve funcionar igual ao desktop
