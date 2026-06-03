# -*- coding: utf-8 -*-
{
    'name': 'Website AllToPack',
    'version': '18.0.1.0.0',
    'category': 'Website',
    'summary': 'Landing page, products page, product page e dieline engine',
    'description': 'Módulo custom de website para AllToPack',
    'author': 'AllToPack',
    'depends': [
        'website',
        'website_sale',
    ],
    'data': [
        'security/ir.model.access.csv',
        'views/templates.xml',
        'views/shop_templates.xml',
        'views/product_templates.xml',
        'views/dieline_templates.xml',
        # 'views/product_backend_views.xml',
        'data/product_data.xml',
    ],
    'assets': {
        'web.assets_frontend': [
            'alltoppack_website/static/src/css/style.css',
            'alltoppack_website/static/src/css/dieline.css',
            'alltoppack_website/static/src/js/main.js',
        ],
    },
    'installable': True,
    'application': True,
    'auto_install': False,
}
