# -*- coding: utf-8 -*-
from odoo import fields, models


class SaleOrderDieline(models.Model):
    """Configuração de dieline associada a uma linha de encomenda."""
    _name = 'sale.order.dieline'
    _description = 'Dieline da Encomenda'

    order_line_id = fields.Many2one(
        'sale.order.line', string='Linha', ondelete='cascade', index=True)
    order_id = fields.Many2one(
        'sale.order', string='Encomenda',
        related='order_line_id.order_id', store=True, index=True)
    product_id = fields.Many2one(
        'product.template', string='Produto', index=True)

    box_type = fields.Char(string='Tipo de caixa')
    box_l    = fields.Float(string='Comprimento L (mm)')
    box_w    = fields.Float(string='Largura W (mm)')
    box_h    = fields.Float(string='Altura H (mm)')

    # SVG do dieline tal como estava no momento da encomenda (base64)
    dieline_svg = fields.Binary(string='Dieline SVG', attachment=True)
    dieline_svg_fname = fields.Char(string='Ficheiro SVG')

    # Artwork: JSON com {__logo__: {...}, __logo_back__: {...}}
    artwork_json = fields.Text(string='Artwork JSON', default='{}')

    # SVGs vectoriais gerados no browser para frente e verso
    svg_front = fields.Text(string='SVG Frente')
    svg_back  = fields.Text(string='SVG Verso')

    svg_front_html = fields.Html(
        string='Pré-visualização Frente', compute='_compute_svg_html', sanitize=False)
    svg_back_html  = fields.Html(
        string='Pré-visualização Verso',  compute='_compute_svg_html', sanitize=False)

    def _compute_svg_html(self):
        for rec in self:
            if rec.id and rec.svg_front:
                rec.svg_front_html = (
                    '<div style="text-align:center;padding:8px">'
                    '<img src="/dieline/order/%d/svg/front" style="max-width:100%%;border:1px solid #ddd"/>'
                    '</div>' % rec.id
                )
            else:
                rec.svg_front_html = '<p class="text-muted">Sem SVG</p>'
            if rec.id and rec.svg_back:
                rec.svg_back_html = (
                    '<div style="text-align:center;padding:8px">'
                    '<img src="/dieline/order/%d/svg/back" style="max-width:100%%;border:1px solid #ddd"/>'
                    '</div>' % rec.id
                )
            else:
                rec.svg_back_html = '<p class="text-muted">Sem SVG</p>'

    def action_open_preview(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_url',
            'url': '/dieline/order/preview/%d' % self.id,
            'target': 'new',
        }

    def action_open_svg(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'SVG Dieline',
            'res_model': 'sale.order.dieline',
            'res_id': self.id,
            'view_mode': 'form',
            'views': [(False, 'form')],
            'target': 'new',
        }

    def action_download_svg_front(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_url',
            'url': '/dieline/order/%d/svg/front' % self.id,
            'target': 'new',
        }

    def action_download_svg_back(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_url',
            'url': '/dieline/order/%d/svg/back' % self.id,
            'target': 'new',
        }


class SaleOrderLine(models.Model):
    _inherit = 'sale.order.line'

    dieline_config_id = fields.Many2one(
        'sale.order.dieline', string='Config. Dieline',
        ondelete='set null', copy=False)


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    dieline_config_ids = fields.One2many(
        'sale.order.dieline', 'order_id', string='Configs. Dieline')
