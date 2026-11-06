"""Construye los datos de la app a partir de SECOP II.

    python -m motor.construir                 # corrida diaria: ultimos 120 dias + adjudicaciones recientes
    python -m motor.construir --dias 365      # carga inicial / reconstruccion de historico
    python -m motor.construir --sin-secop     # solo recalcula radar y resumen con lo guardado

Salidas (todas en data/):
- historico/AAAA-MM.json  procesos con encaje Rebold (medio o alto), por mes de publicacion.
                           Se fusionan por id de portafolio: cada corrida actualiza fase,
                           oferentes y adjudicacion sin perder la fecha en que se detecto.
- radar.json              procesos vigentes (abiertos, solicitudes de informacion, por confirmar)
                           con el indice de oportunidad.
- resumen.json            competencia historica por entidad y modalidad + agregados por mes y
                           linea (alimenta el factor "posibilidad" y la vista Historico).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
from collections import Counter, defaultdict

from . import secop
from .puntaje import (clave_modalidad, complejidad, dias_habiles, indice, mediana)
from .suite import (FIT_MEDIO, LINEAS, clasificar, estado_comercial, norm, terminos_api,
                    unspsc_api)

RAIZ = pathlib.Path(__file__).resolve().parent.parent
DATA = RAIZ / "data"
HIST = DATA / "historico"
CERRADOS = {"adjudicado", "cancelado", "desierto", "terminado", "celebrado"}


def _num(v) -> float | None:
    try:
        n = float(v)
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


def _fecha(v) -> str | None:
    return str(v)[:10] if v and str(v)[:4] not in ("1900", "") else None


def compactar(r: dict, hoy: dt.date) -> dict | None:
    """Fila cruda de SECOP -> registro compacto clasificado (None si no encaja con Rebold)."""
    proc = {
        "objeto": r.get("nombre_del_procedimiento"),
        "descripcion": r.get("descripci_n_del_procedimiento"),
        "modalidad": r.get("modalidad_de_contratacion"),
        "unspsc": r.get("codigo_principal_de_categoria"),
        "fecha_cierre": r.get("fecha_de_recepcion_de"),
    }
    c = clasificar(proc)
    if c["score"] < FIT_MEDIO:
        return None
    est = estado_comercial(proc, hoy)
    if norm(r.get("estado_resumen")) in CERRADOS and est["estado"] != "inteligencia":
        est["estado"] = "cerrada"
    url = r.get("urlproceso")
    url = url.get("url") if isinstance(url, dict) else url
    mk = clave_modalidad(r.get("modalidad_de_contratacion"))
    base = _num(r.get("precio_base"))
    return {
        "id": r.get("id_del_portafolio") or r.get("id_del_proceso"),
        "proc": r.get("id_del_proceso"),
        "ref": r.get("referencia_del_proceso"),
        "ent": (r.get("entidad") or "").strip(),
        "nit": r.get("nit_entidad"),
        "dep": r.get("departamento_entidad"),
        "ciu": r.get("ciudad_entidad"),
        "orden": r.get("ordenentidad"),
        "obj": (r.get("nombre_del_procedimiento") or "").strip(),
        "desc": (r.get("descripci_n_del_procedimiento") or "").strip()[:600],
        "mod": r.get("modalidad_de_contratacion"),
        "mk": mk,
        "fase": r.get("estado_resumen") or r.get("fase"),
        "pub": _fecha(r.get("fecha_de_publicacion_del")),
        "cie": _fecha(r.get("fecha_de_recepcion_de")),
        "base": base,
        "dur": f"{r.get('duracion')} {r.get('unidad_de_duracion') or ''}".strip()
               if r.get("duracion") not in (None, "0") else None,
        "unspsc": r.get("codigo_principal_de_categoria"),
        "tipo": r.get("tipo_de_contrato"),
        "url": url,
        "resp": int(r["respuestas_al_procedimiento"]) if str(r.get("respuestas_al_procedimiento") or "").isdigit() else None,
        "adj": (r.get("adjudicado") or "").lower() == "si",
        "prov": r.get("nombre_del_proveedor") if (r.get("adjudicado") or "").lower() == "si" else None,
        "nitp": r.get("nit_del_proveedor_adjudicado") if (r.get("adjudicado") or "").lower() == "si" else None,
        "vadj": _num(r.get("valor_total_adjudicacion")),
        "fadj": _fecha(r.get("fecha_adjudicacion")),
        "fit": c["score"],
        "lin": c["linea"],
        "lins": [x["id"] for x in c["lineas"] if x["score"] >= 6] or ([c["linea"]] if c["linea"] else []),
        "evid": c["evidencia"][:4],
        "neg": c["negativos"][:3],
        "estado": est["estado"],
        "cpx": complejidad(mk, base),
    }


def fusionar(viejo: dict | None, nuevo: dict) -> dict:
    """Conserva la primera deteccion; la adjudicacion nunca se pierde."""
    if not viejo:
        return nuevo
    out = {**viejo, **{k: v for k, v in nuevo.items() if v not in (None, "", [])}}
    out["visto"] = viejo.get("visto") or nuevo.get("visto")
    if viejo.get("adj") and not nuevo.get("adj"):
        for k in ("adj", "prov", "nitp", "vadj", "fadj"):
            out[k] = viejo.get(k)
    return out


def dedupe(filas: list[dict], hoy: dt.date) -> dict[str, dict]:
    """Una entrada por portafolio: SECOP repite el proceso por fase."""
    out: dict[str, dict] = {}
    for r in filas:
        rec = compactar(r, hoy)
        if not rec or not rec["id"]:
            continue
        rec["visto"] = hoy.isoformat()
        prev = out.get(rec["id"])
        if prev is None or (rec["pub"] or "") >= (prev["pub"] or ""):
            out[rec["id"]] = fusionar(prev, rec) if prev else rec
        else:
            out[rec["id"]] = fusionar(rec, prev)
    return out


# ------------------------------ historico ------------------------------
def cargar_historico() -> dict[str, dict]:
    todo: dict[str, dict] = {}
    for f in sorted(HIST.glob("*.json")):
        for rec in json.loads(f.read_text(encoding="utf-8")):
            todo[rec["id"]] = rec
    return todo


def guardar_historico(todo: dict[str, dict]) -> list[str]:
    por_mes: dict[str, list] = defaultdict(list)
    for rec in todo.values():
        por_mes[(rec.get("pub") or "0000-00")[:7]].append(rec)
    HIST.mkdir(parents=True, exist_ok=True)
    meses = []
    for mes, recs in sorted(por_mes.items()):
        recs.sort(key=lambda r: (r.get("pub") or "", r["id"]), reverse=True)
        (HIST / f"{mes}.json").write_text(
            json.dumps(recs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        meses.append(mes)
    return meses


# ------------------------------ competencia y resumen ------------------------------
def competencia(todo: dict[str, dict]) -> dict:
    """Oferentes reales por entidad y modalidad (solo procesos competitivos con respuestas)."""
    ent, mod = defaultdict(list), defaultdict(list)
    for r in todo.values():
        if r.get("resp") and r["mk"] not in ("rfi",) and r["estado"] != "inteligencia":
            ent[r.get("nit") or r["ent"]].append(r["resp"])
            mod[r["mk"]].append(r["resp"])
    return {
        "entidad": {k: {"n": len(v), "mediana": mediana(v)} for k, v in ent.items()},
        "modalidad": {k: {"n": len(v), "mediana": mediana(v)} for k, v in mod.items()},
    }


def resumen(todo: dict[str, dict], comp: dict, meses: list[str], hoy: dt.date) -> dict:
    por_mes = defaultdict(lambda: defaultdict(lambda: {"n": 0, "valor": 0.0, "competitivos": 0}))
    entidades = defaultdict(lambda: {"n": 0, "valor": 0.0, "competitivos": 0, "ganadores": Counter(),
                                     "nombre": "", "dep": ""})
    ganadores = Counter()
    for r in todo.values():
        mes = (r.get("pub") or "")[:7]
        lin = r.get("lin") or "otra"
        b = por_mes[mes][lin]
        b["n"] += 1
        b["valor"] += r.get("base") or 0
        comp_ = r["estado"] != "inteligencia"
        b["competitivos"] += comp_
        k = r.get("nit") or r["ent"]
        e = entidades[k]
        e["nombre"], e["dep"] = r["ent"], r.get("dep") or ""
        e["n"] += 1
        e["valor"] += r.get("base") or 0
        e["competitivos"] += comp_
        if r.get("prov"):
            e["ganadores"][r["prov"]] += 1
            ganadores[r["prov"]] += 1
    top_ent = sorted(entidades.items(), key=lambda kv: kv[1]["valor"], reverse=True)[:150]
    return {
        "generado": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "hoy": hoy.isoformat(),
        "meses": meses,
        "total_procesos": len(todo),
        "por_mes": {m: dict(v) for m, v in sorted(por_mes.items())},
        "entidades": [
            {"id": k, "nombre": v["nombre"], "dep": v["dep"], "n": v["n"], "valor": v["valor"],
             "competitivos": v["competitivos"],
             "oferentes": comp["entidad"].get(k, {}).get("mediana"),
             "ganadores": v["ganadores"].most_common(3)}
            for k, v in top_ent
        ],
        "ganadores": ganadores.most_common(25),
        "competencia_modalidad": comp["modalidad"],
        "competencia_entidad": {k: v for k, v in comp["entidad"].items()},
        "lineas": {k: {"nombre": v["nombre"], "servicio": v["servicio"], "casos": v["casos"]}
                   for k, v in LINEAS.items()},
    }


def radar(todo: dict[str, dict], comp: dict, hoy: dt.date) -> list[dict]:
    from .suite import estado_comercial as ec
    out = []
    for r in todo.values():
        # el estado depende de la fecha de hoy, no de la del dia en que se descargo
        est = ec({"modalidad": r["mod"], "fecha_cierre": r.get("cie")}, hoy)["estado"]
        if norm(r.get("fase")) in CERRADOS and est != "inteligencia":
            est = "cerrada"
        if est not in ("abierta", "rfi", "por_confirmar"):
            continue
        if est == "por_confirmar" and r.get("pub") and (hoy - dt.date.fromisoformat(r["pub"])).days > 45:
            continue  # sin fecha de cierre y viejo: casi seguro ya cerro
        rec = {**r, "estado": est}
        rec["dh"] = dias_habiles(hoy, dt.date.fromisoformat(r["cie"])) if r.get("cie") else None
        rec["manifestar"] = "manifestacion de interes" in norm(r.get("fase"))
        rec.update(indice(rec, comp, hoy))
        out.append(rec)
    out.sort(key=lambda r: (r["cie"] or "9999", -r["indice"]))
    return out


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dias", type=int, default=120, help="ventana de publicacion a releer")
    ap.add_argument("--sin-secop", action="store_true")
    a = ap.parse_args(argv)
    hoy = dt.date.today()
    todo = cargar_historico()
    print(f"historico previo: {len(todo)} procesos")

    if not a.sin_secop:
        desde = (hoy - dt.timedelta(days=a.dias)).isoformat()
        excl = "modalidad_de_contratacion != 'Contratación directa'"
        filtros = secop.filtros_suite(terminos_api(), unspsc_api())
        print(f"SECOP: publicados desde {desde}")
        filas = secop.consultar(f"fecha_de_publicacion_del >= '{desde}' AND {excl}", filtros)
        # adjudicaciones recientes de procesos publicados antes de la ventana
        adj_desde = (hoy - dt.timedelta(days=15)).isoformat()
        print(f"SECOP: adjudicados desde {adj_desde} (publicados antes de la ventana)")
        filas += secop.consultar(
            f"fecha_adjudicacion >= '{adj_desde}' AND fecha_de_publicacion_del < '{desde}' AND {excl}",
            filtros)
        nuevos = dedupe(filas, hoy)
        n_nuevos = sum(1 for k in nuevos if k not in todo)
        for k, rec in nuevos.items():
            todo[k] = fusionar(todo.get(k), rec)
        print(f"filas SECOP: {len(filas)} -> {len(nuevos)} procesos con encaje ({n_nuevos} nuevos)")

    meses = guardar_historico(todo)
    comp = competencia(todo)
    rad = radar(todo, comp, hoy)
    res = resumen(todo, comp, meses, hoy)
    res["radar"] = {"n": len(rad), "abiertas": sum(r["estado"] == "abierta" for r in rad)}
    (DATA / "radar.json").write_text(json.dumps(
        {"generado": res["generado"], "hoy": hoy.isoformat(), "procesos": rad},
        ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (DATA / "resumen.json").write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")),
                                       encoding="utf-8")
    print(f"historico: {len(todo)} procesos en {len(meses)} meses · radar: {len(rad)} vigentes")


if __name__ == "__main__":
    main()
