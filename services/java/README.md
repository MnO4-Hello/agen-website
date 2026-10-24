# Java services

Placeholder for Java-based services (for example a Spring Boot backend).
Nothing runs here yet.

## Getting started (when you add code)

Requires a JDK (17 or newer) and, for the wrapper workflow, Maven.

```bash
cd services/java

# Windows
mvnw.cmd spring-boot:run

# Linux / macOS
./mvnw spring-boot:run
```

Record the service's port in the root `.env.example` and add a proxy rule in
`apps/web/vite.config.ts` — see [../README.md](../README.md).

> Build output (`target/`) and `*.class` files are already ignored by the root
> `.gitignore`.
