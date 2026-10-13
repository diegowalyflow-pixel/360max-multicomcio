'use strict';
/*
  ═══════════════════════════════════════════════════════════════════════════
  multicomcio/corte-de-pago.js — MIDDLEWARE DE CORTE DE PAGO + PANTALLA
  ═══════════════════════════════════════════════════════════════════════════
  Bloquea el acceso cuando el comercio tiene pago_al_dia = false o
  estado = 'suspendido'. Respeta:
    - Peticiones /api/*  -> responde JSON 402 { suspendido: true }
    - Navegación (HTML)  -> pantalla violeta/blanca con logo 3D
*/

const { get } = require('./db-pg');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Pantalla de suspensión: degradado violeta→blanco + cubo 3D giratorio
function pantallaSuspension(comercio) {
  const nombre = escapeHtml((comercio && comercio.nombre) || 'Comercio');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Servicio Suspendido — 360MAX</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{
    font-family:'Segoe UI',system-ui,Arial,sans-serif;
    background:linear-gradient(160deg,#4c1d95 0%,#6d28d9 45%,#ede9fe 100%);
    display:flex;align-items:center;justify-content:center;color:#fff;overflow:hidden;
  }
  .card{
    text-align:center;padding:48px 40px;max-width:520px;
    background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.35);
    border-radius:22px;backdrop-filter:blur(8px);
    box-shadow:0 30px 80px rgba(76,29,149,.45);
  }
  .stage{perspective:900px;height:170px;display:flex;align-items:center;justify-content:center;margin-bottom:26px}
  .cube{position:relative;width:96px;height:96px;transform-style:preserve-3d;animation:gira 7s linear infinite}
  .cube .face{
    position:absolute;width:96px;height:96px;display:flex;align-items:center;justify-content:center;
    font-weight:800;font-size:22px;letter-spacing:1px;color:#4c1d95;
    background:linear-gradient(145deg,#ffffff,#ede9fe);border:2px solid #fff;border-radius:12px;
    box-shadow:inset 0 0 22px rgba(109,40,217,.25);
  }
  .f1{transform:translateZ(48px)} .f2{transform:rotateY(90deg) translateZ(48px)}
  .f3{transform:rotateY(180deg) translateZ(48px)} .f4{transform:rotateY(-90deg) translateZ(48px)}
  .f5{transform:rotateX(90deg) translateZ(48px)} .f6{transform:rotateX(-90deg) translateZ(48px)}
  @keyframes gira{from{transform:rotateX(-18deg) rotateY(0)}to{transform:rotateX(-18deg) rotateY(360deg)}}
  h1{font-size:30px;font-weight:800;margin-bottom:10px;text-shadow:0 3px 14px rgba(0,0,0,.35)}
  .sub{font-size:16px;opacity:.95;margin-bottom:18px}
  .pill{display:inline-block;background:#fff;color:#6d28d9;font-weight:700;
    padding:9px 18px;border-radius:999px;font-size:14px;box-shadow:0 6px 18px rgba(0,0,0,.2)}
  .foot{margin-top:22px;font-size:12.5px;opacity:.85}
  .marca{margin-top:6px;font-weight:800;letter-spacing:3px;font-size:13px;opacity:.9}
</style>
</head>
<body>
  <div class="card">
    <div class="stage">
      <div class="cube">
        <div class="face f1">360</div><div class="face f2">MAX</div>
        <div class="face f3">3D</div><div class="face f4">360</div>
        <div class="face f5">MAX</div><div class="face f6">3D</div>
      </div>
    </div>
    <h1>Servicio Suspendido</h1>
    <p class="sub">El acceso de <strong>${nombre}</strong> fue pausado por falta de pago.</p>
    <span class="pill">Regularizá tu cuenta para reactivar el sistema</span>
    <p class="foot">Si ya realizaste el pago, contactá a soporte para reactivar el acceso.</p>
    <p class="marca">3 6 0 M A X</p>
  </div>
</body>
</html>`;
}

/*
  Middleware: espera req.comercio = { id, nombre, ... } (lo pone exigirSesion).
  Consulta el estado real en la BD y corta si corresponde.
*/
async function exigirPagoAlDia(req, res, next) {
  try {
    const comercioId = req.comercio && req.comercio.id;
    if (!comercioId) return res.status(401).json({ ok: false, mensaje: 'Sesión requerida' });

    const c = await get('SELECT id, nombre, estado, pago_al_dia FROM comercios WHERE id = $1', [comercioId]);
    if (!c) return res.status(401).json({ ok: false, mensaje: 'Comercio no encontrado' });

    const bloqueado = (c.pago_al_dia === false) || (String(c.estado).toLowerCase() === 'suspendido');
    if (bloqueado) {
      if (req.path.startsWith('/api/')) {
        return res.status(402).json({ ok: false, suspendido: true, mensaje: 'Servicio suspendido por falta de pago' });
      }
      return res.status(402).type('html').send(pantallaSuspension(c));
    }
    req.comercio = { ...req.comercio, estado: c.estado, pago_al_dia: c.pago_al_dia }; // refresca
    next();
  } catch (e) {
    console.error('[corte-de-pago] error:', e.message);
    return res.status(500).json({ ok: false, mensaje: 'Error verificando estado de cuenta' });
  }
}

module.exports = { exigirPagoAlDia, pantallaSuspension };
