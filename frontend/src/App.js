import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import axios from 'axios';
import logoIsusa from './logo-isusa.png';
import './App.css';

const API = 'http://localhost:8001';

function clasificarCorreccion(texto) {
  const t = texto.toLowerCase();
  if (t.includes('revisar manualmente') || t.includes('duplicado') || t.includes('invalido'))
    return 'error';
  if (t.includes('posible') || t.includes('no se pudo') || t.includes('fuera de rango'))
    return 'aviso';
  if (t.includes('no se encontraron errores') || t.includes('estaba limpio'))
    return 'ok';
  return 'info';
}

function ListaCorrecciones({ correcciones }) {
  return (
    <ul className="correcciones-list">
      {correcciones.map((c, i) => {
        const tipo = clasificarCorreccion(c);
        return (
          <li key={i} className={`correccion-item ${tipo}`}>
            <span className="dot" />
            {c}
          </li>
        );
      })}
    </ul>
  );
}

function TablaPreview({ filas }) {
  if (!filas || filas.length === 0) return null;
  const cols = Object.keys(filas[0]);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{cols.map(c => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {filas.map((fila, i) => (
            <tr key={i}>
              {cols.map(c => <td key={c}>{String(fila[c] ?? '')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PreviewCard({ p, index, total }) {
  const [expandida, setExpandida] = useState(false);
  return (
    <div className="card">
      <div className="preview-card-header">
        <div>
          <h2>{p.descarga}</h2>
          <span className="preview-subtitulo">{p.total_filas} cargas · {p.correcciones.length} corrección/es</span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setExpandida(!expandida)}>
          {expandida ? 'Ocultar detalle' : 'Ver detalle'}
        </button>
      </div>

      {expandida && (
        <>
          <div style={{ marginTop: 16 }}>
            <ListaCorrecciones correcciones={p.correcciones} />
          </div>
          <div style={{ marginTop: 16 }}>
            <p className="preview-subtitulo" style={{ marginBottom: 8 }}>Primeras 5 filas:</p>
            <TablaPreview filas={p.preview} />
          </div>
        </>
      )}
    </div>
  );
}

export default function App() {
  const [archivos, setArchivos] = useState([]);
  const [estado, setEstado] = useState('idle');
  const [previews, setPreviews] = useState([]);
  const [resultados, setResultados] = useState([]);
  const [mensajeError, setMensajeError] = useState('');
  const [progreso, setProgreso] = useState({ actual: 0, total: 0 });

  const onDrop = useCallback((aceptados) => {
    if (aceptados.length > 0) {
      setArchivos(aceptados);
      setEstado('idle');
      setPreviews([]);
      setResultados([]);
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

  const previsualizar = async () => {
    setEstado('previsualizando');
    setMensajeError('');
    setProgreso({ actual: 0, total: archivos.length });
    try {
      const resultadosPrev = [];
      for (let i = 0; i < archivos.length; i++) {
        setProgreso({ actual: i + 1, total: archivos.length });
        const form = new FormData();
        form.append('archivo', archivos[i]);
        const { data } = await axios.post(`${API}/previsualizar-xls`, form);
        resultadosPrev.push({ ...data, nombre: archivos[i].name });
      }
      setPreviews(resultadosPrev);
      setEstado('preview');
    } catch (e) {
      setMensajeError(e.response?.data?.detail || 'Error al analizar los archivos.');
      setEstado('error');
    }
  };

  const subir = async () => {
    setEstado('subiendo');
    setMensajeError('');
    setProgreso({ actual: 0, total: archivos.length });
    try {
      const resultadosSubida = [];
      for (let i = 0; i < archivos.length; i++) {
        setProgreso({ actual: i + 1, total: archivos.length });
        const form = new FormData();
        form.append('archivo', archivos[i]);
        const { data } = await axios.post(`${API}/subir-xls`, form);
        resultadosSubida.push({ ...data, nombre: archivos[i].name });
      }
      setResultados(resultadosSubida);
      setEstado('exito');
    } catch (e) {
      setMensajeError(e.response?.data?.detail || 'Error al subir los archivos.');
      setEstado('error');
    }
  };

  const reiniciar = () => {
    setArchivos([]);
    setEstado('idle');
    setPreviews([]);
    setResultados([]);
    setMensajeError('');
    setProgreso({ actual: 0, total: 0 });
  };

  const totalCargas = resultados.reduce((s, r) => s + r.filas_agregadas, 0);

  return (
    <div className="app">
      <div className="app-header">
        <img src={logoIsusa} alt="ISUSA" className="app-header-logo" />
        <div>
          <h1>ISUSA — Control de Descargas</h1>
          <p>Carga archivos de romaneo y sincronizalos con Google Sheets</p>
        </div>
      </div>

      {/* Zona de carga */}
      {estado !== 'exito' && (
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
                <div key={i} className="file-selected">
                  📄 {a.name}
                </div>
              ))}
              <button className="btn btn-ghost" style={{ marginTop: 10 }} onClick={reiniciar}>
                Cambiar archivos
              </button>
            </div>
          )}

          {archivos.length > 0 && estado === 'idle' && (
            <div className="btn-row">
              <button className="btn btn-primary" onClick={previsualizar}>
                Analizar {archivos.length > 1 ? `${archivos.length} archivos` : 'archivo'}
              </button>
            </div>
          )}

          {estado === 'previsualizando' && (
            <div className="btn-row">
              <button className="btn btn-primary" disabled>
                <span className="spinner" />
                Analizando {progreso.actual} de {progreso.total}...
              </button>
            </div>
          )}
        </div>
      )}

      {/* Previsualizaciones */}
      {estado === 'preview' && previews.length > 0 && (
        <>
          <div className="card">
            <h2>Resumen</h2>
            <div className="resumen">
              <div className="resumen-item">
                <div className="label">Descargas a subir</div>
                <div className="value">{previews.length}</div>
              </div>
              <div className="resumen-item">
                <div className="label">Total de cargas</div>
                <div className="value">{previews.reduce((s, p) => s + p.total_filas, 0)}</div>
              </div>
              <div className="resumen-item">
                <div className="label">Correcciones totales</div>
                <div className="value">{previews.reduce((s, p) => s + p.correcciones.length, 0)}</div>
              </div>
            </div>
            <div className="btn-row">
              <button className="btn btn-success" onClick={subir}>
                Confirmar y subir todo a Google Sheets
              </button>
              <button className="btn btn-ghost" onClick={reiniciar}>Cancelar</button>
            </div>
          </div>

          {previews.map((p, i) => (
            <PreviewCard key={i} p={p} index={i} total={previews.length} />
          ))}
        </>
      )}

      {/* Subiendo */}
      {estado === 'subiendo' && (
        <div className="card">
          <div className="btn-row" style={{ justifyContent: 'center', padding: '24px 0' }}>
            <button className="btn btn-success" disabled>
              <span className="spinner" />
              Subiendo {progreso.actual} de {progreso.total}...
            </button>
          </div>
        </div>
      )}

      {/* Éxito */}
      {estado === 'exito' && resultados.length > 0 && (
        <div className="card">
          <div className="exito-banner">
            <div className="check">✅</div>
            <h2>{resultados.length} descarga{resultados.length > 1 ? 's' : ''} subida{resultados.length > 1 ? 's' : ''} correctamente</h2>
            <p>{totalCargas} cargas registradas en Google Sheets</p>
          </div>
          <div style={{ marginTop: 20 }}>
            {resultados.map((r, i) => (
              <div key={i} className="correccion-item ok" style={{ marginBottom: 8 }}>
                <span className="dot" />
                <strong>{r.descarga}</strong> — {r.filas_agregadas} cargas
              </div>
            ))}
          </div>
          <div className="btn-row" style={{ justifyContent: 'center', marginTop: 24 }}>
            <button className="btn btn-primary" onClick={reiniciar}>
              Subir más archivos
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {estado === 'error' && (
        <div className="card">
          <div className="correccion-item error" style={{ marginBottom: 16 }}>
            <span className="dot" />
            {mensajeError}
          </div>
          <button className="btn btn-ghost" onClick={() => setEstado('idle')}>
            Volver a intentar
          </button>
        </div>
      )}
    </div>
  );
}
