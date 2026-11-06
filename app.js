/* Licitaciones Rebold — app estática (GitHub Pages) + backend Apps Script (Sheets + Drive).
 * Sin backend configurado funciona en MODO DEMO: el flujo se guarda en este navegador.
 * Los datos de SECOP (data/*.json) los actualiza cada día la GitHub Action.
 */
'use strict';

// Apps Script desplegado con la cuenta de Rebold (2026-11-06). El equipo solo escribe el código en Configuración.
const BACKEND_URL_DEFAULT = 'https://script.google.com/macros/s/AKfycbyNd7b0Z9QgjSQ0DBgMus-eUCDW922BXyaHjPppfkH9ubq5ZwutDFGfs05a41hBoRHduQ/exec';
const SECCION_MOMENTO = {juridico: .5, financiero: .4, tecnico: .5, ponderable: .75, economico: .85};
const ESTADOS = {
  nueva:                {t: 'Sin decidir',            c: '#6B6B73'},
  descartada:           {t: 'No participa',           c: '#4A4A52'},
  pendiente_aprobacion: {t: 'Pendiente de aprobación', c: '#E0A526'},
  rechazada:            {t: 'Rechazada por dirección', c: '#EF4444'},
  documentacion:        {t: 'Documentación',          c: '#5B8DEF'},
  propuesta:            {t: 'Propuesta',              c: '#B07CF0'},
  lista:                {t: 'Lista para radicar',     c: '#22C55E'},
  radicada:             {t: 'Radicada en SECOP',      c: '#2BB39A'},
  adjudicada:           {t: 'Adjudicada',             c: '#22C55E'},
  no_adjudicada:        {t: 'No adjudicada',          c: '#9A9AA2'},
};
const EST_SECOP = {abierta: 'Abierta', rfi: 'Solicitud de información', por_confirmar: 'Confirmar cierre'};
const CPX = {baja: 'Baja', media: 'Media', alta: 'Alta'};

const S = {radar: [], resumen: null, param: null, req: null, lic: {}, biblio: [], config: {},
  f: {q: '', linea: '', estado: '', cpx: '', min: '', max: '', desde: '', hasta: '', ocultar: true, orden: 'cierre'},
  hist: {}};

/* ------------------------------ utilidades ------------------------------ */
const $ = (s, el = document) => el.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const hoyISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const fecha = iso => iso ? new Date(iso.slice(0, 10) + 'T00:00:00') : null;
const fmtF = iso => iso ? fecha(iso).toLocaleDateString('es-CO', {day: '2-digit', month: 'short', year: 'numeric'}) : '—';
const fmtM = v => {
  if (!v) return '—';
  if (v >= 1e9) return '$' + (v / 1e9).toLocaleString('es-CO', {maximumFractionDigits: 2}) + ' mil M';
  if (v >= 1e6) return '$' + Math.round(v / 1e6).toLocaleString('es-CO') + ' M';
  return '$' + Math.round(v).toLocaleString('es-CO');
};
const ls = {get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
            set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }};
function toast(msg, ms = 2600) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}
function diasHabiles(a, b) {
  const da = fecha(a), db = fecha(b); if (!da || !db) return null;
  if (+da === +db) return 0;
  const s = db > da ? 1 : -1; let [x, y] = s > 0 ? [da, db] : [db, da]; let n = 0;
  const d = new Date(x);
  while (d < y) { d.setDate(d.getDate() + 1); if (d.getDay() % 6 !== 0) n++; }
  return s * n;
}
function sumarHabiles(iso, n) {
  const d = fecha(iso);
  while (n > 0) { d.setDate(d.getDate() + 1); if (d.getDay() % 6 !== 0) n--; }
  return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
}
const lineaNombre = id => S.resumen?.lineas?.[id]?.nombre || id;
const chipsLineas = ids => (ids || []).map(id => `<span class="chip l-${id}">${esc(lineaNombre(id))}</span>`).join('');
const st = e => `<span class="st" style="--c:${ESTADOS[e]?.c || '#777'}">${ESTADOS[e]?.t || e}</span>`;
const areas = () => (S.config.areas?.length ? S.config.areas : S.param.areas);
const area = id => areas().find(a => a.id === id) || {id, nombre: id, director: ''};

/* ------------------------------ almacenamiento ------------------------------ */
function aplicarCambios(obj, cambios) {
  for (const [ruta, valor] of Object.entries(cambios)) {
    const p = ruta.split('.'); let o = obj;
    for (const k of p.slice(0, -1)) o = (o[k] = (o[k] && typeof o[k] === 'object') ? o[k] : {});
    if (valor === null) delete o[p.at(-1)]; else o[p.at(-1)] = valor;
  }
  return obj;
}
const Store = {
  url: () => ls.get('lp_backend', '') || BACKEND_URL_DEFAULT,
  remoto() { return !!this.url(); },
  async call(accion, datos = {}) {
    const r = await fetch(this.url(), {method: 'POST', headers: {'Content-Type': 'text/plain;charset=utf-8'},
      body: JSON.stringify({accion, codigo: ls.get('lp_codigo', ''), ...datos})});
    let j; try { j = await r.json(); } catch { throw new Error('El backend no respondió JSON'); }
    if (!j.ok) throw new Error(j.error || 'Error del backend');
    return j;
  },
  demo: () => ls.get('lp_demo', {licitaciones: {}, biblioteca: [], config: {}}),
  async cargar() {
    const d = this.remoto() ? await this.call('cargar') : this.demo();
    S.lic = d.licitaciones || {}; S.biblio = d.biblioteca || []; S.config = d.config || {};
  },
  async patch(id, cambios, accion) {
    const por = yo().nombre || 'Sin nombre';
    if (this.remoto()) {
      const j = await this.call('patch', {id, cambios, por, accionLog: accion});
      S.lic[id] = j.licitacion;
    } else {
      const d = this.demo();
      const l = aplicarCambios(d.licitaciones[id] || {id}, cambios);
      (l.log = l.log || []).push({fecha: new Date().toISOString(), por, accion});
      d.licitaciones[id] = l; ls.set('lp_demo', d); S.lic[id] = l;
    }
  },
  async subir(file, meta) {
    if (file.size > 20 * 1024 * 1024) throw new Error('El archivo supera 20 MB');
    if (!this.remoto()) return {nombre: file.name, url: null, demo: true, fecha: hoyISO()};
    const b64 = await new Promise((ok, ko) => { const r = new FileReader();
      r.onload = () => ok(r.result.split(',')[1]); r.onerror = ko; r.readAsDataURL(file); });
    const j = await this.call('subir', {nombre: file.name, mime: file.type || 'application/octet-stream', b64, ...meta, por: yo().nombre});
    return {nombre: file.name, url: j.url, fileId: j.fileId, fecha: hoyISO()};
  },
  async agregarBiblio(e) {
    e = {...e, subido_por: yo().nombre, fecha_subida: new Date().toISOString()};
    if (this.remoto()) { const j = await this.call('biblioteca', {entrada: e}); S.biblio = j.biblioteca; }
    else { const d = this.demo(); d.biblioteca.push(e); ls.set('lp_demo', d); S.biblio = d.biblioteca; }
  },
  async guardarConfig(cfg) {
    if (this.remoto()) await this.call('config', {config: cfg});
    else { const d = this.demo(); d.config = cfg; ls.set('lp_demo', d); }
    S.config = cfg;
  },
};
const yo = () => ls.get('lp_yo', {nombre: '', email: ''});

/* ------------------------------ índice de oportunidad (espejo de motor/puntaje.py) ------------------------------ */
const docsAplicables = mk => S.req.documentos.filter(d => !d.modalidades.length || d.modalidades.includes(mk));
function biblioVigente(tipo, alDia) {
  const def = S.req.documentos.find(d => d.id === tipo);
  const vers = S.biblio.filter(b => b.tipo === tipo).sort((a, b) => (b.fecha_expedicion || '').localeCompare(a.fecha_expedicion || ''));
  const v = vers[0]; if (!v) return {estado: 'falta'};
  if (!def?.vigencia_dias) return {estado: 'vigente', v};
  const dias = def.vigencia_dias - Math.round((fecha(alDia || hoyISO()) - fecha(v.fecha_expedicion)) / 864e5);
  return {estado: dias < 0 ? 'vencido' : dias <= 7 ? 'vence' : 'vigente', dias, v};
}
function fDocumentacion(r) {
  const reutil = docsAplicables(r.mk).filter(d => d.reutilizable);
  if (!reutil.length) return 0;
  const ok = reutil.filter(d => biblioVigente(d.id, r.cie).estado !== 'falta' && biblioVigente(d.id, r.cie).estado !== 'vencido').length;
  return Math.round(ok / reutil.length * 100);
}
function fTiempo(r) {
  if (!r.cie) return 50;
  const dh = diasHabiles(hoyISO(), r.cie); if (dh < 0) return 0;
  const nec = S.param.dias_preparacion[r.mk] ?? S.param.dias_preparacion.otra;
  return Math.round(Math.min(dh / nec, 1.5) / 1.5 * 100);
}
function puntaje(r) {
  const f = {cobertura: r.factores.cobertura, tiempo: fTiempo(r), documentacion: fDocumentacion(r),
             presupuesto: r.factores.presupuesto, posibilidad: r.factores.posibilidad};
  const w = S.param.pesos, tot = Object.values(w).reduce((a, b) => a + b, 0);
  return {f, indice: Math.round(Object.keys(f).reduce((s, k) => s + f[k] * w[k], 0) / tot)};
}

