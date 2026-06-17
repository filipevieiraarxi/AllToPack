# -*- coding: utf-8 -*-
import base64
import json

from odoo import http
from odoo.http import request
from odoo.tools import html_escape
from markupsafe import Markup
from odoo.addons.website_sale.controllers.main import WebsiteSale


class PackagingController(http.Controller):

    @http.route(['/produtos', '/packaging'], type='http', auth='public', website=True)
    def packaging_index(self, **kwargs):
        recs = request.env['product.public.category'].sudo().search(
            [('parent_id', '=', False)],
            order='sequence, name',
        )
        ih = request.env['ir.http']
        categories = []
        for rec in recs:
            categories.append({
                'id': rec.id,
                'name': rec.name,
                'has_children': bool(rec.child_id),
                'url': '/produtos/%s' % ih._slug(rec) if rec.child_id else '/shop?category=%d' % rec.id,
            })
        return request.render('alltoppack_website.packaging_index', {'categories': categories})

    @http.route('/produtos/<path:slug>', type='http', auth='public', website=True)
    def packaging_category(self, slug, **kwargs):
        # extract id from slug (format: name-ID)
        try:
            cat_id = int(slug.rsplit('-', 1)[-1])
        except (ValueError, IndexError):
            return request.not_found()
        cat = request.env['product.public.category'].sudo().browse(cat_id)
        if not cat.exists():
            return request.not_found()
        ih = request.env['ir.http']
        if cat.child_id:
            children = []
            for c in cat.child_id.sorted('sequence'):
                children.append({
                    'id': c.id,
                    'name': c.name,
                    'has_children': bool(c.child_id),
                    'url': '/shop?category=%d' % c.id,
                })
            return request.render('alltoppack_website.packaging_subcategory', {
                'parent': cat,
                'categories': children,
            })
        return request.redirect('/shop?category=%d' % cat.id)


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
            'order_artwork_json': '{}',
            'readonly_mode': False,
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

    # ── Dieline na Sale Order ────────────────────────────────────────

    @http.route('/dieline/order/save', type='json', auth='public', methods=['POST'])
    def save_order_dieline(self, product_id, box_type, box_l, box_w, box_h,
                           artwork_json, svg_front=None, svg_back=None,
                           order_line_id=None, **kwargs):
        """Guarda (ou actualiza) a configuração de dieline para uma linha de encomenda.

        Devolve o ID do registo sale.order.dieline criado/actualizado.
        """
        env = request.env['sale.order.dieline'].sudo()

        vals = {
            'product_id':   int(product_id) if product_id else False,
            'box_type':     box_type or '',
            'box_l':        float(box_l or 0),
            'box_w':        float(box_w or 0),
            'box_h':        float(box_h or 0),
            'artwork_json': artwork_json or '{}',
            'svg_front':    svg_front or '',
            'svg_back':     svg_back or '',
        }

        if order_line_id:
            try:
                line = request.env['sale.order.line'].sudo().browse(int(order_line_id))
                if line.exists():
                    vals['order_line_id'] = line.id
            except (ValueError, TypeError):
                pass

        rec = env.create(vals)
        return {'ok': True, 'dieline_config_id': rec.id}

    @http.route('/dieline/order/preview/<int:config_id>', type='http', auth='public', website=True)
    def order_dieline_preview(self, config_id, **kw):
        """Página de preview do dieline de uma encomenda (read-only)."""
        rec = request.env['sale.order.dieline'].sudo().browse(config_id)
        if not rec.exists():
            return request.not_found()
        values = {
            'product': rec.product_id or None,
            'box_type': rec.box_type or '',
            'box_l': int(rec.box_l),
            'box_w': int(rec.box_w),
            'box_h': int(rec.box_h),
            'dieline_svg_url': '/dieline/svg/%d' % rec.product_id.id if rec.product_id else '',
            'product_variant_id': 0,
            'product_price': 0.0,
            'order_artwork_json': Markup(rec.artwork_json or '{}'),
            'readonly_mode': True,
        }
        return request.render('alltoppack_website.dieline_page', values)

    @http.route('/dieline/order/svg/<int:config_id>', type='http', auth='user', website=True)
    def order_dieline_svg(self, config_id, **kwargs):
        """Serve o SVG do dieline guardado na configuração da encomenda."""
        rec = request.env['sale.order.dieline'].sudo().browse(config_id)
        if not rec.exists() or not rec.dieline_svg:
            return request.not_found()
        try:
            data = base64.b64decode(rec.dieline_svg)
        except (ValueError, TypeError):
            return request.not_found()
        return request.make_response(data, headers=[
            ('Content-Type', 'image/svg+xml'),
            ('Content-Length', str(len(data))),
            ('Cache-Control', 'no-cache'),
        ])

    @http.route('/dieline/order/<int:config_id>/svg/<string:side>', type='http', auth='public')
    def order_dieline_svg_side(self, config_id, side, **kwargs):
        """Serve o SVG vectorial de frente ou verso gerado pelo browser."""
        if side not in ('front', 'back'):
            return request.not_found()
        rec = request.env['sale.order.dieline'].sudo().browse(config_id)
        if not rec.exists():
            return request.not_found()
        data = rec.svg_front if side == 'front' else rec.svg_back
        if not data:
            return request.not_found()
        fname = 'dieline_%s_%s.svg' % (side, config_id)
        return request.make_response(data.encode('utf-8'), headers=[
            ('Content-Type', 'image/svg+xml; charset=utf-8'),
            ('Content-Disposition', 'inline; filename="%s"' % fname),
            ('Cache-Control', 'no-cache'),
        ])


class AtpWebsiteSale(WebsiteSale):
    """Associa o dieline_config_id à order line após add-to-cart."""

    @http.route()
    def cart_update(self, product_id, add_qty=1, set_qty=0, **kwargs):
        result = super().cart_update(
            product_id=product_id, add_qty=add_qty, set_qty=set_qty, **kwargs)

        dieline_config_id = kwargs.get('dieline_config_id')
        if dieline_config_id:
            try:
                config = request.env['sale.order.dieline'].sudo().browse(
                    int(dieline_config_id))
                if config.exists() and not config.order_line_id:
                    order = request.website.sale_get_order()
                    if order:
                        line = order.order_line.filtered(
                            lambda l: l.product_id.id == int(product_id)
                        ).sorted('id', reverse=True)[:1]
                        if line:
                            config.order_line_id = line.id
            except (ValueError, TypeError):
                pass

        return result
