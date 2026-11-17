#!/usr/bin/env python3
"""
CoSpace – servidor local con base de datos SQLite.

Uso:   python servidor.py            (abre http://localhost:8000)
       python servidor.py --puerto 9000
       python servidor.py --reiniciar (borra la base y carga los datos de demostración)

La base de datos se guarda en el archivo cospace.db, en la misma carpeta del proyecto.
Solo usa la biblioteca estándar de Python (3.8 o superior).
"""
import argparse, hashlib, json, os, re, secrets, sqlite3, threading, webbrowser
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

CARPETA = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(CARPETA, "cospace.db")
OPEN_HOUR, CLOSE_HOUR = 8, 20
TYPES = ["Escritorio compartido", "Oficina privada", "Sala de reuniones"]
CANCEL_LIMIT_HOURS = 2
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
LOCK = threading.Lock()

ESQUEMA = """
CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  correo TEXT NOT NULL UNIQUE,
  clave_hash TEXT NOT NULL,
  sal TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT 'user' CHECK (rol IN ('user','admin')),
  creado TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS espacios (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL,
  capacidad INTEGER NOT NULL CHECK (capacidad BETWEEN 1 AND 50),
  precio INTEGER NOT NULL CHECK (precio >= 1000),
  ubicacion TEXT NOT NULL DEFAULT '',
  descripcion TEXT NOT NULL DEFAULT '',
  servicios TEXT NOT NULL DEFAULT '[]',
  tono TEXT NOT NULL DEFAULT '#C9D8D3',
  activo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS reservas (
  id TEXT PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  espacio_id TEXT NOT NULL REFERENCES espacios(id),
  fecha TEXT NOT NULL,
  hora_inicio INTEGER NOT NULL,
  hora_fin INTEGER NOT NULL,
  total INTEGER NOT NULL,
  estado TEXT NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa','cancelada')),
  creada TEXT NOT NULL,
  cancelada TEXT
);
CREATE INDEX IF NOT EXISTS idx_reservas_espacio_fecha ON reservas (espacio_id, fecha);
CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id),
  creada TEXT NOT NULL
);
"""


class Error(Exception):
    def __init__(self, status, payload):
        super().__init__(str(payload))
        self.status, self.payload = status, payload


def conectar(path=None):
    cx = sqlite3.connect(path or DB_PATH, timeout=10)
    cx.row_factory = sqlite3.Row
    cx.execute("PRAGMA foreign_keys = ON")
    return cx


def uid(prefijo):
    return prefijo + "-" + secrets.token_hex(4)


def ahora():
    return datetime.now()


def slot_start(fecha, hora):
    y, m, d = map(int, fecha.split("-"))
    return datetime(y, m, d, hora)


def hash_clave(clave, sal):
    return hashlib.pbkdf2_hmac("sha256", clave.encode("utf-8"), bytes.fromhex(sal), 100_000).hex()


# ---------------------------------------------------------------- usuarios
def validar_registro(cx, d):
    e = {}
    nombre, correo = (d.get("name") or "").strip(), (d.get("email") or "").strip().lower()
    clave, conf = d.get("password") or "", d.get("confirm") or ""
    if len(nombre) < 3:
        e["name"] = "Escribe tu nombre completo."
    if not EMAIL_RE.match(correo):
        e["email"] = "Escribe un correo válido."
    elif cx.execute("SELECT 1 FROM usuarios WHERE correo = ?", (correo,)).fetchone():
        e["email"] = "Ya existe una cuenta con este correo."
    if len(clave) < 8:
        e["password"] = "La contraseña debe tener mínimo 8 caracteres."
    elif not re.search(r"[A-Za-z]", clave) or not re.search(r"\d", clave):
        e["password"] = "Usa al menos una letra y un número."
    if clave != conf:
        e["confirm"] = "Las contraseñas no coinciden."
    return e


def registrar(cx, d, rol="user"):
    e = validar_registro(cx, d)
    if e:
        raise Error(400, {"errors": e})
    sal = secrets.token_hex(16)
    u = {"id": uid("U"), "nombre": d["name"].strip(), "correo": d["email"].strip().lower(), "rol": rol}
    cx.execute("INSERT INTO usuarios (id, nombre, correo, clave_hash, sal, rol, creado) VALUES (?,?,?,?,?,?,?)",
               (u["id"], u["nombre"], u["correo"], hash_clave(d["password"], sal), sal, rol, ahora().isoformat()))
    return u


