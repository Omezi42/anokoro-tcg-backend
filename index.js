// index.js (Renderサーバーのバックエンドコード) - 修正版

// 必要なモジュールのインポート
const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid'); // UUID生成用
const bcrypt = require('bcrypt'); // パスワードハッシュ化用
const { Pool } = require('pg'); // PostgreSQLデータベースクライアント

// --- データベース接続設定 ---
// Renderの環境変数からデータベース接続情報を取得
const databaseUrl = process.env.DATABASE_URL;

// DATABASE_URLが設定されていない場合はエラーログを出力し、データベース機能なしで続行
if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is not set. Please ensure PostgreSQL is linked in Render.');
    // データベースなしでは起動しない場合は process.exit(1) を追加
}

// PostgreSQL接続プールを初期化
const pool = new Pool({
    connectionString: databaseUrl,
    ssl: {
        // RenderではSSLが必要なため、rejectUnauthorizedをfalseに設定（開発用、本番では証明書検証推奨）
        rejectUnauthorized: false 
    }
});

// データベース接続テスト
pool.connect((err, client, release) => {
    if (err) {
        console.error('ERROR: Failed to acquire database client (database connection failed):', err.stack);
        return; // 接続失敗してもサーバーは起動し続ける（ただしDB機能は使えない）
    }
    client.query('SELECT NOW()', (err, result) => {
        release(); // クライアントをプールに戻す
        if (err) {
            return console.error('ERROR: Failed to execute database test query:', err.stack);
        }
        console.log('Database connected successfully:', result.rows[0].now);
    });
});

// --- データベース初期化（テーブルとカラムの作成） ---
// ユーザーテーブルとマッチテーブルが存在しない場合は作成し、新しいカラムを追加
async function initializeDatabase() {
    if (!databaseUrl) {
        console.warn('WARNING: Skipping database initialization: DATABASE_URL is not set.');
        return;
    }
    try {
        // usersテーブルの作成または存在確認
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                user_id UUID PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                display_name VARCHAR(255) NOT NULL DEFAULT '', -- 新しい表示名カラム
                rate INTEGER DEFAULT 1500,
                match_history JSONB DEFAULT '[]'::jsonb,             
                memos JSONB DEFAULT '[]'::jsonb,    
                battle_records JSONB DEFAULT '[]'::jsonb,   
                registered_decks JSONB DEFAULT '[]'::jsonb,   
                current_match_id UUID                      -- 現在のマッチIDを追加
            );
        `);
        console.log('Database: Users table ensured.');

        // 既存のテーブルに新しいカラムを追加する（冪等性のためIF NOT EXISTSを使用）
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(255) NOT NULL DEFAULT '';`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS memos JSONB DEFAULT '[]'::jsonb;`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS battle_records JSONB DEFAULT '[]'::jsonb;`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS registered_decks JSONB DEFAULT '[]'::jsonb;`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS current_match_id UUID;`); // 新しいカラム
        console.log('Database: New columns (display_name, memos, battle_records, registered_decks, current_match_id) ensured.');

        // matchesテーブルを作成（結果報告の整合性用）
        await pool.query(`
            CREATE TABLE IF NOT EXISTS matches (
                match_id UUID PRIMARY KEY,
                player1_id UUID NOT NULL,
                player2_id UUID NOT NULL,
                player1_report VARCHAR(10) DEFAULT NULL, -- 'win', 'lose', 'cancel'
                player2_report VARCHAR(10) DEFAULT NULL, -- 'win', 'lose', 'cancel'
                resolved_at TIMESTAMP WITH TIME ZONE DEFAULT NULL
            );
        `);
        console.log('Database: Matches table ensured.');

    } catch (err) {
        console.error('ERROR: Database initialization failed:', err.stack);
    }
}
initializeDatabase(); // サーバー起動時にデータベースを初期化

// --- HTTPサーバー設定 ---
// HTTPサーバーを作成（RenderはWebSocketのためにHTTPサーバーが必要です）
const server = http.createServer((req, res) => {
    // RenderのKeep-Alive機能のためのシンプルな応答
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('WebSocket server is running.');
    } else {
        res.writeHead(404);
        res.end();
    }
});

