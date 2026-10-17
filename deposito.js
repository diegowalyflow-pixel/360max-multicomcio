'use strict';
/* DEPOSITO CONTROL TOTAL v2.1 — agregador (usa modulos existentes, no rompe nada) */
const path = require('path');
const { router } = require('./deposito-base');
const { ingresoRapido } = require('./deposito-ingreso');
const { preview, confirmar } = require('./deposito-factura');
const { historial, detalle, usuarios, historialCsv } = require('./deposito-auditoria');
const { pool } = require('./db-pg');
async function tablaX(n) {
  try {
    const { get } = require('./db-pg');
    const r = await get('SELECT to_regclass($1) AS t', ['public.' + n]);
    return !!(r && r.t);
  } catch (e) { return false; }
}
function num(x, d) { const n = Number(x); return Number.isFinite(n) ? n : (d || 0); }
function txt(x) { return String(x == null ? '' : x).trim(); }
router.post('/ingreso-rapido', ingresoRapido);
router.post('/factura/preview', preview);
router.post('/factura/confirmar', confirmar);
router.get('/historial', historial);
router.get('/historial.csv', historialCsv);
router.get('/historial/:id', detalle);
router.get('/usuarios', usuarios);
/* Ajuste de stock exacto + merma con motivo + trazabilidad (aditivo). */
router.post('/ajuste', async (req, res) => {
  const c = await pool.connect();
  try {
    const b = req.body || {};
    const pid = num(b.producto_id);
    const nuevo = num(b.stock_nuevo);
    if (!(pid > 0)) throw new Error('producto_id requerido');
    await c.query('BEGIN');
    const p = (await c.query('SELECT * FROM productos WHERE id=$1 AND comercio_id=$2', [pid, req.comercio.id])).rows[0];
    if (!p) throw new Error('Producto no encontrado');
    const fila = (await c.query('UPDATE productos SET stock=$1, actualizado_en=now() WHERE id=$2 RETURNING *', [nuevo, pid])).rows[0];
    const dif = nuevo - (Number(p.stock) || 0);
    if (await tablaX('movimientos_stock')) {
      await c.query('INSERT INTO movimientos_stock (comercio_id,producto_id,producto_nombre,tipo,cantidad,stock_despues,motivo,usuario_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [req.comercio.id, pid, fila.nombre, 'ajuste', dif, nuevo, txt(b.motivo) || 'ajuste-inventario', req.usuarioSesion.id]);
    }
    await c.query('COMMIT');
    res.json({ ok: true, producto: fila, diferencia: dif });
  } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} res.status(400).json({ ok: false, mensaje: e.message }); }
  finally { c.release(); }
});
router.post('/merma', async (req, res) => {
  const c = await pool.connect();
  try {
    const b = req.body || {};
    const pid = num(b.producto_id);
    const cant = num(b.cantidad);
    if (!(pid > 0) || !(cant > 0)) throw new Error('producto_id + cantidad > 0');
    await c.query('BEGIN');
    const p = (await c.query('SELECT * FROM productos WHERE id=$1 AND comercio_id=$2', [pid, req.comercio.id])).rows[0];
    if (!p) throw new Error('Producto no encontrado');
    const fila = (await c.query('UPDATE productos SET stock=GREATEST(0,COALESCE(stock,0)-$1), actualizado_en=now() WHERE id=$2 RETURNING *', [cant, pid])).rows[0];
    if (await tablaX('movimientos_stock')) {
      await c.query('INSERT INTO movimientos_stock (comercio_id,producto_id,producto_nombre,tipo,cantidad,stock_despues,motivo,usuario_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [req.comercio.id, pid, fila.nombre, 'merma', -cant, Number(fila.stock) || 0, txt(b.motivo) || 'merma', req.usuarioSesion.id]);
    }
    await c.query('COMMIT');
    res.json({ ok: true, producto: fila });
  } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} res.status(400).json({ ok: false, mensaje: e.message }); }
  finally { c.release(); }
});
module.exports = function montarDeposito(app, guards) {
  app.use('/api/deposito', guards.exigirSesion, guards.exigirPagoAlDia, router);
  app.get('/deposito', guards.exigirSesion, guards.exigirPagoAlDia, (req, res) => res.sendFile(path.join(__dirname, 'public', 'deposito.html')));
};


