'use strict';

const CATEGORIES = { servidor: 'Servidor', dominio: 'Dominio', software: 'Software', servicio: 'Servicio', otro: 'Otro' };
const FREQUENCIES = { once: 'Pago único', monthly: 'Mensual', yearly: 'Anual' };
const CURRENCIES = ['EUR', 'USD'];

const state = { me: null, filter: 'all' };
const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');
const dialog = $('#dialog');

// --- Utilidades ---

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const moneyFormats = {};
function money(amount, currency) {
  moneyFormats[currency] ??= new Intl.NumberFormat('es-ES', { style: 'currency', currency });
  return moneyFormats[currency].format(amount || 0);
}

function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const isOverdue = (item) => item.status === 'pending' && item.due_date && item.due_date < today();
const isAdmin = () => state.me?.role === 'admin';

async function api(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/login') {
    state.me = null;
    renderLogin();
    throw new Error(data.error || 'Inicia sesión');
  }
  if (!res.ok) throw new Error(data.error || 'Algo ha fallado');
  return data;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// Abre un formulario en el diálogo. onSubmit recibe los datos; si lanza un error, se muestra en el formulario.
function openForm(html, onSubmit, onReady) {
  dialog.innerHTML = `<form method="dialog" novalidate>${html}<p class="error" id="form-error"></p>
    <div class="dialog-actions"><button type="button" class="btn" data-close>Cancelar</button>
    <button type="submit" class="btn primary">Guardar</button></div></form>`;
  const form = $('form', dialog);
  $('[data-close]', form).onclick = () => dialog.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const submit = $('[type=submit]', form);
    submit.disabled = true;
    try {
      await onSubmit(new FormData(form), form);
      dialog.close();
    } catch (err) {
      $('#form-error', form).textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  };
  onReady?.(form);
  dialog.showModal();
}

// --- Navegación ---

function setNav(active) {
  $('#topbar').hidden = false;
  const links = [['#/', 'Resumen', 'home']];
  if (isAdmin()) links.push(['#/socios', 'Socios', 'users']);
  links.push(['#/cuenta', 'Mi cuenta', 'account']);
  $('#nav').innerHTML = links
    .map(([href, label, key]) => `<a href="${href}" class="${key === active ? 'active' : ''}">${label}</a>`)
    .join('');
}

