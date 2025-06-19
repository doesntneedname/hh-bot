import express from 'express';
import schedule from 'node-schedule';
import fs from 'fs';
import { promises as fsp } from 'fs';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';
dotenv.config();

// Константы и конфигурация
const app = express();
const PORT = 3001;
const vacancyId = '116912854';
const CACHE_FILE = './cache/cache.json';
const TOKEN_FILE = './cache/token.json';
const HH_API_URL = 'https://api.hh.ru';
const EMPLOYER_ID = process.env.EMPLOYER_ID;
const PACHCA_TOKEN = process.env.PACHCA_TOKEN;
const SECOND_PACHCA_TOKEN = process.env.SECOND_PACHCA_TOKEN;
const SPECIAL_VACANCIES = [120065476, 118154065];
const DEFAULT_ENTITY_ID = 7431593;
const SPECIAL_ENTITY_ID = 18381861;
// Middleware
app.use(express.json());

// Логирование маршрутов
app._router.stack.forEach((r) => {
  if (r.route && r.route.path) {
    console.log(`[ROUTE] ${r.route.path} [${Object.keys(r.route.methods).join(', ').toUpperCase()}]`);
  }
});

// Кеш
let cache = loadCacheAsArray();

// Вспомогательные функции
function loadCacheAsArray() {
  if (!fs.existsSync(CACHE_FILE)) {
    console.log('[CACHE] Файл cache.json не найден, создаем пустой массив');
    return [];
  }
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) {
      console.log('[CACHE] Файл кеша не является массивом, инициализируем пустым []');
      return [];
    }
    console.log(`[CACHE] Кеш загружен, элементов: ${arr.length}`);
    return arr;
  } catch (e) {
    console.log('[CACHE] Ошибка чтения cache.json:', e.message);
    return [];
  }
}

function saveCacheAsArray(arr) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(arr, null, 2));
  console.log(`[CACHE] Кеш сохранен (элементов: ${arr.length})`);
}

function loadHhTokens() {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.log('[TOKENS] token.json не найден');
    return null;
  }
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.log('[TOKENS] Ошибка чтения token.json:', err.message);
    return null;
  }
}

function saveHhTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  console.log('[TOKENS] Токены HH сохранены');
}

async function refreshHhToken() {
  let tokens = loadHhTokens();
  if (!tokens || !tokens.refresh_token) {
    console.log('[TOKEN] Нет refresh_token, требуется повторная авторизация через /auth');
    return null;
  }

  try {
    console.log('[TOKEN] Обновление access_token через refresh_token...');
    const resp = await axios.post('https://hh.ru/oauth/token', null, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      params: {
        grant_type: 'refresh_token',
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        refresh_token: tokens.refresh_token
      }
    });

    if (!resp.data.access_token) {
      throw new Error("Ошибка: HH не вернул access_token");
    }

    resp.data.expires_at = Date.now() + resp.data.expires_in * 1000;
    saveHhTokens(resp.data);
    console.log('[TOKEN] Новый access_token успешно получен');
    return resp.data;
  } catch (err) {
    console.error('[TOKEN] Ошибка при обновлении access_token:', err.response?.data || err.message);
    if (err.response?.data?.error_description === 'password invalidated') {
      console.log('[TOKEN] refresh_token больше не действителен! Требуется повторная авторизация через /auth');
      saveHhTokens(null);
    }
    return null;
  }
}

async function fetchTestSolution(applyId, headers) {
  try {
    const response = await axios.get(`https://api.hh.ru/negotiations/${applyId}/test/solution`, {
      headers: headers
    });
    return response.data?.test_result?.tasks?.[0]?.opened_answer?.value || null;
  } catch (err) {
    console.log(`[TEST] Ошибка получения тестового задания для applyId=${applyId}:`, err.message);
    return null;
  }
}

async function createPachcaThread(messageId, token) {
  try {
    const response = await axios.post(
      `https://api.pachca.com/api/shared/v1/messages/${messageId}/thread`,
      {},  // пустое тело запроса, так как данные передавать не нужно
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8'
        }
      }
    );
    return response.data?.data?.id;
  } catch (err) {
    console.error('[PACHCA] Ошибка создания треда:', err.message);
    return null;
  }
}

