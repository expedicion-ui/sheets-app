import { useState, useCallback, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import axios from 'axios';
import logoIsusa from './logo-isusa.png';
import './App.css';

const API = 'http://localhost:8001';
const STORAGE_KEY = 'isusa_pendientes';

// ── Helpers ────────────────────────────────────────────────────────────────

function clasificar(texto) {
  const t = texto.toLowerCase();
  if (t.includes('revisar manualmente') || t.includes('duplicado') || t.includes('invalido')) return 'error';
  if (t.includes('posible') || t.includes('no se pudo') || t.includes('fuera de rango')) return 'aviso';
  if (t.includes('no se encontraron errores') || t.includes('estaba limpio')) return 'ok';
  return 'info';
}

function cargarPendientes() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}

function guardarPendientes(lista) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(lista));
}

// ── Componentes pequeños ────────────────────────────────────────────────────

function ListaCorrecciones({ correcciones }) {
  return (
    <ul className="correcciones-list">
      {correcciones.map((c, i) => (
        <li key={i} className={`correccion-item ${clasificar(c)}`}>
          <span className="dot" />{c}
        </li>
      ))}
    </ul>
  );
}

// ── Tabla editable ──────────────────────────────────────────────────────────

const COLS_NUMERICAS = ['CARGA','BRUTO PUERTO','TARA PUERTO','NETO PUERTO','BRUTO PLANTA','TARA PLANTA','NETO PLANTA','NETO'];

function extraerCargasConError(correcciones) {
  const cargas = new Set();
  correcciones.forEach(c => {
    // Busca patrones como "carga 94", "carga 208", "en carga 307"
    const matches = c.matchAll(/carga\s+(\d+)/gi);
    for (const m of matches) cargas.add(Number(m[1]));
    // También captura matrículas corregidas que no siempre mencionan carga explícita
    if (c.toLowerCase().includes('revisar manualmente')) {
      const m = c.match(/carga\s+(\d+)/i);
      if (m) cargas.add(Number(m[1]));
    }
  });
  return cargas;
}

