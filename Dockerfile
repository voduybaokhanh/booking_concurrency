FROM node:20-bullseye AS base
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Generate Prisma client
COPY prisma ./prisma
ENV DATABASE_URL=postgresql://postgres:postgres@postgres:5432/booking
RUN npx prisma generate

# Build application
COPY . .
RUN npm run build

EXPOSE 3000
CMD ["node", "dist/main.js"]

