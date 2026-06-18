const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
// 針對 Zeabur 等雲端環境的部署設定：優先使用環境變數的 PORT
const PORT = process.env.PORT || 3000;

// Middleware 設置
app.use(bodyParser.json());
// 設定靜態檔案目錄 (將 index.html 放在名為 public 的資料夾中)
app.use(express.static(path.join(__dirname, 'public')));

// 資料庫初始化
// 在 Zeabur 上，SQLite 檔案會建立在容器的目錄中
const dbPath = path.join(__dirname, 'health_logs.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('資料庫連接失敗:', err.message);
    } else {
        console.log('成功連接至 SQLite 資料庫。');
        // 建立 health_logs 資料表 (Schema)
        db.run(`
            CREATE TABLE IF NOT EXISTS health_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                log_date DATE NOT NULL,
                sleep_hours REAL NOT NULL,
                steps INTEGER NOT NULL,
                mood_score INTEGER NOT NULL,
                risk_level TEXT
            )
        `);
    }
});

// ==========================================
// 核心演算法：多層分支決策樹 (Decision Tree)
// 依序判斷：【睡眠時數】 -> 【當日步數】 -> 【心情分數】
// ==========================================
function evaluateRiskTree(sleep, steps, mood) {
    // 【第一層：睡眠時數】
    if (sleep < 6.0) {
        return treeNodeSleepPoor(steps, mood);
    } else if (sleep >= 6.0 && sleep <= 8.5) {
        return treeNodeSleepGood(steps, mood);
    } else {
        // 睡眠過長 (> 8.5)
        return treeNodeSleepExcess(steps, mood);
    }
}

// 【第二層：睡眠不佳分支】
function treeNodeSleepPoor(steps, mood) {
    if (steps < 5000) {
        // 步數少且睡眠差，直接依心情評估最差狀況
        return mood < 5 ? '高風險' : '中風險';
    } else {
        // 步數達標，但睡眠極少（模糊情況處理）
        return mood >= 7 ? '中風險' : '高風險';
    }
}

// 【第二層：睡眠優良分支】
function treeNodeSleepGood(steps, mood) {
    if (steps >= 8000) {
        // 睡眠好且步數高
        return mood >= 5 ? '低風險' : '中風險';
    } else if (steps >= 4000) {
        // 睡眠好，步數普通
        return mood >= 6 ? '低風險' : '中風險';
    } else {
        // 睡眠好，但極度缺乏活動
        return mood >= 5 ? '中風險' : '高風險';
    }
}

// 【第二層：睡眠過長分支】
function treeNodeSleepExcess(steps, mood) {
    if (steps < 5000) {
        return mood < 5 ? '高風險' : '中風險';
    } else {
        return mood >= 6 ? '低風險' : '中風險';
    }
}

// ==========================================
// RESTful API 端點
// ==========================================

// 1. GET /health-logs : 取得所有健康日誌紀錄
app.get('/health-logs', (req, res) => {
    const sql = `SELECT * FROM health_logs ORDER BY log_date DESC, id DESC`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 2. POST /health-logs : 新增一筆健康日誌
app.post('/health-logs', (req, res) => {
    const { log_date, sleep_hours, steps, mood_score } = req.body;
    
    if (!log_date || sleep_hours == null || steps == null || mood_score == null) {
        return res.status(400).json({ error: '請提供完整的健康數據。' });
    }

    // 呼叫決策樹計算風險等級
    const risk_level = evaluateRiskTree(Number(sleep_hours), Number(steps), Number(mood_score));

    const sql = `INSERT INTO health_logs (log_date, sleep_hours, steps, mood_score, risk_level) VALUES (?, ?, ?, ?, ?)`;
    db.run(sql, [log_date, sleep_hours, steps, mood_score, risk_level], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ id: this.lastID, risk_level, message: '日誌新增成功' });
    });
});

// 3. PUT /health-logs/:id : 修改指定 ID 的日誌內容（重新計算風險）
app.put('/health-logs/:id', (req, res) => {
    const id = req.params.id;
    const { log_date, sleep_hours, steps, mood_score } = req.body;

    const risk_level = evaluateRiskTree(Number(sleep_hours), Number(steps), Number(mood_score));

    const sql = `UPDATE health_logs SET log_date = ?, sleep_hours = ?, steps = ?, mood_score = ?, risk_level = ? WHERE id = ?`;
    db.run(sql, [log_date, sleep_hours, steps, mood_score, risk_level, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: '找不到該筆紀錄' });
        res.json({ message: '日誌更新成功', risk_level });
    });
});

// 4. DELETE /health-logs/:id : 刪除指定 ID 的日誌
app.delete('/health-logs/:id', (req, res) => {
    const id = req.params.id;
    const sql = `DELETE FROM health_logs WHERE id = ?`;
    db.run(sql, id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: '找不到該筆紀錄' });
        res.json({ message: '日誌刪除成功' });
    });
});

// 5. GET /health-logs/risk : 取得最新一筆日誌的風險評估狀態
app.get('/health-logs/risk', (req, res) => {
    const sql = `SELECT * FROM health_logs ORDER BY log_date DESC, id DESC LIMIT 1`;
    db.get(sql, [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: '尚無任何紀錄' });
        
        const latestRisk = evaluateRiskTree(row.sleep_hours, row.steps, row.mood_score);
        res.json({ latest_log: row, evaluated_risk: latestRisk });
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`伺服器已啟動並監聽於 Port: ${PORT}`);
});