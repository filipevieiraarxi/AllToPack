# -*- coding: utf-8 -*-
from . import controllers, models


def post_init_hook(env):
    """Garante que todos os produtos com box_type têm a categoria pública 'Caixas'."""
    categ = env['product.public.category'].search([('name', '=', 'Caixas')], limit=1)
    if not categ:
        return
    products = env['product.template'].search([('box_type', '!=', False)])
    for p in products:
        if categ not in p.public_categ_ids:
            p.public_categ_ids = [(4, categ.id)]
