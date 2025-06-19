# Используем легковесный образ Node.js
FROM node:18-alpine

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем package.json перед установкой зависимостей
COPY package.json package-lock.json ./

# Проверяем содержимое папки перед установкой зависимостей
RUN ls -l && npm install

# Копируем остальные файлы проекта
COPY . .

# Запускаем приложение
CMD ["node", "app.js"]
