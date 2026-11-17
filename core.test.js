// Pruebas automatizadas de CoSpace. Ejecutar: node --test core.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
require("./core.js");
const C = globalThis.CoSpace;

const NOW = new Date(2026, 10, 16, 9, 30); // lun 16 nov 2026, 9:30 a. m.

function baseState() {
  const s = C.emptyState();
  C.upsertSpace(s, { name: "Sala Ceiba", type: "Sala de reuniones", capacity: 8, price: 45000 });
  C.upsertSpace(s, { name: "Escritorio Flex 3", type: "Escritorio compartido", capacity: 1, price: 12000 });
  C.upsertSpace(s, { name: "Oficina Roble", type: "Oficina privada", capacity: 2, price: 25000 });
  return s;
}

test("CP-01 Registro válido crea el usuario con la contraseña cifrada (HU-01)", async () => {
  const s = baseState();
  const r = await C.register(s, { name: "Ana Pérez", email: "Ana@Correo.com", password: "clave1234", confirm: "clave1234" });
  assert.equal(r.ok, true);
  assert.equal(r.user.email, "ana@correo.com");
  assert.notEqual(r.user.passwordHash, "clave1234");
  assert.equal(r.user.passwordHash.length, 64);
});

test("CP-02 Registro rechaza correo duplicado y contraseña corta (HU-01)", async () => {
  const s = baseState();
  await C.register(s, { name: "Ana Pérez", email: "ana@correo.com", password: "clave1234", confirm: "clave1234" });
  const r = await C.register(s, { name: "Otra", email: "ANA@correo.com", password: "123", confirm: "124" });
  assert.equal(r.ok, false);
  assert.match(r.errors.email, /Ya existe/);
  assert.match(r.errors.password, /mínimo 8/);
  assert.match(r.errors.confirm, /no coinciden/);
});

test("CP-03 Inicio de sesión correcto e incorrecto (HU-02)", async () => {
  const s = baseState();
  await C.register(s, { name: "Ana Pérez", email: "ana@correo.com", password: "clave1234", confirm: "clave1234" });
  assert.equal((await C.login(s, "ana@correo.com", "clave1234")).ok, true);
  const bad = await C.login(s, "ana@correo.com", "otra1234");
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "Correo o contraseña incorrectos.");
});

test("CP-04 Catálogo muestra solo espacios activos y filtra por tipo, capacidad y texto (HU-03, HU-09)", () => {
  const s = baseState();
  C.setSpaceActive(s, s.spaces[2].id, false);
  assert.equal(C.filterSpaces(s, {}).length, 2);
  assert.deepEqual(C.filterSpaces(s, { type: "Sala de reuniones" }).map((x) => x.name), ["Sala Ceiba"]);
  assert.deepEqual(C.filterSpaces(s, { minCapacity: 4 }).map((x) => x.name), ["Sala Ceiba"]);
  assert.deepEqual(C.filterSpaces(s, { text: "flex" }).map((x) => x.name), ["Escritorio Flex 3"]);
  assert.equal(C.filterSpaces(s, { text: "no existe" }).length, 0);
});

test("CP-05 Reserva válida calcula total y genera código (HU-05)", () => {
  const s = baseState();
  const r = C.createReservation(s, { userId: "U1", spaceId: s.spaces[0].id, date: "2026-11-18", hours: [14, 13] }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.reservation.start, 13);
  assert.equal(r.reservation.end, 15);
  assert.equal(r.reservation.total, 90000);
  assert.match(r.reservation.code, /^CS-1126-\d{4}$/);
});

test("CP-06 No permite reservar bloques ocupados (doble reserva) (HU-05)", () => {
  const s = baseState();
  const id = s.spaces[0].id;
  C.createReservation(s, { userId: "U1", spaceId: id, date: "2026-11-18", hours: [10, 11] }, NOW);
  const r = C.createReservation(s, { userId: "U2", spaceId: id, date: "2026-11-18", hours: [11, 12] }, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /ya fue reservado/);
  assert.deepEqual([...C.busyHours(s, id, "2026-11-18")].sort(), [10, 11]);
});

