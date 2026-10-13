#!/usr/bin/env node
'use strict';
// Carga la lista definitiva de 299 productos (precios EXACTOS) en el
// comercio #1 de max360diego_comercios_db (PostgreSQL de Render).
// Uso: node cargar-lista.js  (requiere DATABASE_URL en .env o en el entorno)
const fs = require('fs');
const path = require('path');

// .env local (si existe)
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const linea of env.split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
} catch (e) { /* sin .env, usa el entorno */ }

const URL_DB = process.env.DATABASE_URL || '';
if (!URL_DB) { console.error('Falta DATABASE_URL'); process.exit(1); }

let pg;
try { pg = require('pg'); }
catch (e) { pg = require('C:/Users/DIego/Desktop/proyect360max comercios/node_modules/pg'); }
const pool = new pg.Pool({ connectionString: URL_DB, ssl: { rejectUnauthorized: false } });

// Lista: la leemos del archivo fuente de la lista definitiva (solo el array).
const ORIGEN = 'C:/Users/DIego/Desktop/agustin/src/tools/cargar-lista-agustin.js';
const txt = fs.readFileSync(ORIGEN, 'utf8');
const ini = txt.indexOf('const PRODUCTOS = [');
const fin = txt.indexOf('\n];', ini);
if (ini < 0 || fin < 0) { console.error('No se encontró PRODUCTOS en ' + ORIGEN); process.exit(1); }
const PRODUCTOS = eval(txt.slice(ini + 'const PRODUCTOS = '.length, fin + 2));
console.log('Productos en la lista: ' + PRODUCTOS.length);

(async () => {
  let ok = 0;
  await pool.query('BEGIN');
  try {
    for (const [cod, nombre, precio, categoria] of PRODUCTOS) {
      const p = Math.round(Number(precio) * 100) / 100;
      await pool.query(
        `INSERT INTO productos (comercio_id, nombre, categoria, codigo_barra, costo, precio, precio_fijo, stock)
         VALUES (1, $1, $2, $3, $4, $4, $4, 0)
         ON CONFLICT (comercio_id, codigo_barra)
         DO UPDATE SET nombre = EXCLUDED.nombre, categoria = EXCLUDED.categoria,
                       costo = EXCLUDED.costo, precio = EXCLUDED.precio, precio_fijo = EXCLUDED.precio_fijo`,
        [nombre, categoria, cod, p]
      );
      ok++;
    }
    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    console.error('ERROR: ' + e.message);
    process.exit(1);
  }
  const total = await pool.query('SELECT COUNT(*) n FROM productos WHERE comercio_id = 1');
  console.log('Cargados: ' + ok + ' | Activos en BD: ' + total.rows[0].n);
  await pool.end();
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
