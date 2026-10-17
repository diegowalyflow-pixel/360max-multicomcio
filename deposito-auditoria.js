'use strict';
// deposito-auditoria.js — historial con filtros + csv + usuarios
const { all } = require('./db-pg');
const { tablaExiste, num } = require('./deposito-base');
async function historial(req, res) {
  try {
    const q = req.query || {};
    const lim = Math.min(Math.max(num(q.limit, 20), 1), 100);
    const off = Math.max(num(q.offset, 0), 0);
    const tM = await tablaExiste('movimientos_stock');
    if (!tM) {
      const rows = await all('SELECT v.id, v.creada_en, v.medio_pago, v.total FROM ventas WHERE comercio_id=$1 ORDER BY v.creada_en DESC LIMIT $2 OFFSET $3', [req.comercio.id, lim, off]);
      return res.json({ ok: true, degradado: true, movimientos: rows.map(r => ({ id: r.id, creada_en: r.creada_en, tipo: 'venta', motivo: 'Venta ' + r.medio_pago, cantidad: r.total, cajero: '-' })) });
    }
    const conds = ['m.comercio_id=$1'];
    const par = [req.comercio.id];
    if (q.desde) { conds.push('m.creada_en >= $' + (par.length + 1)); par.push(new Date(q.desde + 'T00:00:00')); }
    if (q.hasta) { conds.push('m.creada_en <= $' + (par.length + 1)); par.push(new Date(q.hasta + 'T23:59:59')); }
    if (q.usuario_id) { conds.push('m.usuario_id=$' + (par.length + 1)); par.push(Number(q.usuario_id)); }
    if (q.tipo && q.tipo !== 'todos') { conds.push('m.tipo=$' + (par.length + 1)); par.push(String(q.tipo)); }
    par.push(lim, off);
    const rows = await all('SELECT m.*, COALESCE(u.nombre,u.usuario,' + "'—'" + ') cajero FROM movimientos_stock m LEFT JOIN usuarios u ON u.id=m.usuario_id WHERE ' + conds.join(' AND ') + ' ORDER BY m.creada_en DESC LIMIT $' + (par.length - 1) + ' OFFSET $' + par.length, par);
    res.json({ ok: true, movimientos: rows, limit: lim, offset: off });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
}
async function detalle(req, res) {
  try {
    const tM = await tablaExiste('movimientos_stock');
    if (!tM) return res.json({ ok: false, mensaje: 'Sin auditoria aun' });
    const r = await all('SELECT m.*, COALESCE(u.nombre,u.usuario,' + "'—'" + ') cajero FROM movimientos_stock m LEFT JOIN usuarios u ON u.id=m.usuario_id WHERE m.comercio_id=$1 AND m.id=$2', [req.comercio.id, Number(req.params.id)]);
    res.json({ ok: true, movimiento: r[0] || null });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
}
async function usuarios(req, res) {
  try {
    const rows = await all('SELECT id,nombre,usuario,rol FROM usuarios WHERE comercio_id=$1 ORDER BY nombre', [req.comercio.id]);
    res.json({ ok: true, usuarios: rows });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
}
function esc(v) { const s = String(v == null ? '' : v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
async function historialCsv(req, res) {
  try {
    const q = req.query || {};
    const tM = await tablaExiste('movimientos_stock');
    let rows = [];
    if (tM) {
      const conds = ['m.comercio_id=$1'];
      const par = [req.comercio.id];
      if (q.desde) { conds.push('m.creada_en >= $' + (par.length + 1)); par.push(new Date(q.desde + 'T00:00:00')); }
      if (q.hasta) { conds.push('m.creada_en <= $' + (par.length + 1)); par.push(new Date(q.hasta + 'T23:59:59')); }
      if (q.usuario_id) { conds.push('m.usuario_id=$' + (par.length + 1)); par.push(Number(q.usuario_id)); }
      if (q.tipo && q.tipo !== 'todos') { conds.push('m.tipo=$' + (par.length + 1)); par.push(String(q.tipo)); }
      rows = await all('SELECT m.id,m.creada_en,m.tipo,m.producto_nombre,m.cantidad,m.motivo,COALESCE(u.nombre,' + "'—'" + ') cajero FROM movimientos_stock m LEFT JOIN usuarios u ON u.id=m.usuario_id WHERE ' + conds.join(' AND ') + ' ORDER BY m.creada_en DESC LIMIT 1000', par);
    }
    const csv = 'id;fecha;tipo;producto;cantidad;motivo;cajero\n' + rows.map(r => [r.id, new Date(r.creada_en).toLocaleString('es-AR'), r.tipo, r.producto_nombre, r.cantidad, r.motivo, r.cajero].map(esc).join(';')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="auditoria-360max.csv"');
    res.send('﻿' + csv);
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
}
module.exports = { historial, detalle, usuarios, historialCsv };
