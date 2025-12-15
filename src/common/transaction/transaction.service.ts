import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TransactionService {
  constructor(private readonly prisma: PrismaService) {}

  async runInTransaction<T>(operation: (tx: PrismaService) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => operation(tx as PrismaService));
  }
}

