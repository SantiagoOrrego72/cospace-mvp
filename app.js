/* CoSpace – interfaz de usuario */
(function () {
  "use strict";
  const C = window.CoSpace;
  const KEY = "cospace_mvp_v2";
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let S = null;          // estado persistido
  let session = null;    // id de usuario
  let view = { name: "login" };
  const ui = { filters: { type: "", minCapacity: 0, date: "", text: "" }, tab: "todas", sel: { date: "", hours: [] }, report: null };
  let memoryStore = null;

  /* ---------- Conexión con el servidor (API + base de datos SQLite) ---------- */
  const TOKEN_KEY = "cospace_token";
  let token = null, user = null, pub = { activeSpaces: 0 }, offline = false;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { token = null; }
  function setToken(t) { token = t; try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) { /* sin almacenamiento */ } }

  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, { method, headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      offline = true; render();
      return { ok: false, status: 0, data: { error: "No se pudo conectar con el servidor." } };
    }
    offline = false;
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (res.status === 401 && token && url !== "/api/login") { setToken(null); session = null; user = null; S = null; toast(data.error || "Tu sesión terminó.", "bad"); go("login"); }
    return { ok: res.ok, status: res.status, data };
  }

  async function refresh() {
    const r = await api("GET", "/api/datos");
    if (!r.ok) return false;
    user = r.data.user; session = user.id;
    S = { users: [], spaces: r.data.spaces, reservations: r.data.reservations, seq: 0 };
    return true;
  }

  function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return C.toDateStr(d); }

  const me = () => user;
  const spaceById = (id) => S.spaces.find((s) => s.id === id);

  /* ---------- Navegación ---------- */
  function go(name, params = {}) {
    view = Object.assign({ name }, params);
    if (name === "reserve") ui.sel = { date: params.date || ui.filters.date || C.toDateStr(new Date()), hours: [] };
    render();
    window.scrollTo(0, 0);
  }

  function toast(msg, kind = "ok") {
    const t = document.createElement("div");
    t.className = "toast " + kind;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add("show"), 10);
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3200);
  }

  function modal(html, onMount) {
    const wrap = document.createElement("div");
    wrap.className = "modal-bg";
    wrap.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + html + "</div>";
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("[data-close]")) close(); });
    onMount && onMount(wrap, close);
    const f = wrap.querySelector("input,select,button.primary"); f && f.focus();
  }

  /* ---------- Componentes ---------- */
  const logo = () => '<button class="logo" data-go="catalog" aria-label="Ir al catálogo"><span class="mark">C</span>CoSpace</button>';
  function nav() {
    const u = me();
    const item = (key, label) => '<button class="nav-item' + (view.name === key || (key === "catalog" && ["detail", "reserve", "confirm"].includes(view.name)) ? " active" : "") + '" data-go="' + key + '">' + label + "</button>";
    const initials = u.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    return '<header class="top">' + logo() + '<nav>' + item("catalog", "Espacios") + item("mine", "Mis reservas") + (u.role === "admin" ? item("admin", "Administración") : "") + "</nav>" +
      '<div class="user"><span>' + esc(u.name.split(" ").slice(0, 2).join(" ")) + '</span><span class="avatar">' + esc(initials) + '</span><button class="link" data-action="logout">Salir</button></div></header>';
  }
  const photo = (tone, cls = "") => '<div class="photo ' + cls + '" style="background:' + esc(tone) + '"><svg viewBox="0 0 80 50" aria-hidden="true"><path d="M6 44 L30 18 L46 34 L56 24 L74 44 Z" fill="#fff" opacity=".75"/><circle cx="58" cy="12" r="7" fill="#fff" opacity=".75"/></svg></div>';
  const field = (name, label, type = "text", value = "", extra = "") => '<label class="field"><span>' + label + '</span><input name="' + name + '" type="' + type + '" value="' + esc(value) + '" ' + extra + '><em class="err" data-err="' + name + '"></em></label>';
  const chip = (txt, cls = "") => '<span class="chip ' + cls + '">' + esc(txt) + "</span>";
  const stateChip = (st) => chip(st[0].toUpperCase() + st.slice(1), st);
  function showErrors(form, errors) {
    form.querySelectorAll("[data-err]").forEach((e) => { e.textContent = errors[e.dataset.err] || ""; });
    form.querySelectorAll("input,select,textarea").forEach((i) => i.classList.toggle("invalid", !!errors[i.name]));
  }
  function niceDate(d) {
    const dt = C.slotStart(d, 12);
    const s = dt.toLocaleDateString("es-CO", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    return s.charAt(0).toUpperCase() + s.slice(1).replace(/\./g, "");
  }
  const range = (a, b) => C.hourLabel(a) + " – " + C.hourLabel(b);

  /* ---------- Vistas ---------- */
  function authShell(inner) {
    return '<div class="auth"><aside><div class="brand"><span class="mark light">C</span>CoSpace</div><div class="pitch"><h1>Tu espacio de trabajo,<br>a un clic de distancia.</h1><p>Reserva escritorios, oficinas y salas de reunión por hora, sin llamadas ni cruces de horario.</p></div>' +
      '<div class="stats"><div><b>' + pub.activeSpaces + '</b><span>espacios</span></div><div><b>8 h</b><span>a 20 h</span></div><div><b>24/7</b><span>reservas en línea</span></div></div></aside><main class="auth-main">' + inner + "</main></div>";
  }

  function vLogin() {
    return authShell('<form class="auth-form" data-form="login" novalidate><h2>Bienvenido de nuevo</h2><p class="muted">Ingresa para ver y gestionar tus reservas.</p>' +
      field("email", "Correo electrónico", "email", "", 'autocomplete="username" placeholder="nombre@correo.com"') + field("password", "Contraseña", "password", "", 'autocomplete="current-password" placeholder="••••••••"') +
      '<div class="alert hidden" data-alert></div><button class="btn primary block" type="submit">Ingresar</button><p class="center muted">¿No tienes cuenta? <button type="button" class="link" data-go="register">Regístrate</button></p>' +
      '<div class="demo"><b>Cuentas de demostración</b><button type="button" class="demo-acc" data-demo="santiago@correo.com|Demo2026">Usuario: santiago@correo.com · Demo2026</button><button type="button" class="demo-acc" data-demo="admin@cospace.co|Admin2026">Administrador: admin@cospace.co · Admin2026</button></div></form>');
  }

  function vRegister() {
    return authShell('<form class="auth-form" data-form="register" novalidate><h2>Crea tu cuenta</h2><p class="muted">Regístrate para empezar a reservar espacios.</p>' +
      field("name", "Nombre completo", "text", "", 'autocomplete="name" placeholder="Ej. Santiago Orrego"') + field("email", "Correo electrónico", "email", "", 'autocomplete="email" placeholder="nombre@correo.com"') +
      field("password", "Contraseña", "password", "", 'autocomplete="new-password" placeholder="Mínimo 8 caracteres, letras y números"') + field("confirm", "Confirmar contraseña", "password", "", 'autocomplete="new-password"') +
      '<button class="btn primary block" type="submit">Crear cuenta</button><p class="center muted">¿Ya tienes cuenta? <button type="button" class="link" data-go="login">Inicia sesión</button></p></form>');
  }

  function vCatalog() {
    const f = ui.filters;
    const list = C.filterSpaces(S, f, new Date());
    const types = ["", ...C.TYPES];
    const cards = list.map((s) => {
      let avail = "";
      if (f.date) avail = s.freeCount > 0 ? chip(s.freeCount + " h libres", "free") : chip("Sin cupo ese día", "busy");
      else avail = chip("Disponible", "free");
      return '<article class="card"><button class="card-hit" data-go="detail" data-id="' + s.id + '" aria-label="Ver ' + esc(s.name) + '"></button>' + photo(s.tone) + '<div class="card-tag">' + avail + '</div><div class="card-body"><h3>' + esc(s.name) + '</h3><p class="muted">' + esc(s.type) + " · " + s.capacity + (s.capacity === 1 ? " persona" : " personas") + '</p><div class="card-foot"><b>' + C.money(s.price) + ' / h</b><button class="btn ghost sm" data-go="detail" data-id="' + s.id + '">Ver detalle</button></div></div></article>';
    }).join("");
    return nav() + '<main class="page"><div class="page-head"><div><h1>Espacios disponibles</h1><p class="muted">Elige un espacio y reserva por horas.</p></div></div>' +
      '<div class="filters"><div class="chips">' + types.map((t) => '<button class="pill' + (f.type === t ? " on" : "") + '" data-type="' + esc(t) + '">' + (t || "Todos") + "</button>").join("") + "</div>" +
      '<div class="filter-inputs"><input type="search" placeholder="Buscar por nombre o ubicación" data-filter="text" value="' + esc(f.text) + '" aria-label="Buscar"><select data-filter="minCapacity" aria-label="Capacidad"><option value="0">Cualquier capacidad</option>' + [2, 4, 8, 12].map((n) => '<option value="' + n + '"' + (+f.minCapacity === n ? " selected" : "") + ">" + n + "+ personas</option>").join("") +
      '</select><input type="date" data-filter="date" min="' + C.toDateStr(new Date()) + '" value="' + esc(f.date) + '" aria-label="Fecha">' + (f.type || f.text || +f.minCapacity || f.date ? '<button class="link" data-action="clear-filters">Limpiar filtros</button>' : "") + "</div></div>" +
      (list.length ? '<div class="grid">' + cards + "</div>" : '<div class="empty"><h3>No encontramos espacios con esos filtros</h3><p class="muted">Prueba con otro tipo de espacio, otra capacidad u otra fecha.</p><button class="btn ghost" data-action="clear-filters">Limpiar filtros</button></div>') + "</main>";
  }

  function vDetail() {
    const s = spaceById(view.id);
    if (!s || !s.active) return nav() + '<main class="page"><div class="empty"><h3>Este espacio ya no está disponible</h3><button class="btn ghost" data-go="catalog">Volver a espacios</button></div></main>';
    return nav() + '<main class="page"><p class="crumbs"><button class="link muted" data-go="catalog">Espacios</button> / ' + esc(s.name) + '</p><div class="detail"><div class="gallery">' + photo(s.tone, "big") + '<div class="thumbs">' + photo("#D6D2C6") + photo("#CCD3DA") + photo("#D3CCC5") + "</div></div>" +
      '<div class="info"><h1>' + esc(s.name) + '</h1><p class="muted">' + esc(s.type) + (s.location ? " · " + esc(s.location) : "") + "</p>" + chip("Hasta " + s.capacity + (s.capacity === 1 ? " persona" : " personas")) +
      '<p class="desc">' + esc(s.description || "Espacio de trabajo del coworking.") + '</p><h4>Servicios incluidos</h4><ul class="services">' + (s.services || []).map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" +
      '<p class="muted small">Horario: lunes a sábado, 8:00 a. m. – 8:00 p. m.</p><div class="price-box"><div><b class="price">' + C.money(s.price) + '</b> <span class="muted">por hora</span><p class="muted small">Cancelación gratis hasta ' + C.CANCEL_LIMIT_HOURS + ' h antes.</p></div><button class="btn primary" data-go="reserve" data-id="' + s.id + '">Reservar</button></div></div></div></main>';
  }

  function vReserve() {
    const s = spaceById(view.id);
    if (!s) return vCatalog();
    const now = new Date();
    const date = ui.sel.date;
    const busy = C.busyHours(S, s.id, date);
    const hs = ui.sel.hours;
    let slots = "";
    for (let h = C.OPEN_HOUR; h < C.CLOSE_HOUR; h++) {
      const past = C.slotStart(date, h) <= now;
      const cls = busy.has(h) ? "busy" : past ? "past" : hs.includes(h) ? "sel" : "";
      slots += '<button class="slot ' + cls + '" data-hour="' + h + '"' + (busy.has(h) || past ? " disabled" : "") + ' aria-pressed="' + hs.includes(h) + '">' + h + ":00</button>";
    }
    const total = hs.length * s.price;
    const sum = hs.length
      ? [["Espacio", esc(s.name)], ["Fecha", niceDate(date)], ["Horario", range(Math.min(...hs), Math.max(...hs) + 1)], ["Duración", hs.length + (hs.length === 1 ? " hora" : " horas")], ["Tarifa", C.money(s.price) + " / h"]]
      : [["Espacio", esc(s.name)], ["Fecha", niceDate(date)], ["Horario", '<span class="muted">Elige los bloques</span>']];
    const freeLeft = C.freeHours(S, s.id, date, now).length;
    return nav() + '<main class="page"><p class="crumbs"><button class="link muted" data-go="detail" data-id="' + s.id + '">' + esc(s.name) + '</button> / Reservar</p><h1>Reservar ' + esc(s.name) + '</h1><p class="muted">Elige fecha y uno o varios bloques consecutivos de una hora.</p>' +
      '<div class="reserve"><section class="panel"><h3>Fecha</h3><input type="date" data-action="pick-date" min="' + C.toDateStr(now) + '" value="' + esc(date) + '" aria-label="Fecha de la reserva"><div class="quick">' + [0, 1, 2].map((n) => '<button class="pill' + (addDays(n) === date ? " on" : "") + '" data-quick="' + addDays(n) + '">' + ["Hoy", "Mañana", "Pasado mañana"][n] + "</button>").join("") + "</div>" +
      '<p class="muted small">' + (freeLeft ? freeLeft + " bloques libres este día." : "No quedan bloques libres este día. Elige otra fecha.") + "</p></section>" +
      '<section class="panel"><h3>Horarios para ' + niceDate(date) + '</h3><p class="muted small">Los bloques ocupados o que ya pasaron no se pueden elegir.</p><div class="slots">' + slots + '</div><div class="legend"><span><i class="lg"></i>Disponible</span><span><i class="lg sel"></i>Seleccionado</span><span><i class="lg busy"></i>Ocupado</span></div></section>' +
      '<section class="panel summary"><h3>Resumen</h3>' + sum.map(([k, v]) => '<div class="row"><span class="muted">' + k + "</span><b>" + v + "</b></div>").join("") + '<div class="row total"><span>Total</span><b>' + C.money(total) + '</b></div><button class="btn primary block" data-action="confirm-reservation"' + (hs.length ? "" : " disabled") + ">Confirmar reserva</button></section></div></main>";
  }

  function vConfirm() {
    const r = S.reservations.find((x) => x.id === view.id);
    const s = spaceById(r.spaceId);
    return nav() + '<main class="page"><div class="confirm"><div class="ok-icon">✓</div><h1>¡Reserva confirmada!</h1><p class="muted">Guarda tu código; también lo verás en Mis reservas.</p><div class="code"><span>Código de reserva</span><b>' + esc(r.code) + "</b></div>" +
      [["Espacio", esc(s.name)], ["Fecha", niceDate(r.date)], ["Horario", range(r.start, r.end)], ["Total", C.money(r.total)]].map(([k, v]) => '<div class="row"><span class="muted">' + k + "</span><b>" + v + "</b></div>").join("") +
      '<div class="two"><button class="btn primary" data-go="mine">Ver mis reservas</button><button class="btn ghost" data-go="catalog">Volver a espacios</button></div></div></main>';
  }

  function vMine() {
    const now = new Date();
    const all = C.userReservations(S, session, "todas", now);
    const counts = { todas: all.length, activas: all.filter((r) => r.state === "activa").length, historial: all.filter((r) => r.state !== "activa").length };
    const list = C.userReservations(S, session, ui.tab, now);
    const rows = list.map((r) => {
      const s = spaceById(r.spaceId);
      const can = C.canCancel(r, now);
      return '<tr class="' + (r.state === "activa" ? "" : "dim") + '"><td>' + esc(r.code) + "</td><td><b>" + esc(s ? s.name : "—") + "</b></td><td>" + niceDate(r.date) + "</td><td>" + range(r.start, r.end) + "</td><td>" + C.money(r.total) + "</td><td>" + stateChip(r.state) + "</td><td>" +
        (r.state === "activa" ? (can ? '<button class="btn ghost sm" data-action="cancel" data-id="' + r.id + '">Cancelar</button>' : '<span class="muted small" title="Solo se puede cancelar hasta ' + C.CANCEL_LIMIT_HOURS + ' h antes">No cancelable</span>') : "") + "</td></tr>";
    }).join("");
    const tab = (k, l) => '<button class="tab' + (ui.tab === k ? " on" : "") + '" data-tab="' + k + '">' + l + " (" + counts[k] + ")</button>";
    return nav() + '<main class="page"><h1>Mis reservas</h1><p class="muted">Consulta tus reservas activas y tu historial.</p><div class="tabs">' + tab("todas", "Todas") + tab("activas", "Activas") + tab("historial", "Historial") + "</div>" +
      (list.length ? '<div class="table-wrap"><table><thead><tr><th>Código</th><th>Espacio</th><th>Fecha</th><th>Horario</th><th>Total</th><th>Estado</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>"
        : '<div class="empty"><h3>' + (ui.tab === "historial" ? "Aún no tienes reservas anteriores" : "No tienes reservas activas") + '</h3><button class="btn primary" data-go="catalog">Buscar un espacio</button></div>') + "</main>";
  }

  function vAdmin() {
    if (me().role !== "admin") return vCatalog();
    if (!ui.report) ui.report = { from: addDays(-7), to: addDays(7) };
    const rep = C.occupancyReport(S, ui.report.from, ui.report.to);
    const max = Math.max(1, ...rep.map((r) => r.occupancy));
    const totalIncome = rep.reduce((a, r) => a + r.income, 0), totalRes = rep.reduce((a, r) => a + r.reservations, 0);
    const avg = rep.length ? Math.round((rep.reduce((a, r) => a + r.occupancy, 0) / rep.length) * 10) / 10 : 0;
    const rows = S.spaces.map((s) => '<tr class="' + (s.active ? "" : "dim") + '"><td><b>' + esc(s.name) + "</b></td><td>" + esc(s.type) + "</td><td>" + s.capacity + "</td><td>" + C.money(s.price) + "</td><td>" + (s.active ? chip("Activo", "activa") : chip("Inactivo", "finalizada")) +
      '</td><td><div class="actions"><button class="btn ghost sm" data-action="edit-space" data-id="' + s.id + '">Editar</button><button class="btn ghost sm" data-action="toggle-space" data-id="' + s.id + '">' + (s.active ? "Desactivar" : "Activar") + "</button></div></td></tr>").join("");
    const bars = rep.map((r) => '<div class="bar-row"><span>' + esc(r.name) + '</span><div class="bar"><i style="width:' + (r.occupancy / max) * 100 + '%"></i></div><b>' + r.occupancy + " %</b><em>" + r.hours + " h · " + C.money(r.income) + "</em></div>").join("");
    return nav() + '<main class="page"><div class="page-head"><div><h1>Administración</h1><p class="muted">Gestiona los espacios del coworking y consulta su ocupación.</p></div><button class="btn primary" data-action="new-space">+ Nuevo espacio</button></div>' +
      '<div class="table-wrap"><table><thead><tr><th>Espacio</th><th>Tipo</th><th>Capacidad</th><th>Precio / h</th><th>Estado</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
      '<section class="panel report"><div class="page-head"><h3>Reporte de ocupación</h3><div class="filter-inputs"><label class="small muted">Desde <input type="date" data-report="from" value="' + ui.report.from + '"></label><label class="small muted">Hasta <input type="date" data-report="to" value="' + ui.report.to + '"></label></div></div>' +
      '<div class="kpis"><div><span class="muted small">Reservas</span><b>' + totalRes + '</b></div><div><span class="muted small">Ingresos</span><b>' + C.money(totalIncome) + '</b></div><div><span class="muted small">Ocupación promedio</span><b>' + avg + " %</b></div></div>" + bars + "</section>" +
      '<p class="muted small">Datos guardados en la base de datos local (cospace.db). <button class="link" data-action="reset">Restablecer datos de demostración</button></p></main>';
  }

  function spaceForm(s) {
    s = s || { name: "", type: C.TYPES[2], capacity: 4, price: 30000, location: "", description: "", services: [] };
    return '<form data-form="space" data-id="' + (s.id || "") + '" novalidate><h2>' + (s.id ? "Editar espacio" : "Nuevo espacio") + "</h2>" + field("name", "Nombre", "text", s.name) +
      '<label class="field"><span>Tipo</span><select name="type">' + C.TYPES.map((t) => "<option" + (t === s.type ? " selected" : "") + ">" + t + "</option>").join("") + '</select><em class="err" data-err="type"></em></label>' +
      '<div class="two">' + field("capacity", "Capacidad (personas)", "number", s.capacity, 'min="1" max="50"') + field("price", "Precio por hora (COP)", "number", s.price, 'min="1000" step="1000"') + "</div>" +
      field("location", "Ubicación", "text", s.location) + '<label class="field"><span>Descripción</span><textarea name="description" rows="2">' + esc(s.description) + "</textarea></label>" +
      field("services", "Servicios (separados por coma)", "text", (s.services || []).join(", ")) + '<div class="two"><button type="button" class="btn ghost" data-close>Cancelar</button><button class="btn primary" type="submit">Guardar</button></div></form>';
  }

  const VIEWS = { login: vLogin, register: vRegister, catalog: vCatalog, detail: vDetail, reserve: vReserve, confirm: vConfirm, mine: vMine, admin: vAdmin };

  function render() {
    if (!session && !["login", "register"].includes(view.name)) view = { name: "login" };
    if (session && ["login", "register"].includes(view.name)) view = { name: "catalog" };
    $("#app").innerHTML = (offline ? '<div class="offline">No hay conexión con el servidor. Inícielo con <b>python servidor.py</b> y recargue la página.</div>' : "") + VIEWS[view.name]();
    const t = { login: "Iniciar sesión", register: "Registro", catalog: "Espacios", detail: "Detalle", reserve: "Reservar", confirm: "Reserva confirmada", mine: "Mis reservas", admin: "Administración" }[view.name];
    document.title = t + " · CoSpace";
  }

  /* ---------- Eventos ---------- */
  document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-go],[data-action],[data-type],[data-tab],[data-hour],[data-quick],[data-demo]");
    if (!el || el.closest(".modal-bg")) return;
    if (el.dataset.go) return go(el.dataset.go, { id: el.dataset.id });
    if (el.dataset.demo) { const [em, pw] = el.dataset.demo.split("|"); const f = $('[data-form="login"]'); f.elements.namedItem("email").value = em; f.elements.namedItem("password").value = pw; return; }
    if (el.dataset.type !== undefined && el.classList.contains("pill")) { ui.filters.type = el.dataset.type; return render(); }
    if (el.dataset.tab) { ui.tab = el.dataset.tab; return render(); }
    if (el.dataset.quick) { ui.sel = { date: el.dataset.quick, hours: [] }; return render(); }
    if (el.dataset.hour) {
      const h = +el.dataset.hour, hs = ui.sel.hours;
      if (hs.includes(h)) ui.sel.hours = h === Math.min(...hs) || h === Math.max(...hs) ? hs.filter((x) => x !== h) : [h];
      else if (hs.length && (h === Math.min(...hs) - 1 || h === Math.max(...hs) + 1)) hs.push(h);
      else ui.sel.hours = [h];
      return render();
    }
    const a = el.dataset.action;
    if (a === "logout") { await api("POST", "/api/logout", {}); setToken(null); session = null; user = null; S = null; ui.filters = { type: "", minCapacity: 0, date: "", text: "" }; ui.tab = "todas"; ui.report = null; await loadPublic(); toast("Cerraste sesión."); return go("login"); }
    if (a === "clear-filters") { ui.filters = { type: "", minCapacity: 0, date: "", text: "" }; return render(); }
    if (a === "confirm-reservation") {
      el.disabled = true;
      const r = await api("POST", "/api/reservas", { spaceId: view.id, date: ui.sel.date, hours: ui.sel.hours });
      await refresh();
      if (!r.ok) { toast(r.data.error || "No se pudo reservar.", "bad"); ui.sel.hours = []; return render(); }
      return go("confirm", { id: r.data.id });
    }
    if (a === "cancel") {
      const r = S.reservations.find((x) => x.id === el.dataset.id), s = spaceById(r.spaceId);
      return modal('<h2>¿Cancelar esta reserva?</h2><p>' + esc(s.name) + " · " + niceDate(r.date) + " · " + range(r.start, r.end) + '</p><p class="muted small">El horario quedará libre para otras personas. Esta acción no se puede deshacer.</p><div class="two"><button class="btn ghost" data-close>Volver</button><button class="btn danger" data-yes>Sí, cancelar</button></div>', (w, close) => {
        w.querySelector("[data-yes]").onclick = async () => { close(); const res = await api("POST", "/api/reservas/" + r.id + "/cancelar", {}); await refresh(); if (res.ok) toast("Reserva " + r.code + " cancelada."); else toast(res.data.error || "No se pudo cancelar.", "bad"); render(); };
      });
    }
    if (a === "new-space" || a === "edit-space") {
      return modal(spaceForm(a === "edit-space" ? spaceById(el.dataset.id) : null), (w, close) => {
        const f = w.querySelector("form");
        f.onsubmit = async (ev) => {
          ev.preventDefault();
          const old = f.dataset.id ? spaceById(f.dataset.id) : null;
          const payload = { name: f.elements.namedItem("name").value, type: f.elements.namedItem("type").value, capacity: f.elements.namedItem("capacity").value, price: f.elements.namedItem("price").value, location: f.elements.namedItem("location").value, description: f.elements.namedItem("description").value, services: f.elements.namedItem("services").value.split(",").map((x) => x.trim()), tone: old ? old.tone : ["#C9D8D3", "#D6D2C6", "#CCD3DA", "#D3CCC5"][S.spaces.length % 4] };
          const local = C.validateSpace(payload);
          if (Object.keys(local).length) return showErrors(f, local);
          const res = old ? await api("PUT", "/api/espacios/" + old.id, payload) : await api("POST", "/api/espacios", payload);
          if (!res.ok) return res.data.errors ? showErrors(f, res.data.errors) : toast(res.data.error || "No se pudo guardar.", "bad");
          await refresh(); close(); toast(old ? "Espacio actualizado." : "Espacio creado."); render();
        };
      });
    }
    if (a === "toggle-space") { const s = spaceById(el.dataset.id), activo = !s.active; const res = await api("POST", "/api/espacios/" + s.id + "/activo", { active: activo }); await refresh(); if (!res.ok) toast(res.data.error || "No se pudo cambiar el estado.", "bad"); else toast(activo ? s.name + " está activo." : s.name + " ya no aparece en el catálogo."); return render(); }
    if (a === "reset") {
      return modal('<h2>¿Restablecer los datos?</h2><p class="muted">Se borran de la base de datos los usuarios, espacios y reservas creados y se cargan los de demostración.</p><div class="two"><button class="btn ghost" data-close>Volver</button><button class="btn danger" data-yes>Restablecer</button></div>', (w, close) => {
        w.querySelector("[data-yes]").onclick = async () => { close(); const res = await api("POST", "/api/reiniciar", {}); if (!res.ok) return toast(res.data.error || "No se pudo restablecer.", "bad"); setToken(null); session = null; user = null; S = null; ui.report = null; await loadPublic(); toast("Datos restablecidos. Inicia sesión de nuevo."); go("login"); };
      });
    }
  });

  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.filter) { ui.filters[el.dataset.filter] = el.value; return render(); }
    if (el.dataset.action === "pick-date" && el.value) { ui.sel = { date: el.value, hours: [] }; return render(); }
    if (el.dataset.report && el.value) { ui.report[el.dataset.report] = el.value; return render(); }
  });
  let tId;
  document.addEventListener("input", (e) => {
    if (e.target.dataset.filter === "text") { clearTimeout(tId); const v = e.target.value; tId = setTimeout(() => { ui.filters.text = v; render(); const i = $('[data-filter="text"]'); i.focus(); i.setSelectionRange(v.length, v.length); }, 250); }
  });

  document.addEventListener("submit", async (e) => {
    const f = e.target;
    if (f.dataset.form === "login") {
      e.preventDefault();
      const r = await api("POST", "/api/login", { email: f.elements.namedItem("email").value, password: f.elements.namedItem("password").value });
      const al = $("[data-alert]", f);
      if (!r.ok) { if (al) { al.textContent = r.data.error; al.classList.remove("hidden"); } return; }
      setToken(r.data.token); await refresh(); toast("Hola, " + user.name.split(" ")[0] + "."); go("catalog");
    }
    if (f.dataset.form === "register") {
      e.preventDefault();
      const r = await api("POST", "/api/registro", { name: f.elements.namedItem("name").value, email: f.elements.namedItem("email").value, password: f.elements.namedItem("password").value, confirm: f.elements.namedItem("confirm").value });
      if (!r.ok) return r.data.errors ? showErrors(f, r.data.errors) : toast(r.data.error || "No se pudo registrar.", "bad");
      setToken(r.data.token); await refresh(); toast("Cuenta creada. ¡Bienvenido!"); go("catalog");
    }
  });

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { const m = $(".modal-bg"); m && m.remove(); } });

  async function loadPublic() { const r = await api("GET", "/api/publico"); if (r.ok) pub = r.data; }

  (async function init() {
    await loadPublic();
    if (token && !(await refresh())) setToken(null);
    view = { name: session ? "catalog" : "login" };
    render();
  })();
})();
