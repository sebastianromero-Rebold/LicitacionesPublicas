# Licitaciones Rebold

Aplicativo para que Rebold detecte, decida, prepare y radique licitaciones públicas de Colombia (SECOP II) en las que encajan los servicios de la **Growth Suite**, y para construir un histórico de 3 años del mercado público de estos servicios.

**App:** `https://sebastianromero-rebold.github.io/LicitacionesPublicas/` (GitHub Pages, rama `main`, raíz).

## Flujo

```
SECOP II (datos abiertos) ──► GitHub Action diaria (6 a. m.) ──► data/*.json ──► App (Radar)
                                                                                   │
                       ¿Se ejecuta?  No ─► descartada (con motivo)                 │
                                     Sí ─► Aprobación de directores de las áreas implicadas
                                               │ (líneas Rebold del proceso + Financiero + Gerencia si ≥ $1.000 M)
                                               ▼
                                     Expediente: documentación tal cual la pide SECOP
                                     (Biblioteca reutilizable · fechas objetivo · % cumplimiento)
                                               ▼
                                     Propuesta: Financiero (costeo, valor, margen) + Director (técnica, casos)
                                               ▼
                                     Radicación en SECOP (manual, con paquete ordenado) ─► Resultado
```

| Vista | Qué hace |
|---|---|
| **Radar** | Licitaciones vigentes ordenadas por fecha de entrega, con filtros por servicio, fecha, monto, complejidad y estado. Cada fila: link al pliego, monto, servicios, índice de oportunidad y botón **Sí / No**. |
| **Aprobaciones** | Directores aprueban o rechazan (con comentario) la decisión de participar. |
| **Expedientes** | Documentación por sección de SECOP, responsable, fecha objetivo y semáforo; propuesta financiera y técnica; paquete de radicación; bitácora. |
| **Biblioteca** | Documentos reutilizables (RUP, cámara de comercio, antecedentes, estados financieros, certificaciones…) con vigencia. |
| **Histórico** | Mercado por línea y mes, entidades compradoras, competidores que ganan y oferentes por modalidad. |

## Índice de oportunidad (0–100 %)

| Parámetro | Peso | Cómo se calcula |
|---|---|---|
| Cobertura de servicios | 30 | Encaje del objeto con el vocabulario SECOP y los códigos UNSPSC de cada línea de la suite (`motor/suite.py`). |
| Tiempo de entrega | 15 | Días hábiles al cierre frente a los que Rebold necesita para esa modalidad. |
| Documentación | 20 | % de documentos reutilizables vigentes en la Biblioteca a la fecha de cierre. |
| Presupuesto | 15 | Monto frente al rango rentable y la capacidad de contratación (POR CONFIRMAR con el RUP). |
| Posibilidad de ganar | 20 | 1 / oferentes esperados (mediana histórica de la entidad o modalidad) × ajuste por modalidad. |

Pesos, rangos y días se editan en [`config/parametros.json`](config/parametros.json). Los documentos y su vigencia en [`config/requisitos.json`](config/requisitos.json). La app recalcula en el navegador los factores que cambian cada día (tiempo, documentación).

## ¿Se puede radicar automáticamente en SECOP?

No de forma confiable. SECOP II no ofrece un API público para que los proveedores presenten ofertas; se presentan con el usuario del proveedor, respondiendo el cuestionario del proceso, y las confirma quien pueda obligar a la empresa. Automatizarlo con un robot de navegador exigiría guardar credenciales de Rebold y cualquier error de cargue invalida la oferta. La app entrega el **paquete ordenado** (índice CSV con sección, numeral, requisito y archivo) y la persona autorizada lo carga y registra el número de oferta.

## Estructura

```
index.html · app.js · app.css       app estática (GitHub Pages)
config/parametros.json              pesos, presupuesto, días por modalidad, áreas y aprobaciones
config/requisitos.json              catálogo de documentos por sección SECOP y modalidad
motor/                              Python sin dependencias: SECOP → clasificación → índice
  suite.py                          vocabulario de la Growth Suite (skill rebold-servicios-suite v4.2)
  puntaje.py                        índice de oportunidad (referencia; app.js lo replica)
  construir.py                      histórico particionado + radar + resumen
data/historico/AAAA-MM.json         procesos con encaje, por mes (3 años ≈ 15 MB)
data/radar.json · data/resumen.json
apps-script/Code.gs                 backend: Sheets (flujo, biblioteca, log) + Drive (documentos)
.github/workflows/actualizar-datos.yml
```

## Puesta en marcha

1. **Pages:** Settings → Pages → Deploy from branch → `main` / root.
2. **Token SECOP (opcional, recomendado):** crear un app token gratuito en datos.gov.co y guardarlo como secret `SECOP_APP_TOKEN`.
3. **Backend:** crear un proyecto en script.google.com con la cuenta de Rebold, pegar `apps-script/Code.gs` y `appsscript.json`, definir la propiedad `TEAM_CODE`, implementar como aplicación web (ejecutar como yo, acceso: cualquier persona) y pegar la URL en Configuración de la app (o en `BACKEND_URL_DEFAULT` de `app.js`). Sin backend, la app corre en **modo demo** (el flujo se guarda solo en el navegador).
4. **Directores:** en Configuración, asignar el director de cada área.

```bash
python -m motor.construir              # corrida diaria (últimos 120 días + adjudicaciones recientes)
python -m motor.construir --dias 365   # reconstruir histórico
python -m motor.construir --sin-secop  # recalcular radar y resumen
python -m http.server 8000             # probar la app en local
```

## Reglas

- Clasificación por palabras clave: cada proceso se confirma leyendo el pliego.
- Casos y cifras solo de la Growth Suite oficial; nunca se inventan.
- Próxima fase: avisos por correo y Slack (`notificar_` en `Code.gs`).
