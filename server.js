'use strict';
/*
  ═══════════════════════════════════════════════════════════════════════════
  multicomcio/server.js — 360MAX COMERCIOS (multi-comercio sobre PostgreSQL)
  ═══════════════════════════════════════════════════════════════════════════
  - Puerto 4000 (configurable por PORT).
  - Login ESTÁNDAR de 2 campos (usuario + clave), usuario con .toLowerCase().
  - Sesiones con cookie HttpOnly (token 8h).
  - Catálogo con STOCK REAL leído de PostgreSQL (aislado por comercio).
  - Corte de pago: si pago_al_dia=false o estado='suspendido' bloquea el panel
    y muestra la pantalla violeta/blanca con logo 3D.
  - AISLADO: solo lee/crea dentro de multicomcio/. No toca boliches ni Agustín.

  USO:  npm run start:multicomcio
*/

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { get, all, run, nuevaClave, verificarClave, DATABASE_URL } = require('./db-pg');
const { exigirPagoAlDia, pantallaSuspension } = require('./corte-de-pago');

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const COMERCIO_ID = Number(process.env.COMERCIO_ID || 1);
const ADMIN_USUARIO = String(process.env.ADMIN_USUARIO || 'administrador').toLowerCase();
const ADMIN_CLAVE = process.env.ADMIN_CLAVE || '';
const ADMIN_NOMBRE = process.env.ADMIN_NOMBRE || 'Administrador';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Sesiones en memoria ────────────────────────────────────────────────────
const sesiones = new Map();
const COOKIE = 'mc_session';
const DURACION = 8 * 60 * 60 * 1000; // 8h

