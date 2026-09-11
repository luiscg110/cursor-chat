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

Opcional: marca **También en Cursor Agents** para ver el run en Cursor (Agents → Filter → Source → SDK).

## Notas

- Por defecto corre en **local** sobre este repo.
- Cloud agents requieren usage / billing en tu cuenta Cursor.
