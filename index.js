// index.js (Render Node.jsサーバー - PostgreSQL永続化版)
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg'); // PostgreSQLクライアントのインポート

const app = express();

// PostgreSQLデータベースのセットアップ
// RenderはDATABASE_URL環境変数に接続文字列を提供します
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // RenderのSSL設定に対応
  }
});

// データベース接続テストとテーブル作成
pool.connect((err, client, done) => {
  if (err) {
    console.error('Error connecting to PostgreSQL database:', err.message);
    return;
  }
  console.log('Connected to the PostgreSQL database.');

  // テーブル作成（存在しない場合のみ）
  const createTablesSql = `
    CREATE TABLE IF NOT EXISTS user_profiles (
      userId TEXT PRIMARY KEY,
      displayName TEXT,
      rate INTEGER,
      wins INTEGER,
      losses INTEGER
    );
    CREATE TABLE IF NOT EXISTS matchmaking_queue (
      userId TEXT PRIMARY KEY,
      displayName TEXT,
      status TEXT,
      timestamp BIGINT, -- PostgreSQLのタイムスタンプはBIGINT
      matchId TEXT,
      player1Id TEXT,
      player2Id TEXT
    );
    CREATE TABLE IF NOT EXISTS active_matches (
      matchId TEXT PRIMARY KEY,
      player1Id TEXT,
      player2Id TEXT,
      status TEXT,
      createdAt BIGINT,
      completedAt BIGINT,
      cancelledBy TEXT,
      winnerId TEXT,
      loserId TEXT,
      rateChange INTEGER,
      chat TEXT -- JSON文字列として保存
    );
    CREATE TABLE IF NOT EXISTS match_confirmations (
      confirmationId TEXT PRIMARY KEY,
      matchId TEXT,
      userId TEXT,
      result TEXT,
      timestamp BIGINT
    );
  `;
  client.query(createTablesSql, (createErr) => {
    done(); // クライアントをプールに戻す
    if (createErr) {
      console.error('Error creating tables:', createErr.message);
    } else {
      console.log('Database tables ensured.');
    }
  });
});

// Renderは環境変数PORTでポート番号を指定します
const port = process.env.PORT || 10000; // Renderのデフォルトポートは10000

// --- CORS設定 ---
app.use(cors());

// JSON形式のボディを解析するミドルウェア
app.use(bodyParser.json());

// --- ルートエンドポイント（サーバーが動作しているか確認用） ---
app.get('/', (req, res) => {
  res.send('Anokoro TCG Backend is running on Render!');
});

// --- APIエンドポイントの定義 ---

// PostgreSQL操作をPromiseでラップするヘルパー関数
const pgQuery = async (sql, params) => {
    const client = await pool.connect();
    try {
        const res = await client.query(sql, params);
        return res;
    } finally {
        client.release();
    }
};

