// index.js (Replit Node.jsサーバー - SQLite永続化版 - 修正版)
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose(); // SQLiteデータベースのインポート

const app = express();

// SQLiteデータベースのセットアップ
// 'database.sqlite'というファイル名でデータベースを作成/接続
const db = new sqlite3.Database("./database.sqlite", (err) => {
    if (err) {
        console.error("Error connecting to SQLite database:", err.message);
    } else {
        console.log("Connected to the SQLite database.");
        // データベースが存在しない場合はテーブルを作成
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS user_profiles (
        userId TEXT PRIMARY KEY,
        displayName TEXT,
        rate INTEGER,
        wins INTEGER,
        losses INTEGER
      )`);
            db.run(`CREATE TABLE IF NOT EXISTS matchmaking_queue (
        userId TEXT PRIMARY KEY,
        displayName TEXT,
        status TEXT,
        timestamp INTEGER,
        matchId TEXT,
        player1Id TEXT, -- マッチ成立時のP1ID
        player2Id TEXT  -- マッチ成立時のP2ID
      )`);
            db.run(`CREATE TABLE IF NOT EXISTS active_matches (
        matchId TEXT PRIMARY KEY,
        player1Id TEXT,
        player2Id TEXT,
        status TEXT,
        createdAt INTEGER,
        completedAt INTEGER,
        cancelledBy TEXT,
        winnerId TEXT,
        loserId TEXT,
        rateChange INTEGER,
        chat TEXT -- JSON文字列としてチャットを保存
      )`);
            db.run(`CREATE TABLE IF NOT EXISTS match_confirmations (
        confirmationId TEXT PRIMARY KEY,
        matchId TEXT,
        userId TEXT,
        result TEXT,
        timestamp INTEGER
      )`);
            console.log("Database tables ensured.");
        });
    }
});

// Replitは環境変数PORTでポート番号を指定します
const port = process.env.PORT || 3000;

// --- CORS設定 ---
app.use(cors());

// JSON形式のボディを解析するミドルウェア
// このミドルウェアがPOSTリクエストのbodyをreq.bodyにパースします。
// これが正しく機能しないと、req.bodyがundefinedになり、
// エンドポイントがGETリクエストを受け取ったかのように振る舞うことがあります。
app.use(bodyParser.json());

// --- ルートエンドポイント（サーバーが動作しているか確認用） ---
app.get("/", (req, res) => {
    res.send("Anokoro TCG Backend is running on Replit!");
});

// --- APIエンドポイントの定義 ---

// SQLite操作をPromiseでラップするヘルパー関数
const dbGet = (sql, params) => {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

const dbAll = (sql, params) => {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

const dbRun = (sql, params) => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            // 'function'キーワードでthisコンテキストを保持
            if (err) reject(err);
            else resolve(this); // this.changes, this.lastID などを返す
        });
    });
};

// ユーザープロファイルの取得
app.post("/getUserProfile", async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        // userIdのバリデーションを追加
        console.error("/getUserProfile: userId is missing in request body.");
        return res
            .status(400)
            .json({ success: false, error: "User ID is required." });
    }
    try {
        let userProfile = await dbGet(
            `SELECT * FROM user_profiles WHERE userId = ?`,
            [userId],
        );
        if (!userProfile) {
            userProfile = {
                userId,
                displayName: `Player_${userId.substring(0, 8)}`,
                rate: 1500,
                wins: 0,
                losses: 0,
            };
            await dbRun(
                `INSERT INTO user_profiles (userId, displayName, rate, wins, losses) VALUES (?, ?, ?, ?, ?)`,
                [
                    userProfile.userId,
                    userProfile.displayName,
                    userProfile.rate,
                    userProfile.wins,
                    userProfile.losses,
                ],
            );
        }
        res.json({ success: true, data: userProfile });
    } catch (err) {
        console.error("/getUserProfile error:", err.message, err.stack); // スタックトレースも出力
        res.status(500).json({ success: false, error: err.message });
    }
});

// プレイヤー名の更新
app.post("/updateDisplayName", async (req, res) => {
    const { userId, newDisplayName } = req.body;
    if (!userId || !newDisplayName) {
        console.error(
            "/updateDisplayName: userId or newDisplayName is missing.",
        );
        return res
            .status(400)
            .json({
                success: false,
                error: "User ID and display name are required.",
            });
    }
    try {
        const result = await dbRun(
            `UPDATE user_profiles SET displayName = ? WHERE userId = ?`,
            [newDisplayName, userId],
        );
        if (result.changes === 0) {
            // ユーザーが存在しない場合、新規作成
            await dbRun(
                `INSERT INTO user_profiles (userId, displayName, rate, wins, losses) VALUES (?, ?, ?, ?, ?)`,
                [userId, newDisplayName, 1500, 0, 0],
            );
            res.json({ success: true, message: "New profile created." });
        } else {
            res.json({ success: true, message: "Display name updated." });
        }
    } catch (err) {
        console.error("/updateDisplayName error:", err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// リーダーボードの取得
app.post("/getLeaderboard", async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT userId, displayName, rate, wins, losses FROM user_profiles ORDER BY rate DESC LIMIT 10`,
            [],
        );
        res.json({ success: true, data: { leaderboard: rows } });
    } catch (err) {
        console.error("/getLeaderboard error:", err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// マッチメイキング処理
app.post("/handleMatchmaking", async (req, res) => {
    const { userId, displayName } = req.body;
    if (!userId || !displayName) {
        console.error("/handleMatchmaking: userId or displayName is missing.");
        return res
            .status(400)
            .json({
                success: false,
                error: "User ID and display name are required.",
            });
    }
    const timestamp = Date.now();

    try {
        let queueRow = await dbGet(
            `SELECT * FROM matchmaking_queue WHERE userId = ?`,
            [userId],
        );

        if (queueRow) {
            if (queueRow.status === "matched") {
                return res.json({
                    success: true,
                    data: {
                        status: "matched",
                        matchId: queueRow.matchId,
                        player1Id: queueRow.player1Id,
                        player2Id: queueRow.player2Id,
                    },
                });
            } else {
                // 既に待機中ならタイムスタンプを更新して、キューの並び替えを促す
                await dbRun(
                    `UPDATE matchmaking_queue SET timestamp = ? WHERE userId = ?`,
                    [timestamp, userId],
                );
                return res.json({ success: true, data: { status: "waiting" } });
            }
        }

        // 新規でキューに追加
        await dbRun(
            `INSERT INTO matchmaking_queue (userId, displayName, status, timestamp) VALUES (?, ?, 'waiting', ?)`,
            [userId, displayName, timestamp],
        );

        // 待機中の対戦相手を探す (自分以外の最も古いエントリ)
        const opponentRow = await dbGet(
            `SELECT * FROM matchmaking_queue WHERE status = 'waiting' AND userId != ? ORDER BY timestamp ASC LIMIT 1`,
            [userId],
        );

        if (opponentRow) {
            // マッチ成立
            const matchId = `match_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
            const player1Id = userId;
            const player2Id = opponentRow.userId;

            await dbRun(
                `INSERT INTO active_matches (matchId, player1Id, player2Id, status, createdAt, chat) VALUES (?, ?, ?, 'in-progress', ?, ?)`,
                [matchId, player1Id, player2Id, Date.now(), JSON.stringify([])],
            );

            // キューを更新 (matched状態に)
            await dbRun(
                `UPDATE matchmaking_queue SET status = 'matched', matchId = ?, player1Id = ?, player2Id = ? WHERE userId = ?`,
                [matchId, player1Id, player2Id, userId],
            );
            await dbRun(
                `UPDATE matchmaking_queue SET status = 'matched', matchId = ?, player1Id = ?, player2Id = ? WHERE userId = ?`,
                [matchId, player1Id, player2Id, opponentRow.userId],
            );

            return res.json({
                success: true,
                data: { status: "matched", matchId, player1Id, player2Id },
            });
        } else {
            // 相手が見つからなければ待機
            return res.json({ success: true, data: { status: "waiting" } });
        }
    } catch (err) {
        console.error("/handleMatchmaking error:", err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// マッチングキューからのキャンセル
app.post("/cancelMatchmaking", async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        console.error("/cancelMatchmaking: userId is missing.");
        return res
            .status(400)
            .json({ success: false, error: "User ID is required." });
    }
    try {
        const result = await dbRun(
            `DELETE FROM matchmaking_queue WHERE userId = ?`,
            [userId],
        );
        if (result.changes > 0) {
            res.json({ success: true, message: "Matching cancelled." });
        } else {
            res.json({ success: false, message: "User not found in queue." });
        }
    } catch (err) {
        console.error("/cancelMatchmaking error:", err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// マッチ状態の確認
app.post("/checkMatchStatus", async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        console.error("/checkMatchStatus: userId is missing.");
        return res
            .status(400)
            .json({ success: false, error: "User ID is required." });
    }
    try {
        const queueRow = await dbGet(
            `SELECT * FROM matchmaking_queue WHERE userId = ?`,
            [userId],
        );

        if (queueRow && queueRow.status === "matched") {
            const matchRow = await dbGet(
                `SELECT * FROM active_matches WHERE matchId = ?`,
                [queueRow.matchId],
            );
            if (matchRow) {
                const matchInfo = {
                    matchId: matchRow.matchId,
                    player1Id: matchRow.player1Id,
                    player2Id: matchRow.player2Id,
                    status: matchRow.status,
                };
                return res.json({
                    success: true,
                    data: { status: "matched", matchInfo },
                });
            } else {
                // キューではmatchedだが、アクティブマッチに見つからない場合はキューから削除してリセットを促す
                await dbRun(`DELETE FROM matchmaking_queue WHERE userId = ?`, [
                    userId,
                ]);
                return res.json({
                    success: true,
                    data: {
                        status: "none",
                        message: "Matched entry found but no active match.",
                    },
                });
            }
        } else if (queueRow && queueRow.status === "waiting") {
            return res.json({ success: true, data: { status: "waiting" } });
        } else {
            return res.json({ success: true, data: { status: "none" } });
        }
    } catch (err) {
        console.error("/checkMatchStatus error:", err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// チャットメッセージ送信
app.post("/sendChatMessage", async (req, res) => {
    const { matchId, senderId, message } = req.body;
    if (!matchId || !senderId || !message) {
        console.error(
            "/sendChatMessage: matchId, senderId or message is missing.",
        );
        return res
            .status(400)
            .json({
                success: false,
                error: "Match ID, sender ID and message are required.",
            });
    }
    try {
        const row = await dbGet(
            `SELECT chat FROM active_matches WHERE matchId = ?`,
            [matchId],
        );
        if (row) {
            let chat = JSON.parse(row.chat || "[]");
            chat.push({ senderId, message, timestamp: Date.now() });
            await dbRun(
                `UPDATE active_matches SET chat = ? WHERE matchId = ?`,
                [JSON.stringify(chat), matchId],
            );
            res.json({ success: true });
        } else {
            res.json({ success: false, error: "Match not found." });
        }
    } catch (err) {
        console.error("/sendChatMessage error:", err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// チャットメッセージ取得
app.post("/getChatMessages", async (req, res) => {
    const { matchId, lastTimestamp } = req.body;
    if (!matchId) {
        console.error("/getChatMessages: matchId is missing.");
        return res
            .status(400)
            .json({ success: false, error: "Match ID is required." });
    }
    try {
        const row = await dbGet(
            `SELECT chat FROM active_matches WHERE matchId = ?`,
            [matchId],
        );
        if (row && row.chat) {
            const chat = JSON.parse(row.chat);
            const newMessages = chat
                .filter((msg) => msg.timestamp > lastTimestamp)
                .sort((a, b) => a.timestamp - b.timestamp);
            res.json({ success: true, data: { messages: newMessages } });
        } else {
            res.json({ success: true, data: { messages: [] } });
        }
    } catch (err) {
        console.error("/getChatMessages error:", err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 対戦結果報告（簡易ELO計算も含む）
const K_FACTOR = 30; // ELOレート計算のKファクター
const calculateElo = (playerRate, opponentRate, isWin) => {
    const expectedScore =
        1 / (1 + Math.pow(10, (opponentRate - playerRate) / 400));
    const actualScore = isWin ? 1 : 0;
    return playerRate + K_FACTOR * (actualScore - expectedScore);
};

app.post("/reportMatchResult", async (req, res) => {
    const { matchId, reporterId, result } = req.body;
    if (!matchId || !reporterId || !result) {
        console.error(
            "/reportMatchResult: matchId, reporterId or result is missing.",
        );
        return res
            .status(400)
            .json({
                success: false,
                error: "Match ID, reporter ID and result are required.",
            });
    }
    try {
        const match = await dbGet(
            `SELECT * FROM active_matches WHERE matchId = ?`,
            [matchId],
        );
        if (!match || match.status !== "in-progress") {
            return res.json({
                success: false,
                error: "Match is not in progress or not found.",
            });
        }

        const player1Id = match.player1Id;
        const player2Id = match.player2Id;
        const opponentId = reporterId === player1Id ? player2Id : player1Id;

        const confirmationId = `${matchId}_${reporterId}`;
        await dbRun(
            `INSERT OR REPLACE INTO match_confirmations (confirmationId, matchId, userId, result, timestamp) VALUES (?, ?, ?, ?, ?)`,
            [confirmationId, matchId, reporterId, result, Date.now()],
        );

        if (result === "cancel") {
            await dbRun(
                `UPDATE active_matches SET status = 'cancelled', cancelledBy = ?, completedAt = ? WHERE matchId = ?`,
                [reporterId, Date.now(), matchId],
            );
            await dbRun(
                `DELETE FROM matchmaking_queue WHERE userId IN (?, ?)`,
                [player1Id, player2Id],
            );
            await dbRun(`DELETE FROM match_confirmations WHERE matchId = ?`, [
                matchId,
            ]);
            return res.json({ success: true, message: "Match cancelled." });
        }

        const opponentConfirmation = await dbGet(
            `SELECT * FROM match_confirmations WHERE matchId = ? AND userId = ?`,
            [matchId, opponentId],
        );

        if (opponentConfirmation) {
            const myResultIsWin = result === "win";
            const opponentResultIsWin = opponentConfirmation.result === "win";
            const resultsConsistent =
                (myResultIsWin && !opponentResultIsWin) ||
                (!myResultIsWin && opponentResultIsWin);
            if (!resultsConsistent) {
                console.warn(
                    `Match ${matchId}: Result inconsistency between ${reporterId} (${result}) and ${opponentId} (${opponentConfirmation.result}). Prioritizing reporter's result.`,
                );
            }

            let reporterProfile = await dbGet(
                `SELECT rate, wins, losses FROM user_profiles WHERE userId = ?`,
                [reporterId],
            );
            reporterProfile = reporterProfile || {
                rate: 1500,
                wins: 0,
                losses: 0,
            };

            let opponentProfile = await dbGet(
                `SELECT rate FROM user_profiles WHERE userId = ?`,
                [opponentId],
            );
            opponentProfile = opponentProfile || { rate: 1500 };

            const reporterOldRate = reporterProfile.rate;
            const opponentOldRate = opponentProfile.rate;

            const reporterNewRate = calculateElo(
                reporterOldRate,
                opponentOldRate,
                myResultIsWin,
            );
            const reporterRateChange = Math.round(
                reporterNewRate - reporterOldRate,
            );

            const newWins = myResultIsWin
                ? (reporterProfile.wins || 0) + 1
                : reporterProfile.wins || 0;
            const newLosses = myResultIsWin
                ? reporterProfile.losses || 0
                : (reporterProfile.losses || 0) + 1;

            await dbRun(
                `UPDATE user_profiles SET rate = ?, wins = ?, losses = ? WHERE userId = ?`,
                [Math.round(reporterNewRate), newWins, newLosses, reporterId],
            );

            await dbRun(
                `UPDATE active_matches SET status = 'completed', winnerId = ?, loserId = ?, rateChange = ?, completedAt = ? WHERE matchId = ?`,
                [
                    myResultIsWin ? reporterId : opponentId,
                    myResultIsWin ? opponentId : reporterId,
                    reporterRateChange,
                    Date.now(),
                    matchId,
                ],
            );

            await dbRun(
                `DELETE FROM matchmaking_queue WHERE userId IN (?, ?)`,
                [player1Id, player2Id],
            );
            await dbRun(`DELETE FROM match_confirmations WHERE matchId = ?`, [
                matchId,
            ]);
            return res.json({
                success: true,
                message: "Match completed and rates updated.",
                rateChange: reporterRateChange,
            });
        } else {
            return res.json({
                success: true,
                message: "Waiting for opponent's result.",
            });
        }
    } catch (err) {
        console.error("/reportMatchResult error:", err.message, err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- サーバーの起動 ---
const listener = app.listen(port, () => {
    console.log("Your app is listening on port " + listener.address().port);
});
