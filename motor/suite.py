"""Vinculo del monitor SECOP con la Growth Suite de Rebold.

Traduce cada linea de servicio de Rebold al vocabulario con el que las entidades
publicas colombianas redactan sus procesos en SECOP II, y clasifica cada proceso:

- `clasificar(proc)`      -> linea(s) Rebold que aplican, puntaje de encaje y evidencia.
- `estado_comercial(proc)` -> si se puede ofertar hoy o si es inteligencia de mercado.
- `terminos_api()`        -> terminos para filtrar el API de SECOP (Socrata).

Fuente de las lineas, servicios y casos: skill `rebold-servicios-suite` v4.2
(29 oct 2026). Los terminos se validaron contra datos reales de SECOP II
(dataset p6dx-8zbt, procesos publicados ago-nov 2026). Las reglas de honestidad
de la suite aplican aqui: no se inventan cifras ni casos.
"""
from __future__ import annotations

import datetime as dt
import json
import re
import unicodedata


def norm(texto) -> str:
    """Minusculas sin tildes; repara texto doble-codificado (UTF-8 leido como latin-1)."""
    if not texto:
        return ""
    s = str(texto)
    if "Ã" in s or "Â" in s:
        try:
            s = s.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    nfkd = unicodedata.normalize("NFKD", s)
    return "".join(c for c in nfkd if not unicodedata.combining(c)).lower()


# --------------------------------------------------------------------------------------
# Lineas de la Growth Suite -> vocabulario SECOP
# fuertes: frase que por si sola indica que el objeto es de Rebold (+6)
# medias:  palabra que suma pero necesita contexto (+2)
# unspsc:  prefijos de codigo UNSPSC (campo codigo_principal_de_categoria) (+4)
# --------------------------------------------------------------------------------------
LINEAS: dict[str, dict] = {
    "activation_hub": {
        "nombre": "Activation Hub",
        "servicio": "Medios y performance · central de medios · SEO + visibilidad en IA",
        "fuertes": [
            "central de medios", "plan de medios", "pauta publicitaria", "pauta digital",
            "pautas institucionales", "pauta institucional", "publicidad digital",
            "marketing digital", "mercadeo digital", "estrategia digital",
            "campana publicitaria", "campanas publicitarias", "agencia de publicidad",
            "servicios de publicidad", "servicio integral de publicidad",
            "divulgacion institucional", "free press", "posicionamiento de marca",
            "promocion turistica", "posicionamiento turistico", "medios masivos",
            "publicidad exterior", "campana de comunicacion", "campanas de comunicacion",
            "estrategia de comunicaciones", "estrategia de comunicacion",
            "acciones publicitarias", "posicionamiento web", "seo",
            "comunicacion y difusion", "difusion de contenidos",
        ],
        "medias": [
            "publicidad", "publicitari", "pauta", "difusion", "divulgacion", "promocion",
            "posicionamiento", "mercadeo", "marketing", "medios de comunicacion",
            "campana", "campanas", "cunas radiales", "emisoras", "comercial",
        ],
        "unspsc": ["V1.821016", "V1.821018", "V1.821019", "V1.821017"],
        "casos": [
            "Páramo Presenta: ~80 eventos en 5 meses, ROAS de 5,3x a 8,5x sin subir inversión",
            "Banco Falabella: CPA −71% (de $208.000 a $60.000)",
            "Camacol Atlántico (feria, oct 2026): 12.000 asistentes, 50% sobre la meta",
            "Knauf (B2B, medios masivos, Mundial 2026): 7 M+ de personas impactadas",
        ],
    },
    "insight_factory": {
        "nombre": "Insight Factory",
        "servicio": "Estudios de mercado · Monitoreo 360° · Social Media · Uncover",
        "fuertes": [
            "estudio de mercado", "estudios de mercado", "investigacion de mercados",
            "monitoreo de medios", "monitoreo de redes", "escucha social", "social listening",
            "estudio de percepcion", "medicion de percepcion", "niveles de percepcion",
            "encuesta de percepcion", "estudio de imagen", "medicion de imagen",
            "reputacion", "reputacional", "analisis de audiencias", "opinion publica",
            "satisfaccion de los usuarios", "satisfaccion del usuario",
            "medicion de satisfaccion", "grupos focales", "focus group",
            "redes sociales", "community manager", "gestion de redes", "manejo de redes",
            "administracion de redes",
        ],
        "medias": [
            "percepcion", "encuesta", "encuestas", "sondeo", "caracterizacion",
            "satisfaccion", "monitoreo", "audiencia", "audiencias", "medicion de impacto",
        ],
        "unspsc": ["V1.801415"],
        "casos": [
            "ETB (Monitoreo 360°): del 6° peor al 2° mejor en reputación digital en < 6 meses",
            "Banco de la República (Monitoreo 360°): 5 años consecutivos",
            "Homecenter (Monitoreo 360°): 8+ años, 15+ crisis acompañadas",
            "Corferias (Social Media): seguidores por feria +155%, ER de 6% a 10%",
        ],
    },
    "creative_lab": {
        "nombre": "Creative Lab",
        "servicio": "Producción creativa con IA · branding · audiovisual",
        "fuertes": [
            "produccion audiovisual", "piezas publicitarias", "piezas graficas",
            "piezas de comunicacion", "piezas comunicativas", "diseno grafico",
            "contenido digital", "contenidos digitales", "produccion de contenidos",
            "gestion de contenidos", "imagen institucional", "imagen corporativa",
            "identidad corporativa", "identidad visual", "manual de marca", "branding",
            "video institucional", "video promocional", "jingle", "estrategia visual",
            "material audiovisual", "componentes digitales",
        ],
        "medias": [
            "audiovisual", "audiovisuales", "diseno", "contenidos", "fotografia", "video",
            "videos", "animacion", "creativ",
        ],
        "unspsc": ["V1.821415", "V1.821015"],
        "casos": [
            "Colsubsidio: contenido de aniversario con IA",
            "Henkel: desarrollo conceptual y ejecución creativa en tiempo récord",
            "Supercerdo / Uniban / Andesco: plataforma de marca + audiovisual y BTL",
        ],
    },
    "growth_engine": {
        "nombre": "Growth Engine",
        "servicio": "Rebold Audit (ORI) · Audience Nexus (monetización de audiencias)",
        "fuertes": [
            "analitica de datos", "analitica web", "analitica digital", "auditoria digital",
            "diagnostico digital", "madurez digital", "tablero de control",
            "inteligencia de negocios", "monetizacion", "retail media",
            "comercializacion de espacios publicitarios", "venta de espacios publicitarios",
            "explotacion comercial de espacios", "experiencia de usuario",
        ],
        "medias": ["analitica", "transformacion digital", "datos abiertos", "ecosistema digital"],
        "unspsc": [],
        "casos": [
            "Rebold Audit: diagnóstico ORI 0–100 (AES, CES, UXCS, AIS)",
            "Audience Nexus: monetización de audiencia propia (revenue share, montos a definir)",
        ],
    },
    "agent_lab": {
        "nombre": "Agent Lab",
        "servicio": "Agentes de IA conectados a CRM, atención y web (complementario)",
        "fuertes": [
            "chatbot", "chat bot", "asistente virtual", "agente virtual", "agentes virtuales",
            "atencion virtual", "crm", "omnicanal", "bot conversacional",
            "agentes de inteligencia artificial", "agente de inteligencia artificial",
        ],
        "medias": ["automatizacion", "atencion al ciudadano", "canales digitales",
                   "inteligencia artificial"],
        "unspsc": [],
        "casos": [
            "MSD Línea Animal: recompra personalizada desde la base de clientes",
            "PTESA: embajadores de marca con IA",
        ],
    },
}

