# node:sqlite is unflagged only from v22.13.0 — older 22.x needs
# --experimental-sqlite. Pin so the image can never regress below that.
FROM node:22.13-bookworm-slim

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App code (fonts included — needed for ₹ in PDFs)
COPY public ./public
COPY src ./src
COPY fonts ./fonts

# Persistent state lives here: data.db, uploads/, invoices/
# Mount a volume, otherwise data is lost when the container is replaced.
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
