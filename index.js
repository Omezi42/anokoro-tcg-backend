// index.js (Renderサーバーのバックエンドコード) - 安定化版 v3.0

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
let waitingPlayers = [];
const activeConnections = new Map();
const wsIdToWs = new Map();
const userToWsId = new Map();

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
        if (data.memos !== undefined) { setClauses.push(`memos = $${valueIndex++}`); values.push(JSON.stringify(data.memos)); }
        if (data.battleRecords !== undefined) { setClauses.push(`battle_records = $${valueIndex++}`); values.push(JSON.stringify(data.battleRecords)); }
        if (data.registeredDecks !== undefined) { setClauses.push(`registered_decks = $${valueIndex++}`); values.push(JSON.stringify(data.registeredDecks)); }
        if (data.currentMatchId !== undefined) { setClauses.push(`current_match_id = $${valueIndex++}`); values.push(data.currentMatchId); }
        
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

// 他のヘルパー関数（registerNewUser, getDisplayNameByUserId, tryMatchPlayers）は変更なし

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

        console.log(`WS: Msg from ${senderInfo.ws_id} (User: ${senderInfo.user_id || 'N/A'}) (Type: ${data.type})`);

        const handleLogin = async (userId, username, requestType) => {
            const existingWsId = userToWsId.get(userId);
            if (existingWsId && existingWsId !== wsId) {
                console.log(`Auth: User ${username} re-logging in. Closing old connection ${existingWsId}.`);
                const oldWs = wsIdToWs.get(existingWsId);
                if (oldWs) {
                    oldWs.send(JSON.stringify({ type: 'logout_forced', message: '別の場所からログインされました。' }));
                    oldWs.close();
                }
            }

            const userData = await getUserData(userId);
            if (!userData) {
                 ws.send(JSON.stringify({ type: `${requestType}_response`, success: false, message: 'ユーザーが見つかりません。' }));
                 return;
            }

            senderInfo.user_id = userId;
            userToWsId.set(userId, wsId);
            
            // DBのキー名をフロントエンドのキャメルケースに変換
            const responsePayload = {
                type: `${requestType}_response`,
                success: true,
                userId: userData.user_id,
                username: userData.username,
                displayName: userData.display_name,
                rate: userData.rate,
                matchHistory: userData.match_history,
                memos: userData.memos,
                battleRecords: userData.battle_records,
                registeredDecks: userData.registered_decks,
                currentMatchId: userData.current_match_id
            };

            ws.send(JSON.stringify(responsePayload));
            console.log(`Auth: User ${username} (${userId}) logged in with connection ${wsId}.`);
        };

        switch (data.type) {
            case 'register': {
                const { username, password } = data;
                if (!username || !password) {
                    return ws.send(JSON.stringify({ type: 'register_response', success: false, message: 'ユーザー名とパスワードは必須です。' }));
                }
                const existingUserId = await getUserIdByUsername(username);
                if (existingUserId) {
                    return ws.send(JSON.stringify({ type: 'register_response', success: false, message: 'このユーザー名は既に使用されています。' }));
                }
                const hashedPassword = await bcrypt.hash(password, 10);
                const newUserId = uuidv4();
                await pool.query(
                    'INSERT INTO users (user_id, username, password_hash, display_name) VALUES ($1, $2, $3, $4)',
                    [newUserId, username, hashedPassword, username]
                );
                ws.send(JSON.stringify({ type: 'register_response', success: true, message: '登録が完了しました。ログインしてください。' }));
                break;
            }
            case 'login': {
                const { username, password } = data;
                const userId = await getUserIdByUsername(username);
                const user = userId ? await getUserData(userId) : null;
                if (user && await bcrypt.compare(password, user.password_hash)) {
                    await handleLogin(user.user_id, user.username, 'login');
                } else {
                    ws.send(JSON.stringify({ type: 'login_response', success: false, message: 'ユーザー名またはパスワードが間違っています。' }));
                }
                break;
            }
            case 'auto_login': {
                const { userId, username } = data;
                const user = userId ? await getUserData(userId) : null;
                if (user && user.username === username) {
                    await handleLogin(userId, username, 'auto_login');
                } else {
                    ws.send(JSON.stringify({ type: 'auto_login_response', success: false }));
                }
                break;
            }
            case 'logout': {
                if (senderInfo.user_id) {
                    userToWsId.delete(senderInfo.user_id);
                    senderInfo.user_id = null;
                }
                ws.send(JSON.stringify({ type: 'logout_response', success: true }));
                break;
            }
            case 'update_user_data': {
                if (senderInfo.user_id && data) {
                    try {
                        await updateUserData(senderInfo.user_id, data);
                    } catch (err) {
                        console.error(`DB: Failed to update data for user ${senderInfo.user_id}`, err);
                    }
                }
                break;
            }
            // ... その他のcase (join_queue, webrtc_signalなど)
        }
    });

    ws.on('close', () => {
        const senderInfo = activeConnections.get(ws);
        if (senderInfo) {
            console.log(`WS: Client disconnected: ${senderInfo.ws_id}.`);
            if (senderInfo.user_id && userToWsId.get(senderInfo.user_id) === senderInfo.ws_id) {
                userToWsId.delete(senderInfo.user_id);
                console.log(`Auth: User ${senderInfo.user_id} map entry removed.`);
                waitingPlayers = waitingPlayers.filter(id => id !== senderInfo.user_id);
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

