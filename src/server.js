const { createPool, migrate, ensureAdmin } = require('./db');
const { createApp } = require('./app');

async function main() {
  const pool = createPool(process.env.DATABASE_URL);
  await migrate(pool);
  const created = await ensureAdmin(pool, {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
    name: process.env.ADMIN_NAME,
  });
  if (created) console.log(`Administrador creado: ${process.env.ADMIN_EMAIL}`);

  const app = createApp({ pool, sessionSecret: process.env.SESSION_SECRET });
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Escuchando en el puerto ${port}`));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
