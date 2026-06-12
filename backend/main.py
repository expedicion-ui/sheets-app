from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import gspread
from google.oauth2.service_account import Credentials
import pandas as pd
import io
import re
import difflib
import traceback
from datetime import datetime, timedelta
from reportes import calcular_reporte

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

COLUMNAS_BASE = [
    "DESCARGA", "BUQUE", "PRODUCTO", "CARGA", "MATRÍCULA", "BOLETA",
    "FECHA", "HORA ENTRADA", "HORA SALIDA",
    "BRUTO PUERTO", "TARA PUERTO", "NETO PUERTO",
    "BRUTO PLANTA", "TARA PLANTA", "NETO PLANTA", "NETO",
]

# Rangos esperados para validación de pesos
TARA_MIN, TARA_MAX = 12000, 18000
BRUTO_MIN = 42000  # El camión de saldo puede estar por debajo, se avisa pero no se corrige
BRUTO_MAX = 58000

# Tiempo mínimo (en minutos) entre dos apariciones del mismo camión
MIN_CIRCUIT_MINUTES = 45


def get_sheet(sheet_index=0):
    creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
    client = gspread.authorize(creds)
    spreadsheet = client.open_by_key(SHEET_ID)
    return spreadsheet.get_worksheet(sheet_index)


def extraer_valor(celda: str, prefijo: str) -> str:
    if not isinstance(celda, str):
        return ""
    match = re.search(rf"{prefijo}:\s*(.+)", celda, re.IGNORECASE)
    return match.group(1).strip() if match else celda.strip()


# ---------------------------------------------------------------------------
# CORRECCIÓN 1: Matrículas
# ---------------------------------------------------------------------------

def _parse_datetime(fecha: str, hora: str):
    """Combina FECHA y HORA ENTRADA en un datetime. Retorna None si falla."""
    try:
        return datetime.strptime(f"{fecha} {hora}", "%d/%m/%Y %H:%M")
    except Exception:
        return None


def corregir_matriculas(df: pd.DataFrame, correcciones: list) -> pd.DataFrame:
    """
    Detecta matrículas con una sola aparición y las corrige por la más similar,
    validando que el tiempo de circuito sea coherente.
    """
    df = df.copy()

    # Construir columna de datetime combinando FECHA + HORA ENTRADA
    df["_dt"] = df.apply(
        lambda r: _parse_datetime(str(r["FECHA"]), str(r["HORA ENTRADA"])), axis=1
    )

    freq = df["MATRÍCULA"].value_counts()
    unicas = freq[freq == 1].index.tolist()
    frecuentes = freq[freq > 1].index.tolist()

    for mat in unicas:
        idx = df[df["MATRÍCULA"] == mat].index[0]
        matches = difflib.get_close_matches(mat, frecuentes, n=1, cutoff=0.75)
        if not matches:
            correcciones.append(
                f"MATRÍCULA: '{mat}' aparece solo una vez y no tiene similar — carga {df.loc[idx,'CARGA']} revisar manualmente"
            )
            continue

        candidata = matches[0]
        dt_unica = df.loc[idx, "_dt"]

        if dt_unica is None:
            # Sin datetime no podemos validar tiempo, aplicamos igual
            df.loc[idx, "MATRÍCULA"] = candidata
            correcciones.append(
                f"MATRÍCULA: '{mat}' -> '{candidata}' (carga {df.loc[idx,'CARGA']}, sin validacion horaria)"
            )
            continue

        # Verificar que la candidata no aparezca demasiado cerca en el tiempo
        dts_candidata = df[df["MATRÍCULA"] == candidata]["_dt"].dropna()
        demasiado_cerca = any(
            abs((dt_unica - t).total_seconds()) < MIN_CIRCUIT_MINUTES * 60
            for t in dts_candidata
        )

        if not demasiado_cerca:
            df.loc[idx, "MATRÍCULA"] = candidata
            correcciones.append(
                f"MATRÍCULA: '{mat}' -> '{candidata}' (carga {df.loc[idx,'CARGA']}, "
                f"{df.loc[idx,'FECHA']} {df.loc[idx,'HORA ENTRADA']})"
            )
        else:
            correcciones.append(
                f"MATRÍCULA: '{mat}' similar a '{candidata}' pero el horario es incompatible "
                f"con el circuito — revisar carga {df.loc[idx,'CARGA']} manualmente"
            )

    df.drop(columns=["_dt"], inplace=True)
    return df


