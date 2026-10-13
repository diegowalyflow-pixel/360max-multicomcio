'use strict';
/*
  ═══════════════════════════════════════════════════════════════════════════
  multicomcio/db-pg.js — CAPA DE DATOS POSTGRESQL (360MAX Comercios)
  ═══════════════════════════════════════════════════════════════════════════
  - Lee DATABASE_URL del entorno o del .env del proyecto (sin dependencias).
  - Pool con SSL (Render). Helpers get/all/query para Postgres ($N).
  - scrypt para hashear/verificar claves (login).
  - AISLADO: no toca SQLite ni otros proyectos.
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- Carga de .env del proyecto (raíz), sin pisar variables reales ---
(function cargarEnv() {
  const archivo = path.join(__dirname, '..', '.env');
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
if (!URL) console.error('[db-pg] ADVERTENCIA: falta DATABASE_URL (definila en .env o entorno).');

// --- Resolver pg SOLO de forma local (aislado; no lee otros proyectos) ---
function requerirPg() {
  try { return require('pg'); } catch (e) {}
  const local = path.join(__dirname, '..', 'node_modules', 'pg');
  try { if (fs.existsSync(path.join(local, 'package.json'))) return require(local); } catch (e) {}
  throw new Error("No se encontró el módulo 'pg'. Instalalo en ESTE proyecto: npm i pg");
}

const pg = requerirPg();
const pool = new pg.Pool({ connectionString: URL, ssl: { rejectUnauthorized: false } });
pool.on('error', (e) => console.error('[db-pg] pool error:', e.message));

// --- Helpers estilo API dual (compatibles con el patrón del proyecto) ---
function query(text, params) { return pool.query(text, params); }
function get(text, params) { return pool.query(text, params).then(r => r.rows[0]); }
function all(text, params) { return pool.query(text, params).then(r => r.rows); }
function run(text, params) { return pool.query(text, params); }

// --- Claves (scrypt) ---
function hashClave(clave, salt) { return crypto.scryptSync(String(clave), salt, 64).toString('hex'); }
function nuevaClave(clave, salt) { return hashClave(clave, salt); }
function verificarClave(clave, salt, hashEsperado) {
  try { return crypto.timingSafeEqual(Buffer.from(hashClave(clave, salt), 'hex'), Buffer.from(hashEsperado, 'hex')); }
  catch (e) { return false; }
}

module.exports = { pool, query, get, all, run, hashClave, nuevaClave, verificarClave, DATABASE_URL: URL };
