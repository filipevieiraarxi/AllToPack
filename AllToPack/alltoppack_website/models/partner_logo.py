# -*- coding: utf-8 -*-
from odoo import fields, models


class PartnerLogo(models.Model):
    """Logo guardado por um parceiro (cliente) para reutilização no configurador."""
    _name = 'atp.partner.logo'
    _description = 'Logo do Cliente'
    _order = 'create_date desc'

    partner_id = fields.Many2one('res.partner', string='Parceiro', required=True,
                                  ondelete='cascade', index=True)
    name = fields.Char(string='Nome', required=True)
    image = fields.Binary(string='Imagem', attachment=True, required=True)
    image_fname = fields.Char(string='Ficheiro')
    mimetype = fields.Char(string='Tipo')
