FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data
ENV PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
USER node
CMD ["node", "src/main.mjs"]