def iniciar_sesion(cx, correo, clave):
    r = cx.execute("SELECT * FROM usuarios WHERE correo = ?", ((correo or "").strip().lower(),)).fetchone()
    if not r or not secrets.compare_digest(r["clave_hash"], hash_clave(clave or "", r["sal"])):
        raise Error(401, {"error": "Correo o contraseña incorrectos."})
    token = secrets.token_urlsafe(24)
    cx.execute("INSERT INTO sesiones (token, usuario_id, creada) VALUES (?,?,?)", (token, r["id"], ahora().isoformat()))
    return token, r


def usuario_de_token(cx, token):
    if not token:
        return None
    return cx.execute("SELECT u.* FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token = ?", (token,)).fetchone()


def user_json(r):
    return {"id": r["id"], "name": r["nombre"], "email": r["correo"], "role": r["rol"]}


# ---------------------------------------------------------------- espacios
def validar_espacio(d):
    e = {}
    if len((d.get("name") or "").strip()) < 3:
        e["name"] = "El nombre debe tener mínimo 3 caracteres."
    if d.get("type") not in TYPES:
        e["type"] = "Elige un tipo de espacio."
    try:
        cap = int(str(d.get("capacity")))
        if not 1 <= cap <= 50:
            raise ValueError
    except ValueError:
        e["capacity"] = "La capacidad debe estar entre 1 y 50."
    try:
        if float(str(d.get("price"))) < 1000:
            raise ValueError
    except ValueError:
        e["price"] = "El precio por hora debe ser mínimo $1.000."
    return e


def guardar_espacio(cx, d, espacio_id=None):
    e = validar_espacio(d)
    if e:
        raise Error(400, {"errors": e})
    vals = (d["name"].strip(), d["type"], int(str(d["capacity"])), round(float(str(d["price"]))),
            (d.get("location") or "").strip(), (d.get("description") or "").strip(),
            json.dumps([s.strip() for s in d.get("services") or [] if s and s.strip()], ensure_ascii=False), d.get("tone") or "#C9D8D3")
    if espacio_id:
        cur = cx.execute("UPDATE espacios SET nombre=?, tipo=?, capacidad=?, precio=?, ubicacion=?, descripcion=?, servicios=?, tono=? WHERE id=?", vals + (espacio_id,))
        if not cur.rowcount:
            raise Error(404, {"error": "Espacio no encontrado."})
        return espacio_id
    nuevo = uid("E")
    cx.execute("INSERT INTO espacios (id, nombre, tipo, capacidad, precio, ubicacion, descripcion, servicios, tono, activo) VALUES (?,?,?,?,?,?,?,?,?,1)", (nuevo,) + vals)
    return nuevo


def activar_espacio(cx, espacio_id, activo):
    if not cx.execute("UPDATE espacios SET activo=? WHERE id=?", (1 if activo else 0, espacio_id)).rowcount:
        raise Error(404, {"error": "Espacio no encontrado."})


def espacio_json(r):
    return {"id": r["id"], "name": r["nombre"], "type": r["tipo"], "capacity": r["capacidad"], "price": r["precio"],
            "location": r["ubicacion"], "description": r["descripcion"], "services": json.loads(r["servicios"]),
            "tone": r["tono"], "active": bool(r["activo"])}


# ---------------------------------------------------------------- reservas
def horas_ocupadas(cx, espacio_id, fecha):
    ocupadas = set()
    for r in cx.execute("SELECT hora_inicio, hora_fin FROM reservas WHERE espacio_id=? AND fecha=? AND estado='activa'", (espacio_id, fecha)):
        ocupadas.update(range(r["hora_inicio"], r["hora_fin"]))
    return ocupadas


