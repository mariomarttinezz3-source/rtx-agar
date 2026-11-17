# RTX Agar — servidor privado

Servidor multijugador estilo Agar.io con 4 modos. **Solo necesita Node.js** (versión 16 o superior), sin instalar nada más.

## Modos
| Modo | Cómo es |
|---|---|
| **FFA Clásico** | Agar normal: empiezas chico y las células tardan ~15 s en juntarse |
| **Instant** | Empiezas con 500 de masa, eres más rápido y te juntas casi al instante. Hasta 32 células |
| **Crazy** | Empiezas con 2500, hay muchísimos virus y puedes dividirte en hasta 64 células |
| **Bots (minions)** | Tienes 3 bots propios que te siguen y se dividen contigo. Con **Q** los mandas a juntar comida |

También trae: **party** con código o link (ves a tus amigos en el minimapa y su masa total), **skins** con un link de imagen, top 10, chat, estadísticas al morir (comida, masa máxima, tiempo vivo y mejor puesto), FPS y ping, y botones táctiles para el celular.

## Controles
- **Mouse**: mover
- **Espacio**: dividir · **D**: doble · **T**: triple · **Z**: dividir al máximo (x16, o x64 en Crazy)
- **W**: expulsar masa · **E**: expulsar rápido (macro)
- **Q**: minions recolectan o te siguen (solo modo Bots)
- **Enter**: chat · **Esc**: menú

## Jugar en tu PC
1. Instala Node.js desde https://nodejs.org (versión LTS).
2. Abre una terminal dentro de esta carpeta y ejecuta `node server.js`.
3. Entra a http://localhost:3000. Si tus amigos están en el mismo WiFi, pueden entrar con `http://TU-IP-LOCAL:3000`.

## Online gratis con Render
1. Sube esta carpeta a un repositorio de GitHub.
2. En render.com elige *New → Web Service* y selecciona el repo.
3. Start command: `node server.js`. Plan: Free.
4. Comparte el link `https://….onrender.com` con tu clan.

El plan gratis "se duerme" si nadie juega por 15 minutos. El primero que entre después espera unos 30 segundos.

## Configuración (variables de entorno)
- `PORT`: puerto (por defecto, 3000)
- `SERVER_NAME`: nombre del servidor
- `MODES`: los modos que quieres activar, por ejemplo `ffa,instant`
- `BOTS`: cantidad de bots en cada sala (`0` = sin bots)

Para cambiar las reglas de cada modo (masa inicial, velocidad, virus, tiempo para juntarse…), edita el bloque `MODES` al principio de `server.js`.
