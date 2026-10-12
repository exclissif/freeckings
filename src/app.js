const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const bcrypt = require('bcryptjs');

const CATEGORIES = ['servidor', 'dominio', 'software', 'servicio', 'otro'];
const CURRENCIES = ['EUR', 'USD'];
const FREQUENCIES = ['once', 'monthly', 'yearly'];
const STATUSES = ['pending', 'paid'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function str(value, field, { required = false, max = 500 } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `Campo no válido: ${field}`);
  value = value.trim();
  if (required && !value) throw new HttpError(400, `Falta el campo: ${field}`);
  if (value.length > max) throw new HttpError(400, `Campo demasiado largo: ${field}`);
  return value;
}

function oneOf(value, field, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) throw new HttpError(400, `Campo no válido: ${field}`);
  return value;
}

function date(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, `Fecha no válida: ${field}`);
  }
  return value;
}

function id(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'No encontrado');
  return n;
}

function parseItem(body) {
  const amount = Number(body.amount);
  if (body.amount === '' || body.amount === null || !Number.isFinite(amount) || amount < 0) {
    throw new HttpError(400, 'Importe no válido');
  }
  const status = oneOf(body.status, 'estado', STATUSES, 'pending');
  return {
    concept: str(body.concept, 'concepto', { required: true, max: 200 }),
    category: oneOf(body.category, 'tipo', CATEGORIES, 'otro'),
    provider: str(body.provider, 'proveedor', { max: 200 }),
    amount: Math.round(amount * 100) / 100,
    currency: oneOf(body.currency, 'moneda', CURRENCIES, 'EUR'),
    frequency: oneOf(body.frequency, 'frecuencia', FREQUENCIES, 'once'),
    due_date: date(body.due_date, 'vencimiento'),
    status,
    paid_date: status === 'paid' ? date(body.paid_date, 'fecha de pago') : null,
    notes: str(body.notes, 'notas', { max: 2000 }),
  };
}

