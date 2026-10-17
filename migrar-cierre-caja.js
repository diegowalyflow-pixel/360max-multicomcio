#!/usr/bin/env node
'use strict';
// Migración Cierre de Caja (aditiva, IF NOT EXISTS): cierres_caja.
// Guarda cada arqueo/cierre con denominaciones, diferencia y auditoría.
// Correr una vez: node migrar-cierre-caja.js   (lee DATABASE_URL del .env o entorno)
const fs = require('fs');
const path = require('path');
(function cargarEnv() {
  const archivo = path.join(__dirname, '.env');
  if (!fs.existsSync(archivo)) return;
  for (const cruda of fs.readFileSync(archivo, 'utf8').split(/\r?\n/)) {
    const linea = cruda.trim();
    if (!linea || linea[0] === '#' || linea.indexOf('=') <= 0) continue;
    const k = linea.slice(0, linea.indexOf('=')).trim();
    let v = linea.slice(linea.indexOf('=') + 1).trim();
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
})();
const URL = process.env.DATABASE_URL || '';
if (!URL) { console.error('Falta DATABASE_URL'); process.exit(1); }
function requerirPg() { try { return require('pg'); } catch (e) {} try { return require('C:/Users/DIego/Desktop/proyect360max comercios/node_modules/pg'); } catch (e) {} throw new Error('Falta pg'); }
const pg = requerirPg();

const DDL = [
  `CREATE TABLE IF NOT EXISTS cierres_caja (
     id             SERIAL PRIMARY KEY,
     comercio_id    INT NOT NULL REFERENCES comercios(id) ON DELETE CASCADE,
     caja_id        INT REFERENCES cajas(id) ON DELETE SET NULL,
     usuario_id     INT,
     fondo          NUMERIC(14,2) NOT NULL DEFAULT 0,
     ventas_total   NUMERIC(14,2) NOT NULL DEFAULT 0,
     esperado       NUMERIC(14,2) NOT NULL DEFAULT 0,
     contado        NUMERIC(14,2) NOT NULL DEFAULT 0,
     diferencia     NUMERIC(14,2) NOT NULL DEFAULT 0,
     denominaciones TEXT,          -- JSON: {"1000":5,"500":6,...}
     auditoria      TEXT,          -- JSON: log de acciones del turno
     observaciones  TEXT,
     creada_en      TIMESTAMP DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cierres_caja_comercio ON cierres_caja(comercio_id, creada_en)`
];

(async () => {
  const pool = new pg.Pool({ connectionString: URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const sql of DDL) await c.query(sql);
    await c.query('COMMIT');
    console.log('✓ Esquema Cierre de Caja listo (tabla cierres_caja).');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('✗ ERROR (rollback): ' + e.message);
    process.exitCode = 1;
  } finally { c.release(); await pool.end(); }
})();