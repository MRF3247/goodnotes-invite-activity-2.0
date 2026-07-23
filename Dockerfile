FROM node:22-alpine

WORKDIR /app

# 零 npm 依赖，直接拷贝源码（config.json / data 由 K8s 注入与挂载，见 .dockerignore）
COPY package.json server.js banned-words.txt ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public

EXPOSE 3210

CMD ["node", "server.js"]
