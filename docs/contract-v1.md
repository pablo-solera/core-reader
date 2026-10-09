# Contrato Reader API v1

Los schemas Zod en `src/contract/v1.ts` son la fuente de verdad del contrato y `src/contract/openapi.ts` genera OpenAPI a partir de ellos. Las rutas y respuestas comunes se comparten entre readers; cada marca define y documenta su esquema `selection` y filtros de `/v1/models/options`. La especificación OpenAPI y la documentación de operaciones se mantienen en inglés, con tags `System`, `Info`, `Labours`, `Parts` y `Models`.

## Convenciones

- Las rutas de negocio usan `/v1`. `/health`, `/ready`, `/openapi.json` y `/docs` quedan fuera del prefijo.
- La retirada de rutas sin versión es directa, sin alias temporal.
- Requests y responses de negocio usan JSON. Los IDs son UUID.
- Los errores usan `{ "error": { "code": "...", "message": "...", "details": {} } }`.
- Códigos comunes: `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `CONFLICT`/`NOT_READY`/`NOT_DOWNLOADABLE` (409), `PAYLOAD_TOO_LARGE` (413), `NOT_SUPPORTED` (501), `UPSTREAM_ERROR` (502), `UNAVAILABLE` (503), `INTERNAL_ERROR` (500).
- Los identificadores, estados y parámetros tienen semántica común; `stage`, `details` y `selection` pueden ser propios de marca.

## Recursos

`POST /v1/labours` y `POST /v1/parts` reciben `{manufacturer, axCode?, edition?, language?, selection}`. `selection` contiene los criterios específicos de marca y está disponible en OpenAPI. Ambos devuelven 202 con `{requestId, resource, status:"queued", links:{self}}`.

Ambos recursos exponen listado filtrable y paginado por cursor, consulta individual, cancelación, reanudación y descarga opcional. Los readers publican sus capabilities en `/v1/info`; una operación no soportada responde 501 `NOT_SUPPORTED`.

La respuesta de estado contiene `requestId`, `resource`, `reader`, `status`, `stage`, `progress`, `request`, `artifacts`, `error`, `details` opcional y timestamps.

## Descargas y S3

`GET /v1/{resource}/{requestId}/download` redirige con 307 a una URL firmada. Sin `artifact`, selecciona el artefacto principal; con `?artifact=<name>`, selecciona uno nombrado. Si no existe principal, responde 409 con artefactos disponibles en `details`. Un artifact `prefix` no es descargable directamente y produce `NOT_DOWNLOADABLE`. La lista de artifacts contiene `name`, `kind`, `primary` y `location {bucket,key}` para integraciones autorizadas que acceden a S3 directamente.

## Descubrimiento de modelos

`GET /v1/models/options` es el único endpoint de opciones. Acepta `manufacturer`, `language`, `includeRaw` y los filtros de marca; devuelve `appliedFilters`, siguientes filtros, modelos con `selection` reutilizable y `complete`.
