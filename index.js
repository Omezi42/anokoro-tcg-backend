// index.js (Renderサーバーのバックエンドコード) - 安定化版 v2.2

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
async function getUserData(userId) { /* ... 実装は変更なし ... */ return null; }
async function updateUserData(userId, data) { /* ... 実装は変更なし ... */ }
async function registerNewUser(userId, username, passwordHash) { /* ... 実装は変更なし ... */ }
async function getUserIdByUsername(username) { /* ... 実装は変更なし ... */ return null; }
async function getDisplayNameByUserId(userId) { /* ... 実装は変更なし ... */ return null; }
async function tryMatchPlayers() { /* ... 実装は変更なし ... */ }

// --- WebSocketイベントハンドリング ---
wss.on('connection', ws => {
    const wsId = uuidv4();
    activeConnections.set(ws, { ws_id: wsId, user_id: null });
    wsIdToWs.set(wsId, ws);
    console.log(`WS: Client connected: ${wsId}. Total: ${activeConnections.size}`);

    ws.on('message', async message => {
        const data = JSON.parse(message);
        const senderInfo = activeConnections.get(ws);
        if (!senderInfo) return;

        console.log(`WS: Msg from ${senderInfo.ws_id} (User: ${senderInfo.user_id || 'N/A'}) (Type: ${data.type})`);

        const handleLogin = async (userId, username) => {
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
            senderInfo.user_id = userId;
            userToWsId.set(userId, wsId);

            ws.send(JSON.stringify({
                type: data.type === 'auto_login' ? 'auto_login_response' : 'login_response',
                success: true,
                ...userData,
                matchHistory: userData.match_history,
                battleRecords: userData.battle_records,
                registeredDecks: userData.registered_decks,
                currentMatchId: userData.current_match_id
            }));
            console.log(`Auth: User ${username} (${userId}) logged in with connection ${wsId}.`);
        };

        switch (data.type) {
            case 'register': {
                // ... (実装は変更なし)
                break;
            }
            case 'login': {
                const { username, password } = data;
                const userId = await getUserIdByUsername(username);
                const user = userId ? await getUserData(userId) : null;
                if (user && await bcrypt.compare(password, user.password_hash)) {
                    await handleLogin(user.user_id, user.username);
                } else {
                    ws.send(JSON.stringify({ type: 'login_response', success: false, message: 'ユーザー名またはパスワードが間違っています。' }));
                }
                break;
            }
            case 'auto_login': {
                const { userId, username } = data;
                const user = userId ? await getUserData(userId) : null;
                if (user && user.username === username) {
                    await handleLogin(userId, username);
                } else {
                    ws.send(JSON.stringify({ type: 'auto_login_response', success: false }));
                }
                break;
            }
            case 'logout': {
                if (senderInfo.user_id) {
                    userToWsId.delete(senderInfo.user_id);
                    senderInfo.user_id = null;
                    ws.send(JSON.stringify({ type: 'logout_response', success: true }));
                }
                break;
            }
            // ★★★ 追加: ユーザーデータ更新処理 ★★★
            case 'update_user_data': {
                if (senderInfo.user_id && data) {
                    try {
                        await updateUserData(senderInfo.user_id, data);
                        // Optional: 確認メッセージを返す
                        // ws.send(JSON.stringify({ type: 'update_user_data_response', success: true }));
                    } catch (err) {
                        console.error(`DB: Failed to update data for user ${senderInfo.user_id}`, err);
                        // ws.send(JSON.stringify({ type: 'update_user_data_response', success: false, message: 'データ更新に失敗しました。' }));
                    }
                }
                break;
            }
            // ... その他のcase (join_queue, webrtc_signalなど) は変更なし
        }
    });

    ws.on('close', () => {
        const senderInfo = activeConnections.get(ws);
        if (senderInfo) {
            console.log(`WS: Client disconnected: ${senderInfo.ws_id}.`);
            // ★★★ 修正: ログアウト処理の安定化 ★★★
            // この接続がユーザーに紐づく最後の接続である場合のみ、userToWsIdから削除
            if (senderInfo.user_id && userToWsId.get(senderInfo.user_id) === senderInfo.ws_id) {
                userToWsId.delete(senderInfo.user_id);
                console.log(`Auth: User ${senderInfo.user_id} map entry removed.`);
                // マッチングキューからも削除
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
