// index.js (Renderサーバーのバックエンドコード) - 安定化版 v3.1

const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

// --- データベース接続設定 ---
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is not set.');
}
const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
});

pool.query('SELECT NOW()', (err, result) => {
    if (err) return console.error('ERROR: Database connection failed:', err.stack);
    console.log('Database connected successfully:', result.rows[0].now);
});

// --- データベース初期化 ---
async function initializeDatabase() {
    if (!databaseUrl) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                user_id UUID PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                display_name VARCHAR(255) NOT NULL DEFAULT '',
                rate INTEGER DEFAULT 1500,
                match_history JSONB DEFAULT '[]'::jsonb,
                memos JSONB DEFAULT '[]'::jsonb,
                battle_records JSONB DEFAULT '[]'::jsonb,
                registered_decks JSONB DEFAULT '[]'::jsonb,
                current_match_id UUID
            );
        `);
        console.log('Database: Users table ensured.');

        const columns = [
            { name: 'display_name', type: "VARCHAR(255) NOT NULL DEFAULT ''" },
            { name: 'memos', type: "JSONB DEFAULT '[]'::jsonb" },
            { name: 'battle_records', type: "JSONB DEFAULT '[]'::jsonb" },
            { name: 'registered_decks', type: "JSONB DEFAULT '[]'::jsonb" },
            { name: 'current_match_id', type: "UUID" }
        ];
        for (const col of columns) {
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col.name} ${col.type};`);
        }
        console.log('Database: All columns ensured.');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS matches (
                match_id UUID PRIMARY KEY,
                player1_id UUID NOT NULL,
                player2_id UUID NOT NULL,
                player1_report VARCHAR(10),
                player2_report VARCHAR(10),
                resolved_at TIMESTAMPTZ
            );
        `);
        console.log('Database: Matches table ensured.');
    } catch (err) {
        console.error('ERROR: Database initialization failed:', err.stack);
    }
}
initializeDatabase();

// --- HTTPサーバー設定 ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebSocket server is running.');
});

// --- WebSocketサーバー設定 ---
const wss = new WebSocket.Server({ server });
console.log('WebSocket server starting...');

// --- グローバル状態管理 ---
let waitingPlayers = []; // { userId, wsId }
const activeConnections = new Map(); // ws -> { ws_id, user_id }
const wsIdToWs = new Map(); // wsId -> ws
const userToWsId = new Map(); // userId -> wsId
const userMatches = new Map(); // userId -> matchId

// --- ヘルパー関数 ---
async function getUserData(userId) {
    if (!databaseUrl || !userId) return null;
    const res = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
    return res.rows[0];
}

async function updateUserData(userId, data) {
    if (!databaseUrl || !userId || !data) return;
    const client = await pool.connect();
    try {
        const setClauses = [];
        const values = [];
        let valueIndex = 1;

        if (data.displayName !== undefined) { setClauses.push(`display_name = $${valueIndex++}`); values.push(data.displayName); }
        if (data.rate !== undefined) { setClauses.push(`rate = $${valueIndex++}`); values.push(data.rate); }
        if (data.matchHistory !== undefined) { setClauses.push(`match_history = $${valueIndex++}`); values.push(JSON.stringify(data.matchHistory)); }
        // ... 他のフィールドも同様に追加 ...
        
        if (setClauses.length === 0) return;

        values.push(userId);
        const queryText = `UPDATE users SET ${setClauses.join(', ')} WHERE user_id = $${valueIndex}`;
        await client.query(queryText, values);
    } finally {
        client.release();
    }
}

async function getUserIdByUsername(username) {
    if (!databaseUrl || !username) return null;
    const res = await pool.query('SELECT user_id FROM users WHERE username = $1', [username]);
    return res.rows[0] ? res.rows[0].user_id : null;
}

// [★追加] Eloレーティング計算
function calculateElo(playerRate, opponentRate, result) {
    const k = 32; // K-factor
    const expectedScore = 1 / (1 + Math.pow(10, (opponentRate - playerRate) / 400));
    let actualScore;
    if (result === 'win') actualScore = 1;
    else if (result === 'lose') actualScore = 0;
    else actualScore = 0.5; // Draw or cancel

    return Math.round(playerRate + k * (actualScore - expectedScore));
}


// [★追加] マッチング試行
async function tryMatchPlayers() {
    if (waitingPlayers.length < 2) return;

    console.log('Matching: Attempting to match players. Queue size:', waitingPlayers.length);
    const [player1Info, player2Info] = waitingPlayers.splice(0, 2);

    const player1Ws = wsIdToWs.get(player1Info.wsId);
    const player2Ws = wsIdToWs.get(player2Info.wsId);

    if (!player1Ws || !player2Ws) {
        console.error('Matching: One or both players disconnected before match could start.');
        // 片方が切断していた場合、もう片方を待ち行列に戻す
        if (player1Ws) waitingPlayers.unshift(player1Info);
        if (player2Ws) waitingPlayers.unshift(player2Info);
        return;
    }
    
    const player1Data = await getUserData(player1Info.userId);
    const player2Data = await getUserData(player2Info.userId);

    const matchId = uuidv4();
    userMatches.set(player1Info.userId, matchId);
    userMatches.set(player2Info.userId, matchId);

    await pool.query('INSERT INTO matches (match_id, player1_id, player2_id) VALUES ($1, $2, $3)', [matchId, player1Info.userId, player2Info.userId]);

    player1Ws.send(JSON.stringify({
        type: 'match_found',
        matchId: matchId,
        opponentId: player2Info.userId,
        opponentDisplayName: player2Data.display_name,
        initiator: true // player1がWebRTCのオファーを開始する
    }));
    player2Ws.send(JSON.stringify({
        type: 'match_found',
        matchId: matchId,
        opponentId: player1Info.userId,
        opponentDisplayName: player1Data.display_name,
        initiator: false
    }));
    console.log(`Matching: Match found! ${player1Data.username} vs ${player2Data.username}. Match ID: ${matchId}`);
}


// --- WebSocketイベントハンドリング ---
wss.on('connection', ws => {
    const wsId = uuidv4();
    activeConnections.set(ws, { ws_id: wsId, user_id: null });
    wsIdToWs.set(wsId, ws);
    console.log(`WS: Client connected: ${wsId}. Total: ${activeConnections.size}`);

    ws.on('message', async message => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error("WS: Invalid JSON received", message);
            return;
        }

        const senderInfo = activeConnections.get(ws);
        if (!senderInfo) return;
        const senderId = senderInfo.user_id;

        console.log(`WS: Msg from ${senderInfo.ws_id} (User: ${senderId || 'N/A'}) (Type: ${data.type})`);

        const handleLogin = async (userId, username, requestType) => {
            // ... (実装は変更なし)
        };

        switch (data.type) {
            case 'register': { /* ... */ break; }
            case 'login': { /* ... */ break; }
            case 'auto_login': { /* ... */ break; }
            case 'logout': { /* ... */ break; }
            case 'update_user_data': { /* ... */ break; }

            // [★追加] マッチングキュー参加
            case 'join_queue': {
                if (senderId && !waitingPlayers.some(p => p.userId === senderId)) {
                    waitingPlayers.push({ userId: senderId, wsId: senderInfo.ws_id });
                    console.log(`Queue: User ${senderId} joined. Queue size: ${waitingPlayers.length}`);
                    ws.send(JSON.stringify({ type: 'queue_status', message: '対戦相手を検索中です...' }));
                    tryMatchPlayers();
                }
                break;
            }

            // [★追加] マッチングキュー離脱
            case 'leave_queue': {
                if (senderId) {
                    waitingPlayers = waitingPlayers.filter(p => p.userId !== senderId);
                    console.log(`Queue: User ${senderId} left. Queue size: ${waitingPlayers.length}`);
                }
                break;
            }

            // [★追加] WebRTCシグナリング中継
            case 'webrtc_signal': {
                if (senderId && data.to) {
                    const targetWsId = userToWsId.get(data.to);
                    const targetWs = wsIdToWs.get(targetWsId);
                    if (targetWs) {
                        targetWs.send(JSON.stringify({
                            type: 'webrtc_signal',
                            from: senderId,
                            data: data.data
                        }));
                    }
                }
                break;
            }

            // [★追加] 対戦結果報告
            case 'report_result': {
                const { matchId, result } = data;
                if (!senderId || !matchId) break;

                const matchRes = await pool.query('SELECT * FROM matches WHERE match_id = $1', [matchId]);
                if (matchRes.rows.length === 0) break;
                const match = matchRes.rows[0];

                const isPlayer1 = match.player1_id === senderId;
                const reportField = isPlayer1 ? 'player1_report' : 'player2_report';
                await pool.query(`UPDATE matches SET ${reportField} = $1 WHERE match_id = $2`, [result, matchId]);
                
                // 両方のレポートが揃ったら結果を処理
                const updatedMatchRes = await pool.query('SELECT * FROM matches WHERE match_id = $1', [matchId]);
                const updatedMatch = updatedMatchRes.rows[0];

                if (updatedMatch.player1_report && updatedMatch.player2_report) {
                    const player1 = await getUserData(updatedMatch.player1_id);
                    const player2 = await getUserData(updatedMatch.player2_id);

                    let p1Result = updatedMatch.player1_report;
                    // 結果が食い違った場合は中止扱い
                    if ((p1Result === 'win' && updatedMatch.player2_report !== 'lose') || (p1Result === 'lose' && updatedMatch.player2_report !== 'win')) {
                        p1Result = 'cancel';
                    }

                    const newRate1 = calculateElo(player1.rate, player2.rate, p1Result);
                    const newRate2 = calculateElo(player2.rate, player1.rate, p1Result === 'win' ? 'lose' : p1Result === 'lose' ? 'win' : 'cancel');
                    
                    await pool.query('UPDATE users SET rate = $1 WHERE user_id = $2', [newRate1, player1.user_id]);
                    await pool.query('UPDATE users SET rate = $1 WHERE user_id = $2', [newRate2, player2.user_id]);
                    
                    await pool.query('UPDATE matches SET resolved_at = NOW() WHERE match_id = $1', [matchId]);
                }

                // 報告者に更新後のデータを送信
                const updatedUserData = await getUserData(senderId);
                ws.send(JSON.stringify({
                    type: 'report_result_response',
                    success: true,
                    message: '対戦結果を報告しました。',
                    updatedUserData: {
                        userId: updatedUserData.user_id,
                        username: updatedUserData.username,
                        displayName: updatedUserData.display_name,
                        rate: updatedUserData.rate,
                        matchHistory: updatedUserData.match_history,
                    }
                }));
                
                userMatches.delete(senderId);
                break;
            }
             // [★追加] ランキング取得
            case 'get_ranking': {
                const rankingRes = await pool.query('SELECT display_name, rate FROM users ORDER BY rate DESC LIMIT 10');
                ws.send(JSON.stringify({ type: 'ranking_response', ranking: rankingRes.rows }));
                break;
            }
        }
    });

    ws.on('close', () => {
        const senderInfo = activeConnections.get(ws);
        if (senderInfo) {
            console.log(`WS: Client disconnected: ${senderInfo.ws_id}.`);
            // 待ち行列から削除
            waitingPlayers = waitingPlayers.filter(p => p.wsId !== senderInfo.ws_id);
            if (senderInfo.user_id && userToWsId.get(senderInfo.user_id) === senderInfo.ws_id) {
                userToWsId.delete(senderInfo.user_id);
                console.log(`Auth: User ${senderInfo.user_id} map entry removed.`);
            }
            activeConnections.delete(ws);
            wsIdToWs.delete(senderInfo.ws_id);
        }
    });

    ws.on('error', (error) => {
        console.error(`WS: Error on connection ${activeConnections.get(ws)?.ws_id}:`, error);
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
