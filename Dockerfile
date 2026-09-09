FROM node:20-slim
WORKDIR /srv/evidence-researcher
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY backend/ backend/
COPY frontend/ frontend/
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "backend/src/index.js"]