# Frases que por si solas definen el objeto como servicio Rebold (+9 en vez de +6).
ANCLAS = {
    "central de medios", "plan de medios", "agencia de publicidad", "pauta publicitaria",
    "marketing digital", "monitoreo de medios", "escucha social", "social listening",
    "estudio de mercado", "estudios de mercado", "investigacion de mercados",
    "satisfaccion del usuario", "satisfaccion de los usuarios", "estudio de percepcion",
    "produccion audiovisual", "chatbot", "asistente virtual", "estrategia de comunicaciones",
    "monetizacion",
}

# Frases que delatan objetos ajenos aunque compartan palabras ("campaña", "piezas"...).
NEGATIVOS = [
    "raciones", "circuito cerrado", "cctv", "repuesto", "partes y piezas", "radar",
    "esterilizacion", "intendencia", "vestimenta", "calzado", "dotacion", "alimentacion",
    "construccion", "obra civil", "mantenimiento preventivo", "plotter", "tintas",
    "peines", "odontolog", "transporte de carga", "piezas postales", "enfermeria",
    "vacunacion", "fumigacion", "banderas", "uniformes", "workover", "refineria",
    "suministro de combustible", "aseo", "vigilancia", "interventoria", "medicamentos",
    "kit escolar", "materiales de construccion", "pavimentacion", "acueducto",
    "alcantarillado", "ambulancia", "vehiculo", "computadores", "licenciamiento",
    "licencias de software", "equipos tecnologicos", "ciber amenazas", "veterinari",
    "espacios fisicos", "valor total de la sumatoria", "lavado de activos", "sarlaft",
    "cobro persuasivo", "cobro coactivo",
]
# Penalizan sin excluir: pueden venir dentro de un contrato integral de comunicaciones.
NEGATIVOS_SUAVES = [
    "impresion", "material impreso", "avisos", "senalizacion", "apoyo logistico",
    "servicios logisticos", "logistico", "capacitacion", "adecuacion", "suministro",
]

