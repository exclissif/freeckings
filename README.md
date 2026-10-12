# Pagos de proyectos

Panel para ver de un vistazo lo pagado y lo pendiente en cada proyecto (servidores, dominios, software…), en euros y dólares.

- **Administrador:** crea proyectos, añade, edita y borra pagos y da de alta a los socios.
- **Socios:** solo ven los proyectos a los que el administrador les da acceso, y no pueden modificar nada. El servidor aplica este control, no solo la pantalla.
- **Pagos recurrentes (mensual/anual):** al marcarlos como pagados se crea automáticamente el siguiente pago pendiente.
- **Móvil:** la web se adapta a la pantalla y se puede instalar como app.

Todo funciona en tu propio servidor: base de datos PostgreSQL, la aplicación (Node.js) y Caddy, que se encarga del HTTPS. Se instala con Docker.

---

## Instalación en AlmaLinux 8

Conéctate al servidor por SSH como `root` y sigue los pasos.

### 1. Instalar Docker

```bash
dnf -y install dnf-plugins-core git
dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin --allowerasing
systemctl enable --now docker
docker compose version
```

### 2. Abrir los puertos web

```bash
firewall-cmd --permanent --add-service=http --add-service=https
firewall-cmd --reload
```

Si `firewall-cmd` dice que firewalld no está activo, sáltate este paso.

### 3. Descargar la aplicación

```bash
cd /opt
git clone https://github.com/exclissif/freeckings.git pagos
cd pagos
```

Si el repositorio es privado, GitHub te pedirá tu usuario y un *token* de acceso: GitHub → Settings → Developer settings → Personal access tokens.

### 4. Configurar

```bash
cp .env.example .env
echo "DB_PASSWORD=$(openssl rand -hex 24)"
echo "SESSION_SECRET=$(openssl rand -hex 32)"
nano .env
```

Copia en `.env` los dos valores aleatorios que se acaban de imprimir y rellena:

- `ADMIN_EMAIL` y `ADMIN_PASSWORD`: tu usuario de administrador, con una contraseña de al menos 8 caracteres. Solo se usan la primera vez.
- `DOMAIN`: déjalo en `:80` para la primera prueba. En el paso 6 se explica cómo poner tu dominio.

### 5. Arrancar

```bash
docker compose up -d --build
docker compose logs app
```

Si en los logs aparecen «Administrador creado» y «Escuchando en el puerto 3000», ya está funcionando. Abre `http://IP-DEL-SERVIDOR` en el navegador y entra con tu email y contraseña.

Una vez dentro, puedes borrar `ADMIN_PASSWORD` de `.env`: ya no se vuelve a usar.

### 6. Poner tu dominio con HTTPS

1. En el panel DNS de tu dominio, crea un registro **A** para el subdominio (por ejemplo `panel`) que apunte a la IP del servidor.
2. Cuando el DNS ya resuelva (puedes comprobarlo con `ping panel.tudominio.com`), cambia `DOMAIN` en `.env`:
   ```
   DOMAIN=panel.tudominio.com
   ```
3. Reinicia:
   ```bash
   docker compose up -d
   ```

Caddy obtiene y renueva el certificado HTTPS automáticamente. A partir de ahí, entra siempre por `https://panel.tudominio.com`.

---

## Uso diario

### Instalar en el móvil

Abre la dirección del panel en el móvil e inicia sesión. Después:

- **iPhone (Safari):** botón Compartir → «Añadir a pantalla de inicio».
- **Android (Chrome):** menú ⋮ → «Instalar aplicación» o «Añadir a pantalla de inicio».

Desde ese momento se abre como una app, a pantalla completa y con su icono.

### Dar acceso a un socio

1. En **Socios**, pulsa «Nuevo socio» e introduce su nombre, su email y una contraseña inicial.
2. Abre el proyecto, pulsa **Editar** y marca qué socios tienen acceso.
3. Pásale al socio la dirección del panel, su email y la contraseña. Podrá cambiarla desde «Mi cuenta».

Para quitarle el acceso, desmárcalo en el proyecto. Si cambias la contraseña de un socio o lo borras, se cierran sus sesiones abiertas.

---

## Mantenimiento

### Actualizar a una nueva versión

```bash
cd /opt/pagos
git pull
docker compose up -d --build
```

### Copias de seguridad

Para hacer una copia manual:

```bash
cd /opt/pagos && mkdir -p backups
docker compose exec -T db pg_dump -U pagos pagos | gzip > backups/pagos-$(date +%F).sql.gz
```

Para hacerla automáticamente cada noche a las 3:00 y conservar 30 días, ejecuta `crontab -e` y añade:

```
0 3 * * * cd /opt/pagos && docker compose exec -T db pg_dump -U pagos pagos | gzip > backups/pagos-$(date +\%F).sql.gz && find backups -name '*.sql.gz' -mtime +30 -delete
```

Para restaurar una copia (esto sustituye los datos actuales):

```bash
docker compose exec -T db psql -U pagos -d postgres -c "DROP DATABASE pagos WITH (FORCE)" -c "CREATE DATABASE pagos OWNER pagos"
gunzip -c backups/pagos-AAAA-MM-DD.sql.gz | docker compose exec -T db psql -U pagos pagos
docker compose restart app
```

Conviene copiar también la carpeta `backups` a otro sitio fuera del servidor.

---

## Desarrollo

Necesitas Node.js 20 o superior y PostgreSQL.

```bash
npm install
DATABASE_URL=postgres://usuario:clave@localhost/pagos SESSION_SECRET=dev \
ADMIN_EMAIL=admin@ejemplo.com ADMIN_PASSWORD=cambiame123 npm start
```

Las pruebas usan una base de datos aparte, que se borra en cada ejecución:

```bash
TEST_DATABASE_URL=postgres://usuario:clave@localhost/pagos_test npm test
```
