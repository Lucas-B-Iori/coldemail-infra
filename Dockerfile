FROM node:22-alpine

WORKDIR /app

# Copia dependências
COPY package*.json ./
RUN npm ci --omit=dev

# Copia código-fonte
COPY . .

# Garante a pasta de dados persistente
RUN mkdir -p data

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "--disable-warning=ExperimentalWarning", "src/cli.ts", "run"]
