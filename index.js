/*
 * Supabase Migration:
 * This file has been updated to use Supabase instead of Render's PostgreSQL.
 *
 * --- Supabase Setup Instructions ---
 * 1. Create a new project on Supabase.
 * 2. Go to the "SQL Editor" in your Supabase project dashboard.
 * 3. Run the following SQL queries to create the necessary tables.
 * 4. Go to "Project Settings" > "API" and find your Project URL and service_role Key.
 * 5. Set SUPABASE_URL and SUPABASE_SERVICE_KEY as environment variables where you deploy this server.
 *
 * --- SQL for Supabase ---
 *
-- users table
CREATE TABLE public.users (
    user_id uuid NOT NULL,
    username character varying NOT NULL,
    password_hash character varying NOT NULL,
    rate integer DEFAULT 1500 NOT NULL,
    match_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    memos jsonb DEFAULT '[]'::jsonb NOT NULL,
    battle_records jsonb DEFAULT '[]'::jsonb NOT NULL,
    registered_decks jsonb DEFAULT '[]'::jsonb NOT NULL,
    current_match_id uuid,
    CONSTRAINT users_pkey PRIMARY KEY (user_id),
    CONSTRAINT users_username_key UNIQUE (username)
);
ALTER TABLE public.users REPLICA IDENTITY FULL; -- For Supabase Realtime (optional but recommended)

-- matches table
CREATE TABLE public.matches (
    match_id uuid NOT NULL,
    player1_id uuid NOT NULL,
    player2_id uuid NOT NULL,
    player1_report character varying(10),
    player2_report character varying(10),
    resolved_at timestamp with time zone,
    CONSTRAINT matches_pkey PRIMARY KEY (match_id),
    CONSTRAINT matches_player1_id_fkey FOREIGN KEY (player1_id) REFERENCES public.users(user_id),
    CONSTRAINT matches_player2_id_fkey FOREIGN KEY (player2_id) REFERENCES public.users(user_id)
);
ALTER TABLE public.matches REPLICA IDENTITY FULL; -- For Supabase Realtime (optional but recommended)
 *
*/

const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs'); // Changed from 'bcrypt' to 'bcryptjs'
const { createClient } = require('@supabase/supabase-js'); // Supabase client

// Get Supabase connection info from environment variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Use the service_role key for backend operations

if (!supabaseUrl || !supabaseKey) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are not set.');
    process.exit(1); // Exit if essential environment variables are missing
}

const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
        persistSession: false // Disable session persistence for server-side usage
    }
});
console.log('Supabase client initialized.');


// HTTP server setup
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('WebSocket server with Supabase is running.');
    } else {
        res.writeHead(404);
        res.end();
    }
});

// Attach WebSocket server to the HTTP server
const wss = new WebSocket.Server({ server });

console.log('WebSocket server starting...');

let waitingPlayers = []; // Array for players waiting for a match (stores user_id)
const activeConnections = new Map(); // Map of active clients (ws instance -> { ws_id, user_id, opponent_ws_id })
const wsIdToWs = new Map(); // Map from ws_id to ws instance
const userToWsId = new Map(); // Map from user_id to ws_id (if the user is logged in)

const BCRYPT_SALT_ROUNDS = 10; // Salt rounds for bcrypt

// --- Supabase Helper Functions ---

// Helper function to get user data from Supabase
async function getUserData(userId) {
    if (!supabase) return null;
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('user_id', userId)
        .single();

    if (error) {
        console.error(`Error getting user data for ${userId}:`, error.message);
        return null;
    }
    return data;
}

// Helper function to update user data in Supabase
async function updateUserData(userId, updatePayload) {
    if (!supabase) return;

    const updateObject = {};
    if (updatePayload.rate !== undefined) updateObject.rate = updatePayload.rate;
    if (updatePayload.matchHistory !== undefined) updateObject.match_history = updatePayload.matchHistory;
    if (updatePayload.memos !== undefined) updateObject.memos = updatePayload.memos;
    if (updatePayload.battleRecords !== undefined) updateObject.battle_records = updatePayload.battleRecords;
    if (updatePayload.registeredDecks !== undefined) updateObject.registered_decks = updatePayload.registeredDecks;
    if (updatePayload.hasOwnProperty('currentMatchId')) {
        updateObject.current_match_id = updatePayload.currentMatchId;
    }


    if (Object.keys(updateObject).length === 0) {
        console.log(`No fields to update for user ${userId}.`);
        return;
    }

    const { error } = await supabase
        .from('users')
        .update(updateObject)
        .eq('user_id', userId);

    if (error) {
        console.error(`Error updating user data for ${userId}:`, error.message);
        throw error;
    }
}

