'use strict';
// deposito-base.js — router + helpers + metricas + buscar
const express = require('express');
const { get, all } = require('./db-pg');
const router = express.Router();
async function tablaExiste(n) {
  try { const r = await get('SELECT to_regclass($1) AS t', ['public.' + n]); return !!(r && r.t); }
  catch (e) { return false; }
}
function num(x, d) { const n = Number(x); return Number.isFinite(n) ? n : (d || 0); }
router.get('/metricas', async (req, res) => {
  try {
    const cid = req.comercio.id;
    const tM = await tablaExiste('movimientos_stock');
    let mM = 0, me = 0, mT = 0;
    if (tM) {
      try { mM = (await get('SELECT COUNT(*) n FROM movimientos_stock WHERE comercio_id=$1 AND creada_en >= date_trunc(\'month\', now())', [cid])).n; } catch (e) { mM = 0; }
      try { me = (await get("SELECT COUNT(*) n FROM movimientos_stock WHERE comercio_id=$1 AND tipo='merma'", [cid])).n; } catch (e) { me = 0; }
      try { mT = (await get('SELECT COUNT(*) n FROM movimientos_stock WHERE comercio_id=$1', [cid])).n; } catch (e) { mT = 0; }
    }
    const st = await get('SELECT COALESCE(SUM(stock),0) u, COUNT(*) p FROM productos WHERE comercio_id=$1', [cid]);
    let falt = 0;
    try { falt = (await get('SELECT COUNT(*) n FROM productos WHERE comercio_id=$1 AND COALESCE(stock_minimo,0)>0 AND stock <= stock_minimo', [cid])).n; } catch (e) { falt = 0; }
    res.json({ ok: true, metricas: { movimientos_mes: num(mM), stock_total: num(st.u), productos: num(st.p), faltantes: num(falt), mermas: num(me), movimientos_total: num(mT) } });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});
router.get('/buscar', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const like = '%' + q.split('').filter(c => c !== '%' && c !== '_').join('') + '%';
    // q vacío → lista completa (limitada) para el buscador en vivo de la pantalla
    const rows = q
      ? await all("SELECT id,nombre,categoria,codigo_barra,costo,precio,precio_fijo,stock,COALESCE(ingresado_total,0) ingresado_total,COALESCE(vendido_total,0) vendido_total,COALESCE(stock_minimo,0) stock_minimo FROM productos WHERE comercio_id=$1 AND (nombre ILIKE $2 OR COALESCE(codigo_barra,'') ILIKE $2) ORDER BY nombre LIMIT 200", [req.comercio.id, like])
      : await all("SELECT id,nombre,categoria,codigo_barra,costo,precio,precio_fijo,stock,COALESCE(ingresado_total,0) ingresado_total,COALESCE(vendido_total,0) vendido_total,COALESCE(stock_minimo,0) stock_minimo FROM productos WHERE comercio_id=$1 ORDER BY nombre LIMIT 200", [req.comercio.id]);
    res.json({ ok: true, productos: rows });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});
module.exports = { router, tablaExiste, num };
