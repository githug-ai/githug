# githug in one container (docs/SELF_HOSTING.md). Data (SQLite, keys) lives in /data.
#   docker build -t githug .
#   docker run -p 8080:8080 -v githug:/data -e GITHUG_ORIGIN=https://githug.example.com githug
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY content ./content
RUN npm run build:node

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production GITHUG_MODE=self-hosted GITHUG_DATA=/data PORT=8080
COPY --from=build /app/dist ./dist
COPY public ./public
COPY migrations ./migrations
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/docs').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/githug.mjs"]
