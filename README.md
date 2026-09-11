# Cursor Chat

App de escritorio para hablar con Cursor **sin abrir ni enfocar** Cursor.
Puedes seguir trabajando en otra ventana; cuando termina, macOS te notifica.

## Setup

```bash
npm install
cp .env.example .env   # pon tu CURSOR_API_KEY
npm run app:build      # una vez (macOS)
```

API key: [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations)

## Run

```bash
npm run app      # app con icono en el Dock
# o
npm start        # ventana en http://127.0.0.1:3860
```

1. Escribe tu pregunta o tarea
2. Pulsa **Enviar**
3. Puedes cambiar a otra app
4. Te llega una notificación al terminar

Opcional: marca **Cloud (Cursor Agents)** para ver el run en Cursor (Agents → Filter → Source → SDK).

## Mejora continua 24h

En la app: sección **Mejora continua 24h** → **Arrancar 24h**.

O por CLI (con la app/servidor ya corriendo):

```bash
npm run improve:24h
# o
npm run improve -- --hours 24 --focus "tests y playbook"
npm run improve -- --stop
```

Ciclo (mensajes con tono humano): implementar → probar → medir → optimizar → guardar hallazgos → repetir.

Lo útil queda en:

- `logs/continuous/playbook.md`
- `logs/continuous/discoveries.json`
- `logs/continuous/cycles.jsonl`

## Cómo probar el chat

1. Completa el [Setup](#setup) (`npm install`, `.env` con `CURSOR_API_KEY`, y `npm run app:build` en macOS si quieres la app nativa).
2. Arranca el servidor:
   ```bash
   npm start
   ```
   Se abre una ventana en `http://127.0.0.1:3860` (o ábrela manualmente en el navegador).
3. Comprueba que el backend responde:
   ```bash
   curl -s http://127.0.0.1:3860/api/health | jq .
   ```
   Deberías ver `"ok": true` y el puerto `3860`.
4. En la UI, escribe una tarea sencilla (por ejemplo: *“¿Qué archivos hay en la raíz del repo?”*) y pulsa **Enviar**.
5. Verifica que:
   - El estado pasa de *conectando…* a *orquestando…* y luego a *listo*.
   - Aparecen burbujas con pasos del agente (herramientas, no solo texto).
   - La barra inferior muestra `local · modo agent`.
6. Cambia a otra app (Safari, Slack, etc.) mientras corre el agente. Al terminar, macOS debería mostrar una notificación.
7. Prueba **Detener** durante un run largo y **Nuevo** para empezar otra conversación.

**Modo cloud (opcional):** marca **Cloud (Cursor Agents)**, envía otra pregunta y comprueba en Cursor → Agents → Filter → Source → SDK que aparece el run. Requiere billing/usage en tu cuenta Cursor.

**App nativa:** con el servidor ya corriendo (`npm start`), en otra terminal:
```bash
npm run app
```
Debería abrirse Cursor Chat con icono en el Dock.

## Notas

- Por defecto corre en **local** sobre este repo.
- Cloud agents requieren usage / billing en tu cuenta Cursor.
