# -*- coding: utf-8 -*-
import base64
import json
import re

from odoo import http
from odoo.http import request
from odoo.tools import html_escape
from markupsafe import Markup
from odoo.addons.website_sale.controllers.main import WebsiteSale


def _scale_dieline_svg(svg_text, L0, W0, H0, L, W, H):
    """Escala o SVG do dieline de (L0,W0,H0) para (L,W,H).

    Estratégia:
    - scaleX = L / L0  (eixo horizontal do SVG = comprimento L)
    - scaleY = H / H0  (eixo vertical do SVG = altura H)
    - W não afecta a geometria 2D do dieline (é a profundidade da caixa)
      mas as cotas verdes que representam W são actualizadas pelo factor W/W0.

    Todas as coordenadas numéricas nos atributos de posição são escaladas.
    Os textos verdes (<tspan> dentro de <text fill:rgb(0,128,0)>) são
    actualizados com os novos valores em mm.
    """
    if not svg_text or L0 <= 0 or H0 <= 0:
        return svg_text

    sx = L / L0  # factor X
    sy = H / H0  # factor Y
    sw = W / W0 if W0 > 0 else 1.0  # factor W (para cotas verdes de W)

    # ── 1. Escalar atributos de coordenadas ──────────────────────────
    # Atributos de posição simples (x, y, x1, y1, x2, y2, width, height, cx, cy, rx, ry)
    def scale_attr(m):
        attr = m.group(1)
        val  = float(m.group(2))
        if attr in ('x', 'x1', 'x2', 'cx', 'rx', 'width'):
            val *= sx
        else:
            val *= sy
        return '%s="%g"' % (attr, val)

    svg = re.sub(
        r'\b(x1|y1|x2|y2|cx|cy|rx|ry|width|height|x|y)="(-?[0-9]+(?:\.[0-9]+)?)"',
        scale_attr,
        svg_text,
    )

    # viewBox
    def scale_vb(m):
        parts = m.group(1).split()
        if len(parts) == 4:
            parts[0] = '%g' % (float(parts[0]) * sx)
            parts[1] = '%g' % (float(parts[1]) * sy)
            parts[2] = '%g' % (float(parts[2]) * sx)
            parts[3] = '%g' % (float(parts[3]) * sy)
        return 'viewBox="%s"' % ' '.join(parts)
    svg = re.sub(r'viewBox="([^"]+)"', scale_vb, svg)

    # transform="matrix(a b c d e f)" — escalar e (tx) e f (ty)
    def scale_matrix(m):
        vals = m.group(1).split()
        if len(vals) == 6:
            try:
                a, b, c, d, e, f = [float(v) for v in vals]
                e *= sx
                f *= sy
                return 'transform="matrix(%s)"' % ' '.join(
                    '%g' % v for v in [a, b, c, d, e, f])
            except ValueError:
                pass
        return m.group(0)
    svg = re.sub(r'transform="matrix\(([^)]+)\)"', scale_matrix, svg)

    # <path d="..."> — escalar comandos M, L, H, V, A, C, S, Q, T
    def scale_path(m):
        d = m.group(1)
        out = []
        tokens = re.findall(
            r'[MmLlHhVvAaZzCcSsQqTt]|[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?', d)
        i = 0
        while i < len(tokens):
            tok = tokens[i]
            if re.match(r'^[A-Za-z]$', tok):
                cmd = tok
                out.append(cmd)
                i += 1
                # consumir parâmetros numéricos seguintes
                while i < len(tokens) and not re.match(r'^[A-Za-z]$', tokens[i]):
                    c_low = cmd.lower()
                    if c_low == 'h':
                        out.append('%g' % (float(tokens[i]) * sx))
                        i += 1
                    elif c_low == 'v':
                        out.append('%g' % (float(tokens[i]) * sy))
                        i += 1
                    elif c_low in ('m', 'l', 't'):
                        out.append('%g' % (float(tokens[i]) * sx)); i += 1
                        if i < len(tokens) and not re.match(r'^[A-Za-z]$', tokens[i]):
                            out.append('%g' % (float(tokens[i]) * sy)); i += 1
                    elif c_low in ('s', 'q'):
                        out.append('%g' % (float(tokens[i]) * sx)); i += 1
                        if i < len(tokens): out.append('%g' % (float(tokens[i]) * sy)); i += 1
                        if i < len(tokens): out.append('%g' % (float(tokens[i]) * sx)); i += 1
                        if i < len(tokens): out.append('%g' % (float(tokens[i]) * sy)); i += 1
                    elif c_low == 'c':
                        for _ in range(3):
                            if i < len(tokens): out.append('%g' % (float(tokens[i]) * sx)); i += 1
                            if i < len(tokens): out.append('%g' % (float(tokens[i]) * sy)); i += 1
                    elif c_low == 'a':
                        # rx ry x-rot large-arc sweep dx dy
                        if i < len(tokens): out.append('%g' % (float(tokens[i]) * sx)); i += 1  # rx
                        if i < len(tokens): out.append('%g' % (float(tokens[i]) * sy)); i += 1  # ry
                        if i < len(tokens): out.append(tokens[i]); i += 1   # x-rotation
                        if i < len(tokens): out.append(tokens[i]); i += 1   # large-arc
                        if i < len(tokens): out.append(tokens[i]); i += 1   # sweep
                        if i < len(tokens): out.append('%g' % (float(tokens[i]) * sx)); i += 1  # x
                        if i < len(tokens): out.append('%g' % (float(tokens[i]) * sy)); i += 1  # y
                    elif c_low == 'z':
                        break
                    else:
                        out.append(tokens[i]); i += 1
            else:
                out.append(tok); i += 1
        return 'd="%s"' % ' '.join(out)

    svg = re.sub(r'd="([^"]+)"', scale_path, svg)

    # ── 2. Actualizar textos verdes com valores correctos em mm ─────
    # Os textos verdes são dimensões cotadas. Cada <tspan> tem um valor
    # numérico em px (= mm na escala original). Após scaling, o valor
    # real em mm é: valor_original * factor_correcto.
    # O factor correcto é determinado pelo transform do <text>:
    #   - matrix(0,-1,...) ou matrix(0,1,...) → eixo vertical → sy ou sw
    #   - matrix(1,0,...) → eixo horizontal → sx ou sw
    # Não sabemos se é L, W ou H sem contexto, mas a heurística é:
    #   vertical transform → H (sy)
    #   horizontal transform → L ou W
    # Para horizontal: se o valor original ≈ W0 → sw; se ≈ L0 → sx;
    # caso contrário → sx (default).

    def update_green_tspan(m):
        full_text = m.group(0)
        attrs = m.group(1)
        body  = m.group(2)
        # só processar textos verdes
        if 'rgb(0,128,0)' not in full_text:
            return full_text
        is_vert = bool(re.search(r'matrix\s*\(\s*0[\s,]', attrs))

        def replace_tspan(tm):
            try:
                orig = float(tm.group(1))
            except ValueError:
                return tm.group(0)
            if is_vert:
                # eixo Y: pode ser H ou W dependendo do valor
                # se orig ≈ W0 → factor sw, senão sy
                factor = sw if abs(orig - W0) < max(W0 * 0.15, 5) else sy
            else:
                # eixo X: pode ser L ou W
                factor = sw if abs(orig - W0) < max(W0 * 0.15, 5) else sx
            new_val = orig * factor
            # arredondar: se o resultado é inteiro, mostrar sem decimais
            if abs(new_val - round(new_val)) < 0.05:
                new_val_str = '%d.0' % round(new_val)
            else:
                new_val_str = '%.1f' % new_val
            return '<tspan%s>%s</tspan>' % (tm.group(0)[6:tm.group(0).index('>')], new_val_str)

        new_body = re.sub(
            r'<tspan([^>]*)>([0-9]+\.?[0-9]*)</tspan>',
            lambda tm: '<tspan%s>%s</tspan>' % (
                tm.group(1),
                _scale_dim_value(float(tm.group(2)), is_vert, L0, W0, H0, sx, sy, sw)
            ),
            body,
        )
        return '<text%s>%s</text>' % (attrs, new_body)

    svg = re.sub(r'<text(\b[^>]*)>(.*?)</text>', update_green_tspan, svg, flags=re.DOTALL)

    return svg