def crear_reserva(cx, usuario_id, d, now=None):
    now = now or ahora()
    esp = cx.execute("SELECT * FROM espacios WHERE id=? AND activo=1", (d.get("spaceId"),)).fetchone()
    if not esp:
        raise Error(400, {"error": "El espacio no está disponible."})
    fecha = d.get("date") or ""
    if not DATE_RE.match(fecha):
        raise Error(400, {"error": "Elige una fecha."})
    try:
        hs = sorted({int(h) for h in d.get("hours") or []})
    except (TypeError, ValueError):
        raise Error(400, {"error": "Bloques horarios no válidos."})
    if not hs:
        raise Error(400, {"error": "Elige al menos un bloque horario."})
    if any(b != a + 1 for a, b in zip(hs, hs[1:])):
        raise Error(400, {"error": "Los bloques deben ser consecutivos."})
    if hs[0] < OPEN_HOUR or hs[-1] >= CLOSE_HOUR:
        raise Error(400, {"error": "Fuera del horario de atención."})
    if slot_start(fecha, hs[0]) <= now:
        raise Error(400, {"error": "No puedes reservar en una hora que ya pasó."})
    if set(hs) & horas_ocupadas(cx, esp["id"], fecha):
        raise Error(409, {"error": "Uno de los bloques ya fue reservado. Elige otro horario."})
    seq = 480 + cx.execute("SELECT COUNT(*) FROM reservas").fetchone()[0] + 1
    codigo = "CS-%s%s-%04d" % (fecha[5:7], fecha[2:4], seq)
    while cx.execute("SELECT 1 FROM reservas WHERE codigo=?", (codigo,)).fetchone():
        seq += 1
        codigo = "CS-%s%s-%04d" % (fecha[5:7], fecha[2:4], seq)
    rid = uid("R")
    cx.execute("INSERT INTO reservas (id, codigo, usuario_id, espacio_id, fecha, hora_inicio, hora_fin, total, estado, creada) VALUES (?,?,?,?,?,?,?,?, 'activa', ?)",
               (rid, codigo, usuario_id, esp["id"], fecha, hs[0], hs[-1] + 1, esp["precio"] * len(hs), now.isoformat()))
    return rid


def cancelar_reserva(cx, usuario_id, reserva_id, now=None):
    now = now or ahora()
    r = cx.execute("SELECT * FROM reservas WHERE id=? AND usuario_id=?", (reserva_id, usuario_id)).fetchone()
    if not r:
        raise Error(404, {"error": "Reserva no encontrada."})
    activa = r["estado"] == "activa" and slot_start(r["fecha"], r["hora_fin"]) > now
    if not activa or (slot_start(r["fecha"], r["hora_inicio"]) - now) < timedelta(hours=CANCEL_LIMIT_HOURS):
        raise Error(400, {"error": "Solo puedes cancelar reservas activas hasta %d horas antes del inicio." % CANCEL_LIMIT_HOURS})
    cx.execute("UPDATE reservas SET estado='cancelada', cancelada=? WHERE id=?", (now.isoformat(), reserva_id))


def reserva_json(r, completa):
    base = {"id": r["id"], "spaceId": r["espacio_id"], "date": r["fecha"], "start": r["hora_inicio"], "end": r["hora_fin"],
            "status": r["estado"]}
    if completa:
        base.update({"code": r["codigo"], "userId": r["usuario_id"], "total": r["total"], "createdAt": r["creada"]})
    return base


def datos_para(cx, u):
    """Datos que ve el usuario: espacios, sus reservas completas y la ocupación de los demás sin datos personales.
    El administrador ve todas las reservas para el reporte de ocupación."""
    admin = u["rol"] == "admin"
    espacios = [espacio_json(r) for r in cx.execute("SELECT * FROM espacios ORDER BY rowid")]
    if not admin:
        espacios = [e for e in espacios if e["active"]]
    reservas = []
    for r in cx.execute("SELECT * FROM reservas ORDER BY fecha, hora_inicio"):
        propia = r["usuario_id"] == u["id"]
        if admin or propia:
            reservas.append(reserva_json(r, True))
        elif r["estado"] == "activa":
            reservas.append(reserva_json(r, False))
    return {"user": user_json(u), "spaces": espacios, "reservations": reservas}


