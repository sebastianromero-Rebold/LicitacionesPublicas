/**
 * Licitaciones Rebold — backend en Google Apps Script (sin Google Cloud).
 *
 * Guarda el flujo de cada licitación (decisión, aprobaciones, requisitos, propuesta,
 * radicación y resultado) en una Google Sheet, y los documentos en Google Drive:
 *   Licitaciones Rebold/
 *     Biblioteca/                 documentos reutilizables (RUP, cámara, antecedentes…)
 *     <Entidad · referencia>/     una carpeta por licitación
 *
 * Propiedades del script (Configuración del proyecto → Propiedades del script):
 *   TEAM_CODE   código que el equipo escribe en la app (obligatorio)
 *   SHEET_ID    (opcional) id de una Sheet existente; si no está, se crea una
 *   FOLDER_ID   (opcional) id de la carpeta raíz en Drive; si no está, se crea
 *
 * Despliegue: Implementar → Nueva implementación → Aplicación web →
 *   Ejecutar como: yo · Quién tiene acceso: cualquier persona.
 * Cada cambio de este archivo requiere "Administrar implementaciones → Nueva versión".
 */
const VERSION = '1.0.0';
const P = PropertiesService.getScriptProperties();

/**
 * Ejecutar UNA vez desde el editor (botón ▶ Ejecutar) antes de implementar:
 * pide los permisos de Sheets y Drive y crea la hoja y la carpeta "Licitaciones Rebold".
 */
function inicializar() {
  if (!P.getProperty('TEAM_CODE')) throw new Error('Falta la propiedad TEAM_CODE (Configuración del proyecto → Propiedades del script)');
  const ss = libro_();
  carpeta_('biblioteca', 'Biblioteca');
  Logger.log('Hoja: ' + ss.getUrl());
  Logger.log('Carpeta: ' + raiz_().getUrl());
}

function doGet() {
  return json_({ok: true, servicio: 'licitaciones-rebold', version: VERSION});
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ok: false, error: 'JSON inválido'}); }
  const codigo = P.getProperty('TEAM_CODE');
  if (!codigo || req.codigo !== codigo) return json_({ok: false, error: 'Código del equipo incorrecto'});
  try {
    switch (req.accion) {
      case 'ping':       return json_({ok: true, version: VERSION});
      case 'cargar':     return json_({ok: true, ...cargar_()});
      case 'patch':      return json_({ok: true, licitacion: patch_(req.id, req.cambios || {}, req.por, req.accionLog)});
      case 'subir':      return json_({ok: true, ...subir_(req)});
      case 'biblioteca': return json_({ok: true, biblioteca: agregarBiblio_(req.entrada)});
      case 'config':     guardarConfig_(req.config); return json_({ok: true});
      default:           return json_({ok: false, error: 'Acción desconocida: ' + req.accion});
    }
  } catch (err) {
    return json_({ok: false, error: String(err && err.message || err)});
  }
}