# Contratos de persona natural (OPS) — no son para una agencia.
_PERSONA_NATURAL = re.compile(
    r"servicios (profesionales|de apoyo a la gestion)|apoyo a la gestion|"
    r"persona natural|como (auxiliar|tecnico|profesional)"
)

MODALIDADES_COMPETITIVAS = (
    "licitacion publica", "seleccion abreviada", "concurso de meritos", "minima cuantia",
    "con ofertas", "solicitud de informacion",
)

FIT_ALTO, FIT_MEDIO = 8, 4


def _patron(frase: str) -> re.Pattern:
    """Palabra/frase completa (evita que 'seo' encaje en 'aseo')."""
    if frase.endswith(("publicitari", "creativ")):
        return re.compile(r"\b" + re.escape(frase))
    return re.compile(r"\b" + re.escape(frase) + r"\b")


_COMPILADO = {
    lid: {
        "fuertes": [(f, _patron(f)) for f in d["fuertes"]],
        "medias": [(f, _patron(f)) for f in d["medias"]],
    }
    for lid, d in LINEAS.items()
}
_NEG = [(f, _patron(f)) for f in NEGATIVOS]
_NEG_SUAVE = [(f, _patron(f)) for f in NEGATIVOS_SUAVES]
# En una "Solicitud de informacion a proveedores", "estudio de mercado" es la
# cotizacion de precios de la propia entidad, no un estudio para contratar.
_FALSO_ESTUDIO = re.compile(r"estudios? de mercado")


