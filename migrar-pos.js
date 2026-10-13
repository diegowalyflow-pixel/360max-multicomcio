#!/usr/bin/env node
'use strict';
// Migración POS (aditivo, IF NOT EXISTS): cajas, ventas, venta_items.
// Correr una vez: node migrar-pos.js   (lee DATABASE_URL del .env o entorno)
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
  `CREATE TABLE IF NOT EXISTS cajas (
     id             SERIAL PRIMARY KEY,
     comercio_id    INT NOT NULL REFERENCES comercios(id) ON DELETE CASCADE,
     usuario_id     INT,
     estado         TEXT NOT NULL DEFAULT 'abierta',       -- abierta | cerrada
     saldo_inicial  NUMERIC(14,2) NOT NULL DEFAULT 0,
     saldo_final    NUMERIC(14,2),
     total_ventas   NUMERIC(14,2) NOT NULL DEFAULT 0,
     cant_ventas    INT NOT NULL DEFAULT 0,
     abierta_en     TIMESTAMP DEFAULT now(),
     cerrada_en     TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS ventas (
     id             SERIAL PRIMARY KEY,
     comercio_id    INT NOT NULL REFERENCES comercios(id) ON DELETE CASCADE,
     caja_id        INT REFERENCES cajas(id) ON DELETE SET NULL,
     usuario_id     INT,
     total          NUMERIC(14,2) NOT NULL DEFAULT 0,
     costo_total    NUMERIC(14,2) NOT NULL DEFAULT 0,
     medio_pago     TEXT NOT NULL DEFAULT 'efectivo',      -- efectivo | tarjeta | transferencia
     cliente        TEXT,
     creada_en      TIMESTAMP DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS venta_items (
     id             SERIAL PRIMARY KEY,
     venta_id       INT NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
     producto_id    INT,
     nombre         TEXT NOT NULL,
     cantidad       NUMERIC(14,3) NOT NULL DEFAULT 1,
     precio_unit    NUMERIC(14,2) NOT NULL DEFAULT 0,
     costo_unit     NUMERIC(14,2) NOT NULL DEFAULT 0,
     subtotal       NUMERIC(14,2) NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ventas_comercio ON ventas(comercio_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(comercio_id, creada_en)`,
  `CREATE INDEX IF NOT EXISTS idx_cajas_comercio ON cajas(comercio_id)`
];

(async () => {
  const pool = new pg.Pool({ connectionString: URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const sql of DDL) await c.query(sql);
    await c.query('COMMIT');
    const tablas = (await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`)).rows.map(r => r.table_name);
    console.log('✓ Esquema POS listo. Tablas: ' + tablas.join(', '));
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('✗ ERROR (rollback): ' + e.message);
    process.exitCode = 1;
  } finally { c.release(); await pool.end(); }
})();
