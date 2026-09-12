FROM node:22.13.0-alpine3.20 AS build

WORKDIR /app
RUN npm install --global pnpm@11.1.3

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22.13.0-alpine3.20

WORKDIR /app
ENV NODE_ENV=development
COPY --from=build /app /app

CMD ["node", "apps/worker/dist/main.js"]