# ---------------------------------------------------------------- datos de demostración
def cargar_demo(cx):
    for t in ("sesiones", "reservas", "espacios", "usuarios"):
        cx.execute("DELETE FROM " + t)
    admin = registrar(cx, {"name": "Administrador CoSpace", "email": "admin@cospace.co", "password": "Admin2026", "confirm": "Admin2026"}, "admin")
    santi = registrar(cx, {"name": "Santiago Orrego", "email": "santiago@correo.com", "password": "Demo2026", "confirm": "Demo2026"})
    hay = registrar(cx, {"name": "Hayversson Mosquera", "email": "hayversson@correo.com", "password": "Demo2026", "confirm": "Demo2026"})
    espacios = [
        ("Sala Ceiba", "Sala de reuniones", 8, 45000, "Piso 3, Torre Norte", "Sala iluminada con mesa para 8, ideal para reuniones de equipo, entrevistas y presentaciones a clientes.", ["Wifi de alta velocidad", "Proyector y pantalla", "Tablero", "Café y agua", "Aire acondicionado", "Videoconferencia"], "#C9D8D3"),
        ("Escritorio Flex 3", "Escritorio compartido", 1, 12000, "Piso 2, zona abierta", "Puesto en zona abierta con buena luz natural, lockers y acceso a la cocina.", ["Wifi de alta velocidad", "Locker", "Café y agua"], "#D6D2C6"),
        ("Oficina Guayacán", "Oficina privada", 4, 32000, "Piso 4, Torre Sur", "Oficina cerrada para cuatro personas, con escritorios, sillas ergonómicas y pantalla.", ["Wifi de alta velocidad", "Pantalla externa", "Aire acondicionado", "Café y agua"], "#CCD3DA"),
        ("Sala Samán", "Sala de reuniones", 12, 60000, "Piso 5, Torre Norte", "La sala más grande del coworking, ideal para talleres y capacitaciones.", ["Wifi de alta velocidad", "Proyector y pantalla", "Sonido", "Videoconferencia", "Café y agua"], "#D3CCC5"),
        ("Escritorio Flex 7", "Escritorio compartido", 1, 12000, "Piso 2, zona abierta", "Puesto junto a la ventana, cerca de la zona de impresión.", ["Wifi de alta velocidad", "Locker", "Impresora"], "#C9D8D3"),
        ("Oficina Roble", "Oficina privada", 2, 25000, "Piso 4, Torre Sur", "Oficina para dos personas, silenciosa y con buena ventilación.", ["Wifi de alta velocidad", "Aire acondicionado", "Café y agua"], "#D6D2C6"),
    ]
    ids = {}
    for n, t, c, p, loc, desc, serv, tono in espacios:
        ids[n] = guardar_espacio(cx, {"name": n, "type": t, "capacity": c, "price": p, "location": loc, "description": desc, "services": serv, "tone": tono})
    hoy = date.today()
    dia = lambda n: (hoy + timedelta(days=n)).isoformat()
    temprano = datetime(hoy.year, hoy.month, hoy.day) - timedelta(days=30)  # permite cargar reservas pasadas
    def reservar(u, esp, n, horas, estado="activa"):
        rid = crear_reserva(cx, u["id"], {"spaceId": ids[esp], "date": dia(n), "hours": horas}, now=temprano)
        if estado == "cancelada":
            cx.execute("UPDATE reservas SET estado='cancelada', cancelada=? WHERE id=?", (ahora().isoformat(), rid))
    reservar(santi, "Oficina Roble", -6, [14, 15, 16])
    reservar(santi, "Sala Samán", -9, [9], "cancelada")
    reservar(hay, "Sala Ceiba", -3, [8, 9, 10, 11])
    reservar(hay, "Escritorio Flex 7", -2, list(range(8, 16)))
    reservar(santi, "Sala Ceiba", 1, [13, 14])
    reservar(santi, "Escritorio Flex 3", 3, [8, 9, 10, 11])
    reservar(hay, "Sala Ceiba", 1, [10, 11])
    reservar(hay, "Sala Ceiba", 1, [16])
    reservar(hay, "Sala Samán", 2, [9, 10, 11])
    reservar(hay, "Oficina Guayacán", 1, list(range(8, 20)))


def preparar_base(path=None, reiniciar=False):
    cx = conectar(path)
    cx.executescript(ESQUEMA)
    if reiniciar or not cx.execute("SELECT 1 FROM usuarios LIMIT 1").fetchone():
        with cx:
            cargar_demo(cx)
    cx.close()


