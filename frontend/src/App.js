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

export default function App() {
  const [archivo, setArchivo] = useState(null);
  const [estado, setEstado] = useState('idle'); // idle | previsualizando | preview | subiendo | exito | error
  const [preview, setPreview] = useState(null);
  const [resultado, setResultado] = useState(null);
  const [mensajeError, setMensajeError] = useState('');

  const onDrop = useCallback((archivosAceptados) => {
    if (archivosAceptados.length > 0) {
      setArchivo(archivosAceptados[0]);
      setEstado('idle');
      setPreview(null);
      setResultado(null);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
               'application/vnd.ms-excel': ['.xls'] },
    multiple: false,
  });

  const previsualizar = async () => {
    if (!archivo) return;
    setEstado('previsualizando');
    setMensajeError('');
    try {
      const form = new FormData();
      form.append('archivo', archivo);
      const { data } = await axios.post(`${API}/previsualizar-xls`, form);
      setPreview(data);
      setEstado('preview');
    } catch (e) {
      setMensajeError(e.response?.data?.detail || 'Error al conectar con el servidor.');
      setEstado('error');
    }
  };

  const subir = async () => {
    if (!archivo) return;
    setEstado('subiendo');
    setMensajeError('');
    try {
      const form = new FormData();
      form.append('archivo', archivo);
      const { data } = await axios.post(`${API}/subir-xls`, form);
      setResultado(data);
      setEstado('exito');
    } catch (e) {
      setMensajeError(e.response?.data?.detail || 'Error al subir el archivo.');
      setEstado('error');
    }
  };

  const reiniciar = () => {
    setArchivo(null);
    setEstado('idle');
    setPreview(null);
    setResultado(null);
    setMensajeError('');
  };

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
          <h2>Seleccionar archivo</h2>
          {!archivo ? (
            <div {...getRootProps()} className={`dropzone${isDragActive ? ' active' : ''}`}>
              <input {...getInputProps()} />
              <div className="dropzone-icon">📂</div>
              <p>Arrastrá el archivo acá o hacé clic para seleccionarlo</p>
              <p className="hint">Formatos aceptados: .xlsx, .xls</p>
            </div>
          ) : (
            <div className="file-selected">
              📄 {archivo.name}
              <button className="btn btn-ghost" style={{ marginLeft: 'auto', padding: '6px 14px' }} onClick={reiniciar}>
                Cambiar
              </button>
            </div>
          )}

          {archivo && estado === 'idle' && (
            <div className="btn-row">
              <button className="btn btn-primary" onClick={previsualizar}>
                Analizar archivo
              </button>
            </div>
          )}

          {estado === 'previsualizando' && (
            <div className="btn-row">
              <button className="btn btn-primary" disabled>
                <span className="spinner" /> Analizando...
              </button>
            </div>
          )}
        </div>
      )}

      {/* Resultado de previsualización */}
      {estado === 'preview' && preview && (
        <>
          <div className="card">
            <h2>Resumen del archivo</h2>
            <div className="resumen">
              <div className="resumen-item" style={{ flexBasis: '100%' }}>
                <div className="label">Descarga</div>
                <div className="value" style={{ fontSize: 15 }}>{preview.descarga}</div>
              </div>
              <div className="resumen-item">
                <div className="label">Cargas a subir</div>
                <div className="value">{preview.total_filas}</div>
              </div>
              <div className="resumen-item">
                <div className="label">Correcciones</div>
                <div className="value">{preview.correcciones.length}</div>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Correcciones detectadas</h2>
            <ListaCorrecciones correcciones={preview.correcciones} />
          </div>

          <div className="card">
            <h2>Vista previa — primeras 5 filas</h2>
            <TablaPreview filas={preview.preview} />
            <div className="btn-row">
              <button className="btn btn-success" onClick={subir} disabled={estado === 'subiendo'}>
                Confirmar y subir a Google Sheets
              </button>
              <button className="btn btn-ghost" onClick={reiniciar}>
                Cancelar
              </button>
            </div>
          </div>
        </>
      )}

      {/* Subiendo */}
      {estado === 'subiendo' && (
        <div className="card">
          <div className="btn-row" style={{ justifyContent: 'center', padding: '20px 0' }}>
            <button className="btn btn-success" disabled>
              <span className="spinner" /> Subiendo a Google Sheets...
            </button>
          </div>
        </div>
      )}

      {/* Exito */}
      {estado === 'exito' && resultado && (
        <div className="card">
          <div className="exito-banner">
            <div className="check">✅</div>
            <h2>{resultado.filas_agregadas} cargas subidas correctamente</h2>
            <p>{resultado.descarga}</p>
          </div>
          <ListaCorrecciones correcciones={resultado.correcciones} />
          <div className="btn-row" style={{ justifyContent: 'center', marginTop: 24 }}>
            <button className="btn btn-primary" onClick={reiniciar}>
              Subir otro archivo
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
          <button className="btn btn-ghost" onClick={() => setEstado(archivo ? 'idle' : 'idle')}>
            Volver a intentar
          </button>
        </div>
      )}
    </div>
  );
}
