const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const { Pool } = require('pg'); // PostgreSQLクライアント

// Renderの環境変数からデータベース接続情報を取得
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is not set. Please ensure PostgreSQL is linked in Render.');
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
            return console.error('Error executing query (database connection test failed):', err.stack);
        }
        console.log('Database connected successfully:', result.rows[0].now);
    });
});

// ユーザーテーブルが存在しない場合は作成し、新しいカラムを追加
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
                match_history JSONB DEFAULT '[]'::jsonb,
                memos JSONB DEFAULT '[]'::jsonb,             -- 新しいカラム
                battle_records JSONB DEFAULT '[]'::jsonb,    -- 新しいカラム
                registered_decks JSONB DEFAULT '[]'::jsonb   -- 新しいカラム
            );
        `);
        console.log('Users table ensured.');

        // 既存のテーブルに新しいカラムを追加する（冪等性のためIF NOT EXISTSを使用）
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS memos JSONB DEFAULT '[]'::jsonb;`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS battle_records JSONB DEFAULT '[]'::jsonb;`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS registered_decks JSONB DEFAULT '[]'::jsonb;`);
        console.log('New columns (memos, battle_records, registered_decks) ensured.');

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
const activeConnections = new Map(); // 接続中のクライアント (wsインスタンス -> { ws_id, user_id, opponent_ws_id, current_room_id })
const wsIdToWs = new Map(); // ws_id -> wsインスタンス
const userToWsId = new Map(); // user_id -> ws_id (ユーザーがログイン中の場合)

// 対戦結果報告の整合性を取るためのマップ
// key: roomId, value: { player1Id, player2Id, player1Report: 'win'|'lose'|null, player2Report: 'win'|'lose'|null, reportedAt: timestamp }
const reportedMatchResults = new Map();

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
    // クライアントから送信される可能性のあるフィールドのみを更新対象とする
    // username, password_hash はこの関数では更新しない
    const { rate, matchHistory, memos, battleRecords, registeredDecks } = data;
    
    // 現在のユーザーデータを取得して、更新対象外のフィールドを保持
    const currentUserData = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
    if (!currentUserData.rows[0]) {
        throw new Error(`User with ID ${userId} not found for update.`);
    }
    const existingUserData = currentUserData.rows[0];

    await pool.query(
        `UPDATE users SET rate = $1, match_history = $2, memos = $3, battle_records = $4, registered_decks = $5 WHERE user_id = $6`,
        [
            rate !== undefined ? rate : existingUserData.rate,
            matchHistory !== undefined ? JSON.stringify(matchHistory) : existingUserData.match_history,
            memos !== undefined ? JSON.stringify(memos) : existingUserData.memos,
            battleRecords !== undefined ? JSON.stringify(battleRecords) : existingUserData.battle_records,
            registeredDecks !== undefined ? JSON.stringify(registeredDecks) : existingUserData.registered_decks,
            userId
        ]
    );
}

