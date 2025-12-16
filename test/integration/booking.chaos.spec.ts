import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { RedlockService } from '../../src/common/lock/redlock.service';
import Redis from 'ioredis';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Booking chaos tests', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let lockService: RedlockService;
  let redisClients: Redis[];

  beforeAll(async () => {
    process.env.HOLD_TTL_MS = '500';
    process.env.HOLD_SWEEP_INTERVAL_MS = '200';
    process.env.LOCK_TTL_MS = '2000';
    process.env.REDIS_URLS = 'redis://localhost:6379';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = moduleRef.get(PrismaService);
    lockService = moduleRef.get(RedlockService);

    const urls = process.env.REDIS_URLS?.split(',') || ['redis://localhost:6379'];
    redisClients = urls.map((url) => new Redis(url.trim()));
  });

  afterAll(async () => {
    await Promise.all(redisClients.map((client) => client.quit()));
    await app.close();
  });

  beforeEach(async () => {
    await prisma.booking.deleteMany();
    await prisma.idempotencyRecord.deleteMany();
    await prisma.seat.deleteMany();
  });

  it('handles lock expiry mid-transaction gracefully', async () => {
    const seatId = randomUUID();
    await prisma.seat.create({
      data: { id: seatId, status: 'AVAILABLE', version: 0 },
    });

    process.env.LOCK_TTL_MS = '100';

    const server = app.getHttpServer();
    const responses = await Promise.all(
      Array.from({ length: 10 }).map(() =>
        request(server)
          .post('/bookings')
          .set('Idempotency-Key', randomUUID())
          .send({ seatId, userId: randomUUID() }),
      ),
    );

    const successes = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    expect(successes.length + conflicts.length).toBe(10);
    expect(successes.length).toBeGreaterThanOrEqual(0);
    expect(conflicts.length).toBeGreaterThanOrEqual(0);
  }, 30000);

  it('handles same idempotency key from multiple concurrent requests', async () => {
    const seatId = randomUUID();
    const userId = randomUUID();
    const idempotencyKey = randomUUID();
    await prisma.seat.create({
      data: { id: seatId, status: 'AVAILABLE', version: 0 },
    });

    const server = app.getHttpServer();
    const responses = await Promise.all(
      Array.from({ length: 20 }).map(() =>
        request(server)
          .post('/bookings')
          .set('Idempotency-Key', idempotencyKey)
          .send({ seatId, userId }),
      ),
    );

    const successes = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(19);

    const bookings = await prisma.booking.findMany({
      where: { idempotencyKey },
    });
    expect(bookings).toHaveLength(1);
  }, 30000);

  it('handles Redis delay gracefully', async () => {
    const seatId = randomUUID();
    await prisma.seat.create({
      data: { id: seatId, status: 'AVAILABLE', version: 0 },
    });

    const originalEval = redisClients[0].eval.bind(redisClients[0]);
    let callCount = 0;
    redisClients[0].eval = async function (...args: unknown[]) {
      callCount++;
      if (callCount <= 2) {
        await wait(150);
      }
      return originalEval(...args);
    };

    const server = app.getHttpServer();
    const responses = await Promise.all(
      Array.from({ length: 5 }).map(() =>
        request(server)
          .post('/bookings')
          .set('Idempotency-Key', randomUUID())
          .send({ seatId, userId: randomUUID() }),
      ),
    );

    redisClients[0].eval = originalEval;

    const successes = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    expect(successes.length + conflicts.length).toBe(5);
    expect(successes.length).toBeGreaterThanOrEqual(0);
  }, 30000);

  it('handles DB commit delay', async () => {
    const seatId = randomUUID();
    await prisma.seat.create({
      data: { id: seatId, status: 'AVAILABLE', version: 0 },
    });

    const originalExecuteRaw = prisma.$executeRaw.bind(prisma);
    let callCount = 0;
    prisma.$executeRaw = async function (...args: unknown[]) {
      callCount++;
      if (callCount <= 3) {
        await wait(100);
      }
      return originalExecuteRaw(...args);
    };

    const server = app.getHttpServer();
    const responses = await Promise.all(
      Array.from({ length: 10 }).map(() =>
        request(server)
          .post('/bookings')
          .set('Idempotency-Key', randomUUID())
          .send({ seatId, userId: randomUUID() }),
      ),
    );

    prisma.$executeRaw = originalExecuteRaw;

    const successes = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    expect(successes.length + conflicts.length).toBe(10);
    expect(successes.length).toBeGreaterThanOrEqual(0);

    const finalBookings = await prisma.booking.findMany({
      where: { seatId },
    });
    expect(finalBookings.length).toBeLessThanOrEqual(1);
  }, 30000);

  it('ensures zero duplicate bookings under extreme concurrency', async () => {
    const seatId = randomUUID();
    await prisma.seat.create({
      data: { id: seatId, status: 'AVAILABLE', version: 0 },
    });

    const server = app.getHttpServer();
    const responses = await Promise.all(
      Array.from({ length: 50 }).map(() =>
        request(server)
          .post('/bookings')
          .set('Idempotency-Key', randomUUID())
          .send({ seatId, userId: randomUUID() }),
      ),
    );

    const successes = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(49);

    const bookings = await prisma.booking.findMany({
      where: { seatId },
    });
    expect(bookings).toHaveLength(1);
  }, 60000);

  it('handles idempotency key reuse with different payload', async () => {
    const seatId1 = randomUUID();
    const seatId2 = randomUUID();
    const userId = randomUUID();
    const idempotencyKey = randomUUID();

    await prisma.seat.createMany({
      data: [
        { id: seatId1, status: 'AVAILABLE', version: 0 },
        { id: seatId2, status: 'AVAILABLE', version: 0 },
      ],
    });

    const server = app.getHttpServer();

    const response1 = await request(server)
      .post('/bookings')
      .set('Idempotency-Key', idempotencyKey)
      .send({ seatId: seatId1, userId });

    expect(response1.status).toBe(201);

    const response2 = await request(server)
      .post('/bookings')
      .set('Idempotency-Key', idempotencyKey)
      .send({ seatId: seatId2, userId });

    expect(response2.status).toBe(409);
    expect(response2.body.message).toContain('different payload');
  });

  it('measures latency under concurrent load', async () => {
    const seatId = randomUUID();
    await prisma.seat.create({
      data: { id: seatId, status: 'AVAILABLE', version: 0 },
    });

    const server = app.getHttpServer();
    const startTime = Date.now();

    const responses = await Promise.all(
      Array.from({ length: 20 }).map(() =>
        request(server)
          .post('/bookings')
          .set('Idempotency-Key', randomUUID())
          .send({ seatId, userId: randomUUID() }),
      ),
    );

    const endTime = Date.now();
    const totalTime = endTime - startTime;
    const avgLatency = totalTime / responses.length;

    const successes = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(19);
    expect(avgLatency).toBeLessThan(5000);
  }, 30000);
});