# ---------------------------------------------------------------------------
# CORRECCIÓN 2: Boletas
# ---------------------------------------------------------------------------

def corregir_boletas(df: pd.DataFrame, correcciones: list) -> pd.DataFrame:
    """
    Detecta duplicados en boletas y completa huecos de un solo número
    entre cargas consecutivas.
    """
    df = df.copy()

    def to_int(v):
        try:
            return int(str(v).strip())
        except Exception:
            return None

    df["_bol_int"] = df["BOLETA"].apply(to_int)

    # Detectar duplicados
    dup = df["_bol_int"].dropna()
    dup = dup[dup.duplicated(keep=False)]
    for b in dup.unique():
        cargas = df[df["_bol_int"] == b]["CARGA"].tolist()
        cargas_str = ", ".join(f"carga {c}" for c in cargas)
        correcciones.append(f"BOLETA: número {int(b)} duplicado en {cargas_str} — revisar manualmente")

    # Detectar boletas vacías y completar solo cuando el hueco entre
    # la boleta anterior y siguiente es exactamente 1
    mask_vacias = df["_bol_int"].isna()
    for idx in df[mask_vacias].index:
        pos = df.index.get_loc(idx)
        ant = df.iloc[pos - 1]["_bol_int"] if pos > 0 else None
        sig = df.iloc[pos + 1]["_bol_int"] if pos < len(df) - 1 else None

        if ant is not None and sig is not None and sig - ant == 2:
            boleta_nueva = str(int(ant) + 1).zfill(5)
            df.loc[idx, "BOLETA"] = boleta_nueva
            correcciones.append(
                f"BOLETA: completada boleta {boleta_nueva} en carga {df.loc[idx,'CARGA']}"
            )
        else:
            correcciones.append(
                f"BOLETA: vacía en carga {df.loc[idx,'CARGA']} — no se pudo determinar el número"
            )

    df.drop(columns=["_bol_int"], inplace=True)
    return df


# ---------------------------------------------------------------------------
# CORRECCIÓN 3: Pesos
# ---------------------------------------------------------------------------

def corregir_pesos(df: pd.DataFrame, correcciones: list) -> pd.DataFrame:
    """
    Valida BRUTO, TARA y NETO para PUERTO y PLANTA.
    Corrige el NETO cuando BRUTO y TARA son correctos pero NETO no coincide.
    """
    df = df.copy()

    grupos = [
        ("BRUTO PUERTO", "TARA PUERTO", "NETO PUERTO"),
        ("BRUTO PLANTA", "TARA PLANTA", "NETO PLANTA"),
    ]

    for col_bruto, col_tara, col_neto in grupos:
        for idx in df.index:
            try:
                bruto = float(df.loc[idx, col_bruto])
                tara = float(df.loc[idx, col_tara])
                neto = float(df.loc[idx, col_neto])
            except (ValueError, TypeError):
                continue

            carga = df.loc[idx, "CARGA"]
            neto_esperado = bruto - tara

            # Verificar rangos
            tara_ok = TARA_MIN <= tara <= TARA_MAX
            bruto_bajo = bruto < BRUTO_MIN  # posible camión de saldo o error

            # Si BRUTO <= TARA es imposible fisicamente: el BRUTO esta mal cargado
            bruto_invalido = bruto <= tara

            if not tara_ok:
                correcciones.append(
                    f"PESO: carga {carga} - {col_tara} = {tara:.0f} "
                    f"fuera de rango ({TARA_MIN}-{TARA_MAX}) — revisar manualmente"
                )

            if bruto > BRUTO_MAX:
                correcciones.append(
                    f"PESO: carga {carga} - {col_bruto} = {bruto:.0f} "
                    f"inusualmente alto — revisar manualmente"
                )

            if bruto_invalido:
                # Determinar qué valor está mal y sustituir por el equivalente PUERTO
                sufijo = col_bruto.split(" ", 1)[1]  # "PUERTO" o "PLANTA"
                if sufijo == "PLANTA":
                    col_ref_bruto = "BRUTO PUERTO"
                    col_ref_tara = "TARA PUERTO"
                else:
                    col_ref_bruto = "BRUTO PLANTA"
                    col_ref_tara = "TARA PLANTA"

                try:
                    bruto_ref = float(df.loc[idx, col_ref_bruto])
                    tara_ref = float(df.loc[idx, col_ref_tara])
                except (ValueError, TypeError):
                    bruto_ref = tara_ref = None

                if tara_ok and bruto_ref is not None and bruto_ref >= BRUTO_MIN:
                    # TARA es válida, BRUTO es el erróneo → sustituir BRUTO por el de referencia
                    df.loc[idx, col_bruto] = int(bruto_ref)
                    neto_corregido = int(bruto_ref - tara)
                    df.loc[idx, col_neto] = neto_corregido
                    correcciones.append(
                        f"PESO: carga {carga} - {col_bruto} = {bruto:.0f} invalido "
                        f"(igual a TARA) -> sustituido por {col_ref_bruto} = {bruto_ref:.0f}, "
                        f"{col_neto} recalculado = {neto_corregido}"
                    )
                elif not tara_ok and tara_ref is not None and TARA_MIN <= tara_ref <= TARA_MAX:
                    # TARA es inválida, sustituir TARA por la de referencia
                    df.loc[idx, col_tara] = int(tara_ref)
                    neto_corregido = int(bruto - tara_ref)
                    df.loc[idx, col_neto] = neto_corregido
                    correcciones.append(
                        f"PESO: carga {carga} - {col_tara} = {tara:.0f} invalido "
                        f"-> sustituido por {col_ref_tara} = {tara_ref:.0f}, "
                        f"{col_neto} recalculado = {neto_corregido}"
                    )
                else:
                    correcciones.append(
                        f"PESO: carga {carga} - {col_bruto} = {bruto:.0f} es igual "
                        f"a TARA — no se pudo corregir automaticamente, revisar manualmente"
                    )
                continue

            if bruto_bajo:
                correcciones.append(
                    f"PESO: carga {carga} - {col_bruto} = {bruto:.0f} "
                    f"por debajo de {BRUTO_MIN} (posible camion de saldo)"
                )

            # Corregir NETO solo cuando BRUTO y TARA son plausibles
            if abs(neto - neto_esperado) > 10 and tara_ok and not bruto_bajo:
                correcciones.append(
                    f"PESO: carga {carga} - {col_neto} {neto:.0f} -> {neto_esperado:.0f} "
                    f"(BRUTO {bruto:.0f} - TARA {tara:.0f})"
                )
                df.loc[idx, col_neto] = int(neto_esperado)

    return df


