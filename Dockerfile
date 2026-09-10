FROM node:20-slim
WORKDIR /srv/evidence-researcher
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force
COPY backend/ backend/
COPY frontend/ frontend/
# Run as non-root; DATA_DIR must stay writable.
RUN chown -R node:node /srv/evidence-researcher && mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "backend/src/index.js"]
