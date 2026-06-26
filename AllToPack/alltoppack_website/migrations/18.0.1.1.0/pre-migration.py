# -*- coding: utf-8 -*-
from odoo import api, SUPERUSER_ID


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    xml_ids = [
        'alltoppack_website.product_template_rollover_hinged_lid',
        'alltoppack_website.product_template_rsc_regular_slotted',
    ]
    for xml_id in xml_ids:
        rec = env.ref(xml_id, raise_if_not_found=False)
        if rec:
            rec.write({'active': False, 'is_published': False})