// --- WebSocketサーバー設定 ---
// WebSocketサーバーをHTTPサーバーにアタッチ
const wss = new WebSocket.Server({ server });

console.log('WebSocket server starting...');

// --- グローバル状態管理 ---
let waitingPlayers = []; // マッチング待ちのプレイヤーのuser_idを格納
const activeConnections = new Map(); // 接続中のクライアント (wsインスタンス -> { ws_id, user_id, opponent_ws_id, current_room_id })
const wsIdToWs = new Map(); // ws_id -> wsインスタンス (WebSocketインスタンスへの参照)
const userToWsId = new Map(); // user_id -> ws_id (ユーザーがログイン中の場合、現在のWS_IDを保持)

// 対戦結果報告の整合性を取るためのマップ
// key: roomId, value: { player1Id, player2Id, player1Report: 'win'|'lose'|'cancel'|null, player2Report: 'win'|'lose'|'cancel'|null }
const reportedMatchResults = new Map(); 

const BCRYPT_SALT_ROUNDS = 10; // bcryptのソルトラウンド数（セキュリティレベル）

// --- データベース操作ヘルパー関数 ---
/**
 * 指定されたユーザーIDの全ユーザーデータをデータベースから取得します。
 * @param {string} userId - ユーザーのUUID。
 * @returns {Promise<Object|null>} ユーザーデータオブジェクト、またはnull。
 */
async function getUserData(userId) {
    if (!databaseUrl) return null;
    try {
        const res = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
        return res.rows[0];
    } catch (err) {
        console.error(`Database: Error getting user data for ${userId}:`, err.stack);
        return null;
    }
}

/**
 * 指定されたユーザーIDのユーザーデータをデータベースで更新します。
 * クライアントから提供されたフィールドのみを更新します。
 * @param {string} userId - ユーザーのUUID。
 * @param {Object} data - 更新するデータ（display_name, rate, matchHistory, memos, battleRecords, registeredDecks, currentMatchId）。
 */
async function updateUserData(userId, data) {
    if (!databaseUrl) return;
    try {
        // 現在のユーザーデータを取得して、更新対象外のフィールドを保持
        const currentUserData = await getUserData(userId);
        if (!currentUserData) {
            console.error(`Database: User with ID ${userId} not found for update.`);
            return;
        }

        await pool.query(
            `UPDATE users SET 
                display_name = $1,
                rate = $2, 
                match_history = $3, 
                memos = $4, 
                battle_records = $5, 
                registered_decks = $6, 
                current_match_id = $7 
             WHERE user_id = $8`,
            [
                data.displayName !== undefined ? data.displayName : currentUserData.display_name, // display_nameを更新
                data.rate !== undefined ? data.rate : currentUserData.rate,
                data.matchHistory !== undefined ? JSON.stringify(data.matchHistory) : currentUserData.match_history,
                data.memos !== undefined ? JSON.stringify(data.memos) : currentUserData.memos,
                data.battleRecords !== undefined ? JSON.stringify(data.battleRecords) : currentUserData.battle_records,
                data.registeredDecks !== undefined ? JSON.stringify(data.registeredDecks) : currentUserData.registered_decks,
                data.currentMatchId !== undefined ? data.currentMatchId : currentUserData.current_match_id, // current_match_id も更新対象に
                userId
            ]
        );
    } catch (err) {
        console.error(`Database: Error updating user data for ${userId}:`, err.stack);
        throw err; // エラーを呼び出し元に再スロー
    }
}

/**
 * 新規ユーザーをデータベースに登録します。
 * @param {string} userId - 新しいユーザーのUUID。
 * @param {string} username - ユーザー名。
 * @param {string} passwordHash - ハッシュ化されたパスワード。
 */