function leerCookie(req, nombre) {
  const raw = String(req.headers.cookie || '');
  const parte = raw.split(';').map(s => s.trim()).find(s => s.indexOf(nombre + '=') === 0);
  return parte ? decodeURIComponent(parte.slice(nombre.length + 1)) : null;
}
function limpiarCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}
function crearSesion(res, usuario, comercio) {
  const token = crypto.randomBytes(24).toString('hex');
  sesiones.set(token, { usuario, comercio, expira: Date.now() + DURACION });
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(DURACION / 1000)}`);
  return token;
}
function exigirSesion(req, res, next) {
  const token = leerCookie(req, COOKIE);
  const s = token && sesiones.get(token);
  if (!s || s.expira < Date.now()) { if (token) sesiones.delete(token); return res.status(401).json({ ok: false, mensaje: 'Sesión requerida' }); }
  req.sesion = s; req.usuarioSesion = s.usuario; req.comercio = s.comercio;
  next();
}

// ── Auto-siembra del admin desde variables de entorno (una sola vez) ───────
async function asegurarAdmin() {
  const comercio = await get('SELECT id, nombre, estado, pago_al_dia FROM comercios WHERE id = $1', [COMERCIO_ID]);
  if (!comercio) { console.error(`[multicomcio] No existe el comercio id=${COMERCIO_ID}. Corré: node migrar-comercios-pg.js`); return null; }
  const existe = await get('SELECT id FROM usuarios WHERE comercio_id = $1 AND usuario = $2', [COMERCIO_ID, ADMIN_USUARIO]);
  if (!existe && ADMIN_CLAVE) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = nuevaClave(ADMIN_CLAVE, salt);
    await run('INSERT INTO usuarios (comercio_id, nombre, usuario, clave_hash, clave_salt, rol) VALUES ($1,$2,$3,$4,$5,$6)',
      [COMERCIO_ID, ADMIN_NOMBRE, ADMIN_USUARIO, hash, salt, 'dueno']);
    console.log(`[multicomcio] Admin sembrado desde env: ${ADMIN_USUARIO}`);
  }
  return comercio;
}

// ── API: LOGIN (2 campos) ──────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const usuario = String((req.body && req.body.usuario) || '').trim().toLowerCase();
    const clave = String((req.body && req.body.clave) || '');
    if (!usuario || !clave) return res.status(400).json({ ok: false, mensaje: 'Usuario y contraseña requeridos' });

    const u = await get('SELECT id, nombre, usuario, clave_hash, clave_salt, rol, comercio_id FROM usuarios WHERE comercio_id = $1 AND usuario = $2',
      [COMERCIO_ID, usuario]);
    if (!u) return res.status(401).json({ ok: false, mensaje: 'Usuario o contraseña incorrectos' });
    if (!verificarClave(clave, u.clave_salt, u.clave_hash)) return res.status(401).json({ ok: false, mensaje: 'Usuario o contraseña incorrectos' });

    const comercio = await get('SELECT id, nombre, estado, pago_al_dia FROM comercios WHERE id = $1', [u.comercio_id]);
    crearSesion(res, { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol }, comercio);
    return res.json({ ok: true, usuario: { nombre: u.nombre, usuario: u.usuario, rol: u.rol } });
  } catch (e) { console.error('[login]', e); return res.status(500).json({ ok: false, mensaje: 'Error en el login' }); }
});

app.post('/api/logout', (req, res) => { const t = leerCookie(req, COOKIE); if (t) sesiones.delete(t); limpiarCookie(res); res.json({ ok: true }); });
app.get('/api/sesion', exigirSesion, (req, res) => res.json({ ok: true, usuario: req.usuarioSesion, comercio: req.comercio }));
app.get('/api/auth/estado', async (req, res) => {
  try { const r = await get('SELECT COUNT(*)::int n FROM usuarios WHERE comercio_id = $1', [COMERCIO_ID]); res.json({ ok: true, primer_uso: r.n === 0 }); }
  catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});

// Catálogo con stock REAL de la BD (requiere sesión + pago al día)
app.get('/api/productos', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const rows = await all('SELECT id, nombre, categoria, codigo_barra, costo, precio, precio_fijo, stock FROM productos WHERE comercio_id = $1 ORDER BY nombre',
      [req.comercio.id]);
    res.json({ ok: true, productos: rows });
  } catch (e) { console.error('[productos]', e); res.status(500).json({ ok: false, mensaje: 'Error cargando productos' }); }
});

// Estado del comercio (dueño/admin): permite suspender/reactivar desde el panel
app.post('/api/comercio/estado', exigirSesion, async (req, res) => {
  try {
    const rol = String(req.usuarioSesion.rol || '').toLowerCase();
    if (rol !== 'dueno' && rol !== 'administrador') return res.status(403).json({ ok: false, mensaje: 'Solo el dueño' });
    const pago = req.body && req.body.pago_al_dia;
    await run('UPDATE comercios SET pago_al_dia = $1, actualizado_en = now() WHERE id = $2', [!!pago, req.comercio.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  POS 360MAX — CAJA (aislado por comercio)
// ═════════════════════════════════════════════════════════════════════════════
function precioDe(p) {
  const fijo = p.precio_fijo != null && p.precio_fijo !== '' ? Number(p.precio_fijo) : null;
  return fijo != null ? fijo : Number(p.precio || 0);
}

app.get('/api/caja/actual', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const caja = await get("SELECT * FROM cajas WHERE comercio_id = $1 AND estado = 'abierta' ORDER BY id DESC LIMIT 1", [req.comercio.id]);
    res.json({ ok: true, caja: caja || null });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});

app.post('/api/caja/abrir', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const abierta = await get("SELECT id FROM cajas WHERE comercio_id = $1 AND estado = 'abierta'", [req.comercio.id]);
    if (abierta) return res.status(400).json({ ok: false, mensaje: 'Ya hay una caja abierta' });
    const inicial = Number(req.body && req.body.saldo_inicial || 0);
    const r = await run(
      "INSERT INTO cajas (comercio_id, usuario_id, saldo_inicial) VALUES ($1, $2, $3) RETURNING *",
      [req.comercio.id, req.usuarioSesion.id, inicial]);
    res.json({ ok: true, caja: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});

app.post('/api/caja/cerrar', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const caja = await get("SELECT * FROM cajas WHERE comercio_id = $1 AND estado = 'abierta' ORDER BY id DESC LIMIT 1", [req.comercio.id]);
    if (!caja) return res.status(400).json({ ok: false, mensaje: 'No hay caja abierta' });
    const conteo = Number(req.body && req.body.saldo_contado || 0);
    const r = await run(
      "UPDATE cajas SET estado='cerrada', saldo_final=$1, cerrada_en=now() WHERE id=$2 RETURNING *",
      [conteo, caja.id]);
    res.json({ ok: true, caja: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  POS 360MAX — COBRO + REPORTES
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/ventas', exigirSesion, exigirPagoAlDia, async (req, res) => {
  const { items, medio_pago, cliente } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, mensaje: 'Carrito vacío' });
  const { pool } = require('./db-pg');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let total = 0, costo = 0;
    const detalle = [];
    for (const it of items) {
      const pid = Number(it.producto_id);
      const cant = Number(it.cantidad || 1);
      if (!pid || cant <= 0) throw new Error('Item inválido');
      const p = (await c.query('SELECT * FROM productos WHERE id = $1 AND comercio_id = $2 FOR UPDATE', [pid, req.comercio.id])).rows[0];
      if (!p) throw new Error('Producto no encontrado');
      if (cant > Number(p.stock || 0)) throw new Error('Stock insuficiente de ' + p.nombre + ' (quedan ' + Number(p.stock || 0) + ')');
      const precio = it.precio != null && it.precio !== '' ? Number(it.precio) : precioDe(p);
      const sub = Math.round(precio * cant * 100) / 100;
      total += sub; costo += Math.round(Number(p.costo || 0) * cant * 100) / 100;
      await c.query('UPDATE productos SET stock = stock - $1 WHERE id = $2', [cant, pid]);
      detalle.push({ producto_id: pid, nombre: p.nombre, cantidad: cant, precio_unit: precio, costo_unit: Number(p.costo || 0), subtotal: sub });
    }
    total = Math.round(total * 100) / 100; costo = Math.round(costo * 100) / 100;
    const caja = (await c.query("SELECT id FROM cajas WHERE comercio_id = $1 AND estado='abierta' ORDER BY id DESC LIMIT 1", [req.comercio.id])).rows[0];
    const v = (await c.query(
      "INSERT INTO ventas (comercio_id, caja_id, usuario_id, total, costo_total, medio_pago, cliente) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [req.comercio.id, caja ? caja.id : null, req.usuarioSesion.id, total, costo, medio_pago || 'efectivo', cliente || null])).rows[0];
    for (const d of detalle) {
      await c.query(
        "INSERT INTO venta_items (venta_id, producto_id, nombre, cantidad, precio_unit, costo_unit, subtotal) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [v.id, d.producto_id, d.nombre, d.cantidad, d.precio_unit, d.costo_unit, d.subtotal]);
    }
    if (caja) await c.query("UPDATE cajas SET total_ventas = total_ventas + $1, cant_ventas = cant_ventas + 1 WHERE id = $2", [total, caja.id]);
    await c.query('COMMIT');
    res.json({ ok: true, venta_id: v.id, total, costo_total: costo, ganancia: Math.round((total - costo) * 100) / 100 });
  } catch (e) {
    await c.query('ROLLBACK');
    res.status(400).json({ ok: false, mensaje: e.message });
  } finally { c.release(); }
});

app.get('/api/reportes/hoy', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const cid = req.comercio.id;
    const totales = await get(
      `SELECT COALESCE(SUM(total),0) total, COALESCE(SUM(total - costo_total),0) ganancia, COUNT(*) ventas
       FROM ventas WHERE comercio_id = $1 AND creada_en::date = now()::date`, [cid]);
    const porMedio = await all(
      `SELECT medio_pago, COALESCE(SUM(total),0) total, COUNT(*) n
       FROM ventas WHERE comercio_id = $1 AND creada_en::date = now()::date
       GROUP BY medio_pago ORDER BY total DESC`, [cid]);
    const top = await all(
      `SELECT vi.nombre, SUM(vi.cantidad) cantidad, SUM(vi.subtotal) subtotal
       FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id
       WHERE v.comercio_id = $1 AND v.creada_en::date = now()::date
       GROUP BY vi.nombre ORDER BY cantidad DESC LIMIT 10`, [cid]);
    const ultimas = await all(
      `SELECT id, total, medio_pago, cliente, creada_en FROM ventas
       WHERE comercio_id = $1 AND creada_en::date = now()::date ORDER BY id DESC LIMIT 15`, [cid]);
    res.json({ ok: true, totales, porMedio, top, ultimas });
  } catch (e) {
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});

// ── Reportes por rango de fechas ──────────────────────────────────────────
app.get('/api/reportes/rango', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const cid = req.comercio.id;
    let desde = String(req.query.desde || '');
    let hasta = String(req.query.hasta || '');
    const hoy = new Date();
    const ahora = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}-${String(hoy.getDate()).padStart(2,'0')}`;
    if (!desde || !hasta) {
      desde = ahora;
      hasta = ahora;
    }
    const desdeSql = `to_date('${desde}','YYYY-MM-DD')`;
    const hastaSql = `to_date('${hasta}','YYYY-MM-DD')`;
    const totales = await get(
      `SELECT COALESCE(SUM(total),0) total,
              COALESCE(SUM(total - costo_total),0) ganancia,
              COUNT(*) ventas,
              COALESCE(SUM(CASE WHEN creada_en::date BETWEEN ${desdeSql} AND ${hastaSql} THEN 1 ELSE 0 END),0) ventas_en_rango,
              COALESCE(SUM(CASE WHEN creada_en::date BETWEEN ${desdeSql} AND ${hastaSql} THEN total ELSE 0 END),0) total_en_rango,
              COALESCE(SUM(CASE WHEN creada_en::date BETWEEN ${desdeSql} AND ${hastaSql} THEN total - costo_total ELSE 0 END),0) ganancia_en_rango
       FROM ventas WHERE comercio_id = $1`, [cid]);
    const porMedio = await all(
      `SELECT medio_pago, COALESCE(SUM(total),0) total, COUNT(*) n
       FROM ventas WHERE comercio_id = $1 AND creada_en::date BETWEEN ${desdeSql} AND ${hastaSql}
       GROUP BY medio_pago ORDER BY total DESC`, [cid]);
    const productos = await all(
      `SELECT vi.nombre, SUM(vi.cantidad) cantidad, SUM(vi.subtotal) subtotal
       FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id
       WHERE v.comercio_id = $1 AND v.creada_en::date BETWEEN ${desdeSql} AND ${hastaSql}
       GROUP BY vi.nombre ORDER BY cantidad DESC LIMIT 10`, [cid]);
    const porFechas = await all(
      `SELECT creada_en::date fecha, COUNT(*) n, COALESCE(SUM(total),0) total, COALESCE(SUM(total - costo_total),0) ganancia
       FROM ventas WHERE comercio_id = $1 AND creada_en::date BETWEEN ${desdeSql} AND ${hastaSql}
       GROUP BY fecha ORDER BY fecha`, [cid]);
    res.json({ ok: true, totales, porMedio, productos, porFechas });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  POS 360MAX — PRODUCTOS (crear / editar / stock / borrar)
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/productos', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const rol = String(req.usuarioSesion.rol || '').toLowerCase();
    if (rol === 'cajero') return res.status(403).json({ ok: false, mensaje: 'Sin permiso' });
    const { nombre, categoria, codigo_barra, costo, precio, precio_fijo, stock } = req.body || {};
    if (!nombre) return res.status(400).json({ ok: false, mensaje: 'Falta el nombre' });
    const r = await run(
      `INSERT INTO productos (comercio_id, nombre, categoria, codigo_barra, costo, precio, precio_fijo, stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.comercio.id, nombre, categoria || null, codigo_barra || null,
       Number(costo || 0), Number(precio || 0), precio_fijo != null && precio_fijo !== '' ? Number(precio_fijo) : null,
       Number(stock || 0)]);
    res.json({ ok: true, producto: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ ok: false, mensaje: 'Ya existe un producto con ese código de barras' });
    res.status(500).json({ ok: false, mensaje: e.message });
  }
});

app.put('/api/productos/:id', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const rol = String(req.usuarioSesion.rol || '').toLowerCase();
    if (rol === 'cajero') return res.status(403).json({ ok: false, mensaje: 'Sin permiso' });
    const { nombre, categoria, codigo_barra, costo, precio, precio_fijo } = req.body || {};
    const r = await run(
      `UPDATE productos SET nombre=$1, categoria=$2, codigo_barra=$3, costo=$4, precio=$5, precio_fijo=$6
       WHERE id=$7 AND comercio_id=$8 RETURNING *`,
      [nombre, categoria || null, codigo_barra || null, Number(costo || 0), Number(precio || 0),
       precio_fijo != null && precio_fijo !== '' ? Number(precio_fijo) : null,
       Number(req.params.id), req.comercio.id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, mensaje: 'No encontrado' });
    res.json({ ok: true, producto: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});

app.post('/api/productos/:id/stock', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const cantidad = Number(req.body && req.body.cantidad);
    if (!cantidad) return res.status(400).json({ ok: false, mensaje: 'Cantidad inválida' });
    const r = await run(
      'UPDATE productos SET stock = stock + $1 WHERE id = $2 AND comercio_id = $3 RETURNING *',
      [cantidad, Number(req.params.id), req.comercio.id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, mensaje: 'No encontrado' });
    res.json({ ok: true, producto: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});

app.delete('/api/productos/:id', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const rol = String(req.usuarioSesion.rol || '').toLowerCase();
    if (rol !== 'dueno' && rol !== 'administrador') return res.status(403).json({ ok: false, mensaje: 'Solo dueño/admin' });
    await run('DELETE FROM productos WHERE id = $1 AND comercio_id = $2', [Number(req.params.id), req.comercio.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});

// ── Clientes y cuenta corriente ──
app.get('/api/clientes', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const rows = await all(q ? 'SELECT * FROM clientes WHERE comercio_id = $1 AND (nombre ILIKE $2 OR telefono ILIKE $2) ORDER BY nombre' : 'SELECT * FROM clientes WHERE comercio_id = $1 ORDER BY nombre', [req.comercio.id, '%' + q + '%']);
    res.json({ ok: true, clientes: rows });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});

app.post('/api/clientes', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const { nombre, telefono } = req.body || {};
    if (!nombre) return res.status(400).json({ ok: false, mensaje: 'Falta el nombre' });
    const r = await run('INSERT INTO clientes (comercio_id, nombre, telefono) VALUES ($1,$2,$3) RETURNING *', [req.comercio.id, nombre, telefono || null]);
    res.json({ ok: true, cliente: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});

app.get('/api/clientes/:id', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const c = await get('SELECT * FROM clientes WHERE id = $1 AND comercio_id = $2', [Number(req.params.id), req.comercio.id]);
    if (!c) return res.status(404).json({ ok: false, mensaje: 'No encontrado' });
    const movs = await all('SELECT * FROM clientes_movimientos WHERE cliente_id = $1 ORDER BY creada_en DESC LIMIT 50', [Number(req.params.id)]);
    res.json({ ok: true, cliente: c, movimientos: movs });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});

app.post('/api/clientes/:id/pago', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const { importe, motivo } = req.body || {};
    if (!importe || Number(importe) <= 0) return res.status(400).json({ ok: false, mensaje: 'Importe inválido' });
    const id = Number(req.params.id);
    await run('BEGIN');
    await run('UPDATE clientes SET saldo = saldo - $1 WHERE id = $2 AND comercio_id = $3', [importe, id, req.comercio.id]);
    await run('INSERT INTO clientes_movimientos (cliente_id, tipo, importe, motivo) VALUES ($1,\'pago\',$2,$3)', [id, importe, motivo || '']);
    await c.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await c.query('ROLLBACK'); res.status(500).json({ ok: false, mensaje: e.message }); }
});

// ── Listar ventas (para devoluciones/historial) ──
app.get('/api/ventas', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const caja = await get("SELECT id FROM cajas WHERE comercio_id = $1 AND estado = 'abierta' ORDER BY id DESC LIMIT 1", [req.comercio.id]);
    const rows = await all('SELECT id, total, medio_pago, cliente, creada_en FROM ventas WHERE comercio_id = $1' + (caja ? ' AND caja_id = $2' : '') + ' ORDER BY id DESC LIMIT 50', caja ? [req.comercio.id, caja.id] : [req.comercio.id]);
    res.json({ ok: true, ventas: rows });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});

// ── Vistas ──────────────────────────────────────────────────────────────────
// ── Ruta directa a la Caja POS ──
app.get('/caja', exigirSesion, exigirPagoAlDia, (req, res) => res.sendFile(path.join(__dirname, 'public', 'caja.html')));
app.get('/caja/cierre', exigirSesion, exigirPagoAlDia, (req, res) => res.sendFile(path.join(__dirname, 'public', 'cierre.html')));

// ── Estado del turno (caja abierta) ──
app.get('/api/caja/estado', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const caja = await get("SELECT * FROM cajas WHERE comercio_id = $1 AND estado = 'abierta' ORDER BY id DESC LIMIT 1", [req.comercio.id]);
    if (!caja) return res.json({ ok: true, turno: null });
    const ventas = await get("SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM ventas WHERE comercio_id = $1 AND caja_id = $2", [req.comercio.id, caja.id]);
    const u = await get('SELECT nombre FROM usuarios WHERE id = $1', [caja.usuario_id]);
    res.json({ ok: true, turno: { caja: caja.id, usuario: u ? u.nombre : '—', fecha_apertura: caja.abierta_en, fondo: Number(caja.saldo_inicial || 0), ventas_n: Number(ventas.n || 0), ventas_total: Number(ventas.total || 0) }, cierre_anterior: null });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});

// ── Arqueo de caja ──
app.get('/api/caja/arqueo', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const caja = await get("SELECT * FROM cajas WHERE comercio_id = $1 AND estado = 'abierta' ORDER BY id DESC LIMIT 1", [req.comercio.id]);
    if (!caja) return res.json({ ok: true, turno: null });
    const ventas = await get("SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM ventas WHERE comercio_id = $1 AND caja_id = $2", [req.comercio.id, caja.id]);
    const porMedio = await all("SELECT medio_pago, COALESCE(SUM(total),0) AS monto, COUNT(*) AS n FROM ventas WHERE comercio_id = $1 AND caja_id = $2 GROUP BY medio_pago ORDER BY monto DESC", [req.comercio.id, caja.id]);
    const movimientos = await all("SELECT tipo, importe, motivo, creada_en FROM movimientos_caja WHERE comercio_id = $1 AND (caja_id = $2 OR caja_id IS NULL) ORDER BY creada_en DESC LIMIT 20", [req.comercio.id, caja.id]);
    let esperado = Number(caja.saldo_inicial || 0) + Number(caja.total_ventas || 0);
    for (const m of movimientos) { if (m.tipo === 'ingreso') esperado += Number(m.importe || 0); else esperado -= Number(m.importe || 0); }
    res.json({ ok: true, turno: { caja: caja.id, usuario: 'Cajero', fechaapertura: caja.abierta_en, fondo: Number(caja.saldo_inicial || 0), ventasn: Number(ventas.n || 0), ventastotal: Number(ventas.total || 0) }, esperado, pagos: porMedio.map(p => ({ medio: p.medio_pago, monto: Number(p.monto || 0) })), movimientos: movimientos.map(m => ({ tipo: m.tipo, motivo: m.motivo || '', importe: Number(m.importe || 0) })) });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});

// ── Cierre de caja (POST arqueo): guarda denominaciones, diferencia y bloquea caja ──
app.post('/api/caja/arqueo', exigirSesion, exigirPagoAlDia, async (req, res) => {
  const { pool } = require('./db-pg');
  const c = await pool.connect();
  try {
    const caja = await get("SELECT * FROM cajas WHERE comercio_id = $1 AND estado = 'abierta' ORDER BY id DESC LIMIT 1", [req.comercio.id]);
    if (!caja) return res.status(400).json({ ok: false, mensaje: 'No hay caja abierta' });
    const contado = Number(req.body && req.body.contado || 0);
    const denominaciones = req.body && req.body.denominaciones ? JSON.stringify(req.body.denominaciones) : null;
    const auditoria = req.body && req.body.auditoria ? JSON.stringify(req.body.auditoria) : null;
    const observaciones = (req.body && req.body.observaciones) || '';
    // esperado = fondo + ventas + movimientos del turno
    const movimientos = await all("SELECT tipo, importe FROM movimientos_caja WHERE comercio_id = $1 AND (caja_id = $2 OR caja_id IS NULL)", [req.comercio.id, caja.id]);
    let esperado = Number(caja.saldo_inicial || 0) + Number(caja.total_ventas || 0);
    for (const m of movimientos) { if (m.tipo === 'ingreso') esperado += Number(m.importe || 0); else esperado -= Number(m.importe || 0); }
    esperado = Math.round(esperado * 100) / 100;
    const diferencia = Math.round((contado - esperado) * 100) / 100;
    await c.query('BEGIN');
    // registrar cierre
    await c.query(
      `INSERT INTO cierres_caja (comercio_id, caja_id, usuario_id, fondo, ventas_total, esperado, contado, diferencia, denominaciones, auditoria, observaciones)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [req.comercio.id, caja.id, req.usuarioSesion.id, Number(caja.saldo_inicial || 0), Number(caja.total_ventas || 0), esperado, contado, diferencia, denominaciones, auditoria, observaciones]);
    // bloquear caja
    await c.query("UPDATE cajas SET estado='cerrada', saldo_final=$1, cerrada_en=now() WHERE id=$2", [contado, caja.id]);
    await c.query('COMMIT');
    res.json({ ok: true, cierre: { caja: caja.id, esperado, contado, diferencia, cerrada_en: new Date().toISOString() } });
  } catch (e) {
    await c.query('ROLLBACK');
    res.status(500).json({ ok: false, mensaje: e.message });
  } finally { c.release(); }
});

