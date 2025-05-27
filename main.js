require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Telegraf } = require('telegraf');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3000;

//middleware
app.use(cors());
app.use(bodyParser.json());

//подключение к бд
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

db.connect(err => {
  if (err) {
    console.error('ошибка подключения к бд:', err.stack);
    return;
  }
  console.log('подключено к бд');
});

//настройка телеграм бота
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const verificationRequests = new Map();

//1.получение информации о гильдиях
app.get('/api/guilds', (req, res) => {
  db.query('SELECT `user-in-siteid`, id, name, tag, leader_name, status FROM guilds', (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'ошибка бд' });
    }
    res.json(results);
  });
});

//2.проверка никнейма в mojang api
app.post('/api/check-username', async (req, res) => {
  const { username } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: 'никнейм обязателен' });
  }

  try {
    const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${username}`);
    
    if (response.status === 204) {
      return res.json({ exists: false, message: 'пользователь не найден в mojang' });
    }
    
    const data = await response.json();
    res.json({ exists: true, uuid: data.id, username: data.name });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'ошибка проверки никнейма' });
  }
});

//3.запрос верификации
app.post('/api/request-verification', async (req, res) => {
  const { username, userId, telegramChatId } = req.body;
  
  if (!username || !userId || !telegramChatId) {
    return res.status(400).json({ error: 'не заполнены обязательные поля' });
  }

  //сохраняем запрос на верификацию
  const verificationId = Math.random().toString(36).substring(2, 15);
  verificationRequests.set(verificationId, { username, userId, status: 'pending' });

  //отправляем сообщение в телеграм канал
  try {
    await bot.telegram.sendMessage(
      process.env.TELEGRAM_CHANNEL_ID,
      `запрос на верификацию:\n\nигрок: ${username}\nid пользователя: ${userId}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'принять', callback_data: `approve_${verificationId}` },
              { text: 'отклонить', callback_data: `reject_${verificationId}` }
            ]
          ]
        }
      }
    );
    
    res.json({ success: true, message: 'запрос на верификацию отправлен' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'ошибка отправки запроса' });
  }
});

//обработка кнопок телеграм бота
bot.action(/approve_(.+)/, async (ctx) => {
  const verificationId = ctx.match[1];
  const request = verificationRequests.get(verificationId);
  
  if (request) {
    request.status = 'approved';
    
    //обновляем статус в бд
    db.query(
      'UPDATE guilds SET status = ? WHERE id = ?',
      ['verified', request.userId],
      (err) => {
        if (err) {
          console.error(err);
          return ctx.reply('ошибка обновления статуса в бд');
        }
        
        ctx.editMessageText(`верификация для ${request.username} одобрена`);
        verificationRequests.delete(verificationId);
      }
    );
  } else {
    ctx.reply('запрос на верификацию не найден');
  }
});

bot.action(/reject_(.+)/, async (ctx) => {
  const verificationId = ctx.match[1];
  const request = verificationRequests.get(verificationId);
  
  if (request) {
    request.status = 'rejected';
    verificationRequests.delete(verificationId);
    ctx.editMessageText(`верификация для ${request.username} отклонена`);
  } else {
    ctx.reply('запрос на верификацию не найден');
  }
});

//запуск бота
bot.launch();

//запуск сервера
app.listen(port, () => {
  console.log(`сервер запущен на порту ${port}`);
});

process.on('SIGINT', () => {
  bot.stop();
  process.exit();
});