async function registerNewUser(userId, username, passwordHash) {
    if (!databaseUrl) throw new Error('Database not configured.');
    try {
        await pool.query(
            `INSERT INTO users (user_id, username, password_hash, display_name, rate, match_history, memos, battle_records, registered_decks, current_match_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [userId, username, passwordHash, username, 1500, '[]', '[]', '[]', '[]', null] // display_nameをusernameで初期化
        );
    } catch (err) {
        console.error(`Database: Error registering new user ${username}:`, err.stack);
        throw err; // エラーを呼び出し元に再スロー
    }
}

/**
 * ユーザー名からユーザーIDをデータベースから取得します。
 * @param {string} username - ユーザー名。
 * @returns {Promise<string|null>} ユーザーID、またはnull。
 */
async function getUserIdByUsername(username) {
    if (!databaseUrl) return null;
    try {
        const res = await pool.query('SELECT user_id FROM users WHERE username = $1', [username]);
        return res.rows[0] ? res.rows[0].user_id : null;
    } catch (err) {
        console.error(`Database: Error getting user ID by username ${username}:`, err.stack);
        return null;
    }
}

/**
 * ユーザーIDからユーザー名を取得します。
 * @param {string} userId - ユーザーID。
 * @returns {Promise<string|null>} ユーザー名、またはnull。
 */
async function getUsernameByUserId(userId) {
    if (!databaseUrl) return null;
    try {
        const res = await pool.query('SELECT username FROM users WHERE user_id = $1', [userId]);
        return res.rows[0] ? res.rows[0].username : null;
    } catch (err) {
        console.error(`Database: Error getting username by user ID ${userId}:`, err.stack);
        return null;
    }
}

/**
 * ユーザーIDから表示名を取得します。
 * @param {string} userId - ユーザーID。
 * @returns {Promise<string|null>} 表示名、またはnull。
 */
async function getDisplayNameByUserId(userId) {
    if (!databaseUrl) return null;
    try {
        const res = await pool.query('SELECT display_name FROM users WHERE user_id = $1', [userId]);
        return res.rows[0] ? res.rows[0].display_name : null;
    } catch (err) {
        console.error(`Database: Error getting display name by user ID ${userId}:`, err.stack);
        return null;
    }
}


// --- マッチングロジック ---
/**
 * マッチングキューからプレイヤーをマッチングさせます。
 * 2人以上のプレイヤーがキューにいる場合にマッチを成立させます。
 */
async function tryMatchPlayers() {
    if (waitingPlayers.length >= 2) {
        const player1UserId = waitingPlayers.shift();
        const player2UserId = waitingPlayers.shift();

        const ws1Id = userToWsId.get(player1UserId);
        const ws2Id = userToWsId.get(player2UserId);

        const ws1 = wsIdToWs.get(ws1Id);
        const ws2 = wsIdToWs.get(ws2Id);

        // 両方のWebSocket接続がまだオープンであることを確認
        if (ws1 && ws2 && ws1.readyState === WebSocket.OPEN && ws2.readyState === WebSocket.OPEN) {
            const matchId = uuidv4(); // 新しいマッチIDを生成

            // 相手の表示名を取得
            const player1DisplayName = await getDisplayNameByUserId(player1UserId);
            const player2DisplayName = await getDisplayNameByUserId(player2UserId);

            // 接続情報に相手のws_idとroom_idを紐付け
            activeConnections.get(ws1).opponent_ws_id = ws2Id;
            activeConnections.get(ws2).opponent_ws_id = ws1Id;
            activeConnections.get(ws1).current_room_id = matchId; // current_room_idをmatchIdに設定
            activeConnections.get(ws2).current_room_id = matchId;


            // ユーザーのcurrent_match_idを更新
            await updateUserData(player1UserId, { currentMatchId: matchId });
            await updateUserData(player2UserId, { currentMatchId: matchId });

            // matchesテーブルに新しいマッチを記録
            await pool.query(
                `INSERT INTO matches (match_id, player1_id, player2_id) VALUES ($1, $2, $3)`,
                [matchId, player1UserId, player2UserId]
            );
            console.log(`Match: Match ${matchId} recorded between ${player1UserId} and ${player2UserId}.`);


            // プレイヤー1にマッチング成立を通知
            ws1.send(JSON.stringify({
                type: 'match_found',
                matchId: matchId, // マッチIDを含める
                opponentUserId: player2UserId,
                opponentDisplayName: player2DisplayName, // 相手の表示名を追加
                isInitiator: true // プレイヤー1がWebRTCのOfferを作成する側
            }));
            console.log(`Match: Match found! ${player1UserId} (${player1DisplayName}) is initiator for match ${matchId}. Opponent: ${player2UserId} (${player2DisplayName}).`);

            // プレイヤー2にマッチング成立を通知
            ws2.send(JSON.stringify({
                type: 'match_found',
                matchId: matchId, // マッチIDを含める
                opponentUserId: player1UserId,
                opponentDisplayName: player1DisplayName, // 相手の表示名を追加
                isInitiator: false // プレイヤー2はWebRTCのAnswerを作成する側
            }));
            console.log(`Match: Match found! ${player2UserId} (${player2DisplayName}) is not initiator for match ${matchId}. Opponent: ${player1UserId} (${player1DisplayName}).`);

        } else {
            // プレイヤーの接続が切れている場合はキューに戻すか破棄
            if (ws1 && ws1.readyState === WebSocket.OPEN) waitingPlayers.unshift(player1UserId);
            if (ws2 && ws2.readyState === WebSocket.OPEN) waitingPlayers.unshift(player2UserId);
            console.log('Match: One or both players disconnected before match could be established. Re-queueing or discarding.');
        }
    }
}

// --- WebSocketイベントハンドリング ---
wss.on('connection', ws => {
    const wsId = uuidv4(); // WebSocket接続ごとにユニークなIDを生成
    activeConnections.set(ws, { ws_id: wsId, user_id: null, opponent_ws_id: null, current_room_id: null }); // current_room_idを追加
    wsIdToWs.set(wsId, ws);

    console.log(`WS: Client connected: ${wsId}. Total active WS: ${activeConnections.size}`);

    ws.on('message', async message => {
        const data = JSON.parse(message);
        const senderInfo = activeConnections.get(ws);
        if (!senderInfo) {
            console.warn('WS: WARNING: Message from unknown client (no senderInfo).');
            return;
        }

        console.log(`WS: Message from WS_ID ${senderInfo.ws_id} (User: ${senderInfo.user_id || 'N/A'}) (Type: ${data.type})`);

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
                    console.log(`Auth: User registered: ${regUsername} (${newUserId})`);
                } catch (dbErr) {
                    console.error('Auth: ERROR: Database register error:', dbErr);
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

                // ★★★ 修正点 ★★★
                // 以前はここで古い接続を強制的に切断していましたが、それがログアウトループの原因でした。
                // このロジックを無効化し、新しい接続が常に優先されるようにします。
                // 古い接続はタイムアウトによって自然に切断されます。
                const existingWsIdForUser = userToWsId.get(storedUserData.user_id);
                if (existingWsIdForUser) {
                     console.log(`Auth: INFO: User ${loginUsername} (${storedUserData.user_id}) is re-logging in. New connection (${senderInfo.ws_id}) will take over from old one (${existingWsIdForUser}).`);
                }

                senderInfo.user_id = storedUserData.user_id; // WS接続にユーザーIDを紐付け
                userToWsId.set(storedUserData.user_id, senderInfo.ws_id); // ユーザーIDからWS_IDを引けるように（常に新しい接続で上書き）
                ws.send(JSON.stringify({
                    type: 'login_response',
                    success: true,
                    message: 'ログインしました！',
                    userId: storedUserData.user_id,
                    username: storedUserData.username, // usernameも送信
                    displayName: storedUserData.display_name, // display_nameを送信
                    rate: storedUserData.rate,
                    matchHistory: storedUserData.match_history, // DBから取得した履歴
                    memos: storedUserData.memos,                 // DBから取得したメモ
                    battleRecords: storedUserData.battle_records, // DBから取得した対戦記録
                    registeredDecks: storedUserData.registered_decks, // DBから取得した登録デッキ
                    currentMatchId: storedUserData.current_match_id // 現在のマッチIDも送信
                }));
                console.log(`Auth: User logged in: ${loginUsername} (${storedUserData.user_id})`);
                break;
            
            case 'auto_login': // 自動ログインリクエスト
                const { userId: autoLoginUserId, username: autoLoginUsername } = data;
                if (!autoLoginUserId || !autoLoginUsername) {
                    ws.send(JSON.stringify({ type: 'auto_login_response', success: false, message: '自動ログイン情報が不足しています。' }));
                    return;
                }
                const autoLoginUserData = await getUserData(autoLoginUserId);
                if (autoLoginUserData && autoLoginUserData.username === autoLoginUsername) {
                    // ★★★ 修正点 ★★★
                    // こちらも同様に、古い接続を強制切断するロジックを無効化します。
                    const existingAutoLoginWsId = userToWsId.get(autoLoginUserData.user_id);
                     if (existingAutoLoginWsId) {
                        console.log(`Auth: INFO: User ${autoLoginUsername} (${autoLoginUserData.user_id}) is re-logging in automatically. New connection (${senderInfo.ws_id}) will take over from old one (${existingAutoLoginWsId}).`);
                    }

                    senderInfo.user_id = autoLoginUserData.user_id;
                    userToWsId.set(autoLoginUserData.user_id, senderInfo.ws_id); // 常に新しい接続で上書き
                    ws.send(JSON.stringify({
                        type: 'auto_login_response',
                        success: true,
                        message: '自動ログインしました！',
                        userId: autoLoginUserData.user_id,
                        username: autoLoginUserData.username, // usernameも送信
                        displayName: autoLoginUserData.display_name, // display_nameを送信
                        rate: autoLoginUserData.rate,
                        matchHistory: autoLoginUserData.match_history,
                        memos: autoLoginUserData.memos,
                        battleRecords: autoLoginUserData.battle_records,
                        registeredDecks: autoLoginUserData.registered_decks,
                        currentMatchId: autoLoginUserData.current_match_id // 現在のマッチIDも送信
                    }));
                    console.log(`Auth: User auto-logged in: ${autoLoginUsername} (${autoLoginUserData.user_id})`);
                } else {
                    ws.send(JSON.stringify({ type: 'auto_login_response', success: false, message: '自動ログインに失敗しました。' }));
                }
                break;

            case 'logout':
                if (senderInfo.user_id) {
                    userToWsId.delete(senderInfo.user_id);
                    senderInfo.user_id = null;
                    ws.send(JSON.stringify({ type: 'logout_response', success: true, message: 'ログアウトしました。' }));
                    console.log(`Auth: User logged out: ${senderInfo.user_id}`);
                } else {
                    ws.send(JSON.stringify({ type: 'logout_response', success: false, message: 'ログインしていません。' }));
                }
                break;
            
            case 'update_display_name': // 表示名変更リクエスト
                const { newDisplayName } = data;
                if (!senderInfo.user_id || !newDisplayName) {
                    ws.send(JSON.stringify({ type: 'update_display_name_response', success: false, message: '表示名が不正です。' }));
                    return;
                }
                if (newDisplayName.length > 20) { // 表示名の長さに制限を設ける（クライアント側と同期）
                    ws.send(JSON.stringify({ type: 'update_display_name_response', success: false, message: '表示名は20文字以内で入力してください。' }));
                    return;
                }
                try {
                    const currentUserData = await getUserData(senderInfo.user_id);
                    if (!currentUserData) {
                        ws.send(JSON.stringify({ type: 'update_display_name_response', success: false, message: 'ユーザーが見つかりません。' }));
                        return;
                    }
                    await updateUserData(senderInfo.user_id, { displayName: newDisplayName });
                    ws.send(JSON.stringify({ type: 'update_display_name_response', success: true, message: '表示名を更新しました！', displayName: newDisplayName }));
                    console.log(`Auth: User ${senderInfo.user_id} display name updated to ${newDisplayName}.`);
                } catch (err) {
                    console.error('Auth: ERROR: Failed to update display name:', err);
                    ws.send(JSON.stringify({ type: 'update_display_name_response', success: false, message: '表示名の更新に失敗しました。' }));
                }
                break;

            case 'join_queue':
                if (!senderInfo.user_id) {
                    ws.send(JSON.stringify({ type: 'error', message: 'ログインしてください。' }));
                    return;
                }
                // 既にキューにいるか、マッチ中の場合はエラー
                if (waitingPlayers.includes(senderInfo.user_id) || (await getUserData(senderInfo.user_id)).current_match_id) {
                    ws.send(JSON.stringify({ type: 'error', message: '既にマッチングキューに参加しているか、対戦中です。' }));
                    return;
                }

                waitingPlayers.push(senderInfo.user_id);
                console.log(`Matchmaking: User ${senderInfo.user_id} joined queue. Current queue: ${waitingPlayers.length}`);
                ws.send(JSON.stringify({ type: 'queue_status', message: '対戦相手を検索中です...' }));
                tryMatchPlayers();
                break;

            case 'leave_queue':
                if (!senderInfo.user_id) {
                    ws.send(JSON.stringify({ type: 'error', message: 'ログインしてください。' }));
                    return;
                }
                waitingPlayers = waitingPlayers.filter(id => id !== senderInfo.user_id);
                console.log(`Matchmaking: User ${senderInfo.user_id} left queue. Current queue: ${waitingPlayers.length}`);
                ws.send(JSON.stringify({ type: 'queue_status', message: 'マッチングをキャンセルしました。' }));
                // もしマッチ中にキャンセルされた場合、相手にも通知してマッチを終了させるロジックが必要
                // (例: if (senderInfo.opponent_ws_id) { ... })
                break;

            case 'webrtc_signal':
                if (!senderInfo.user_id || !senderInfo.opponent_ws_id) {
                    console.warn(`WebRTC: WARNING: WebRTC signal from ${senderInfo.ws_id} but no user_id or opponent_ws_id.`);
                    return;
                }
                const opponentWs = wsIdToWs.get(senderInfo.opponent_ws_id);
                if (opponentWs && opponentWs.readyState === WebSocket.OPEN) {
                    opponentWs.send(JSON.stringify({
                        type: 'webrtc_signal',
                        senderUserId: senderInfo.user_id, // 相手に送信元のユーザーIDを伝える
                        signal: data.signal // SDP (offer/answer) や ICE candidate
                    }));
                    console.log(`WebRTC: Relaying WebRTC signal from WS_ID ${senderInfo.ws_id} (User: ${senderInfo.user_id}) to WS_ID ${senderInfo.opponent_ws_id}`);
                } else {
                    console.warn(`WebRTC: WARNING: Opponent WS_ID ${senderInfo.opponent_ws_id} not found or not open for signaling from WS_ID ${senderInfo.ws_id}.`);
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
                    console.log(`Report: User ${senderInfo.user_id} reported ${reportedResult} for match ${reportedMatchId}.`);

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
                            messageToP1 = `対戦結果が確定しました: 対戦中止。`;
                            messageToP2 = `対戦結果が確定しました: 対戦中止。`;
                        } else if ((myResult === 'win' && theirResult === 'lose') || (myResult === 'lose' && theirResult === 'win')) {
                            resolutionMessage = 'resolved_consistent'; // 整合性あり
                            // レート計算
                            if (myResult === 'win') {
                                myNewRate += 30;
                                opponentNewRate -= 20;
                                myMatchHistory.unshift(`${timestamp} - 勝利 (レート: ${myNewRate - 30} → ${myNewRate})`);
                                opponentMatchHistory.unshift(`${timestamp} - 敗北 (レート: ${opponentNewRate + 20} → ${opponentNewRate})`);
                                messageToP1 = `対戦結果が確定しました！勝利！<br>レート: ${myNewRate - 30} → ${myNewRate} (+30)`;
                                messageToP2 = `対戦結果が確定しました。敗北。<br>レート: ${opponentNewRate + 20} → ${opponentNewRate} (-20)`;
                            } else { // myResult === 'lose'
                                myNewRate -= 20;
                                opponentNewRate += 30;
                                myMatchHistory.unshift(`${timestamp} - 敗北 (レート: ${myNewRate + 20} → ${myNewRate})`);
                                opponentMatchHistory.unshift(`${timestamp} - 勝利 (レート: ${opponentNewRate - 30} → ${opponentNewRate})`);
                                messageToP1 = `対戦結果が確定しました。敗北。<br>レート: ${myNewRate + 20} → ${myNewRate} (-20)`;
                                messageToP2 = `対戦結果が確定しました！勝利！<br>レート: ${opponentNewRate - 30} → ${opponentNewRate} (+30)`;
                            }
                        } else {
                            // 結果不一致 (win vs win, lose vs lose, win vs cancel, lose vs cancel)
                            resolutionMessage = 'disputed'; // 不一致
                            // レート変動なし、履歴に不一致を記録
                            myMatchHistory.unshift(`${timestamp} - 結果不一致`);
                            opponentMatchHistory.unshift(`${timestamp} - 結果不一致`);
                            messageToP1 = `対戦結果が一致しませんでした。`;
                            messageToP2 = `対戦結果が一致しませんでした。`;
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
                            message: messageToP1,
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
                                message: messageToP2,
                                result: resolutionMessage,
                                myNewRate: opponentNewRate,
                                myMatchHistory: opponentMatchHistory
                            };
                            opponentWs.send(JSON.stringify(responseToOpponent));
                        }
                        console.log(`Report: Match ${reportedMatchId} resolved: ${resolutionMessage}`);

                    } else {
                        // 相手の報告を待つ
                        ws.send(JSON.stringify({ type: 'report_result_response', success: true, message: '結果を報告しました。相手の報告を待っています。', result: 'pending' }));
                    }

                } catch (reportErr) {
                    console.error('Report: ERROR: Report result error:', reportErr);
                    ws.send(JSON.stringify({ type: 'report_result_response', success: false, message: '結果報告中にエラーが発生しました。' }));
                }
                break;

            case 'clear_match_info':
                // 対戦終了時に相手のWS_IDとroom_idをクリア
                senderInfo.opponent_ws_id = null;
                senderInfo.current_room_id = null;
                console.log(`Match: WS_ID ${senderInfo.ws_id} cleared match info.`);
                break;
            
            case 'get_ranking':
                if (!databaseUrl) {
                    ws.send(JSON.stringify({ type: 'ranking_response', success: false, message: 'データベースが設定されていません。' }));
                    return;
                }
                try {
                    // レートの高い順にユーザー名とレートを取得（上位100名）
                    const res = await pool.query('SELECT username, display_name, rate FROM users ORDER BY rate DESC LIMIT 100'); // display_nameも取得
                    ws.send(JSON.stringify({
                        type: 'ranking_response',
                        success: true,
                        rankingData: res.rows.map(row => ({ userId: row.user_id, username: row.username, displayName: row.display_name, rate: row.rate })) // userIdも送信
                    }));
                    console.log('Ranking: Sent ranking data to client.');
                } catch (err) {
                    console.error('Ranking: ERROR: Failed to get ranking data:', err.stack);
                    ws.send(JSON.stringify({ type: 'ranking_response', success: false, message: 'ランキングの取得に失敗しました。' }));
                }
                break;

            default:
                console.warn(`WS: WARNING: Unknown message type: ${data.type}`);
        }
    });

    ws.on('close', async () => { // async を追加
        const senderInfo = activeConnections.get(ws);
        if (senderInfo) {
            console.log(`WS: Client disconnected: WS_ID ${senderInfo.ws_id}.`);
            if (senderInfo.user_id) {
                // ユーザーがログアウトせずに切断した場合、userToWsIdから削除
                // ★★★ 重要 ★★★
                // 複数の接続が存在する場合、現在の接続が本当にこのユーザーの最後の接続であるかを確認してから削除します。
                // これにより、新しい接続が古い接続の切断処理によって誤ってログアウトされるのを防ぎます。
                if (userToWsId.get(senderInfo.user_id) === senderInfo.ws_id) {
                    userToWsId.delete(senderInfo.user_id);
                    console.log(`Auth: User ${senderInfo.user_id} removed from active user map because their connection (${senderInfo.ws_id}) closed.`);
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
            // 切断されたプレイヤーが結果報告を保留していた場合、その情報をクリアするロジックも検討
            // reportedMatchResultsをチェックし、該当するroomIdのレポートを削除
            reportedMatchResults.forEach((value, key) => {
                if (value.player1Id === senderInfo.user_id || value.player2Id === senderInfo.user_id) {
                    reportedMatchResults.delete(key);
                    console.log(`Report: Cleared pending result for room ${key} due to player disconnect.`);
                }
            });
        } else {
            console.log('WS: Unknown client disconnected.');
        }
    });

    ws.on('error', error => {
        const senderInfo = activeConnections.get(ws);
        console.error(`WS: ERROR: WebSocket error for WS_ID ${senderInfo ? senderInfo.ws_id : 'unknown'}:`, error);
    });
});

// Renderの環境変数からポートを取得
const PORT = process.env.PORT || 10000; // Renderは通常PORT環境変数を使用
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
