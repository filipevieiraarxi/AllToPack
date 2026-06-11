# -*- coding: utf-8 -*-
from odoo import fields, models


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    # box_type é apenas um rótulo/categoria informativa do produto.
    # NÃO determina a geometria 3D — essa é derivada do box_dieline_svg.
    box_type = fields.Selection(
        selection=[
            ('rollover_hinged_lid', 'Rollover Hinged Lid'),
            ('rsc_regular_slotted', 'RSC Regular Slotted Container'),
        ],
        string='Tipo de Caixa',
        default='rollover_hinged_lid',
    )
    box_l = fields.Float('Comprimento (mm)', default=120.0)
    box_w = fields.Float('Largura (mm)', default=80.0)
    box_h = fields.Float('Altura (mm)', default=100.0)

    # SVG-dieline anotado: é a ÚNICA fonte da geometria 3D.
    # O engine lê painéis (<rect ..._panel>) e dobras (<line>) e infere a árvore.
    box_dieline_svg = fields.Binary(
        string='Dieline SVG',
        attachment=True,
        help='SVG-dieline anotado: cada face é um <rect id="..._panel"> em '
             '#cut_lines e cada dobra uma <line> em #fold_lines. Marque a base '
             'com data-root="1" e o ângulo de cada dobra com data-fold-angle. '
             'O motor 3D deriva toda a geometria deste ficheiro.',
    )
    box_dieline_svg_fname = fields.Char(string='Nome do ficheiro SVG')
    box_artwork = fields.Text(string='Artwork JSON', default='{}',
        help='JSON dict {face_key: base64_data_url} com as imagens aplicadas a cada face.')

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
