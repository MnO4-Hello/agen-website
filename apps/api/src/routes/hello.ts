import type { FastifyInstance } from 'fastify';

export async function helloRoutes(app: FastifyInstance): Promise<void> {
  app.get('/hello', async () => ({
    message: 'Hello World',
    service: 'agen-api',
    timestamp: new Date().toISOString(),
  }));
}
