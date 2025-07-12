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
                registered_decks JSONB DEFAULT '[]'::jsonb,   -- 新しいカラム
                current_match_id UUID                      -- 現在のマッチIDを追加
            );
        `);
        console.log('Users table ensured.');

        // 既存のテーブルに新しいカラムを追加する（冪等性のためIF NOT EXISTSを使用）
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS memos JSONB DEFAULT '[]'::jsonb;`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS battle_records JSONB DEFAULT '[]'::jsonb;`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS registered_decks JSONB DEFAULT '[]'::jsonb;`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS current_match_id UUID;`); // 新しいカラム
        console.log('New columns (memos, battle_records, registered_decks, current_match_id) ensured.');

        // マッチ結果を保存するテーブルを作成
        await pool.query(`
            CREATE TABLE IF NOT EXISTS matches (
                match_id UUID PRIMARY KEY,
                player1_id UUID NOT NULL,
                player2_id UUID NOT NULL,
                player1_report VARCHAR(10) DEFAULT NULL,
                player2_report VARCHAR(10) DEFAULT NULL,
                resolved_at TIMESTAMP WITH TIME ZONE DEFAULT NULL
            );
        `);
        console.log('Matches table ensured.');

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
    // クライアントから送信される可能性のあるフィールドのみを更新対象とする
    // username, password_hash はこの関数では更新しない
    const { rate, matchHistory, memos, battleRecords, registeredDecks, currentMatchId } = data;
    
    // 現在のユーザーデータを取得して、更新対象外のフィールドを保持
    const currentUserData = await getUserData(userId);
    if (!currentUserData) {
        throw new Error(`User with ID ${userId} not found for update.`);
    }

    await pool.query(
        `UPDATE users SET rate = $1, match_history = $2, memos = $3, battle_records = $4, registered_decks = $5, current_match_id = $6 WHERE user_id = $7`,
        [
            rate !== undefined ? rate : currentUserData.rate,
            matchHistory !== undefined ? JSON.stringify(matchHistory) : currentUserData.match_history,
            memos !== undefined ? JSON.stringify(memos) : currentUserData.memos,
            battleRecords !== undefined ? JSON.stringify(battleRecords) : currentUserData.battle_records,
            registeredDecks !== undefined ? JSON.stringify(registeredDecks) : currentUserData.registered_decks,
            currentMatchId !== undefined ? currentMatchId : currentUserData.current_match_id, // current_match_id を更新
            userId
        ]
    );
}

// 新規ユーザーをDBに登録するヘルパー関数
async function registerNewUser(userId, username, passwordHash) {
    if (!databaseUrl) throw new Error('Database not configured.');
    await pool.query(
        `INSERT INTO users (user_id, username, password_hash, rate, match_history, memos, battle_records, registered_decks, current_match_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [userId, username, passwordHash, 1500, '[]', '[]', '[]', '[]', null] // current_match_idをnullで初期化
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
async function tryMatchPlayers() { // async を追加
    if (waitingPlayers.length >= 2) {
        const player1UserId = waitingPlayers.shift();
        const player2UserId = waitingPlayers.shift();

        const ws1Id = userToWsId.get(player1UserId);
        const ws2Id = userToWsId.get(player2UserId);

        const ws1 = wsIdToWs.get(ws1Id);
        const ws2 = wsIdToWs.get(ws2Id);

        if (ws1 && ws2 && ws1.readyState === WebSocket.OPEN && ws2.readyState === WebSocket.OPEN) {
            const matchId = uuidv4(); // 新しいマッチIDを生成

            // 相手のユーザー名を取得
            const player1Username = await getUsernameByUserId(player1UserId);
            const player2Username = await getUsernameByUserId(player2UserId);

            // 接続情報に相手のws_idを紐付け
            activeConnections.get(ws1).opponent_ws_id = ws2Id;
            activeConnections.get(ws2).opponent_ws_id = ws1Id;

            // ユーザーのcurrent_match_idを更新
            await pool.query('UPDATE users SET current_match_id = $1 WHERE user_id = $2', [matchId, player1UserId]);
            await pool.query('UPDATE users SET current_match_id = $1 WHERE user_id = $2', [matchId, player2UserId]);

            // matchesテーブルに新しいマッチを記録
            await pool.query(
                `INSERT INTO matches (match_id, player1_id, player2_id) VALUES ($1, $2, $3)`,
                [matchId, player1UserId, player2UserId]
            );


            // プレイヤー1にマッチング成立を通知
            ws1.send(JSON.stringify({
                type: 'match_found',
                matchId: matchId, // マッチIDを含める
                opponentUserId: player2UserId,
                opponentUsername: player2Username, // 相手のユーザー名を追加
                isInitiator: true // プレイヤー1がWebRTCのOfferを作成する側
            }));
            console.log(`Matched ${player1UserId} (${player1Username}) with ${player2UserId} (${player2Username}) in match ${matchId}. ${player1UserId} is initiator.`);

            // プレイヤー2にマッチング成立を通知
            ws2.send(JSON.stringify({
                type: 'match_found',
                matchId: matchId, // マッチIDを含める
                opponentUserId: player1UserId,
                opponentUsername: player1Username, // 相手のユーザー名を追加
                isInitiator: false // プレイヤー2はWebRTCのAnswerを作成する側
            }));
            console.log(`Matched ${player2UserId} (${player2Username}) with ${player1UserId} (${player1Username}) in match ${matchId}. ${player2UserId} is not initiator.`);

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
                    registeredDecks: storedUserData.registered_decks, // DBから取得した登録デッキ
                    currentMatchId: storedUserData.current_match_id // 現在のマッチIDも送信
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
                        registeredDecks: autoLoginUserData.registered_decks,
                        currentMatchId: autoLoginUserData.current_match_id // 現在のマッチIDも送信
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
                    // username, password_hash はこの関数では更新しない
                    if (data.rate !== undefined) userToUpdate.rate = data.rate;
                    if (data.matchHistory !== undefined) userToUpdate.match_history = data.matchHistory; // DBの列名に合わせる
                    if (data.memos !== undefined) userToUpdate.memos = data.memos;
                    if (data.battleRecords !== undefined) userToUpdate.battle_records = data.battleRecords;
                    if (data.registeredDecks !== undefined) userToUpdate.registered_decks = data.registeredDecks;
                    if (data.currentMatchId !== undefined) userToUpdate.current_match_id = data.currentMatchId; // current_match_id も更新対象に

                    try {
                        await updateUserData(senderInfo.user_id, userToUpdate);
                        ws.send(JSON.stringify({ type: 'update_user_data_response', success: true, message: 'ユーザーデータを更新しました。', userData: {
                            userId: userToUpdate.user_id,
                            username: userToUpdate.username,
                            rate: userToUpdate.rate,
                            matchHistory: userToUpdate.match_history,
                            memos: userToUpdate.memos,
                            battleRecords: userToUpdate.battle_records,
                            registeredDecks: userToUpdate.registered_decks,
                            currentMatchId: userToUpdate.current_match_id
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

            case 'report_result':
                const { matchId: reportedMatchId, result: reportedResult } = data;
                if (!senderInfo.user_id || !reportedMatchId || !reportedResult) {
                    ws.send(JSON.stringify({ type: 'report_result_response', success: false, message: '報告情報が不足しています。' }));
                    return;
                }

                try {
                    const matchQuery = await pool.query('SELECT * FROM matches WHERE match_id = $1', [reportedMatchId]);
                    const match = matchQuery.rows[0];

                    if (!match) {
                        ws.send(JSON.stringify({ type: 'report_result_response', success: false, message: '無効なマッチIDです。' }));
                        return;
                    }

                    let reporterIsPlayer1 = (match.player1_id === senderInfo.user_id);
                    let reporterIsPlayer2 = (match.player2_id === senderInfo.user_id);

                    if (!reporterIsPlayer1 && !reporterIsPlayer2) {
                        ws.send(JSON.stringify({ type: 'report_result_response', success: false, message: 'このマッチに参加していません。' }));
                        return;
                    }

                    let updateField = reporterIsPlayer1 ? 'player1_report' : 'player2_report';
                    let opponentReportField = reporterIsPlayer1 ? 'player2_report' : 'player1_report';
                    let opponentId = reporterIsPlayer1 ? match.player2_id : match.player1_id;

                    // 既に報告済みかチェック
                    if ((reporterIsPlayer1 && match.player1_report) || (reporterIsPlayer2 && match.player2_report)) {
                        ws.send(JSON.stringify({ type: 'report_result_response', success: false, message: '既に結果を報告済みです。' }));
                        return;
                    }

                    // 報告をDBに保存
                    await pool.query(`UPDATE matches SET ${updateField} = $1 WHERE match_id = $2`, [reportedResult, reportedMatchId]);
                    console.log(`User ${senderInfo.user_id} reported ${reportedResult} for match ${reportedMatchId}.`);

                    // 相手の報告を取得
                    const updatedMatchQuery = await pool.query('SELECT * FROM matches WHERE match_id = $1', [reportedMatchId]);
                    const updatedMatch = updatedMatchQuery.rows[0];
                    const opponentReport = updatedMatch[opponentReportField];

                    if (opponentReport) {
                        // 両方のプレイヤーが報告済み
                        let myResult = reportedResult;
                        let theirResult = opponentReport;

                        let resolutionMessage = '';
                        let myNewRate = (await getUserData(senderInfo.user_id)).rate;
                        let opponentNewRate = (await getUserData(opponentId)).rate;
                        let myMatchHistory = (await getUserData(senderInfo.user_id)).match_history;
                        let opponentMatchHistory = (await getUserData(opponentId)).match_history;

                        const timestamp = new Date().toLocaleString();

                        if (myResult === 'cancel' && theirResult === 'cancel') {
                            resolutionMessage = 'resolved_cancel';
                            // レート変動なし、履歴に中止を記録
                            myMatchHistory.unshift(`${timestamp} - 対戦中止`);
                            opponentMatchHistory.unshift(`${timestamp} - 対戦中止`);
                        } else if ((myResult === 'win' && theirResult === 'lose') || (myResult === 'lose' && theirResult === 'win')) {
                            resolutionMessage = 'resolved_consistent'; // 整合性あり
                            // レート計算
                            if (myResult === 'win') {
                                myNewRate += 30;
                                opponentNewRate -= 20;
                                myMatchHistory.unshift(`${timestamp} - 勝利 (レート: ${myNewRate - 30} → ${myNewRate})`);
                                opponentMatchHistory.unshift(`${timestamp} - 敗北 (レート: ${opponentNewRate + 20} → ${opponentNewRate})`);
                            } else { // myResult === 'lose'
                                myNewRate -= 20;
                                opponentNewRate += 30;
                                myMatchHistory.unshift(`${timestamp} - 敗北 (レート: ${myNewRate + 20} → ${myNewRate})`);
                                opponentMatchHistory.unshift(`${timestamp} - 勝利 (レート: ${opponentNewRate - 30} → ${opponentNewRate})`);
                            }
                        } else {
                            // 結果不一致 (win vs win, lose vs lose, win vs cancel, lose vs cancel)
                            resolutionMessage = 'disputed'; // 不一致
                            // レート変動なし、履歴に不一致を記録
                            myMatchHistory.unshift(`${timestamp} - 結果不一致`);
                            opponentMatchHistory.unshift(`${timestamp} - 結果不一致`);
                        }

                        // データベースを更新
                        await pool.query('UPDATE matches SET player1_report = $1, player2_report = $2, resolved_at = NOW() WHERE match_id = $3',
                            [updatedMatch.player1_report, updatedMatch.player2_report, reportedMatchId]);
                        
                        await updateUserData(senderInfo.user_id, { rate: myNewRate, matchHistory: myMatchHistory, currentMatchId: null });
                        await updateUserData(opponentId, { rate: opponentNewRate, matchHistory: opponentMatchHistory, currentMatchId: null });

                        // 両方のクライアントに結果を通知
                        const responseToReporter = {
                            type: 'report_result_response',
                            success: true,
                            message: `結果が確定しました: ${resolutionMessage === 'resolved_consistent' ? '整合性あり' : (resolutionMessage === 'resolved_cancel' ? '対戦中止' : '結果不一致')}`,
                            result: resolutionMessage,
                            myNewRate: myNewRate,
                            myMatchHistory: myMatchHistory
                        };
                        ws.send(JSON.stringify(responseToReporter));

                        const opponentWs = wsIdToWs.get(userToWsId.get(opponentId));
                        if (opponentWs && opponentWs.readyState === WebSocket.OPEN) {
                            const responseToOpponent = {
                                type: 'report_result_response',
                                success: true,
                                message: `対戦相手が結果を報告しました。結果が確定しました: ${resolutionMessage === 'resolved_consistent' ? '整合性あり' : (resolutionMessage === 'resolved_cancel' ? '対戦中止' : '結果不一致')}`,
                                result: resolutionMessage,
                                myNewRate: opponentNewRate,
                                myMatchHistory: opponentMatchHistory
                            };
                            opponentWs.send(JSON.stringify(responseToOpponent));
                        }
                        console.log(`Match ${reportedMatchId} resolved: ${resolutionMessage}`);

                    } else {
                        // 相手の報告を待つ
                        ws.send(JSON.stringify({ type: 'report_result_response', success: true, message: '結果を報告しました。相手の報告を待っています。', result: 'pending' }));
                    }

                } catch (reportErr) {
                    console.error('Report result error:', reportErr);
                    ws.send(JSON.stringify({ type: 'report_result_response', success: false, message: '結果報告中にエラーが発生しました。' }));
                }
                break;

            case 'clear_match_info':
                // 対戦終了時に相手のWS_IDをクリア
                senderInfo.opponent_ws_id = null;
                // ユーザーのcurrent_match_idもクリア
                if (senderInfo.user_id) {
                    await pool.query('UPDATE users SET current_match_id = NULL WHERE user_id = $1', [senderInfo.user_id]);
                }
                console.log(`WS_ID ${senderInfo.ws_id} cleared match info.`);
                break;

            default:
                console.warn(`Unknown message type: ${data.type}`);
        }
    });

    ws.on('close', async () => { // async を追加
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

                // もしマッチ中に切断された場合、相手に通知するロジックを追加することも可能
                // (例: if (senderInfo.opponent_ws_id) { ... })
                // current_match_id をDBからクリア
                await pool.query('UPDATE users SET current_match_id = NULL WHERE user_id = $1', [senderInfo.user_id]);
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

// Renderの環境変数からポートを取得
const PORT = process.env.PORT || 3000; // Renderは通常PORT環境変数を使用
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
