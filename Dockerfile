FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:18-alpine AS runner

RUN apk add --no-cache \
    python3 \
    py3-pip \
    py3-numpy \
    py3-opencv \
    py3-pillow \
    && pip3 install --no-cache-dir rapidocr_onnxruntime>=1.3.0

RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY paddle_ocr_service ./paddle_ocr_service

RUN mkdir -p /app/.data /app/uploads && \
    chown -R appuser:appgroup /app

USER appuser

ENV NODE_ENV=production
ENV SERVER_HOST=0.0.0.0
ENV SERVER_PORT=3000
ENV DATA_DIR=/app/.data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["npm", "start"]