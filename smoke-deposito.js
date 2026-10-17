'use strict';
/* Smoke test (sin DB): verifica que deposito.js registra todas las rutas esperadas */
const fakeDb = {
  pool: { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }), on: () => {} },
  query: async () => ({ rows: [] }),
  get: async () => ({}),
  all: async () => [],
  run: async () => ({ rows: [] }),
  hashClave: () => '', nuevaClave: () => '', verificarClave: () => false,
  DATABASE_URL: ''
};
require.cache[require.resolve('./db-pg')] = { id: 'db-pg', filename: require.resolve('./db-pg'), loaded: true, exports: fakeDb };

const montar = require('./deposito');
const montajes = [];
const app = {
  use: (...a) => montajes.push('use ' + a[0]),
  get: (...a) => montajes.push('get ' + a[0]),
  post: (...a) => montajes.push('post ' + a[0])
};
montar(app, { exigirSesion: (q, s, n) => n(), exigirPagoAlDia: (q, s, n) => n() });
console.log('MONTAJES APP:', JSON.stringify(montajes));

const { router } = require('./deposito-base');
const rutas = router.stack.filter(l => l.route).map(l => Object.keys(l.route.methods).map(m => m.toUpperCase() + ' ' + l.route.path).join(','));
console.log('RUTAS API:', rutas.join(' | '));

const esperadas = ['POST /ingreso-rapido', 'POST /factura/preview', 'POST /factura/confirmar', 'GET /historial', 'GET /historial.csv', 'GET /historial/:id', 'GET /usuarios', 'POST /ajuste', 'POST /merma', 'GET /metricas', 'GET /buscar'];
const faltantes = esperadas.filter(e => rutas.indexOf(e) < 0);
if (faltantes.length) { console.error('FALTAN RUTAS:', faltantes); process.exit(1); }
if (montajes.length !== 2 || montajes[0] !== 'use /api/deposito' || montajes[1] !== 'get /deposito') { console.error('MONTAJE APP INESPERADO'); process.exit(1); }
console.log('SMOKE TEST OK — 11 rutas API + montaje unico verificados');