async function sendPachcaThreadMessage(threadId, content, token) {
  try {
    await axios.post(
      'https://api.pachca.com/api/shared/v1/messages',
      {
        message: {
          entity_type: 'thread',
          entity_id: threadId,
          content: content
        }
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8'
        }
      }
    );
    console.log(`[PACHCA] Сообщение отправлено в тред ${threadId}`);
  } catch (err) {
    console.error('[PACHCA] Ошибка отправки сообщения в тред:', err.message);
  }
}

async function fetchCandidateContacts(owner, headers) {
  try {
    const email = owner?.contacts?.emails?.[0]?.value || 'Не указано';
    const telegram = owner?.contacts?.messengers?.find(m => m.type === 'telegram')?.value || 'Не указано';
    return { email, telegram };
  } catch (error) {
    console.error('[FETCH CONTACTS] Ошибка получения контактов:', error.message);
    return { email: 'Не указано', telegram: 'Не указано' };
  }
}

function extractResumeId(alternateUrl) {
  const match = alternateUrl.match(/\/resumes\/([a-f0-9]+)/i);
  return match ? match[1] : null;
}

async function downloadResumePdf(pdfUrl, applyId, accessToken) {
  const tempDir = './temp';
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  const filePath = path.join(tempDir, `${applyId}.pdf`);
  console.log(`[PDF] Скачиваем резюме с URL: ${pdfUrl}, файл: ${filePath}`);

  try {
    const response = await axios.get(pdfUrl, {
      responseType: 'stream',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'YourAppName/1.0'
      }
    });
    const writer = fs.createWriteStream(filePath);

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log(`[PDF] Резюме для applyId=${applyId} сохранено: ${filePath}`);
        resolve(filePath);
      });
      writer.on('error', reject);
    });
  } catch (error) {
    console.error(`[PDF] Ошибка скачивания PDF для applyId=${applyId}:`, error.message);
    return null;
  }
}