test("CP-07 No permite bloques no consecutivos, fuera de horario ni en el pasado (HU-05)", () => {
  const s = baseState();
  const id = s.spaces[0].id;
  assert.match(C.createReservation(s, { userId: "U1", spaceId: id, date: "2026-11-18", hours: [9, 11] }, NOW).error, /consecutivos/);
  assert.match(C.createReservation(s, { userId: "U1", spaceId: id, date: "2026-11-18", hours: [20] }, NOW).error, /horario/);
  assert.match(C.createReservation(s, { userId: "U1", spaceId: id, date: "2026-11-16", hours: [9] }, NOW).error, /ya pasó/);
  assert.match(C.createReservation(s, { userId: "U1", spaceId: id, date: "2026-11-18", hours: [] }, NOW).error, /al menos/);
});

test("CP-08 Horas libres excluye ocupadas y horas pasadas (HU-05)", () => {
  const s = baseState();
  const id = s.spaces[0].id;
  C.createReservation(s, { userId: "U1", spaceId: id, date: "2026-11-16", hours: [12] }, NOW);
  const free = C.freeHours(s, id, "2026-11-16", NOW);
  assert.equal(free[0], 10);
  assert.ok(!free.includes(12));
  assert.equal(free.length, 9);
});

test("CP-09 Mis reservas separa activas e historial (HU-06)", () => {
  const s = baseState();
  const id = s.spaces[1].id;
  C.createReservation(s, { userId: "U1", spaceId: id, date: "2026-11-20", hours: [8] }, NOW);
  s.reservations.push({ id: "old", code: "X", userId: "U1", spaceId: id, date: "2026-11-02", start: 9, end: 10, total: 12000, status: "activa" });
  assert.equal(C.userReservations(s, "U1", "activas", NOW).length, 1);
  const hist = C.userReservations(s, "U1", "historial", NOW);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].state, "finalizada");
  assert.equal(C.userReservations(s, "U2", "todas", NOW).length, 0);
});

test("CP-10 Cancelar libera el horario y respeta el límite de 2 horas (HU-07)", () => {
  const s = baseState();
  const id = s.spaces[0].id;
  const a = C.createReservation(s, { userId: "U1", spaceId: id, date: "2026-11-18", hours: [10] }, NOW).reservation;
  assert.equal(C.cancelReservation(s, a.id, "U2", NOW).ok, false);
  assert.equal(C.cancelReservation(s, a.id, "U1", NOW).ok, true);
  assert.ok(!C.busyHours(s, id, "2026-11-18").has(10));
  const soon = C.createReservation(s, { userId: "U1", spaceId: id, date: "2026-11-16", hours: [11] }, NOW).reservation;
  assert.equal(C.cancelReservation(s, soon.id, "U1", NOW).ok, false);
});

test("CP-11 Administrador crea, edita y desactiva espacios con validaciones (HU-08)", () => {
  const s = baseState();
  const bad = C.upsertSpace(s, { name: "A", type: "Otro", capacity: 0, price: 10 });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ["capacity", "name", "price", "type"]);
  const ok = C.upsertSpace(s, { name: "Sala Nogal", type: "Sala de reuniones", capacity: 6, price: 38000 });
  assert.equal(ok.ok, true);
  C.upsertSpace(s, Object.assign({}, ok.space, { price: 40000 }));
  assert.equal(s.spaces.find((x) => x.id === ok.space.id).price, 40000);
  C.setSpaceActive(s, ok.space.id, false);
  assert.ok(!C.filterSpaces(s, {}).some((x) => x.id === ok.space.id));
});

test("CP-12 Reporte de ocupación suma horas e ingresos sin contar canceladas", () => {
  const s = baseState();
  const id = s.spaces[0].id;
  C.createReservation(s, { userId: "U1", spaceId: id, date: "2026-11-18", hours: [8, 9, 10] }, NOW);
  const c = C.createReservation(s, { userId: "U1", spaceId: id, date: "2026-11-19", hours: [8] }, NOW).reservation;
  C.cancelReservation(s, c.id, "U1", NOW);
  const rep = C.occupancyReport(s, "2026-11-16", "2026-11-20").find((x) => x.id === id);
  assert.equal(rep.hours, 3);
  assert.equal(rep.income, 135000);
  assert.equal(rep.occupancy, 5);
});
