const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');

// Devolver DATE como 'YYYY-MM-DD' y NUMERIC como número, sin conversiones de zona horaria.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => Number(v));

function createPool(connectionString) {
  return new Pool({ connectionString });
}

async function migrate(pool) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// Crea el administrador inicial solo si todavía no existe ningún usuario.
async function ensureAdmin(pool, { email, password, name }) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return false;
  if (!email || !password) {
    throw new Error('No hay usuarios: define ADMIN_EMAIL y ADMIN_PASSWORD para crear el administrador.');
  }
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    "INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'admin')",
    [email.trim().toLowerCase(), name || 'Administrador', hash]
  );
  return true;
}

module.exports = { createPool, migrate, ensureAdmin };
