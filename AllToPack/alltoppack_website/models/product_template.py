# -*- coding: utf-8 -*-
from odoo import fields, models


class ProductTemplate(models.Model):
    _inherit = 'product.template'

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

    # SVG de dieline anotado — quando preenchido, o engine lê a geometria a partir daqui.
    # L/W/H são inferidos do SVG; os campos box_l/w/h ficam como fallback/override.
    box_dieline_svg = fields.Binary(
        string='Dieline SVG',
        attachment=True,
        help='SVG planificado com ids de face (face_front, face_back, …). '
             'O engine 3D lê as dimensões directamente deste ficheiro.',
    )
    box_dieline_svg_fname = fields.Char(string='Nome do ficheiro SVG')