/* ------------------------------ estado del flujo ------------------------------ */
// Un requisito cuenta como cumplido solo si tiene el archivo en el expediente: el paquete debe quedar completo.
const hecho = q => (q.estado === 'cargado' || q.estado === 'validado') && !!q.archivo;
function cumplimiento(l) {
  const reqs = Object.values(l.requisitos || {}).filter(q => q.estado !== 'na');
  const pct = arr => { const t = arr.reduce((s, q) => s + (q.peso || 1), 0);
    return t ? Math.round(arr.filter(hecho).reduce((s, q) => s + (q.peso || 1), 0) / t * 100) : 0; };
  const hab = reqs.filter(q => q.habilitante);
  return {pct: pct(reqs), hab: pct(hab), n: reqs.length, hechos: reqs.filter(hecho).length};
}
function estadoLic(l) {
  if (!l) return 'nueva';
  if (l.resultado?.estado) return l.resultado.estado;
  if (l.radicacion?.fecha) return 'radicada';
  if (!l.decision) return 'nueva';
  if (l.decision.participar === false) return 'descartada';
  const ap = Object.values(l.aprobaciones || {});
  if (ap.some(a => a.estado === 'rechazado')) return 'rechazada';
  if (ap.some(a => a.estado !== 'aprobado')) return 'pendiente_aprobacion';
  const c = cumplimiento(l);
  if (c.pct === 100) return 'lista';
  if (c.hab === 100) return 'propuesta';
  return 'documentacion';
}
function areasAprobacion(r) {
  const s = new Set((r.lins?.length ? r.lins : [r.lin]).filter(Boolean));
  S.param.aprobacion.siempre.forEach(a => s.add(a));
  if ((r.base || 0) >= S.param.aprobacion.gerencia_desde_monto) s.add('gerencia');
  return [...s];
}
function plantillaRequisitos(r) {
  const out = {};
  docsAplicables(r.mk).forEach((d, i) => {
    out[d.id] = {orden: i, doc: d.id, nombre: d.nombre, seccion: d.seccion, habilitante: d.habilitante,
      peso: d.peso, resp: d.resp === 'linea' ? (r.lin || 'gerencia') : d.resp, numeral: '', estado: 'pendiente'};
  });
  return out;
}
function objetivo(l, q) {
  const ini = (l.decision?.fecha || hoyISO()).slice(0, 10);
  const cie = l.snap?.cie || sumarHabiles(ini, 10);
  const tot = Math.max(diasHabiles(ini, cie), 1);
  return sumarHabiles(ini, Math.round(tot * (SECCION_MOMENTO[q.seccion] ?? .7)));
}
function semaforo(l, q) {
  if (q.estado === 'na') return ['na', 'No aplica'];
  if (hecho(q)) return ['ok', 'Listo'];
  if (q.estado === 'cargado' || q.estado === 'validado') return ['vencido', 'Falta el archivo'];
  const dh = diasHabiles(hoyISO(), objetivo(l, q));
  if (dh < 0) return ['vencido', `Vencido hace ${-dh} d háb.`];
  if (dh === 0) return ['hoy', 'Hoy'];
  return ['', `Faltan ${dh} d háb.`];
}

/* ------------------------------ modal ------------------------------ */
function modal(html, onMount) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const bg = $('.modal-bg', root);
  bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-cerrar]')) cerrarModal(); });
  document.addEventListener('keydown', escKey);
  onMount?.($('.modal', root));
}
function escKey(e) { if (e.key === 'Escape') cerrarModal(); }
function cerrarModal() { $('#modal-root').innerHTML = ''; document.removeEventListener('keydown', escKey); }

