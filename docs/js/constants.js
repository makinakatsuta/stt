/**
 * Sound Table Tennis (STT) Online
 * Client-side Core Logic (Web Audio API, Web Speech API, Canvas, WebSockets)
 *
 * 著作権: © 2026 Maki Nakatsuta. MIT License.
 */

// ==========================================================================
// 1. グローバル設定・定数
// ==========================================================================
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 500;
const PADDLE_WIDTH = 100;
const PADDLE_HEIGHT = 15;
const BALL_RADIUS = 10;
const TABLE_FRICTION = 0.997; // ラリーを維持しやすい摩擦減衰率

// STT コートのY座標定義
const Y_NET = CANVAS_HEIGHT / 2;             // ネット中央 (Y=250)
const Y_DEFENSE_P1 = CANVAS_HEIGHT - 100;     // プレイヤー1(自分)の守備ライン (Y=400)
const Y_DEFENSE_P2 = 100;                    // プレイヤー2(相手)の守備ライン (Y=100)

// ゲーム状態の定数
const STATE_MENU = 'MENU';
const STATE_WAITING_OPPONENT = 'WAITING_OPPONENT';
const STATE_PRE_SERVE_READY = 'PRE_SERVE_READY'; // サーバーの「いきます」待ち
const STATE_PRE_SERVE_HEARD = 'PRE_SERVE_HEARD'; // レシーバーの「はい」待ち
const STATE_SERVE_WAITING = 'SERVE_WAITING';     // サーブ打球待ち
const STATE_RALLY = 'RALLY';                     // ラリー中
const STATE_POINT_WON = 'POINT_WON';             // 得点発生・一時停止

export { CANVAS_WIDTH, CANVAS_HEIGHT, PADDLE_WIDTH, PADDLE_HEIGHT, BALL_RADIUS, TABLE_FRICTION, Y_NET, Y_DEFENSE_P1, Y_DEFENSE_P2, STATE_MENU, STATE_WAITING_OPPONENT, STATE_PRE_SERVE_READY, STATE_PRE_SERVE_HEARD, STATE_SERVE_WAITING, STATE_RALLY, STATE_POINT_WON };
