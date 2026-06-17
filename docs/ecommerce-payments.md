# E-commerce & Pagamentos

O catálogo, carrinho, checkout, pagamento e confirmação de encomenda assentam
**inteiramente nos módulos oficiais** `website_sale`, `sale` e `payment_stripe`.
O módulo custom só acrescenta a apresentação (páginas, cards, filtros) e os
campos de produto. Esta secção documenta o fluxo e os **pontos de configuração**
que tiveram de ser acertados nesta instância.

## 1. Fluxo de compra

```
/packaging (categorias)  ──►  /shop (catálogo)  ──►  produto  ──►  carrinho
                                                                      │
                                          sale.order em 'draft' (= o carrinho)
                                                                      │
                                            /shop/checkout ──► /shop/payment
                                                                      │
                                                 Stripe (cartão / redirect)
                                                                      │
                                   payment.transaction 'done'  +  webhook
                                                                      │
                              website_sale: _check_amount_and_confirm_order
                                                                      │
                                            sale.order 'draft' → 'sale'  ✅
```

Pontos-chave:
- **O carrinho É a sale order.** Adicionar ao carrinho já cria uma `sale.order`
  em `draft` (com `website_id`). Não é o pagamento que a cria.
- A confirmação (`draft → sale`) acontece no **post-processing da transação**
  (`sale/models/payment_transaction.py :: _post_process` →
  `_check_amount_and_confirm_order`), quando a transação fica `done` e o montante
  cobre o total.

## 2. Configuração do Stripe (esta instância)

Provider Stripe (`payment.provider`, code `stripe`) na BD `teste`:

| Campo | Valor | Notas |
|-------|-------|-------|
| `state` | `test` | sandbox; chaves `pk_test`/`sk_test` |
| `is_published` | `True` | **necessário** para aparecer no checkout |
| `journal_id` | Bank | contabilidade |
| `payment_method_ids` | Card, iDEAL, Bancontact, EPS, Giropay, P24 | |
| `stripe_publishable_key` | `pk_test_…` | |
| `stripe_secret_key` | `sk_test_…` | |
| `stripe_webhook_secret` | (a configurar) | ver §4 |

> As credenciais do Stripe vivem na **BD** (campos encriptados do provider),
> **não** em ficheiros versionados nem env vars. É a forma correta no Odoo.

### Script de provisionamento (dev)

[`tools/set_stripe_keys.py`](../tools/set_stripe_keys.py) escreve as chaves no
provider a partir de [`.local/stripe_keys.json`](../.local) (gitignored):

```bash
./odoo/odoo-bin shell --config odoo18.conf -d teste --no-http < tools/set_stripe_keys.py
```

O JSON suporta `provider_code`, `state`, `stripe_publishable_key`,
`stripe_secret_key`, `stripe_webhook_secret`. O script é idempotente e faz commit.

> ⚠️ **Segurança:** `.local/` e `*stripe_keys*.json` estão no `.gitignore`.
> Nunca commitar segredos. Chaves de teste expostas devem ser rodadas no dashboard.

## 3. Confirmação automática da Sale Order

Comportamento nativo: ao pagar, a SO confirma sozinha. **Não é preciso código
custom** para isto.

### Armadilha encontrada: wkhtmltopdf em falta {#wkhtmltopdf}

Sintoma observado nesta instância: pagamentos `done`, transações ligadas à SO,
mas a **SO ficava presa em `draft`**.

Causa raiz: ao confirmar, `action_confirm(send_email=True)` envia o email de
**"Sales: Order Confirmation"** (`mail.template` id 12), que tem o relatório
**"PDF Quote"** anexo. Renderizar esse PDF requer **`wkhtmltopdf`**, que **não
estava instalado** → `UserError('Unable to find Wkhtmltopdf…')` → o
post-processing abortava → a SO nunca passava a `sale`.

Duas resoluções (podem coexistir):

1. **Instalar wkhtmltopdf** (definitivo; também necessário para faturas/relatórios):
   ```bash
   sudo apt-get update
   sudo apt-get install -y /tmp/wkhtmltox.deb      # .deb jammy 0.12.6.1-3 (patched qt)
   # se faltar libssl3 no Ubuntu recente:
   sudo apt-get install -y libssl3t64 libpng16-16 xfonts-75dpi
   which wkhtmltopdf && wkhtmltopdf --version
   ```
   Após instalar, reiniciar o processo Odoo (deteta o binário no arranque).

2. **Workaround de dev** (aplicado): desligar o template de confirmação
   automática para a SO confirmar sem gerar PDF:
   ```python
   env['ir.config_parameter'].sudo().set_param('sale.default_confirmation_template', '')
   ```
   Efeito: o cliente deixa de receber o email de confirmação com PDF (o pagamento
   e a confirmação da SO funcionam à mesma). Quando o wkhtmltopdf estiver
   instalado, **reverter** repondo `sale.default_confirmation_template = 12`.

> As transações que ficaram presas foram reprocessadas em massa via
> `tx.is_post_processed = False; tx._post_process()` no shell, confirmando as SOs
> retroativamente.

## 4. Webhook do Stripe (dev local)

Em `web.base.url = http://localhost:8090`, o Stripe (na internet) **não consegue**
chamar um endpoint local. Para dev usa-se o **Stripe CLI** (instalado em
`~/.local/bin/stripe`), que faz túnel — **não** se cria endpoint no dashboard:

```bash
stripe login
stripe listen --forward-to localhost:8090/payment/stripe/webhook
# → "Your webhook signing secret is whsec_…"  → meter em .local/stripe_keys.json
```

Depois recorrer o script de provisionamento para gravar o `stripe_webhook_secret`.

Para produção: criar o endpoint no dashboard (`https://<dominio>/payment/stripe/webhook`,
eventos `checkout.session.completed`, `payment_intent.succeeded`,
`payment_intent.payment_failed`) e usar o `whsec_` real.

### Porque é que o webhook importa
Em pagamentos com **redirect/3D Secure** (iDEAL, etc.), a confirmação final chega
muitas vezes pelo **webhook**, não pelo retorno do browser (que o cliente pode
fechar). Sem webhook, esses ficam pendentes e a SO não confirma. Já o cartão de
teste `4242 4242 4242 4242` confirma sem redirect, logo **sem** webhook — útil
para testar o fluxo base.

## 5. Customizações de loja do módulo

- `shop_templates.xml` — grelha da loja, toggle 2D/3D dos cards, **BoxFinder**
  (filtro por dimensões em JS, [`main.js`](../AllToPack/alltoppack_website/static/src/js/main.js)).
- `product_templates.xml` — página de produto (liga ao configurador `/dieline`).
- Cards usam `card_image_normal` / `card_image_hover` (campos custom do produto).
- `post_init_hook` garante produtos-caixa na categoria pública "Caixas".
