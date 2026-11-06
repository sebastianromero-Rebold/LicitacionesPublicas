"""Cliente minimo del API abierto de SECOP II (Socrata, dataset p6dx-8zbt).

Solo libreria estandar (urllib) para que la GitHub Action no instale nada.
Un token gratuito de Socrata (SECOP_APP_TOKEN) sube el limite de peticiones.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

URL = "https://www.datos.gov.co/resource/p6dx-8zbt.json"
TIMEOUT = 120
REINTENTOS = 5

# Campos que guardamos (el resto del registro de SECOP no se usa).
CAMPOS = [
    "id_del_portafolio", "id_del_proceso", "referencia_del_proceso", "entidad", "nit_entidad",
    "departamento_entidad", "ciudad_entidad", "ordenentidad", "nombre_del_procedimiento",
    "descripci_n_del_procedimiento", "fase", "precio_base", "modalidad_de_contratacion",
    "duracion", "unidad_de_duracion", "fecha_de_publicacion_del", "fecha_de_recepcion_de",
    "fecha_de_apertura_de_respuesta", "respuestas_al_procedimiento", "proveedores_unicos_con",
    "estado_del_procedimiento", "estado_resumen", "adjudicado", "fecha_adjudicacion",
    "valor_total_adjudicacion", "nombre_del_proveedor", "nit_del_proveedor_adjudicado",
    "codigo_principal_de_categoria", "tipo_de_contrato", "urlproceso",
]


def _get(params: dict) -> list[dict]:
    qs = urllib.parse.urlencode(params)
    headers = {"Accept": "application/json", "User-Agent": "rebold-licitaciones/1.0"}
    token = os.environ.get("SECOP_APP_TOKEN")
    if token:
        headers["X-App-Token"] = token
    ultimo = None
    for intento in range(REINTENTOS):
        try:
            req = urllib.request.Request(f"{URL}?{qs}", headers=headers)
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            ultimo = exc
            time.sleep(2 * (2 ** intento))
    raise RuntimeError(f"SECOP no respondio tras {REINTENTOS} intentos: {ultimo}")


def _like(campo: str, termino: str) -> str:
    t = termino.upper().replace("'", "''")
    return f"upper({campo}) like '%{t}%'"


def filtros_suite(terminos: list[str], unspsc: list[str], por_lote: int = 6) -> list[str]:
    """Lotes de condiciones OR (URL corta; cada lote se pagina por separado)."""
    out = []
    for i in range(0, len(terminos), por_lote):
        ors = []
        for t in terminos[i:i + por_lote]:
            ors += [_like("nombre_del_procedimiento", t), _like("descripci_n_del_procedimiento", t)]
        out.append(" OR ".join(ors))
    if unspsc:
        out.append(" OR ".join(f"codigo_principal_de_categoria like '{u}%'" for u in unspsc))
    return out


def consultar(base: str, filtros: list[str], pagina: int = 1000, max_paginas: int = 40,
              log=print) -> list[dict]:
    """Ejecuta cada lote `base AND (filtro)` paginando; devuelve filas crudas (con duplicados)."""
    filas: list[dict] = []
    for n, f in enumerate(filtros, 1):
        offset = 0
        while True:
            rows = _get({
                "$select": ",".join(CAMPOS),
                "$where": f"{base} AND ({f})",
                "$order": "fecha_de_publicacion_del DESC, :id",
                "$limit": pagina, "$offset": offset,
            })
            filas += rows
            offset += pagina
            if len(rows) < pagina or offset >= pagina * max_paginas:
                break
        log(f"  lote {n}/{len(filtros)}: {offset if len(rows) == pagina else offset - pagina + len(rows)} filas")
    return filas
