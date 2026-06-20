FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev 

COPY . .

# Build Next.js admin
RUN npm run build:admin

EXPOSE 3000

CMD ["node", "src/server.js"]