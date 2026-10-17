'use strict';
// deposito-factura.js — preview (CSV real / PDF-JPG simulado) + confirmar con regla de oro
const { pool } = require('./db-pg');
const { tablaExiste, num } = require('./deposito-base');
function preview(req, res) {
  try {
    const b = req.body || {};
    const nom = String(b.archivo_nombre || 'factura');
    const tipo = String(b.archivo_tipo || '').toLowerCase();
    const esCsv = tipo.indexOf('csv') >= 0 || nom.toLowerCase().endsWith('.csv');
    let items = [];
    if (esCsv) {
      const lineas = String(b.texto || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const ln of lineas.slice(0, 200)) {
        const p = ln.split(/[;,]/).map(s => s.trim());
        if (p.length < 2 || !p[1]) continue;
        items.push({ codigo: p[0] || '', nombre: p[1], cantidad: num(p[2], 1) || 1, costo: num(p[3]) });
      }
      if (!items.length) return res.status(400).json({ ok: false, mensaje: 'CSV vacio. Formato: codigo;nombre;cantidad;costo' });
    } else {
      const h = Math.abs(nom.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0));
      items = [
        { codigo: '779' + String(1000000 + (h % 8999999)), nombre: 'Item 1 ' + nom.slice(0, 16), cantidad: 12, costo: 500 },
        { codigo: '779' + String(2000000 + (h % 7999999)), nombre: 'Item 2 ' + nom.slice(0, 16), cantidad: 6, costo: 1200 }
      ];
    }
    res.json({ ok: true, simulado: !esCsv, archivo: nom, items });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
}
async function confirmar(req, res) {
  const c = await pool.connect();
  try {
    const b = req.body || {};
    const items = b.items || [];
    if (!items.length) { c.release(); return res.status(400).json({ ok: false, mensaje: 'Sin items' }); }
    await c.query('BEGIN');
    let ad = 0, cr = 0, un = 0;
    for (const it of items.slice(0, 500)) {
      const cant = num(it.cantidad);
      if (!(cant > 0)) continue;
      const barra = String(it.codigo || '').trim();
      let p = null;
      if (barra) p = (await c.query('SELECT * FROM productos WHERE comercio_id=$1 AND codigo_barra=$2', [req.comercio.id, barra])).rows[0];
      if (!p && it.nombre) p = (await c.query('SELECT * FROM productos WHERE comercio_id=$1 AND LOWER(nombre)=LOWER($2) LIMIT 1', [req.comercio.id, String(it.nombre).trim()])).rows[0];
      let fila;
      if (p) {
        const nc = (it.costo !== undefined && it.costo !== '') ? num(it.costo, Number(p.costo) || 0) : (Number(p.costo) || 0);
        fila = (await c.query('UPDATE productos SET stock=COALESCE(stock,0)+$1, costo=$2 WHERE id=$3 RETURNING *', [cant, nc, p.id])).rows[0];
        ad++;
      } else {
        fila = (await c.query('INSERT INTO productos (comercio_id,nombre,categoria,codigo_barra,costo,precio,precio_fijo,stock) VALUES ($1,$2,$3,$4,$5,$5,$5,$6) RETURNING *', [req.comercio.id, String(it.nombre || barra).trim(), 'General', barra || null, num(it.costo), cant])).rows[0];
        cr++;
      }
      un += cant;
      if (await tablaExiste('movimientos_stock')) {
        await c.query('INSERT INTO movimientos_stock (comercio_id,producto_id,producto_nombre,tipo,cantidad,stock_despues,costo_unit,motivo,factura_n,usuario_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [req.comercio.id, fila.id, fila.nombre, 'ingreso', cant, Number(fila.stock) || 0, fila.costo, 'factura ' + String(b.numero || ''), String(b.numero || ''), req.usuarioSesion.id]);
      }
    }
    await c.query('COMMIT');
    res.json({ ok: true, adaptados: ad, creados: cr, unidades: un });
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ ok: false, mensaje: e.message });
  } finally { c.release(); }
}
module.exports = { preview, confirmar };
