"""
Lógica de cálculo de indicadores para el reporte individual de descarga.
"""

from datetime import datetime, timedelta
import pandas as pd


UMBRAL_DESCANSO_HORAS = 4
INTERVALO_HORAS = 3


def _parse_dt(fecha: str, hora: str):
    """Combina FECHA (DD/MM/YYYY) y HORA (HH:MM) en un datetime. Retorna None si falla."""
    try:
        return datetime.strptime(f"{fecha} {hora}", "%d/%m/%Y %H:%M")
    except Exception:
        return None


def calcular_reporte(registros: list[dict], todos_los_registros: list[dict] | None = None) -> dict:
    """
    Recibe los registros de una descarga y devuelve todos los indicadores.
    todos_los_registros se usa para calcular la comparativa histórica del mismo producto.
    """
    df = _preparar_df(registros)

    resultado = {
        **_indicadores_generales(df),
        **_indicadores_flota(df),
    }

    if todos_los_registros:
        producto = df["PRODUCTO"].iloc[0] if len(df) > 0 else ""
        descarga_actual = df["DESCARGA"].iloc[0] if len(df) > 0 else ""
        resultado["comparativa_producto"] = _comparativa_producto(
            todos_los_registros, producto, descarga_actual
        )

    return resultado


def _preparar_df(registros: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(registros)
    for col in ["BRUTO PUERTO", "TARA PUERTO", "NETO PUERTO",
                "BRUTO PLANTA", "TARA PLANTA", "NETO PLANTA", "NETO"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["_dt_entrada"] = df.apply(
        lambda r: _parse_dt(str(r["FECHA"]), str(r["HORA ENTRADA"])), axis=1
    )
    df["_dt_salida"] = df.apply(
        lambda r: _parse_dt(str(r["FECHA"]), str(r["HORA SALIDA"])), axis=1
    )
    return df


# ---------------------------------------------------------------------------
# Grupo 1 — Indicadores generales
# ---------------------------------------------------------------------------

def _indicadores_generales(df: pd.DataFrame) -> dict:
    neto_planta = df["NETO PLANTA"].dropna()
    neto_puerto = df["NETO PUERTO"].dropna()

    total_neto_planta = round(neto_planta.sum() / 1000, 3)
    total_neto_puerto = round(neto_puerto.sum() / 1000, 3)
    diferencia_puerto_planta = round(total_neto_planta - total_neto_puerto, 3)
    diferencia_porcentaje = (
        round(diferencia_puerto_planta / total_neto_planta * 100, 2)
        if total_neto_planta != 0 else None
    )

    cantidad_cargas = len(df)
    peso_promedio = round(neto_planta.mean() / 1000, 3) if len(neto_planta) > 0 else None

    fechas_validas = df["_dt_entrada"].dropna()
    fecha_inicio = fechas_validas.min().strftime("%d/%m/%Y %H:%M") if len(fechas_validas) > 0 else None
    fecha_fin_dt = df["_dt_salida"].dropna()
    fecha_fin = fecha_fin_dt.max().strftime("%d/%m/%Y %H:%M") if len(fecha_fin_dt) > 0 else None

    duracion_dias = None
    if len(fechas_validas) > 0 and len(fecha_fin_dt) > 0:
        delta = fecha_fin_dt.max() - fechas_validas.min()
        duracion_dias = round(delta.total_seconds() / 86400, 1)

    cargas_por_fecha = (
        df.dropna(subset=["_dt_entrada"])
        .assign(fecha=lambda x: x["_dt_entrada"].dt.strftime("%d/%m/%Y"))
        .groupby("fecha")
        .size()
        .reset_index(name="cargas")
        .to_dict(orient="records")
    )

    return {
        "generales": {
            "total_toneladas_netas": total_neto_planta,
            "diferencia_puerto_planta_tn": diferencia_puerto_planta,
            "diferencia_porcentaje": diferencia_porcentaje,
            "cantidad_cargas": cantidad_cargas,
            "peso_promedio_por_carga_tn": peso_promedio,
            "fecha_inicio": fecha_inicio,
            "fecha_fin": fecha_fin,
            "duracion_dias": duracion_dias,
            "cargas_por_fecha": cargas_por_fecha,
        }
    }


# ---------------------------------------------------------------------------
# Grupo 2 — Flota y demoras
# ---------------------------------------------------------------------------

def _indicadores_flota(df: pd.DataFrame) -> dict:
    matriculas_unicas = df["MATRÍCULA"].nunique()

    detalle_por_matricula = _calcular_detalle_matriculas(df)
    demora_planta_min, demora_fuera_planta_min, periodos_sin_camiones = _calcular_demoras(df)

    total_min_sin_camiones = round(
        sum(p["duracion_min"] for p in periodos_sin_camiones), 1
    )

    serie_circuito, serie_planta = _series_temporales(df)

    return {
        "flota": {
            "matriculas_unicas": matriculas_unicas,
            "detalle_por_matricula": detalle_por_matricula,
            "demora_promedio_dentro_planta_min": demora_planta_min,
            "demora_promedio_fuera_planta_min": demora_fuera_planta_min,
            "total_minutos_sin_camiones_en_planta": total_min_sin_camiones,
            "periodos_sin_camiones_en_planta": periodos_sin_camiones,
            "grafico_camiones_en_circuito": serie_circuito,
            "grafico_camiones_en_planta": serie_planta,
        }
    }


def _calcular_detalle_matriculas(df: pd.DataFrame) -> list:
    """
    Por cada matrícula devuelve:
      - cargas: cantidad de viajes
      - demora_promedio_planta_min: promedio de (HORA SALIDA - HORA ENTRADA)
      - demora_promedio_fuera_planta_min: promedio de gaps < 4h entre viajes consecutivos
      - diferencia_netos_promedio_kg: promedio de (NETO PLANTA - NETO PUERTO), con signo
    """
    df_valid = df.dropna(subset=["_dt_entrada", "_dt_salida"]).copy()
    df_valid["_dur_planta"] = (
        df_valid["_dt_salida"] - df_valid["_dt_entrada"]
    ).dt.total_seconds() / 60
    df_valid = df_valid[df_valid["_dur_planta"] >= 0]

    resultado = []
    for mat, grupo in df.groupby("MATRÍCULA"):
        cargas = len(grupo)

        # Demora en planta
        grupo_valid = df_valid[df_valid["MATRÍCULA"] == mat]
        dem_planta = (
            round(grupo_valid["_dur_planta"].mean(), 1)
            if len(grupo_valid) > 0 else None
        )

        # Demora fuera de planta
        grupo_es = df.dropna(subset=["_dt_entrada", "_dt_salida"])
        grupo_mat = grupo_es[grupo_es["MATRÍCULA"] == mat].sort_values("_dt_entrada")
        entradas = grupo_mat["_dt_entrada"].tolist()
        salidas = grupo_mat["_dt_salida"].tolist()
        gaps = []
        for i in range(len(salidas) - 1):
            gap_h = (entradas[i + 1] - salidas[i]).total_seconds() / 3600
            if 0 < gap_h < UMBRAL_DESCANSO_HORAS:
                gaps.append(gap_h * 60)
        dem_fuera = round(sum(gaps) / len(gaps), 1) if gaps else None

        # Diferencia netos promedio (NETO PLANTA - NETO PUERTO)
        dif_netos = grupo["NETO PLANTA"].dropna() - grupo["NETO PUERTO"].dropna()
        dif_netos_promedio = round(dif_netos.mean(), 1) if len(dif_netos) > 0 else None

        resultado.append({
            "matricula": mat,
            "cargas": cargas,
            "demora_promedio_planta_min": dem_planta,
            "demora_promedio_fuera_planta_min": dem_fuera,
            "diferencia_netos_promedio_kg": dif_netos_promedio,
        })

    resultado.sort(key=lambda x: x["cargas"], reverse=True)
    return resultado


def _calcular_demoras(df: pd.DataFrame) -> tuple:
    df_valid = df.dropna(subset=["_dt_entrada", "_dt_salida"]).copy()
    df_valid["_duracion_planta"] = (
        df_valid["_dt_salida"] - df_valid["_dt_entrada"]
    ).dt.total_seconds() / 60
    df_valid = df_valid[df_valid["_duracion_planta"] >= 0]
    demora_planta = round(df_valid["_duracion_planta"].mean(), 1) if len(df_valid) > 0 else None

    intervalos_fuera = []
    for mat, grupo in df.dropna(subset=["_dt_entrada", "_dt_salida"]).groupby("MATRÍCULA"):
        grupo = grupo.sort_values("_dt_entrada")
        entradas = grupo["_dt_entrada"].tolist()
        salidas = grupo["_dt_salida"].tolist()
        for i in range(len(salidas) - 1):
            gap = (entradas[i + 1] - salidas[i]).total_seconds() / 3600
            if 0 < gap < UMBRAL_DESCANSO_HORAS:
                intervalos_fuera.append(gap * 60)

    demora_fuera = round(sum(intervalos_fuera) / len(intervalos_fuera), 1) if intervalos_fuera else None
    periodos_sin_camiones = _detectar_periodos_sin_camiones(df_valid)

    return demora_planta, demora_fuera, periodos_sin_camiones


def _detectar_periodos_sin_camiones(df: pd.DataFrame) -> list:
    if len(df) == 0:
        return []

    eventos = []
    for _, row in df.iterrows():
        eventos.append((row["_dt_entrada"], "entrada"))
        eventos.append((row["_dt_salida"], "salida"))
    eventos.sort(key=lambda x: x[0])

    periodos = []
    camiones_en_planta = 0
    ultimo_vacio = None

    for dt, tipo in eventos:
        if tipo == "entrada":
            if camiones_en_planta == 0 and ultimo_vacio is not None:
                duracion = (dt - ultimo_vacio).total_seconds() / 60
                if duracion > 1:
                    periodos.append({
                        "desde": ultimo_vacio.strftime("%d/%m/%Y %H:%M"),
                        "hasta": dt.strftime("%d/%m/%Y %H:%M"),
                        "duracion_min": round(duracion, 1),
                    })
            camiones_en_planta += 1
        else:
            camiones_en_planta = max(0, camiones_en_planta - 1)
            if camiones_en_planta == 0:
                ultimo_vacio = dt

    return periodos


def _series_temporales(df: pd.DataFrame) -> tuple:
    """
    Snapshots puntuales cada INTERVALO_HORAS horas.
    Planta:   matrículas con _dt_entrada <= T <= _dt_salida
    Circuito: matrículas cuyo rango activo cubre T
    """
    df_e = df.dropna(subset=["_dt_entrada"])
    df_es = df.dropna(subset=["_dt_entrada", "_dt_salida"]).copy()

    if len(df_e) == 0:
        return [], []

    t_inicio = df_e["_dt_entrada"].min().replace(minute=0, second=0, microsecond=0)
    t_fin_base = df_e["_dt_entrada"].max()
    if len(df_es) > 0:
        t_fin_base = max(t_fin_base, df_es["_dt_salida"].max())
    t_fin = t_fin_base.replace(minute=0, second=0, microsecond=0) + timedelta(hours=INTERVALO_HORAS)

    snapshots = []
    t = t_inicio
    while t <= t_fin:
        snapshots.append(t)
        t += timedelta(hours=INTERVALO_HORAS)

    rangos_activos = _rangos_activos_por_matricula(df)
    filas_planta = [
        (row["MATRÍCULA"], row["_dt_entrada"], row["_dt_salida"])
        for _, row in df_es.iterrows()
    ]

    serie_circuito = []
    serie_planta = []

    for t in snapshots:
        label = t.strftime("%d/%m/%Y %H:%M")
        en_circuito = sum(
            1 for rangos in rangos_activos.values()
            if any(r[0] <= t <= r[1] for r in rangos)
        )
        mats_en_planta = {
            mat for mat, entrada, salida in filas_planta
            if entrada <= t <= salida
        }
        serie_circuito.append({"hora": label, "camiones": en_circuito})
        serie_planta.append({"hora": label, "camiones": len(mats_en_planta)})

    return serie_circuito, serie_planta


def _rangos_activos_por_matricula(df: pd.DataFrame) -> dict:
    rangos = {}
    df_valid = df.dropna(subset=["_dt_entrada"]).copy()

    for mat, grupo in df_valid.groupby("MATRÍCULA"):
        grupo = grupo.sort_values("_dt_entrada")
        entradas = grupo["_dt_entrada"].tolist()
        salidas = grupo["_dt_salida"].tolist() if "_dt_salida" in grupo.columns else [None] * len(entradas)

        mat_rangos = []
        segmento_inicio = entradas[0]
        segmento_fin = salidas[0] if salidas[0] else entradas[0]

        for i in range(1, len(entradas)):
            entrada_sig = entradas[i]
            salida_sig = salidas[i] if salidas[i] else entradas[i]
            gap = (entrada_sig - segmento_fin).total_seconds() / 3600
            if gap >= UMBRAL_DESCANSO_HORAS:
                mat_rangos.append((segmento_inicio, segmento_fin))
                segmento_inicio = entrada_sig
                segmento_fin = salida_sig
            else:
                segmento_fin = max(segmento_fin, salida_sig)

        mat_rangos.append((segmento_inicio, segmento_fin))
        rangos[mat] = mat_rangos

    return rangos


# ---------------------------------------------------------------------------
# Comparativa histórica — últimas 5 descargas del mismo producto
# ---------------------------------------------------------------------------

def _indicadores_resumen(registros: list[dict]) -> dict:
    """
    Calcula los indicadores clave resumidos para una descarga (usado en comparativa).
    """
    df = _preparar_df(registros)

    neto_planta = df["NETO PLANTA"].dropna()
    neto_puerto = df["NETO PUERTO"].dropna()
    total_tn = round(neto_planta.sum() / 1000, 3)
    dif_tn = round(total_tn - round(neto_puerto.sum() / 1000, 3), 3)
    dif_pct = round(dif_tn / total_tn * 100, 2) if total_tn != 0 else None

    matriculas = df["MATRÍCULA"].nunique()

    _, demora_fuera, periodos = _calcular_demoras(df)
    df_valid = df.dropna(subset=["_dt_entrada", "_dt_salida"]).copy()
    df_valid["_dur"] = (df_valid["_dt_salida"] - df_valid["_dt_entrada"]).dt.total_seconds() / 60
    df_valid = df_valid[df_valid["_dur"] >= 0]
    demora_planta = round(df_valid["_dur"].mean(), 1) if len(df_valid) > 0 else None
    total_sin_camiones = round(sum(p["duracion_min"] for p in periodos), 1)

    return {
        "total_toneladas_netas": total_tn,
        "diferencia_puerto_planta_tn": dif_tn,
        "diferencia_porcentaje": dif_pct,
        "matriculas_unicas": matriculas,
        "demora_promedio_dentro_planta_min": demora_planta,
        "demora_promedio_fuera_planta_min": demora_fuera,
        "total_minutos_sin_camiones_en_planta": total_sin_camiones,
    }


def _fecha_fin_descarga(registros: list[dict]):
    """Devuelve el datetime máximo de HORA SALIDA para ordenar descargas."""
    mejor = None
    for r in registros:
        dt = _parse_dt(str(r.get("FECHA", "")), str(r.get("HORA SALIDA", "")))
        if dt and (mejor is None or dt > mejor):
            mejor = dt
    return mejor or datetime.min


def _comparativa_producto(todos: list[dict], producto: str, descarga_actual: str) -> list:
    """
    Devuelve los indicadores clave de las últimas 5 descargas del mismo producto,
    excluyendo la descarga actual, ordenadas de más reciente a más antigua.
    """
    # Agrupar registros por descarga
    agrupados: dict[str, list] = {}
    for r in todos:
        desc = r.get("DESCARGA", "")
        prod = r.get("PRODUCTO", "")
        if prod == producto and desc and desc != descarga_actual:
            agrupados.setdefault(desc, []).append(r)

    # Ordenar por fecha_fin descendente y tomar las 5 más recientes
    ordenadas = sorted(
        agrupados.items(),
        key=lambda x: _fecha_fin_descarga(x[1]),
        reverse=True,
    )[:5]

    resultado = []
    for desc, regs in ordenadas:
        indicadores = _indicadores_resumen(regs)
        resultado.append({"descarga": desc, **indicadores})

    return resultado