// Основная функция получения откликов
async function fetchTodayResponses() {
  console.log('[FETCH] Старт fetchTodayResponses...');
  let tokens = loadHhTokens();
  if (!tokens || !tokens.access_token) {
    console.log('[FETCH] Нет access_token, пытаемся обновить...');
    tokens = await refreshHhToken();
    if (!tokens) {
      console.log('[FETCH] Токен не обновлён, прерываем выполнение');
      return;
    }
  }

  if (tokens.expires_at && Date.now() >= tokens.expires_at) {
    console.log('[FETCH] access_token устарел, обновляем...');
    tokens = await refreshHhToken();
    if (!tokens) {
      console.log('[FETCH] Не удалось обновить токен, прерываем выполнение');
      return;
    }
  }

  const hhHeaders = {
    Authorization: `Bearer ${tokens.access_token}`,
    'User-Agent': 'YourAppName/1.0'
  };
  const todayStr = new Date().toISOString().split('T')[0];

  try {
    console.log(`[FETCH] Запрашиваем вакансии для EMPLOYER_ID=${EMPLOYER_ID}`);
    const vacResp = await axios.get(`https://api.hh.ru/vacancies?employer_id=${EMPLOYER_ID}`, {
      headers: hhHeaders
    });
    const vacancies = vacResp.data.items || [];
    console.log(`[FETCH] Найдено ${vacancies.length} вакансий`);

    for (const v of vacancies) {
      const vacancyId = v.id;
      const vacancyTitle = v.name;
      console.log(`[FETCH] vacancyId=${vacancyId}, ищем отклики...`);
      const isSpecialVacancy = SPECIAL_VACANCIES.includes(Number(vacancyId));
      const targetEntityId = isSpecialVacancy ? SPECIAL_ENTITY_ID : DEFAULT_ENTITY_ID;

      console.log(`[CHECK] vacancyId=${vacancyId} (${typeof vacancyId}), isSpecialVacancy=${isSpecialVacancy}, targetEntityId=${targetEntityId}`);


      try {
        const resp = await axios.get(`https://api.hh.ru/negotiations/response?vacancy_id=${vacancyId}`, {
          headers: hhHeaders
        });
        const responses = resp.data.items || [];
        console.log(`[FETCH] vacancyId=${vacancyId}: найдено откликов=${responses.length}`);
        const todays = responses.filter(r => r.created_at && r.created_at.startsWith(todayStr));
        console.log(`[FETCH] vacancyId=${vacancyId}, сегодняшних=${todays.length}`);

        for (const apply of todays) {
          if (!cache.includes(apply.id)) {
            console.log(`[NEW] Новый отклик applyId=${apply.id} от ${apply.resume.first_name} ${apply.resume.last_name}`);

            const userFirstName = apply.resume?.first_name || '';
            const userLastName = apply.resume?.last_name || '';
            const experienceMonths = apply.resume?.total_experience?.months || 0;
            const experienceYears = (experienceMonths / 12).toFixed(1);
            const resumeUrl = apply.resume?.alternate_url || '';
            const pdfUrl = apply.resume?.actions?.download?.pdf?.url;

            if (pdfUrl) {
              const pdfPath = await downloadResumePdf(pdfUrl, apply.id, hhHeaders);
              if (pdfPath) {
                console.log(`[PDF] Файл сохранен по пути: ${pdfPath}`);
              } else {
                console.log(`[PDF] Не удалось скачать файл для applyId=${apply.id}`);
              }
            } else {
              console.log(`[PDF] URL отсутствует для applyId=${apply.id}`);
            }

            const vacancyExpiresWarning = v.expires && new Date(v.expires) <= new Date(Date.now() + 24*60*60*1000) 
              ? "\n⚠️ **Вакансия истекает завтра!**" 
              : "";

            const messageContent = `
Отклик на вакансию **[${vacancyTitle}](https://hh.ru/vacancy/${vacancyId})** от *${userFirstName} ${userLastName}*!
Опыт работы: ${experienceYears} лет
[Резюме](${resumeUrl})
🟢 **New**${vacancyExpiresWarning}
`.trim();

            try {
              const pachcaResp = await axios.post(
                'https://api.pachca.com/api/shared/v1/messages',
                {
                  message: {
                    entity_type: 'discussion',
                    entity_id: targetEntityId,
                    content: messageContent,
                  }
                },
                {
                  headers: {
                    Authorization: `Bearer ${PACHCA_TOKEN}`,
                    'Content-Type': 'application/json; charset=utf-8'
                  }
                }
              );

              console.log(`[PACHCA] Сообщение отправлено в чат: ${targetEntityId}, message_id=${pachcaResp.data.data.id}`);

              const testSolution = await fetchTestSolution(apply.id, hhHeaders);

              if (testSolution) {
                const threadId = await createPachcaThread(pachcaResp.data.data.id, PACHCA_TOKEN);

                if (threadId) {
                  await sendPachcaThreadMessage(threadId, `**Тестовое задание:**\n${testSolution}`, PACHCA_TOKEN);
                }
              }

              cache.push(apply.id);
              saveCacheAsArray(cache);
            } catch (err) {
              console.error('[PACHCA] Ошибка отправки сообщения:', err.message);
            }
          }
        }
      } catch (err) {
        console.error(`[FETCH] Ошибка получения откликов для vacancyId=${vacancyId}:`, err.response?.data || err.message);
      }
    }
  } catch (err) {
    console.error('[FETCH] Ошибка получения списка вакансий:', err.response?.data || err.message);
  }
}

// Планировщики
schedule.scheduleJob('0 0 * * 1', () => {
  console.log('[CACHE] Очистка кеша (раз в неделю)');
  cache = [];
  saveCacheAsArray(cache);
});

schedule.scheduleJob('*/5 * * * *', () => {
  console.log('[SCHEDULE] Запуск сбора откликов...');
  fetchTodayResponses();
});

// Роуты
app.get('/auth', (req, res) => {
  if (!process.env.CLIENT_ID || !process.env.REDIRECT_URI) {
    return res.status(500).send('CLIENT_ID или REDIRECT_URI не указаны');
  }
  const url = `https://hh.ru/oauth/authorize?response_type=code&client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}`;
  console.log('[AUTH] Перенаправляем на HH:', url);
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    console.log("[CALLBACK] Нет кода авторизации");
    return res.status(400).send('No code provided');
  }

  console.log('[CALLBACK] Получен code:', code);

  try {
    const resp = await axios.post('https://hh.ru/oauth/token', null, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      params: {
        grant_type: 'authorization_code',
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        code,
        redirect_uri: process.env.REDIRECT_URI,
        scope: 'resumes:download negotiations:read negotiations:write'
      }
    });

    if (!resp.data.access_token) {
      throw new Error("Нет access_token в ответе HH");
    }

    saveHhTokens(resp.data);
    console.log('[CALLBACK] Токен HH получен, выполняем fetchTodayResponses...');
    await fetchTodayResponses();
    res.send('HH Token obtained, responses fetched. Check logs.');
  } catch (err) {
    console.error('[CALLBACK] Ошибка при обмене code:', err.response?.data || err.message);
    res.status(500).send('Error exchanging code for token');
  }
});

