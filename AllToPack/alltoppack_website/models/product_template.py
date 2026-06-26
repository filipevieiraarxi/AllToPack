# -*- coding: utf-8 -*-
from odoo import fields, models


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    box_type = fields.Selection(
        selection=[
            ('FEFCO_0201', 'FEFCO 0201'),
            ('FEFCO_0216', 'FEFCO 0216'),
            ('FEFCO_0215', 'FEFCO 0215'),
            ('FEFCO_0200', 'FEFCO 0200'),
            ('FEFCO_0427', 'FEFCO 0427'),
            ('FEFCO_04XX', 'FEFCO 04XX'),
            ('FEFCO_0422', 'FEFCO 0422'),
            ('FEFCO_0425', 'FEFCO 0425'),
            ('FEFCO_0330', 'FEFCO 0330'),
            ('FEFCO_0426', 'FEFCO 0426'),
            ('FEFCO_0473', 'FEFCO 0473'),
            ('FEFCO_0703', 'FEFCO 0703'),
            ('GENERIC',    'Generic'),
        ],
        string='Box Type (FEFCO)',
        default='GENERIC',
    )
    box_l = fields.Float('Comprimento (mm)', default=120.0)
    box_w = fields.Float('Largura (mm)', default=80.0)
    box_h = fields.Float('Altura (mm)', default=100.0)

    box_dieline_svg = fields.Binary(
        string='Dieline SVG',
        attachment=True,
        help='SVG-dieline Format B: <g id="root_group"> com linhas coloridas. '
             'Vermelho=corte, Azul=vinco, Verde=dimensões (ignorado). '
             'O motor 3D deriva toda a geometria deste ficheiro via DCEL.',
    )
    box_dieline_svg_fname = fields.Char(string='Nome do ficheiro SVG')
    box_artwork = fields.Text(string='Artwork JSON', default='{}',
        help='JSON dict com as imagens aplicadas a cada face.')

    card_image_normal = fields.Binary(
        string='Imagem do Card (normal)',
        attachment=True,
        help='Imagem exibida no card do produto na loja (estado normal).',
    )
    card_image_normal_fname = fields.Char(string='Nome ficheiro imagem normal')
    card_image_hover = fields.Binary(
        string='Imagem do Card (hover)',
        attachment=True,
        help='Imagem exibida no card do produto quando o cursor está por cima.',
    )
    card_image_hover_fname = fields.Char(string='Nome ficheiro imagem hover')

    def action_open_dieline_3d(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_url',
            'url': '/dieline?product_id=%d' % self.id,
            'target': 'new',
        }
