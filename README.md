# @pablosla/core-reader

Contrato HTTP v1, puertos e infraestructura compartida (Express, BullMQ, Redis, S3) de los readers de fabricante (`bmw-reader`, `mercedes-reader`, ...). Contrato detallado en [docs/contract-v1.md](docs/contract-v1.md).

## Qué aporta

| Área | Subruta | Contenido |
|---|---|---|
| Contrato | `contract/v1`, `contract/openapi` | Esquemas zod, tipos y `generateOpenApiV1` (los esquemas zod de `selection` se convierten a JSON Schema) |
| HTTP | `interfaces/http/express/*` | `createV1Router`, `createSystemRouter`, middlewares de error, `swaggerDocsHtml` |
| Errores | `domain/errors`, `domain/cursor` | Errores tipados con su código HTTP y cursor opaco |
| Estado y colas | `infrastructure/redis/state-store`, `.../keyspace`, `infrastructure/bullmq/adapter` | Estado con TTL y parches atómicos, claves por namespace, cola y worker BullMQ |
| Worker | `infrastructure/redis/worker-lock`, `.../worker-healthcheck` | Un único worker activo, heartbeat para `/ready` y healthcheck de Docker |
| Listados | `infrastructure/redis/request-index`, `application/list-requests` | Índice ordenado y paginación por cursor con filtros |
| Límites | `infrastructure/redis/rate-limiter`, `shared/retry`, `shared/concurrency` | Reservorio compartido entre procesos con cooldown (429/cuota), backoff y concurrencia acotada |
| Autenticación | `infrastructure/auth/token-pool` | Pool OAuth `client_credentials` (credenciales en body o Basic) |
| S3 | `infrastructure/s3/object-storage`, `.../aws-storage`, `.../archive` | `S3Store`, adaptador AWS y ZIP en streaming |
| Tests | `testing/conformance` | `checkV1HttpConformance` contra un servidor real |

`bullmq`, `ioredis`, el SDK de AWS y `archiver` son peers **opcionales**: instala solo los que use tu reader. `express` y `zod` son obligatorios.

## Crear un reader nuevo

1. **Namespace.** Elige un namespace (`mercedes-reader`) y úsalo en `createKeyspace`, `createWorkerLock`, `createRedisRequestIndex` y `createRedisRateLimiter`.
2. **Selección.** Define tu esquema zod de `selection` y valida con él en el handler `create`. Pásalo en `selectionSchemas` de `generateOpenApiV1`.
3. **Handlers.** Implementa solo lo que soportes en `createV1Router({ handlers })`; lo demás responde 501 y `/v1/info` lo refleja.
4. **App.** Orden de montaje: `express.json`, `createSystemRouter`, rutas extra bajo `/v1` (antes del router v1, que termina en un 404), `createV1Router`, `readerNotFoundMiddleware`, `readerErrorMiddleware`.
5. **Worker.** `createWorkerLock` + heartbeat cada 10 s, `createBullMqWorker` y `/ready` con `lock.assertAlive`.
6. **Cliente del fabricante.** Token con `AccessTokenPool` y `createClientCredentialsRequest`; cada petición pasa por `limiter.acquire()`; ante 429 o cuota agotada llama a `limiter.reportCooldown(ms)`.
7. **Errores.** Lanza los errores de `domain/errors`; no compares mensajes.
8. **Tests.** Levanta la app en un puerto efímero y ejecuta `checkV1HttpConformance`.

## Desarrollo

```sh
bun install
bun test
bun run typecheck
bun run build
```
