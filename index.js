const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const { Pool } = require('pg'); // PostgreSQLクライアント

// Railwayの環境変数からデータベース接続情報を取得
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is not set. Please ensure PostgreSQL is linked in Railway.');
    // アプリケーションを終了させるか、データベースなしで起動するか選択
    // process.exit(1); // データベースなしでは起動しない場合
}

const pool = new Pool({
    connectionString: databaseUrl,
    ssl: {
        rejectUnauthorized: false // 本番環境ではtrueに設定することを推奨
    }
});

// データベース接続テスト
pool.connect((err, client, release) => {
    if (err) {
        console.error('Error acquiring client (database connection failed):', err.stack);
        return; // 接続失敗してもサーバーは起動し続ける（ただしDB機能は使えない）
    }
    client.query('SELECT NOW()', (err, result) => {
        release();
        if (err) {
            console.error('Error executing query (database connection test failed):', err.stack);
            return;
        }
        console.log('Database connected successfully:', result.rows[0].now);
    });
});

// ユーザーテーブルが存在しない場合は作成
async function initializeDatabase() {
    if (!databaseUrl) {
        console.warn('Skipping database initialization: DATABASE_URL is not set.');
        return;
    }
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                user_id UUID PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                rate INTEGER DEFAULT 1500,
                match_history JSONB DEFAULT '[]'::jsonb
            );
        `);
        console.log('Users table ensured.');
    } catch (err) {
        console.error('Error initializing database:', err.stack);
    }
}
initializeDatabase(); // サーバー起動時にデータベースを初期化

// HTTPサーバーを作成
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('WebSocket server is running.');
    } else {
        res.writeHead(404);
        res.end();
    }
});

// WebSocketサーバーをHTTPサーバーにアタッチ
const wss = new WebSocket.Server({ server });

console.log('WebSocket server starting...');

let waitingPlayers = []; // マッチング待ちのプレイヤー (user_idを格納)
const activeConnections = new Map(); // 接続中のクライアント (wsインスタンス -> { ws_id, user_id, opponent_ws_id })
const wsIdToWs = new Map(); // ws_id -> wsインスタンス
const userToWsId = new Map(); // user_id -> ws_id (ユーザーがログイン中の場合)

const BCRYPT_SALT_ROUNDS = 10; // bcryptのソルトラウンド数

// ユーザーデータをDBから取得するヘルパー関数
async function getUserData(userId) {
    if (!databaseUrl) return null;
    const res = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
    return res.rows[0];
}

// ユーザーデータをDBに保存するヘルパー関数
async function updateUserData(userId, data) {
    if (!databaseUrl) return;
    const { username, passwordHash, rate, matchHistory } = data;
    await pool.query(
        `UPDATE users SET username = $1, password_hash = $2, rate = $3, match_history = $4 WHERE user_id = $5`,
        [username, passwordHash, rate, JSON.stringify(matchHistory), userId]
    );
}

// 新規ユーザーをDBに登録するヘルパー関数
async function registerNewUser(userId, username, passwordHash) {
    if (!databaseUrl) throw new Error('Database not configured.');
    await pool.query(
        `INSERT INTO users (user_id, username, password_hash, rate, match_history) VALUES ($1, $2, $3, $4, $5)`,
        [userId, username, passwordHash, 1500, '[]']
    );
}

// ユーザー名からユーザーIDを取得するヘルパー関数
async function getUserIdByUsername(username) {
    if (!databaseUrl) return null;
    const res = await pool.query('SELECT user_id FROM users WHERE username = $1', [username]);
    return res.rows[0] ? res.rows[0].user_id : null;
}

// マッチングロジック
function tryMatchPlayers() {
    if (waitingPlayers.length >= 2) {
        const player1UserId = waitingPlayers.shift();
        const player2UserId = waitingPlayers.shift();

        const ws1Id = userToWsId.get(player1UserId);
        const ws2Id = userToWsId.get(player2UserId);

        const ws1 = wsIdToWs.get(ws1Id);
        const ws2 = wsIdToWs.get(ws2Id);

        if (ws1 && ws2 && ws1.readyState === WebSocket.OPEN && ws2.readyState === WebSocket.OPEN) {
            const roomId = uuidv4(); // 新しいルームIDを生成

            // 接続情報に相手のws_idを紐付け
            activeConnections.get(ws1).opponent_ws_id = ws2Id;
            activeConnections.get(ws2).opponent_ws_id = ws1Id;

            // プレイヤー1にマッチング成立を通知
            ws1.send(JSON.stringify({
                type: 'match_found',
                roomId: roomId,
                opponentUserId: player2UserId,
                isInitiator: true // プレイヤー1がWebRTCのOfferを作成する側
            }));
            console.log(`Matched ${player1UserId} with ${player2UserId} in room ${roomId}. ${player1UserId} is initiator.`);

            // プレイヤー2にマッチング成立を通知
            ws2.send(JSON.stringify({
                type: 'match_found',
                roomId: roomId,
                opponentUserId: player1UserId,
                isInitiator: false // プレイヤー2はWebRTCのAnswerを作成する側
            }));
            console.log(`Matched ${player2UserId} with ${player1UserId} in room ${roomId}. ${player2UserId} is not initiator.`);

        } else {
            // プレイヤーの接続が切れている場合はキューに戻すか破棄
            if (ws1 && ws1.readyState === WebSocket.OPEN) waitingPlayers.unshift(player1UserId);
            if (ws2 && ws2.readyState === WebSocket.OPEN) waitingPlayers.unshift(player2UserId);
            console.log('One or both players disconnected before match could be established. Re-queueing or discarding.');
        }
    }
}

wss.on('connection', ws => {
    const wsId = uuidv4(); // WebSocket接続ごとにユニークなIDを生成
    activeConnections.set(ws, { ws_id: wsId, user_id: null, opponent_ws_id: null });
    wsIdToWs.set(wsId, ws);

    console.log(`Client connected: ${wsId}. Total active WS: ${activeConnections.size}`);

    ws.on('message', async message => {
        const data = JSON.parse(message);
        const senderInfo = activeConnections.get(ws);
        if (!senderInfo) {
            console.warn('Message from unknown client (no senderInfo).');
            return;
        }

        console.log(`Message from WS_ID ${senderInfo.ws_id} (Type: ${data.type})`);

        switch (data.type) {
            case 'register':
                const { username: regUsername, password: regPassword } = data;
                if (!regUsername || !regPassword) {
                    ws.send(JSON.stringify({ type: 'register_response', success: false, message: 'ユーザー名とパスワードを入力してください。' }));
                    return;
                }
                const existingUserId = await getUserIdByUsername(regUsername);
                if (existingUserId) {
                    ws.send(JSON.stringify({ type: 'register_response', success: false, message: 'このユーザー名は既に使われています。' }));
                    return;
                }
                const hashedPassword = await bcrypt.hash(regPassword, BCRYPT_SALT_ROUNDS);
                const newUserId = uuidv4();
                try {
                    await registerNewUser(newUserId, regUsername, hashedPassword);
                    ws.send(JSON.stringify({ type: 'register_response', success: true, message: 'アカウント登録が完了しました！ログインしてください。' }));
                    console.log(`User registered: ${regUsername} (${newUserId})`);
                } catch (dbErr) {
                    console.error('Database register error:', dbErr);
                    ws.send(JSON.stringify({ type: 'register_response', success: false, message: 'データベースエラーにより登録できませんでした。' }));
                }
                break;

            case 'login':
                const { username: loginUsername, password: loginPassword } = data;
                if (!loginUsername || !loginPassword) {
                    ws.send(JSON.stringify({ type: 'login_response', success: false, message: 'ユーザー名とパスワードを入力してください。' }));
                    return;
                }
                const userIdFromUsername = await getUserIdByUsername(loginUsername);
                if (!userIdFromUsername) {
                    ws.send(JSON.stringify({ type: 'login_response', success: false, message: 'ユーザー名またはパスワードが間違っています。' }));
                    return;
                }
                const storedUserData = await getUserData(userIdFromUsername);
                if (!storedUserData || !(await bcrypt.compare(loginPassword, storedUserData.password_hash))) {
                    ws.send(JSON.stringify({ type: 'login_response', success: false, message: 'ユーザー名またはパスワードが間違っています。' }));
                    return;
                }

                // 既にこのユーザーIDでログイン中の接続があれば、古い接続を切断または無効化する
                const existingWsIdForUser = userToWsId.get(storedUserData.user_id);
                if (existingWsIdForUser && wsIdToWs.has(existingWsIdForUser) && wsIdToWs.get(existingWsIdForUser).readyState === WebSocket.OPEN) {
                    console.log(`User ${loginUsername} (${storedUserData.user_id}) is already logged in on another connection (${existingWsIdForUser}). Closing old connection.`);
                    wsIdToWs.get(existingWsIdForUser).send(JSON.stringify({ type: 'logout_forced', message: '別端末/タブでログインしたため、この接続は切断されました。' }));
                    wsIdToWs.get(existingWsIdForUser).close();
                }

                senderInfo.user_id = storedUserData.user_id; // WS接続にユーザーIDを紐付け
                userToWsId.set(storedUserData.user_id, senderInfo.ws_id); // ユーザーIDからWS_IDを引けるように
                ws.send(JSON.stringify({
                    type: 'login_response',
                    success: true,
                    message: 'ログインしました！',
                    userId: storedUserData.user_id,
                    username: storedUserData.username,
                    rate: storedUserData.rate,
                    matchHistory: storedUserData.match_history // DBから取得した履歴
                }));
                console.log(`User logged in: ${loginUsername} (${storedUserData.user_id})`);
                break;
            
            case 'auto_login': // 自動ログインリクエスト
                const { userId: autoLoginUserId, username: autoLoginUsername } = data;
                if (!autoLoginUserId || !autoLoginUsername) {
                    ws.send(JSON.stringify({ type: 'auto_login_response', success: false, message: '自動ログイン情報が不足しています。' }));
                    return;
                }
                const autoLoginUserData = await getUserData(autoLoginUserId);
                if (autoLoginUserData && autoLoginUserData.username === autoLoginUsername) {
                    // ユーザーIDとユーザー名が一致すれば認証成功とみなす (パスワードなしの簡易自動ログイン)
                    // 既にこのユーザーIDでログイン中の接続があれば、古い接続を切断または無効化する
                    const existingAutoLoginWsId = userToWsId.get(autoLoginUserData.user_id);
                    if (existingAutoLoginWsId && wsIdToWs.has(existingAutoLoginWsId) && wsIdToWs.get(existingAutoLoginWsId).readyState === WebSocket.OPEN) {
                        console.log(`User ${autoLoginUsername} (${autoLoginUserData.user_id}) is already logged in on another connection (${existingAutoLoginWsId}). Closing old connection for auto-login.`);
                        wsIdToWs.get(existingAutoLoginWsId).send(JSON.stringify({ type: 'logout_forced', message: '別端末/タブでログインしたため、この接続は切断されました。' }));
                        wsIdToWs.get(existingAutoLoginWsId).close();
                    }

                    senderInfo.user_id = autoLoginUserData.user_id;
                    userToWsId.set(autoLoginUserData.user_id, senderInfo.ws_id);
                    ws.send(JSON.stringify({
                        type: 'auto_login_response',
                        success: true,
                        message: '自動ログインしました！',
                        userId: autoLoginUserData.user_id,
                        username: autoLoginUserData.username,
                        rate: autoLoginUserData.rate,
                        matchHistory: autoLoginUserData.match_history
                    }));
                    console.log(`User auto-logged in: ${autoLoginUsername} (${autoLoginUserData.user_id})`);
                } else {
                    ws.send(JSON.stringify({ type: 'auto_login_response', success: false, message: '自動ログインに失敗しました。' }));
                }
                break;

            case 'logout':
                if (senderInfo.user_id) {
                    userToWsId.delete(senderInfo.user_id);
                    senderInfo.user_id = null;
                    ws.send(JSON.stringify({ type: 'logout_response', success: true, message: 'ログアウトしました。' }));
                    console.log(`User logged out: ${senderInfo.user_id}`);
                } else {
                    ws.send(JSON.stringify({ type: 'logout_response', success: false, message: 'ログインしていません。' }));
                }
                break;

            case 'join_queue':
                if (!senderInfo.user_id) {
                    ws.send(JSON.stringify({ type: 'error', message: 'ログインしてください。' }));
                    return;
                }
                if (!waitingPlayers.includes(senderInfo.user_id)) {
                    waitingPlayers.push(senderInfo.user_id);
                    console.log(`User ${senderInfo.user_id} joined queue. Current queue: ${waitingPlayers.length}`);
                    ws.send(JSON.stringify({ type: 'queue_status', message: '対戦相手を検索中です...' }));
                    tryMatchPlayers();
                }
                break;

            case 'leave_queue':
                if (!senderInfo.user_id) {
                    ws.send(JSON.stringify({ type: 'error', message: 'ログインしてください。' }));
                    return;
                }
                waitingPlayers = waitingPlayers.filter(id => id !== senderInfo.user_id);
                console.log(`User ${senderInfo.user_id} left queue. Current queue: ${waitingPlayers.length}`);
                ws.send(JSON.stringify({ type: 'queue_status', message: 'マッチングをキャンセルしました。' }));
                break;

            case 'webrtc_signal':
                if (!senderInfo.user_id || !senderInfo.opponent_ws_id) {
                    console.warn(`WebRTC signal from ${senderInfo.ws_id} but no user_id or opponent_ws_id.`);
                    return;
                }
                const opponentWs = wsIdToWs.get(senderInfo.opponent_ws_id);
                if (opponentWs && opponentWs.readyState === WebSocket.OPEN) {
                    opponentWs.send(JSON.stringify({
                        type: 'webrtc_signal',
                        senderUserId: senderInfo.user_id, // 相手に送信元のユーザーIDを伝える
                        signal: data.signal // SDP (offer/answer) や ICE candidate
                    }));
                    console.log(`Relaying WebRTC signal from WS_ID ${senderInfo.ws_id} (User: ${senderInfo.user_id}) to WS_ID ${senderInfo.opponent_ws_id}`);
                } else {
                    console.warn(`Opponent WS_ID ${senderInfo.opponent_ws_id} not found or not open for signaling from WS_ID ${senderInfo.ws_id}.`);
                }
                break;

            case 'update_user_data':
                if (!senderInfo.user_id) {
                    ws.send(JSON.stringify({ type: 'error', message: 'ログインしてください。' }));
                    return;
                }
                const userToUpdate = await getUserData(senderInfo.user_id);
                if (userToUpdate) {
                    // 更新可能なフィールドのみを上書き
                    if (data.rate !== undefined) userToUpdate.rate = data.rate;
                    if (data.matchHistory !== undefined) userToUpdate.match_history = data.matchHistory; // DBの列名に合わせる
                    await updateUserData(senderInfo.user_id, userToUpdate);
                    ws.send(JSON.stringify({ type: 'update_user_data_response', success: true, message: 'ユーザーデータを更新しました。', userData: {
                        userId: userToUpdate.user_id,
                        username: userToUpdate.username,
                        rate: userToUpdate.rate,
                        matchHistory: userToUpdate.match_history // DBの列名に合わせる
                    } }));
                    console.log(`User data updated for ${senderInfo.user_id}: Rate=${userToUpdate.rate}`);
                } else {
                    ws.send(JSON.stringify({ type: 'update_user_data_response', success: false, message: 'ユーザーデータが見つかりません。' }));
                }
                break;

            case 'clear_match_info':
                // 対戦終了時に相手のWS_IDをクリア
                senderInfo.opponent_ws_id = null;
                console.log(`WS_ID ${senderInfo.ws_id} cleared match info.`);
                break;

            default:
                console.warn(`Unknown message type: ${data.type}`);
        }
    });

    ws.on('close', () => {
        const senderInfo = activeConnections.get(ws);
        if (senderInfo) {
            console.log(`Client disconnected: WS_ID ${senderInfo.ws_id}.`);
            if (senderInfo.user_id) {
                // ユーザーがログアウトせずに切断した場合、userToWsIdから削除
                if (userToWsId.get(senderInfo.user_id) === senderInfo.ws_id) {
                    userToWsId.delete(senderInfo.user_id);
                    console.log(`User ${senderInfo.user_id} removed from active user map.`);
                }
                // キューにいた場合はキューから削除
                waitingPlayers = waitingPlayers.filter(id => id !== senderInfo.user_id);
            }
            activeConnections.delete(ws);
            wsIdToWs.delete(senderInfo.ws_id);
        } else {
            console.log('Unknown client disconnected.');
        }
    });

    ws.on('error', error => {
        const senderInfo = activeConnections.get(ws);
        console.error(`WebSocket error for WS_ID ${senderInfo ? senderInfo.ws_id : 'unknown'}:`, error);
    });
});

// Railwayの環境変数からポートを取得
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
