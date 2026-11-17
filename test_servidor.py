"""Pruebas del servidor y la base de datos de CoSpace.  Ejecutar: python -m unittest test_servidor -v"""
import json, os, tempfile, threading, unittest, urllib.error, urllib.request
from datetime import datetime
from http.server import ThreadingHTTPServer

import servidor as S

NOW = datetime(2026, 11, 16, 9, 30)


class BaseTemp(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "prueba.db")
        S.preparar_base(self.path)
        self.cx = S.conectar(self.path)
        self.ceiba = self.cx.execute("SELECT id FROM espacios WHERE nombre='Sala Ceiba'").fetchone()[0]
        self.santi = self.cx.execute("SELECT id FROM usuarios WHERE correo='santiago@correo.com'").fetchone()[0]

    def tearDown(self):
        self.cx.close()
        self.dir.cleanup()


class PruebasBaseDeDatos(BaseTemp):
    def test_BD01_esquema_y_datos_demo(self):
        tablas = {r[0] for r in self.cx.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({"usuarios", "espacios", "reservas", "sesiones"} <= tablas)
        self.assertEqual(self.cx.execute("SELECT COUNT(*) FROM espacios").fetchone()[0], 6)
        self.assertEqual(self.cx.execute("SELECT COUNT(*) FROM usuarios").fetchone()[0], 3)

    def test_BD02_clave_guardada_con_hash_y_sal(self):
        r = self.cx.execute("SELECT clave_hash, sal FROM usuarios WHERE correo='santiago@correo.com'").fetchone()
        self.assertNotIn("Demo2026", r["clave_hash"])
        self.assertEqual(len(r["clave_hash"]), 64)
        self.assertEqual(len(r["sal"]), 32)

    def test_BD03_registro_valida_y_persiste(self):
        with self.assertRaises(S.Error) as e:
            S.registrar(self.cx, {"name": "X", "email": "santiago@correo.com", "password": "123", "confirm": "1"})
        self.assertEqual(set(e.exception.payload["errors"]), {"name", "email", "password", "confirm"})
        S.registrar(self.cx, {"name": "Laura Gómez", "email": "laura@correo.com", "password": "clave2026", "confirm": "clave2026"})
        self.cx.commit()
        otra = S.conectar(self.path)  # nueva conexión: el dato quedó guardado en el archivo
        self.assertIsNotNone(otra.execute("SELECT 1 FROM usuarios WHERE correo='laura@correo.com'").fetchone())
        otra.close()

    def test_BD04_reserva_sin_cruces_en_la_base(self):
        S.crear_reserva(self.cx, self.santi, {"spaceId": self.ceiba, "date": "2026-11-20", "hours": [10, 11]}, NOW)
        with self.assertRaises(S.Error) as e:
            S.crear_reserva(self.cx, self.santi, {"spaceId": self.ceiba, "date": "2026-11-20", "hours": [11, 12]}, NOW)
        self.assertEqual(e.exception.status, 409)
        with self.assertRaises(S.Error):
            S.crear_reserva(self.cx, self.santi, {"spaceId": self.ceiba, "date": "2026-11-20", "hours": [8, 10]}, NOW)

    def test_BD05_cancelar_respeta_limite_y_libera(self):
        rid = S.crear_reserva(self.cx, self.santi, {"spaceId": self.ceiba, "date": "2026-11-20", "hours": [15]}, NOW)
        S.cancelar_reserva(self.cx, self.santi, rid, NOW)
        self.assertNotIn(15, S.horas_ocupadas(self.cx, self.ceiba, "2026-11-20"))
        cerca = S.crear_reserva(self.cx, self.santi, {"spaceId": self.ceiba, "date": "2026-11-16", "hours": [11]}, NOW)
        with self.assertRaises(S.Error):
            S.cancelar_reserva(self.cx, self.santi, cerca, NOW)


class PruebasAPI(BaseTemp):
    """Levanta el servidor real en un puerto libre y lo prueba por HTTP."""

    def setUp(self):
        super().setUp()
        S.DB_PATH = self.path
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), S.Manejador)
        self.base = "http://127.0.0.1:%d" % self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        super().tearDown()

    def req(self, metodo, ruta, datos=None, token=None):
        r = urllib.request.Request(self.base + ruta, method=metodo, data=json.dumps(datos).encode() if datos is not None else None,
                                   headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + token} if token else {})})
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def login(self, correo, clave):
        return self.req("POST", "/api/login", {"email": correo, "password": clave})[1]["token"]

    def test_API01_pagina_y_login(self):
        with urllib.request.urlopen(self.base + "/") as r:
            self.assertIn(b"CoSpace", r.read())
        self.assertEqual(self.req("POST", "/api/login", {"email": "santiago@correo.com", "password": "mala1234"})[0], 401)
        st, d = self.req("GET", "/api/datos", token=self.login("santiago@correo.com", "Demo2026"))
        self.assertEqual(st, 200)
        self.assertEqual(d["user"]["role"], "user")

    def test_API02_usuario_no_ve_datos_de_otros(self):
        d = self.req("GET", "/api/datos", token=self.login("santiago@correo.com", "Demo2026"))[1]
        ajenas = [r for r in d["reservations"] if "userId" not in r]
        self.assertTrue(ajenas)
        self.assertTrue(all("code" not in r and "total" not in r for r in ajenas))

    def test_API03_reservar_y_cancelar_por_http(self):
        t = self.login("santiago@correo.com", "Demo2026")
        st, d = self.req("POST", "/api/reservas", {"spaceId": self.ceiba, "date": "2030-01-15", "hours": [9, 10]}, t)
        self.assertEqual(st, 201)
        self.assertEqual(self.req("POST", "/api/reservas", {"spaceId": self.ceiba, "date": "2030-01-15", "hours": [10]}, t)[0], 409)
        self.assertEqual(self.req("POST", "/api/reservas/%s/cancelar" % d["id"], {}, t)[0], 200)

    def test_API04_solo_admin_gestiona_espacios(self):
        nuevo = {"name": "Sala Nogal", "type": "Sala de reuniones", "capacity": 6, "price": 38000}
        self.assertEqual(self.req("POST", "/api/espacios", nuevo, self.login("santiago@correo.com", "Demo2026"))[0], 403)
        st, d = self.req("POST", "/api/espacios", nuevo, self.login("admin@cospace.co", "Admin2026"))
        self.assertEqual(st, 201)
        self.assertEqual(self.req("POST", "/api/espacios", {"name": "A"}, self.login("admin@cospace.co", "Admin2026"))[0], 400)

    def test_API05_sin_sesion_y_archivos_protegidos(self):
        self.assertEqual(self.req("GET", "/api/datos")[0], 401)
        for ruta in ("/cospace.db", "/servidor.py", "/../servidor.py"):
            with self.assertRaises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(self.base + ruta)
            self.assertEqual(e.exception.code, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
