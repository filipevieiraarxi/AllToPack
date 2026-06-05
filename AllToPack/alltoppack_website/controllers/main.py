# -*- coding: utf-8 -*-
import base64
import json

from odoo import http
from odoo.http import request


class DielineController(http.Controller):

    @http.route('/dieline', type='http', auth='public', website=True)
    def dieline_page(self, product_id=None, **kwargs):
        """Página do configurador 3D.

        O SVG-dieline é SEMPRE o attachment do produto (box_dieline_svg).
        Não há SVG estático por tipo de caixa: se o produto não tiver SVG,
        o engine mostra "sem dieline". box_type é apenas um rótulo.
        """
        values = {
            'product': None,
            'box_type': '',
            'box_l': 0,
            'box_w': 0,
            'box_h': 0,
            'dieline_svg_url': '',
            'product_variant_id': 0,
            'product_price': 0.0,
        }
        if product_id:
            try:
                product = request.env['product.template'].sudo().browse(int(product_id))
            except (ValueError, TypeError):
                product = None
            if product and product.exists():
                values['product'] = product
                values['box_type'] = product.box_type or ''
                values['box_l'] = int(product.box_l) if product.box_l else 0
                values['box_w'] = int(product.box_w) if product.box_w else 0
                values['box_h'] = int(product.box_h) if product.box_h else 0
                values['product_variant_id'] = product.product_variant_ids[0].id if product.product_variant_ids else 0
                values['product_price'] = product.list_price
                if product.box_dieline_svg:
                    values['dieline_svg_url'] = '/dieline/svg/%d' % product.id
        return request.render('alltoppack_website.dieline_page', values)

    @http.route('/dieline/svg/<int:product_id>', type='http', auth='public', website=True)
    def dieline_svg(self, product_id, **kwargs):
        """Serve o SVG-dieline anotado guardado no attachment do produto."""
        product = request.env['product.template'].sudo().browse(product_id)
        if not product.exists() or not product.box_dieline_svg:
            return request.not_found()
        try:
            data = base64.b64decode(product.box_dieline_svg)
        except (ValueError, TypeError):
            return request.not_found()
        return request.make_response(data, headers=[
            ('Content-Type', 'image/svg+xml'),
            ('Content-Length', str(len(data))),
            ('Cache-Control', 'no-cache'),
        ])

    @http.route('/dieline/artwork/save', type='json', auth='user', methods=['POST'])
    def save_artwork(self, product_id, artwork, **kwargs):
        """Guarda o artwork JSON {face_key: data_url} no produto."""
        product = request.env['product.template'].sudo().browse(int(product_id))
        if not product.exists():
            return {'ok': False, 'error': 'Produto não encontrado'}
        product.box_artwork = json.dumps(artwork)
        return {'ok': True}

    @http.route('/dieline/artwork/load', type='http', auth='public', website=True)
    def load_artwork(self, product_id, **kwargs):
        """Devolve o artwork JSON guardado no produto."""
        product = request.env['product.template'].sudo().browse(int(product_id))
        if not product.exists():
            return request.make_response('{}', headers=[('Content-Type', 'application/json')])
        return request.make_response(product.box_artwork or '{}',
            headers=[('Content-Type', 'application/json')])