// Helper function to register a new user in Supabase
async function registerNewUser(userId, username, passwordHash) {
    if (!supabase) throw new Error('Supabase client not configured.');
    const { error } = await supabase
        .from('users')
        .insert([{
            user_id: userId,
            username: username,
            password_hash: passwordHash,
            rate: 1500,
            match_history: [],
            memos: [],
            battle_records: [],
            registered_decks: [],
            current_match_id: null
        }]);

    if (error) {
        console.error('Error registering new user:', error.message);
        throw error;
    }
}

// Helper function to get user ID by username
async function getUserIdByUsername(username) {
    if (!supabase) return null;
    const { data, error } = await supabase
        .from('users')
        .select('user_id')
        .eq('username', username)
        .single();

    if (error && error.code !== 'PGRST116') { // PGRST116: "exact one row not found" (not a critical error)
        console.error(`Error getting user id for ${username}:`, error.message);
    }
    return data ? data.user_id : null;
}

// Helper function to get username by user ID
async function getUsernameByUserId(userId) {
    if (!supabase) return null;
    const { data, error } = await supabase
        .from('users')
        .select('username')
        .eq('user_id', userId)
        .single();

    if (error && error.code !== 'PGRST116') {
        console.error(`Error getting username for ${userId}:`, error.message);
    }
    return data ? data.username : null;
}


// Matching logic
async function tryMatchPlayers() {
    if (waitingPlayers.length >= 2) {
        const player1UserId = waitingPlayers.shift();
        const player2UserId = waitingPlayers.shift();

        const ws1Id = userToWsId.get(player1UserId);
        const ws2Id = userToWsId.get(player2UserId);

        const ws1 = wsIdToWs.get(ws1Id);
        const ws2 = wsIdToWs.get(ws2Id);

        if (ws1 && ws2 && ws1.readyState === WebSocket.OPEN && ws2.readyState === WebSocket.OPEN) {
            const matchId = uuidv4();

            const player1Username = await getUsernameByUserId(player1UserId);
            const player2Username = await getUsernameByUserId(player2UserId);

            activeConnections.get(ws1).opponent_ws_id = ws2Id;
            activeConnections.get(ws2).opponent_ws_id = ws1Id;

            await updateUserData(player1UserId, { currentMatchId: matchId });
            await updateUserData(player2UserId, { currentMatchId: matchId });

            const { error: matchInsertError } = await supabase
                .from('matches')
                .insert([{ match_id: matchId, player1_id: player1UserId, player2_id: player2UserId }]);
            
            if (matchInsertError) {
                console.error('Error inserting new match:', matchInsertError.message);
                waitingPlayers.unshift(player1UserId, player2UserId);
                return;
            }

            ws1.send(JSON.stringify({
                type: 'match_found',
                matchId: matchId,
                opponentUserId: player2UserId,
                opponentUsername: player2Username,
                isInitiator: true
            }));
            console.log(`Matched ${player1UserId} (${player1Username}) with ${player2UserId} (${player2Username}) in match ${matchId}. ${player1UserId} is initiator.`);

            ws2.send(JSON.stringify({
                type: 'match_found',
                matchId: matchId,
                opponentUserId: player1UserId,
                opponentUsername: player1Username,
                isInitiator: false
            }));
            console.log(`Matched ${player2UserId} (${player2Username}) with ${player1UserId} (${player1Username}) in match ${matchId}. ${player2UserId} is not initiator.`);

        } else {
            if (ws1 && ws1.readyState === WebSocket.OPEN) waitingPlayers.unshift(player1UserId);
            if (ws2 && ws2.readyState === WebSocket.OPEN) waitingPlayers.unshift(player2UserId);
            console.log('One or both players disconnected before match could be established. Re-queueing or discarding.');
        }
    }
}