def _raw(proc: dict) -> dict:
    raw = proc.get("raw") or proc.get("raw_json") or {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = {}
    return raw if isinstance(raw, dict) else {}


def texto_proceso(proc: dict) -> str:
    raw = _raw(proc)
    partes = [
        proc.get("objeto"), proc.get("descripcion"),
        raw.get("nombre_del_procedimiento"), raw.get("descripci_n_del_procedimiento"),
    ]
    vistos, out = set(), []
    for p in partes:
        n = norm(p)
        if n and n not in vistos:
            vistos.add(n)
            out.append(n)
    return " | ".join(out)


def clasificar(proc: dict) -> dict:
    """Encaje del proceso con la Growth Suite.

    Devuelve {score, nivel (alto|medio|bajo|ninguno), linea, lineas[], evidencia[],
    negativos[], persona_natural}.
    """
    texto = texto_proceso(proc)
    raw = _raw(proc)
    unspsc = proc.get("unspsc") or raw.get("codigo_principal_de_categoria") or ""
    modalidad = norm(proc.get("modalidad") or raw.get("modalidad_de_contratacion"))
    if "solicitud de informacion" in modalidad or "cotizacion" in texto:
        texto = _FALSO_ESTUDIO.sub("cotizacion de precios", texto)
    lineas = []
    for lid, d in LINEAS.items():
        pts, hits = 0, []
        for frase, pat in _COMPILADO[lid]["fuertes"]:
            if pat.search(texto):
                pts += 9 if frase in ANCLAS else 6
                hits.append(frase)
        for frase, pat in _COMPILADO[lid]["medias"]:
            if pat.search(texto):
                pts += 2
                hits.append(frase)
        if any(unspsc.startswith(u) for u in d["unspsc"]):
            pts += 4
            hits.append(f"UNSPSC {unspsc}")
        if pts:
            lineas.append({"id": lid, "nombre": d["nombre"], "score": min(pts, 20),
                           "evidencia": hits})
    lineas.sort(key=lambda x: x["score"], reverse=True)

    negativos = [f for f, pat in _NEG if pat.search(texto)]
    suaves = [f for f, pat in _NEG_SUAVE if pat.search(texto)]
    persona = bool(_PERSONA_NATURAL.search(texto))
    score = lineas[0]["score"] if lineas else 0
    # Varias lineas a la vez = proceso integral (ej. estrategia + produccion + pauta).
    score += min(sum(1 for x in lineas[1:] if x["score"] >= 6) * 2, 4)
    score -= 10 * len(negativos) + 3 * min(len(suaves), 2)
    negativos += suaves
    if persona:
        score -= 6
    score = max(score, 0)

    nivel = (
        "alto" if score >= FIT_ALTO else
        "medio" if score >= FIT_MEDIO else
        "bajo" if score > 0 else "ninguno"
    )
    return {
        "score": score,
        "nivel": nivel,
        "linea": lineas[0]["id"] if lineas and score > 0 else None,
        "linea_nombre": lineas[0]["nombre"] if lineas and score > 0 else None,
        "lineas": lineas,
        "evidencia": lineas[0]["evidencia"] if lineas else [],
        "negativos": negativos,
        "persona_natural": persona,
    }


def _fecha(v) -> dt.date | None:
    if not v:
        return None
    try:
        return dt.date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def estado_comercial(proc: dict, hoy: dt.date | None = None) -> dict:
    """Clasifica si Rebold puede ofertar hoy.

    - "abierta":       modalidad competitiva y fecha de cierre futura -> se puede ofertar.
    - "rfi":           solicitud de informacion a proveedores: no es licitacion, pero
                        responderla mete a Rebold en el estudio de mercado del pliego.
    - "por_confirmar": competitiva pero SECOP no publica fecha de cierre -> revisar en SECOP.
    - "cerrada":       la fecha de recepcion de ofertas ya paso.
    - "inteligencia":  contratacion directa / regimen especial sin convocatoria: no se
                        oferta, pero revela que entidades compran estos servicios y a quien.
    """
    hoy = hoy or dt.date.today()
    raw = _raw(proc)
    modalidad = norm(proc.get("modalidad") or raw.get("modalidad_de_contratacion"))
    cierre = _fecha(proc.get("fecha_cierre") or raw.get("fecha_de_recepcion_de"))
    competitiva = any(m in modalidad for m in MODALIDADES_COMPETITIVAS)
    dias = (cierre - hoy).days if cierre else None

    if "solicitud de informacion" in modalidad and (dias is None or dias >= 0):
        estado = "rfi"  # cotizar ahora = entrar al estudio de mercado del futuro pliego
    elif competitiva and cierre and dias is not None and dias >= 0:
        estado = "abierta"
    elif cierre and dias is not None and dias < 0:
        estado = "cerrada"
    elif competitiva:
        estado = "por_confirmar"
    else:
        estado = "inteligencia"
    etiquetas = {
        "abierta": "Abierta para ofertar",
        "rfi": "Solicitud de información (cotizar)",
        "por_confirmar": "Confirmar cierre en SECOP",
        "cerrada": "Cerrada",
        "inteligencia": "Inteligencia de mercado",
    }
    return {"estado": estado, "etiqueta": etiquetas[estado], "dias_al_cierre": dias,
            "fecha_cierre": cierre.isoformat() if cierre else None}


def terminos_api() -> list[str]:
    """Terminos (MAYUSCULA, sin tildes ni enie, como raiz) para el `$where` de Socrata.

    Se usan raices sin caracteres acentuados ('COMUNICACI', 'CAMPA') para que el
    `like` encuentre el texto con o sin tildes.
    """
    return [
        "PUBLICIDAD", "PUBLICITARI", "CENTRAL DE MEDIOS", "PLAN DE MEDIOS", "PAUTA",
        "MARKETING", "MERCADEO", "ESTRATEGIA DE COMUNICACI", "ESTRATEGIA DIGITAL",
        "REDES SOCIALES", "COMMUNITY MANAGER", "MONITOREO DE MEDIOS", "DE MERCADO",
        "PERCEPCI", "REPUTACI", "IMAGEN INSTITUCIONAL", "IMAGEN CORPORATIVA",
        "POSICIONAMIENTO", "DIVULGACI", "DIFUSI", "AUDIOVISUAL", "GRAFIC",
        "CONTENIDOS DIGITALES", "CONTENIDO DIGITAL", "CAMPA", "FREE PRESS", "CHATBOT",
        "ASISTENTE VIRTUAL", "INTELIGENCIA ARTIFICIAL", "TICA DE DATOS", "TICA WEB",
        "SATISFACCI", "ENCUESTA",
    ]


def unspsc_api() -> list[str]:
    out: list[str] = []
    for d in LINEAS.values():
        out += d["unspsc"]
    return out


# Perfil precargado para la vista Perfil del monitor.
PERFIL_REBOLD = {
    "nombre": "Rebold",
    "sector": "Marketing, publicidad, medios e investigación de mercados",
    "palabras_clave": ", ".join([
        "central de medios", "plan de medios", "publicidad", "pauta digital",
        "marketing digital", "estrategia de comunicaciones", "redes sociales",
        "monitoreo de medios", "estudio de mercado", "percepción", "reputación",
        "producción audiovisual", "piezas publicitarias", "imagen institucional",
        "posicionamiento", "divulgación", "chatbot", "inteligencia artificial",
    ]),
    "ciudad": "",          # completar en Perfil (bono leve por ubicacion)
    "departamento": "",
    "descripcion": (
        "Rebold es una agencia de growth: Insight Factory (estudios de mercado, "
        "monitoreo 360° y social media), Creative Lab (producción creativa con IA), "
        "Activation Hub (medios, performance, SEO y visibilidad en IA), Growth Engine "
        "(Rebold Audit y Audience Nexus) y Agent Lab (agentes de IA, complementario)."
    ),
}
