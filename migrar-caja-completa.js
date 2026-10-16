#!/usr/bin/env node
'use strict';
// Migración Caja Completa (aditiva, IF NOT EXISTS): clientes, movimientos_caja.
// Correr una vez: node migrar-caja-completa.js   (lee DATABASE_URL del .env o entorno)
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
  `CREATE TABLE IF NOT EXISTS clientes (
     id             SERIAL PRIMARY KEY,
     comercio_id    INT NOT NULL REFERENCES comercios(id) ON DELETE CASCADE,
     nombre         TEXT NOT NULL,
     telefono       TEXT,
     saldo          NUMERIC(14,2) NOT NULL DEFAULT 0,
     creada_en      TIMESTAMP DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS movimientos_caja (
     id             SERIAL PRIMARY KEY,
     comercio_id    INT NOT NULL REFERENCES comercios(id) ON DELETE CASCADE,
     caja_id        INT REFERENCES cajas(id) ON DELETE SET NULL,
     tipo           TEXT NOT NULL,          -- ingreso | egreso
     importe        NUMERIC(14,2) NOT NULL DEFAULT 0,
     motivo         TEXT,
     usuario_id     INT,
     creada_en      TIMESTAMP DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS clientes_movimientos (
     id             SERIAL PRIMARY KEY,
     cliente_id     INT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
     tipo           TEXT NOT NULL,          -- pago | deuda
     importe        NUMERIC(14,2) NOT NULL DEFAULT 0,
     motivo         TEXT,
     creada_en      TIMESTAMP DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_clientes_comercio ON clientes(comercio_id)`,
  `CREATE INDEX IF NOT EXISTS idx_movimientos_caja_comercio ON movimientos_caja(comercio_id)`,
  `CREATE INDEX IF NOT EXISTS idx_clientes_movimientos_cliente ON clientes_movimientos(cliente_id)`
];

(async () => {
  const pool = new pg.Pool({ connectionString: URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const sql of DDL) await c.query(sql);
    await c.query('COMMIT');
    const tablas = (await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`)).rows.map(r => r.table_name);
    console.log('✓ Esquema Caja Completa listo. Tablas: ' + tablas.join(', '));
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('✗ ERROR (rollback): ' + e.message);
    process.exitCode = 1;
  } finally { c.release(); await pool.end(); }
})();