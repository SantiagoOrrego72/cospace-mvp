# CoSpace – Sistema de Reservas de Espacios de Coworking (MVP, Sprint 2)

Proyecto final – ITM. Integrantes: Santiago Orrego Castaño y Hayversson Jhair Mosquera Moreno.

Aplicación web para reservar escritorios, oficinas privadas y salas de reuniones por bloques de una hora, con un panel de administración y un reporte de ocupación.

## Requisitos

- **Python 3.8 o superior** (https://www.python.org). El servidor y la base de datos SQLite usan solo la biblioteca estándar: no hay que instalar paquetes.
- **Node.js 18 o superior** (opcional), solo para ejecutar las pruebas de la lógica (`core.test.js`).

## Cómo ejecutarlo en localhost

1. Descargar el proyecto:
   ```bash
   git clone https://github.com/SantiagoOrrego72/cospace-mvp.git
   cd cospace-mvp
   ```
   (También se puede descargar como ZIP desde GitHub con **Code → Download ZIP** y descomprimirlo).
2. Iniciar el servidor:
   - **Windows:** doble clic en `iniciar.bat`, o `python servidor.py` en una terminal.
   - **Mac / Linux:** `./iniciar.sh`, o `python3 servidor.py`.
3. El navegador se abre en **http://localhost:8000** (si no se abre, entrar a esa dirección).
4. Para detener el servidor: `Ctrl + C` en la terminal.

Opciones del servidor:

| Opción | Efecto |
|---|---|
| `--puerto 9000` | Usa otro puerto (por defecto 8000). |
| `--reiniciar` | Borra los datos y carga de nuevo los de demostración. |
| `--sin-navegador` | No abre el navegador automáticamente. |

El servidor solo escucha en `127.0.0.1`, es decir, únicamente es accesible desde el mismo equipo.

### Cuentas de demostración

| Rol | Correo | Contraseña |
|---|---|---|
| Usuario | santiago@correo.com | Demo2026 |
| Usuario | hayversson@correo.com | Demo2026 |
| Administrador | admin@cospace.co | Admin2026 |

## Base de datos

Los datos se guardan en el archivo **`cospace.db`** (SQLite). El servidor lo crea automáticamente en la carpeta del proyecto la primera vez que se inicia y carga los datos de demostración. Este archivo **no se sube al repositorio** (está en `.gitignore`), así que cada copia del proyecto genera la suya. Los datos se conservan al cerrar el navegador o reiniciar el servidor. Se puede abrir con DB Browser for SQLite para ver las tablas.

| Tabla | Contenido |
|---|---|
| `usuarios` | id, nombre, correo (único), clave_hash (PBKDF2-SHA256), sal, rol (user/admin), fecha de creación |
| `espacios` | id, nombre, tipo, capacidad, precio por hora, ubicación, descripción, servicios, color, activo |
| `reservas` | id, código, usuario_id, espacio_id, fecha, hora_inicio, hora_fin, total, estado (activa/cancelada), fechas de creación y cancelación |
| `sesiones` | token, usuario_id, fecha de creación |

## Funcionalidades (historias de usuario)

- HU-01 Registro con validaciones (correo único, contraseña de 8+ caracteres con letras y números).
- HU-02 Inicio de sesión con sesiones por token.
- HU-03 Catálogo de espacios activos.
- HU-04 Detalle del espacio.
- HU-05 Reserva por bloques de una hora consecutivos entre las 8:00 y las 20:00, sin cruces de horario ni horas pasadas (validado en el servidor).
- HU-06 Mis reservas (todas, activas, historial).
- HU-07 Cancelar reserva (hasta 2 horas antes del inicio), con confirmación.
- HU-08 Administración de espacios (crear, editar, activar/desactivar). Solo administrador.
- HU-09 Filtros por tipo, capacidad, fecha y búsqueda por texto.
- HU-13 Reporte de ocupación por rango de fechas (administrador).
- HU-15 Horas libres por fecha en el catálogo.

## Estructura

| Archivo | Contenido |
|---|---|
| `servidor.py` | Servidor local: API, reglas de negocio, sesiones y base de datos SQLite. |
| `index.html` | Interfaz web que sirve el servidor. Se genera uniendo `shell.html`, `core.js` y `app.js`. |
| `shell.html` | Plantilla HTML y estilos de la interfaz. |
| `core.js` | Lógica de negocio de la interfaz (validaciones, disponibilidad, reservas, reporte). |
| `app.js` | Vistas, navegación y conexión con la API. |
| `core.test.js` | 12 pruebas de la lógica (Node.js). |
| `test_servidor.py` | 10 pruebas del servidor y la base de datos (Python). |
| `resultados_pruebas.txt` | Salida de la última ejecución de las pruebas. |
| `iniciar.bat` / `iniciar.sh` | Inician el servidor en Windows y en Mac / Linux. |

### Regenerar `index.html`

Si se modifica `shell.html`, `core.js` o `app.js`, hay que regenerar `index.html` (requiere Node.js):

```bash
node -e "const f=require('fs'),r=n=>f.readFileSync(n,'utf8');f.writeFileSync('index.html',r('shell.html').replace('/*CORE*/',()=>r('core.js')).replace('/*APP*/',()=>r('app.js')))"
```

## API

Todas las rutas, salvo `/api/publico`, `/api/registro` y `/api/login`, requieren el encabezado `Authorization: Bearer <token>`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | /api/publico | Número de espacios activos (pantalla de inicio de sesión) |
| POST | /api/registro | Crea un usuario e inicia sesión |
| POST | /api/login, /api/logout | Inicia o cierra sesión |
| GET | /api/datos | Espacios, reservas propias y ocupación (sin datos de otros usuarios) |
| POST | /api/reservas | Crea una reserva |
| POST | /api/reservas/{id}/cancelar | Cancela una reserva propia |
| POST / PUT | /api/espacios, /api/espacios/{id} | Crea o edita un espacio (administrador) |
| POST | /api/espacios/{id}/activo | Activa o desactiva un espacio (administrador) |
| POST | /api/reiniciar | Restablece los datos de demostración (administrador) |

## Pruebas

```bash
node --test core.test.js             # 12 pruebas (requiere Node.js 18+)
python -m unittest test_servidor -v  # 10 pruebas
```

Resultado: 22 pruebas, 22 aprobadas, 0 fallidas (ver `resultados_pruebas.txt`).

## Organización del repositorio

| Rama | Uso |
|---|---|
| `main` | Versión estable entregada. Solo recibe cambios desde `develop`. |
| `develop` | Integración de las funcionalidades terminadas. |
| `feature/*` | Una rama por funcionalidad (servidor, lógica, interfaz, scripts de inicio). |
| `docs/*` | Documentación. |

Cada rama se integra a `develop` con un *merge* propio, de modo que el historial muestra qué se hizo en cada parte del proyecto.