# ---------------------------------------------------------------- servidor HTTP
class Manejador(BaseHTTPRequestHandler):
    server_version = "CoSpace/1.0"

    def log_message(self, fmt, *args):
        print("  %s %s" % (self.command, self.path.split("?")[0]))

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 100_000:
            raise Error(413, {"error": "Solicitud demasiado grande."})
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            raise Error(400, {"error": "JSON no válido."})

    def _token(self):
        a = self.headers.get("Authorization") or ""
        return a[7:] if a.startswith("Bearer ") else None

    def do_GET(self):
        ruta = urlparse(self.path).path
        if ruta in ("/", "/index.html"):
            with open(os.path.join(CARPETA, "index.html"), "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if ruta.startswith("/api/"):
            return self._api("GET", ruta)
        self._json(404, {"error": "No encontrado."})

    def do_POST(self):
        self._api("POST", urlparse(self.path).path)

    def do_PUT(self):
        self._api("PUT", urlparse(self.path).path)

    def _api(self, metodo, ruta):
        try:
            with LOCK:
                cx = conectar()
                try:
                    with cx:
                        status, payload = self._rutas(cx, metodo, ruta)
                finally:
                    cx.close()
            self._json(status, payload)
        except Error as e:
            self._json(e.status, e.payload)
        except Exception as e:  # error inesperado
            print("  ERROR:", repr(e))
            self._json(500, {"error": "Error interno del servidor."})

    def _rutas(self, cx, metodo, ruta):
        if metodo == "GET" and ruta == "/api/publico":
            n = cx.execute("SELECT COUNT(*) FROM espacios WHERE activo=1").fetchone()[0]
            return 200, {"activeSpaces": n}
        if metodo == "POST" and ruta == "/api/registro":
            d = self._body()
            u = registrar(cx, d)
            token, _ = iniciar_sesion(cx, u["correo"], d.get("password"))
            return 201, {"token": token}
        if metodo == "POST" and ruta == "/api/login":
            d = self._body()
            token, _ = iniciar_sesion(cx, d.get("email"), d.get("password"))
            return 200, {"token": token}

        u = usuario_de_token(cx, self._token())
        if not u:
            raise Error(401, {"error": "Tu sesión terminó. Inicia sesión de nuevo."})
        es_admin = u["rol"] == "admin"

        if metodo == "POST" and ruta == "/api/logout":
            cx.execute("DELETE FROM sesiones WHERE token=?", (self._token(),))
            return 200, {"ok": True}
        if metodo == "GET" and ruta == "/api/datos":
            return 200, datos_para(cx, u)
        if metodo == "POST" and ruta == "/api/reservas":
            rid = crear_reserva(cx, u["id"], self._body())
            return 201, {"id": rid}
        m = re.fullmatch(r"/api/reservas/([\w-]+)/cancelar", ruta)
        if metodo == "POST" and m:
            cancelar_reserva(cx, u["id"], m.group(1))
            return 200, {"ok": True}

        if ruta.startswith("/api/espacios") or ruta == "/api/reiniciar":
            if not es_admin:
                raise Error(403, {"error": "Solo el administrador puede hacer esto."})
        if metodo == "POST" and ruta == "/api/espacios":
            return 201, {"id": guardar_espacio(cx, self._body())}
        m = re.fullmatch(r"/api/espacios/([\w-]+)", ruta)
        if metodo == "PUT" and m:
            return 200, {"id": guardar_espacio(cx, self._body(), m.group(1))}
        m = re.fullmatch(r"/api/espacios/([\w-]+)/activo", ruta)
        if metodo == "POST" and m:
            activar_espacio(cx, m.group(1), bool(self._body().get("active")))
            return 200, {"ok": True}
        if metodo == "POST" and ruta == "/api/reiniciar":
            cargar_demo(cx)
            return 200, {"ok": True}
        raise Error(404, {"error": "Ruta no encontrada."})


def main():
    ap = argparse.ArgumentParser(description="Servidor local de CoSpace")
    ap.add_argument("--puerto", type=int, default=8000)
    ap.add_argument("--reiniciar", action="store_true", help="borra la base de datos y carga los datos de demostración")
    ap.add_argument("--sin-navegador", action="store_true")
    a = ap.parse_args()
    preparar_base(reiniciar=a.reiniciar)
    srv = ThreadingHTTPServer(("127.0.0.1", a.puerto), Manejador)
    url = "http://localhost:%d" % a.puerto
    print("CoSpace en %s  (base de datos: %s)" % (url, DB_PATH))
    print("Presione Ctrl+C para detener el servidor.")
    if not a.sin_navegador:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")


if __name__ == "__main__":
    main()
