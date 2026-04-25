FROM node:18-alpine
WORKDIR /app
COPY package.json .
COPY webhook_server.js .
EXPOSE 3000
CMD ["node", "webhook_server.js"]
