/*
 * Supabase Migration & Spectator Feature:
 * This file has been updated to use Supabase for user data and to handle
 * WebRTC signaling for the new spectator mode, now fully integrated
 * with the existing authentication and matchmaking logic.
 * Version: Full Integration
 */

const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

// --- Supabase Setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are not set.');
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
console.log('Supabase client initialized.');

// --- Server Setup ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebSocket server with Supabase is running.');
});
const wss = new WebSocket.Server({ server });
console.log('WebSocket server starting...');

// --- In-memory State Management ---
let waitingPlayers = []; // Array for players waiting for a match
const activeConnections = new Map(); // ws -> { ws_id, user_id, opponent_ws_id, lastOffer }
const wsIdToWs = new Map(); // ws_id -> ws
const userToWsId = new Map(); // user_id -> ws_id
const spectateRooms = new Map(); // roomId -> { broadcaster: ws, spectators: Set<ws> }
const BCRYPT_SALT_ROUNDS = 10;

// =================================================================
// HELPER FUNCTIONS (Supabase, etc.)
// =================================================================
async function getUserData(userId) {
    if (!supabase) return null;
    const { data, error } = await supabase.from('users').select('*').eq('user_id', userId).single();
    if (error) {
        console.error(`Error getting user data for ${userId}:`, error.message);
        return null;
    }
    return data;
}

async function updateUserData(userId, updatePayload) {
    if (!supabase) return;
    const updateObject = {};
    if (updatePayload.rate !== undefined) updateObject.rate = updatePayload.rate;
    if (updatePayload.matchHistory !== undefined) updateObject.match_history = updatePayload.matchHistory;
    if (updatePayload.memos !== undefined) updateObject.memos = updatePayload.memos;
    if (updatePayload.battleRecords !== undefined) updateObject.battle_records = updatePayload.battleRecords;
    if (updatePayload.registeredDecks !== undefined) updateObject.registered_decks = updatePayload.registeredDecks;
    if (updatePayload.hasOwnProperty('currentMatchId')) updateObject.current_match_id = updatePayload.currentMatchId;
    if (Object.keys(updateObject).length === 0) return;
    const { error } = await supabase.from('users').update(updateObject).eq('user_id', userId);
    if (error) {
        console.error(`Error updating user data for ${userId}:`, error.message);
        throw error;
    }
}

async function registerNewUser(userId, username, passwordHash) {
    if (!supabase) throw new Error('Supabase client not configured.');
    const { error } = await supabase.from('users').insert([{
        user_id: userId, username: username, password_hash: passwordHash,
        rate: 1500, match_history: [], memos: [], battle_records: [], registered_decks: [], current_match_id: null
    }]);
    if (error) {
        console.error('Error registering new user:', error.message);
        throw error;
    }
}

async function getUserIdByUsername(username) {
    if (!supabase) return null;
    const { data, error } = await supabase.from('users').select('user_id').eq('username', username).single();
    if (error && error.code !== 'PGRST116') console.error(`Error getting user id for ${username}:`, error.message);
    return data ? data.user_id : null;
}

async function getUsernameByUserId(userId) {
    if (!supabase) return null;
    const { data, error } = await supabase.from('users').select('username').eq('user_id', userId).single();
    if (error && error.code !== 'PGRST116') console.error(`Error getting username for ${userId}:`, error.message);
    return data ? data.username : null;
}

async function tryMatchPlayers() {
    if (waitingPlayers.length < 2) return;
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
        const { error: matchInsertError } = await supabase.from('matches').insert([{ match_id: matchId, player1_id: player1UserId, player2_id: player2UserId }]);
        if (matchInsertError) {
            console.error('Error inserting new match:', matchInsertError.message);
            waitingPlayers.unshift(player1UserId, player2UserId);
            return;
        }
        ws1.send(JSON.stringify({ type: 'match_found', matchId, opponentUserId: player2UserId, opponentUsername: player2Username, isInitiator: true }));
        ws2.send(JSON.stringify({ type: 'match_found', matchId, opponentUserId: player1UserId, opponentUsername: player1Username, isInitiator: false }));
        console.log(`Matched ${player1Username} with ${player2Username}`);
    } else {
        if (ws1 && ws1.readyState === WebSocket.OPEN) waitingPlayers.unshift(player1UserId);
        if (ws2 && ws2.readyState === WebSocket.OPEN) waitingPlayers.unshift(player2UserId);
    }
}

