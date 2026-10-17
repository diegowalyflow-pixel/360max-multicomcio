'use strict';
/* 360MAX Multicomercio — Migracion DEPOSITO CONTROL TOTAL & AUDITORIA (v2.1)
   Aditiva e idempotente (IF NOT EXISTS). NO rompe caja/ventas/Agustin.
   Uso: node migrar-deposito.js  (lee DATABASE_URL del .env o entorno) */
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
    if (v.length >= 2 && ((v[0] === '"' && v[v.length-1] === '"') || (v[0] === "'" && v[v.length-1] === "'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
})();
const URL = process.env.DATABASE_URL || '';
if (!URL) { console.error('Falta DATABASE_URL (definila en .env o entorno).'); process.exit(1); }
function requerirPg() { try { return require('pg'); } catch (e) {} throw new Error("Falta 'pg'. Instalalo: npm i pg"); }
const pg = requerirPg();
const DDL = [
  `ALTER TABLE productos ADD COLUMN IF NOT EXISTS stock_minimo NUMERIC(14,3) NOT NULL DEFAULT 0`,
  `ALTER TABLE productos ADD COLUMN IF NOT EXISTS ingresado_total NUMERIC(14,3) NOT NULL DEFAULT 0`,
  `ALTER TABLE productos ADD COLUMN IF NOT EXISTS vendido_total NUMERIC(14,3) NOT NULL DEFAULT 0`,
  `ALTER TABLE productos ADD COLUMN IF NOT EXISTS actualizado_en TIMESTAMP DEFAULT now()`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_productos_comercio_barra')
    THEN ALTER TABLE productos ADD CONSTRAINT uq_productos_comercio_barra UNIQUE (comercio_id, codigo_barra); END IF; END $$`,
  `CREATE TABLE IF NOT EXISTS movimientos_stock (
     id SERIAL PRIMARY KEY, comercio_id INT NOT NULL REFERENCES comercios(id) ON DELETE CASCADE,
     producto_id INT REFERENCES productos(id) ON DELETE SET NULL, producto_nombre TEXT NOT NULL DEFAULT '',
     tipo TEXT NOT NULL, cantidad NUMERIC(14,3) NOT NULL DEFAULT 0,
     stock_despues NUMERIC(14,3) NOT NULL DEFAULT 0, costo_unit NUMERIC(14,2),
     motivo TEXT NOT NULL DEFAULT '', factura_n TEXT, usuario_id INT, creada_en TIMESTAMP DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_movstock_comercio ON movimientos_stock(comercio_id, creada_en DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_movstock_tipo ON movimientos_stock(comercio_id, tipo)`,
  `CREATE TABLE IF NOT EXISTS facturas (
     id SERIAL PRIMARY KEY, comercio_id INT NOT NULL REFERENCES comercios(id) ON DELETE CASCADE,
     numero TEXT, proveedor TEXT, archivo_nombre TEXT, archivo_tipo TEXT,
     items_total INT NOT NULL DEFAULT 0, unidades_total NUMERIC(14,3) NOT NULL DEFAULT 0,
     usuario_id INT, creada_en TIMESTAMP DEFAULT now())`
];
(async () => {
  const pool = new pg.Pool({ connectionString: URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const sql of DDL) await c.query(sql);
    await c.query('COMMIT');
    console.log('OK Esquema Deposito Control Total listo (movimientos_stock, facturas, stock_minimo, uq barra).');
  } catch (e) { await c.query('ROLLBACK'); console.error('ERROR (rollback): ' + e.message); process.exitCode = 1; }
  finally { c.release(); await pool.end(); }
})();
