# -*- coding: utf-8 -*-
from odoo import http
from odoo.http import request


class DielineController(http.Controller):

    @http.route('/dieline', type='http', auth='public', website=True)
    def dieline_page(self, product_id=None, **kwargs):
        box_type = 'rollover_hinged_lid'
        values = {
            'product': None,
            'box_type': box_type,
            'box_l': 120,
            'box_w': 80,
            'box_h': 100,
            # SVG estático por tipo de caixa — sempre presente
            'dieline_svg_url': '/alltoppack_website/static/src/img/%s_dieline.svg' % box_type,
        }
        if product_id:
            try:
                product = request.env['product.template'].sudo().browse(int(product_id))
                if product.exists():
                    box_type = product.box_type or 'rollover_hinged_lid'
                    values['product'] = product
                    values['box_type'] = box_type
                    values['box_l'] = int(product.box_l) if product.box_l else 120
                    values['box_w'] = int(product.box_w) if product.box_w else 80
                    values['box_h'] = int(product.box_h) if product.box_h else 100

                    # SVG estático por tipo de caixa (o campo de upload foi removido)
                    values['dieline_svg_url'] = (
                        '/alltoppack_website/static/src/img/%s_dieline.svg' % box_type
                    )
            except (ValueError, TypeError):
                pass
        return request.render('alltoppack_website.dieline_page', values)