def _scale_dim_value(orig, is_vert, L0, W0, H0, sx, sy, sw):
    """Determina o factor correcto para um valor de cota verde e devolve string."""
    tol = 0.15
    if is_vert:
        if abs(orig - H0) < max(H0 * tol, 5):
            factor = sy
        elif abs(orig - W0) < max(W0 * tol, 5):
            factor = sw
        else:
            factor = sy
    else:
        if abs(orig - L0) < max(L0 * tol, 5):
            factor = sx
        elif abs(orig - W0) < max(W0 * tol, 5):
            factor = sw
        else:
            factor = sx
    new_val = orig * factor
    if abs(new_val - round(new_val)) < 0.05:
        return '%d.0' % round(new_val)
    return '%.1f' % new_val


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
        box_type (FEFCO code) é passado ao engine para que o TemplateMapper
        correcto seja aplicado na construção da árvore de dobras.
        """
        values = {
            'product': None,
            'box_type': 'GENERIC',
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
                values['box_type'] = product.box_type or 'GENERIC'
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

        L = float(box_l or 0)
        W = float(box_w or 0)
        H = float(box_h or 0)

        # Gerar SVG escalado a partir do SVG original do produto
        scaled_svg_b64 = False
        pid = int(product_id) if product_id else 0
        if pid and L > 0 and H > 0:
            product = request.env['product.template'].sudo().browse(pid)
            if product.exists() and product.box_dieline_svg:
                try:
                    raw = base64.b64decode(product.box_dieline_svg)
                    svg_text = raw.decode('utf-8', errors='replace')
                    L0 = product.box_l or L
                    W0 = product.box_w or W
                    H0 = product.box_h or H
                    scaled = _scale_dieline_svg(svg_text, L0, W0, H0, L, W, H)
                    scaled_svg_b64 = base64.b64encode(scaled.encode('utf-8')).decode('ascii')
                except Exception:
                    pass

        vals = {
            'product_id':   pid or False,
            'box_type':     box_type or '',
            'box_l':        L,
            'box_w':        W,
            'box_h':        H,
            'artwork_json': artwork_json or '{}',
            'svg_front':    svg_front or '',
            'svg_back':     svg_back or '',
        }
        if scaled_svg_b64:
            vals['dieline_svg'] = scaled_svg_b64
            vals['dieline_svg_fname'] = 'dieline_scaled.svg'

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
        # Usar SVG escalado da order se existir, senão o original do produto
        if rec.dieline_svg:
            svg_url = '/dieline/order/svg/%d' % rec.id
        elif rec.product_id:
            svg_url = '/dieline/svg/%d' % rec.product_id.id
        else:
            svg_url = ''
        values = {
            'product': rec.product_id or None,
            'box_type': rec.box_type or 'GENERIC',
            'box_l': int(rec.box_l),
            'box_w': int(rec.box_w),
            'box_h': int(rec.box_h),
            'dieline_svg_url': svg_url,
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
        fname = 'dieline_%d.svg' % config_id
        return request.make_response(data, headers=[
            ('Content-Type', 'image/svg+xml; charset=utf-8'),
            ('Content-Disposition', 'attachment; filename="%s"' % fname),
            ('Content-Length', str(len(data))),
            ('Cache-Control', 'no-cache'),
        ])

    @http.route('/dieline/order/<int:config_id>/svg/<string:side>', type='http', auth='public')
    def order_dieline_svg_side(self, config_id, side, **kwargs):
        """Serve o SVG escalado com todos os logos + cotas injectados."""
        if side not in ('front', 'back'):
            return request.not_found()
        rec = request.env['sale.order.dieline'].sudo().browse(config_id)
        if not rec.exists():
            return request.not_found()

        svg_text = None
        if rec.dieline_svg:
            try:
                svg_text = base64.b64decode(rec.dieline_svg).decode('utf-8', errors='replace')
            except Exception:
                pass
        if not svg_text and rec.product_id and rec.product_id.box_dieline_svg:
            try:
                raw_bytes = base64.b64decode(rec.product_id.box_dieline_svg)
                for enc in ('utf-8', 'utf-16', 'latin-1'):
                    try:
                        raw = raw_bytes.decode(enc)
                        break
                    except Exception:
                        raw = None
                raw = raw or raw_bytes.decode('utf-8', errors='replace')
                prod = rec.product_id
                L0 = prod.box_l or rec.box_l
                W0 = prod.box_w or rec.box_w
                H0 = prod.box_h or rec.box_h
                if (rec.box_l != L0 or rec.box_h != H0) and L0 and H0:
                    svg_text = _scale_dieline_svg(raw, L0, W0, H0, rec.box_l, rec.box_w, rec.box_h)
                else:
                    svg_text = raw
            except Exception:
                pass
        if not svg_text:
            return request.not_found()

        try:
            artwork = json.loads(rec.artwork_json or '{}')
            prefix = '__logo__' if side == 'front' else '__logo_back__'
            side_artwork = {k: v for k, v in artwork.items() if k.startswith(prefix)}
            svg_text = _inject_logos_into_svg(svg_text, side_artwork, rec.product_id, rec)
        except Exception:
            pass

        fname = 'dieline_%s_%d.svg' % (side, config_id)
        return request.make_response(svg_text.encode('utf-8'), headers=[
            ('Content-Type', 'image/svg+xml; charset=utf-8'),
            ('Content-Disposition', 'attachment; filename="%s"' % fname),
            ('Cache-Control', 'no-cache'),
        ])

    # ── Galeria de logos do cliente ──────────────────────────────────

    @http.route('/dieline/logo/upload', type='json', auth='user', methods=['POST'])
    def logo_upload(self, name, data_url, **kwargs):
        """Guarda um logo como attachment do parceiro actual."""
        partner = request.env.user.partner_id
        if not partner:
            return {'ok': False}
        # data_url = "data:image/png;base64,AAAA..."
        try:
            header, b64data = data_url.split(',', 1)
            mimetype = header.split(';')[0].replace('data:', '') or 'image/png'
            image_data = base64.b64decode(b64data)
        except Exception:
            return {'ok': False, 'error': 'data_url inválido'}

        logo = request.env['atp.partner.logo'].sudo().create({
            'partner_id': partner.id,
            'name': name or 'logo',
            'image': base64.b64encode(image_data).decode('ascii'),
            'image_fname': name or 'logo.png',
            'mimetype': mimetype,
        })
        return {'ok': True, 'id': logo.id, 'name': logo.name}

    @http.route('/dieline/logo/list', type='json', auth='user', methods=['POST'])
    def logo_list(self, **kwargs):
        """Devolve a lista de logos guardados pelo parceiro actual."""
        partner = request.env.user.partner_id
        if not partner:
            return []
        logos = request.env['atp.partner.logo'].sudo().search(
            [('partner_id', '=', partner.id)], order='create_date desc')
        result = []
        for lg in logos:
            data_url = ''
            if lg.image:
                mime = lg.mimetype or 'image/png'
                data_url = 'data:%s;base64,%s' % (mime, lg.image.decode('ascii') if isinstance(lg.image, bytes) else lg.image)
            result.append({'id': lg.id, 'name': lg.name, 'dataUrl': data_url})
        return result

    @http.route('/dieline/logo/delete', type='json', auth='user', methods=['POST'])
    def logo_delete(self, logo_id, **kwargs):
        """Remove um logo da galeria do parceiro."""
        partner = request.env.user.partner_id
        logo = request.env['atp.partner.logo'].sudo().browse(int(logo_id))
        if logo.exists() and logo.partner_id.id == partner.id:
            logo.unlink()
            return {'ok': True}
        return {'ok': False}


def _inject_logos_into_svg(svg_text, artwork, prod, rec):
    """Injeta todos os logos do artwork_json no SVG escalado, com cotas em mm."""
    import math, re

    if not artwork:
        return svg_text

    # Escala entre o SVG original do produto e o SVG desta encomenda
    sx = (rec.box_l / prod.box_l) if (prod and prod.box_l) else 1.0
    sy = (rec.box_h / prod.box_h) if (prod and prod.box_h) else 1.0

    # Ler viewBox/width do SVG para saber o viewBox original (para escalar dielineX/Y)
    # O SVG pode ter width/height em px — usamos o viewBox se disponível
    vb_scale_x, vb_scale_y = 1.0, 1.0
    m_vb = re.search(r'viewBox=["\']([^"\']+)["\']', svg_text)
    m_w  = re.search(r'<svg[^>]+width=["\']([0-9.]+)["\']', svg_text)
    m_h  = re.search(r'<svg[^>]+height=["\']([0-9.]+)["\']', svg_text)
    if m_vb and m_w and m_h:
        try:
            vb = [float(v) for v in m_vb.group(1).split()]
            svg_w, svg_h = float(m_w.group(1)), float(m_h.group(1))
            if vb[2] and vb[3]:
                vb_scale_x = svg_w / vb[2]
                vb_scale_y = svg_h / vb[3]
        except Exception:
            pass

    def dim_line_svg(x1, y1, x2, y2, label_mm):
        dx, dy = x2 - x1, y2 - y1
        length = math.sqrt(dx * dx + dy * dy)
        if length < 2:
            return ''
        ux, uy = dx / length, dy / length
        # offset perpendicular para a etiqueta
        px, py = -uy * 16, ux * 16
        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        ar = 8
        ax1 = x2 - ar * ux + ar * 0.35 * uy
        ay1 = y2 - ar * uy - ar * 0.35 * ux
        ax2 = x2 - ar * ux - ar * 0.35 * uy
        ay2 = y2 - ar * uy + ar * 0.35 * ux
        stroke = '#0d9488'
        lbl = '%g mm' % round(label_mm, 1)
        lbl_w = max(52, len(lbl) * 7)
        return (
            '<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="1.5" stroke-dasharray="5 3"/>'
            '<polygon points="%g,%g %g,%g %g,%g" fill="%s"/>'
            '<rect x="%g" y="%g" width="%g" height="18" fill="white" fill-opacity="0.9"/>'
            '<text x="%g" y="%g" font-size="12" font-weight="bold" font-family="Arial,sans-serif" '
            'fill="%s" text-anchor="middle" dominant-baseline="middle">%s</text>'
        ) % (
            x1, y1, x2, y2, stroke,
            x2, y2, ax1, ay1, ax2, ay2, stroke,
            mx + px - lbl_w / 2, my + py - 9, lbl_w,
            mx + px, my + py, stroke, lbl,
        )

    inject = []
    for _logo_key, logo in artwork.items():
        if not logo or not logo.get('dataUrl'):
            continue

        data_url = logo['dataUrl']
        size_mm  = float(logo.get('sizeMM', 80))
        rot      = float(logo.get('rot', 0))
        aspect   = float(logo.get('aspect', 1)) or 1

        # Coordenadas centro do logo no SVG escalado da encomenda
        # Preferência: dielineX/Y (em px do SVG original) × escala do produto
        dx0 = logo.get('dielineX')
        dy0 = logo.get('dielineY')
        svgW0 = logo.get('svgW')  # largura em px no SVG original
        svgH0 = logo.get('svgH')  # altura em px no SVG original

        if dx0 is None or dy0 is None:
            continue  # sem coordenadas, não é possível injectar

        lx = float(dx0) * sx * vb_scale_x
        ly = float(dy0) * sy * vb_scale_y

        # Dimensões em px no SVG escalado
        if svgW0 and svgH0:
            lw = float(svgW0) * sx * vb_scale_x
            lh = float(svgH0) * sy * vb_scale_y
        else:
            # fallback: estimar a partir de sizeMM e escala
            # PPM ≈ svgW / (prod.box_l + prod.box_w * 2 + ...) — não conhecido aqui
            # Usar sx/sy como proxy (1 mm ≈ sx px)
            lw = size_mm * sx
            lh = size_mm * aspect * sy

        rot_attr = ''
        if rot:
            rot_attr = ' transform="rotate(%g %g %g)"' % (rot, lx, ly)

        img_tag = '<image href="%s" x="%g" y="%g" width="%g" height="%g"%s preserveAspectRatio="xMidYMid meet"/>' % (
            data_url, lx - lw / 2, ly - lh / 2, lw, lh, rot_attr)
        inject.append(img_tag)

        # Cotas: largura e altura do logo em mm
        lw_mm = size_mm
        lh_mm = size_mm * aspect
        inject.append(dim_line_svg(lx, ly, lx - lw / 2, ly, lw_mm / 2))
        inject.append(dim_line_svg(lx, ly, lx + lw / 2, ly, lw_mm / 2))
        inject.append(dim_line_svg(lx, ly, lx, ly - lh / 2, lh_mm / 2))
        inject.append(dim_line_svg(lx, ly, lx, ly + lh / 2, lh_mm / 2))

    if not inject:
        return svg_text

    block = '\n'.join(inject)
    svg_text = svg_text.rstrip()
    if svg_text.endswith('</svg>'):
        svg_text = svg_text[:-6] + block + '\n</svg>'
    else:
        svg_text = svg_text + block
    return svg_text


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