// =================================================================
// WEBSOCKET CONNECTION HANDLING
// =================================================================
wss.on('connection', ws => {
    const wsId = uuidv4();
    activeConnections.set(ws, { ws_id: wsId, user_id: null, opponent_ws_id: null, lastOffer: null });
    wsIdToWs.set(wsId, ws);
    console.log(`Client connected: ${wsId}. Total: ${activeConnections.size}`);

    ws.on('message', async message => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error("Failed to parse message:", message);
            return;
        }

        const senderInfo = activeConnections.get(ws);
        if (!senderInfo) return;

        console.log(`Message from WS_ID ${senderInfo.ws_id} (Type: ${data.type})`);

        switch (data.type) {
            // --- User Auth & Data ---
            case 'register':
                const { username: regUsername, password: regPassword } = data;
                if (!regUsername || !regPassword) return ws.send(JSON.stringify({ type: 'register_response', success: false, message: 'ユーザー名とパスワードを入力してください。' }));
                const existingUserId = await getUserIdByUsername(regUsername);
                if (existingUserId) return ws.send(JSON.stringify({ type: 'register_response', success: false, message: 'このユーザー名は既に使われています。' }));
                const hashedPassword = await bcrypt.hash(regPassword, BCRYPT_SALT_ROUNDS);
                const newUserId = uuidv4();
                try {
                    await registerNewUser(newUserId, regUsername, hashedPassword);
                    ws.send(JSON.stringify({ type: 'register_response', success: true, message: 'アカウント登録が完了しました！ログインしてください。' }));
                } catch (dbErr) {
                    ws.send(JSON.stringify({ type: 'register_response', success: false, message: 'データベースエラーにより登録できませんでした。' }));
                }
                break;

            case 'login':
                const { username: loginUsername, password: loginPassword } = data;
                const userIdFromUsername = await getUserIdByUsername(loginUsername);
                if (!userIdFromUsername) return ws.send(JSON.stringify({ type: 'login_response', success: false, message: 'ユーザー名またはパスワードが間違っています。' }));
                const storedUserData = await getUserData(userIdFromUsername);
                if (!storedUserData || !(await bcrypt.compare(loginPassword, storedUserData.password_hash))) {
                    return ws.send(JSON.stringify({ type: 'login_response', success: false, message: 'ユーザー名またはパスワードが間違っています。' }));
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
                break;
            
            case 'auto_login':
                const { userId: autoLoginUserId, username: autoLoginUsername } = data;
                if (!autoLoginUserId || !autoLoginUsername) return ws.send(JSON.stringify({ type: 'auto_login_response', success: false, message: '自動ログイン情報が不足しています。' }));
                const autoLoginUserData = await getUserData(autoLoginUserId);
                if (autoLoginUserData && autoLoginUserData.username === autoLoginUsername) {
                    senderInfo.user_id = autoLoginUserData.user_id;
                    userToWsId.set(autoLoginUserData.user_id, senderInfo.ws_id);
                    ws.send(JSON.stringify({ type: 'auto_login_response', success: true, message: '自動ログインしました！', ...autoLoginUserData }));
                } else {
                    ws.send(JSON.stringify({ type: 'auto_login_response', success: false, message: '自動ログインに失敗しました。' }));
                }
                break;

            case 'logout':
                if (senderInfo.user_id) {
                    userToWsId.delete(senderInfo.user_id);
                    senderInfo.user_id = null;
                    ws.send(JSON.stringify({ type: 'logout_response', success: true, message: 'ログアウトしました。' }));
                }
                break;

            case 'update_user_data':
                if (!senderInfo.user_id) return ws.send(JSON.stringify({ type: 'error', message: 'ログインしてください。' }));
                try {
                    await updateUserData(senderInfo.user_id, data);
                    const updatedUserData = await getUserData(senderInfo.user_id);
                    ws.send(JSON.stringify({ type: 'update_user_data_response', success: true, message: 'ユーザーデータを更新しました。', userData: updatedUserData }));
                } catch (dbErr) {
                    ws.send(JSON.stringify({ type: 'update_user_data_response', success: false, message: 'データベース更新エラー。' }));
                }
                break;

            // --- Matchmaking ---
            case 'join_queue':
                if (!senderInfo.user_id) return ws.send(JSON.stringify({ type: 'error', message: 'ログインしてください。' }));
                if (!waitingPlayers.includes(senderInfo.user_id)) {
                    waitingPlayers.push(senderInfo.user_id);
                    ws.send(JSON.stringify({ type: 'queue_status', message: '対戦相手を検索中です...' }));
                    tryMatchPlayers();
                }
                break;

            case 'leave_queue':
                waitingPlayers = waitingPlayers.filter(id => id !== senderInfo.user_id);
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

            // --- Spectator Mode Cases ---
            case 'start_broadcast':
                const roomId = `room_${uuidv4().substring(0, 8)}`;
                spectateRooms.set(roomId, { broadcaster: ws, spectators: new Set() });
                console.log(`Room created: ${roomId} by ${senderInfo.ws_id}`);
                ws.send(JSON.stringify({ type: 'broadcast_started', roomId: roomId }));
                break;

            case 'stop_broadcast':
                if (spectateRooms.has(data.roomId)) {
                    spectateRooms.get(data.roomId).spectators.forEach(spectatorWs => {
                        if (spectatorWs.readyState === WebSocket.OPEN) {
                            spectatorWs.send(JSON.stringify({ type: 'broadcast_stopped', roomId: data.roomId }));
                        }
                    });
                    spectateRooms.delete(data.roomId);
                    console.log(`Room closed: ${data.roomId}`);
                }
                break;

            case 'join_spectate_room':
                const roomToJoin = spectateRooms.get(data.roomId);
                if (roomToJoin) {
                    roomToJoin.spectators.add(ws);
                    console.log(`${senderInfo.ws_id} joined room ${data.roomId}`);
                    const broadcasterWs = roomToJoin.broadcaster;
                    const broadcasterInfo = activeConnections.get(broadcasterWs);
                    if(broadcasterInfo && broadcasterInfo.lastOffer) {
                         ws.send(JSON.stringify({
                            type: 'spectate_signal',
                            roomId: data.roomId,
                            signal: { offer: broadcasterInfo.lastOffer }
                        }));
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: '指定された観戦ルームが見つかりません。' }));
                }
                break;
            
            case 'leave_spectate_room':
                 const roomToLeave = spectateRooms.get(data.roomId);
                 if (roomToLeave) {
                     roomToLeave.spectators.delete(ws);
                     console.log(`${senderInfo.ws_id} left room ${data.roomId}`);
                 }
                 break;

            case 'spectate_signal':
                const room = spectateRooms.get(data.roomId);
                if (!room) break;
                
                if (ws === room.broadcaster) { // 配信者からのシグナル
                    if(data.signal.offer) { // Offerを保存
                        activeConnections.get(ws).lastOffer = data.signal.offer;
                    }
                    room.spectators.forEach(spectatorWs => {
                        if (spectatorWs.readyState === WebSocket.OPEN) {
                            spectatorWs.send(JSON.stringify({ type: 'spectate_signal', roomId: data.roomId, signal: data.signal }));
                        }
                    });
                } 
                else if (room.spectators.has(ws)) { // 視聴者からのシグナル
                    if (room.broadcaster.readyState === WebSocket.OPEN) {
                        room.broadcaster.send(JSON.stringify({ type: 'spectate_signal', roomId: data.roomId, signal: data.signal }));
                    }
                }
                break;

            default:
                console.warn(`Unknown message type: ${data.type}`);
        }
    });

    ws.on('close', () => {
        const senderInfo = activeConnections.get(ws);
        if (!senderInfo) return;

        // 観戦ルームから退出させる
        spectateRooms.forEach((room, roomId) => {
            if (ws === room.broadcaster) {
                console.log(`Broadcaster for room ${roomId} disconnected. Closing room.`);
                room.spectators.forEach(sWs => {
                    if (sWs.readyState === WebSocket.OPEN) {
                        sWs.send(JSON.stringify({ type: 'broadcast_stopped', roomId }));
                    }
                });
                spectateRooms.delete(roomId);
            } else if (room.spectators.has(ws)) {
                console.log(`Spectator disconnected from room ${roomId}.`);
                room.spectators.delete(ws);
            }
        });

        // 既存の切断処理
        if (senderInfo.user_id) {
            if (userToWsId.get(senderInfo.user_id) === senderInfo.ws_id) {
                userToWsId.delete(senderInfo.user_id);
            }
            waitingPlayers = waitingPlayers.filter(id => id !== senderInfo.user_id);
        }
        activeConnections.delete(ws);
        wsIdToWs.delete(senderInfo.ws_id);
        console.log(`Client disconnected: ${senderInfo.ws_id}. Total: ${activeConnections.size}`);
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error:`, error);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
