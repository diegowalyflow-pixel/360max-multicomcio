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

// ── Vistas ──────────────────────────────────────────────────────────────────
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