async function route() {
  if (!state.me) {
    try {
      state.me = await api('GET', '/me');
    } catch {
      return;
    }
  }
  const hash = location.hash || '#/';
  try {
    let m;
    if ((m = hash.match(/^#\/p\/(\d+)$/))) return await renderProject(Number(m[1]));
    if (hash === '#/socios' && isAdmin()) return await renderUsers();
    if (hash === '#/cuenta') return renderAccount();
    return await renderSummary();
  } catch (err) {
    main.innerHTML = `<div class="card empty">${esc(err.message)}<br><br><a href="#/">Volver al resumen</a></div>`;
  }
}

window.addEventListener('hashchange', route);

// --- Login ---

function renderLogin() {
  $('#topbar').hidden = true;
  dialog.open && dialog.close();
  main.innerHTML = `
    <form class="card login" id="login-form">
      <h1>Pagos de proyectos</h1>
      <div class="field"><label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Contraseña</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required></div>
      <p class="error" id="login-error"></p>
      <button class="btn primary" type="submit">Entrar</button>
    </form>`;
  const form = $('#login-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    try {
      state.me = await api('POST', '/login', { email: data.get('email'), password: data.get('password') });
      route();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  };
}

// --- Resumen ---

function moneyBlock(totals) {
  const rows = CURRENCIES.filter((c) => totals[c].paid || totals[c].pending);
  if (!rows.length) return '<p class="muted">Sin pagos todavía</p>';
  return rows
    .map((c) => {
      const { paid, pending } = totals[c];
      const pct = paid + pending ? (paid / (paid + pending)) * 100 : 0;
      return `<div class="money">
        <div class="money-row"><span class="cur">${c}</span><span class="muted">${Math.round(pct)}% pagado</span></div>
        <div class="bar" role="img" aria-label="${Math.round(pct)}% pagado en ${c}">
          <span class="paid" style="width:${pct}%"></span></div>
        <div class="money-row num"><span>Pagado ${money(paid, c)}</span><span>Pendiente <strong>${money(pending, c)}</strong></span></div>
      </div>`;
    })
    .join('');
}

async function renderSummary() {
  setNav('home');
  const s = await api('GET', '/summary');
  const kpis = CURRENCIES.filter((c) => c === 'EUR' || s.totals[c].paid || s.totals[c].pending)
    .flatMap((c) => [
      `<div class="card kpi"><div class="label">Pendiente ${c}</div><div class="value num">${money(s.totals[c].pending, c)}</div></div>`,
      `<div class="card kpi"><div class="label">Pagado ${c}</div><div class="value num">${money(s.totals[c].paid, c)}</div></div>`,
    ]);
  if (s.overdue) {
    kpis.unshift(`<div class="card kpi alert"><div class="label">⚠ Vencidos</div>
      <div class="value">${s.overdue}</div><div class="sub">pagos fuera de plazo</div></div>`);
  }

  const projects = s.projects.length
    ? s.projects
        .map(
          (p) => `<a class="card project" href="#/p/${p.id}">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
            <h2>${esc(p.name)}</h2>
            ${p.overdue ? `<span class="badge overdue">⚠ ${p.overdue} vencido${p.overdue > 1 ? 's' : ''}</span>` : ''}
          </div>
          <p class="desc">${esc(p.description) || `${p.items} pago${p.items === 1 ? '' : 's'}`}</p>
          ${moneyBlock(p.totals)}
        </a>`
        )
        .join('')
    : `<div class="card empty">${isAdmin() ? 'Aún no hay proyectos. Crea el primero.' : 'Todavía no tienes proyectos asignados.'}</div>`;

  const upcoming = s.upcoming.length
    ? `<div class="card list">${s.upcoming
        .map(
          (i) => `<div class="row">
          <div><div class="title">${esc(i.concept)}</div>
            <div class="meta"><a href="#/p/${i.project_id}">${esc(i.project_name)}</a>
            <span>${CATEGORIES[i.category]}</span>
            ${isOverdue(i) ? `<span class="badge overdue">⚠ Vencido ${fmtDate(i.due_date)}</span>` : `<span>Vence ${fmtDate(i.due_date)}</span>`}</div></div>
          <div class="amount num">${money(i.amount, i.currency)}</div></div>`
        )
        .join('')}</div>`
    : '<div class="card empty">Nada pendiente en los próximos 30 días.</div>';

  main.innerHTML = `
    <div class="page-head"><div><h1>Resumen</h1><p class="muted">Hola, ${esc(state.me.name)}</p></div>
      ${isAdmin() ? '<div class="actions"><button class="btn primary" id="new-project">+ Nuevo proyecto</button></div>' : ''}</div>
    <div class="kpis">${kpis.join('')}</div>
    <section class="section"><h2>Proyectos</h2>
      <div class="legend"><span><i class="l-paid"></i>Pagado</span><span><i class="l-pending"></i>Pendiente</span></div>
      <div class="projects" style="margin-top:10px">${projects}</div></section>
    <section class="section"><h2>Próximos 30 días y vencidos</h2>${upcoming}</section>`;
  $('#new-project')?.addEventListener('click', () => projectForm());
}

// --- Proyecto ---

async function projectForm(project) {
  const users = (await api('GET', '/users')).filter((u) => u.role === 'partner');
  const members = new Set(project?.member_ids || []);
  const checks = users.length
    ? users
        .map(
          (u) => `<label><input type="checkbox" name="member" value="${u.id}" ${members.has(u.id) ? 'checked' : ''}>
          ${esc(u.name)} <span class="muted">${esc(u.email)}</span></label>`
        )
        .join('')
    : '<p class="muted">Aún no has creado socios. Puedes hacerlo en «Socios».</p>';
  openForm(
    `<h2>${project ? 'Editar proyecto' : 'Nuevo proyecto'}</h2>
     <div class="field"><label for="p-name">Nombre</label><input id="p-name" name="name" required maxlength="120" value="${esc(project?.name)}"></div>
     <div class="field"><label for="p-desc">Descripción</label><input id="p-desc" name="description" maxlength="1000" value="${esc(project?.description)}"></div>
     <div class="field"><label>Socios con acceso</label><div class="checks">${checks}</div></div>`,
    async (data) => {
      const body = {
        name: data.get('name'),
        description: data.get('description'),
        member_ids: data.getAll('member').map(Number),
      };
      const saved = project ? await api('PUT', `/projects/${project.id}`, body) : await api('POST', '/projects', body);
      toast(project ? 'Proyecto guardado' : 'Proyecto creado');
      if (project) route();
      else location.hash = `#/p/${saved.id}`;
    }
  );
}

function itemForm(projectId, item) {
  const v = item || { category: 'servidor', currency: 'EUR', frequency: 'once', status: 'pending' };
  const opts = (map, sel) => Object.entries(map).map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${l}</option>`).join('');
  openForm(
    `<h2>${item ? 'Editar pago' : 'Nuevo pago'}</h2>
     <div class="field"><label for="i-concept">Concepto</label>
       <input id="i-concept" name="concept" required maxlength="200" value="${esc(v.concept)}" placeholder="p. ej. VPS producción"></div>
     <div class="grid2">
       <div class="field"><label for="i-cat">Tipo</label><select id="i-cat" name="category">${opts(CATEGORIES, v.category)}</select></div>
       <div class="field"><label for="i-prov">Proveedor</label><input id="i-prov" name="provider" maxlength="200" value="${esc(v.provider)}" placeholder="p. ej. Hetzner"></div>
       <div class="field"><label for="i-amount">Importe</label>
         <input id="i-amount" name="amount" type="number" inputmode="decimal" step="0.01" min="0" required value="${v.amount ?? ''}"></div>
       <div class="field"><label for="i-cur">Moneda</label><select id="i-cur" name="currency">${opts({ EUR: 'Euros (€)', USD: 'Dólares ($)' }, v.currency)}</select></div>
       <div class="field"><label for="i-freq">Frecuencia</label><select id="i-freq" name="frequency">${opts(FREQUENCIES, v.frequency)}</select></div>
       <div class="field"><label for="i-due">Vencimiento</label><input id="i-due" name="due_date" type="date" value="${v.due_date || ''}"></div>
       <div class="field"><label for="i-status">Estado</label><select id="i-status" name="status">${opts({ pending: 'Pendiente', paid: 'Pagado' }, v.status)}</select></div>
       <div class="field" id="paid-field"><label for="i-paid">Fecha de pago</label><input id="i-paid" name="paid_date" type="date" value="${v.paid_date || today()}"></div>
     </div>
     <div class="field"><label for="i-notes">Notas</label><textarea id="i-notes" name="notes" maxlength="2000">${esc(v.notes)}</textarea></div>`,
    async (data) => {
      const body = Object.fromEntries(data.entries());
      if (item) await api('PUT', `/items/${item.id}`, body);
      else await api('POST', `/projects/${projectId}/items`, body);
      toast(item ? 'Pago guardado' : 'Pago añadido');
      route();
    },
    (form) => {
      const sync = () => ($('#paid-field', form).hidden = form.status.value !== 'paid');
      form.status.onchange = sync;
      sync();
    }
  );
}

function payForm(item) {
  const recurring = item.frequency !== 'once';
  openForm(
    `<h2>Marcar como pagado</h2>
     <p>${esc(item.concept)} · <strong>${money(item.amount, item.currency)}</strong></p>
     <div class="field"><label for="pay-date">Fecha de pago</label><input id="pay-date" name="paid_date" type="date" value="${today()}"></div>
     ${recurring ? `<p class="muted">Es un pago ${FREQUENCIES[item.frequency].toLowerCase()}: se creará automáticamente el siguiente como pendiente.</p>` : ''}`,
    async (data) => {
      const res = await api('POST', `/items/${item.id}/pay`, { paid_date: data.get('paid_date') });
      toast(res.next ? `Pagado. Siguiente: ${fmtDate(res.next.due_date)}` : 'Marcado como pagado');
      route();
    }
  );
}

async function renderProject(projectId) {
  setNav('home');
  const p = await api('GET', `/projects/${projectId}`);
  const totals = { EUR: { paid: 0, pending: 0 }, USD: { paid: 0, pending: 0 } };
  for (const i of p.items) totals[i.currency][i.status] += i.amount;

  const filters = { all: 'Todos', pending: 'Pendientes', paid: 'Pagados' };
  const items = p.items.filter((i) => state.filter === 'all' || i.status === state.filter);
  const byId = new Map(p.items.map((i) => [i.id, i]));

  const rows = items.length
    ? items
        .map((i) => {
          const status =
            i.status === 'paid'
              ? `<span class="badge paid">✓ Pagado ${fmtDate(i.paid_date)}</span>`
              : isOverdue(i)
                ? `<span class="badge overdue">⚠ Vencido ${fmtDate(i.due_date)}</span>`
                : `<span class="badge">Pendiente${i.due_date ? ` · vence ${fmtDate(i.due_date)}` : ''}</span>`;
          const actions = isAdmin()
            ? `<div class="row-actions">
                ${i.status === 'pending' ? `<button class="btn small" data-pay="${i.id}">Marcar pagado</button>` : ''}
                <button class="btn small" data-edit="${i.id}">Editar</button>
                <button class="btn small danger" data-del="${i.id}">Borrar</button></div>`
            : '';
          return `<div class="row ${i.status === 'paid' ? 'is-paid' : ''}">
            <div><div class="title">${esc(i.concept)}</div>
              <div class="meta"><span>${CATEGORIES[i.category]}</span>${i.provider ? `<span>${esc(i.provider)}</span>` : ''}
                <span>${FREQUENCIES[i.frequency]}</span>${status}</div>
              ${i.notes ? `<div class="meta">${esc(i.notes)}</div>` : ''}</div>
            <div class="amount num">${money(i.amount, i.currency)}</div>${actions}</div>`;
        })
        .join('')
    : `<div class="empty">${p.items.length ? 'No hay pagos con este filtro.' : 'Este proyecto aún no tiene pagos.'}</div>`;

  main.innerHTML = `
    <a class="back" href="#/">← Resumen</a>
    <div class="page-head"><div><h1>${esc(p.name)}</h1>${p.description ? `<p class="muted">${esc(p.description)}</p>` : ''}</div>
      ${isAdmin() ? `<div class="actions">
        <button class="btn primary" id="add-item">+ Añadir pago</button>
        <button class="btn" id="edit-project">Editar</button>
        <button class="btn danger" id="del-project">Borrar</button></div>` : ''}</div>
    <div class="card">${moneyBlock(totals)}
      <div class="legend"><span><i class="l-paid"></i>Pagado</span><span><i class="l-pending"></i>Pendiente</span></div></div>
    <section class="section"><h2 style="margin-bottom:10px">Pagos</h2>
      <div class="filters">${Object.entries(filters)
        .map(([k, l]) => `<button class="chip" data-filter="${k}" aria-pressed="${state.filter === k}">${l}</button>`)
        .join('')}</div>
      <div class="card list">${rows}</div></section>`;

  main.querySelectorAll('[data-filter]').forEach((b) => (b.onclick = () => { state.filter = b.dataset.filter; route(); }));
  main.querySelectorAll('[data-pay]').forEach((b) => (b.onclick = () => payForm(byId.get(Number(b.dataset.pay)))));
  main.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => itemForm(p.id, byId.get(Number(b.dataset.edit)))));
  main.querySelectorAll('[data-del]').forEach(
    (b) =>
      (b.onclick = async () => {
        const item = byId.get(Number(b.dataset.del));
        if (!confirm(`¿Borrar «${item.concept}»?`)) return;
        try {
          await api('DELETE', `/items/${item.id}`);
          toast('Pago borrado');
          route();
        } catch (e) {
          toast(e.message);
        }
      })
  );
  $('#add-item')?.addEventListener('click', () => itemForm(p.id));
  $('#edit-project')?.addEventListener('click', async () => {
    const all = await api('GET', '/projects');
    projectForm(all.find((x) => x.id === p.id));
  });
  $('#del-project')?.addEventListener('click', async () => {
    if (!confirm(`¿Borrar el proyecto «${p.name}» y todos sus pagos? No se puede deshacer.`)) return;
    try {
      await api('DELETE', `/projects/${p.id}`);
      toast('Proyecto borrado');
      location.hash = '#/';
    } catch (e) {
      toast(e.message);
    }
  });
}

// --- Socios ---

function userForm(user) {
  openForm(
    `<h2>${user ? 'Editar socio' : 'Nuevo socio'}</h2>
     <div class="field"><label for="u-name">Nombre</label><input id="u-name" name="name" required maxlength="120" value="${esc(user?.name)}"></div>
     <div class="field"><label for="u-email">Email</label><input id="u-email" name="email" type="email" required value="${esc(user?.email)}"></div>
     <div class="field"><label for="u-pass">${user ? 'Nueva contraseña (déjala vacía para no cambiarla)' : 'Contraseña inicial'}</label>
       <input id="u-pass" name="password" type="text" autocomplete="new-password" minlength="8" ${user ? '' : 'required'}></div>
     <p class="muted">Pásale el email y la contraseña al socio. Podrá cambiarla desde «Mi cuenta». Los proyectos que ve se eligen al editar cada proyecto.</p>`,
    async (data) => {
      const body = Object.fromEntries(data.entries());
      if (user) await api('PUT', `/users/${user.id}`, body);
      else await api('POST', '/users', body);
      toast(user ? 'Socio guardado' : 'Socio creado');
      route();
    }
  );
}

async function renderUsers() {
  setNav('users');
  const [users, projects] = await Promise.all([api('GET', '/users'), api('GET', '/projects')]);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const byId = new Map(users.map((u) => [u.id, u]));
  const rows = users
    .map((u) => {
      const access =
        u.role === 'admin'
          ? '<span class="badge">Administrador · ve todo</span>'
          : u.project_ids.length
            ? u.project_ids.map((id) => `<span class="badge">${esc(names.get(id))}</span>`).join('')
            : '<span class="muted">Sin proyectos asignados</span>';
      return `<div class="row"><div><div class="title">${esc(u.name)}</div>
          <div class="meta"><span>${esc(u.email)}</span></div><div class="meta" style="margin-top:4px">${access}</div></div>
          <div></div>
          ${u.role === 'partner' ? `<div class="row-actions"><button class="btn small" data-edit="${u.id}">Editar</button>
            <button class="btn small danger" data-del="${u.id}">Borrar</button></div>` : ''}</div>`;
    })
    .join('');
  main.innerHTML = `
    <div class="page-head"><div><h1>Socios</h1><p class="muted">Cada socio solo ve los proyectos a los que le des acceso.</p></div>
      <div class="actions"><button class="btn primary" id="new-user">+ Nuevo socio</button></div></div>
    <div class="card list">${rows}</div>`;
  $('#new-user').onclick = () => userForm();
  main.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => userForm(byId.get(Number(b.dataset.edit)))));
  main.querySelectorAll('[data-del]').forEach(
    (b) =>
      (b.onclick = async () => {
        const u = byId.get(Number(b.dataset.del));
        if (!confirm(`¿Borrar a ${u.name}? Perderá el acceso a todos los proyectos.`)) return;
        try {
          await api('DELETE', `/users/${u.id}`);
          toast('Socio borrado');
          route();
        } catch (e) {
          toast(e.message);
        }
      })
  );
}

// --- Mi cuenta ---

function renderAccount() {
  setNav('account');
  main.innerHTML = `
    <div class="page-head"><div><h1>Mi cuenta</h1><p class="muted">${esc(state.me.name)} · ${esc(state.me.email)}</p></div>
      <div class="actions"><button class="btn" id="logout">Cerrar sesión</button></div></div>
    <form class="card" id="pass-form" style="max-width:420px">
      <h2 style="margin-bottom:12px">Cambiar contraseña</h2>
      <div class="field"><label for="cur">Contraseña actual</label><input id="cur" name="current" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="new">Nueva contraseña (mínimo 8 caracteres)</label><input id="new" name="next" type="password" autocomplete="new-password" minlength="8" required></div>
      <p class="error" id="pass-error"></p>
      <button class="btn primary" type="submit">Cambiar contraseña</button>
    </form>`;
  $('#logout').onclick = async () => {
    await api('POST', '/logout').catch(() => {});
    state.me = null;
    location.hash = '#/';
    renderLogin();
  };
  const form = $('#pass-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    try {
      await api('POST', '/me/password', { current: data.get('current'), next: data.get('next') });
      form.reset();
      $('#pass-error').textContent = '';
      toast('Contraseña cambiada');
    } catch (err) {
      $('#pass-error').textContent = err.message;
    }
  };
}

// --- Arranque ---

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
route();