/* ------------------------------ almacenamiento ------------------------------ */
function libro_() {
  let id = P.getProperty('SHEET_ID');
  if (!id) {
    const ss = SpreadsheetApp.create('Licitaciones Rebold — flujo');
    id = ss.getId(); P.setProperty('SHEET_ID', id);
    DriveApp.getFileById(id).moveTo(raiz_());
  }
  const ss = SpreadsheetApp.openById(id);
  hoja_(ss, 'Licitaciones', ['id', 'estado', 'objeto', 'entidad', 'cierre', 'actualizado', 'json']);
  hoja_(ss, 'Biblioteca', ['tipo', 'nombre', 'fecha_expedicion', 'url', 'fileId', 'subido_por', 'fecha_subida']);
  hoja_(ss, 'Config', ['clave', 'json']);
  hoja_(ss, 'Log', ['fecha', 'id', 'por', 'accion']);
  return ss;
}
function hoja_(ss, nombre, cab) {
  let h = ss.getSheetByName(nombre);
  if (!h) { h = ss.insertSheet(nombre); h.appendRow(cab); h.setFrozenRows(1); }
  return h;
}
function raiz_() {
  let id = P.getProperty('FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const f = DriveApp.createFolder('Licitaciones Rebold');
  P.setProperty('FOLDER_ID', f.getId());
  return f;
}
function carpeta_(clave, nombre) {
  const props = 'CARPETA_' + clave.replace(/[^\w]/g, '_').slice(0, 80);
  const id = P.getProperty(props);
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = raiz_().createFolder(nombre || clave);
  P.setProperty(props, f.getId());
  return f;
}

function cargar_() {
  const ss = libro_();
  const licitaciones = {};
  ss.getSheetByName('Licitaciones').getDataRange().getValues().slice(1).forEach(r => {
    if (r[0]) try { licitaciones[r[0]] = JSON.parse(r[6]); } catch (e) {}
  });
  const biblioteca = leerBiblio_(ss);
  const cfg = ss.getSheetByName('Config').getDataRange().getValues().slice(1).find(r => r[0] === 'config');
  return {licitaciones, biblioteca, config: cfg ? JSON.parse(cfg[1]) : {}};
}
function leerBiblio_(ss) {
  return ss.getSheetByName('Biblioteca').getDataRange().getValues().slice(1).filter(r => r[0]).map(r => ({
    tipo: r[0], nombre: r[1], fecha_expedicion: fechaISO_(r[2]), url: r[3], fileId: r[4], subido_por: r[5], fecha_subida: String(r[6])}));
}
function fechaISO_(v) {
  return v instanceof Date ? Utilities.formatDate(v, 'America/Bogota', 'yyyy-MM-dd') : String(v || '');
}

/** Aplica cambios {ruta.con.puntos: valor} bajo bloqueo: dos directores aprobando a la vez no se pisan. */
function patch_(id, cambios, por, accion) {
  if (!id) throw new Error('Falta id');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('Servidor ocupado, intenta de nuevo');
  try {
    const ss = libro_(), h = ss.getSheetByName('Licitaciones');
    const ids = h.getRange(1, 1, h.getLastRow(), 1).getValues().map(r => r[0]);
    let fila = ids.indexOf(id) + 1, obj = {id};
    if (fila > 0) obj = JSON.parse(h.getRange(fila, 7).getValue() || '{}');
    Object.keys(cambios).forEach(ruta => {
      const p = ruta.split('.'); let o = obj;
      p.slice(0, -1).forEach(k => { o = (o[k] = (o[k] && typeof o[k] === 'object') ? o[k] : {}); });
      if (cambios[ruta] === null) delete o[p[p.length - 1]]; else o[p[p.length - 1]] = cambios[ruta];
    });
    const ahora = new Date().toISOString();
    (obj.log = obj.log || []).push({fecha: ahora, por: por || '', accion: accion || ''});
    const snap = obj.snap || {};
    const fila_ = [id, resumenEstado_(obj), snap.obj || '', snap.ent || '', snap.cie || '', ahora, JSON.stringify(obj)];
    if (fila > 0) h.getRange(fila, 1, 1, 7).setValues([fila_]); else h.appendRow(fila_);
    ss.getSheetByName('Log').appendRow([ahora, id, por || '', accion || '']);
    notificar_(obj, accion, por);
    return obj;
  } finally { lock.releaseLock(); }
}
/** Solo para leer la Sheet a ojo; la app calcula el estado real. */
function resumenEstado_(o) {
  if (o.resultado && o.resultado.estado) return o.resultado.estado;
  if (o.radicacion && o.radicacion.fecha) return 'radicada';
  if (!o.decision) return 'nueva';
  if (o.decision.participar === false) return 'descartada';
  const ap = Object.keys(o.aprobaciones || {}).map(k => o.aprobaciones[k].estado);
  if (ap.indexOf('rechazado') >= 0) return 'rechazada';
  if (ap.some(e => e !== 'aprobado')) return 'pendiente_aprobacion';
  return 'en_preparacion';
}

function subir_(req) {
  if (!req.b64) throw new Error('Archivo vacío');
  const carpeta = req.carpeta === 'biblioteca' ? carpeta_('biblioteca', 'Biblioteca') : carpeta_(req.carpeta, req.carpetaNombre);
  const blob = Utilities.newBlob(Utilities.base64Decode(req.b64), req.mime, req.nombre);
  const f = carpeta.createFile(blob);
  f.setDescription('Subido por ' + (req.por || '') + ' desde Licitaciones Rebold');
  return {url: f.getUrl(), fileId: f.getId()};
}

function agregarBiblio_(e) {
  const ss = libro_();
  ss.getSheetByName('Biblioteca').appendRow([e.tipo, e.nombre, e.fecha_expedicion, e.url || '', e.fileId || '', e.subido_por || '', e.fecha_subida || new Date().toISOString()]);
  return leerBiblio_(ss);
}

function guardarConfig_(cfg) {
  const h = libro_().getSheetByName('Config');
  const vals = h.getDataRange().getValues();
  const i = vals.findIndex(r => r[0] === 'config');
  if (i > 0) h.getRange(i + 1, 2).setValue(JSON.stringify(cfg)); else h.appendRow(['config', JSON.stringify(cfg)]);
}

/** Punto de enganche para avisos (correo / Slack). Se activa en la siguiente fase. */
function notificar_(obj, accion, por) {
  // Ejemplo futuro: al proponer participar, avisar a los directores de obj.aprobaciones;
  // al aprobar el último, avisar al equipo que el expediente está abierto.
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