// ユーザープロファイルの取得
app.post('/getUserProfile', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        console.error('/getUserProfile: userId is missing in request body.');
        return res.status(400).json({ success: false, error: 'User ID is required.' });
    }
    try {
        let result = await pgQuery(`SELECT * FROM user_profiles WHERE userId = $1`, [userId]);
        let userProfile = result.rows[0];
        if (!userProfile) {
            userProfile = { userId, displayName: `Player_${userId.substring(0, 8)}`, rate: 1500, wins: 0, losses: 0 };
            await pgQuery(`INSERT INTO user_profiles (userId, displayName, rate, wins, losses) VALUES ($1, $2, $3, $4, $5)`,
                [userProfile.userId, userProfile.displayName, userProfile.rate, userProfile.wins, userProfile.losses]);
        }
        res.json({ success: true, data: userProfile });
    } catch (err) {
        console.error('/getUserProfile error:', err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// プレイヤー名の更新
app.post('/updateDisplayName', async (req, res) => {
    const { userId, newDisplayName } = req.body;
    if (!userId || !newDisplayName) {
        console.error('/updateDisplayName: userId or newDisplayName is missing.');
        return res.status(400).json({ success: false, error: 'User ID and display name are required.' });
    }
    try {
        const result = await pgQuery(`UPDATE user_profiles SET displayName = $1 WHERE userId = $2`, [newDisplayName, userId]);
        if (result.rowCount === 0) {
            // ユーザーが存在しない場合、新規作成
            await pgQuery(`INSERT INTO user_profiles (userId, displayName, rate, wins, losses) VALUES ($1, $2, $3, $4, $5)`,
                [userId, newDisplayName, 1500, 0, 0]);
            res.json({ success: true, message: 'New profile created.' });
        } else {
            res.json({ success: true, message: 'Display name updated.' });
        }
    } catch (err) {
        console.error('/updateDisplayName error:', err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// リーダーボードの取得
app.post('/getLeaderboard', async (req, res) => {
    try {
        const result = await pgQuery(`SELECT userId, displayName, rate, wins, losses FROM user_profiles ORDER BY rate DESC LIMIT 10`, []);
        res.json({ success: true, data: { leaderboard: result.rows } });
    } catch (err) {
        console.error('/getLeaderboard error:', err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// マッチメイキング処理
app.post('/handleMatchmaking', async (req, res) => {
    const { userId, displayName } = req.body;
    if (!userId || !displayName) {
        console.error('/handleMatchmaking: userId or displayName is missing.');
        return res.status(400).json({ success: false, error: 'User ID and display name are required.' });
    }
    const timestamp = Date.now();

    try {
        let queueResult = await pgQuery(`SELECT * FROM matchmaking_queue WHERE userId = $1`, [userId]);
        let queueRow = queueResult.rows[0];

        if (queueRow) {
            if (queueRow.status === 'matched') {
                return res.json({ success: true, data: { status: 'matched', matchId: queueRow.matchId, player1Id: queueRow.player1Id, player2Id: queueRow.player2Id } });
            } else {
                // 既に待機中ならタイムスタンプを更新して、キューの並び替えを促す
                await pgQuery(`UPDATE matchmaking_queue SET timestamp = $1 WHERE userId = $2`, [timestamp, userId]);
                return res.json({ success: true, data: { status: 'waiting' } });
            }
        }

        // 新規でキューに追加
        await pgQuery(`INSERT INTO matchmaking_queue (userId, displayName, status, timestamp) VALUES ($1, $2, 'waiting', $3)`,
            [userId, displayName, timestamp]);

        // 待機中の対戦相手を探す (自分以外の最も古いエントリ)
        const opponentResult = await pgQuery(`SELECT * FROM matchmaking_queue WHERE status = 'waiting' AND userId != $1 ORDER BY timestamp ASC LIMIT 1`, [userId]);
        const opponentRow = opponentResult.rows[0];

        if (opponentRow) {
            // マッチ成立
            const matchId = `match_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
            const player1Id = userId;
            const player2Id = opponentRow.userId;

            await pgQuery(`INSERT INTO active_matches (matchId, player1Id, player2Id, status, createdAt, chat) VALUES ($1, $2, $3, 'in-progress', $4, $5)`,
                [matchId, player1Id, player2Id, Date.now(), JSON.stringify([])]);

            // キューを更新 (matched状態に)
            await pgQuery(`UPDATE matchmaking_queue SET status = 'matched', matchId = $1, player1Id = $2, player2Id = $3 WHERE userId = $4`,
                [matchId, player1Id, player2Id, userId]);
            await pgQuery(`UPDATE matchmaking_queue SET status = 'matched', matchId = $1, player1Id = $2, player2Id = $3 WHERE userId = $4`,
                [matchId, player1Id, player2Id, opponentRow.userId]);

            return res.json({ success: true, data: { status: 'matched', matchId, player1Id, player2Id } });
        } else {
            // 相手が見つからなければ待機
            return res.json({ success: true, data: { status: 'waiting' } });
        }
    } catch (err) {
        console.error('/handleMatchmaking error:', err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// マッチングキューからのキャンセル
app.post('/cancelMatchmaking', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        console.error('/cancelMatchmaking: userId is missing.');
        return res.status(400).json({ success: false, error: 'User ID is required.' });
    }
    try {
        const result = await pgQuery(`DELETE FROM matchmaking_queue WHERE userId = $1`, [userId]);
        if (result.rowCount > 0) {
            res.json({ success: true, message: 'Matching cancelled.' });
        } else {
            res.json({ success: false, message: 'User not found in queue.' });
        }
    } catch (err) {
        console.error('/cancelMatchmaking error:', err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// マッチ状態の確認
app.post('/checkMatchStatus', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        console.error('/checkMatchStatus: userId is missing.');
        return res.status(400).json({ success: false, error: 'User ID is required.' });
    }
    try {
        const queueResult = await pgQuery(`SELECT * FROM matchmaking_queue WHERE userId = $1`, [userId]);
        const queueRow = queueResult.rows[0];

        if (queueRow && queueRow.status === 'matched') {
            const matchResult = await pgQuery(`SELECT * FROM active_matches WHERE matchId = $1`, [queueRow.matchId]);
            const matchRow = matchResult.rows[0];
            if (matchRow) {
                const matchInfo = {
                    matchId: matchRow.matchId,
                    player1Id: matchRow.player1Id,
                    player2Id: matchRow.player2Id,
                    status: matchRow.status
                };
                return res.json({ success: true, data: { status: 'matched', matchInfo } });
            } else {
                // キューではmatchedだが、アクティブマッチに見つからない場合はキューから削除してリセットを促す
                await pgQuery(`DELETE FROM matchmaking_queue WHERE userId = $1`, [userId]);
                return res.json({ success: true, data: { status: 'none', message: 'Matched entry found but no active match.' } });
            }
        } else if (queueRow && queueRow.status === 'waiting') {
            return res.json({ success: true, data: { status: 'waiting' } });
        } else {
            return res.json({ success: true, data: { status: 'none' } });
        }
    } catch (err) {
        console.error('/checkMatchStatus error:', err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// チャットメッセージ送信
app.post('/sendChatMessage', async (req, res) => {
    const { matchId, senderId, message } = req.body;
    if (!matchId || !senderId || !message) {
        console.error('/sendChatMessage: matchId, senderId or message is missing.');
        return res.status(400).json({ success: false, error: 'Match ID, sender ID and message are required.' });
    }
    try {
        const result = await pgQuery(`SELECT chat FROM active_matches WHERE matchId = $1`, [matchId]);
        const row = result.rows[0];
        if (row) {
            let chat = JSON.parse(row.chat || '[]');
            chat.push({ senderId, message, timestamp: Date.now() });
            await pgQuery(`UPDATE active_matches SET chat = $1 WHERE matchId = $2`, [JSON.stringify(chat), matchId]);
            res.json({ success: true });
        } else {
            res.json({ success: false, error: 'Match not found.' });
        }
    } catch (err) {
        console.error('/sendChatMessage error:', err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// チャットメッセージ取得
app.post('/getChatMessages', async (req, res) => {
    const { matchId, lastTimestamp } = req.body;
    if (!matchId) {
        console.error('/getChatMessages: matchId is missing.');
        return res.status(400).json({ success: false, error: 'Match ID is required.' });
    }
    try {
        const result = await pgQuery(`SELECT chat FROM active_matches WHERE matchId = $1`, [matchId]);
        const row = result.rows[0];
        if (row && row.chat) {
            const chat = JSON.parse(row.chat);
            const newMessages = chat.filter(msg => msg.timestamp > lastTimestamp)
                                    .sort((a, b) => a.timestamp - b.timestamp);
            res.json({ success: true, data: { messages: newMessages } });
        } else {
            res.json({ success: true, data: { messages: [] } });
        }
    } catch (err) {
        console.error('/getChatMessages error:', err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 対戦結果報告（簡易ELO計算も含む）
const K_FACTOR = 30; // ELOレート計算のKファクター
const calculateElo = (playerRate, opponentRate, isWin) => {
    const expectedScore = 1 / (1 + Math.pow(10, (opponentRate - playerRate) / 400));
    const actualScore = isWin ? 1 : 0;
    return playerRate + K_FACTOR * (actualScore - expectedScore);
};

app.post('/reportMatchResult', async (req, res) => {
    const { matchId, reporterId, result } = req.body;
    if (!matchId || !reporterId || !result) {
        console.error('/reportMatchResult: matchId, reporterId or result is missing.');
        return res.status(400).json({ success: false, error: 'Match ID, reporter ID and result are required.' });
    }
    try {
        const matchResult = await pgQuery(`SELECT * FROM active_matches WHERE matchId = $1`, [matchId]);
        const match = matchResult.rows[0];
        if (!match || match.status !== 'in-progress') {
            return res.json({ success: false, error: 'Match is not in progress or not found.' });
        }

        const player1Id = match.player1Id;
        const player2Id = match.player2Id;
        const opponentId = (reporterId === player1Id) ? player2Id : player1Id;

        const confirmationId = `${matchId}_${reporterId}`;
        await pgQuery(`INSERT INTO match_confirmations (confirmationId, matchId, userId, result, timestamp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(confirmationId) DO UPDATE SET result = $4, timestamp = $5`,
            [confirmationId, matchId, reporterId, result, Date.now()]);

        if (result === 'cancel') {
            await pgQuery(`UPDATE active_matches SET status = 'cancelled', cancelledBy = $1, completedAt = $2 WHERE matchId = $3`,
                [reporterId, Date.now(), matchId]);
            await pgQuery(`DELETE FROM matchmaking_queue WHERE userId IN ($1, $2)`, [player1Id, player2Id]);
            await pgQuery(`DELETE FROM match_confirmations WHERE matchId = $1`, [matchId]);
            return res.json({ success: true, message: 'Match cancelled.' });
        }

        const opponentConfResult = await pgQuery(`SELECT * FROM match_confirmations WHERE matchId = $1 AND userId = $2`, [matchId, opponentId]);
        const opponentConfirmation = opponentConfResult.rows[0];

        if (opponentConfirmation) {
            const myResultIsWin = (result === 'win');
            const opponentResultIsWin = (opponentConfirmation.result === 'win');
            const resultsConsistent = (myResultIsWin && !opponentResultIsWin) || (!myResultIsWin && opponentResultIsWin);
            if (!resultsConsistent) {
                console.warn(`Match ${matchId}: Result inconsistency between ${reporterId} (${result}) and ${opponentId} (${opponentConfirmation.result}). Prioritizing reporter's result.`);
            }

            let reporterProfileResult = await pgQuery(`SELECT rate, wins, losses FROM user_profiles WHERE userId = $1`, [reporterId]);
            let reporterProfile = reporterProfileResult.rows[0] || { rate: 1500, wins: 0, losses: 0 };

            let opponentProfileResult = await pgQuery(`SELECT rate FROM user_profiles WHERE userId = $1`, [opponentId]);
            let opponentProfile = opponentProfileResult.rows[0] || { rate: 1500 };

            const reporterOldRate = reporterProfile.rate;
            const opponentOldRate = opponentProfile.rate;

            const reporterNewRate = calculateElo(reporterOldRate, opponentOldRate, myResultIsWin);
            const reporterRateChange = Math.round(reporterNewRate - reporterOldRate);

            const newWins = myResultIsWin ? (reporterProfile.wins || 0) + 1 : (reporterProfile.wins || 0);
            const newLosses = myResultIsWin ? (reporterProfile.losses || 0) : (reporterProfile.losses || 0) + 1;

            await pgQuery(`UPDATE user_profiles SET rate = $1, wins = $2, losses = $3 WHERE userId = $4`,
                [Math.round(reporterNewRate), newWins, newLosses, reporterId]);

            await pgQuery(`UPDATE active_matches SET status = 'completed', winnerId = $1, loserId = $2, rateChange = $3, completedAt = $4 WHERE matchId = $5`,
                [myResultIsWin ? reporterId : opponentId, myResultIsWin ? opponentId : reporterId, reporterRateChange, Date.now(), matchId]);

            await pgQuery(`DELETE FROM matchmaking_queue WHERE userId IN ($1, $2)`, [player1Id, player2Id]);
            await pgQuery(`DELETE FROM match_confirmations WHERE matchId = $1`, [matchId]);
            return res.json({ success: true, message: 'Match completed and rates updated.', rateChange: reporterRateChange });
        } else {
            return res.json({ success: true, message: 'Waiting for opponent\'s result.' });
        }
    } catch (err) {
        console.error('/reportMatchResult error:', err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});


// --- サーバーの起動 ---
const listener = app.listen(port, () => {
    console.log('Your app is listening on port ' + listener.address().port);
});