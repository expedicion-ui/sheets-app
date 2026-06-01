from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import gspread
from google.oauth2.service_account import Credentials
import pandas as pd
import io
import os

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SHEET_ID = "1erWd7G09YGsspg5Gln23VfaBQtiEAP2lZdOmyHT6D4Q"
CREDENTIALS_FILE = "credentials.json"
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

def get_sheet(sheet_index=0):
    creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
    client = gspread.authorize(creds)
    spreadsheet = client.open_by_key(SHEET_ID)
    return spreadsheet.get_worksheet(sheet_index)

@app.get("/")
def root():
    return {"status": "ok", "mensaje": "API de sheets-app funcionando"}

@app.get("/datos")
def obtener_datos():
    try:
        sheet = get_sheet()
        registros = sheet.get_all_records()
        return {"total": len(registros), "datos": registros}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/hojas")
def obtener_hojas():
    try:
        creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
        client = gspread.authorize(creds)
        spreadsheet = client.open_by_key(SHEET_ID)
        hojas = [{"id": i, "nombre": ws.title} for i, ws in enumerate(spreadsheet.worksheets())]
        return {"hojas": hojas}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/subir-xls")
async def subir_xls(archivo: UploadFile = File(...)):
    try:
        contenido = await archivo.read()
        df = pd.read_excel(io.BytesIO(contenido))

        # Reporte de correcciones
        correcciones = []

        # 1. Eliminar filas completamente vacías
        filas_antes = len(df)
        df.dropna(how="all", inplace=True)
        filas_vacias = filas_antes - len(df)
        if filas_vacias > 0:
            correcciones.append(f"Se eliminaron {filas_vacias} fila(s) completamente vacías")

        # 2. Rellenar celdas vacías con vacío explícito
        df.fillna("", inplace=True)

        # 3. Limpiar espacios en texto
        for col in df.select_dtypes(include="object").columns:
            df[col] = df[col].astype(str).str.strip()
            df[col] = df[col].replace("nan", "")

        # 4. Eliminar columnas sin nombre
        cols_sin_nombre = [c for c in df.columns if str(c).startswith("Unnamed")]
        if cols_sin_nombre:
            df.drop(columns=cols_sin_nombre, inplace=True)
            correcciones.append(f"Se eliminaron {len(cols_sin_nombre)} columna(s) sin nombre")

        if not correcciones:
            correcciones.append("No se encontraron errores — el archivo estaba limpio")

        # Subir a Google Sheets
        sheet = get_sheet()
        filas_existentes = len(sheet.get_all_values())

        # Si la hoja está vacía, escribir encabezados
        if filas_existentes == 0:
            sheet.append_row(df.columns.tolist())

        # Agregar los datos
        for _, fila in df.iterrows():
            sheet.append_row(fila.tolist())

        return {
            "exito": True,
            "filas_agregadas": len(df),
            "correcciones": correcciones,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
