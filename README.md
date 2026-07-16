# TikTok Sticker Downloader

Extensión de Chrome para descargar stickers de los mensajes directos de TikTok (uno o varios).

## Instalación

1. Abre Chrome y ve a `chrome://extensions`
2. Activa **Modo de desarrollador** (arriba a la derecha)
3. Pulsa **Cargar descomprimida**
4. Selecciona esta carpeta: `tiktok-sticker-downloader`

## Uso

1. Entra en [TikTok](https://www.tiktok.com) e inicia sesión
2. Abre un chat con stickers
3. Sobre cada sticker verás:
   - **Checkbox** (arriba izquierda) para seleccionarlo
   - **Botón de descarga** (arriba derecha) para bajar ese sticker
4. Abajo a la derecha aparece una barra flotante:
   - **Descargar** → solo los seleccionados
   - **Descargar visibles** → todos los stickers de la conversación visible
   - **Limpiar** → quita la selección
5. También puedes usar el popup del icono de la extensión

Los archivos se guardan en la carpeta de descargas, dentro de `tiktok-stickers/`.

- Stickers **estáticos** → `.webp`
- Stickers **animados** (`.awebp`) → se convierten a **`.gif`**

## Notas

- Detecta imágenes con `alt="sticker"`, clases `StickerImage` / `DivStickerContainer` y URLs del CDN de TikTok.
- Tras actualizar la extensión en `chrome://extensions`, pulsa **Recargar** y recarga también la pestaña de TikTok.
- Si TikTok cambia el DOM, puede hacer falta ajustar los selectores en `content.js`.
