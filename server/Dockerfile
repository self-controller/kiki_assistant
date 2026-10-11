# Build from the repository root:  docker build -f server/Dockerfile -t kiki-server .
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY desktop/package.json desktop/
RUN npm ci --omit=dev --workspace server --include-workspace-root=false --ignore-scripts
COPY shared/src shared/src
COPY server/src server/src
WORKDIR /app/server
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 KIKI_DB_PATH=/data/kiki.db
VOLUME /data
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
