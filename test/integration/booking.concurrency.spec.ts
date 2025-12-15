import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Booking concurrency (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.HOLD_TTL_MS = '500';
    process.env.HOLD_SWEEP_INTERVAL_MS = '200';
    process.env.LOCK_TTL_MS = '1000';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.booking.deleteMany();
    await prisma.seat.deleteMany();
  });

  it('allows only one success across 20 concurrent booking attempts', async () => {
    const seatId = randomUUID();
    await prisma.seat.create({
      data: { id: seatId, status: 'AVAILABLE', version: 0 },
    });

    const server = app.getHttpServer();
    const responses = await Promise.all(
      Array.from({ length: 20 }).map(() =>
        request(server)
          .post('/bookings')
          .set('Idempotency-Key', randomUUID())
          .send({ seatId, userId: randomUUID() }),
      ),
    );

    const successes = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(19);
  });

  it('releases hold after TTL and allows booking', async () => {
    const seatId = randomUUID();
    await prisma.seat.create({
      data: { id: seatId, status: 'AVAILABLE', version: 0 },
    });

    const server = app.getHttpServer();
    await request(server).post(`/seats/${seatId}/hold`).send({});

    await wait(800);

    const response = await request(server)
      .post('/bookings')
      .set('Idempotency-Key', randomUUID())
      .send({ seatId, userId: randomUUID() });

    expect(response.status).toBe(201);
  });
});