function TablaEditable({ columnas, datos, correcciones, onChange }) {
  const [editando, setEditando] = useState(null);
  const [valorEdit, setValorEdit] = useState('');

  const cargasConError = extraerCargasConError(correcciones);

  const filaEditable = (fila) => cargasConError.has(Number(fila['CARGA']));

  const iniciarEdit = (fi, col) => {
    setEditando({ fi, col });
    setValorEdit(String(datos[fi][col] ?? ''));
  };

  const confirmarEdit = () => {
    if (!editando) return;
    const { fi, col } = editando;
    const nuevos = datos.map((r, i) => {
      if (i !== fi) return r;
      const val = COLS_NUMERICAS.includes(col) ? (Number(valorEdit) || valorEdit) : valorEdit;
      const fila = { ...r, [col]: val };
      // Recalcular NETs si se editó BRUTO o TARA
      if (['BRUTO PUERTO','TARA PUERTO'].includes(col)) {
        fila['NETO PUERTO'] = (Number(fila['BRUTO PUERTO']) || 0) - (Number(fila['TARA PUERTO']) || 0);
      }
      if (['BRUTO PLANTA','TARA PLANTA'].includes(col)) {
        fila['NETO PLANTA'] = (Number(fila['BRUTO PLANTA']) || 0) - (Number(fila['TARA PLANTA']) || 0);
      }
      if (['NETO PUERTO','NETO PLANTA','BRUTO PUERTO','TARA PUERTO','BRUTO PLANTA','TARA PLANTA'].includes(col)) {
        fila['NETO'] = (Number(fila['NETO PLANTA']) || 0) - (Number(fila['NETO PUERTO']) || 0);
      }
      return fila;
    });
    onChange(nuevos);
    setEditando(null);
  };

  const cols = columnas.filter(c => c !== 'DESCARGA' && c !== 'BUQUE' && c !== 'PRODUCTO');

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{cols.map(c => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {datos.map((fila, fi) => {
            const editable = filaEditable(fila);
            return (
              <tr key={fi} className={editable ? 'fila-con-error' : ''}>
                {cols.map(col => {
                  const esEditando = editando?.fi === fi && editando?.col === col;
                  return (
                    <td
                      key={col}
                      className={esEditando ? 'celda-editando' : editable ? 'celda-editable' : ''}
                      title={editable ? 'Clic para editar' : ''}
                      onClick={() => editable && !esEditando && iniciarEdit(fi, col)}
                    >
                      {esEditando ? (
                        <input
                          className="input-celda"
                          value={valorEdit}
                          autoFocus
                          onChange={e => setValorEdit(e.target.value)}
                          onBlur={confirmarEdit}
                          onKeyDown={e => { if (e.key === 'Enter') confirmarEdit(); if (e.key === 'Escape') setEditando(null); }}
                        />
                      ) : (
                        String(fila[col] ?? '')
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── PreviewCard ─────────────────────────────────────────────────────────────

function PreviewCard({ item, onSubir, onPosponer, onEliminar, modoReview = false }) {
  const [expandida, setExpandida] = useState(modoReview);
  const [datos, setDatos] = useState(item.datos);
  const [subiendo, setSubiendo] = useState(false);
  const [exito, setExito] = useState(false);

  const handleSubir = async () => {
    setSubiendo(true);
    try {
      const filas = datos.map(r => item.columnas.map(c => r[c] ?? ''));
      await onSubir(filas, item.descarga);
      setExito(true);
    } finally {
      setSubiendo(false);
    }
  };

  if (exito) {
    return (
      <div className="card card-exito">
        <div className="preview-card-header">
          <div>
            <span className="tag tag-ok">✓ Subida</span>
            <h2 style={{ marginTop: 6 }}>{item.descarga}</h2>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`card ${modoReview ? 'card-review' : ''}`}>
      <div className="preview-card-header">
        <div>
          {modoReview && <span className="tag tag-pendiente">Pendiente de revisión</span>}
          <h2 style={{ marginTop: modoReview ? 6 : 0 }}>{item.descarga}</h2>
          <span className="preview-subtitulo">
            {item.total_filas} cargas · {item.correcciones.length} corrección/es
            {item.fechaAgregada && ` · guardado ${new Date(item.fechaAgregada).toLocaleDateString()}`}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setExpandida(!expandida)}>
            {expandida ? 'Ocultar' : 'Ver detalle'}
          </button>
        </div>
      </div>

      {expandida && (
        <div style={{ marginTop: 16 }}>
          <ListaCorrecciones correcciones={item.correcciones} />
          <p className="preview-subtitulo" style={{ margin: '14px 0 8px', fontWeight: 600 }}>
            Datos procesados — hacé clic en una celda para editar:
          </p>
          <TablaEditable columnas={item.columnas} datos={datos} correcciones={item.correcciones} onChange={setDatos} />
        </div>
      )}

      <div className="btn-row">
        <button className="btn btn-success" onClick={handleSubir} disabled={subiendo}>
          {subiendo ? <><span className="spinner" /> Subiendo...</> : 'Subir a Google Sheets'}
        </button>
        {!modoReview && (
          <button className="btn btn-ghost" onClick={() => onPosponer(item)}>
            Guardar para revisión
          </button>
        )}
        {modoReview && (
          <button className="btn btn-danger" onClick={() => onEliminar(item.id)}>
            Descartar
          </button>
        )}
      </div>
    </div>
  );
}

// ── App principal ───────────────────────────────────────────────────────────

export default function App() {
  const [pantalla, setPantalla] = useState('inicio'); // inicio | carga | pendientes
  const [archivos, setArchivos] = useState([]);
  const [estado, setEstado] = useState('idle');
  const [previews, setPreviews] = useState([]);
  const [mensajeError, setMensajeError] = useState('');
  const [progreso, setProgreso] = useState({ actual: 0, total: 0 });
  const [pendientes, setPendientes] = useState(cargarPendientes);

  useEffect(() => { guardarPendientes(pendientes); }, [pendientes]);

  const onDrop = useCallback((aceptados) => {
    if (aceptados.length > 0) {
      setArchivos(aceptados);
      setEstado('idle');
      setPreviews([]);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls'],
    },
    multiple: true,
  });

  const analizar = async () => {
    setEstado('analizando');
    setMensajeError('');
    setProgreso({ actual: 0, total: archivos.length });
    try {
      const resultados = [];
      for (let i = 0; i < archivos.length; i++) {
        setProgreso({ actual: i + 1, total: archivos.length });
        const form = new FormData();
        form.append('archivo', archivos[i]);
        const { data } = await axios.post(`${API}/previsualizar-xls`, form);
        resultados.push({ ...data, nombre: archivos[i].name });
      }
      setPreviews(resultados);
      setEstado('preview');
    } catch (e) {
      setMensajeError(e.response?.data?.detail || 'Error al analizar los archivos.');
      setEstado('error');
    }
  };

  const subirDescarga = async (filas, descarga) => {
    await axios.post(`${API}/subir-datos`, { filas });
    setPreviews(prev => prev.filter(p => p.descarga !== descarga));
  };

  const posponerDescarga = (item) => {
    const nueva = {
      ...item,
      id: `${item.descarga}-${Date.now()}`,
      fechaAgregada: new Date().toISOString(),
    };
    setPendientes(prev => [...prev, nueva]);
    setPreviews(prev => prev.filter(p => p.descarga !== item.descarga));
  };

  const subirPendiente = async (filas, descarga) => {
    await axios.post(`${API}/subir-datos`, { filas });
    setPendientes(prev => prev.filter(p => p.descarga !== descarga));
  };

  const descartarPendiente = (id) => {
    setPendientes(prev => prev.filter(p => p.id !== id));
  };

  const reiniciar = () => {
    setArchivos([]);
    setEstado('idle');
    setPreviews([]);
    setMensajeError('');
  };

  // ── Render ──

  return (
    <div className="app">
      {/* Header */}
      <div className="app-header">
        <img src={logoIsusa} alt="ISUSA" className="app-header-logo" />
        <div style={{ flex: 1 }}>
          <h1>ISUSA — Control de Descargas</h1>
          <p>Carga archivos de romaneo y sincronizalos con Google Sheets</p>
        </div>
        <nav className="app-nav">
          <button className={`nav-btn ${pantalla === 'inicio' ? 'active' : ''}`} onClick={() => { setPantalla('inicio'); reiniciar(); }}>
            Nueva carga
          </button>
          <button className={`nav-btn ${pantalla === 'pendientes' ? 'active' : ''}`} onClick={() => setPantalla('pendientes')}>
            Pendientes de revisión {pendientes.length > 0 && <span className="badge">{pendientes.length}</span>}
          </button>
        </nav>
      </div>

      {/* ── Pantalla: Nueva carga ── */}
      {pantalla === 'inicio' && (
        <>
          <div className="card">
            <h2>Seleccionar archivos</h2>
            {archivos.length === 0 ? (
              <div {...getRootProps()} className={`dropzone${isDragActive ? ' active' : ''}`}>
                <input {...getInputProps()} />
                <div className="dropzone-icon">📂</div>
                <p>Arrastrá uno o varios archivos acá, o hacé clic para seleccionarlos</p>
                <p className="hint">Formatos aceptados: .xlsx, .xls · Podés seleccionar múltiples archivos</p>
              </div>
            ) : (
              <div className="archivos-lista">
                {archivos.map((a, i) => (
                  <div key={i} className="file-selected">📄 {a.name}</div>
                ))}
                <button className="btn btn-ghost" style={{ marginTop: 10, alignSelf: 'flex-start' }} onClick={reiniciar}>
                  Cambiar archivos
                </button>
              </div>
            )}

            {archivos.length > 0 && estado === 'idle' && (
              <div className="btn-row">
                <button className="btn btn-primary" onClick={analizar}>
                  Analizar {archivos.length > 1 ? `${archivos.length} archivos` : 'archivo'}
                </button>
              </div>
            )}

            {estado === 'analizando' && (
              <div className="btn-row">
                <button className="btn btn-primary" disabled>
                  <span className="spinner" /> Analizando {progreso.actual} de {progreso.total}...
                </button>
              </div>
            )}

            {estado === 'error' && (
              <div className="correccion-item error" style={{ marginTop: 16 }}>
                <span className="dot" />{mensajeError}
              </div>
            )}
          </div>

          {estado === 'preview' && previews.length > 0 && (
            <>
              <div className="card">
                <h2>Resumen</h2>
                <div className="resumen">
                  <div className="resumen-item">
                    <div className="label">Archivos analizados</div>
                    <div className="value">{previews.length}</div>
                  </div>
                  <div className="resumen-item">
                    <div className="label">Total de cargas</div>
                    <div className="value">{previews.reduce((s, p) => s + p.total_filas, 0)}</div>
                  </div>
                </div>
                <p className="preview-subtitulo">
                  Revisá cada descarga, editá los valores si es necesario, y elegí si subir ahora o guardar para revisión.
                </p>
              </div>

              {previews.map((p, i) => (
                <PreviewCard
                  key={i}
                  item={p}
                  onSubir={subirDescarga}
                  onPosponer={posponerDescarga}
                />
              ))}

              {previews.length === 0 && (
                <div className="card">
                  <div className="exito-banner">
                    <div className="check">✅</div>
                    <h2>Todas las descargas fueron procesadas</h2>
                    <p>Podés cargar más archivos o revisar los pendientes.</p>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── Pantalla: Pendientes ── */}
      {pantalla === 'pendientes' && (
        <>
          {pendientes.length === 0 ? (
            <div className="card">
              <div className="exito-banner">
                <div className="check" style={{ fontSize: 40 }}>📋</div>
                <h2>No hay descargas pendientes</h2>
                <p>Las descargas que guardes para revisión aparecerán aquí.</p>
              </div>
            </div>
          ) : (
            <>
              <div className="card">
                <h2>Descargas pendientes de revisión</h2>
                <p className="preview-subtitulo">
                  {pendientes.length} descarga{pendientes.length > 1 ? 's' : ''} esperando revisión.
                  Revisá los datos, editá si es necesario, y subí cuando estén listos.
                </p>
              </div>
              {pendientes.map((p) => (
                <PreviewCard
                  key={p.id}
                  item={p}
                  onSubir={subirPendiente}
                  onEliminar={descartarPendiente}
                  modoReview={true}
                />
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
