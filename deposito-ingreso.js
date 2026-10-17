'use strict';
// deposito-ingreso.js — REGLA DE ORO: upsert, jamas duplica
const { pool } = require('./db-pg');
const { tablaExiste, num } = require('./deposito-base');
async function ingresoRapido(req, res) {
  const c = await pool.connect();
  try {
    const b = req.body || {};
    const cant = num(b.cantidad);
    const barra = String(b.codigo_barra || '').trim();
    const nombre = String(b.nombre || '').trim();
    if ((!nombre && !barra) || !(cant > 0)) { c.release(); return res.status(400).json({ ok: false, mensaje: 'Nombre o codigo + cantidad > 0' }); }
    await c.query('BEGIN');
    let p = null;
    if (barra) p = (await c.query('SELECT * FROM productos WHERE comercio_id=$1 AND codigo_barra=$2', [req.comercio.id, barra])).rows[0];
    if (!p && nombre) p = (await c.query('SELECT * FROM productos WHERE comercio_id=$1 AND LOWER(nombre)=LOWER($2) LIMIT 1', [req.comercio.id, nombre])).rows[0];
    let fila, accion;
    if (p) {
      const nc = (b.costo !== undefined && b.costo !== '') ? num(b.costo, Number(p.costo) || 0) : (Number(p.costo) || 0);
      fila = (await c.query('UPDATE productos SET stock=COALESCE(stock,0)+$1, costo=$2 WHERE id=$3 RETURNING *', [cant, nc, p.id])).rows[0];
      accion = 'adaptado';
    } else {
      const co = (b.costo !== undefined && b.costo !== '') ? num(b.costo) : 0;
      fila = (await c.query('INSERT INTO productos (comercio_id,nombre,categoria,codigo_barra,costo,precio,precio_fijo,stock) VALUES ($1,$2,$3,$4,$5,$5,$5,$6) RETURNING *', [req.comercio.id, nombre || barra, String(b.categoria || 'General'), barra || null, co, cant])).rows[0];
      accion = 'creado';
    }
    if (await tablaExiste('movimientos_stock')) {
      await c.query('INSERT INTO movimientos_stock (comercio_id,producto_id,producto_nombre,tipo,cantidad,stock_despues,costo_unit,motivo,usuario_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [req.comercio.id, fila.id, fila.nombre, 'ingreso', cant, Number(fila.stock) || 0, fila.costo, 'ingreso-rapido', req.usuarioSesion.id]);
    }
    await c.query('COMMIT');
    res.json({ ok: true, accion, producto: fila });
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    if (String(e.code) === '23505') return res.status(409).json({ ok: false, mensaje: 'Ya existe: se adapta el original.' });
    res.status(500).json({ ok: false, mensaje: e.message });
  } finally { c.release(); }
}
module.exports = { ingresoRapido };
