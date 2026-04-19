const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const db = new sqlite3.Database('database.db');

global.sessions = {};

// Настройки
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Таблицы
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, password TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS workouts (id INTEGER PRIMARY KEY, name TEXT, userId INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS exercises (id INTEGER PRIMARY KEY, name TEXT, details TEXT, workoutId INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS schedule (id INTEGER PRIMARY KEY, day TEXT, workoutId INTEGER, userId INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS weight_entries (id INTEGER PRIMARY KEY, weight REAL, date TEXT, userId INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY,
        userId INTEGER,
        start_date TEXT,
        end_date TEXT
    )`);
});

console.log("✅ База данных готова");

// Middleware: проверка авторизации + подписки
function requireAuth(req, res, next) {
    const token = req.query.token;
    if (!token || !global.sessions[token]) {
        return res.redirect('/');
    }

    req.userId = global.sessions[token].userId;
    req.userName = global.sessions[token].name;

    // Проверяем подписку
    db.get('SELECT end_date FROM subscriptions WHERE userId = ? ORDER BY id DESC LIMIT 1', 
        [req.userId], (err, sub) => {
        
        if (err || !sub) {
            return res.redirect('/subscription-expired?token=' + token);
        }

        const endDate = new Date(sub.end_date);
        const now = new Date();

        if (endDate < now) {
            return res.redirect('/subscription-expired?token=' + token);
        }

        // Подписка активна — продолжаем
        next();
    });
}

// Главная
app.get('/', (req, res) => res.render('main'));

// Регистрация
// Регистрация — без пробной подписки
app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);

    db.run('INSERT INTO users (name, email, password) VALUES (?, ?, ?)', [name, email, hashed], function(err) {
        if (err) return res.status(400).send('Email уже используется');

        const userId = this.lastID;

        // Создаём подписку с уже истёкшей датой (чтобы сразу требовать оплату)
        const start = new Date().toISOString().split('T')[0];
        const end = new Date(Date.now() - 24*60*60*1000).toISOString().split('T')[0]; // вчера

        db.run('INSERT INTO subscriptions (userId, start_date, end_date) VALUES (?, ?, ?)', [userId, start, end]);

        res.send('Регистрация успешна! Теперь войдите.');
    });
});

// Вход
app.post('/login', (req, res) => {
    const { email, password } = req.body;
    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (err || !user || !(await bcrypt.compare(password, user.password))) {
            return res.json({ error: 'Неверный email или пароль' });
        }
        const token = 'sess_' + Math.random().toString(36).substring(2, 15);
        global.sessions[token] = { userId: user.id, name: user.name };
        res.json({ token });
    });
});

// Dashboard
app.get('/dashboard', requireAuth, (req, res) => res.render('dashboard', { userName: req.userName }));

// Защищённые страницы
app.get('/create-workout', requireAuth, (req, res) => res.render('create-workout'));
app.get('/schedule', requireAuth, (req, res) => res.render('schedule'));
app.get('/view-schedule', requireAuth, (req, res) => res.render('view-schedule'));
app.get('/progress', requireAuth, (req, res) => res.render('progress'));

// Создать тренировку
app.post('/create-workout', requireAuth, (req, res) => {
    const { name, exercises } = req.body;
    const userId = req.userId;

    db.run('INSERT INTO workouts (name, userId) VALUES (?, ?)', [name, userId], function(err) {
        if (err) return res.status(500).json({ error: 'Ошибка сохранения' });

        const workoutId = this.lastID;
        const stmt = db.prepare('INSERT INTO exercises (name, details, workoutId) VALUES (?, ?, ?)');
        exercises.forEach(ex => {
            if (ex.name) stmt.run(ex.name.trim(), (ex.details || '').trim(), workoutId);
        });
        stmt.finalize();
        res.json({ success: true });
    });
});

// Сохранение расписания
app.post('/schedule', requireAuth, (req, res) => {
    const userId = req.userId;
    const { days } = req.body;

    db.run('DELETE FROM schedule WHERE userId = ?', [userId], (err) => {
        if (err) return res.status(500).json({ error: 'Ошибка' });

        const stmt = db.prepare('INSERT INTO schedule (day, workoutId, userId) VALUES (?, ?, ?)');
        Object.keys(days).forEach(day => {
            let workoutId = days[day];
            if (workoutId === "rest" || workoutId === null || workoutId === "null") workoutId = null;
            stmt.run(day, workoutId, userId);
        });
        stmt.finalize();
        res.json({ success: true });
    });
});

// API для списка тренировок (нужен для "Создать расписание")
app.get('/api/workouts', requireAuth, (req, res) => {
    console.log(`📥 Запрос /api/workouts от userId: ${req.userId}`);
    
    db.all(`SELECT id, name FROM workouts WHERE userId = ? ORDER BY id DESC`, [req.userId], (err, rows) => {
        if (err) {
            console.error("❌ Ошибка в /api/workouts:", err.message);
            return res.status(500).json({ error: "Ошибка базы данных" });
        }
        console.log(`✅ Найдено тренировок: ${rows.length}`);
        res.json(rows);
    });
});

// API для просмотра расписания
app.get('/api/schedule/view', requireAuth, (req, res) => {
    db.all(`
        SELECT s.day, COALESCE(w.name, 'Отдых') as workoutName, s.workoutId 
        FROM schedule s 
        LEFT JOIN workouts w ON s.workoutId = w.id 
        WHERE s.userId = ? 
        ORDER BY CASE s.day 
            WHEN 'понедельник' THEN 1 WHEN 'вторник' THEN 2 WHEN 'среда' THEN 3 
            WHEN 'четверг' THEN 4 WHEN 'пятница' THEN 5 WHEN 'суббота' THEN 6 
            WHEN 'воскресенье' THEN 7 END
    `, [req.userId], (err, rows) => res.json(rows || []));
});

// API для упражнений одной тренировки
app.get('/api/workout/:id', requireAuth, (req, res) => {
    db.all('SELECT name, details FROM exercises WHERE workoutId = ?', [req.params.id], (err, rows) => res.json(rows || []));
});

// API для получения текущего расписания пользователя
app.get('/api/schedule', requireAuth, (req, res) => {
    const userId = req.userId;
    db.all('SELECT day, workoutId FROM schedule WHERE userId = ?', [userId], (err, rows) => {
        if (err) {
            console.error("Ошибка /api/schedule:", err);
            return res.json([]);
        }
        res.json(rows);
    });
});

// API для статуса подписки (для Dashboard)
app.get('/api/subscription-status', requireAuth, (req, res) => {
    const userId = req.userId;

    db.get('SELECT end_date FROM subscriptions WHERE userId = ? ORDER BY id DESC LIMIT 1', [userId], (err, sub) => {
        if (err || !sub) {
            return res.json({ active: false, end_date: null, days_left: 0 });
        }

        const endDate = new Date(sub.end_date);
        const today = new Date();
        const daysLeft = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));

        res.json({
            active: daysLeft > 0,
            end_date: sub.end_date,
            days_left: daysLeft > 0 ? daysLeft : 0
        });
    });
});

// Страница истекшей подписки
// Страница истекшей подписки
app.get('/subscription-expired', (req, res) => {
    const token = req.query.token || '';
    res.render('subscription-expired', { token });
});

// Страница оплаты
app.get('/pay', (req, res) => {
    const token = req.query.token;
    if (!token || !global.sessions[token]) return res.redirect('/');
    res.render('pay');
});

// Успешная оплата
app.post('/pay-success', (req, res) => {
    const token = req.query.token;
    if (!token || !global.sessions[token]) return res.status(401).json({ error: 'Не авторизован' });

    const userId = global.sessions[token].userId;
    const start = new Date().toISOString().split('T')[0];
    const end = new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0];

    db.run('INSERT INTO subscriptions (userId, start_date, end_date) VALUES (?, ?, ?)', [userId, start, end], (err) => {
        if (err) return res.status(500).json({ error: 'Ошибка активации' });
        res.json({ success: true });
    });
});

// Добавление веса
app.post('/progress', requireAuth, (req, res) => {
    const { weight, date } = req.body;
    const userId = req.userId;

    if (!weight || !date) {
        return res.status(400).json({ error: 'Укажите вес и дату' });
    }

    db.run('INSERT INTO weight_entries (weight, date, userId) VALUES (?, ?, ?)', 
        [parseFloat(weight), date, userId], 
        (err) => {
            if (err) {
                console.error("Ошибка добавления веса:", err);
                return res.status(500).json({ error: 'Ошибка при добавлении веса' });
            }
            res.json({ success: true });
        });
});


// API для получения истории веса
app.get('/api/progress', requireAuth, (req, res) => {
    const userId = req.userId;
    console.log(`📥 Запрос истории веса для userId: ${userId}`);

    db.all(`
        SELECT id, weight, date 
        FROM weight_entries 
        WHERE userId = ? 
        ORDER BY date DESC
    `, [userId], (err, rows) => {
        if (err) {
            console.error("❌ Ошибка /api/progress:", err.message);
            return res.json([]);
        }
        console.log(`✅ Найдено записей веса: ${rows.length}`);
        res.json(rows);
    });
});


// GET /api/progress - получение всей истории веса
app.get('/api/progress', requireAuth, (req, res) => {
    const userId = req.userId;
    db.all(`
        SELECT id, weight, date 
        FROM weight_entries 
        WHERE userId = ? 
        ORDER BY date DESC
    `, [userId], (err, rows) => {
        if (err) {
            console.error("Ошибка получения прогресса:", err);
            return res.json([]);
        }
        res.json(rows);
    });
});

// DELETE /api/progress/:id - удаление одной записи
app.delete('/api/progress/:id', requireAuth, (req, res) => {
    const userId = req.userId;
    const id = req.params.id;

    db.run('DELETE FROM weight_entries WHERE id = ? AND userId = ?', [id, userId], function(err) {
        if (err) {
            console.error("Ошибка удаления:", err);
            return res.status(500).json({ error: 'Ошибка удаления' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Запись не найдена' });
        }
        res.json({ success: true });
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("🚀 Сервер запущен");
});