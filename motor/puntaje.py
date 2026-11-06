"""Indice de oportunidad Rebold (0-100) con los 5 parametros acordados.

1. cobertura     — que tanto cubren los servicios de la Growth Suite lo que pide el proceso
2. tiempo        — dias habiles al cierre frente a los que Rebold necesita para ofertar
3. documentacion — % de documentos reutilizables ya vigentes en la Biblioteca
4. presupuesto   — monto del proceso frente al rango rentable y la capacidad de Rebold
5. posibilidad   — probabilidad estimada de ganar (1 / oferentes esperados x ajuste por modalidad)

La app (app.js) replica estas formulas en el navegador para usar la Biblioteca real y la
fecha de hoy; este modulo es la referencia y alimenta el reporte diario.
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib
import statistics

from .suite import norm

RAIZ = pathlib.Path(__file__).resolve().parent.parent
PARAM = json.loads((RAIZ / "config" / "parametros.json").read_text(encoding="utf-8"))
REQ = json.loads((RAIZ / "config" / "requisitos.json").read_text(encoding="utf-8"))


def clave_modalidad(modalidad: str | None) -> str:
    m = norm(modalidad)
    if "minima cuantia" in m:
        return "minima"
    if "solicitud de informacion" in m:
        return "rfi"
    if "regimen especial" in m:
        return "regimen"
    if "seleccion abreviada" in m:
        return "selabreviada"
    if "concurso de meritos" in m:
        return "concurso"
    if "licitacion publica" in m:
        return "licitacion"
    return "otra"


def dias_habiles(desde: dt.date, hasta: dt.date) -> int:
    """Dias habiles (lun-vie) entre dos fechas; negativo si `hasta` ya paso."""
    if hasta == desde:
        return 0
    signo = 1 if hasta > desde else -1
    a, b = sorted((desde, hasta))
    n, d = 0, a
    while d < b:
        d += dt.timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    return signo * n


def complejidad(mod: str, valor: float | None) -> str:
    c = PARAM["complejidad"]
    v = valor or 0
    if mod in ("licitacion", "concurso") or v >= c["alta_desde"]:
        return "alta"
    if mod in ("minima", "rfi") and v <= c["baja_hasta"]:
        return "baja"
    return "media"


def documentos_aplicables(mod: str) -> list[dict]:
    return [d for d in REQ["documentos"] if not d["modalidades"] or mod in d["modalidades"]]


# ------------------------------ factores ------------------------------
def f_cobertura(fit: int, n_lineas: int) -> float:
    s = min(fit / 12, 1) * 100 + (10 if n_lineas >= 2 else 0)
    return round(min(s, 100))


def f_tiempo(cierre: str | None, mod: str, hoy: dt.date) -> float:
    if not cierre:
        return 50
    dh = dias_habiles(hoy, dt.date.fromisoformat(cierre[:10]))
    if dh < 0:
        return 0
    necesita = PARAM["dias_preparacion"].get(mod, PARAM["dias_preparacion"]["otra"])
    return round(min(dh / necesita, 1.5) / 1.5 * 100)


def f_documentacion(mod: str, biblioteca: dict | None) -> float:
    """biblioteca = {tipo_documento: fecha_expedicion ISO}. Sin biblioteca = 0."""
    reutil = [d for d in documentos_aplicables(mod) if d["reutilizable"]]
    if not reutil or not biblioteca:
        return 0
    hoy = dt.date.today()
    ok = 0
    for d in reutil:
        exp = biblioteca.get(d["id"])
        if not exp:
            continue
        if d["vigencia_dias"] is None or (hoy - dt.date.fromisoformat(exp[:10])).days <= d["vigencia_dias"]:
            ok += 1
    return round(ok / len(reutil) * 100)


def f_presupuesto(valor: float | None) -> float:
    p = PARAM["presupuesto"]
    if not valor:
        return 50
    if valor < p["minimo_rentable"] or valor > p["capacidad_maxima"]:
        return 15
    if valor < p["optimo_desde"]:
        return round(50 + 50 * (valor - p["minimo_rentable"]) / (p["optimo_desde"] - p["minimo_rentable"]))
    if valor <= p["optimo_hasta"]:
        return 100
    return round(100 - 60 * (valor - p["optimo_hasta"]) / (p["capacidad_maxima"] - p["optimo_hasta"]))


def oferentes_esperados(rec: dict, competencia: dict) -> tuple[float, str]:
    """Mediana historica de oferentes de la entidad; si no hay, de la modalidad; si no, defecto."""
    mod = rec["mk"]
    ent = competencia.get("entidad", {}).get(rec.get("nit") or rec["ent"])
    if ent and ent.get("n", 0) >= 2:
        return ent["mediana"], f"mediana de {ent['n']} procesos de la entidad"
    m = competencia.get("modalidad", {}).get(mod)
    if m and m.get("n", 0) >= 5:
        return m["mediana"], f"mediana de {m['n']} procesos de la modalidad"
    return PARAM["competidores_defecto"].get(mod, 4), "valor por defecto (sin histórico)"


def prob_ganar(rec: dict, competencia: dict) -> tuple[float, float, str]:
    n, fuente = oferentes_esperados(rec, competencia)
    aj = PARAM["ajuste_modalidad"].get(rec["mk"], 1.0)
    # Rebold entra como un oferente mas: compite contra los n historicos.
    p = min(aj / (max(n, 1) + 1), 0.95)
    return round(p * 100, 1), n, fuente


def indice(rec: dict, competencia: dict, hoy: dt.date, biblioteca: dict | None = None) -> dict:
    p, n, fuente = prob_ganar(rec, competencia)
    f = {
        "cobertura": f_cobertura(rec["fit"], len(rec.get("lins") or [])),
        "tiempo": f_tiempo(rec.get("cie"), rec["mk"], hoy),
        "documentacion": f_documentacion(rec["mk"], biblioteca),
        "presupuesto": f_presupuesto(rec.get("base")),
        "posibilidad": round(min(p / 40, 1) * 100),
    }
    w = PARAM["pesos"]
    total = sum(f[k] * w[k] for k in f) / sum(w.values())
    return {"indice": round(total), "factores": f, "prob": p, "oferentes": n, "fuente_oferentes": fuente}


def mediana(valores: list[float]) -> float:
    return statistics.median(valores) if valores else 0