function createApp({ pool, sessionSecret, loginLimit = 10 }) {
  if (!sessionSecret) throw new Error('Falta SESSION_SECRET');

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  app.use(
    session({
      name: 'sid',
      store: new PgSession({ pool, createTableIfMissing: true }),
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 30 * 24 * 3600 * 1000 },
    })
  );

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  const api = express.Router();

  // Protección CSRF: las peticiones que modifican datos deben venir de la propia app.
  api.use((req, res, next) => {
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'fetch') {
      return next(new HttpError(403, 'Petición no permitida'));
    }
    next();
  });

  const loadUser = wrap(async (req, res, next) => {
    if (!req.session.userId) throw new HttpError(401, 'Inicia sesión');
    const { rows } = await pool.query('SELECT id, email, name, role FROM users WHERE id = $1', [
      req.session.userId,
    ]);
    if (!rows[0]) {
      req.session.destroy(() => {});
      throw new HttpError(401, 'Inicia sesión');
    }
    req.user = rows[0];
    next();
  });

  const adminOnly = (req, res, next) =>
    next(req.user.role === 'admin' ? undefined : new HttpError(403, 'Solo el administrador puede hacer esto'));

  // Proyectos visibles para el usuario actual: todos para el admin, los asignados para un socio.
  const visibleProjects = (user) =>
    user.role === 'admin'
      ? { sql: 'TRUE', params: [] }
      : {
          sql: 'p.id IN (SELECT project_id FROM project_members WHERE user_id = $1)',
          params: [user.id],
        };

  async function assertProjectVisible(user, projectId) {
    const v = visibleProjects(user);
    const { rows } = await pool.query(
      `SELECT p.id FROM projects p WHERE ${v.sql} AND p.id = $${v.params.length + 1}`,
      [...v.params, projectId]
    );
    if (!rows[0]) throw new HttpError(404, 'Proyecto no encontrado');
  }

  // --- Sesión ---

  api.post(
    '/login',
    rateLimit({ windowMs: 15 * 60 * 1000, limit: loginLimit, standardHeaders: true, legacyHeaders: false,
      message: { error: 'Demasiados intentos. Espera unos minutos.' } }),
    wrap(async (req, res) => {
      const email = str(req.body.email, 'email', { required: true }).toLowerCase();
      const password = typeof req.body.password === 'string' ? req.body.password : '';
      const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      const user = rows[0];
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        throw new HttpError(401, 'Email o contraseña incorrectos');
      }
      await new Promise((ok, fail) => req.session.regenerate((e) => (e ? fail(e) : ok())));
      req.session.userId = user.id;
      res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
    })
  );

  api.post('/logout', (req, res, next) => {
    req.session.destroy((e) => {
      if (e) return next(e);
      res.clearCookie('sid');
      res.json({ ok: true });
    });
  });

  api.use(loadUser);

  api.get('/me', (req, res) => res.json(req.user));

  api.post(
    '/me/password',
    wrap(async (req, res) => {
      const current = typeof req.body.current === 'string' ? req.body.current : '';
      const next = typeof req.body.next === 'string' ? req.body.next : '';
      if (next.length < MIN_PASSWORD) throw new HttpError(400, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`);
      const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
      if (!(await bcrypt.compare(current, rows[0].password_hash))) {
        throw new HttpError(400, 'La contraseña actual no es correcta');
      }
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(next, 12), req.user.id]);
      res.json({ ok: true });
    })
  );

  // --- Resumen ---

  api.get(
    '/summary',
    wrap(async (req, res) => {
      const v = visibleProjects(req.user);
      const { rows: projects } = await pool.query(
        `SELECT p.id, p.name, p.description FROM projects p WHERE ${v.sql} ORDER BY lower(p.name)`,
        v.params
      );
      const { rows: totals } = await pool.query(
        `SELECT i.project_id, i.currency, i.status, sum(i.amount)::numeric AS total, count(*)::int AS n,
                count(*) FILTER (WHERE i.status = 'pending' AND i.due_date < current_date)::int AS overdue
           FROM items i JOIN projects p ON p.id = i.project_id
          WHERE ${v.sql}
          GROUP BY i.project_id, i.currency, i.status`,
        v.params
      );
      const { rows: upcoming } = await pool.query(
        `SELECT i.id, i.project_id, p.name AS project_name, i.concept, i.category, i.amount, i.currency, i.due_date, i.status
           FROM items i JOIN projects p ON p.id = i.project_id
          WHERE ${v.sql} AND i.status = 'pending' AND i.due_date IS NOT NULL
            AND i.due_date <= current_date + 30
          ORDER BY i.due_date, i.id
          LIMIT 50`,
        v.params
      );

      const empty = () => ({ EUR: { paid: 0, pending: 0 }, USD: { paid: 0, pending: 0 } });
      const global = empty();
      let globalOverdue = 0;
      const byProject = new Map(projects.map((p) => [p.id, { ...p, totals: empty(), overdue: 0, items: 0 }]));
      for (const t of totals) {
        const p = byProject.get(t.project_id);
        if (!p) continue;
        p.totals[t.currency][t.status] += t.total;
        global[t.currency][t.status] += t.total;
        p.overdue += t.overdue;
        p.items += t.n;
        globalOverdue += t.overdue;
      }
      const round = (o) => {
        for (const c of CURRENCIES) for (const s of ['paid', 'pending']) o[c][s] = Math.round(o[c][s] * 100) / 100;
        return o;
      };
      res.json({
        totals: round(global),
        overdue: globalOverdue,
        projects: [...byProject.values()].map((p) => ({ ...p, totals: round(p.totals) })),
        upcoming,
      });
    })
  );

  // --- Proyectos ---

  api.get(
    '/projects',
    wrap(async (req, res) => {
      const v = visibleProjects(req.user);
      const { rows } = await pool.query(
        `SELECT p.id, p.name, p.description,
                COALESCE(array_agg(m.user_id ORDER BY m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS member_ids
           FROM projects p LEFT JOIN project_members m ON m.project_id = p.id
          WHERE ${v.sql}
          GROUP BY p.id ORDER BY lower(p.name)`,
        v.params
      );
      // Los socios no necesitan saber quién más tiene acceso.
      if (req.user.role !== 'admin') rows.forEach((r) => delete r.member_ids);
      res.json(rows);
    })
  );

  api.get(
    '/projects/:id',
    wrap(async (req, res) => {
      const projectId = id(req.params.id);
      await assertProjectVisible(req.user, projectId);
      const { rows } = await pool.query('SELECT id, name, description FROM projects WHERE id = $1', [projectId]);
      const { rows: items } = await pool.query(
        `SELECT * FROM items WHERE project_id = $1
          ORDER BY (status = 'paid'), due_date NULLS LAST, id`,
        [projectId]
      );
      res.json({ ...rows[0], items });
    })
  );

  async function setMembers(client, projectId, memberIds) {
    if (memberIds === undefined) return;
    if (!Array.isArray(memberIds) || !memberIds.every((m) => Number.isInteger(m) && m > 0)) {
      throw new HttpError(400, 'Lista de socios no válida');
    }
    await client.query('DELETE FROM project_members WHERE project_id = $1', [projectId]);
    if (memberIds.length) {
      await client.query(
        `INSERT INTO project_members (project_id, user_id)
         SELECT $1, u.id FROM users u WHERE u.id = ANY($2::int[]) AND u.role = 'partner'`,
        [projectId, memberIds]
      );
    }
  }

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  api.post(
    '/projects',
    adminOnly,
    wrap(async (req, res) => {
      const name = str(req.body.name, 'nombre', { required: true, max: 120 });
      const description = str(req.body.description, 'descripción', { max: 1000 });
      const project = await tx(async (c) => {
        const { rows } = await c.query(
          'INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id, name, description',
          [name, description]
        );
        await setMembers(c, rows[0].id, req.body.member_ids);
        return rows[0];
      });
      res.status(201).json(project);
    })
  );

  api.put(
    '/projects/:id',
    adminOnly,
    wrap(async (req, res) => {
      const projectId = id(req.params.id);
      const name = str(req.body.name, 'nombre', { required: true, max: 120 });
      const description = str(req.body.description, 'descripción', { max: 1000 });
      const project = await tx(async (c) => {
        const { rows } = await c.query(
          'UPDATE projects SET name = $1, description = $2 WHERE id = $3 RETURNING id, name, description',
          [name, description, projectId]
        );
        if (!rows[0]) throw new HttpError(404, 'Proyecto no encontrado');
        await setMembers(c, projectId, req.body.member_ids);
        return rows[0];
      });
      res.json(project);
    })
  );

  api.delete(
    '/projects/:id',
    adminOnly,
    wrap(async (req, res) => {
      const { rowCount } = await pool.query('DELETE FROM projects WHERE id = $1', [id(req.params.id)]);
      if (!rowCount) throw new HttpError(404, 'Proyecto no encontrado');
      res.json({ ok: true });
    })
  );

  // --- Pagos ---

  const ITEM_COLS = ['concept', 'category', 'provider', 'amount', 'currency', 'frequency', 'due_date', 'status', 'paid_date', 'notes'];

  api.post(
    '/projects/:id/items',
    adminOnly,
    wrap(async (req, res) => {
      const projectId = id(req.params.id);
      await assertProjectVisible(req.user, projectId);
      const item = parseItem(req.body);
      const { rows } = await pool.query(
        `INSERT INTO items (project_id, ${ITEM_COLS.join(', ')})
         VALUES ($1, ${ITEM_COLS.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
        [projectId, ...ITEM_COLS.map((k) => item[k])]
      );
      res.status(201).json(rows[0]);
    })
  );

  api.put(
    '/items/:id',
    adminOnly,
    wrap(async (req, res) => {
      const item = parseItem(req.body);
      const { rows } = await pool.query(
        `UPDATE items SET ${ITEM_COLS.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now()
          WHERE id = $${ITEM_COLS.length + 1} RETURNING *`,
        [...ITEM_COLS.map((k) => item[k]), id(req.params.id)]
      );
      if (!rows[0]) throw new HttpError(404, 'Pago no encontrado');
      res.json(rows[0]);
    })
  );

  api.delete(
    '/items/:id',
    adminOnly,
    wrap(async (req, res) => {
      const { rowCount } = await pool.query('DELETE FROM items WHERE id = $1', [id(req.params.id)]);
      if (!rowCount) throw new HttpError(404, 'Pago no encontrado');
      res.json({ ok: true });
    })
  );

  // Marca un pago como pagado. Si es recurrente, crea automáticamente el siguiente pendiente.
  api.post(
    '/items/:id/pay',
    adminOnly,
    wrap(async (req, res) => {
      const itemId = id(req.params.id);
      const paidDate = date(req.body.paid_date, 'fecha de pago');
      const result = await tx(async (c) => {
        const { rows } = await c.query(
          `UPDATE items SET status = 'paid', paid_date = COALESCE($1::date, current_date), updated_at = now()
            WHERE id = $2 AND status = 'pending' RETURNING *`,
          [paidDate, itemId]
        );
        const paid = rows[0];
        if (!paid) throw new HttpError(404, 'Pago pendiente no encontrado');
        let next = null;
        if (paid.frequency !== 'once') {
          const step = paid.frequency === 'monthly' ? '1 month' : '1 year';
          const { rows: created } = await c.query(
            `INSERT INTO items (project_id, concept, category, provider, amount, currency, frequency, due_date, status, notes)
             SELECT project_id, concept, category, provider, amount, currency, frequency,
                    (COALESCE(due_date, paid_date) + $2::interval)::date, 'pending', notes
               FROM items WHERE id = $1 RETURNING *`,
            [itemId, step]
          );
          next = created[0];
        }
        return { paid, next };
      });
      res.json(result);
    })
  );

  // --- Usuarios (socios) ---

  api.get(
    '/users',
    adminOnly,
    wrap(async (req, res) => {
      const { rows } = await pool.query(
        `SELECT u.id, u.email, u.name, u.role,
                COALESCE(array_agg(m.project_id ORDER BY m.project_id) FILTER (WHERE m.project_id IS NOT NULL), '{}') AS project_ids
           FROM users u LEFT JOIN project_members m ON m.user_id = u.id
          GROUP BY u.id ORDER BY u.role, lower(u.name)`
      );
      res.json(rows);
    })
  );

  function parsePassword(value, required) {
    if ((value === undefined || value === '') && !required) return null;
    if (typeof value !== 'string' || value.length < MIN_PASSWORD) {
      throw new HttpError(400, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`);
    }
    return value;
  }

  function parseEmail(value) {
    const email = str(value, 'email', { required: true, max: 200 }).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Email no válido');
    return email;
  }

  api.post(
    '/users',
    adminOnly,
    wrap(async (req, res) => {
      const email = parseEmail(req.body.email);
      const name = str(req.body.name, 'nombre', { required: true, max: 120 });
      const password = parsePassword(req.body.password, true);
      const hash = await bcrypt.hash(password, 12);
      try {
        const { rows } = await pool.query(
          "INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'partner') RETURNING id, email, name, role",
          [email, name, hash]
        );
        res.status(201).json(rows[0]);
      } catch (e) {
        if (e.code === '23505') throw new HttpError(409, 'Ya existe un usuario con ese email');
        throw e;
      }
    })
  );

  api.put(
    '/users/:id',
    adminOnly,
    wrap(async (req, res) => {
      const userId = id(req.params.id);
      const email = parseEmail(req.body.email);
      const name = str(req.body.name, 'nombre', { required: true, max: 120 });
      const password = parsePassword(req.body.password, false);
      const hash = password ? await bcrypt.hash(password, 12) : null;
      try {
        const { rows } = await pool.query(
          `UPDATE users SET email = $1, name = $2, password_hash = COALESCE($3, password_hash)
            WHERE id = $4 RETURNING id, email, name, role`,
          [email, name, hash, userId]
        );
        if (!rows[0]) throw new HttpError(404, 'Usuario no encontrado');
        if (hash && userId !== req.user.id) {
          // Cierra las sesiones abiertas de ese usuario al cambiarle la contraseña.
          await pool.query(`DELETE FROM session WHERE (sess->>'userId')::int = $1`, [userId]);
        }
        res.json(rows[0]);
      } catch (e) {
        if (e.code === '23505') throw new HttpError(409, 'Ya existe un usuario con ese email');
        throw e;
      }
    })
  );

  api.delete(
    '/users/:id',
    adminOnly,
    wrap(async (req, res) => {
      const userId = id(req.params.id);
      if (userId === req.user.id) throw new HttpError(400, 'No puedes borrar tu propio usuario');
      const { rowCount } = await pool.query("DELETE FROM users WHERE id = $1 AND role = 'partner'", [userId]);
      if (!rowCount) throw new HttpError(404, 'Socio no encontrado');
      await pool.query(`DELETE FROM session WHERE (sess->>'userId')::int = $1`, [userId]);
      res.json({ ok: true });
    })
  );

  api.use((req, res, next) => next(new HttpError(404, 'No encontrado')));

  app.use('/api', api);

  // Cualquier otra ruta devuelve la app (navegación del lado del cliente).
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON no válido' });
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  });

  return app;
}

module.exports = { createApp };
