/* CoSpace – lógica de negocio (sin interfaz). Se usa en la app y en las pruebas. */
(function (root) {
  "use strict";

  const OPEN_HOUR = 8, CLOSE_HOUR = 20;
  const TYPES = ["Escritorio compartido", "Oficina privada", "Sala de reuniones"];
  const CANCEL_LIMIT_HOURS = 2;

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function uid(prefix) {
    return prefix + "-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  async function hashPassword(pw) {
    const data = new TextEncoder().encode("cospace::" + pw);
    const buf = await root.crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function toDateStr(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function slotStart(date, hour) {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(y, m - 1, d, hour, 0, 0);
  }

  function emptyState() { return { users: [], spaces: [], reservations: [], seq: 480 }; }

  /* ---------- Usuarios (HU-01, HU-02) ---------- */
  function validateRegistration(state, { name, email, password, confirm }) {
    const errors = {};
    if (!name || name.trim().length < 3) errors.name = "Escribe tu nombre completo.";
    if (!email || !EMAIL_RE.test(email.trim())) errors.email = "Escribe un correo válido.";
    else if (state.users.some((u) => u.email === email.trim().toLowerCase())) errors.email = "Ya existe una cuenta con este correo.";
    if (!password || password.length < 8) errors.password = "La contraseña debe tener mínimo 8 caracteres.";
    else if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) errors.password = "Usa al menos una letra y un número.";
    if (password !== confirm) errors.confirm = "Las contraseñas no coinciden.";
    return errors;
  }

  async function register(state, input) {
    const errors = validateRegistration(state, input);
    if (Object.keys(errors).length) return { ok: false, errors };
    const user = { id: uid("U"), name: input.name.trim(), email: input.email.trim().toLowerCase(), passwordHash: await hashPassword(input.password), role: "user" };
    state.users.push(user);
    return { ok: true, user };
  }

  async function login(state, email, password) {
    const u = state.users.find((x) => x.email === String(email || "").trim().toLowerCase());
    if (!u || u.passwordHash !== (await hashPassword(password || ""))) return { ok: false, error: "Correo o contraseña incorrectos." };
    return { ok: true, user: u };
  }

  /* ---------- Espacios (HU-03, HU-04, HU-08, HU-09) ---------- */
  function validateSpace(s) {
    const errors = {};
    if (!s.name || s.name.trim().length < 3) errors.name = "El nombre debe tener mínimo 3 caracteres.";
    if (!TYPES.includes(s.type)) errors.type = "Elige un tipo de espacio.";
    if (!Number.isInteger(+s.capacity) || +s.capacity < 1 || +s.capacity > 50) errors.capacity = "La capacidad debe estar entre 1 y 50.";
    if (!Number.isFinite(+s.price) || +s.price < 1000) errors.price = "El precio por hora debe ser mínimo $1.000.";
    return errors;
  }

  function upsertSpace(state, input) {
    const errors = validateSpace(input);
    if (Object.keys(errors).length) return { ok: false, errors };
    const clean = {
      name: input.name.trim(), type: input.type, capacity: +input.capacity, price: Math.round(+input.price),
      location: (input.location || "").trim(), description: (input.description || "").trim(),
      services: (input.services || []).filter(Boolean), tone: input.tone || "#C9D8D3",
    };
    if (input.id) {
      const s = state.spaces.find((x) => x.id === input.id);
      if (!s) return { ok: false, errors: { id: "Espacio no encontrado." } };
      Object.assign(s, clean);
      return { ok: true, space: s };
    }
    const space = Object.assign({ id: uid("E"), active: true }, clean);
    state.spaces.push(space);
    return { ok: true, space };
  }

  function setSpaceActive(state, id, active) {
    const s = state.spaces.find((x) => x.id === id);
    if (!s) return { ok: false, error: "Espacio no encontrado." };
    s.active = !!active;
    return { ok: true, space: s };
  }

  function busyHours(state, spaceId, date) {
    const set = new Set();
    for (const r of state.reservations) {
      if (r.spaceId !== spaceId || r.date !== date || r.status === "cancelada") continue;
      for (let h = r.start; h < r.end; h++) set.add(h);
    }
    return set;
  }

  function freeHours(state, spaceId, date, now) {
    const busy = busyHours(state, spaceId, date);
    const out = [];
    for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
      if (busy.has(h)) continue;
      if (now && slotStart(date, h) <= now) continue;
      out.push(h);
    }
    return out;
  }

  function filterSpaces(state, { type = "", minCapacity = 0, date = "", text = "" } = {}, now) {
    const q = text.trim().toLowerCase();
    return state.spaces
      .filter((s) => s.active)
      .filter((s) => !type || s.type === type)
      .filter((s) => s.capacity >= (+minCapacity || 0))
      .filter((s) => !q || (s.name + " " + s.type + " " + s.location).toLowerCase().includes(q))
      .map((s) => Object.assign({}, s, { freeCount: date ? freeHours(state, s.id, date, now).length : null }));
  }

  /* ---------- Reservas (HU-05, HU-06, HU-07) ---------- */
  function createReservation(state, { userId, spaceId, date, hours }, now) {
    const space = state.spaces.find((s) => s.id === spaceId && s.active);
    if (!space) return { ok: false, error: "El espacio no está disponible." };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return { ok: false, error: "Elige una fecha." };
    const hs = Array.from(new Set(hours || [])).map(Number).sort((a, b) => a - b);
    if (!hs.length) return { ok: false, error: "Elige al menos un bloque horario." };
    for (let i = 1; i < hs.length; i++) if (hs[i] !== hs[i - 1] + 1) return { ok: false, error: "Los bloques deben ser consecutivos." };
    if (hs[0] < OPEN_HOUR || hs[hs.length - 1] >= CLOSE_HOUR) return { ok: false, error: "Fuera del horario de atención." };
    if (now && slotStart(date, hs[0]) <= now) return { ok: false, error: "No puedes reservar en una hora que ya pasó." };
    const busy = busyHours(state, spaceId, date);
    if (hs.some((h) => busy.has(h))) return { ok: false, error: "Uno de los bloques ya fue reservado. Elige otro horario." };
    state.seq += 1;
    const [y, m] = date.split("-");
    const r = {
      id: uid("R"), code: "CS-" + m + y.slice(2) + "-" + String(state.seq).padStart(4, "0"),
      userId, spaceId, date, start: hs[0], end: hs[hs.length - 1] + 1,
      total: space.price * hs.length, status: "activa", createdAt: (now || new Date()).toISOString(),
    };
    state.reservations.push(r);
    return { ok: true, reservation: r };
  }

  function statusOf(r, now) {
    if (r.status === "cancelada") return "cancelada";
    if (now && slotStart(r.date, r.end) <= now) return "finalizada";
    return "activa";
  }

  function canCancel(r, now) {
    if (statusOf(r, now) !== "activa") return false;
    if (!now) return true;
    return (slotStart(r.date, r.start) - now) / 36e5 >= CANCEL_LIMIT_HOURS;
  }

  function cancelReservation(state, id, userId, now) {
    const r = state.reservations.find((x) => x.id === id);
    if (!r || r.userId !== userId) return { ok: false, error: "Reserva no encontrada." };
    if (!canCancel(r, now)) return { ok: false, error: "Solo puedes cancelar reservas activas hasta " + CANCEL_LIMIT_HOURS + " horas antes del inicio." };
    r.status = "cancelada";
    r.cancelledAt = (now || new Date()).toISOString();
    return { ok: true, reservation: r };
  }

  function userReservations(state, userId, tab, now) {
    return state.reservations
      .filter((r) => r.userId === userId)
      .map((r) => Object.assign({}, r, { state: statusOf(r, now) }))
      .filter((r) => tab === "activas" ? r.state === "activa" : tab === "historial" ? r.state !== "activa" : true)
      .sort((a, b) => {
        const ka = (a.state === "activa" ? "0" : "1"), kb = (b.state === "activa" ? "0" : "1");
        if (ka !== kb) return ka < kb ? -1 : 1;
        const cmp = (a.date + pad(a.start)).localeCompare(b.date + pad(b.start));
        return a.state === "activa" ? cmp : -cmp; // activas: próximas primero; historial: más recientes primero
      });
  }

  /* ---------- Reporte de ocupación (administrador) ---------- */
  function occupancyReport(state, fromDate, toDate) {
    const days = Math.max(1, Math.round((slotStart(toDate, 0) - slotStart(fromDate, 0)) / 864e5) + 1);
    const capacityHours = days * (CLOSE_HOUR - OPEN_HOUR);
    return state.spaces.map((s) => {
      const rs = state.reservations.filter((r) => r.spaceId === s.id && r.status !== "cancelada" && r.date >= fromDate && r.date <= toDate);
      const hours = rs.reduce((a, r) => a + (r.end - r.start), 0);
      return { id: s.id, name: s.name, type: s.type, active: s.active, reservations: rs.length, hours, income: rs.reduce((a, r) => a + r.total, 0), occupancy: Math.round((hours / capacityHours) * 1000) / 10 };
    });
  }

  function money(n) { return "$" + Math.round(n).toLocaleString("es-CO").replace(/,/g, "."); }
  function hourLabel(h) {
    const suf = h < 12 ? "a. m." : "p. m.";
    const hh = h % 12 === 0 ? 12 : h % 12;
    return hh + ":00 " + suf;
  }

  root.CoSpace = {
    OPEN_HOUR, CLOSE_HOUR, TYPES, CANCEL_LIMIT_HOURS, emptyState, hashPassword, toDateStr, slotStart,
    validateRegistration, register, login, validateSpace, upsertSpace, setSpaceActive,
    busyHours, freeHours, filterSpaces, createReservation, statusOf, canCancel, cancelReservation,
    userReservations, occupancyReport, money, hourLabel,
  };
})(typeof window !== "undefined" ? window : globalThis);