/* ------------------------------ RADAR ------------------------------ */
function filasRadar() {
  const f = S.f, q = f.q.toLowerCase();
  let rows = S.radar.map(r => ({...r, ...puntaje(r), flujo: estadoLic(S.lic[r.id])}));
  rows = rows.filter(r =>
    (!q || (r.obj + ' ' + r.ent + ' ' + (r.desc || '')).toLowerCase().includes(q)) &&
    (!f.linea || (r.lins || []).includes(f.linea) || r.lin === f.linea) &&
    (!f.estado || r.estado === f.estado) &&
    (!f.cpx || r.cpx === f.cpx) &&
    (!f.min || (r.base || 0) >= +f.min) &&
    (!f.max || (r.base || 0) <= +f.max) &&
    (!f.desde || (r.cie && r.cie >= f.desde)) &&
    (!f.hasta || (r.cie && r.cie <= f.hasta)) &&
    (!f.ocultar || r.flujo !== 'descartada'));
  const ord = {
    cierre: (a, b) => (a.cie || '9999').localeCompare(b.cie || '9999') || b.indice - a.indice,
    indice: (a, b) => b.indice - a.indice,
    monto: (a, b) => (b.base || 0) - (a.base || 0),
  }[f.orden];
  return rows.sort(ord);
}
function vistaRadar() {
  const rows = filasRadar();
  const abiertas = rows.filter(r => r.estado === 'abierta');
  const urg = rows.filter(r => r.dh != null && diasHabiles(hoyISO(), r.cie) <= 3);
  const enFlujo = Object.values(S.lic).filter(l => !['nueva', 'descartada'].includes(estadoLic(l))).length;
  const lineas = Object.entries(S.resumen.lineas);
  const montos = [[10e6, '$10 M'], [30e6, '$30 M'], [100e6, '$100 M'], [500e6, '$500 M'], [1e9, '$1.000 M'], [3e9, '$3.000 M']];
  $('#main').innerHTML = `
  <div class="row"><h2>Licitaciones en las que Rebold puede participar</h2><span class="sp"></span>
    <span class="muted small">Ordenadas por fecha de entrega · índice = cobertura, tiempo, documentación, presupuesto y posibilidad</span></div>
  <div class="grid kpis">
    <div class="card kpi"><div class="v">${rows.length}</div><div class="l">Vigentes con los filtros</div></div>
    <div class="card kpi"><div class="v">${abiertas.length}</div><div class="l">Abiertas para ofertar</div></div>
    <div class="card kpi"><div class="v num">${fmtM(rows.reduce((s, r) => s + (r.base || 0), 0))}</div><div class="l">Valor en juego</div></div>
    <div class="card kpi"><div class="v ${urg.length ? 'urg' : ''}">${urg.length}</div><div class="l">Cierran en ≤ 3 días hábiles</div></div>
    <div class="card kpi"><div class="v">${enFlujo}</div><div class="l">En flujo de participación</div></div>
  </div>
  <div class="card filtros mb">
    <label class="f">Buscar<input id="f-q" placeholder="Objeto, entidad…" value="${esc(S.f.q)}"></label>
    <label class="f">Servicio (Growth Suite)<select id="f-linea"><option value="">Todos</option>${lineas.map(([k, v]) => `<option value="${k}" ${S.f.linea === k ? 'selected' : ''}>${esc(v.nombre)}</option>`).join('')}</select></label>
    <label class="f">Entrega desde<input type="date" id="f-desde" value="${S.f.desde}"></label>
    <label class="f">Entrega hasta<input type="date" id="f-hasta" value="${S.f.hasta}"></label>
    <label class="f">Monto mínimo<select id="f-min"><option value="">Sin mínimo</option>${montos.map(([v, t]) => `<option value="${v}" ${+S.f.min === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="f">Monto máximo<select id="f-max"><option value="">Sin máximo</option>${montos.map(([v, t]) => `<option value="${v}" ${+S.f.max === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="f">Complejidad<select id="f-cpx"><option value="">Todas</option>${Object.entries(CPX).map(([k, t]) => `<option value="${k}" ${S.f.cpx === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="f">Estado en SECOP<select id="f-estado"><option value="">Todos</option>${Object.entries(EST_SECOP).map(([k, t]) => `<option value="${k}" ${S.f.estado === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="f">Ordenar por<select id="f-orden">${[['cierre', 'Fecha de entrega'], ['indice', 'Índice de oportunidad'], ['monto', 'Monto']].map(([k, t]) => `<option value="${k}" ${S.f.orden === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="f" style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" id="f-ocultar" ${S.f.ocultar ? 'checked' : ''}> Ocultar descartadas</label>
    <button class="btn sm" id="f-limpiar">Limpiar filtros</button>
  </div>
  ${rows.length ? `<div class="tbl-wrap"><table>
    <thead><tr><th>Entrega</th><th>Licitación</th><th>Servicios Rebold</th><th>Monto</th><th>Índice</th><th>Complejidad</th><th>Pliego</th><th>¿Se ejecuta?</th></tr></thead>
    <tbody>${rows.map(filaRadar).join('')}</tbody></table></div>`
    : `<div class="card empty">No hay licitaciones con estos filtros.</div>`}`;
  const on = (id, k, ev = 'change') => $(id).addEventListener(ev, e => { S.f[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; ls.set('lp_filtros', S.f); vistaRadar(); if (id === '#f-q') { const i = $('#f-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); } });
  on('#f-q', 'q', 'input'); on('#f-linea', 'linea'); on('#f-desde', 'desde'); on('#f-hasta', 'hasta');
  on('#f-min', 'min'); on('#f-max', 'max'); on('#f-cpx', 'cpx'); on('#f-estado', 'estado'); on('#f-orden', 'orden'); on('#f-ocultar', 'ocultar');
  $('#f-limpiar').onclick = () => { S.f = {q: '', linea: '', estado: '', cpx: '', min: '', max: '', desde: '', hasta: '', ocultar: true, orden: 'cierre'}; ls.set('lp_filtros', S.f); vistaRadar(); };
  $('#main').querySelectorAll('[data-det]').forEach(b => b.onclick = () => detalle(b.dataset.det));
  $('#main').querySelectorAll('[data-si]').forEach(b => b.onclick = () => decidir(b.dataset.si, true));
  $('#main').querySelectorAll('[data-no]').forEach(b => b.onclick = () => decidir(b.dataset.no, false));
}
function filaRadar(r) {
  const dh = r.cie ? diasHabiles(hoyISO(), r.cie) : null;
  const cierre = r.cie ? `<div class="num">${fmtF(r.cie)}</div><div class="small ${dh <= 3 ? 'urg' : 'muted'}">${dh === 0 ? 'Cierra hoy' : `${dh} días háb.`}</div>`
    : `<div class="warn small">Confirmar en SECOP</div>`;
  const acc = r.flujo === 'nueva'
    ? `<button class="btn sm ok" data-si="${esc(r.id)}">Sí</button> <button class="btn sm no" data-no="${esc(r.id)}">No</button>`
    : `${st(r.flujo)}${r.flujo === 'descartada' ? ` <button class="btn sm" data-si="${esc(r.id)}" title="Reconsiderar">↺</button>` : ''}`;
  return `<tr>
    <td>${cierre}</td>
    <td><div class="t" data-det="${esc(r.id)}">${esc(r.obj)}</div>
      <div class="small muted">${esc(r.ent)}${r.dep ? ' · ' + esc(r.dep) : ''}</div>
      <div class="small muted">${esc(r.mod)}${r.estado === 'rfi' ? ' · <span class="warn">cotizar: entra al estudio de mercado</span>' : ''}${r.manifestar ? ' · <span class="urg">manifestar interés (3 días háb.)</span>' : ''}</div></td>
    <td>${chipsLineas(r.lins?.length ? r.lins : [r.lin])}</td>
    <td class="num">${fmtM(r.base)}</td>
    <td><div class="idx" title="Probabilidad estimada de ganar: ${r.prob}%"><b>${r.indice}%</b><div class="bar"><i style="width:${r.indice}%"></i></div><span class="small muted">gana ≈ ${r.prob}%</span></div></td>
    <td>${CPX[r.cpx]}</td>
    <td>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">Ver en SECOP ↗</a>` : '—'}</td>
    <td class="acc">${acc}</td></tr>`;
}
const EXPLICA = {
  cobertura: 'Qué tanto cubren los servicios de la Growth Suite lo que pide el objeto (vocabulario SECOP + códigos UNSPSC).',
  tiempo: 'Días hábiles hasta el cierre frente a los que Rebold necesita para armar la oferta en esta modalidad.',
  documentacion: 'Documentos reutilizables que ya están vigentes en la Biblioteca para la fecha de cierre.',
  presupuesto: 'Monto del proceso frente al rango rentable y la capacidad de contratación de Rebold.',
  posibilidad: 'Probabilidad de ganar según los oferentes que históricamente se presentan con esta entidad o modalidad.',
};
function buscarProc(id) { return S.radar.find(r => r.id === id) || S.lic[id]?.snap; }
function detalle(id) {
  const r0 = buscarProc(id); if (!r0) return;
  const r = {...r0, ...puntaje(r0)};
  const casos = (r.lins?.length ? r.lins : [r.lin]).flatMap(l => S.resumen.lineas[l]?.casos || []);
  const ent = S.resumen.entidades.find(e => e.id === (r.nit || r.ent));
  const faltan = docsAplicables(r.mk).filter(d => d.reutilizable && ['falta', 'vencido'].includes(biblioVigente(d.id, r.cie).estado));
  modal(`
    <div class="row"><h2 style="flex:1">${esc(r.obj)}</h2><button class="btn sm" data-cerrar>Cerrar</button></div>
    <div class="muted">${esc(r.ent)} · ${esc(r.mod)} · ${esc(r.ref || '')}</div>
    <div class="grid kpis">
      <div class="card kpi"><div class="v">${r.indice}%</div><div class="l">Índice de oportunidad</div></div>
      <div class="card kpi"><div class="v">${r.prob}%</div><div class="l">Probabilidad estimada de ganar</div></div>
      <div class="card kpi"><div class="v num">${fmtM(r.base)}</div><div class="l">Presupuesto oficial</div></div>
      <div class="card kpi"><div class="v">${r.cie ? fmtF(r.cie) : '—'}</div><div class="l">Cierre / entrega</div></div>
    </div>
    <h3>Por qué este índice</h3>
    ${Object.entries(r.f).map(([k, v]) => `<div class="factor"><div><b>${k[0].toUpperCase() + k.slice(1)}</b> <span class="small muted">peso ${S.param.pesos[k]}</span></div>
      <div><div class="bar"><i style="width:${v}%"></i></div><div class="small muted">${EXPLICA[k]}</div></div><b class="num">${v}</b></div>`).join('')}
    <div class="note info mt small">Oferentes esperados además de Rebold: <b>${r.oferentes}</b> (${esc(r.fuente_oferentes)}). Probabilidad = ajuste por modalidad ÷ (oferentes + Rebold).
      ${ent ? `Esta entidad tiene ${ent.n} procesos de la suite en el histórico${ent.ganadores?.length ? '; ganadores frecuentes: ' + ent.ganadores.map(g => esc(g[0]) + ' (' + g[1] + ')').join(', ') : ''}.` : ''}</div>
    <h3 class="mt">Objeto</h3><p>${esc(r.desc || r.obj)}</p>
    <p class="small muted">Evidencia de encaje: ${esc((r.evid || []).join(', '))}${r.neg?.length ? ` · <span class="warn">alertas: ${esc(r.neg.join(', '))}</span>` : ''}</p>
    <h3>Casos de la suite para sustentar</h3><ul>${casos.map(c => `<li>${esc(c)}</li>`).join('') || '<li class="muted">Sin casos publicados para esta línea</li>'}</ul>
    ${faltan.length ? `<div class="note small">Faltan o están vencidos en la Biblioteca: ${faltan.map(d => esc(d.nombre.split('(')[0])).join(' · ')}</div>` : '<div class="note ok small">La Biblioteca tiene vigentes todos los documentos reutilizables de esta modalidad.</div>'}
    <div class="row mt">${r.url ? `<a class="btn" href="${esc(r.url)}" target="_blank" rel="noopener">Abrir pliego en SECOP ↗</a>` : ''}<span class="sp"></span>
      ${estadoLic(S.lic[id]) === 'nueva' ? `<button class="btn no" id="d-no">No participar</button><button class="btn pri" id="d-si">Sí, participar</button>` : st(estadoLic(S.lic[id]))}</div>
  `, m => { $('#d-si', m) && ($('#d-si', m).onclick = () => decidir(id, true)); $('#d-no', m) && ($('#d-no', m).onclick = () => decidir(id, false)); });
}
function decidir(id, participar) {
  const r = buscarProc(id); if (!r) return;
  if (!yo().nombre) { toast('Primero escribe tu nombre en Configuración'); location.hash = '#config'; return; }
  if (!participar) {
    modal(`<h2>No participar</h2><p class="muted">${esc(r.obj)}</p>
      <label class="f">Motivo<select id="m-mot">${['No cubre nuestros servicios', 'Tiempo insuficiente', 'Monto fuera de rango', 'No cumplimos habilitantes (RUP, experiencia, financieros)', 'Baja posibilidad de ganar', 'Otro'].map(o => `<option>${o}</option>`).join('')}</select></label>
      <label class="f mt">Comentario<textarea id="m-com"></textarea></label>
      <div class="row mt"><span class="sp"></span><button class="btn" data-cerrar>Cancelar</button><button class="btn pri" id="m-ok">Guardar</button></div>`,
      m => $('#m-ok', m).onclick = async () => {
        await guardar(id, {snap: r, decision: {participar: false, motivo: $('#m-mot', m).value, comentario: $('#m-com', m).value, por: yo().nombre, fecha: new Date().toISOString()}}, 'Decidió no participar');
        cerrarModal(); render();
      });
    return;
  }
  const req = areasAprobacion(r);
  modal(`<h2>Participar en esta licitación</h2><p class="muted">${esc(r.obj)} · ${esc(r.ent)}</p>
    <p>La decisión pasa a aprobación de:</p>
    <ul>${req.map(a => `<li><b>${esc(area(a).nombre)}</b> ${area(a).director ? '— ' + esc(area(a).director) : '<span class="warn small">(sin director asignado en Configuración)</span>'}</li>`).join('')}</ul>
    <label class="f">Por qué participar (contexto para los directores)<textarea id="m-com" placeholder="Encaje, relación con la entidad, casos que aplican…"></textarea></label>
    <div class="row mt"><span class="sp"></span><button class="btn" data-cerrar>Cancelar</button><button class="btn pri" id="m-ok">Enviar a aprobación</button></div>`,
    m => $('#m-ok', m).onclick = async () => {
      const prev = S.lic[id];
      const cambios = {snap: r, decision: {participar: true, comentario: $('#m-com', m).value, por: yo().nombre, fecha: new Date().toISOString()},
        aprobaciones: Object.fromEntries(req.map(a => [a, {estado: 'pendiente'}]))};
      if (!prev?.requisitos) cambios.requisitos = plantillaRequisitos(r);
      await guardar(id, cambios, 'Propuso participar');
      cerrarModal(); toast('Enviada a aprobación'); render();
    });
}
async function guardar(id, cambios, accion) {
  try { await Store.patch(id, cambios, accion); }
  catch (e) { toast('No se pudo guardar: ' + e.message, 5000); throw e; }
}

/* ------------------------------ APROBACIONES ------------------------------ */
function vistaAprobaciones() {
  const lics = Object.values(S.lic).filter(l => l.decision?.participar);
  const pend = lics.filter(l => estadoLic(l) === 'pendiente_aprobacion');
  const resto = lics.filter(l => estadoLic(l) !== 'pendiente_aprobacion').slice(-20).reverse();
  const tarjeta = l => {
    const r = l.snap;
    return `<div class="card mb"><div class="row"><div style="flex:1"><b class="t" data-det="${esc(l.id)}" style="cursor:pointer">${esc(r.obj)}</b>
      <div class="small muted">${esc(r.ent)} · ${fmtM(r.base)} · cierre ${fmtF(r.cie)} · ${chipsLineas(r.lins)}</div></div>${st(estadoLic(l))}</div>
      <div class="small mt">Propuesto por <b>${esc(l.decision.por)}</b> el ${fmtF(l.decision.fecha)}${l.decision.comentario ? ': “' + esc(l.decision.comentario) + '”' : ''}</div>
      <table class="mt"><thead><tr><th>Área</th><th>Director</th><th>Estado</th><th></th></tr></thead><tbody>
      ${Object.entries(l.aprobaciones || {}).map(([a, ap]) => {
        const ar = area(a), puedo = !ar.director || ar.director.trim().toLowerCase() === (yo().nombre || '').trim().toLowerCase();
        return `<tr><td>${esc(ar.nombre)}</td><td>${esc(ar.director || '—')}</td>
          <td>${ap.estado === 'aprobado' ? '<span class="st" style="--c:var(--ok)">Aprobado</span>' : ap.estado === 'rechazado' ? '<span class="st" style="--c:var(--err)">Rechazado</span>' : '<span class="st" style="--c:var(--warn)">Pendiente</span>'}
          ${ap.por ? `<div class="small muted">${esc(ap.por)} · ${fmtF(ap.fecha)}${ap.comentario ? ' · ' + esc(ap.comentario) : ''}</div>` : ''}</td>
          <td class="acc">${ap.estado === 'pendiente' && estadoLic(l) === 'pendiente_aprobacion' ? (puedo
            ? `<button class="btn sm ok" data-ap="${esc(l.id)}|${a}|aprobado">Aprobar</button> <button class="btn sm no" data-ap="${esc(l.id)}|${a}|rechazado">Rechazar</button>`
            : `<span class="small muted">Solo ${esc(ar.director)}</span>`) : ''}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  };
  $('#main').innerHTML = `<h2>Aprobación de directores</h2>
    <p class="muted">Cada licitación que el equipo decide ejecutar necesita el visto bueno de los directores de las áreas implicadas (las líneas Rebold del proceso, Financiero y, desde ${fmtM(S.param.aprobacion.gerencia_desde_monto)}, Gerencia).</p>
    ${pend.length ? pend.map(tarjeta).join('') : '<div class="card empty">No hay decisiones pendientes de aprobación.</div>'}
    ${resto.length ? `<h3 class="mt mb">Decisiones recientes</h3>${resto.map(tarjeta).join('')}` : ''}`;
  $('#main').querySelectorAll('[data-det]').forEach(b => b.onclick = () => detalle(b.dataset.det));
  $('#main').querySelectorAll('[data-ap]').forEach(b => b.onclick = () => {
    const [id, a, estado] = b.dataset.ap.split('|');
    modal(`<h2>${estado === 'aprobado' ? 'Aprobar' : 'Rechazar'} · ${esc(area(a).nombre)}</h2>
      <label class="f">Comentario ${estado === 'rechazado' ? '(obligatorio)' : '(opcional)'}<textarea id="m-com"></textarea></label>
      <div class="row mt"><span class="sp"></span><button class="btn" data-cerrar>Cancelar</button><button class="btn pri" id="m-ok">Confirmar</button></div>`,
      m => $('#m-ok', m).onclick = async () => {
        const com = $('#m-com', m).value.trim();
        if (estado === 'rechazado' && !com) { toast('Escribe el motivo del rechazo'); return; }
        await guardar(id, {[`aprobaciones.${a}`]: {estado, por: yo().nombre, fecha: new Date().toISOString(), comentario: com}}, `${estado === 'aprobado' ? 'Aprobó' : 'Rechazó'} (${area(a).nombre})`);
        cerrarModal(); render();
      });
  });
}

/* ------------------------------ EXPEDIENTES ------------------------------ */
const FLUJO_EXP = ['documentacion', 'propuesta', 'lista', 'radicada', 'adjudicada', 'no_adjudicada'];
function vistaExpedientes() {
  const lics = Object.values(S.lic).filter(l => FLUJO_EXP.includes(estadoLic(l)))
    .sort((a, b) => (a.snap?.cie || '9999').localeCompare(b.snap?.cie || '9999'));
  $('#main').innerHTML = `<h2>Expedientes de participación</h2>
    <p class="muted">Licitaciones aprobadas. Primero se reúne la documentación tal cual la pide SECOP; luego Financiero y el director arman la propuesta.</p>
    ${lics.length ? `<div class="board mt">${lics.map(l => { const c = cumplimiento(l), dh = l.snap?.cie ? diasHabiles(hoyISO(), l.snap.cie) : null; return `
      <a class="card lic-card" href="#exp/${encodeURIComponent(l.id)}" style="text-decoration:none;color:inherit">
        <div class="row">${st(estadoLic(l))}<span class="sp"></span><span class="small ${dh != null && dh <= 3 ? 'urg' : 'muted'}">${l.snap?.cie ? (dh >= 0 ? `cierra en ${dh} d háb.` : 'cerrada') : 'sin fecha'}</span></div>
        <div class="mt"><b>${esc(l.snap?.obj)}</b></div><div class="small muted">${esc(l.snap?.ent)} · ${fmtM(l.snap?.base)}</div>
        <div class="row mt small"><span style="width:110px">Cumplimiento</span><div class="bar sp"><i style="width:${c.pct}%"></i></div><b>${c.pct}%</b></div>
        <div class="row small"><span style="width:110px">Habilitantes</span><div class="bar sp ok"><i style="width:${c.hab}%"></i></div><b>${c.hab}%</b></div>
      </a>`; }).join('')}</div>` : '<div class="card empty">Aún no hay licitaciones aprobadas. Decide en el Radar y pide aprobación.</div>'}`;
}
let tabExp = 'docs';
function vistaExpediente(id) {
  const l = S.lic[id];
  if (!l) { $('#main').innerHTML = '<div class="card empty">Expediente no encontrado.</div>'; return; }
  const r = l.snap, c = cumplimiento(l), e = estadoLic(l), dh = r.cie ? diasHabiles(hoyISO(), r.cie) : null;
  const bloqueado = !FLUJO_EXP.includes(e);
  $('#main').innerHTML = `<a href="#expedientes" class="small">← Expedientes</a>
    <div class="row mt"><h2 style="flex:1">${esc(r.obj)}</h2>${st(e)}</div>
    <div class="muted">${esc(r.ent)} · ${esc(r.mod)} · ${esc(r.ref || '')} · ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">Pliego en SECOP ↗</a>` : ''}</div>
    <div class="grid kpis">
      <div class="card kpi"><div class="v ${dh != null && dh <= 3 ? 'urg' : ''}">${r.cie ? fmtF(r.cie) : '—'}</div><div class="l">Cierre${dh != null ? ` · ${dh} días hábiles` : ''}</div></div>
      <div class="card kpi"><div class="v num">${fmtM(r.base)}</div><div class="l">Presupuesto oficial</div></div>
      <div class="card kpi"><div class="v">${c.pct}%</div><div class="l">Cumplimiento (${c.hechos}/${c.n} requisitos)</div><div class="bar mt"><i style="width:${c.pct}%"></i></div></div>
      <div class="card kpi"><div class="v">${c.hab}%</div><div class="l">Habilitantes (deben llegar a 100%)</div><div class="bar ok mt"><i style="width:${c.hab}%"></i></div></div>
    </div>
    ${bloqueado ? `<div class="note">Este expediente se activa cuando todos los directores aprueben. Estado: ${ESTADOS[e].t}.</div>` : ''}
    <div class="subtabs">${[['docs', 'Documentación SECOP'], ['prop', 'Propuesta'], ['rad', 'Radicación'], ['log', 'Bitácora']].map(([k, t]) => `<button data-tab="${k}" class="${tabExp === k ? 'on' : ''}">${t}</button>`).join('')}</div>
    <div id="tab"></div>`;
  $('#main').querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tabExp = b.dataset.tab; vistaExpediente(id); });
  ({docs: tabDocs, prop: tabPropuesta, rad: tabRadicacion, log: tabLog})[tabExp](l, $('#tab'), bloqueado);
}
function tabDocs(l, el, bloqueado) {
  const reqs = Object.entries(l.requisitos || {}).sort((a, b) => (a[1].orden ?? 99) - (b[1].orden ?? 99));
  const opArea = sel => areas().map(a => `<option value="${a.id}" ${sel === a.id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('');
  el.innerHTML = `<div class="note info small mb">Ajusta cada requisito <b>tal cual lo pide el pliego en SECOP</b> (nombre exacto y numeral). Si el pliego pide algo que no está en la lista, agrégalo en su sección. Los documentos reutilizables se pueden tomar de la Biblioteca si siguen vigentes a la fecha de cierre.</div>
  ${S.req.secciones.map(sec => {
    const items = reqs.filter(([, q]) => q.seccion === sec.id);
    return `<div class="card mb"><div class="row"><h3 style="flex:1">${esc(sec.nombre)}</h3><button class="btn sm" data-add="${sec.id}" ${bloqueado ? 'disabled' : ''}>+ Requisito del pliego</button></div>
      <div class="tbl-wrap mt"><table class="req"><thead><tr><th style="width:38%">Requisito (como lo pide SECOP)</th><th>Numeral</th><th>Responsable</th><th>Fecha objetivo</th><th>Documento</th><th>Estado</th></tr></thead><tbody>
      ${items.map(([qid, q]) => {
        const [sc, stxt] = semaforo(l, q), def = S.req.documentos.find(d => d.id === q.doc);
        const bv = def?.reutilizable ? biblioVigente(def.id, l.snap?.cie) : null;
        const archivo = q.archivo ? (q.archivo.url ? `<a href="${esc(q.archivo.url)}" target="_blank" rel="noopener">${esc(q.archivo.nombre)}</a>` : `<span>${esc(q.archivo.nombre)}</span> <span class="small muted">(demo)</span>`) + (q.archivo.de_biblioteca ? ' <span class="chip">Biblioteca</span>' : '') : '';
        return `<tr><td><input class="nom" data-q="${qid}" data-k="nombre" value="${esc(q.nombre)}" ${bloqueado ? 'disabled' : ''}>${q.habilitante ? '<div class="small warn">Habilitante · sin esto la oferta se rechaza</div>' : ''}</td>
          <td><input data-q="${qid}" data-k="numeral" value="${esc(q.numeral || '')}" placeholder="Ej. 3.2.1" style="width:80px" ${bloqueado ? 'disabled' : ''}></td>
          <td><select data-q="${qid}" data-k="resp" ${bloqueado ? 'disabled' : ''}>${opArea(q.resp)}</select></td>
          <td><div class="num small">${fmtF(objetivo(l, q))}</div><div class="sem ${sc}">${stxt}</div></td>
          <td>${archivo}<div class="row" style="gap:4px;margin-top:4px">
            <label class="btn sm" ${bloqueado ? 'style="pointer-events:none;opacity:.45"' : ''}>Subir<input type="file" data-up="${qid}" hidden></label>
            ${bv && bv.v && bv.estado !== 'vencido' ? `<button class="btn sm" data-bib="${qid}" title="Expedido ${fmtF(bv.v.fecha_expedicion)}" ${bloqueado ? 'disabled' : ''}>Usar Biblioteca</button>` : ''}
            ${bv && bv.estado === 'vencido' ? '<span class="small urg">Biblioteca vencida</span>' : ''}</div></td>
          <td><select data-q="${qid}" data-k="estado" ${bloqueado ? 'disabled' : ''}>${[['pendiente', 'Pendiente'], ['cargado', 'Cargado'], ['validado', 'Validado'], ['na', 'No aplica']].map(([k, t]) => `<option value="${k}" ${q.estado === k ? 'selected' : ''}>${t}</option>`).join('')}</select></td></tr>`;
      }).join('') || '<tr><td colspan="6" class="muted small">Sin requisitos en esta sección.</td></tr>'}</tbody></table></div></div>`;
  }).join('')}`;
  el.querySelectorAll('[data-q]').forEach(i => i.onchange = async () => {
    await guardar(l.id, {[`requisitos.${i.dataset.q}.${i.dataset.k}`]: i.value}, `Editó requisito (${i.dataset.k})`);
    vistaExpediente(l.id);
  });
  el.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
    modal(`<h2>Agregar requisito del pliego</h2>
      <label class="f">Nombre exacto como aparece en SECOP<input id="m-n"></label>
      <div class="row mt"><label class="f">Numeral<input id="m-num"></label><label class="f" style="flex-direction:row;gap:6px;align-items:center;margin-top:18px"><input type="checkbox" id="m-hab"> Es habilitante</label></div>
      <div class="row mt"><span class="sp"></span><button class="btn" data-cerrar>Cancelar</button><button class="btn pri" id="m-ok">Agregar</button></div>`,
      m => $('#m-ok', m).onclick = async () => {
        const n = $('#m-n', m).value.trim(); if (!n) return;
        const qid = 'p' + Date.now().toString(36);
        await guardar(l.id, {[`requisitos.${qid}`]: {orden: 100 + Object.keys(l.requisitos || {}).length, doc: null, nombre: n, numeral: $('#m-num', m).value,
          seccion: b.dataset.add, habilitante: $('#m-hab', m).checked, peso: $('#m-hab', m).checked ? 3 : 2, resp: 'gerencia', estado: 'pendiente'}}, 'Agregó requisito del pliego');
        cerrarModal(); vistaExpediente(l.id);
      });
  });
  el.querySelectorAll('[data-bib]').forEach(b => b.onclick = async () => {
    const q = l.requisitos[b.dataset.bib], v = biblioVigente(q.doc, l.snap?.cie).v;
    await guardar(l.id, {[`requisitos.${b.dataset.bib}.archivo`]: {nombre: v.nombre, url: v.url || null, fecha: v.fecha_expedicion, de_biblioteca: true},
      [`requisitos.${b.dataset.bib}.estado`]: 'cargado'}, 'Tomó documento de la Biblioteca');
    vistaExpediente(l.id);
  });
  el.querySelectorAll('[data-up]').forEach(inp => inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    const qid = inp.dataset.up, q = l.requisitos[qid], def = S.req.documentos.find(d => d.id === q.doc);
    const subir = async (exp, aBiblio) => {
      toast('Subiendo ' + file.name + '…');
      try {
        const a = await Store.subir(file, {carpeta: l.id, carpetaNombre: `${(l.snap.ent || '').slice(0, 40)} · ${l.snap.ref || l.id}`});
        await guardar(l.id, {[`requisitos.${qid}.archivo`]: a, [`requisitos.${qid}.estado`]: 'cargado'}, `Cargó ${file.name}`);
        if (aBiblio) await Store.agregarBiblio({tipo: def.id, nombre: a.nombre, url: a.url, fileId: a.fileId || null, fecha_expedicion: exp});
        toast('Documento cargado'); vistaExpediente(l.id);
      } catch (e) { toast('Error: ' + e.message, 5000); }
    };
    if (def?.reutilizable) {
      modal(`<h2>${esc(file.name)}</h2><p class="muted">${esc(def.nombre)}</p>
        <label class="f">Fecha de expedición del documento<input type="date" id="m-f" value="${hoyISO()}"></label>
        <label class="row mt"><input type="checkbox" id="m-b" checked> Guardar también en la Biblioteca para futuras licitaciones</label>
        <div class="row mt"><span class="sp"></span><button class="btn" data-cerrar>Cancelar</button><button class="btn pri" id="m-ok">Subir</button></div>`,
        m => $('#m-ok', m).onclick = () => { const f = $('#m-f', m).value, b = $('#m-b', m).checked; cerrarModal(); subir(f, b); });
    } else subir(null, false);
  });
}
function tabPropuesta(l, el, bloqueado) {
  const p = l.propuesta || {}, r = l.snap;
  const casos = (r.lins?.length ? r.lins : [r.lin]).flatMap(x => S.resumen.lineas[x]?.casos || []);
  const margen = p.valor_ofertado && p.costo ? Math.round((1 - p.costo / p.valor_ofertado) * 100) : null;
  const c = cumplimiento(l);
  el.innerHTML = `${c.hab < 100 ? `<div class="note small mb">Primero se completa la documentación habilitante (${c.hab}%). La propuesta se puede ir adelantando.</div>` : ''}
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr))">
    <div class="card"><h3>Financiero</h3>
      <div class="row mt"><label class="f sp">Presupuesto oficial<input value="${fmtM(r.base)}" disabled></label>
        <label class="f sp">Costo estimado (COP)<input type="number" id="p-costo" value="${p.costo || ''}"></label></div>
      <div class="row mt"><label class="f sp">Valor a ofertar (COP)<input type="number" id="p-valor" value="${p.valor_ofertado || ''}"></label>
        <label class="f sp">Margen<input value="${margen == null ? '—' : margen + '%'}" disabled></label></div>
      ${p.valor_ofertado && r.base && p.valor_ofertado > r.base ? '<div class="note mt small">⚠ El valor ofertado supera el presupuesto oficial: la oferta sería rechazada.</div>' : ''}
      <label class="f mt">Notas de costeo (terceros, pauta, horas)<textarea id="p-nf">${esc(p.notas_financiero || '')}</textarea></label>
    </div>
    <div class="card"><h3>Director · propuesta técnica</h3>
      <label class="f mt">Enfoque y metodología<textarea id="p-enf" style="min-height:120px">${esc(p.enfoque || '')}</textarea></label>
      <label class="f mt">Equipo propuesto<textarea id="p-eq">${esc(p.equipo || '')}</textarea></label>
      <div class="f mt">Casos de la Growth Suite a citar (cifras oficiales, no inventar)
        ${casos.map((cs, i) => `<label class="row small"><input type="checkbox" data-caso="${i}" ${(p.casos || []).includes(cs) ? 'checked' : ''}> ${esc(cs)}</label>`).join('') || '<span class="muted small">Sin casos publicados para esta línea.</span>'}</div>
    </div>
  </div>
  <div class="row mt"><span class="sp"></span><button class="btn pri" id="p-ok" ${bloqueado ? 'disabled' : ''}>Guardar propuesta</button></div>`;
  $('#p-ok').onclick = async () => {
    await guardar(l.id, {propuesta: {costo: +$('#p-costo').value || null, valor_ofertado: +$('#p-valor').value || null,
      notas_financiero: $('#p-nf').value, enfoque: $('#p-enf').value, equipo: $('#p-eq').value,
      casos: [...el.querySelectorAll('[data-caso]:checked')].map(i => casos[+i.dataset.caso])}}, 'Actualizó la propuesta');
    toast('Propuesta guardada'); vistaExpediente(l.id);
  };
}
function tabRadicacion(l, el) {
  const c = cumplimiento(l), e = estadoLic(l), r = l.snap;
  const reqs = Object.values(l.requisitos || {}).filter(q => q.estado !== 'na').sort((a, b) => S.req.secciones.findIndex(s => s.id === a.seccion) - S.req.secciones.findIndex(s => s.id === b.seccion) || (a.orden ?? 99) - (b.orden ?? 99));
  el.innerHTML = `<div class="note info mb"><b>¿Se puede radicar automáticamente en SECOP?</b> No de forma confiable ni recomendable. SECOP II no tiene un API público para que los proveedores envíen ofertas: la oferta se presenta con el usuario del proveedor registrado, respondiendo el cuestionario del proceso y cargando cada documento en su casilla, y la debe confirmar quien tenga permisos para obligar a la empresa. Un robot de navegador podría intentarlo, pero un error en el cargue anula la oferta y exigiría guardar credenciales de la cuenta de Rebold. <b>Recomendación:</b> la app deja el paquete completo y ordenado como lo pide SECOP, y la persona autorizada lo carga (30–60 min) y registra aquí el número de oferta.</div>
  <div class="card mb"><div class="row"><h3 style="flex:1">Paquete de radicación</h3><span class="small ${c.pct === 100 ? '' : 'warn'}">${c.pct === 100 ? 'Completo' : `Faltan ${c.n - c.hechos} requisitos`}</span>
    <button class="btn sm" id="r-csv">Descargar índice (CSV)</button></div>
    <div class="tbl-wrap mt"><table><thead><tr><th>#</th><th>Sección SECOP</th><th>Numeral</th><th>Requisito</th><th>Archivo</th><th>Estado</th></tr></thead><tbody>
    ${reqs.map((q, i) => `<tr><td>${i + 1}</td><td class="small">${esc(S.req.secciones.find(s => s.id === q.seccion)?.nombre)}</td><td>${esc(q.numeral || '')}</td><td>${esc(q.nombre)}</td>
      <td>${q.archivo ? (q.archivo.url ? `<a href="${esc(q.archivo.url)}" target="_blank" rel="noopener">${esc(q.archivo.nombre)}</a>` : esc(q.archivo.nombre)) : '<span class="urg small">Falta</span>'}</td><td>${q.estado}</td></tr>`).join('')}</tbody></table></div></div>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
    <div class="card"><h3>Registrar radicación</h3>
      ${l.radicacion?.fecha ? `<p>Radicada el <b>${fmtF(l.radicacion.fecha)}</b> por ${esc(l.radicacion.por)} · oferta SECOP <b>${esc(l.radicacion.numero || '—')}</b></p>` : `
      <label class="f mt">Número de oferta en SECOP<input id="r-num" placeholder="CO1.BID…"></label>
      <label class="f mt">Fecha de envío<input type="date" id="r-f" value="${hoyISO()}"></label>
      <button class="btn pri mt" id="r-ok" ${e !== 'lista' ? 'disabled title="Disponible cuando el cumplimiento llegue a 100%"' : ''}>Marcar como radicada</button>`}
    </div>
    <div class="card"><h3>Resultado</h3>
      ${l.resultado?.estado ? `<p>${st(l.resultado.estado)} ${l.resultado.ganador ? '· ganador: ' + esc(l.resultado.ganador) : ''} ${l.resultado.valor ? '· ' + fmtM(l.resultado.valor) : ''}</p>` : `
      <label class="f mt">Resultado<select id="x-e"><option value="adjudicada">Adjudicada a Rebold</option><option value="no_adjudicada">No adjudicada</option></select></label>
      <label class="f mt">Ganador (si no fue Rebold)<input id="x-g"></label>
      <label class="f mt">Valor adjudicado (COP)<input type="number" id="x-v"></label>
      <button class="btn mt" id="x-ok" ${e !== 'radicada' ? 'disabled' : ''}>Guardar resultado</button>`}
    </div></div>`;
  $('#r-csv').onclick = () => {
    const filas = [['#', 'Seccion', 'Numeral', 'Requisito', 'Archivo', 'URL', 'Estado'], ...reqs.map((q, i) => [i + 1, S.req.secciones.find(s => s.id === q.seccion)?.nombre, q.numeral || '', q.nombre, q.archivo?.nombre || '', q.archivo?.url || '', q.estado])];
    const csv = '﻿' + filas.map(f => f.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], {type: 'text/csv'}));
    a.download = `paquete_${(r.ref || l.id).replace(/[^\w.-]+/g, '_')}.csv`; a.click();
  };
  $('#r-ok') && ($('#r-ok').onclick = async () => { await guardar(l.id, {radicacion: {fecha: $('#r-f').value, numero: $('#r-num').value, por: yo().nombre}}, 'Registró radicación en SECOP'); vistaExpediente(l.id); });
  $('#x-ok') && ($('#x-ok').onclick = async () => { await guardar(l.id, {resultado: {estado: $('#x-e').value, ganador: $('#x-g').value, valor: +$('#x-v').value || null, fecha: hoyISO()}}, 'Registró resultado'); vistaExpediente(l.id); });
}
function tabLog(l, el) {
  el.innerHTML = `<div class="card"><table><thead><tr><th>Fecha</th><th>Quién</th><th>Acción</th></tr></thead><tbody>
    ${(l.log || []).slice().reverse().map(x => `<tr><td class="num small">${new Date(x.fecha).toLocaleString('es-CO')}</td><td>${esc(x.por)}</td><td>${esc(x.accion)}</td></tr>`).join('')}</tbody></table></div>`;
}

/* ------------------------------ BIBLIOTECA ------------------------------ */
function vistaBiblioteca() {
  const docs = S.req.documentos.filter(d => d.reutilizable);
  const lbl = {vigente: ['Vigente', 'var(--ok)'], vence: ['Vence pronto', 'var(--warn)'], vencido: ['Vencido', 'var(--err)'], falta: ['Falta', '#6B6B73']};
  const listos = docs.filter(d => ['vigente', 'vence'].includes(biblioVigente(d.id).estado)).length;
  $('#main').innerHTML = `<h2>Biblioteca documental</h2>
    <p class="muted">Documentos que sirven para todas las licitaciones. Cada carga queda versionada${Store.remoto() ? ' en la carpeta de Google Drive del backend' : ' (modo demo: solo se guarda el nombre del archivo)'}; el Radar usa esta Biblioteca para calcular el factor de documentación.</p>
    <div class="grid kpis"><div class="card kpi"><div class="v">${listos}/${docs.length}</div><div class="l">Documentos reutilizables vigentes hoy</div><div class="bar ok mt"><i style="width:${Math.round(listos / docs.length * 100)}%"></i></div></div></div>
    <div class="tbl-wrap"><table><thead><tr><th>Documento</th><th>Vigencia usual</th><th>Estado hoy</th><th>Última versión</th><th></th></tr></thead><tbody>
    ${docs.map(d => { const b = biblioVigente(d.id), [t, c] = lbl[b.estado], vers = S.biblio.filter(x => x.tipo === d.id).length; return `<tr>
      <td><b>${esc(d.nombre)}</b><div class="small muted">${esc(S.req.secciones.find(s => s.id === d.seccion)?.nombre)} · responsable ${esc(area(d.resp).nombre || 'línea Rebold')}</div></td>
      <td class="small">${d.vigencia_dias ? d.vigencia_dias + ' días' : 'No vence'}</td>
      <td><span class="st" style="--c:${c}">${t}</span>${b.dias != null && b.estado !== 'falta' ? `<div class="small muted">${b.dias >= 0 ? `quedan ${b.dias} días` : `hace ${-b.dias} días`}</div>` : ''}</td>
      <td>${b.v ? `${b.v.url ? `<a href="${esc(b.v.url)}" target="_blank" rel="noopener">${esc(b.v.nombre)}</a>` : esc(b.v.nombre)}<div class="small muted">expedido ${fmtF(b.v.fecha_expedicion)} · ${esc(b.v.subido_por || '')} · ${vers} versión(es)</div>` : '—'}</td>
      <td><label class="btn sm">Subir versión<input type="file" data-bup="${d.id}" hidden></label></td></tr>`; }).join('')}
    </tbody></table></div>`;
  $('#main').querySelectorAll('[data-bup]').forEach(inp => inp.onchange = () => {
    const file = inp.files[0]; if (!file) return;
    const d = S.req.documentos.find(x => x.id === inp.dataset.bup);
    modal(`<h2>${esc(d.nombre)}</h2><p class="muted">${esc(file.name)}</p>
      <label class="f">Fecha de expedición<input type="date" id="m-f" value="${hoyISO()}"></label>
      <div class="row mt"><span class="sp"></span><button class="btn" data-cerrar>Cancelar</button><button class="btn pri" id="m-ok">Subir</button></div>`,
      m => $('#m-ok', m).onclick = async () => {
        const f = $('#m-f', m).value; cerrarModal(); toast('Subiendo…');
        try { const a = await Store.subir(file, {carpeta: 'biblioteca', carpetaNombre: 'Biblioteca'});
          await Store.agregarBiblio({tipo: d.id, nombre: a.nombre, url: a.url, fileId: a.fileId || null, fecha_expedicion: f});
          toast('Guardado en la Biblioteca'); vistaBiblioteca(); } catch (e) { toast('Error: ' + e.message, 5000); }
      });
  });
}

/* ------------------------------ HISTÓRICO ------------------------------ */
function barras(items, fmt) {
  const max = Math.max(...items.map(i => i.v), 1);
  return items.map(i => `<div class="hbar" title="${esc(i.k)}: ${fmt(i.v)}"><span class="small">${esc(i.k)}</span><div class="track"><i style="width:${Math.max(i.v / max * 100, .5)}%"></i></div><span class="num small">${fmt(i.v)}</span></div>`).join('');
}
async function vistaHistorico() {
  const R = S.resumen, meses = Object.keys(R.por_mes).filter(m => m >= '2000');
  const porLinea = {};
  for (const m of meses) for (const [lin, b] of Object.entries(R.por_mes[m])) {
    const x = porLinea[lin] ||= {n: 0, valor: 0, comp: 0}; x.n += b.n; x.valor += b.valor; x.comp += b.competitivos;
  }
  const tot = Object.values(porLinea).reduce((a, b) => ({n: a.n + b.n, valor: a.valor + b.valor, comp: a.comp + b.comp}), {n: 0, valor: 0, comp: 0});
  const propias = Object.values(S.lic).filter(l => l.decision?.participar);
  const rad = propias.filter(l => ['radicada', 'adjudicada', 'no_adjudicada'].includes(estadoLic(l)));
  const gan = propias.filter(l => estadoLic(l) === 'adjudicada');
  $('#main').innerHTML = `<h2>Histórico de licitaciones (Growth Suite)</h2>
    <p class="muted">Procesos de SECOP II con encaje medio o alto, ${meses.length ? `${meses[0]} a ${meses.at(-1)}` : ''}. Cada día se suma lo nuevo y se actualizan oferentes y adjudicaciones; se conserva para comparar año contra año durante los próximos 3 años.</p>
    <div class="grid kpis">
      <div class="card kpi"><div class="v">${tot.n.toLocaleString('es-CO')}</div><div class="l">Procesos con encaje</div></div>
      <div class="card kpi"><div class="v num">${fmtM(tot.valor)}</div><div class="l">Valor publicado</div></div>
      <div class="card kpi"><div class="v">${tot.n ? Math.round(tot.comp / tot.n * 100) : 0}%</div><div class="l">Por convocatoria abierta (el resto: régimen especial sin ofertas)</div></div>
      <div class="card kpi"><div class="v">${propias.length} · ${rad.length} · ${gan.length}</div><div class="l">Rebold: decididas · radicadas · ganadas${rad.length ? ` (${Math.round(gan.length / rad.length * 100)}% de éxito)` : ''}</div></div>
    </div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(420px,1fr))">
      <div class="card"><h3>Valor por línea de la suite</h3><div class="mt">${barras(Object.entries(porLinea).sort((a, b) => b[1].valor - a[1].valor).map(([k, v]) => ({k: lineaNombre(k), v: v.valor})), fmtM)}</div></div>
      <div class="card"><h3>Procesos por mes de publicación</h3><div class="mt">${barras(meses.slice(-18).map(m => ({k: m, v: Object.values(R.por_mes[m]).reduce((s, b) => s + b.n, 0)})), v => v.toLocaleString('es-CO'))}</div></div>
    </div>
    <div class="grid mt" style="grid-template-columns:repeat(auto-fit,minmax(420px,1fr))">
      <div class="card"><h3>Entidades que más compran estos servicios</h3><div class="tbl-wrap mt" style="max-height:460px"><table><thead><tr><th>Entidad</th><th>Procesos</th><th>Valor</th><th>Oferentes (mediana)</th><th>Ganadores frecuentes</th></tr></thead><tbody>
        ${R.entidades.slice(0, 60).map(e => `<tr><td>${esc(e.nombre)}<div class="small muted">${esc(e.dep)}</div></td><td>${e.n}</td><td class="num">${fmtM(e.valor)}</td><td>${e.oferentes ?? '—'}</td><td class="small">${e.ganadores.map(g => esc(g[0]) + ' (' + g[1] + ')').join('<br>')}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="card"><h3>Competidores: quién gana estos procesos</h3><div class="tbl-wrap mt" style="max-height:460px"><table><thead><tr><th>Proveedor adjudicado</th><th>Procesos</th></tr></thead><tbody>
        ${R.ganadores.map(g => `<tr><td>${esc(g[0])}</td><td>${g[1]}</td></tr>`).join('')}</tbody></table></div>
        <h3 class="mt">Oferentes por modalidad (mediana)</h3><div class="mt">${barras(Object.entries(R.competencia_modalidad).map(([k, v]) => ({k: `${k} (n=${v.n})`, v: v.mediana})), v => v)}</div></div>
    </div>
    <div class="card mt"><div class="row"><h3 style="flex:1">Buscar en el histórico</h3>
      <select id="h-mes">${meses.slice().reverse().map(m => `<option>${m}</option>`).join('')}</select><input id="h-q" placeholder="Filtrar por texto…"></div><div id="h-tabla" class="mt"></div></div>`;
  const pintar = async () => {
    const m = $('#h-mes').value;
    if (!S.hist[m]) { $('#h-tabla').innerHTML = '<div class="muted small">Cargando…</div>'; S.hist[m] = await (await fetch(`data/historico/${m}.json`)).json(); }
    const q = $('#h-q').value.toLowerCase();
    const rows = S.hist[m].filter(r => !q || (r.obj + ' ' + r.ent).toLowerCase().includes(q));
    $('#h-tabla').innerHTML = `<div class="small muted mb">${rows.length} procesos</div><div class="tbl-wrap" style="max-height:520px"><table><thead><tr><th>Publicado</th><th>Proceso</th><th>Línea</th><th>Modalidad</th><th>Valor</th><th>Oferentes</th><th>Adjudicado a</th></tr></thead><tbody>
      ${rows.slice(0, 400).map(r => `<tr><td class="num small">${fmtF(r.pub)}</td><td>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.obj)}</a>` : esc(r.obj)}<div class="small muted">${esc(r.ent)}</div></td><td>${chipsLineas([r.lin])}</td><td class="small">${esc(r.mod)}</td><td class="num">${fmtM(r.base)}</td><td>${r.resp ?? '—'}</td><td class="small">${esc(r.prov || '')}${r.vadj ? '<br>' + fmtM(r.vadj) : ''}</td></tr>`).join('')}</tbody></table></div>`;
  };
  $('#h-mes').onchange = pintar; $('#h-q').oninput = pintar; if (meses.length) pintar();
}

/* ------------------------------ CONFIGURACIÓN ------------------------------ */
function vistaConfig() {
  const y = yo(), ars = areas();
  $('#main').innerHTML = `<h2>Configuración</h2>
  <div class="grid mt" style="grid-template-columns:repeat(auto-fit,minmax(360px,1fr))">
    <div class="card"><h3>Quién eres</h3><p class="small muted">Se registra en cada decisión, aprobación y carga.</p>
      <label class="f">Nombre<input id="c-n" value="${esc(y.nombre)}"></label>
      <label class="f mt">Correo<input id="c-e" value="${esc(y.email)}"></label>
      <button class="btn pri mt" id="c-yo">Guardar</button></div>
    <div class="card"><h3>Backend (Google Apps Script)</h3>
      <p class="small muted">Sin backend la app funciona en modo demo y todo queda en este navegador. Con backend, el flujo y los documentos se comparten con el equipo (Google Sheets + Drive).</p>
      <label class="f">URL del Web App (/exec)<input id="c-u" value="${esc(ls.get('lp_backend', ''))}" placeholder="${esc(BACKEND_URL_DEFAULT || 'https://script.google.com/macros/s/…/exec')}"></label>
      <label class="f mt">Código del equipo<input id="c-c" type="password" value="${esc(ls.get('lp_codigo', ''))}"></label>
      <div class="row mt"><button class="btn pri" id="c-b">Guardar y probar</button><span id="c-r" class="small"></span></div></div>
  </div>
  <div class="card mt"><h3>Directores por área (aprueban la participación)</h3>
    <p class="small muted">Si un área no tiene director asignado, cualquier persona puede aprobarla (queda registrado quién).</p>
    <div class="tbl-wrap mt"><table><thead><tr><th>Área</th><th>Director (nombre como lo escribe en "Quién eres")</th><th>Correo (avisos)</th></tr></thead><tbody>
    ${ars.map((a, i) => `<tr><td>${esc(a.nombre)}</td><td><input data-ar="${i}" data-k="director" value="${esc(a.director)}"></td><td><input data-ar="${i}" data-k="email" value="${esc(a.email)}"></td></tr>`).join('')}</tbody></table></div>
    <button class="btn pri mt" id="c-ar">Guardar directores</button></div>
  <div class="card mt"><h3>Pesos del índice de oportunidad</h3>
    <p class="small muted">Se editan en <code>config/parametros.json</code> del repositorio (también el rango de presupuesto y los días de preparación por modalidad).</p>
    ${barras(Object.entries(S.param.pesos).map(([k, v]) => ({k, v})), v => v + '%')}</div>`;
  $('#c-yo').onclick = () => { ls.set('lp_yo', {nombre: $('#c-n').value.trim(), email: $('#c-e').value.trim()}); pintarCabecera(); toast('Guardado'); };
  $('#c-b').onclick = async () => {
    ls.set('lp_backend', $('#c-u').value.trim()); ls.set('lp_codigo', $('#c-c').value);
    $('#c-r').textContent = 'Probando…';
    try { if (Store.remoto()) { const j = await Store.call('ping'); $('#c-r').textContent = '✓ Conectado · backend ' + (j.version || ''); await Store.cargar(); S.conectado = true; }
      else $('#c-r').textContent = 'Modo demo'; }
    catch (e) { S.conectado = false; $('#c-r').textContent = '✗ ' + e.message; }
    pintarCabecera();
  };
  $('#c-ar').onclick = async () => {
    const nuevas = ars.map(a => ({...a}));
    $('#main').querySelectorAll('[data-ar]').forEach(i => nuevas[+i.dataset.ar][i.dataset.k] = i.value.trim());
    try { await Store.guardarConfig({...S.config, areas: nuevas}); toast('Directores guardados'); } catch (e) { toast('Error: ' + e.message, 5000); }
  };
}

/* ------------------------------ arranque y rutas ------------------------------ */
function pintarCabecera() {
  const m = $('#modo');
  m.textContent = !Store.remoto() ? 'Modo demo' : S.conectado ? 'Conectado' : 'Sin conexión: revisa el código';
  m.className = 'modo' + (S.conectado ? ' real' : '');
  $('#yo').textContent = yo().nombre || 'Sin identificar';
  const pend = Object.values(S.lic).filter(l => estadoLic(l) === 'pendiente_aprobacion').length;
  $('#nav').querySelectorAll('a').forEach(a => {
    const h = a.getAttribute('href'), ruta = (location.hash || '#radar').split('/')[0];
    a.classList.toggle('on', h === ruta || (h === '#expedientes' && ruta === '#exp'));
    a.querySelector('.badge')?.remove();
    if (h === '#aprobaciones' && pend) a.insertAdjacentHTML('beforeend', `<span class="badge">${pend}</span>`);
  });
}
function render() {
  const [ruta, arg] = (location.hash || '#radar').slice(1).split('/');
  pintarCabecera(); window.scrollTo(0, 0);
  ({radar: vistaRadar, aprobaciones: vistaAprobaciones, expedientes: vistaExpedientes, biblioteca: vistaBiblioteca,
    historico: vistaHistorico, config: vistaConfig, exp: () => vistaExpediente(decodeURIComponent(arg || ''))}[ruta] || vistaRadar)();
}
async function iniciar() {
  try {
    const get = u => fetch(u, {cache: 'no-cache'}).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
    const [radar, resumen, param, req] = await Promise.all([get('data/radar.json'), get('data/resumen.json'), get('config/parametros.json'), get('config/requisitos.json')]);
    Object.assign(S, {radar: radar.procesos, resumen, param, req});
    S.f = {...S.f, ...ls.get('lp_filtros', {})};
    $('#generado').textContent = 'SECOP actualizado ' + new Date(radar.generado).toLocaleString('es-CO', {dateStyle: 'medium', timeStyle: 'short'});
    if (Store.remoto() && !ls.get('lp_codigo', '')) {
      toast('Escribe el código del equipo en Configuración para guardar decisiones y documentos', 6000);
    } else {
      try { await Store.cargar(); S.conectado = Store.remoto(); }
      catch (e) { toast('Backend: ' + e.message + '. Revisa el código en Configuración', 6000); }
    }
    window.addEventListener('hashchange', render);
    render();
  } catch (e) {
    $('#main').innerHTML = `<div class="card empty">No se pudieron cargar los datos: ${esc(e.message)}</div>`;
  }
}
iniciar();
