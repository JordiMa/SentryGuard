FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /app

COPY . .

RUN yarn install --immutable

RUN npx nx build api
RUN npx nx copy-workspace-modules api
RUN npx nx prune-lockfile api

RUN cd apps/api && \
    npx tsc -p tsconfig.migrations.json && \
    mkdir -p dist/migrations && \
    cp dist-migrations/migrations/*.js dist/migrations/

WORKDIR /app/apps/api/dist
RUN yarn install && yarn cache clean

FROM node:20-alpine AS runner
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
RUN ls -la /app/dist/ && ls -la /app/dist/node_modules/ 2>/dev/null | head -10 || echo "No node_modules found"

EXPOSE 3001
ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]