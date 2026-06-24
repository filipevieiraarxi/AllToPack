# -*- coding: utf-8 -*-
import base64
import os
from . import controllers, models


def post_init_hook(env):
    """Garante que todos os produtos com box_type têm a categoria pública 'Caixas'.
    Define também o logo da company com o logo ALL2PACK."""
    categ = env['product.public.category'].search([('name', '=', 'Caixas')], limit=1)
    if categ:
        products = env['product.template'].search([('box_type', '!=', False)])
        for p in products:
            if categ not in p.public_categ_ids:
                p.public_categ_ids = [(4, categ.id)]

    logo_path = os.path.join(
        os.path.dirname(__file__),
        'static', 'src', 'img', 'all2pack_logo.png',
    )
    if os.path.exists(logo_path):
        with open(logo_path, 'rb') as f:
            logo_b64 = base64.b64encode(f.read())
        company = env['res.company'].search([], limit=1)
        if company and not company.logo:
            company.logo = logo_b64
        website = env['website'].search([], limit=1)
        if website:
            website.logo = logo_b64
