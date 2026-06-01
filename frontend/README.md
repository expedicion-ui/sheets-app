# sheets-app

Aplicación web para subir archivos Excel y sincronizarlos automáticamente con Google Sheets.

## ¿Qué hace?

- Sube archivos `.xlsx` desde el navegador
- Limpia los datos automáticamente (filas vacías, columnas sin nombre, espacios extra)
- Escribe los datos directamente en una hoja de Google Sheets
- Muestra un reporte de las correcciones aplicadas

## Estructura

```
sheets-app/
├── backend/   # API en FastAPI (Python)
└── frontend/  # Interfaz en React
```

## Cómo correrlo

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

La API queda disponible en `http://localhost:8000`.

### Frontend

```bash
cd frontend
npm install
npm start
```

La app queda disponible en `http://localhost:3000`.

## Endpoints del backend

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/` | Estado de la API |
| GET | `/datos` | Obtiene todos los registros de la hoja |
| GET | `/hojas` | Lista las hojas disponibles |
| POST | `/subir-xls` | Sube un archivo Excel y lo sincroniza |

## Requisitos

- Python 3.9+
- Node.js 16+
- Credenciales de Google Service Account en `backend/credentials.json`
