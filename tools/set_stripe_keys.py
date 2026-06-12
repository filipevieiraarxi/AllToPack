#!/usr/bin/env python3
"""
Configura as chaves do Stripe no payment.provider de uma BD Odoo de DEV.

As chaves NÃO ficam no código: são lidas de .local/stripe_keys.json (gitignored).
Em Odoo as credenciais vivem na BD, não em env vars nem ficheiros versionados.

Uso (a partir da raiz do projeto):

    ./odoo/odoo-bin shell -c odoo18.conf -d <DB> \
        --no-http < tools/set_stripe_keys.py

ou, se tiveres um wrapper, qualquer forma de abrir `odoo shell` na BD desejada.
O script corre no contexto do shell (env já tem `env`, `self`, etc.).
"""
import json
import os

# Localizar .local/stripe_keys.json de forma robusta. Quando o script é lido
# via stdin (`odoo shell < script`), `__file__` não existe — caímos no cwd.
# Permite ainda override por env var STRIPE_KEYS_FILE.
def _resolve_keys_path():
    env_path = os.environ.get("STRIPE_KEYS_FILE")
    if env_path:
        return env_path
    candidates = []
    try:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # noqa: F821
        candidates.append(os.path.join(root, ".local", "stripe_keys.json"))
    except NameError:
        pass
    cwd = os.getcwd()
    candidates.append(os.path.join(cwd, ".local", "stripe_keys.json"))
    candidates.append(os.path.join(cwd, "tools", "..", ".local", "stripe_keys.json"))
    for c in candidates:
        if os.path.exists(c):
            return c
    return candidates[-1]


_KEYS_PATH = _resolve_keys_path()


def _load_keys():
    if not os.path.exists(_KEYS_PATH):
        raise SystemExit(
            "[stripe] Falta %s — cria-o a partir do exemplo." % _KEYS_PATH
        )
    with open(_KEYS_PATH, "r") as fh:
        data = json.load(fh)
    if not data.get("stripe_secret_key") or not data.get("stripe_publishable_key"):
        raise SystemExit("[stripe] stripe_secret_key/publishable_key em falta no JSON.")
    return data


def configure(env):
    keys = _load_keys()
    provider_code = keys.get("provider_code", "stripe")

    Provider = env["payment.provider"]
    provider = Provider.search([("code", "=", provider_code)], limit=1)
    if not provider:
        raise SystemExit(
            "[stripe] Nenhum payment.provider com code=%r. "
            "O módulo payment_stripe está instalado nesta BD?" % provider_code
        )

    vals = {
        "stripe_publishable_key": keys["stripe_publishable_key"],
        "stripe_secret_key": keys["stripe_secret_key"],
        "state": keys.get("state", "test"),  # test mode para chaves de sandbox
    }
    # Webhook secret é opcional — só escreve se vier preenchido.
    if keys.get("stripe_webhook_secret"):
        vals["stripe_webhook_secret"] = keys["stripe_webhook_secret"]

    provider.write(vals)
    env.cr.commit()

    print("[stripe] provider id=%s actualizado." % provider.id)
    print("[stripe]   state            = %s" % provider.state)
    print("[stripe]   publishable_key  = %s…" % provider.stripe_publishable_key[:12])
    print("[stripe]   secret_key       = (definida, %d chars)" % len(provider.stripe_secret_key))
    print("[stripe]   webhook_secret   = %s" % ("definida" if provider.stripe_webhook_secret else "(vazia — configurar no dashboard Stripe)"))


# Em `odoo shell`, a variável global `env` está disponível.
try:
    env  # noqa: F821
except NameError:
    raise SystemExit(
        "Este script é para correr dentro de `odoo shell` "
        "(onde `env` existe). Vê o docstring no topo do ficheiro."
    )
else:
    configure(env)  # noqa: F821
