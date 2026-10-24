# services/

Reserved space for additional polyglot services that the personal website may
grow into over time. Nothing here is started by `npm run dev` yet — this is
scaffolding so future work has an obvious home.

| Folder    | Purpose                                            |
| --------- | -------------------------------------------------- |
| `python/` | Python-based services (data jobs, ML, scripts)      |
| `java/`   | Java-based services (Spring Boot style backends)    |

## How to wire a new service into the frontend

1. Give the service a port (add it to `.env.example` and `.env`).
2. Add a proxy rule in [`apps/web/vite.config.ts`](../apps/web/vite.config.ts)
   under `server.proxy`, for example:

   ```ts
   '/py-api': {
     target: 'http://localhost:8000',
     changeOrigin: true,
   },
   ```

3. Call it from the frontend with the relative path (`/py-api/...`) so the same
   code works in development and in production.

## Conventions shared with the rest of the repo

- Code style: see [`.editorconfig`](../.editorconfig).
- Keep each service self-contained with its own manifest (`requirements.txt`,
  `pyproject.toml`, `pom.xml`, …).
- Add a `dev`/`run` command in the service's own manifest rather than in the
  root `package.json`, then optionally expose a root script that calls it.
