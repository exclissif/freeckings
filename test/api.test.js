const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createPool, migrate, ensureAdmin } = require('../src/db');
const { createApp } = require('../src/app');

const DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://pagos:pagos@localhost:5432/pagos_test';
let pool;
let app;

async function login(email, password) {
  const agent = request.agent(app);
  const res = await agent.post('/api/login').set('X-Requested-With', 'fetch').send({ email, password });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  return agent;
}

const send = (agent, method, url, body) => agent[method](url).set('X-Requested-With', 'fetch').send(body);

before(async () => {
  pool = createPool(DATABASE_URL);
  await pool.query('DROP TABLE IF EXISTS items, project_members, projects, users, session CASCADE');
  await migrate(pool);
  await ensureAdmin(pool, { email: 'Admin@Example.com', password: 'admin-pass-123', name: 'Admin' });
  app = createApp({ pool, sessionSecret: 'test-secret', loginLimit: 1000 });
});

after(async () => {
  await pool.end();
});

test('requiere sesión y rechaza credenciales incorrectas', async () => {
  assert.strictEqual((await request(app).get('/api/summary')).status, 401);
  const bad = await request(app)
    .post('/api/login')
    .set('X-Requested-With', 'fetch')
    .send({ email: 'admin@example.com', password: 'nope' });
  assert.strictEqual(bad.status, 401);
});

test('rechaza peticiones de escritura sin la cabecera de la app (CSRF)', async () => {
  const res = await request(app).post('/api/login').send({ email: 'admin@example.com', password: 'admin-pass-123' });
  assert.strictEqual(res.status, 403);
});

test('flujo completo: proyectos, socios, pagos y permisos', async () => {
  const admin = await login('admin@example.com', 'admin-pass-123');

  const ana = (await send(admin, 'post', '/api/users', { email: 'ana@example.com', name: 'Ana', password: 'ana-pass-123' })).body;
  const luis = (await send(admin, 'post', '/api/users', { email: 'luis@example.com', name: 'Luis', password: 'luis-pass-123' })).body;
  assert.strictEqual((await send(admin, 'post', '/api/users', { email: 'ana@example.com', name: 'X', password: 'xxxxxxxx' })).status, 409);

  const web = await send(admin, 'post', '/api/projects', { name: 'Web', member_ids: [ana.id] });
  const shop = await send(admin, 'post', '/api/projects', { name: 'Tienda', member_ids: [luis.id] });
  assert.strictEqual(web.status, 201);

  const dom = await send(admin, 'post', `/api/projects/${web.body.id}/items`, {
    concept: 'Dominio web.com', category: 'dominio', amount: 12.5, currency: 'EUR', frequency: 'yearly', due_date: '2026-01-31',
  });
  assert.strictEqual(dom.status, 201);
  await send(admin, 'post', `/api/projects/${web.body.id}/items`, {
    concept: 'VPS', category: 'servidor', amount: 20, currency: 'USD', status: 'paid', paid_date: '2026-01-01',
  });
  await send(admin, 'post', `/api/projects/${shop.body.id}/items`, { concept: 'Hosting tienda', amount: 99, currency: 'EUR' });

  assert.strictEqual((await send(admin, 'post', `/api/projects/${web.body.id}/items`, { concept: 'x', amount: -1 })).status, 400);
  assert.strictEqual((await send(admin, 'post', `/api/projects/${web.body.id}/items`, { concept: '', amount: 1 })).status, 400);

  // Pago recurrente: al pagarlo se crea el siguiente pendiente.
  const pay = await send(admin, 'post', `/api/items/${dom.body.id}/pay`, { paid_date: '2026-01-30' });
  assert.strictEqual(pay.status, 200);
  assert.strictEqual(pay.body.paid.status, 'paid');
  assert.strictEqual(pay.body.next.due_date, '2027-01-31');
  assert.strictEqual(pay.body.next.status, 'pending');
  assert.strictEqual((await send(admin, 'post', `/api/items/${dom.body.id}/pay`, {})).status, 404);

  const summary = (await admin.get('/api/summary')).body;
  assert.deepStrictEqual(summary.totals, { EUR: { paid: 12.5, pending: 111.5 }, USD: { paid: 20, pending: 0 } });
  assert.strictEqual(summary.projects.length, 2);
  assert.ok(summary.upcoming.every((u) => u.status === 'pending'));

  // Ana solo ve el proyecto Web, y no puede modificar nada.
  const anaAgent = await login('ana@example.com', 'ana-pass-123');
  const anaSummary = (await anaAgent.get('/api/summary')).body;
  assert.deepStrictEqual(anaSummary.projects.map((p) => p.name), ['Web']);
  assert.deepStrictEqual(anaSummary.totals, { EUR: { paid: 12.5, pending: 12.5 }, USD: { paid: 20, pending: 0 } });
  assert.strictEqual((await anaAgent.get(`/api/projects/${shop.body.id}`)).status, 404);
  assert.strictEqual((await anaAgent.get(`/api/projects/${web.body.id}`)).body.items.length, 3);
  const anaProjects = (await anaAgent.get('/api/projects')).body;
  assert.strictEqual(anaProjects[0].member_ids, undefined);
  assert.strictEqual((await send(anaAgent, 'post', `/api/projects/${web.body.id}/items`, { concept: 'x', amount: 1 })).status, 403);
  assert.strictEqual((await send(anaAgent, 'delete', `/api/items/${dom.body.id}`)).status, 403);
  assert.strictEqual((await anaAgent.get('/api/users')).status, 403);

  // Quitar a Ana del proyecto le retira el acceso.
  await send(admin, 'put', `/api/projects/${web.body.id}`, { name: 'Web', member_ids: [] });
  assert.strictEqual((await anaAgent.get(`/api/projects/${web.body.id}`)).status, 404);

  // Cambiar la contraseña de un socio cierra sus sesiones.
  await send(admin, 'put', `/api/users/${ana.id}`, { email: 'ana@example.com', name: 'Ana', password: 'new-pass-456' });
  assert.strictEqual((await anaAgent.get('/api/me')).status, 401);

  // Editar y borrar.
  const edited = await send(admin, 'put', `/api/items/${pay.body.next.id}`, { ...pay.body.next, amount: 15 });
  assert.strictEqual(edited.body.amount, 15);
  assert.strictEqual((await send(admin, 'delete', `/api/items/${pay.body.next.id}`)).status, 200);
  assert.strictEqual((await send(admin, 'delete', `/api/projects/${shop.body.id}`)).status, 200);
  assert.strictEqual((await send(admin, 'delete', `/api/users/${luis.id}`)).status, 200);
  assert.strictEqual((await admin.get('/api/projects')).body.length, 1);
});

test('el socio puede cambiar su propia contraseña', async () => {
  const agent = await login('ana@example.com', 'new-pass-456');
  assert.strictEqual((await send(agent, 'post', '/api/me/password', { current: 'mal', next: 'otra-pass-789' })).status, 400);
  assert.strictEqual((await send(agent, 'post', '/api/me/password', { current: 'new-pass-456', next: 'otra-pass-789' })).status, 200);
  await login('ana@example.com', 'otra-pass-789');
});