app.get('/responses', async (req, res) => {
  await fetchTodayResponses();
  res.send('Check logs for details.');
});

app.post('/reaction', async (req, res) => {
  console.log('[WEBHOOK] Входящие данные:', req.body);
  const { type, event, message_id, code, user_id } = req.body;

  if (type === 'reaction' && event === 'new') {
    console.log(`[WEBHOOK] Обработка реакции ${code} для message_id=${message_id}`);

    try {
      const messageResponse = await axios.get(`https://api.pachca.com/api/shared/v1/messages/${message_id}`, {
        headers: {
          Authorization: `Bearer ${PACHCA_TOKEN}`
        }
      });
      let content = messageResponse.data.data.content;
      console.log(`[WEBHOOK] Получено content: ${content}`);

      let newContent = content;
      let tokenToUse = PACHCA_TOKEN;

      if (content.includes('hh.ru')) {
        console.log(`[WEBHOOK] Найден паттерн (hh.ru)`);
        newContent = replaceStatus(content, code);
      } else if (content.includes('career.habr.com')) {
        console.log(`[WEBHOOK] Найден паттерн (career.habr.com)`);
        tokenToUse = SECOND_PACHCA_TOKEN;
        newContent = replaceStatus(content, code);
      } else {
        console.log(`[WEBHOOK] Не удалось определить паттерн`);
        return res.status(400).send('Content pattern not recognized');
      }

      console.log(`[WEBHOOK] Новый контент для обновления: ${newContent}`);

      await axios.put(
        `https://api.pachca.com/api/shared/v1/messages/${message_id}`,
        { content: newContent },
        {
          headers: {
            Authorization: `Bearer ${tokenToUse}`,
            'Content-Type': 'application/json; charset=utf-8'
          }
        }
      );

      console.log(`[WEBHOOK] Контент сообщения успешно обновлен для message_id=${message_id}`);
      return res.send('Message content updated.');
    } catch (err) {
      console.error(`[WEBHOOK] Ошибка при обработке реакции для message_id=${message_id}:`, err.response?.data || err.message);
      return res.status(500).send('Error processing reaction');
    }
  }

  res.status(400).send('Unsupported webhook type or event');
});

// Вспомогательные функции для статусов
const statusRegex = /^\s*(🟢 \*\*New\*\*|👀 \*\*На рассмотрении\*\*|☎️ \*\*Собес\*\*|✅ \*\*Принят\*\*|❌ \*\*Отклонено\*\*)/m;

function replaceStatus(content, code) {
  const statusMapping = {
    '👀': '👀 **На рассмотрении**',
    '☎️': '☎️ **Собес**',
    '✅': '✅ **Принят**',
    '❌': '❌ **Отклонено**'
  };

  if (statusRegex.test(content)) {
    console.log('[WEBHOOK] Статус найден, выполняем замену');
    return content.replace(statusRegex, statusMapping[code]);
  } else {
    console.log('[WEBHOOK] Статус не найден, добавляем в начало');
    return `${statusMapping[code]} ${content.trim()}`;
  }
}

// Запуск сервера
app.listen(PORT, () => {
  if (!process.env.CLIENT_ID || !process.env.CLIENT_SECRET || !process.env.REDIRECT_URI) {
    console.error("[ERROR] Не заданы переменные окружения: CLIENT_ID, CLIENT_SECRET, REDIRECT_URI");
    process.exit(1);
  }
  console.log(process.env.SERVER_URL);
  console.log(`[SERVER] Запущен на порту ${PORT}`);
  console.log(process.env.CLIENT_ID, process.env.CLIENT_SECRET);
  cache = loadCacheAsArray();
  fetchTodayResponses();
});