# ---------------------------------------------------------------------------
# CORRECCIÓN 4: Fechas anómalas dentro de la descarga
# ---------------------------------------------------------------------------

def detectar_fechas_anomalas(df: pd.DataFrame, correcciones: list) -> None:
    """
    Avisa si algún registro tiene una fecha que difiere más de 48 hs
    del grueso del grupo (percentil 10-90 del archivo).
    No modifica el df — solo agrega avisos a correcciones.
    """
    UMBRAL_HORAS = 48

    dts = df.apply(
        lambda r: _parse_datetime(str(r["FECHA"]), str(r["HORA ENTRADA"])), axis=1
    )
    validos = dts.dropna()
    if len(validos) < 3:
        return

    sorted_dts = sorted(validos)
    n = len(sorted_dts)
    p10 = sorted_dts[max(0, n // 10)]
    p90 = sorted_dts[min(n - 1, 9 * n // 10)]

    for idx, dt in dts.items():
        if dt is None:
            continue
        horas_antes = (p10 - dt).total_seconds() / 3600 if dt < p10 else 0
        horas_despues = (dt - p90).total_seconds() / 3600 if dt > p90 else 0
        desfase = max(horas_antes, horas_despues)
        if desfase > UMBRAL_HORAS:
            carga = df.loc[idx, "CARGA"]
            matricula = df.loc[idx, "MATRÍCULA"]
            fecha = df.loc[idx, "FECHA"]
            hora = df.loc[idx, "HORA ENTRADA"]
            direccion = "antes" if horas_antes > 0 else "después"
            correcciones.append(
                f"FECHA ANOMALA: carga {carga} (matrícula {matricula}) — "
                f"{fecha} {hora} está {int(desfase)} hs {direccion} del resto de la descarga — revisar manualmente"
            )


# ---------------------------------------------------------------------------
# Pipeline principal de procesamiento
# ---------------------------------------------------------------------------

def procesar_xls(contenido: bytes):
    raw = pd.read_excel(io.BytesIO(contenido), header=None)
    correcciones = []

    # Extraer BUQUE y PRODUCTO de A1 y A2
    buque = extraer_valor(str(raw.iloc[0, 0]), "Buque")
    producto = extraer_valor(str(raw.iloc[1, 0]), "Producto")

    # Los datos comienzan en la fila 4 (índice 4)
    df = raw.iloc[4:].copy()
    df.columns = range(len(df.columns))

    # Eliminar fila de TOTAL
    mask_total = df[4].astype(str).str.upper() == "TOTAL"
    if mask_total.sum() > 0:
        df = df[~mask_total]
        correcciones.append("Se eliminó la fila de totales")

    # Eliminar filas completamente vacías
    filas_antes = len(df)
    df.dropna(how="all", inplace=True)
    filas_vacias = filas_antes - len(df)
    if filas_vacias > 0:
        correcciones.append(f"Se eliminaron {filas_vacias} fila(s) completamente vacías")

    # Renombrar columnas
    columnas_datos = [
        "CARGA", "MATRÍCULA", "BOLETA", "FECHA", "HORA ENTRADA", "HORA SALIDA",
        "BRUTO PUERTO", "TARA PUERTO", "NETO PUERTO",
        "BRUTO PLANTA", "TARA PLANTA", "NETO PLANTA", "NETO",
    ]
    df = df.iloc[:, :13].copy()
    df.columns = columnas_datos
    df = df.reset_index(drop=True)

    # Limpiar texto
    for col in ["MATRÍCULA", "BOLETA", "HORA ENTRADA", "HORA SALIDA"]:
        df[col] = df[col].astype(str).str.strip().replace("nan", "")

    # Normalizar FECHA a DD/MM/AAAA
    try:
        df["FECHA"] = pd.to_datetime(df["FECHA"], dayfirst=True).dt.strftime("%d/%m/%Y")
    except Exception:
        correcciones.append("No se pudo normalizar el formato de FECHA — se dejó como estaba")

    # Convertir columnas numéricas
    for col in ["BRUTO PUERTO", "TARA PUERTO", "NETO PUERTO",
                "BRUTO PLANTA", "TARA PLANTA", "NETO PLANTA", "NETO"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # --- Aplicar correcciones ---
    df = corregir_matriculas(df, correcciones)
    df = corregir_boletas(df, correcciones)
    df = corregir_pesos(df, correcciones)
    detectar_fechas_anomalas(df, correcciones)

    # Recalcular NETO final (NETO PLANTA - NETO PUERTO) después de todas las correcciones
    neto_calculado = df["NETO PLANTA"] - df["NETO PUERTO"]
    diferencias = (neto_calculado - df["NETO"]).abs() > 0
    n_ajustes = diferencias.sum()
    if n_ajustes > 0:
        df.loc[diferencias, "NETO"] = neto_calculado[diferencias].astype(int)
        correcciones.append(
            f"NETO final recalculado en {n_ajustes} fila(s) (NETO PLANTA - NETO PUERTO)"
        )

    # Calcular identificador de Descarga usando la fecha de la primera carga
    fecha_inicio = df["FECHA"].iloc[0] if len(df) > 0 else ""
    try:
        mes_anio = datetime.strptime(fecha_inicio, "%d/%m/%Y").strftime("%m/%Y")
    except Exception:
        mes_anio = fecha_inicio
    descarga = f"{producto} - {mes_anio} - {buque}"

    # Agregar columnas identificadoras al inicio
    df.insert(0, "DESCARGA", descarga)
    df.insert(1, "BUQUE", buque)
    df.insert(2, "PRODUCTO", producto)

    # Reemplazar NaN por cadena vacía para evitar errores de serialización
    df = df.fillna("").infer_objects(copy=False)

    if not correcciones:
        correcciones.append("No se encontraron errores — el archivo estaba limpio")

    return df, buque, producto, correcciones


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

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


@app.post("/previsualizar-xls")
async def previsualizar_xls(archivo: UploadFile = File(...)):
    """Procesa el archivo y devuelve todos los datos corregidos sin subir nada."""
    try:
        contenido = await archivo.read()
        df, buque, producto, correcciones = procesar_xls(contenido)
        return {
            "descarga": df["DESCARGA"].iloc[0] if len(df) > 0 else "",
            "buque": buque,
            "producto": producto,
            "total_filas": len(df),
            "correcciones": correcciones,
            "columnas": df.columns.tolist(),
            "datos": df.to_dict(orient="records"),
        }
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/descargas")
def obtener_descargas():
    """
    Devuelve la lista de descargas con metadatos, ordenadas por fecha de
    finalización descendente (la más reciente primero).
    """
    try:
        sheet = get_sheet()
        registros = sheet.get_all_records()
        if not registros:
            return {"descargas": []}

        agrupadas = {}
        for r in registros:
            desc = r.get("DESCARGA", "")
            if not desc:
                continue
            if desc not in agrupadas:
                agrupadas[desc] = {
                    "descarga": desc,
                    "producto": r.get("PRODUCTO", ""),
                    "buque": r.get("BUQUE", ""),
                    "fecha_fin": None,
                }
            # Combinar FECHA + HORA SALIDA para obtener el datetime más tardío
            fecha = r.get("FECHA", "")
            hora_salida = r.get("HORA SALIDA", "")
            if fecha and hora_salida:
                try:
                    dt = datetime.strptime(f"{fecha} {hora_salida}", "%d/%m/%Y %H:%M")
                    actual = agrupadas[desc]["fecha_fin"]
                    if actual is None or dt > actual:
                        agrupadas[desc]["fecha_fin"] = dt
                except Exception:
                    pass

        resultado = sorted(
            agrupadas.values(),
            key=lambda x: x["fecha_fin"] or datetime.min,
            reverse=True,
        )

        # Serializar fecha_fin a string
        for item in resultado:
            item["fecha_fin"] = item["fecha_fin"].strftime("%d/%m/%Y %H:%M") if item["fecha_fin"] else None

        return {"descargas": resultado}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/subir-datos")
async def subir_datos(payload: dict):
    """Sube datos ya procesados y editados manualmente."""
    try:
        filas = payload.get("filas", [])
        if not filas:
            raise HTTPException(status_code=400, detail="No hay filas para subir.")

        reemplazar = payload.get("reemplazar", False)
        sheet = get_sheet()
        todos = sheet.get_all_values()
        descarga = filas[0][0] if filas and filas[0] else ""

        if reemplazar and descarga:
            # Eliminar filas existentes de esta descarga (sin tocar el encabezado)
            # Los índices son 1-based en Sheets (fila 1 = encabezado)
            indices_borrar = sorted([
                i + 2 for i, fila in enumerate(todos[1:])
                if fila and fila[0] == descarga
            ])
            # Borrar en bloques contiguos con una sola llamada por bloque
            # para no superar el rate limit de la API de Google Sheets
            if indices_borrar:
                bloques = []
                inicio = indices_borrar[0]
                fin = indices_borrar[0]
                for idx in indices_borrar[1:]:
                    if idx == fin + 1:
                        fin = idx
                    else:
                        bloques.append((inicio, fin))
                        inicio = fin = idx
                bloques.append((inicio, fin))
                for bloque_inicio, bloque_fin in reversed(bloques):
                    sheet.delete_rows(bloque_inicio, bloque_fin)

        todos_actualizado = sheet.get_all_values()
        if len(todos_actualizado) == 0:
            sheet.append_row(COLUMNAS_BASE)

        sheet.append_rows(filas, value_input_option="USER_ENTERED")

        return {
            "exito": True,
            "descarga": descarga,
            "filas_agregadas": len(filas),
            "reemplazada": reemplazar,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/reportes/{descarga:path}")
def obtener_reporte(descarga: str):
    """Devuelve todos los indicadores calculados para una descarga específica."""
    try:
        sheet = get_sheet()
        todos = sheet.get_all_records()
        registros = [r for r in todos if r.get("DESCARGA") == descarga]
        if not registros:
            raise HTTPException(status_code=404, detail=f"Descarga '{descarga}' no encontrada")
        reporte = calcular_reporte(registros, todos_los_registros=todos)
        return {"descarga": descarga, **reporte}
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/subir-xls")
async def subir_xls(archivo: UploadFile = File(...)):
    try:
        contenido = await archivo.read()
        df, buque, producto, correcciones = procesar_xls(contenido)

        sheet = get_sheet()
        filas_existentes = len(sheet.get_all_values())

        if filas_existentes == 0:
            sheet.append_row(COLUMNAS_BASE)

        todas_las_filas = df.values.tolist()
        sheet.append_rows(todas_las_filas, value_input_option="USER_ENTERED")

        return {
            "exito": True,
            "descarga": df["DESCARGA"].iloc[0] if len(df) > 0 else "",
            "buque": buque,
            "producto": producto,
            "filas_agregadas": len(df),
            "correcciones": correcciones,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