// 新規ユーザーをDBに登録するヘルパー関数
async function registerNewUser(userId, username, passwordHash) {
    if (!databaseUrl) throw new Error('Database not configured.');
    await pool.query(
        `INSERT INTO users (user_id, username, password_hash, rate, match_history, memos, battle_records, registered_decks) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userId, username, passwordHash, 1500, '[]', '[]', '[]', '[]']
    );
}

// ユーザー名からユーザーIDを取得するヘルパー関数
async function getUserIdByUsername(username) {
    if (!databaseUrl) return null;
    const res = await pool.query('SELECT user_id FROM users WHERE username = $1', [username]);
    return res.rows[0] ? res.rows[0].user_id : null;
}

// ユーザーIDからユーザー名を取得するヘルパー関数
async function getUsernameByUserId(userId) {
    if (!databaseUrl) return null;
    const res = await pool.query('SELECT username FROM users WHERE user_id = $1', [userId]);
    return res.rows[0] ? res.rows[0].username : null;
}


// マッチングロジック
async function tryMatchPlayers() {
    if (waitingPlayers.length >= 2) {
        const player1UserId = waitingPlayers.shift();
        const player2UserId = waitingPlayers.shift();

        const ws1Id = userToWsId.get(player1UserId);
        const ws2Id = userToWsId.get(player2UserId);

        const ws1 = wsIdToWs.get(ws1Id);
        const ws2 = wsIdToWs.get(ws2Id);

        if (ws1 && ws2 && ws1.readyState === WebSocket.OPEN && ws2.readyState === WebSocket.OPEN) {
            const roomId = uuidv4(); // 新しいルームIDを生成

            // 相手のユーザー名を取得
            const player1Username = await getUsernameByUserId(player1UserId);
            const player2Username = await getUsernameByUserId(player2UserId);

            // 接続情報に相手のws_idとroom_idを紐付け
            activeConnections.get(ws1).opponent_ws_id = ws2Id;
            activeConnections.get(ws2).opponent_ws_id = ws1Id;
            activeConnections.get(ws1).current_room_id = roomId;
            activeConnections.get(ws2).current_room_id = roomId;


            // プレイヤー1にマッチング成立を通知
            ws1.send(JSON.stringify({
                type: 'match_found',
                roomId: roomId,
                opponentUserId: player2UserId,
                opponentUsername: player2Username, // 相手のユーザー名を追加
                isInitiator: true // プレイヤー1がWebRTCのOfferを作成する側
            }));
            console.log(`Matched ${player1UserId} (${player1Username}) with ${player2UserId} (${player2Username}) in room ${roomId}. ${player1UserId} is initiator.`);

            // プレイヤー2にマッチング成立を通知
            ws2.send(JSON.stringify({
                type: 'match_found',
                roomId: roomId,
                opponentUserId: player1UserId,
                opponentUsername: player1Username, // 相手のユーザー名を追加
                isInitiator: false // プレイヤー2はWebRTCのAnswerを作成する側
            }));
            console.log(`Matched ${player2UserId} (${player2Username}) with ${player1UserId} (${player1Username}) in room ${roomId}. ${player2UserId} is not initiator.`);

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
    activeConnections.set(ws, { ws_id: wsId, user_id: null, opponent_ws_id: null, current_room_id: null }); // current_room_idを追加
    wsIdToWs.set(wsId, ws);

    console.log(`Client connected: ${wsId}. Total active WS: ${activeConnections.size}`);

    ws.on('message', async message => {
        const data = JSON.parse(message);
        const senderInfo = activeConnections.get(ws);
        if (!senderInfo) {
            console.warn('Message from unknown client (no senderInfo).');
            return;
        }

        console.log(`Message from WS_ID ${senderInfo.ws_id} (User: ${senderInfo.user_id || 'N/A'}) (Type: ${data.type})`);

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
                    // PostgreSQLのエラーコードをチェックして詳細なメッセージを返す
                    if (dbErr.code === '23505') { // unique_violation
                        ws.send(JSON.stringify({ type: 'register_response', success: false, message: 'このユーザー名は既に使われています。' }));
                    } else {
                        ws.send(JSON.stringify({ type: 'register_response', success: false, message: 'データベースエラーにより登録できませんでした。' }));
                    }
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
                    matchHistory: storedUserData.match_history, // DBから取得した履歴
                    memos: storedUserData.memos,                 // DBから取得したメモ
                    battleRecords: storedUserData.battle_records, // DBから取得した対戦記録
                    registeredDecks: storedUserData.registered_decks // DBから取得した登録デッキ
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
                        matchHistory: autoLoginUserData.match_history,
                        memos: autoLoginUserData.memos,
                        battleRecords: autoLoginUserData.battle_records,
                        registeredDecks: autoLoginUserData.registered_decks
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

            case 'report_battle_result': // 新しいメッセージタイプ
                if (!senderInfo.user_id || !senderInfo.current_room_id || !data.result || !data.opponentUserId) {
                    ws.send(JSON.stringify({ type: 'error', message: '結果報告情報が不足しています。' }));
                    return;
                }
                const { roomId, result, opponentUserId } = data;
                const reporterUserId = senderInfo.user_id;

                let matchResult = reportedMatchResults.get(roomId) || {
                    player1Id: reporterUserId,
                    player2Id: opponentUserId,
                    player1Report: null,
                    player2Report: null,
                    reportedAt: Date.now()
                };

                if (matchResult.player1Id === reporterUserId) {
                    matchResult.player1Report = result;
                } else if (matchResult.player2Id === reporterUserId) {
                    matchResult.player2Report = result;
                } else {
                    console.warn(`Report from unexpected player for room ${roomId}. Reporter: ${reporterUserId}`);
                    ws.send(JSON.stringify({ type: 'error', message: '不正な結果報告です。' }));
                    return;
                }
                reportedMatchResults.set(roomId, matchResult);
                console.log(`Result reported for room ${roomId} by ${reporterUserId}: ${result}`);

                // 両方のプレイヤーが報告済みかチェック
                if (matchResult.player1Report && matchResult.player2Report) {
                    const p1Ws = wsIdToWs.get(userToWsId.get(matchResult.player1Id));
                    const p2Ws = wsIdToWs.get(userToWsId.get(matchResult.player2Id));

                    let p1NewRate, p2NewRate;
                    let p1Record, p2Record;
                    let messageToP1, messageToP2;

                    // 結果の整合性をチェック
                    const isConsistent = 
                        (matchResult.player1Report === 'win' && matchResult.player2Report === 'lose') ||
                        (matchResult.player1Report === 'lose' && matchResult.player2Report === 'win');

                    if (isConsistent) {
                        console.log(`Consistent results for room ${roomId}. Updating rates.`);
                        const p1Data = await getUserData(matchResult.player1Id);
                        const p2Data = await getUserData(matchResult.player2Id);

                        if (p1Data && p2Data) {
                            if (matchResult.player1Report === 'win') {
                                p1NewRate = p1Data.rate + 30;
                                p2NewRate = p2Data.rate - 20;
                                p1Record = `${new Date().toLocaleString()} - BO3 勝利 (レート: ${p1Data.rate} → ${p1NewRate})`;
                                p2Record = `${new Date().toLocaleString()} - BO3 敗北 (レート: ${p2Data.rate} → ${p2NewRate})`;
                                messageToP1 = `対戦結果が確定しました！勝利！<br>レート: ${p1Data.rate} → ${p1NewRate} (+30)`;
                                messageToP2 = `対戦結果が確定しました。敗北。<br>レート: ${p2Data.rate} → ${p2NewRate} (-20)`;
                            } else { // player1Report === 'lose'
                                p1NewRate = p1Data.rate - 20;
                                p2NewRate = p2Data.rate + 30;
                                p1Record = `${new Date().toLocaleString()} - BO3 敗北 (レート: ${p1Data.rate} → ${p1NewRate})`;
                                p2Record = `${new Date().toLocaleString()} - BO3 勝利 (レート: ${p2Data.rate} → ${p2NewRate})`;
                                messageToP1 = `対戦結果が確定しました。敗北。<br>レート: ${p1Data.rate} → ${p1NewRate} (-20)`;
                                messageToP2 = `対戦結果が確定しました！勝利！<br>レート: ${p2Data.rate} → ${p2NewRate} (+30)`;
                            }

                            // データベース更新
                            p1Data.rate = p1NewRate;
                            p1Data.match_history.unshift(p1Record);
                            p1Data.match_history = p1Data.match_history.slice(0, 10); // 最新10件
                            await updateUserData(matchResult.player1Id, p1Data);

                            p2Data.rate = p2NewRate;
                            p2Data.match_history.unshift(p2Record);
                            p2Data.match_history = p2Data.match_history.slice(0, 10); // 最新10件
                            await updateUserData(matchResult.player2Id, p2Data);

                            // クライアントに確定結果を通知
                            if (p1Ws && p1Ws.readyState === WebSocket.OPEN) {
                                p1Ws.send(JSON.stringify({
                                    type: 'battle_result_finalized',
                                    success: true,
                                    message: messageToP1,
                                    newRate: p1NewRate,
                                    newMatchHistory: p1Data.match_history
                                }));
                            }
                            if (p2Ws && p2Ws.readyState === WebSocket.OPEN) {
                                p2Ws.send(JSON.stringify({
                                    type: 'battle_result_finalized',
                                    success: true,
                                    message: messageToP2,
                                    newRate: p2NewRate,
                                    newMatchHistory: p2Data.match_history
                                }));
                            }
                        } else {
                            console.error(`User data not found for rate update in room ${roomId}.`);
                            if (p1Ws && p1Ws.readyState === WebSocket.OPEN) p1Ws.send(JSON.stringify({ type: 'error', message: 'ユーザーデータ取得エラー。' }));
                            if (p2Ws && p2Ws.readyState === WebSocket.OPEN) p2Ws.send(JSON.stringify({ type: 'error', message: 'ユーザーデータ取得エラー。' }));
                        }
                    } else {
                        // 結果が不一致
                        console.log(`Inconsistent results for room ${roomId}.`);
                        if (p1Ws && p1Ws.readyState === WebSocket.OPEN) {
                            p1Ws.send(JSON.stringify({ type: 'battle_result_disputed', message: '対戦結果が一致しませんでした。' }));
                        }
                        if (p2Ws && p2Ws.readyState === WebSocket.OPEN) {
                            p2Ws.send(JSON.stringify({ type: 'battle_result_disputed', message: '対戦結果が一致しませんでした。' }));
                        }
                    }
                    reportedMatchResults.delete(roomId); // 結果処理後、マップから削除
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
                    // username, password_hash はこの関数では更新しない
                    if (data.rate !== undefined) userToUpdate.rate = data.rate;
                    if (data.matchHistory !== undefined) userToUpdate.match_history = data.matchHistory; // DBの列名に合わせる
                    if (data.memos !== undefined) userToUpdate.memos = data.memos;
                    if (data.battleRecords !== undefined) userToUpdate.battle_records = data.battleRecords;
                    if (data.registeredDecks !== undefined) userToUpdate.registered_decks = data.registeredDecks;

                    try {
                        await updateUserData(senderInfo.user_id, userToUpdate);
                        ws.send(JSON.stringify({ type: 'update_user_data_response', success: true, message: 'ユーザーデータを更新しました。', userData: {
                            userId: userToUpdate.user_id,
                            username: userToUpdate.username,
                            rate: userToUpdate.rate,
                            matchHistory: userToUpdate.match_history,
                            memos: userToUpdate.memos,
                            battleRecords: userToUpdate.battle_records,
                            registeredDecks: userToUpdate.registered_decks
                        } }));
                        console.log(`User data updated for ${senderInfo.user_id}: Rate=${userToUpdate.rate}`);
                    } catch (dbErr) {
                        console.error('Database update error:', dbErr);
                        ws.send(JSON.stringify({ type: 'update_user_data_response', success: false, message: 'データベース更新エラーによりデータを保存できませんでした。' }));
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'update_user_data_response', success: false, message: 'ユーザーデータが見つかりません。' }));
                }
                break;

            case 'clear_match_info':
                // 対戦終了時に相手のWS_IDとroom_idをクリア
                senderInfo.opponent_ws_id = null;
                senderInfo.current_room_id = null;
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
            // 切断されたプレイヤーが結果報告を保留していた場合、その情報をクリアするロジックも検討
            // reportedMatchResultsをチェックし、該当するroomIdのレポートを削除
            reportedMatchResults.forEach((value, key) => {
                if (value.player1Id === senderInfo.user_id || value.player2Id === senderInfo.user_id) {
                    reportedMatchResults.delete(key);
                    console.log(`Cleared pending result for room ${key} due to player disconnect.`);
                }
            });
        } else {
            console.log('Unknown client disconnected.');
        }
    });

    ws.on('error', error => {
        const senderInfo = activeConnections.get(ws);
        console.error(`WebSocket error for WS_ID ${senderInfo ? senderInfo.ws_id : 'unknown'}:`, error);
    });
});

// Renderの環境変数からポートを取得
const PORT = process.env.PORT || 3000; // Renderは通常PORT環境変数を使用
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