wss.on('connection', ws => {
    const wsId = uuidv4();
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
                    if (dbErr.code === '23505') {
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

                const existingWsIdForUser = userToWsId.get(storedUserData.user_id);
                if (existingWsIdForUser && existingWsIdForUser !== senderInfo.ws_id) {
                    console.log(`User ${loginUsername} is already logged in on another connection (${existingWsIdForUser}). Rejecting new login from ${senderInfo.ws_id}.`);
                    ws.send(JSON.stringify({ type: 'login_response', success: false, message: 'このアカウントは既に他の場所でログインされています。' }));
                    return; 
                }

                senderInfo.user_id = storedUserData.user_id;
                userToWsId.set(storedUserData.user_id, senderInfo.ws_id);
                ws.send(JSON.stringify({
                    type: 'login_response',
                    success: true,
                    message: 'ログインしました！',
                    userId: storedUserData.user_id,
                    username: storedUserData.username,
                    rate: storedUserData.rate,
                    matchHistory: storedUserData.match_history,
                    memos: storedUserData.memos,
                    battleRecords: storedUserData.battle_records,
                    registeredDecks: storedUserData.registered_decks,
                    currentMatchId: storedUserData.current_match_id
                }));
                console.log(`User logged in: ${loginUsername} (${storedUserData.user_id})`);
                break;
            
            case 'auto_login':
                const { userId: autoLoginUserId, username: autoLoginUsername } = data;
                if (!autoLoginUserId || !autoLoginUsername) {
                    ws.send(JSON.stringify({ type: 'auto_login_response', success: false, message: '自動ログイン情報が不足しています。' }));
                    return;
                }
                const autoLoginUserData = await getUserData(autoLoginUserId);
                if (autoLoginUserData && autoLoginUserData.username === autoLoginUsername) {
                    
                    const existingAutoLoginWsId = userToWsId.get(autoLoginUserData.user_id);
                    if (existingAutoLoginWsId && existingAutoLoginWsId !== senderInfo.ws_id) {
                         console.log(`User ${autoLoginUsername} is already logged in on another connection (${existingAutoLoginWsId}). Rejecting new auto-login from ${senderInfo.ws_id}.`);
                         ws.send(JSON.stringify({ type: 'auto_login_response', success: false, message: 'このアカウントは既に他の場所でログインされています。' }));
                         return;
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
                        currentMatchId: autoLoginUserData.current_match_id
                    }));
                    console.log(`User auto-logged in: ${autoLoginUsername} (${autoLoginUserData.user_id})`);
                } else {
                    ws.send(JSON.stringify({ type: 'auto_login_response', success: false, message: '自動ログインに失敗しました。' }));
                }
                break;

            case 'logout':
                if (senderInfo.user_id) {
                    const loggedOutUserId = senderInfo.user_id;
                    userToWsId.delete(senderInfo.user_id);
                    senderInfo.user_id = null;
                    ws.send(JSON.stringify({ type: 'logout_response', success: true, message: 'ログアウトしました。' }));
                    console.log(`User logged out: ${loggedOutUserId}`);
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
                        senderUserId: senderInfo.user_id,
                        signal: data.signal
                    }));
                    console.log(`Relaying WebRTC signal from WS_ID ${senderInfo.ws_id} to WS_ID ${senderInfo.opponent_ws_id}`);
                } else {
                    console.warn(`Opponent WS_ID ${senderInfo.opponent_ws_id} not found or not open.`);
                }
                break;

            case 'update_user_data':
                if (!senderInfo.user_id) {
                    ws.send(JSON.stringify({ type: 'error', message: 'ログインしてください。' }));
                    return;
                }
                try {
                    await updateUserData(senderInfo.user_id, data);
                    const updatedUserData = await getUserData(senderInfo.user_id);
                    ws.send(JSON.stringify({
                        type: 'update_user_data_response',
                        success: true,
                        message: 'ユーザーデータを更新しました。',
                        userData: {
                            userId: updatedUserData.user_id,
                            username: updatedUserData.username,
                            rate: updatedUserData.rate,
                            matchHistory: updatedUserData.match_history,
                            memos: updatedUserData.memos,
                            battleRecords: updatedUserData.battle_records,
                            registeredDecks: updatedUserData.registered_decks,
                            currentMatchId: updatedUserData.current_match_id
                        }
                    }));
                    console.log(`User data updated for ${senderInfo.user_id}`);
                } catch (dbErr) {
                    console.error('Database update error:', dbErr);
                    ws.send(JSON.stringify({ type: 'update_user_data_response', success: false, message: 'データベース更新エラーによりデータを保存できませんでした。' }));
                }
                break;
            
            case 'change_username':
                if (!senderInfo.user_id) {
                    ws.send(JSON.stringify({ type: 'error', message: 'ログインしてください。' }));
                    return;
                }
                const { newUsername } = data;
                if (!newUsername || newUsername.length < 3 || newUsername.length > 15) {
                    ws.send(JSON.stringify({ type: 'change_username_response', success: false, message: 'ユーザー名は3文字以上15文字以下にしてください。' }));
                    return;
                }

                try {
                    const { data: existingUser, error: checkError } = await supabase
                        .from('users')
                        .select('user_id')
                        .eq('username', newUsername)
                        .single();

                    if (checkError && checkError.code !== 'PGRST116') {
                        throw checkError;
                    }

                    if (existingUser && existingUser.user_id !== senderInfo.user_id) {
                        ws.send(JSON.stringify({ type: 'change_username_response', success: false, message: 'そのユーザー名は既に使用されています。' }));
                        return;
                    }

                    const { error: updateError } = await supabase
                        .from('users')
                        .update({ username: newUsername })
                        .eq('user_id', senderInfo.user_id);

                    if (updateError) {
                        throw updateError;
                    }

                    ws.send(JSON.stringify({
                        type: 'change_username_response',
                        success: true,
                        newUsername: newUsername,
                        message: 'ユーザー名を変更しました！'
                    }));
                    console.log(`User ${senderInfo.user_id} changed username to ${newUsername}`);

                } catch (err) {
                    console.error('Error changing username:', err);
                    ws.send(JSON.stringify({ type: 'change_username_response', success: false, message: 'ユーザー名の変更中にエラーが発生しました。' }));
                }
                break;

            case 'report_result':
                const { matchId: reportedMatchId, result: reportedResult } = data;
                if (!senderInfo.user_id || !reportedMatchId || !reportedResult) {
                    ws.send(JSON.stringify({ type: 'report_result_response', success: false, message: '報告情報が不足しています。' }));
                    return;
                }

                try {
                    const { data: match, error: matchError } = await supabase.from('matches').select('*').eq('match_id', reportedMatchId).single();

                    if (matchError || !match) {
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

                    if ((reporterIsPlayer1 && match.player1_report) || (reporterIsPlayer2 && match.player2_report)) {
                        ws.send(JSON.stringify({ type: 'report_result_response', success: false, message: '既に結果を報告済みです。' }));
                        return;
                    }

                    await supabase.from('matches').update({ [updateField]: reportedResult }).eq('match_id', reportedMatchId);
                    console.log(`User ${senderInfo.user_id} reported ${reportedResult} for match ${reportedMatchId}.`);

                    const { data: updatedMatch } = await supabase.from('matches').select('*').eq('match_id', reportedMatchId).single();
                    const opponentReport = updatedMatch[opponentReportField];

                    if (opponentReport) {
                        let myResult = reportedResult;
                        let theirResult = opponentReport;
                        let resolutionMessage = '';

                        const myUserData = await getUserData(senderInfo.user_id);
                        const opponentUserData = await getUserData(opponentId);
                        let myCurrentRate = myUserData.rate;
                        let opponentCurrentRate = opponentUserData.rate;
                        let myNewRate = myCurrentRate;
                        let opponentNewRate = opponentCurrentRate;
                        let myMatchHistory = myUserData.match_history || [];
                        let opponentMatchHistory = opponentUserData.match_history || [];
                        const timestamp = new Date().toLocaleString();

                        if (myResult === 'cancel' && theirResult === 'cancel') {
                            resolutionMessage = 'resolved_cancel';
                            myMatchHistory.unshift(`${timestamp} - 対戦中止`);
                            opponentMatchHistory.unshift(`${timestamp} - 対戦中止`);
                        } else if ((myResult === 'win' && theirResult === 'lose') || (myResult === 'lose' && theirResult === 'win')) {
                            resolutionMessage = 'resolved_consistent';
                            
                            // [MODIFIED] Elo Rating Calculation
                            const K_FACTOR = 32;
                            const myExpectedScore = 1 / (1 + Math.pow(10, (opponentCurrentRate - myCurrentRate) / 400));
                            
                            const myActualScore = (myResult === 'win') ? 1 : 0;
                            
                            const myRateChange = Math.round(K_FACTOR * (myActualScore - myExpectedScore));
                            
                            myNewRate = myCurrentRate + myRateChange;
                            opponentNewRate = opponentCurrentRate - myRateChange; // Zero-sum

                            if (myResult === 'win') {
                                myMatchHistory.unshift(`${timestamp} - 勝利 (レート: ${myCurrentRate} → ${myNewRate})`);
                                opponentMatchHistory.unshift(`${timestamp} - 敗北 (レート: ${opponentCurrentRate} → ${opponentNewRate})`);
                            } else {
                                myMatchHistory.unshift(`${timestamp} - 敗北 (レート: ${myCurrentRate} → ${myNewRate})`);
                                opponentMatchHistory.unshift(`${timestamp} - 勝利 (レート: ${opponentCurrentRate} → ${opponentNewRate})`);
                            }
                        } else {
                            resolutionMessage = 'disputed';
                            myMatchHistory.unshift(`${timestamp} - 結果不一致`);
                            opponentMatchHistory.unshift(`${timestamp} - 結果不一致`);
                        }

                        await supabase.from('matches').update({ resolved_at: new Date().toISOString() }).eq('match_id', reportedMatchId);
                        await updateUserData(senderInfo.user_id, { rate: myNewRate, matchHistory: myMatchHistory, currentMatchId: null });
                        await updateUserData(opponentId, { rate: opponentNewRate, matchHistory: opponentMatchHistory, currentMatchId: null });

                        const responseToReporter = {
                            type: 'report_result_response', success: true,
                            message: `結果が確定しました: ${resolutionMessage === 'resolved_consistent' ? '整合性あり' : (resolutionMessage === 'resolved_cancel' ? '対戦中止' : '結果不一致')}`,
                            result: resolutionMessage, myNewRate: myNewRate, myMatchHistory: myMatchHistory
                        };
                        ws.send(JSON.stringify(responseToReporter));

                        const opponentWsInstance = wsIdToWs.get(userToWsId.get(opponentId));
                        if (opponentWsInstance && opponentWsInstance.readyState === WebSocket.OPEN) {
                            const responseToOpponent = {
                                type: 'report_result_response', success: true,
                                message: `対戦相手が結果を報告しました。結果が確定しました: ${resolutionMessage === 'resolved_consistent' ? '整合性あり' : (resolutionMessage === 'resolved_cancel' ? '対戦中止' : '結果不一致')}`,
                                result: resolutionMessage, myNewRate: opponentNewRate, myMatchHistory: opponentMatchHistory
                            };
                            opponentWsInstance.send(JSON.stringify(responseToOpponent));
                        }
                        console.log(`Match ${reportedMatchId} resolved: ${resolutionMessage}`);

                    } else {
                        ws.send(JSON.stringify({ type: 'report_result_response', success: true, message: '結果を報告しました。相手の報告を待っています。', result: 'pending' }));
                    }

                } catch (reportErr) {
                    console.error('Report result error:', reportErr);
                    ws.send(JSON.stringify({ type: 'report_result_response', success: false, message: '結果報告中にエラーが発生しました。' }));
                }
                break;

            case 'clear_match_info':
                senderInfo.opponent_ws_id = null;
                if (senderInfo.user_id) {
                    await updateUserData(senderInfo.user_id, { currentMatchId: null });
                }
                console.log(`WS_ID ${senderInfo.ws_id} cleared match info.`);
                break;

            case 'get_ranking':
                try {
                    const { data: rankingData, error: rankingError } = await supabase
                        .from('users')
                        .select('username, rate')
                        .order('rate', { ascending: false })
                        .limit(10);

                    if (rankingError) {
                        throw rankingError;
                    }

                    ws.send(JSON.stringify({
                        type: 'ranking_data',
                        success: true,
                        data: rankingData
                    }));
                } catch (err) {
                    console.error('Error fetching ranking:', err);
                    ws.send(JSON.stringify({
                        type: 'ranking_data',
                        success: false,
                        message: 'ランキングの取得に失敗しました。'
                    }));
                }
                break;

            default:
                console.warn(`Unknown message type: ${data.type}`);
        }
    });

    ws.on('close', async () => {
        const senderInfo = activeConnections.get(ws);
        if (senderInfo) {
            console.log(`Client disconnected: WS_ID ${senderInfo.ws_id}.`);
            if (senderInfo.user_id) {
                if (userToWsId.get(senderInfo.user_id) === senderInfo.ws_id) {
                    userToWsId.delete(senderInfo.user_id);
                    console.log(`User ${senderInfo.user_id} removed from active user map.`);
                }
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
