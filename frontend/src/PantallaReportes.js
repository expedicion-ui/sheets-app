import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import axios from 'axios';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from 'recharts';

const API = 'http://localhost:8001';

// ── Helpers ─────────────────────────────────────────────────────────────────

function num(v, decimals = 2) {
  if (v === null || v === undefined) return '—';
  return Number(v).toLocaleString('es-AR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function parseFechaFin(str) {
  if (!str) return null;
  const [fecha] = str.split(' ');
  const [d, m, y] = fecha.split('/');
  return new Date(`${y}-${m}-${d}`);
}

function tickFormatter(str) {
  if (!str) return '';
  const parts = str.split(' ');
  const fechaParts = parts[0].split('/');
  return `${fechaParts[0]}/${fechaParts[1]} ${parts[1] || ''}`.trim();
}

// ── Combobox con búsqueda ─────────────────────────────────────────────────────

function Combobox({ opciones, valor, onChange, placeholder }) {
  const [texto, setTexto] = useState(valor || '');
  const [abierto, setAbierto] = useState(false);
  const ref = useRef(null);

  useEffect(() => { setTexto(valor || ''); }, [valor]);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setAbierto(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtradas = useMemo(() =>
    opciones.filter(o => o.toLowerCase().includes(texto.toLowerCase())),
    [opciones, texto]
  );

  const seleccionar = useCallback((opcion) => {
    setTexto(opcion);
    onChange(opcion);
    setAbierto(false);
  }, [onChange]);

  const limpiar = useCallback(() => {
    setTexto('');
    onChange('');
    setAbierto(false);
  }, [onChange]);

  const handleChange = (e) => {
    setTexto(e.target.value);
    onChange('');
    setAbierto(true);
  };

  const handleBlur = () => {
    // Si el texto escrito coincide exactamente con una opción, la seleccionamos
    const exacta = opciones.find(o => o.toLowerCase() === texto.toLowerCase());
    if (exacta) { onChange(exacta); setTexto(exacta); }
    else if (!valor) setTexto('');
  };

  return (
    <div ref={ref} className="combobox-wrap">
      <input
        className="filtro-input combobox-input"
        value={texto}
        placeholder={placeholder}
        onChange={handleChange}
        onFocus={() => setAbierto(true)}
        onBlur={handleBlur}
      />
      {texto && (
        <button className="combobox-clear" onMouseDown={limpiar} tabIndex={-1}>✕</button>
      )}
      {abierto && filtradas.length > 0 && (
        <ul className="combobox-lista">
          {filtradas.map(o => (
            <li key={o} onMouseDown={() => seleccionar(o)} className={o === valor ? 'activo' : ''}>
              {o}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Semáforo ──────────────────────────────────────────────────────────────────

/**
 * Compara `valor` contra `promedio` y devuelve un círculo de color.
 * mejorEsMenor: true para demoras y tiempo sin camiones, false para diferencia %.
 * Umbral: ±5% del promedio → amarillo; fuera → verde/rojo.
 */
function Semaforo({ valor, promedio, mejorEsMenor }) {
  if (valor === null || valor === undefined || promedio === null || promedio === undefined) return null;

  let color;
  const umbral = Math.abs(promedio) * 0.05;
  const diff = valor - promedio;

  if (Math.abs(diff) <= umbral) {
    color = '#d97706'; // amarillo
  } else if ((mejorEsMenor && diff < 0) || (!mejorEsMenor && diff > 0)) {
    color = '#009661'; // verde
  } else {
    color = '#DC291E'; // rojo
  }

  return (
    <span style={{
      display: 'inline-block',
      width: 9, height: 9,
      borderRadius: '50%',
      background: color,
      marginLeft: 6,
      flexShrink: 0,
      verticalAlign: 'middle',
    }} title={`Promedio histórico: ${promedio}`} />
  );
}

// ── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, unit, sub }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">
        {value}
        {unit && <span className="kpi-unit"> {unit}</span>}
      </div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

// ── Gráfico comparativo ───────────────────────────────────────────────────────

const tooltipFlota = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const enPlanta = payload.find(p => p.dataKey === 'planta')?.value ?? 0;
  const fuera    = payload.find(p => p.dataKey === 'fuera')?.value ?? 0;
  const total    = enPlanta + fuera;
  const pct      = total > 0 ? Math.round(enPlanta / total * 100) : 0;
  return (
    <div style={{ background: '#fff', border: '1px solid #e0ede8', borderRadius: 6, padding: '8px 12px', fontSize: 12 }}>
      <p style={{ fontWeight: 600, marginBottom: 4, color: '#1a1a1a' }}>{label}</p>
      <p style={{ color: '#d97706' }}>En planta: {enPlanta}</p>
      <p style={{ color: '#009661' }}>Fuera (en circuito): {fuera}</p>
      <p style={{ color: '#666', marginTop: 4 }}>Total en circuito: {total} · {pct}% en planta</p>
    </div>
  );
};

function GraficosFlota({ circuito, planta }) {
  const data = circuito.map((p, i) => {
    const enPlanta = planta[i]?.camiones ?? 0;
    return {
      hora:   p.hora,
      planta: enPlanta,
      fuera:  Math.max(0, p.camiones - enPlanta),
    };
  });
  const tickInterval = Math.max(0, Math.floor(data.length / 8) - 1);

  return (
    <div className="graficos-wrap">
      <p className="grafico-titulo">Distribución de camiones activos</p>
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 40 }}>
          <defs>
            <linearGradient id="gradPlanta" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#d97706" stopOpacity={0.9} />
              <stop offset="95%" stopColor="#d97706" stopOpacity={0.6} />
            </linearGradient>
            <linearGradient id="gradFuera" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#b2d8c8" stopOpacity={0.9} />
              <stop offset="95%" stopColor="#b2d8c8" stopOpacity={0.5} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e0ede8" />
          <XAxis
            dataKey="hora"
            tickFormatter={tickFormatter}
            interval={tickInterval}
            angle={-40}
            textAnchor="end"
            tick={{ fontSize: 11, fill: '#666' }}
            height={60}
          />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#666' }} width={30} />
          <Tooltip content={tooltipFlota} />
          <Legend
            formatter={(v) => v === 'planta' ? 'En planta (descargando)' : 'Fuera de planta (en circuito)'}
            wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
          />
          <Area type="monotone" dataKey="planta" stackId="1" stroke="#d97706" strokeWidth={1.5} fill="url(#gradPlanta)" />
          <Area type="monotone" dataKey="fuera"  stackId="1" stroke="#009661" strokeWidth={1.5} fill="url(#gradFuera)"  />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Vista del reporte ─────────────────────────────────────────────────────────

function VistaReporte({ descarga, onVolver }) {
  const [reporte, setReporte] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const reporteRef = useRef(null);

  useEffect(() => {
    setCargando(true);
    setError('');
    axios.get(`${API}/reportes/${encodeURIComponent(descarga)}`)
      .then(r => setReporte(r.data))
      .catch(e => setError(e.response?.data?.detail || 'Error al cargar el reporte.'))
      .finally(() => setCargando(false));
  }, [descarga]);

  const exportarPDF = () => {
    document.title = descarga;
    window.print();
    setTimeout(() => { document.title = 'ISUSA — Control de Descargas'; }, 500);
  };

  if (cargando) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 48 }}>
        <span className="spinner spinner-dark" /> Cargando reporte...
      </div>
    );
  }
  if (error) {
    return (
      <div className="card">
        <div className="correccion-item error"><span className="dot" />{error}</div>
        <div className="btn-row"><button className="btn btn-ghost" onClick={onVolver}>Volver</button></div>
      </div>
    );
  }

  const g = reporte.generales;
  const f = reporte.flota;
  const comp = reporte.comparativa_producto || [];

  return (
    <div ref={reporteRef}>
      {/* Encabezado */}
      <div className="card print-card">
        <div className="reporte-header">
          <div>
            <span className="tag tag-ok no-print">Reporte</span>
            <h2 style={{ marginTop: 6 }} translate="no">{descarga}</h2>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }} className="no-print">
            <button className="btn btn-ghost btn-sm" onClick={exportarPDF}>⬇ Exportar PDF</button>
            <button className="btn btn-ghost btn-sm" onClick={onVolver}>← Volver</button>
          </div>
        </div>
      </div>

      {/* Grupo 1: Indicadores generales */}
      <div className="card print-card">
        <h2>Indicadores generales</h2>
        <div className="reporte-fechas">
          {g.fecha_inicio && <span><strong>Inicio:</strong> {g.fecha_inicio}</span>}
          {g.fecha_fin    && <span><strong>Fin:</strong> {g.fecha_fin}</span>}
          {g.duracion_dias !== null && <span><strong>Duración:</strong> {g.duracion_dias} días</span>}
        </div>
        <div className="kpi-grid">
          <KpiCard label="Toneladas netas (planta)" value={num(g.total_toneladas_netas)} unit="tn" />
          <KpiCard
            label="Diferencia puerto / planta"
            value={num(g.diferencia_puerto_planta_tn)}
            unit="tn"
            sub={
              g.diferencia_porcentaje !== null
                ? `${num(g.diferencia_porcentaje)}% del neto · ${g.diferencia_puerto_planta_tn >= 0 ? 'Ganancia' : 'Merma'} en tránsito`
                : (g.diferencia_puerto_planta_tn >= 0 ? 'Ganancia en tránsito' : 'Merma en tránsito')
            }
          />
          <KpiCard label="Total de viajes" value={g.cantidad_cargas} />
          <KpiCard label="Peso promedio por viaje" value={num(g.peso_promedio_por_carga_tn)} unit="tn" />
        </div>

        {g.cargas_por_fecha?.length > 1 && (
          <div style={{ marginTop: 20 }}>
            <p className="kpi-label" style={{ marginBottom: 10 }}>Viajes por fecha</p>
            <div className="tabla-compacta">
              <table>
                <thead><tr><th>Fecha</th><th>Viajes</th></tr></thead>
                <tbody>
                  {g.cargas_por_fecha.map(r => (
                    <tr key={r.fecha}><td>{r.fecha}</td><td>{r.cargas}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Comparativa histórica */}
      {comp.length > 0 && (() => {
        const partes = descarga.split(' - ');
        const productoNombre = partes.length >= 3 ? partes.slice(0, partes.length - 2).join(' - ') : descarga;

        const abreviarDescarga = (d) => {
          const p = d.split(' - ');
          return p.length >= 3 ? p.slice(p.length - 2).join(' - ') : d;
        };

        const avg = (campo) => {
          const vals = comp.map(c => c[campo]).filter(v => v !== null && v !== undefined);
          return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        };
        const prom = {
          dif_pct:     avg('diferencia_porcentaje'),
          matriculas:  avg('matriculas_unicas'),
          dem_planta:  avg('demora_promedio_dentro_planta_min'),
          dem_fuera:   avg('demora_promedio_fuera_planta_min'),
          sin_cam:     avg('total_minutos_sin_camiones_en_planta'),
        };

        const actual = {
          descarga,
          total_toneladas_netas:              g.total_toneladas_netas,
          diferencia_puerto_planta_tn:        g.diferencia_puerto_planta_tn,
          diferencia_porcentaje:              g.diferencia_porcentaje,
          matriculas_unicas:                  f.matriculas_unicas,
          demora_promedio_dentro_planta_min:  f.demora_promedio_dentro_planta_min,
          demora_promedio_fuera_planta_min:   f.demora_promedio_fuera_planta_min,
          total_minutos_sin_camiones_en_planta: f.total_minutos_sin_camiones_en_planta,
        };

        const FilaComparativa = ({ c, esActual }) => (
          <tr className={esActual ? 'fila-actual-comparativa' : ''}>
            <td translate="no" style={{ fontWeight: esActual ? 700 : 500 }}>
              {esActual ? '▶ ' : ''}{abreviarDescarga(c.descarga)}
            </td>
            <td>{num(c.total_toneladas_netas)}</td>
            <td>
              <span>{num(c.diferencia_puerto_planta_tn)} tn</span>
              {c.diferencia_porcentaje !== null && (
                <span className="kpi-sub" style={{ display: 'block' }}>
                  {num(c.diferencia_porcentaje)}%
                  {esActual && <Semaforo valor={c.diferencia_porcentaje} promedio={prom.dif_pct} mejorEsMenor={false} />}
                </span>
              )}
            </td>
            <td>{c.matriculas_unicas}</td>
            <td>
              {c.demora_promedio_dentro_planta_min !== null ? num(c.demora_promedio_dentro_planta_min, 0) + ' min' : '—'}
              {esActual && <Semaforo valor={c.demora_promedio_dentro_planta_min} promedio={prom.dem_planta} mejorEsMenor={true} />}
            </td>
            <td>
              {c.demora_promedio_fuera_planta_min !== null ? num(c.demora_promedio_fuera_planta_min, 0) + ' min' : '—'}
              {esActual && <Semaforo valor={c.demora_promedio_fuera_planta_min} promedio={prom.dem_fuera} mejorEsMenor={true} />}
            </td>
            <td>
              {num(c.total_minutos_sin_camiones_en_planta, 0)} min
              {esActual && <Semaforo valor={c.total_minutos_sin_camiones_en_planta} promedio={prom.sin_cam} mejorEsMenor={true} />}
            </td>
          </tr>
        );

        return (
          <div className="card print-card">
            <h2>
              Comparativa — últimas {comp.length} descargas de {productoNombre}
            </h2>
            <div className="tabla-compacta tabla-comparativa">
              <table>
                <thead>
                  <tr>
                    <th>Fecha / Buque</th>
                    <th>Tn netas</th>
                    <th>Dif. pto/planta</th>
                    <th>Camiones</th>
                    <th>Dem. planta</th>
                    <th>Dem. fuera</th>
                    <th>Sin camiones</th>
                  </tr>
                </thead>
                <tbody>
                  <FilaComparativa c={actual} esActual={true} />
                  <tr className="separador-comparativa"><td colSpan={7} /></tr>
                  {comp.map((c, i) => <FilaComparativa key={i} c={c} esActual={false} />)}
                </tbody>
              </table>
            </div>
            <div className="semaforo-leyenda">
              <span className="semaforo-leyenda-titulo">Sistema de semáforos:</span>
              <span><span className="dot-semaforo verde" /> Mejor que el promedio histórico (&gt;5%)</span>
              <span><span className="dot-semaforo amarillo" /> En el promedio histórico (±5%)</span>
              <span><span className="dot-semaforo rojo" /> Peor que el promedio histórico (&gt;5%)</span>
            </div>
          </div>
        );
      })()}

      {/* Grupo 2: Flota y demoras */}
      <div className="card print-card print-nueva-pagina">
        <h2>Flota y demoras</h2>
        <div className="kpi-grid">
          <KpiCard label="Matrículas únicas" value={f.matriculas_unicas} unit="camiones" />
          <KpiCard label="Demora promedio en planta" value={num(f.demora_promedio_dentro_planta_min, 0)} unit="min" />
          <KpiCard label="Demora promedio fuera de planta" value={num(f.demora_promedio_fuera_planta_min, 0)} unit="min" />
          <KpiCard
            label="Tiempo sin camiones en planta"
            value={num(f.total_minutos_sin_camiones_en_planta, 0)}
            unit="min"
            sub={`${f.periodos_sin_camiones_en_planta?.length ?? 0} períodos`}
          />
        </div>

        {/* Detalle por matrícula */}
        <div style={{ marginTop: 20 }}>
          <p className="kpi-label" style={{ marginBottom: 10 }}>Detalle por matrícula</p>
          <div className="tabla-compacta">
            <table>
              <thead>
                <tr>
                  <th>Matrícula</th>
                  <th>Viajes</th>
                  <th>Dem. planta (min)</th>
                  <th>Dem. fuera planta (min)</th>
                  <th>Dif. netos prom. (tn)</th>
                </tr>
              </thead>
              <tbody>
                {f.detalle_por_matricula.map(r => (
                  <tr key={r.matricula}>
                    <td translate="no">{r.matricula}</td>
                    <td>{r.cargas}</td>
                    <td>{r.demora_promedio_planta_min !== null ? num(r.demora_promedio_planta_min, 1) : '—'}</td>
                    <td>{r.demora_promedio_fuera_planta_min !== null ? num(r.demora_promedio_fuera_planta_min, 1) : '—'}</td>
                    <td style={{ color: r.diferencia_netos_promedio_kg >= 0 ? '#005738' : '#9b1c1c' }}>
                      {r.diferencia_netos_promedio_kg !== null
                        ? (r.diferencia_netos_promedio_kg >= 0 ? '+' : '') + num(r.diferencia_netos_promedio_kg / 1000, 3)
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Períodos sin camiones */}
        {f.periodos_sin_camiones_en_planta?.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <p className="kpi-label" style={{ marginBottom: 10 }}>
              Períodos sin camiones en planta ({f.periodos_sin_camiones_en_planta.length})
            </p>
            <div className="tabla-compacta">
              <table>
                <thead><tr><th>Desde</th><th>Hasta</th><th>Duración</th></tr></thead>
                <tbody>
                  {f.periodos_sin_camiones_en_planta.map((p, i) => (
                    <tr key={i}><td>{p.desde}</td><td>{p.hasta}</td><td>{p.duracion_min} min</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Gráficos */}
        {f.grafico_camiones_en_circuito?.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <GraficosFlota
              circuito={f.grafico_camiones_en_circuito}
              planta={f.grafico_camiones_en_planta}
            />
          </div>
        )}
      </div>

    </div>
  );
}

// ── Selector de descarga ──────────────────────────────────────────────────────

export default function PantallaReportes() {
  const [descargas, setDescargas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [seleccionada, setSeleccionada] = useState(null);

  const [filtroProducto, setFiltroProducto] = useState('');
  const [filtroBuque, setFiltroBuque] = useState('');
  const [filtroFechaDesde, setFiltroFechaDesde] = useState('');
  const [filtroFechaHasta, setFiltroFechaHasta] = useState('');

  useEffect(() => {
    axios.get(`${API}/descargas`)
      .then(r => setDescargas(r.data.descargas))
      .catch(e => setError(e.response?.data?.detail || 'Error al cargar descargas.'))
      .finally(() => setCargando(false));
  }, []);

  const productos = useMemo(() =>
    [...new Set(descargas.map(d => d.producto).filter(Boolean))].sort(), [descargas]);
  const buques = useMemo(() =>
    [...new Set(descargas.map(d => d.buque).filter(Boolean))].sort(), [descargas]);

  const descargasFiltradas = useMemo(() => {
    return descargas.filter(d => {
      if (filtroProducto && d.producto !== filtroProducto) return false;
      if (filtroBuque && d.buque !== filtroBuque) return false;
      if (filtroFechaDesde || filtroFechaHasta) {
        const dt = parseFechaFin(d.fecha_fin);
        if (filtroFechaDesde && dt < new Date(filtroFechaDesde)) return false;
        if (filtroFechaHasta) {
          const hasta = new Date(filtroFechaHasta);
          hasta.setHours(23, 59, 59);
          if (dt > hasta) return false;
        }
      }
      return true;
    });
  }, [descargas, filtroProducto, filtroBuque, filtroFechaDesde, filtroFechaHasta]);

  const limpiarFiltros = () => {
    setFiltroProducto(''); setFiltroBuque('');
    setFiltroFechaDesde(''); setFiltroFechaHasta('');
  };
  const hayFiltros = filtroProducto || filtroBuque || filtroFechaDesde || filtroFechaHasta;

  if (seleccionada) {
    return <VistaReporte descarga={seleccionada} onVolver={() => setSeleccionada(null)} />;
  }

  return (
    <>
      <div className="card">
        <h2>Reportes</h2>
        <p className="preview-subtitulo" style={{ marginBottom: 16 }}>
          Seleccioná una descarga para ver el reporte. Ordenadas por fecha de finalización, más reciente primero.
        </p>
        <div className="filtros-wrap">
          <Combobox
            opciones={productos}
            valor={filtroProducto}
            onChange={setFiltroProducto}
            placeholder="Buscar producto..."
          />
          <Combobox
            opciones={buques}
            valor={filtroBuque}
            onChange={setFiltroBuque}
            placeholder="Buscar buque..."
          />
          <input type="date" className="filtro-input" value={filtroFechaDesde} onChange={e => setFiltroFechaDesde(e.target.value)} title="Fecha de finalización desde" />
          <input type="date" className="filtro-input" value={filtroFechaHasta} onChange={e => setFiltroFechaHasta(e.target.value)} title="Fecha de finalización hasta" />
          {hayFiltros && <button className="btn btn-ghost btn-sm" onClick={limpiarFiltros}>Limpiar filtros</button>}
        </div>

        {cargando && <div style={{ padding: '24px 0', textAlign: 'center', color: '#888' }}><span className="spinner spinner-dark" /> Cargando descargas...</div>}
        {error && <div className="correccion-item error" style={{ marginTop: 12 }}><span className="dot" />{error}</div>}
        {!cargando && !error && descargasFiltradas.length === 0 && (
          <p className="preview-subtitulo" style={{ marginTop: 12 }}>No hay descargas que coincidan con los filtros.</p>
        )}
      </div>

      {!cargando && descargasFiltradas.map(d => (
        <button key={d.descarga} className="descarga-item" onClick={() => setSeleccionada(d.descarga)}>
          <div className="descarga-item-main">
            <span className="descarga-nombre" translate="no">{d.descarga}</span>
          </div>
          <div className="descarga-item-meta">
            {d.fecha_fin && <span>Fin: {d.fecha_fin}</span>}
            <span className="descarga-arrow">→</span>
          </div>
        </button>
      ))}
    </>
  );
}
