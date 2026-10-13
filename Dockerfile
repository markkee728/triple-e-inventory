FROM node:22-slim

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

COPY backend/ ./backend/
COPY Finance_Inventory/ ./Finance_Inventory/

WORKDIR /app/backend
ENV NODE_ENV=production
ENV PORT=8080
ENV FRONTEND_DIR=../Finance_Inventory
EXPOSE 8080
CMD ["npm", "start"]