// ── Historial de cierres (para el buscador) ──
app.get('/api/caja/cierres', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    let rows;
    if (q) {
      // filtra por fecha (substring de fecha ISO) o monto (esperado/contado/diferencia)
      rows = await all(
        `SELECT id, caja_id, fondo, ventas_total, esperado, contado, diferencia, creada_en
         FROM cierres_caja
         WHERE comercio_id = $1
           AND (to_char(creada_en,'YYYY-MM-DD') ILIKE '%'||$2||'%'
                OR to_char(creada_en,'DD/MM/YYYY') ILIKE '%'||$2||'%'
                OR CAST(esperado AS TEXT) ILIKE '%'||$2||'%'
                OR CAST(contado AS TEXT) ILIKE '%'||$2||'%'
                OR CAST(diferencia AS TEXT) ILIKE '%'||$2||'%')
         ORDER BY creada_en DESC LIMIT 30`,
        [req.comercio.id, q]);
    } else {
      rows = await all(
        `SELECT id, caja_id, fondo, ventas_total, esperado, contado, diferencia, creada_en
         FROM cierres_caja WHERE comercio_id = $1 ORDER BY creada_en DESC LIMIT 30`,
        [req.comercio.id]);
    }
    res.json({ ok: true, cierres: rows });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});

// ── Movimiento de caja ──
app.post('/api/caja/movimiento', exigirSesion, exigirPagoAlDia, async (req, res) => {
  try {
    const { tipo, importe, motivo } = req.body || {};
    if (!tipo || !importe) return res.status(400).json({ ok: false, mensaje: 'Tipo e importe requeridos' });
    const caja = await get("SELECT id FROM cajas WHERE comercio_id = $1 AND estado = 'abierta' ORDER BY id DESC LIMIT 1", [req.comercio.id]);
    const r = await run('INSERT INTO movimientos_caja (comercio_id, caja_id, tipo, importe, motivo, usuario_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [req.comercio.id, caja ? caja.id : null, tipo, Number(importe), motivo || '', req.usuarioSesion.id]);
    res.json({ ok: true, movimiento: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Panel protegido: si el comercio está suspendido, exigirPagoAlDia corta con la
// pantalla violeta/blanca; si está al día, sirve el panel (app.html).
app.get('/panel', exigirSesion, exigirPagoAlDia, (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// Ruta directa a la pantalla de suspensión (redirige desde el front ante un 402)
app.get('/suspension', exigirSesion, async (req, res) => {
  try {
    const c = await get('SELECT id, nombre, estado, pago_al_dia FROM comercios WHERE id = $1', [req.comercio.id]);
    res.status(402).type('html').send(pantallaSuspension(c));
  } catch (e) { res.status(500).type('html').send('Error'); }
});

// ── Arranque ─────────────────────────────────────────────────────────────────
asegurarAdmin()
  .then(() => app.listen(PORT, () => {
    console.log(`[multicomcio] 360MAX Comercios → http://localhost:${PORT}`);
    console.log(`[multicomcio] DATABASE_URL: ${DATABASE_URL ? 'OK' : 'FALTA (revisá .env)'} · comercio id=${COMERCIO_ID}`);
  }))
  .catch(e => { console.error('[multicomcio] error de arranque:', e.message); process.exit(1); });

