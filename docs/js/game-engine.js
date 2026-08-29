import { CANVAS_WIDTH, CANVAS_HEIGHT, PADDLE_WIDTH, PADDLE_HEIGHT, BALL_RADIUS, TABLE_FRICTION, Y_NET, Y_DEFENSE_P1, Y_DEFENSE_P2, STATE_MENU, STATE_WAITING_OPPONENT, STATE_PRE_SERVE_READY, STATE_PRE_SERVE_HEARD, STATE_SERVE_WAITING, STATE_RALLY, STATE_POINT_WON } from './constants.js';
import { sounds } from './sound-system.js';
import { narrator } from './speech-system.js';
import { NetworkSystem } from './network-system.js';

const EASY_RALLY_SPEED_FACTOR = 0.8;
// Normal is the standard reference. Hard makes the player's timing and
// movement 10% less forgiving than Normal.
const NORMAL_PADDLE_SPEED = 8;
const HARD_DIFFICULTY_FACTOR = 0.9;
const NORMAL_HIT_ZONE = 90;
const NORMAL_PADDLE_MARGIN = 35;
const NORMAL_OUT_SPEED = 13;
// At 60 FPS with TABLE_FRICTION, this range crosses the 300 px court in
// roughly 5-6 seconds. Easy serves deliberately drift left or right.
const EASY_SERVE_VY_MIN = 1.35;
const EASY_SERVE_VY_MAX = 1.45;
const EASY_SERVE_VX_MIN = 0.65;
const EASY_SERVE_VX_MAX = 0.85;

export class GameEngine {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.ctx = this.canvas.getContext('2d');

    // UIの切り替え用エレメント取得
    this.screens = {
      welcome: document.getElementById('screen-welcome'),
      menu: document.getElementById('screen-menu'),
      difficulty: document.getElementById('screen-difficulty'),
      lobby: document.getElementById('screen-lobby'),
      waiting: document.getElementById('screen-waiting'),
      play: document.getElementById('screen-play'),
      help: document.getElementById('screen-help')
    };

    // ゲームモード、難易度と役割
    this.mode = 'cpu'; // 'cpu' or 'online'
    this.difficulty = 'normal'; // 'easy' or 'normal' or 'hard'
    this.role = 1;      // 1: Player 1 (手前 / サーバー), 2: Player 2 (奥 / レシーバー)
    this.state = STATE_MENU;

    // ゲームオブジェクトのステート
    // Kept for compatibility with a previously cached WASM binary. The
    // current game logic does not use this value to guarantee any rally.
    this.ball = { x: 400, y: 250, vx: 0, vy: 0, active: false, easyPlayerReturns: 0 };
    this.endFrameHits = 0;
    this.p1 = { x: 350, y: Y_DEFENSE_P1 + 50 }; // 手前 (自分)
    this.p2 = { x: 350, y: Y_DEFENSE_P2 - 50 }; // 奥 (相手 / CPU)

    // 得点とゲーム設定
    this.scores = { p1: 0, p2: 0 };
    this.gameScores = { p1: 0, p2: 0 }; // 各ゲームの獲得数
    this.serverRole = 1; // 現在のサーバー (1 or 2)
    this.matchGames = 3; // 3ゲームマッチ、2ゲーム先取を維持
    this.maxScore = 11;  // 11点先取

    // タイムアウト管理 (公式5秒ルールなどのチェック用)
    this.stateStartTime = 0;
    this.timerInterval = null;

    // Feature #2, #4: チャージサーブおよびインターバルスキップ用の状態管理変数
    this.chargeStartTime = 0;
    this.isCharging = false;
    this.intervalSkipCallback = null;

    // キー入力状態
    this.keys = {
      ArrowLeft: false,
      ArrowRight: false
    };
    this.lastMyPaddleX = 350;
    this.lastFootstepTime = 0;
    this.wasInCenter = false;
    // 少し早めに押した返球入力を、次の物理フレームまで保持する。
    this.pendingSwingUntil = 0;

    // 描画演出用のエフェクト配列 (波紋など)
    this.ripples = [];

    // ネットワーク初期化
    this.net = new NetworkSystem((msg) => this.handleNetworkMessage(msg));
    this.net.onDisconnect = () => this.handleNetworkDisconnect();
    this.net.onError = () => this.handleNetworkError();

    // オンライン対戦時の遅延によるフライング得点防止用のタイマー
    this.pendingScoreTimeout = null;

    // モバイル・アクセシビリティ対応用変数
    this.isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
      || ('ontouchstart' in window)
      || (navigator.maxTouchPoints > 0);
    this.useTilt = false;
    // 加速度センサー（DeviceMotion）による体移動操作
    this.motionAccelX = 0;       // 現在の横方向加速度 (m/s²)
    this.motionSpeed = 0;        // 正規化されたラケット速度 (0.0〜1.0)
    this.tiltSpeed = 0;          // updatePhysics で参照する速度 (互換性維持)
    this.handleMotionBound = null;

    // 戻る確認ダイアログ表示中は、ゲームを完全に停止する
    this.isGameplayPaused = false;
    this.gameplayPausedAt = 0;


    // イベントリスナーのバインド
    this.setupEventListeners();
  }

  /**
   * HTML上の各種ボタンにイベントをバインドします。
   */
  setupEventListeners() {
    // モバイル用設定パネルの表示制御とARIALabel初期化
    if (this.isMobile) {
      const panel = document.getElementById('mobile-settings-panel');
      if (panel) panel.classList.remove('hidden');
    }
    this.updateCanvasAriaLabel();

    // Feature #8: 音声速度設定スライダーのバインド＆初期化
    const rangeSpeechRate = document.getElementById('range-speech-rate');
    const lblSpeechRateVal = document.getElementById('lbl-speech-rate-val');
    if (rangeSpeechRate && lblSpeechRateVal) {
      const savedRate = localStorage.getItem('stt_speech_rate') || '1.2';
      rangeSpeechRate.value = savedRate;
      lblSpeechRateVal.textContent = savedRate;
      narrator.speechRate = parseFloat(savedRate);

      rangeSpeechRate.addEventListener('input', (e) => {
        const rate = e.target.value;
        lblSpeechRateVal.textContent = rate;
        narrator.setSpeechRate(parseFloat(rate));
      });
    }

    // 体移動操作切り替えチェックボックスの変更監視 (Feature #17: 保存)
    const useTiltCheckbox = document.getElementById('chk-use-tilt');
    if (useTiltCheckbox) {
      useTiltCheckbox.addEventListener('change', (e) => {
        localStorage.setItem('stt_use_tilt', e.target.checked);
        if (e.target.checked) {
          this.requestDeviceMotionPermission();
        } else {
          this.useTilt = false;
          // DeviceMotion リスナーを解除
          if (this.handleMotionBound) {
            window.removeEventListener('devicemotion', this.handleMotionBound);
            this.handleMotionBound = null;
          }
          // キー状態のクリア
          this.keys['ArrowLeft'] = false;
          this.keys['ArrowRight'] = false;
          this.keys['KeyA'] = false;
          this.keys['KeyD'] = false;
          this.motionSpeed = 0;
          this.tiltSpeed = 0;
          document.getElementById('btn-calibrate-tilt').classList.add('hidden');
          this.updateCanvasAriaLabel();
        }
      });
    }

    // ラケット位置リセットボタンのクリック
    const btnCalibrate = document.getElementById('btn-calibrate-tilt');
    if (btnCalibrate) {
      btnCalibrate.addEventListener('click', () => {
        this.resetPaddlePosition();
        narrator.speak("ラケット位置を中央にリセットしました。");
      });
    }

    // ゲーム画面タップによるアクション (スマホ・アクセシビリティ対応)
    // canvas-container だけでなく screen-play 全体をタップ対象にして、
    // プレーに集中できるよう画面のどこをタップ/ダブルタップしてもアクションを実行できるようにする
    const screenPlay = document.getElementById('screen-play');
    const canvasContainer = document.getElementById('canvas-container');
    // Do not treat a swipe/drag used for movement as a swing on touchend.
    let touchStartPoint = null;
    let pointerStartPoint = null;
    // Pointer events provide one authoritative tap path and prevent the
    // touchend + synthetic click pair from being interpreted twice.
    const pointerExcludedTags = ['BUTTON', 'A', 'INPUT', 'LABEL', 'SELECT', 'TEXTAREA'];
    const pointerActiveStates = [STATE_PRE_SERVE_READY, STATE_PRE_SERVE_HEARD, STATE_SERVE_WAITING, STATE_RALLY, STATE_POINT_WON];

    if (canvasContainer) {
      canvasContainer.style.touchAction = 'none';
      canvasContainer.addEventListener('pointerdown', (e) => {
        if (this.isGameplayPaused || !e.isPrimary || pointerExcludedTags.includes(e.target.tagName)) return;
        pointerStartPoint = { id: e.pointerId, x: e.clientX, y: e.clientY };
        if (this.state === STATE_SERVE_WAITING && this.isMyTurnToServe()) {
          e.preventDefault();
          this.isCharging = true;
          this.chargeStartTime = Date.now();
        }
      }, { passive: false });

      canvasContainer.addEventListener('pointerup', (e) => {
        if (this.isGameplayPaused || !e.isPrimary || !pointerStartPoint || pointerStartPoint.id !== e.pointerId) return;
        const start = pointerStartPoint;
        pointerStartPoint = null;
        if (pointerExcludedTags.includes(e.target.tagName)) return;
        const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y) > 12;
        if (moved || !pointerActiveStates.includes(this.state)) return;
        e.preventDefault();
        this.handleActionInput();
      }, { passive: false });

      canvasContainer.addEventListener('pointercancel', () => {
        pointerStartPoint = null;
        this.isCharging = false;
      }, { passive: true });
    }

    // プレイ画面全体のタップハンドラ (アクションボタン類は除外)
    const handlePlayAreaAction = (e) => {
      if (window.PointerEvent) return;
      if (this.isGameplayPaused) return;
      const activeStates = [STATE_PRE_SERVE_READY, STATE_PRE_SERVE_HEARD, STATE_SERVE_WAITING, STATE_RALLY, STATE_POINT_WON];
      if (!activeStates.includes(this.state)) return;

      // ボタン・リンク・input 要素のクリックは除外する（誤爆防止）
      const excluded = ['BUTTON', 'A', 'INPUT', 'LABEL', 'SELECT', 'TEXTAREA'];
      if (excluded.includes(e.target.tagName)) return;

      e.preventDefault();
      this.handleActionInput();
    };

    // PC/タブレット向けのクリックイベント（画面全体）
    document.addEventListener('click', handlePlayAreaAction);

    // スマホ向けのタッチイベント（touchend で click より早く応答）(Feature #4: STATE_POINT_WON を追加)
    document.addEventListener('touchend', (e) => {
      if (window.PointerEvent) return;
      if (this.isGameplayPaused) return;
      const activeStates = [STATE_PRE_SERVE_READY, STATE_PRE_SERVE_HEARD, STATE_SERVE_WAITING, STATE_RALLY, STATE_POINT_WON];
      if (!activeStates.includes(this.state)) return;

      const excluded = ['BUTTON', 'A', 'INPUT', 'LABEL', 'SELECT', 'TEXTAREA'];
      if (excluded.includes(e.target.tagName)) return;

      e.preventDefault(); // 300ms の click 遅延と二重発火を防ぐ
      const touch = e.changedTouches && e.changedTouches[0];
      const moved = touchStartPoint && touch
        ? Math.hypot(touch.clientX - touchStartPoint.x, touch.clientY - touchStartPoint.y) > 12
        : false;
      touchStartPoint = null;
      if (moved) return;

      this.handleActionInput();
    }, { passive: false });

    document.addEventListener('touchcancel', () => {
      touchStartPoint = null;
    }, { passive: true });

    // スマホ用のtouchstartでチャージ開始 (Feature #2)
    document.addEventListener('touchstart', (e) => {
      if (window.PointerEvent) return;
      if (this.isGameplayPaused) return;
      const activeStates = [STATE_SERVE_WAITING];

      const excluded = ['BUTTON', 'A', 'INPUT', 'LABEL', 'SELECT', 'TEXTAREA'];
      if (excluded.includes(e.target.tagName)) return;

      const touch = e.touches && e.touches[0];
      touchStartPoint = touch ? { x: touch.clientX, y: touch.clientY } : null;
      if (!activeStates.includes(this.state)) return;

      if (this.state === STATE_SERVE_WAITING && this.isMyTurnToServe()) {
        e.preventDefault();
        this.isCharging = true;
        this.chargeStartTime = Date.now();
      }
    }, { passive: false });

    // 1. オーディオ有効化ボタン
    const btnEnableAudio = document.getElementById('btn-enable-audio');
    if (btnEnableAudio) btnEnableAudio.addEventListener('click', () => {
      try {
        sounds.init();
      } catch (error) {
        // Audio failure must not prevent the game menu from opening.
        console.warn('Audio initialization skipped:', error);
      }

      // Feature #17: 設定から体移動操作設定を復元
      const useTiltCheckbox = document.getElementById('chk-use-tilt');
      if (useTiltCheckbox) {
        const savedTilt = localStorage.getItem('stt_use_tilt') === 'true';
        useTiltCheckbox.checked = savedTilt;
        // changeイベントをディスパッチして状態を適用させる
        useTiltCheckbox.dispatchEvent(new Event('change'));
      }

      const useTilt = useTiltCheckbox ? useTiltCheckbox.checked : false;
      if (this.isMobile && useTilt) {
        this.requestDeviceMotionPermission();
      }

      this.changeScreen('menu');
      narrator.speak("サウンドテーブルテニスへようこそ。モードを選択してください。");
    });

    // 2. モード選択: CPU戦 (難易度画面へ遷移)
    document.getElementById('btn-mode-cpu').addEventListener('click', () => {
      this.mode = 'cpu';
      this.role = 1; // CPU戦では自分が常にPlayer 1 (手前)
      this.changeScreen('difficulty');
      narrator.speak("CPUの難易度を選択してください。簡単、普通、難しいから選べます。");
    });

    // 2.5 難易度選択ボタン (Feature #17: 選択した難易度を保存)
    document.getElementById('btn-diff-easy').addEventListener('click', () => {
      this.difficulty = 'easy';
      localStorage.setItem('stt_last_difficulty', 'easy');
      this.startNewMatch();
    });
    document.getElementById('btn-diff-normal').addEventListener('click', () => {
      this.difficulty = 'normal';
      localStorage.setItem('stt_last_difficulty', 'normal');
      this.startNewMatch();
    });
    document.getElementById('btn-diff-hard').addEventListener('click', () => {
      this.difficulty = 'hard';
      localStorage.setItem('stt_last_difficulty', 'hard');
      this.startNewMatch();
    });
    document.getElementById('btn-difficulty-back').addEventListener('click', () => {
      this.changeScreen('menu');
    });

    // 3. モード選択: オンライン戦 (Feature #17: サーバーアドレスの復元)
    // 3. モード選択: オンライン対戦 — 🚧 工事中 (500 Internal Error)
    const btnOnline = document.getElementById('btn-mode-online');
    if (btnOnline) {
      // ボタンを視覚的に無効化 (disabled 属性は付けず aria-disabled で管理)
      btnOnline.setAttribute('aria-disabled', 'true');
      btnOnline.setAttribute('title', '現在このモードは工事中です (500)');
      btnOnline.style.opacity = '0.4';
      btnOnline.style.cursor = 'not-allowed';
      btnOnline.style.filter = 'grayscale(80%)';

      btnOnline.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // 500 Internal Error ダイアログを表示
        narrator.speak("500 インターナルエラー。オンライン対戦は現在工事中です。しばらくお待ちください。");

        // 既存のエラーオーバーレイがあれば再利用、なければ生成
        let overlay = document.getElementById('error-overlay-500');
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = 'error-overlay-500';
          overlay.setAttribute('role', 'alertdialog');
          overlay.setAttribute('aria-modal', 'true');
          overlay.setAttribute('aria-labelledby', 'error-overlay-500-title');
          overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:9999',
            'display:flex', 'align-items:center', 'justify-content:center',
            'background:rgba(0,0,0,0.75)', 'backdrop-filter:blur(4px)',
          ].join(';');

          overlay.innerHTML = `
            <div style="
              background:#1a1a2e;
              border:2px solid #ff4444;
              border-radius:12px;
              padding:2rem 2.5rem;
              max-width:420px;
              width:90%;
              text-align:center;
              color:#fff;
              font-family:inherit;
              box-shadow:0 0 40px rgba(255,68,68,0.4);
            ">
              <div style="font-size:3rem;margin-bottom:0.5rem;">🚧</div>
              <h2 id="error-overlay-500-title" style="
                color:#ff4444;
                font-size:1.4rem;
                margin:0 0 0.5rem;
                letter-spacing:1px;
              ">500 Internal Error</h2>
              <p style="margin:0 0 0.4rem;font-size:0.95rem;color:#ccc;">
                オンライン対戦は現在 <strong style="color:#ffaa00;">工事中</strong> です。
              </p>
              <p style="margin:0 0 1.5rem;font-size:0.8rem;color:#888;">
                This feature is temporarily unavailable.<br>Please check back later.
              </p>
              <button id="error-overlay-500-close" style="
                background:#ff4444;
                color:#fff;
                border:none;
                border-radius:8px;
                padding:0.6rem 2rem;
                font-size:1rem;
                cursor:pointer;
                font-family:inherit;
              ">閉じる</button>
            </div>
          `;

          document.body.appendChild(overlay);

          // 閉じるボタン
          overlay.querySelector('#error-overlay-500-close').addEventListener('click', () => {
            overlay.style.display = 'none';
          });
          // オーバーレイ背景クリックでも閉じる
          overlay.addEventListener('click', (ev) => {
            if (ev.target === overlay) overlay.style.display = 'none';
          });
          // Escキーでも閉じる
          document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && overlay.style.display !== 'none') {
              overlay.style.display = 'none';
            }
          });
        } else {
          overlay.style.display = 'flex';
        }

        // フォーカスを閉じるボタンに移す（アクセシビリティ）
        setTimeout(() => {
          const closeBtn = document.getElementById('error-overlay-500-close');
          if (closeBtn) closeBtn.focus();
        }, 50);
      });
    }

    // 4. ロビー: 接続開始
    document.getElementById('btn-join-room').addEventListener('click', () => {
      const roomId = document.getElementById('input-room-id').value.trim();
      const serverAddrEl = document.getElementById('input-server-addr');
      const serverAddr = serverAddrEl ? serverAddrEl.value.trim() : '';

      // Feature #17: 接続時にもアドレス保存
      if (serverAddr) {
        localStorage.setItem('stt_server_addr', serverAddr);
      }

      this.changeScreen('waiting');
      this.state = STATE_WAITING_OPPONENT;
      document.getElementById('lbl-current-room').textContent = roomId || '自動マッチング';
      this.net.disconnectHandled = false;
      this.clearNetworkError();
      narrator.speak("サーバーに接続しています。対戦相手を待っています。");
      this.net.connect(roomId, serverAddr);
    });

    // 5. ロビーから戻る
    document.getElementById('btn-lobby-back').addEventListener('click', () => {
      this.changeScreen('menu');
    });

    // 6. マッチングキャンセル
    document.getElementById('btn-cancel-matching').addEventListener('click', () => {
      this.net.disconnect();
      this.changeScreen('menu');
    });

    // 7. ヘルプ画面の開閉
    document.getElementById('btn-show-help').addEventListener('click', () => {
      this.changeScreen('help');
      narrator.speak("操作方法とルール説明です。読み上げが終わったら、エスケープキーまたはメニューに戻るボタンで戻れます。");
    });
    document.getElementById('btn-close-help').addEventListener('click', () => {
      this.changeScreen('menu');
    });

    // 8. ゲームプレイ中断（確認ダイアログを表示）
    document.getElementById('btn-quit-game').addEventListener('click', () => {
      this.showQuitConfirmation();
    });
    document.getElementById('btn-confirm-quit').addEventListener('click', () => {
      this.confirmQuitGame();
    });
    document.getElementById('btn-cancel-quit').addEventListener('click', () => {
      this.resumeGameplay();
    });

    // キーボード入力の監視 (Feature #2: スペースキー長押しによるサーブチャージ)
    window.addEventListener('keydown', (e) => {
      if (this.isGameplayPaused) {
        e.preventDefault();
        return;
      }

      // プレイ中は矢印キーのデフォルト挙動 (スクロール) を防止して連打・長押しを円滑にする
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code) || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        if (this.state !== STATE_MENU) {
          e.preventDefault();
        }
      }

      this.keys[e.code] = true;

      // スペースキーによるアクション制御 (スクロール防止)
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) {
          if (this.state === STATE_SERVE_WAITING && this.isMyTurnToServe()) {
            // サーブチャージ開始
            this.isCharging = true;
            this.chargeStartTime = Date.now();
          } else {
            this.handleActionInput();
          }
        }
      }

      // Escキーによる中断
      if (e.code === 'Escape') {
        if (this.state !== STATE_MENU) {
          this.showQuitConfirmation();
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      if (this.isGameplayPaused) return;
      this.keys[e.code] = false;

      if (e.code === 'Space') {
        if (this.isCharging) {
          // チャージ完了でサーブ実行
          this.handleActionInput();
        }
      }
    });

    // Canvasへのフォーカス制御 (矢印キーでのブラウザスクロール防止)
    this.canvas.addEventListener('keydown', (e) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
      }
    });

    // タブ切り替え・画面非表示時のチャージ状態リセット
    // （Alt+Tab等で keyup が発火しないまま isCharging が残るケースを防ぐ）
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.isCharging) {
        this.isCharging = false;
      }
    });
  }

  /**
   * 表示画面を切り替えます。
   * @param {string} screenId 画面ID ('welcome', 'menu', 'lobby', 'waiting', 'play', 'help')
   */
  changeScreen(screenId) {
    Object.keys(this.screens).forEach(key => {
      if (key === screenId) {
        this.screens[key].classList.remove('hidden');
        // フォーカスを適切な要素に移す
        const focusable = this.screens[key].querySelector('button, input, [tabindex="0"]');
        if (focusable) focusable.focus();
      } else {
        this.screens[key].classList.add('hidden');
      }
    });

    // 状態を同期
    if (screenId === 'menu') this.state = STATE_MENU;
  }

  /**
   * ゲームを安全に終了し、メニューに戻ります。
   */
  quitGame() {
    this.isGameplayPaused = false;
    this.net.disconnect();
    this.state = STATE_MENU;
    this.stopLoop(); // アニメーションループを確実に停止
    sounds.updateBallSound(400, 250, 0, 0); // 音を止める
    sounds.stopRallyMusic();
    narrator.stop();
    this.changeScreen('menu');

    // チルト調整ボタンを非表示化、キーのクリア
    const btnCalibrate = document.getElementById('btn-calibrate-tilt');
    if (btnCalibrate) btnCalibrate.classList.add('hidden');
    this.keys['ArrowLeft'] = false;
    this.keys['ArrowRight'] = false;
    this.keys['KeyA'] = false;
    this.keys['KeyD'] = false;
    this.motionSpeed = 0;
    this.tiltSpeed = 0;
    this.updateCanvasAriaLabel();

    // play-instructions を元の表示状態に戻す (次回プレイ開始まで非表示のまま)
    const instrEl = document.getElementById('play-instructions');
    if (instrEl) instrEl.classList.remove('hidden');


    narrator.speak("ゲームを終了し、メニューに戻りました。");
  }

  /**
   * 戻る確認を表示し、確認中のゲーム処理・音響・入力を停止します。
   */
  showQuitConfirmation() {
    if (this.isGameplayPaused || this.screens.play.classList.contains('hidden')) return;

    this.isGameplayPaused = true;
    this.gameplayPausedAt = Date.now();
    this.stopLoop();
    this.isCharging = false;
    this.keys['ArrowLeft'] = false;
    this.keys['ArrowRight'] = false;
    this.keys['KeyA'] = false;
    this.keys['KeyD'] = false;
    this.motionSpeed = 0;
    this.tiltSpeed = 0;
    sounds.updateBallSound(this.ball.x, this.ball.y, 0, 0);

    const overlay = document.getElementById('quit-confirm-overlay');
    overlay.classList.remove('hidden');
    narrator.speak("プレイを停止しました。メニューに戻りますか？ OKで戻る、キャンセルでプレイを再開します。", true);
    document.getElementById('btn-confirm-quit').focus();
  }

  /**
   * 戻る確認を取り消し、停止時点のゲーム状態から再開します。
   */
  resumeGameplay() {
    if (!this.isGameplayPaused) return;

    const pausedDuration = Date.now() - this.gameplayPausedAt;
    this.stateStartTime += pausedDuration;
    this.isGameplayPaused = false;
    this.gameplayPausedAt = 0;
    document.getElementById('quit-confirm-overlay').classList.add('hidden');
    this.startLoop();
    this.canvas.focus();
    narrator.speak("プレイを再開しました。");
  }

  /**
   * 戻る確認を確定し、ゲームを終了します。
   */
  confirmQuitGame() {
    document.getElementById('quit-confirm-overlay').classList.add('hidden');
    this.quitGame();
  }

  handleNetworkDisconnect() {
    // 改善②: onerror → onclose の二重発火によるダブル quitGame を防ぐ
    if (this.net.disconnectHandled) return;
    this.net.disconnectHandled = true;

    // プレイ中や待機中に予期せず切断された場合
    if (this.state === STATE_WAITING_OPPONENT || this.state === STATE_RALLY || this.state === STATE_PRE_SERVE_READY || this.state === STATE_PRE_SERVE_HEARD || this.state === STATE_SERVE_WAITING) {
      const msg = "サーバーから切断されました。\nメインメニューに戻ります。";
      narrator.speak(msg.replace('\n', ''), true);
      // 改善①③: 視覚的エラーメッセージとカウントダウンを表示（5秒）
      this.showNetworkError(msg, 5, () => this.quitGame());
    }
  }

  handleNetworkError() {
    // 改善②: onerror → onclose の二重発火によるダブル quitGame を防ぐ
    if (this.net.disconnectHandled) return;
    this.net.disconnectHandled = true;

    const msg = "サーバーへの接続に失敗しました。\n・stt.exe が起動しているか確認してください。\n・スマホからアクセスする場合はPCと同じWi-Fiに接続してください。";
    narrator.speak("サーバーへの接続に失敗しました。実行ファイルが起動しているか確認してください。", true);
    // 改善①③: 視覚的エラーメッセージとカウントダウンを表示（5秒）
    this.showNetworkError(msg, 5, () => this.quitGame());
  }

  /**
   * 改善①: 待機画面にネットワークエラーメッセージとカウントダウンを視覚的に表示します。
   * @param {string} message 表示するエラーメッセージ (\n で改行)
   * @param {number} countdownSec カウントダウン秒数
   * @param {Function} onComplete カウントダウン終了後に呼ぶコールバック
   */
  showNetworkError(message, countdownSec, onComplete) {
    const box = document.getElementById('network-error-box');
    const msgEl = document.getElementById('network-error-message');
    const cntEl = document.getElementById('network-error-countdown');
    const spinner = document.getElementById('waiting-spinner');

    if (!box || !msgEl || !cntEl) {
      // HTML要素がない場合は即コールバック
      setTimeout(onComplete, countdownSec * 1000);
      return;
    }

    // スピナーをエラー状態にする
    if (spinner) spinner.classList.add('spinner-error');

    // メッセージを表示
    msgEl.innerHTML = message.replace(/\n/g, '<br>');
    box.classList.remove('hidden');

    // カウントダウン
    let remaining = countdownSec;
    cntEl.textContent = `${remaining} 秒後にメニューに戻ります...`;

    const tick = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(tick);
        cntEl.textContent = 'メニューに戻ります...';
        onComplete();
      } else {
        cntEl.textContent = `${remaining} 秒後にメニューに戻ります...`;
      }
    }, 1000);
  }

  /**
   * 改善①: エラーボックスをリセット・非表示にします。
   */
  clearNetworkError() {
    const box = document.getElementById('network-error-box');
    const spinner = document.getElementById('waiting-spinner');
    if (box) box.classList.add('hidden');
    if (spinner) spinner.classList.remove('spinner-error');
  }

  // ==========================================================================
  // 6. オンライン通信メッセージ処理
  // ==========================================================================
  handleNetworkMessage(msg) {
    switch (msg.type) {
      case 'init':
        // 役割の確定 (1: 手前 / 2: 奥)
        this.role = msg.payload.role;
        // サーバーが割り当てたIDを保存（再接続時にサーバー側と照合するために使用）
        if (msg.payload.id) {
          this.net.clientId = msg.payload.id;
        }
        console.log(`Your assigned role is Player ${this.role}`);
        break;

      case 'opponent_joined':
        // 対戦相手が揃った
        narrator.speak("対戦相手が接続しました。まもなく試合を開始します。");
        setTimeout(() => {
          this.startNewMatch();
        }, 2000);
        break;

      case 'opponent_left':
        // 対戦相手が切断
        narrator.speak("対戦相手が切断されました。ゲームを終了します。");
        setTimeout(() => {
          this.quitGame();
        }, 3000);
        break;

      case 'action':
        this.handleOpponentAction(msg.payload);
        break;

      case 'error': {
        // サーバーからのエラー（ルーム満員など）をカウントダウン付きで表示
        const errMsg = (msg.payload && msg.payload.message) ? msg.payload.message : 'サーバーエラーが発生しました。';
        const localizedMsg = errMsg === 'Room is full'
          ? 'このルームはすでに満員です（2名まで）。\n別のルームIDを試してください。'
          : errMsg;
        narrator.speak(localizedMsg.replace(/\n/g, ''), true);
        this.showNetworkError(localizedMsg, 5, () => this.quitGame());
        break;
      }
    }
  }

  /**
   * 相手から届いたゲーム内の動的アクションを反映します。
   */
  handleOpponentAction(payload) {
    if (payload.actionType === 'paddle') {
      // 相手のラケット位置同期
      // 相手の画面から送られてくるラケット位置をそのままセット
      // (対戦相手のX座標は、画面上部なので反転せずにそのまま同期できます。Xの向きは共通)
      if (this.role === 1) {
        this.p2.x = payload.x;
      } else {
        this.p1.x = payload.x;
      }
    }
    else if (payload.actionType === 'voice_call') {
      // 相手の発声イベント同期
      if (payload.call === 'ikimasu') {
        this.state = STATE_PRE_SERVE_HEARD;
        this.stateStartTime = Date.now();

        // 自分がレシーバーの場合、発声を再生
        const voiceOwner = this.serverRole === 1 ? "Player 1" : "Player 2";
        narrator.speak("いきます", false);

        if (this.isMyTurnToReceive()) {
          // 音声のみで案円（画面テキストは非表示中）
          // narrator.speak("画面をタップまたはスペースキーで「はい」と返答してください。", false);
        }
      }
      else if (payload.call === 'hai') {
        this.state = STATE_SERVE_WAITING;
        this.stateStartTime = Date.now();
        narrator.speak("はい", false);

        if (this.isMyTurnToServe()) {
          // 音声のみで案円（画面テキストは非表示中）
          // narrator.speak("画面をタップまたはスペースキーそサーブを打ってください。", false);
        }
      }
    }
    else if (payload.actionType === 'serve') {
      // 相手のサーブ実行
      this.ball.x = payload.x;
      this.ball.y = payload.y;
      this.ball.vx = payload.vx;
      this.ball.vy = payload.vy;
      this.ball.active = true;
      this.state = STATE_RALLY;
      // 音声のみでラリー開始を案円（画面テキストは非表示中）
      // ビープ音によるボール接近通知が開始される
      // 音波エフェクト（サーブ位置）
      this.addRipple(this.ball.x, this.ball.y, 'serve');
      sounds.playServeSound(this.ball.x, this.difficulty);
    }
    else if (payload.actionType === 'ball_hit') {
      // 得点確定後に遅れて届いた打球通知でラリー音や球を再開しない。
      if (this.state !== STATE_RALLY) return;
      // 保留中の得点判定があればキャンセル
      if (this.pendingScoreTimeout) {
        clearTimeout(this.pendingScoreTimeout);
        this.pendingScoreTimeout = null;
      }

      // 相手の打球同期
      this.ball.x = payload.x;
      this.ball.y = payload.y;
      this.ball.vx = payload.vx;
      this.ball.vy = payload.vy;

      // 衝突音と波紋
      sounds.playHitSound(this.ball.x);
      sounds.playServeRollSound(this.ball.x, this.ball.y);
      sounds.startRallyMusic();
      if (this.ball.vy < 0) {
        this.addRipple(this.ball.x, this.ball.y, 'hit_p1');
      } else {
        this.addRipple(this.ball.x, this.ball.y, 'hit');
      }
    }
    else if (payload.actionType === 'point') {
      // 得点の決定
      this.scores.p1 = payload.score1;
      this.scores.p2 = payload.score2;
      this.updateScoreboard();

      this.awardPointTo(payload.winner, payload.reason);
    }
    else if (payload.actionType === 'rematch_offer') {
      // Feature #13: 再戦の申し込みを受信
      narrator.speak("対戦相手が再戦を希望しています。もう一度プレイボタンを押すと再戦が開始します。", true);
      const btnPlayAgain = document.getElementById('btn-play-again');
      if (btnPlayAgain) {
        btnPlayAgain.textContent = "再戦を受ける";
      }
    }
    else if (payload.actionType === 'rematch_accept') {
      // Feature #13: 再戦の同意を受信
      const instr = document.getElementById('play-instructions');
      if (instr) {
        instr.classList.add('hidden');
        instr.innerHTML = '左右矢印キーでラケット移動。スペースキーでアクション。';
      }
      this.startNewMatch();
    }
  }

  // ==========================================================================
  // 7. ゲームプレイ制御 (ロジック・ステート)
  // ==========================================================================

  /**
   * 新しいマッチ(3ゲーム・2ゲーム先取)を開始します。
   */
  startNewMatch() {
    // Feature #17: 難易度を復元
    if (this.mode === 'cpu' && !this.difficulty) {
      this.difficulty = localStorage.getItem('stt_last_difficulty') || 'normal';
    }

    this.scores.p1 = 0;
    this.scores.p2 = 0;
    this.gameScores.p1 = 0;
    this.gameScores.p2 = 0;
    // STT準拠: Easyを含む全難易度で、2ポイントごとにサーブ権を交替する。
    this.serverRole = 1;

    // UIの切り替え
    this.changeScreen('play');

    // 体移動操作（DeviceMotion）の調整ボタン表示制御
    if (this.isMobile && this.useTilt) {
      const btnCalibrate = document.getElementById('btn-calibrate-tilt');
      if (btnCalibrate) btnCalibrate.classList.remove('hidden');
    } else {
      const btnCalibrate = document.getElementById('btn-calibrate-tilt');
      if (btnCalibrate) btnCalibrate.classList.add('hidden');
    }
    this.updateCanvasAriaLabel();

    this.updateScoreboard();

    // プレイヤーの名前設定
    if (this.mode === 'online') {
      if (this.role === 1) {
        document.getElementById('name-p1').textContent = "自分 (P1)";
        document.getElementById('name-p2').textContent = "対戦相手 (P2)";
      } else {
        document.getElementById('name-p1').textContent = "対戦相手 (P1)";
        document.getElementById('name-p2').textContent = "自分 (P2)";
      }
    } else {
      let diffJp = "普通";
      if (this.difficulty === "easy") diffJp = "簡単";
      if (this.difficulty === "hard") diffJp = "難しい";

      document.getElementById('name-p1').textContent = "プレイヤー";
      document.getElementById('name-p2').textContent = `CPU (${diffJp})`;

      // ゲーム開始時に音声でアナウンス
      narrator.speak(`難易度、${diffJp}、で、CPU対戦を開始します。`, true);
    }

    // ループとタイマーの開始
    this.startLoop();

    // 最初のサーブ準備へ
    this.prepareServeSequence();
  }

  /**
   * スコアボードのビジュアル表示を更新します。
   */
  updateScoreboard() {
    document.getElementById('score-p1').textContent = this.scores.p1;
    document.getElementById('score-p2').textContent = this.scores.p2;

    const g1 = document.getElementById('game-p1');
    const g2 = document.getElementById('game-p2');
    if (g1) g1.textContent = `ゲーム獲得: ${this.gameScores.p1}`;
    if (g2) g2.textContent = `ゲーム獲得: ${this.gameScores.p2}`;
  }

  /**
   * 自分がサーブする番かどうかを判定します。
   */
  isMyTurnToServe() {
    if (this.mode === 'cpu') return this.serverRole === 1;
    return this.serverRole === this.role;
  }

  /**
   * 自分がレシーブする番かどうかを判定します。
   */
  isMyTurnToReceive() {
    return !this.isMyTurnToServe();
  }

  /**
   * サーブ開始シーケンスを初期化します。
   * プレイ中は画面からルール説明テキストを非表示にし、
   * 画面全体タップでのアクション集中モードを有効にします。
   */
  prepareServeSequence() {
    sounds.stopRallyMusic();
    this.state = STATE_PRE_SERVE_READY;
    this.stateStartTime = Date.now();
    this.ball.active = false;
    this.pendingSwingUntil = 0;
    this.endFrameHits = 0;

    // プレイ集中モード: play-instructions テキストボックスを非表示にする
    // (スクリーンリーダーの sr-announcer 経由で音声で案内するため画面テキストは不要)
    const instrEl = document.getElementById('play-instructions');
    if (instrEl) instrEl.classList.add('hidden');


    // ボールをサーバーのラケットに吸着させる準備（位置は毎フレーム更新される）
    if (this.serverRole === 1) {
      // STT service area: the right half of the server's defensive court.
      this.p1.x = Math.max(CANVAS_WIDTH / 2, Math.min(CANVAS_WIDTH - PADDLE_WIDTH, this.p1.x));
      this.ball.x = this.p1.x + PADDLE_WIDTH / 2;
      this.ball.y = Y_DEFENSE_P1 - BALL_RADIUS;
    } else {
      this.p2.x = Math.max(CANVAS_WIDTH / 2, Math.min(CANVAS_WIDTH - PADDLE_WIDTH, this.p2.x));
      this.ball.x = this.p2.x + PADDLE_WIDTH / 2;
      this.ball.y = Y_DEFENSE_P2 + BALL_RADIUS;
    }
    this.ball.vx = 0;
    this.ball.vy = 0;

    // 主審の「プレー」宣告
    narrator.speak("プレー", true);

    if (this.isMyTurnToServe()) {
      // 音声のみで案内（テキストフィールドには書かない）
      // narrator.speak("あなたのサーブです。画面をタップまたはスペースキーで「いきます」と発声してください。", false);
    } else {
      // CPU対戦かつCPUがサーバーの場合、一定時間後にCPUが自動で「いきます」と発声
      if (this.mode === 'cpu' && this.serverRole === 2) {
        setTimeout(() => {
          if (this.state === STATE_PRE_SERVE_READY) {
            this.state = STATE_PRE_SERVE_HEARD;
            this.stateStartTime = Date.now();
            narrator.speak("いきます", false);
          }
        }, 1200 + Math.random() * 800); // 1.2〜2.0秒後に発声
      }
    }
  }

  /**
   * スペースキー（アクションキー）が押されたときのイベント処理。
   * STT特有の「いきます」「はい」「サーブ打球」などのシークエンスを進めます。
   */
  handleActionInput() {
    // Feature #4: インターバルスキップ - STATE_POINT_WON中にアクションでインターバルをスキップ
    if (this.state === STATE_POINT_WON && this.intervalSkipCallback) {
      clearTimeout(this.currentIntervalTimer);
      this.intervalSkipCallback();
      this.intervalSkipCallback = null;
      return;
    }

    // オンライン対戦時、自分のターン以外の誤入力を防ぐ

    if (this.state === STATE_PRE_SERVE_READY) {
      // 1. サーバー側の「いきます」発声
      if (this.isMyTurnToServe()) {
        this.state = STATE_PRE_SERVE_HEARD;
        this.stateStartTime = Date.now();

        narrator.speak("いきます", false);

        if (this.mode === 'online') {
          // 相手に通知
          this.net.send('action', { actionType: 'voice_call', call: 'ikimasu' });
        } else {
          // CPU戦の場合、一定時間後にCPUが「はい」と答える
          setTimeout(() => {
            if (this.state === STATE_PRE_SERVE_HEARD) {
              this.state = STATE_SERVE_WAITING;
              this.stateStartTime = Date.now();
              narrator.speak("はい", false);
            }
          }, 1000 + Math.random() * 800);
        }
      }
    }
    else if (this.state === STATE_PRE_SERVE_HEARD) {
      // 2. レシーバー側の「はい」返答
      if (this.isMyTurnToReceive()) {
        this.state = STATE_SERVE_WAITING;
        this.stateStartTime = Date.now();

        narrator.speak("はい", false);

        if (this.mode === 'online') {
          // 相手に通知
          this.net.send('action', { actionType: 'voice_call', call: 'hai' });
        } else {
          // CPU戦かつCPUがサーバー（自分がレシーバー）の場合、一定時間後にCPUが自動でサーブを打つ
          if (this.serverRole === 2) {
            const cpuDelay = 1200 + Math.random() * 800;

            setTimeout(() => {
              if (this.state === STATE_SERVE_WAITING) {
                this.state = STATE_RALLY;
                this.ball.active = true;

                // 難易度に応じてサーブの速度や角度を調整
                if (this.difficulty === 'easy') {
                  // 初級: 打ち返しやすい安定した低速サーブ (中央付近へ)
                  this.ball.vx = (Math.random() < 0.5 ? -1 : 1) *
                    (EASY_SERVE_VX_MIN + Math.random() * (EASY_SERVE_VX_MAX - EASY_SERVE_VX_MIN));
                  this.ball.vy = EASY_SERVE_VY_MIN +
                    Math.random() * (EASY_SERVE_VY_MAX - EASY_SERVE_VY_MIN);
                } else if (this.difficulty === 'normal') {
                  // ノーマル: スローサーブ、通常速度サーブ、高速サーブをランダムに打ち分け
                  const speedCategory = Math.random();
                  let baseVy;
                  if (speedCategory < 0.33) {
                    // スローサーブ (ふわりと緩い球)
                    baseVy = 3.42 + Math.random() * 0.45; // 3.42〜3.87
                  } else if (speedCategory < 0.67) {
                    // 通常速度サーブ
                    baseVy = 4.68 + Math.random() * 0.72; // 4.68〜5.4
                  } else {
                    // 高速サーブ (鋭く速い球)
                    baseVy = 6.3 + Math.random() * 0.9; // 6.3〜7.2
                  }

                  const serveAngle = Math.random();
                  let cpuServeVx;
                  if (serveAngle < 0.4) {
                    cpuServeVx = (Math.random() * 0.8 - 0.4); // 直球
                  } else if (serveAngle < 0.7) {
                    cpuServeVx = -(1.2 + Math.random() * 2.0); // 左流し
                  } else {
                    cpuServeVx = (1.2 + Math.random() * 2.0);  // 右流し
                  }
                  this.ball.vx = cpuServeVx;
                  this.ball.vy = baseVy;
                } else {
                  // ハード: 強烈かつ鋭角な高速サーブ
                  // 90% は高速、10% だけ遅い変化球にする。
                  const speedCategory = Math.random();
                  let baseVy;
                  if (speedCategory < 0.2) {
                    baseVy = 3.6 + Math.random() * 0.72;
                  } else if (speedCategory < 0.4) {
                    baseVy = 5.4 + Math.random() * 0.9;
                  } else {
                    baseVy = 7.2 + Math.random() * 1.8;
                  }
                  const serveAngle = Math.random();
                  let cpuServeVx;
                  if (serveAngle < 0.33) {
                    cpuServeVx = (Math.random() * 1.0 - 0.5) * 1.15;
                  } else if (serveAngle < 0.66) {
                    cpuServeVx = -(1.8 + Math.random() * 3.0) * 1.15;
                  } else {
                    cpuServeVx = (1.8 + Math.random() * 3.0) * 1.15;
                  }
                  this.ball.vx = cpuServeVx;
                  this.ball.vy = baseVy;
                }

                // 通常ラリー用に、中央寄りへゆっくり出す。
                if (this.difficulty !== 'easy') {
                  this.ball.vx = Math.random() * 1.2 - 0.6;
                }
                sounds.playServeSound(this.ball.x, this.difficulty, this.ball.y, true);
                this.addRipple(this.ball.x, this.ball.y, 'serve');
              }
            }, cpuDelay);
          }
        }
      }
    }
    else if (this.state === STATE_SERVE_WAITING) {
      // 3. サーバーによるサーブ実行
      if (this.isMyTurnToServe()) {
        // Feature #2: チャージ量を計算して初速に反映
        const chargeTime = this.isCharging ? Math.min((Date.now() - this.chargeStartTime) / 1500, 1.0) : 0;
        this.isCharging = false;
        const chargeRatio = chargeTime;
        let baseVy = 4.05 + (chargeRatio * 3.15); // 4.05〜7.2
        if (this.difficulty === 'easy') {
          // Keep Easy serves in the 5-6 second range, independent of charge.
          baseVy = EASY_SERVE_VY_MIN +
            Math.random() * (EASY_SERVE_VY_MAX - EASY_SERVE_VY_MIN);
        }
        if (this.difficulty === 'hard') {
          // ハードはプレイヤーのサーブも高速主体、遅球は10%。
          baseVy = Math.random() < 0.10
          baseVy = Math.random() < 0.10
            ? 4.0 + Math.random() * 0.8
            : 8.0 + Math.random() * 2.0;
        }

        this.state = STATE_RALLY;
        this.ball.active = true;

        // 音声のみでラリー開始を案内（テキストフィールドには書かない）
        // narrator.speak("ラリー開始。ボールが近づいたら高い音が鳴ります。画面をタップまたはスペースキーで打ち返してください。", false);
        // サーブの初速度設定 (対角のレシーブエリアへ向けて発射)
        if (this.serverRole === 1) {
          // 自分から相手へ (Yをマイナス方向へ)
          const startX = this.p1.x + PADDLE_WIDTH / 2;
          const targetX = CANVAS_WIDTH - startX; // 対角を狙う
          const dx = targetX - startX;
          this.ball.vx = (dx / 150) + (Math.random() * 0.4 - 0.2); // 距離に応じて横成分を決定
          this.ball.vy = -baseVy;
        } else {
          // 相手から自分へ (Yをプラス方向へ)
          const startX = this.p2.x + PADDLE_WIDTH / 2;
          const targetX = CANVAS_WIDTH - startX;
          const dx = targetX - startX;
          this.ball.vx = (dx / 150) + (Math.random() * 0.4 - 0.2);
          this.ball.vy = baseVy;
        }

        // 通常ラリー用に、中央寄りへゆっくり出す。
        if (this.difficulty === 'easy') {
          this.ball.vx = (Math.random() < 0.5 ? -1 : 1) *
            (EASY_SERVE_VX_MIN + Math.random() * (EASY_SERVE_VX_MAX - EASY_SERVE_VX_MIN));
        } else {
          this.ball.vx = Math.random() * 1.2 - 0.6;
        }
        sounds.playServeSound(this.ball.x, this.difficulty);
        this.addRipple(this.ball.x, this.ball.y, 'serve');

        if (this.mode === 'online') {
          // 相手にボールの初期軌跡を同期
          this.net.send('action', {
            actionType: 'serve',
            x: this.ball.x,
            y: this.ball.y,
            vx: this.ball.vx,
            vy: this.ball.vy
          });
        }
      }
    }
    else if (this.state === STATE_RALLY) {
      // A return must match the ball at the exact explicit input moment.
      // Do not replay the action later from a buffered swing window.
      this.pendingSwingUntil = 0;
      this.tryPlayerReturn();
    }
  }

  /**
   * 得点獲得処理。得点理由と勝者をアナウンスし、次のラリーへ。
   * @param {number} winner 勝者プレイヤー番号 (1 or 2)
   * @param {string} reason 理由 ('miss', 'serve_fault', 'out', 'stop', 'overtime')
   */
  awardPointTo(winner, reason) {
    // A physics frame can report more than one terminal condition (for
    // example, crossing an end line and stopping). Only one point is legal.
    if (this.state === STATE_POINT_WON) return;
    this.state = STATE_POINT_WON;
    this.ball.active = false;

    // 得点が入ってプレイが止まったらボールの転がり音をミュートし、ラリーBGMも停止する
    sounds.updateBallSound(this.ball.x, this.ball.y, 0, 0);
    sounds.stopRallyMusic();

    if (reason === 'out') {
      sounds.playOutSound(this.ball.x, this.ball.y);
    }

    // エンドフレーム2回成功の判定時だけ、rally2.m4aを1回鳴らす。
    if (reason === 'end_frame_success') {
      sounds.playEndFrameSuccessSound(this.ball.x, this.ball.y);
    }


    // 効果音の再生
    if (reason === 'out') {
      // playOutSound は上で再生済み。
    } else if (winner === this.role) {
      // 自分の得点
      sounds.playFrameSound(CANVAS_WIDTH / 2);
    } else {
      // 相手の得点 - Feature #5: パンニングのためにボールのX座標を渡す
      sounds.playMissSound(this.ball.x);
    }

    // 得点の理由案内テキスト (STT公式ルールブック「審判法 1. 主審の宣告用語」に準拠)
    let reasonText = "";
    switch (reason) {
      case 'safe':
        reasonText = "セーフ";
        break;
      case 'out':
        reasonText = "アウト";
        break;
      case 'miss':
        reasonText = "リターンミス";
        break;
      case 'stop':
        reasonText = "ストップボール";
        break;
      case 'front_stop':
        reasonText = "前コートストップ";
        break;
      case 'serve_fault':
        reasonText = "フォルト";
        break;
      case 'end_frame_success':
        reasonText = "エンドフレーム成功";
        break;
      case 'overtime':
        reasonText = "オーバータイム";
        break;
      default:
        reasonText = reason || "ポイント";
    }

    // コール発声: [終了の理由] → 「ポイント」 → [選手名] → [スコア]
    // STTルールブック審判法（27ページ）の順序に準拠
    const winnerName = this.mode === 'cpu'
      ? (winner === 1 ? 'プレイヤー' : 'CPU')
      : (winner === 1 ? 'プレイヤー 1' : 'プレイヤー 2');

    // デュース判定などの公式スコア計算 (ホスト、またはCPU戦の場合のみ加算)
    if (this.mode === 'cpu' || this.isServerAndDecider()) {
      if (winner === 1) this.scores.p1++;
      else this.scores.p2++;

      this.updateScoreboard();

      // オンライン対戦時はホスト(Player1)がスコアを決定し同期する
      if (this.mode === 'online') {
        this.net.send('action', {
          actionType: 'point',
          winner: winner,
          reason: reason,
          score1: this.scores.p1,
          score2: this.scores.p2
        });
      }
    }

    // Feature #3: リターンミス時のミス方向音声アナウンス
    if (reason === 'miss' || reason === 'safe') {
      const sideText = this.ball.x < CANVAS_WIDTH / 3 ? '左を通りました' : (this.ball.x > CANVAS_WIDTH * 2 / 3 ? '右を通りました' : '中央を通りました');
      try {
        const srEl = document.getElementById('sr-announcer');
        if (srEl) {
          srEl.textContent = '';
          setTimeout(() => {
            srEl.textContent = sideText;
          }, 80);
        }
      } catch (e) {}
    }

    // 主審の宣告コール（例:「セーフ、ポイント プレイヤー。 1 対 0。」 / 「アウト、ポイント CPU。 0 対 1。」）
    const scoreAnnounce = `${reasonText}、ポイント ${winnerName}。 ${this.scores.p1} 対 ${this.scores.p2}。`;
    narrator.speak(scoreAnnounce, true);

    // 改善⑧: インターバル中にスキップ可能なことをスクリーンリーダーで案内（2秒後）
    setTimeout(() => {
      try {
        const srEl = document.getElementById('sr-announcer');
        if (srEl) {
          srEl.textContent = '';
          setTimeout(() => { srEl.textContent = 'タップまたはスペースキーで次のサーブへ進めます。'; }, 50);
        }
      } catch(e) {}
    }, 2000);

    // 1ゲーム（セット）終了判定 (11点先取、デュース時は2点差)
    const p1 = this.scores.p1;
    const p2 = this.scores.p2;
    const isGameFinished = (p1 >= this.maxScore || p2 >= this.maxScore) && Math.abs(p1 - p2) >= 2;

    // Feature #4: インターバルスキップ用のコールバックパターンの適用
    this.intervalSkipCallback = () => {
      if (isGameFinished) {
        // ゲーム獲得数をインクリメント
        const gameWinner = p1 > p2 ? 1 : 2;
        this.gameScores[gameWinner === 1 ? 'p1' : 'p2']++;
        this.updateScoreboard();

        // 3ゲームマッチの勝利条件（2ゲーム先取）
        const winThreshold = Math.ceil(this.matchGames / 2);
        if (this.gameScores.p1 >= winThreshold || this.gameScores.p2 >= winThreshold) {
          // マッチ終了（全ゲームセット）
          this.finishMatch(this.gameScores.p1 > this.gameScores.p2 ? 1 : 2);
        } else {
          // 次のゲームの準備
          const totalGames = this.gameScores.p1 + this.gameScores.p2;
          const nextGameNum = totalGames + 1;

          narrator.speak(`ゲームカウント、${this.gameScores.p1} 対 ${this.gameScores.p2}。第 ${nextGameNum} ゲームを開始します。`, true);

          // ゲーム内のスコアをリセット
          this.scores.p1 = 0;
          this.scores.p2 = 0;
          this.updateScoreboard();

          // Feature #1 / 改善⑦: CPU戦サーブ交代制（easy含め全難易度でゲームごとに交代）
          this.serverRole = nextGameNum % 2 === 1 ? 1 : 2;

          setTimeout(() => {
            this.prepareServeSequence();
          }, 3000);
        }
      } else {
        // 次のサーブ権の移行チェック（全難易度共通）
        const total = p1 + p2;
        const serviceChangePoints = p1 >= 10 && p2 >= 10 ? 1 : 2;
        if (total > 0 && total % serviceChangePoints === 0) {
          this.serverRole = this.serverRole === 1 ? 2 : 1;
        }

        this.prepareServeSequence();
      }
    };

    const skipTimer = setTimeout(() => {
      if (this.intervalSkipCallback) {
        this.intervalSkipCallback();
        this.intervalSkipCallback = null;
      }
    }, 4000);
    this.currentIntervalTimer = skipTimer;
  }

  /**
   * オンライン対戦において、Player1をスコア決定のマスターとします。
   */
  isServerAndDecider() {
    return this.role === 1;
  }

  /**
   * マッチ(試合全体)の決着がついた際の終了処理。
   */
  finishMatch(matchWinner) {
    // ゲームループを停止（リザルト表示中に物理計算・描画が走り続けるのを防ぐ）
    this.stopLoop();
    // 改善⑥: CPU戦では「プレイヤー 2」でなく「CPU」と読み上げる
    const winnerName = this.mode === 'cpu'
      ? (matchWinner === 1 ? 'プレイヤー' : 'CPU')
      : (matchWinner === 1 ? 'プレイヤー 1' : 'プレイヤー 2');
    narrator.speak(`マッチ終了！ 勝者は、${winnerName} です！おめでとうございます！`, true);

    // 試合終了の歓声音を再生（ラリーBGMは先に停止）
    sounds.stopRallyMusic();
    sounds.playCheerSound();

    // play-instructions を再表示し、リザルト画面に書き換える (Feature #11)
    const instrEl = document.getElementById('play-instructions');
    if (instrEl) {
      instrEl.classList.remove('hidden');
      instrEl.innerHTML = `<div class="match-result-overlay">
        <div class="match-result-title">🏆 試合終了！</div>
        <div class="match-result-winner">勝者: ${winnerName}</div>
        <div class="match-result-score">最終スコア ${this.gameScores.p1} - ${this.gameScores.p2}</div>
        <div class="match-result-buttons">
          <button id="btn-play-again" class="btn btn-primary">もう一度プレイ</button>
          <button id="btn-quit-to-menu" class="btn btn-secondary">メニューに戻る</button>
        </div>
      </div>`;

      const btnPlayAgain = document.getElementById('btn-play-again');
      const btnQuitMenu = document.getElementById('btn-quit-to-menu');

      if (btnPlayAgain) {
        btnPlayAgain.addEventListener('click', () => {
          instrEl.classList.add('hidden');
          instrEl.innerHTML = '左右矢印キーでラケット移動。スペースキーでアクション。'; // 元に戻す

          if (this.mode === 'online') {
            // Feature #13: オンライン対戦時は相手に rematch_accept を送信
            // 送信側も即座に startNewMatch() を呼ぶ（双方が同時にゲームを開始する）
            this.net.send('action', { actionType: 'rematch_accept' });
            this.startNewMatch();
          } else {
            this.startNewMatch();
          }
        });
      }

      if (btnQuitMenu) {
        btnQuitMenu.addEventListener('click', () => {
          this.quitGame();
        });
      }

      if (btnPlayAgain) btnPlayAgain.focus();
    }

    // Feature #13: オンライン対戦時は相手に再戦希望（offer）のみを送信する。
    // accept は「もう一度プレイ」ボタン押下時に送信される。
    if (this.mode === 'online') {
      this.net.send('action', { actionType: 'rematch_offer' });
    }
  }

  // ==========================================================================
  // 8. 物理エンジン & CPU AI
  // ==========================================================================

  getBallAssistKeys() {
    // Paddle movement is manual only. Never steer it toward the ball.
    return { ...this.keys };

    // 通常ラリーでは自動アシストを使わず、左右入力だけを使う。
    // 返球は Space／タップから tryPlayerReturn() を呼んだ時だけ行う。
    return { ...this.keys };
    /*
    const keys = { ...this.keys };
    if (!this.ball.active || this.state !== STATE_RALLY) return keys;

    const isIncoming = this.role === 1
      ? this.ball.vy > 0 && this.ball.y >= Y_NET
      : this.ball.vy < 0 && this.ball.y <= Y_NET;
    if (!isIncoming || keys.ArrowLeft || keys.ArrowRight) return keys;

    const paddle = this.role === 1 ? this.p1 : this.p2;
    const defenseY = this.role === 1 ? Y_DEFENSE_P1 : Y_DEFENSE_P2;

    // ラケットに到達する頃の X 座標を先読みする。現在位置だけを追うと、
    // 横に速い球や壁で反射する球に対してラケットが後手になる。
    const framesToPaddle = Math.max(0, (defenseY - this.ball.y) / this.ball.vy);
    let targetCenter = this.ball.x + this.ball.vx * framesToPaddle;
    const maxX = CANVAS_WIDTH - BALL_RADIUS;
    const minX = BALL_RADIUS;
    const span = maxX - minX;
    if (span > 0) {
      // 壁反射を折り返し座標に変換して、実際に届く位置を求める。
      let reflected = ((targetCenter - minX) % (span * 2) + span * 2) % (span * 2);
      if (reflected > span) reflected = span * 2 - reflected;
      targetCenter = minX + reflected;
    }
    const targetX = targetCenter - PADDLE_WIDTH / 2;
    if (targetX < paddle.x - 2) keys.ArrowLeft = true;
    if (targetX > paddle.x + 2) keys.ArrowRight = true;
    return keys;
  }

    */
  }

  tryPlayerReturn() {
    if (!this.ball.active || this.state !== STATE_RALLY) return false;

    const paddle = this.role === 1 ? this.p1 : this.p2;
    const defenseY = this.role === 1 ? Y_DEFENSE_P1 : Y_DEFENSE_P2;
    const isIncoming = (this.role === 1 && this.ball.vy > 0) ||
      (this.role === 2 && this.ball.vy < 0);
    const hitZone = this.difficulty === 'easy'
      ? 130
      : this.difficulty === 'hard' ? NORMAL_HIT_ZONE * HARD_DIFFICULTY_FACTOR : NORMAL_HIT_ZONE;
    const normalPaddleMargin = NORMAL_PADDLE_MARGIN + BALL_RADIUS;
    const paddleMargin = this.difficulty === 'easy'
      ? 45 + BALL_RADIUS
      : this.difficulty === 'hard' ? normalPaddleMargin * HARD_DIFFICULTY_FACTOR : normalPaddleMargin;
    const isNearPaddle = Math.abs(this.ball.y - defenseY) < hitZone;
    const hitPaddle = this.ball.x >= paddle.x - paddleMargin &&
      this.ball.x <= paddle.x + PADDLE_WIDTH + paddleMargin;

    if (!isIncoming || !isNearPaddle || !hitPaddle) {
      console.debug('[STT return rejected]', {
        role: this.role,
        ball: { x: this.ball.x, y: this.ball.y, vx: this.ball.vx, vy: this.ball.vy },
        paddleX: paddle.x,
        defenseY,
        isIncoming,
        isNearPaddle,
        hitPaddle
      });
      return false;
    }

    this.pendingSwingUntil = 0;
    this.ball.y = defenseY;
    const relativeHitPos = (this.ball.x - (paddle.x + PADDLE_WIDTH / 2)) / (PADDLE_WIDTH / 2);
    const rallySpeedFactor = this.difficulty === 'easy' ? EASY_RALLY_SPEED_FACTOR : 1;
    this.ball.vx = relativeHitPos * 7.5 * rallySpeedFactor;
    this.ball.vy = this.role === 1
      ? -Math.abs(this.ball.vy) * 1.05 * rallySpeedFactor
      : Math.abs(this.ball.vy) * 1.05 * rallySpeedFactor;

    sounds.playSwingSound(paddle.x + PADDLE_WIDTH / 2, defenseY);
    sounds.playHitSound(this.ball.x, defenseY);
    sounds.playServeRollSound(this.ball.x, defenseY);
    sounds.startRallyMusic();
    sounds.playSuccessChime(this.ball.x, this.difficulty === 'easy', defenseY);
    this.addRipple(this.ball.x, this.ball.y, this.role === 1 ? 'hit_p1' : 'hit');
    console.debug('[STT return success]', {
      role: this.role,
      x: this.ball.x,
      y: this.ball.y,
      vx: this.ball.vx,
      vy: this.ball.vy
    });

    if (this.mode === 'online') {
      this.net.send('action', {
        actionType: 'ball_hit',
        x: this.ball.x,
        y: this.ball.y,
        vx: this.ball.vx,
        vy: this.ball.vy
      });
    }
    return true;
  }

  processBufferedSwing() {
    if (!this.pendingSwingUntil) return;

    if (Date.now() > this.pendingSwingUntil || this.state !== STATE_RALLY) {
      this.pendingSwingUntil = 0;
      return;
    }

    // handleActionInput() が現在のボール位置で成功判定を行う。
    // 成功すればそこで pendingSwingUntil がクリアされる。
    const pendingUntil = this.pendingSwingUntil;
    this.pendingSwingUntil = 0;
    this.handleActionInput();

    // まだ判定帯に届いていない場合は、残り時間だけ保留を継続する。
    if (this.state === STATE_RALLY && this.pendingSwingUntil === 0 && Date.now() < pendingUntil) {
      this.pendingSwingUntil = pendingUntil;
    }
  }

  /**
   * ゲームの物理アップデート (1フレームごとの処理)。
   */
  updatePhysics() {
    if (this.isGameplayPaused) return;
    try {
      const physicsKeys = this.getBallAssistKeys();
      // サービス前のボール吸着処理 (物理演算呼び出し前に行う)
      if (this.state === STATE_PRE_SERVE_READY ||
          this.state === STATE_PRE_SERVE_HEARD ||
          this.state === STATE_SERVE_WAITING) {
        if (this.serverRole === 1) {
          this.p1.x = Math.max(CANVAS_WIDTH / 2, Math.min(CANVAS_WIDTH - PADDLE_WIDTH, this.p1.x));
          this.ball.x = this.p1.x + PADDLE_WIDTH / 2;
          this.ball.y = Y_DEFENSE_P1 - BALL_RADIUS;
        } else {
          this.p2.x = Math.max(CANVAS_WIDTH / 2, Math.min(CANVAS_WIDTH - PADDLE_WIDTH, this.p2.x));
          this.ball.x = this.p2.x + PADDLE_WIDTH / 2;
          this.ball.y = Y_DEFENSE_P2 + BALL_RADIUS;
        }
      }

      // Go WebAssembly版の物理演算がロードされている場合はそれを使用
      if (typeof window.updatePhysicsWasm === 'function') {
      const result = window.updatePhysicsWasm(
        this.ball,
        this.p1,
        this.p2,
        physicsKeys,
        this.mode,
        this.state,
        this.role,
        this.difficulty,
        Date.now()
      );

      if (result) {
        // パドルの位置更新
        this.p1.x = result.p1.x;
        this.p2.x = result.p2.x;

        // 自分（プレイヤー）とCPUのラケット移動音の処理
        const myPaddleX = this.role === 1 ? this.p1.x : this.p2.x;
        const oppPaddleX = this.role === 1 ? this.p2.x : this.p1.x;

        const myDeltaX = Math.abs(myPaddleX - (this.lastMyPaddleX || myPaddleX));
        const oppDeltaX = Math.abs(oppPaddleX - (this.lastOppPaddleX || oppPaddleX));

        const now = Date.now();
        if (myDeltaX > 0.1 && now - this.lastFootstepTime >= 90) {
          sounds.playFootstepSound(myPaddleX, myDeltaX);
          sounds.playPaddleMoveClick(myPaddleX);
          this.lastFootstepTime = now;
        }
        // 中央判定 (コート中央 X=400 に対し、ラケット中心が 370〜430 の範囲内)
        const myCenterPos = myPaddleX + PADDLE_WIDTH / 2;
        const isInCenter = Math.abs(myCenterPos - (CANVAS_WIDTH / 2)) < 30;

        // 中央に入った瞬間にピピッ/振動（目印音）を再生
        if (isInCenter && !this.wasInCenter) {
          sounds.playCenterBeep(myCenterPos);
        }
        this.wasInCenter = isInCenter;

        this.lastMyPaddleX = myPaddleX;
        this.lastOppPaddleX = oppPaddleX;

        // パドル位置の同期 (オンライン対戦用)
        const paddle = this.role === 1 ? this.p1 : this.p2;
        this.syncPaddlePosition(paddle.x);

        // ボール状態の更新
        // オンライン対戦時: Player2（クライアント）はボール位置をWASMの独立計算では上書きしない。
        // ただし、スマホ同士の対戦でタップ当たり判定が機能するよう、
        // Player2でもserve/ball_hit受信後にローカル補間計算（移動のみ）を行う。
        // （得点判定はPlayer1のみが送信するため、二重カウントは発生しない）
        if (this.mode !== 'online' || this.role !== 2) {
          this.ball.x = result.ball.x;
          this.ball.y = result.ball.y;
          this.ball.vx = result.ball.vx;
          this.ball.vy = result.ball.vy;
          this.ball.active = result.ball.active;
        } else {
          // Player2: ボールの移動補間のみ行う（壁反射・ネット跳ね返りのみ、スコア判定なし）
          if (this.ball.active && this.state === STATE_RALLY) {
            this.ball.vx *= TABLE_FRICTION;
            this.ball.vy *= TABLE_FRICTION;
            this.ball.x += this.ball.vx;
            this.ball.y += this.ball.vy;
            // 左右壁反射
            if (this.ball.x - BALL_RADIUS <= 0) {
              this.ball.x = BALL_RADIUS;
              this.ball.vx = -this.ball.vx * 0.85;
            } else if (this.ball.x + BALL_RADIUS >= CANVAS_WIDTH) {
              this.ball.x = CANVAS_WIDTH - BALL_RADIUS;
              this.ball.vx = -this.ball.vx * 0.85;
            }
          }
        }

        // 立体音響のアップデート
        if (this.ball.active && this.state === STATE_RALLY) {
          sounds.updateBallSound(this.ball.x, this.ball.y, this.ball.vx, this.ball.vy);
        }
        this.processBufferedSwing();

        // イベントの処理 (音、エフェクト、得点、通信同期)
        if (result.events && result.events.length > 0) {
          result.events.forEach(evt => {
            if (evt.type === 'wall_hit') {
              sounds.playFrameSound(evt.x);
              this.addRipple(evt.x, evt.y, 'wall');
            } else if (evt.type === 'net_hit') {
              sounds.playNetSound(evt.x);
              this.addRipple(evt.x, evt.y, 'net');
            } else if (evt.type === 'ball_hit') {
              sounds.playHitSound(evt.x);
              sounds.playServeRollSound(evt.x, evt.y);
              sounds.startRallyMusic();
              if (evt.vy < 0 || evt.player === 1) {
                this.addRipple(evt.x, evt.y, 'hit_p1');
              } else {
                this.addRipple(evt.x, evt.y, 'hit');
              }

              if (this.mode === 'online' && this.role === evt.player) {
                this.net.send('action', {
                  actionType: 'ball_hit',
                  x: evt.x,
                  y: evt.y,
                  vx: evt.vx,
                  vy: evt.vy
                });
              }
            } else if (evt.type === 'score') {
              // Feature #6: ボール停止位置音の再生
              if (evt.reason === 'stop') {
                sounds.playBallStopSound(this.ball.x);
              }
              // オンライン対戦時: Player2（クライアント）はローカルの score イベントを無視し、
              // Player1（ホスト）から送られてくる 'point' メッセージでのみ得点を更新する
              if (this.mode === 'online' && this.role === 2) {
                if (evt.reason === 'stop') {
                  sounds.updateBallSound(this.ball.x, this.ball.y, 0, 0);
                }
                // Player2 はここで処理を終わらせ、ホストの判定を待つ
                return;
              }

              if (this.mode === 'online') {
                // Player1（ホスト）が得点を決定・同期する
                if (evt.winner === 2) {
                  // 自分（Player1）がミスした場合は即座に判定
                  if (evt.reason === 'stop') {
                    sounds.updateBallSound(this.ball.x, this.ball.y, 0, 0);
                  }
                  this.awardPointTo(evt.winner, evt.reason);
                } else {
                  // 相手がミスした場合は、遅延パケット到着を考慮して300ms保留する
                  if (this.pendingScoreTimeout) clearTimeout(this.pendingScoreTimeout);
                  this.pendingScoreTimeout = setTimeout(() => {
                    if (this.state === STATE_RALLY) { // まだラリー中であれば確定
                      if (evt.reason === 'stop') {
                        sounds.updateBallSound(this.ball.x, this.ball.y, 0, 0);
                      }
                      this.awardPointTo(evt.winner, evt.reason);
                    }
                    this.pendingScoreTimeout = null;
                  }, 300); // 300msのバッファ
                }
              } else {
                // CPU戦などは即座に判定
                if (evt.reason === 'stop') {
                  sounds.updateBallSound(this.ball.x, this.ball.y, 0, 0);
                }
                this.awardPointTo(evt.winner, evt.reason);
              }
            }
          });
        }
      }

      // 公式ルールにおける時間制限 (オーバータイム) のチェック
      this.checkTimeouts();
      return;
    }

    // 1. プレイヤーのラケット移動 (矢印キー / A,Dキー / チルト比例制御)
    // チルト操作時: 傾き比率 (0〜1) × 難易度別の最大速度で比例移動
    // キーボード操作時: 難易度別の最大速度で移動
    // Normalを標準速度とし、Hardはその90%にして操作を厳しくする。
    // チルト操作時は、この最大速度に傾き比率 (0〜1) を掛けて比例移動する。
    const maxSpeed = this.difficulty === 'hard'
      ? NORMAL_PADDLE_SPEED * HARD_DIFFICULTY_FACTOR
      : this.difficulty === 'normal' ? NORMAL_PADDLE_SPEED : 7;
    const paddle = this.role === 1 ? this.p1 : this.p2;
    const isAssistMove = !this.keys['ArrowLeft'] && !this.keys['ArrowRight'] &&
      (physicsKeys['ArrowLeft'] || physicsKeys['ArrowRight']);

    if (physicsKeys['ArrowLeft']) {
      // チルト操作中は比例速度を使用、キーボードは最大速度
      const speed = !isAssistMove && this.useTilt && this.tiltSpeed !== undefined
        ? maxSpeed * this.tiltSpeed
        : maxSpeed;
      paddle.x -= speed;
      if (paddle.x < 0) paddle.x = 0;
      this.syncPaddlePosition(paddle.x);
    }
    if (physicsKeys['ArrowRight']) {
      const speed = !isAssistMove && this.useTilt && this.tiltSpeed !== undefined
        ? maxSpeed * this.tiltSpeed
        : maxSpeed;
      paddle.x += speed;
      if (paddle.x > CANVAS_WIDTH - PADDLE_WIDTH) paddle.x = CANVAS_WIDTH - PADDLE_WIDTH;
      this.syncPaddlePosition(paddle.x);
    }

    // 2. CPUのAI (CPU戦かつ相手のターン時)
    const myPaddleX = paddle.x;
    const myDeltaX = Math.abs(myPaddleX - this.lastMyPaddleX);
    const now = Date.now();
    if (myDeltaX > 0.1 && now - this.lastFootstepTime >= 90) {
      sounds.playFootstepSound(myPaddleX, myDeltaX);
      sounds.playPaddleMoveClick(myPaddleX);
      this.lastFootstepTime = now;
    }
    this.lastMyPaddleX = myPaddleX;

    if (this.mode === 'cpu' && this.state === STATE_RALLY && this.ball.vy < 0) {
      // 難易度に応じたCPUの追従速度とブレを設定
      let cpuSpeed = 4.5;
      let targetOffset = 0;

      switch (this.difficulty) {
        case 'easy':
          // 【簡単モード】プレイヤーが3回返球できるよう、最初だけCPU返球を補助する
          cpuSpeed = 4.05; // 従来比90%
          targetOffset = Math.sin(Date.now() / 600) * 8; // 微小なブレのみ（自然な動きの演出用）
          break;
        case 'normal':
          cpuSpeed = 4.68; // 従来比90%
          targetOffset = Math.sin(Date.now() / 300) * 15; // わずかなブレ
          break;
        case 'hard':
          cpuSpeed = 7.65; // 従来比90%
          targetOffset = 0; // ブレなし、常に正確にボールの中心を狙う
          break;
      }

      const cpuTarget = this.ball.x - PADDLE_WIDTH / 2 + targetOffset;

      if (this.p2.x < cpuTarget) {
        this.p2.x += cpuSpeed;
        if (this.p2.x > CANVAS_WIDTH - PADDLE_WIDTH) this.p2.x = CANVAS_WIDTH - PADDLE_WIDTH;
      } else if (this.p2.x > cpuTarget) {
        this.p2.x -= cpuSpeed;
        if (this.p2.x < 0) this.p2.x = 0;
      }
    }

    // 3. ボールの運動計算 (ラリー中のみ移動)
    // オンライン対戦で Player2（クライアント）の場合、得点判定を伴うWASM物理計算はスキップ済み。
    // ただし、タップ当たり判定のためにPlayer2でもローカル補間計算を行う（JSフォールバック）。
    if (this.mode === 'online' && this.role === 2 && this.ball.active && this.state === STATE_RALLY) {
      // Player2: 移動補間のみ（壁反射込み、スコア判定なし）
      this.ball.vx *= TABLE_FRICTION;
      this.ball.vy *= TABLE_FRICTION;
      this.ball.x += this.ball.vx;
      this.ball.y += this.ball.vy;
      if (this.ball.x - BALL_RADIUS <= 0) {
        this.ball.x = BALL_RADIUS;
        this.ball.vx = -this.ball.vx * 0.85;
      } else if (this.ball.x + BALL_RADIUS >= CANVAS_WIDTH) {
        this.ball.x = CANVAS_WIDTH - BALL_RADIUS;
        this.ball.vx = -this.ball.vx * 0.85;
      }
      sounds.updateBallSound(this.ball.x, this.ball.y, this.ball.vx, this.ball.vy);
      this.processBufferedSwing();

    }
    const shouldComputeBall = !(this.mode === 'online' && this.role === 2);
    if (shouldComputeBall && this.ball.active && this.state === STATE_RALLY) {
      this.processBufferedSwing();
      // 摩擦による減速
      this.ball.vx *= TABLE_FRICTION;
      this.ball.vy *= TABLE_FRICTION;

      this.ball.x += this.ball.vx;
      this.ball.y += this.ball.vy;

      // 立体音響のアップデート
      sounds.updateBallSound(this.ball.x, this.ball.y, this.ball.vx, this.ball.vy);


      // --- 左右サイド境界 (X=0, X=800) の壁反射 ---
      // STTでは横端は壁。壁に当たっただけでは失点にせず、反射音を案内する。
      if (this.ball.x - BALL_RADIUS <= 0) {
        this.ball.x = BALL_RADIUS;
        this.ball.vx = -this.ball.vx * 0.85;
        sounds.playFrameSound(this.ball.x);
        this.addRipple(this.ball.x, this.ball.y, 'wall');
      } else if (this.ball.x + BALL_RADIUS >= CANVAS_WIDTH) {
        this.ball.x = CANVAS_WIDTH - BALL_RADIUS;
        this.ball.vx = -this.ball.vx * 0.85;
        sounds.playFrameSound(this.ball.x);
        this.addRipple(this.ball.x, this.ball.y, 'wall');
      }

      // --- ネット (Y=250) の通過判定 ---
      // 稀に、または特定の条件でネットに引っかかる判定を追加
      const wasAboveNet = (this.ball.y - this.ball.vy) < Y_NET;
      const isBelowNet = this.ball.y >= Y_NET;
      if (wasAboveNet !== isBelowNet && Math.abs(this.ball.vx) > 8) {
        // 速度が速すぎて「ネットの下を通らず、浮き上がってネットに当たった」想定の処理
        if (Math.random() < 0.25) {
          sounds.playNetSound(this.ball.x);
          this.addRipple(this.ball.x, this.ball.y, 'net');
          this.ball.vy = -this.ball.vy * 0.3; // 弱く跳ね返る
          this.ball.vx *= 0.5;
          return;
        }
      }

      // --- プレイヤー1 (手前自分 Y=400〜500) の衝突/打ち返し判定 ---
      if (this.ball.vy > 0 && this.ball.y >= Y_DEFENSE_P1 && this.ball.y <= Y_DEFENSE_P1 + 25) {
        // P1がCPUの場合のみ自動で打ち返す（人間プレイヤーの場合はSpaceキー入力でのみ打ち返せる）
        const isP1Cpu = (this.mode === 'cpu' && this.role === 2);
        if (isP1Cpu) {
          const hitPaddle = this.ball.x >= this.p1.x && this.ball.x <= this.p1.x + PADDLE_WIDTH;
          const cpuReturnChance = this.difficulty === 'easy' ? 0.54
            : this.difficulty === 'normal' ? 0.79 : 0.88;
          if (hitPaddle && Math.random() < cpuReturnChance) {
            this.ball.y = Y_DEFENSE_P1;
            const relativeHitPos = (this.ball.x - (this.p1.x + PADDLE_WIDTH / 2)) / (PADDLE_WIDTH / 2);
            // 改善①②④: 難易度別の返球横速度・縦加速
            const cpuVxFactor = this.difficulty === 'easy' ? 1.35 : this.difficulty === 'hard' ? 5.4 : 3.6;
            const cpuVyBoost = this.difficulty === 'hard' ? 1.144 : this.difficulty === 'easy' ? 1.018 : 1.045;
            const rallySpeedFactor = this.difficulty === 'easy' ? EASY_RALLY_SPEED_FACTOR : 1;
            this.ball.vx = relativeHitPos * cpuVxFactor * rallySpeedFactor;
            this.ball.vy = -Math.abs(this.ball.vy) * cpuVyBoost * rallySpeedFactor;

            sounds.playHitSound(this.ball.x);
            sounds.playServeRollSound(this.ball.x, this.ball.y);
            sounds.startRallyMusic();
            this.addRipple(this.ball.x, this.ball.y, 'hit_p1');
          }
        }
      }

      // --- プレイヤー2 (奥相手 Y=100〜0) の衝突/打ち返し判定 ---
      if (this.ball.vy < 0 && this.ball.y <= Y_DEFENSE_P2 && this.ball.y >= Y_DEFENSE_P2 - 25) {
        // P2がCPUの場合のみ自動で打ち返す（人間プレイヤーの場合はSpaceキー入力でのみ打ち返せる）
        const isP2Cpu = (this.mode === 'cpu' && this.role === 1);
        if (isP2Cpu) {
          const hitPaddle = this.ball.x >= this.p2.x && this.ball.x <= this.p2.x + PADDLE_WIDTH;
          const cpuReturnChance = this.difficulty === 'easy' ? 0.54
            : this.difficulty === 'normal' ? 0.79 : 0.88;
          if (hitPaddle && Math.random() < cpuReturnChance) {
            this.ball.y = Y_DEFENSE_P2;
            const relativeHitPos = (this.ball.x - (this.p2.x + PADDLE_WIDTH / 2)) / (PADDLE_WIDTH / 2);
            // 改善①②④: 難易度別の返球横速度・縦加速
            const cpuVxFactor = this.difficulty === 'easy' ? 1.35 : this.difficulty === 'hard' ? 5.4 : 3.6;
            const cpuVyBoost = this.difficulty === 'hard' ? 1.144 : this.difficulty === 'easy' ? 1.018 : 1.045;
            const rallySpeedFactor = this.difficulty === 'easy' ? EASY_RALLY_SPEED_FACTOR : 1;
            this.ball.vx = relativeHitPos * cpuVxFactor * rallySpeedFactor;
            this.ball.vy = Math.abs(this.ball.vy) * cpuVyBoost * rallySpeedFactor;

            sounds.playHitSound(this.ball.x);
            sounds.playServeRollSound(this.ball.x, this.ball.y);
            sounds.startRallyMusic();
            this.addRipple(this.ball.x, this.ball.y, 'hit');
            // 改善⑤: CPU打球時のスクリーンリーダー向け通知
            try {
              const srEl = document.getElementById('sr-announcer');
              if (srEl) { srEl.textContent = ''; setTimeout(() => { srEl.textContent = 'CPUが打ちました'; }, 20); }
            } catch(e) {}
          }
        }
      }

      // --- 得点・セーフ・アウト・停止判定 (STT公式ルールブック 1.7.12, 1.9.1, 1.9.2 に準拠) ---

      // 1. 自分側 (P1) のエンドフレーム到達
      if (this.ball.y > CANVAS_HEIGHT) {
        const outSpeed = this.difficulty === 'hard'
          ? NORMAL_OUT_SPEED * HARD_DIFFICULTY_FACTOR : NORMAL_OUT_SPEED;
        if (Math.abs(this.ball.vy) > outSpeed) {
          // 強すぎてエンドフレームを越えて飛び出た -> P2のアウト、P1の得点
          this.awardPointTo(1, 'out');
        } else {
          this.endFrameHits++;
          sounds.playFrameSound(this.ball.x, CANVAS_HEIGHT);
          if (this.endFrameHits >= 2) {
            // 2回目もコート内に残った場合は成功扱いにする。
            this.awardPointTo(2, 'end_frame_success');
          } else {
            // 1回目はコート内へ跳ね返し、2回目の接触を待つ。
            this.ball.y = CANVAS_HEIGHT - BALL_RADIUS;
            this.ball.vy = -Math.abs(this.ball.vy) * 0.75;
          }
        }
      }

      // 2. 相手側 (P2) のエンドフレーム到達
      else if (this.ball.y < 0) {
        const outSpeed = this.difficulty === 'hard'
          ? NORMAL_OUT_SPEED * HARD_DIFFICULTY_FACTOR : NORMAL_OUT_SPEED;
        if (Math.abs(this.ball.vy) > outSpeed) {
          // 強すぎてエンドフレームを越えて飛び出た -> P1のアウト、P2の得点
          this.awardPointTo(2, 'out');
        } else {
          this.endFrameHits++;
          sounds.playFrameSound(this.ball.x, 0);
          if (this.endFrameHits >= 2) {
            // 2回目もコート内に残った場合は成功扱いにする。
            this.awardPointTo(1, 'end_frame_success');
          } else {
            // 1回目はコート内へ跳ね返し、2回目の接触を待つ。
            this.ball.y = BALL_RADIUS;
            this.ball.vy = Math.abs(this.ball.vy) * 0.75;
          }
        }
      }

      // 3. ボールの摩擦停止判定 (守備コート内停止＝ストップボール、前コート停止＝前コートストップ)
      const ballSpeed = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
      if (ballSpeed < 0.12) {
        this.ball.vx = 0;
        this.ball.vy = 0;
        sounds.playBallStopSound(this.ball.x, this.ball.y);
        sounds.updateBallSound(this.ball.x, this.ball.y, 0, 0);

        if (this.ball.y >= Y_DEFENSE_P1) {
          // プレイヤー1の守備コート内で停止 -> プレイヤー2のストップボール得点
          this.awardPointTo(2, 'stop');
        } else if (this.ball.y <= Y_DEFENSE_P2) {
          // プレイヤー2の守備コート内で停止 -> プレイヤー1のストップボール得点
          this.awardPointTo(1, 'stop');
        } else {
          // 前コート（ネット付近）で停止 -> 打球者の前コートストップ失点
          if (this.ball.y > Y_NET) {
            // P1側前コートで失速・停止 -> P1の失点、P2の得点
            this.awardPointTo(2, 'front_stop');
          } else {
            // P2側前コートで失速・停止 -> P2の失点、P1の得点
            this.awardPointTo(1, 'front_stop');
          }
        }
      }
    }

    // 4. 公式ルールにおける時間制限 (オーバータイム) のチェック
    this.checkTimeouts();
    } catch (err) {
      console.error("Error in updatePhysics:", err);
      const instructions = document.getElementById('play-instructions');
      if (instructions) {
        instructions.textContent = "エラー発生: " + err.message;
      }
    }
  }

  /**
   * 自分のラケット位置をネットワーク同期します (流量制限を行い負荷低減)。
   */
  syncPaddlePosition(x) {
    if (this.mode !== 'online') return;
    // 30ms 以内の重複送信を防いでサーバー負荷を抑制する（スロットル）
    const now = Date.now();
    if (now - this.net.paddleLastSent < 30) return;
    this.net.paddleLastSent = now;
    this.net.send('action', { actionType: 'paddle', x: x });
  }

  /**
   * STT公式ルールに基づく秒数制限をチェックし、違反時は失点処理を行います。
   */
  checkTimeouts() {
    if (this.state === STATE_POINT_WON || this.state === STATE_MENU) return;

    const elapsed = (Date.now() - this.stateStartTime) / 1000;

    if (this.state === STATE_PRE_SERVE_READY) {
      // サーバーは「プレー」宣告から10秒以内に「いきます」と言わなければならない
      if (elapsed > 10.0) {
        const offender = this.serverRole;
        const winner = offender === 1 ? 2 : 1;
        this.awardPointTo(winner, 'overtime');
      }
    }
    else if (this.state === STATE_PRE_SERVE_HEARD) {
      // レシーバーは「いきます」から5秒以内に「はい」と言わなければならない
      if (elapsed > 5.0) {
        const offender = this.serverRole === 1 ? 2 : 1; // サーバーと逆がレシーバー
        const winner = offender === 1 ? 2 : 1;
        this.awardPointTo(winner, 'overtime');
      }
    }
    else if (this.state === STATE_SERVE_WAITING) {
      // サーバーは「はい」から5秒以内にサーブを打たなければならない
      if (elapsed > 5.0) {
        const offender = this.serverRole;
        const winner = offender === 1 ? 2 : 1;
        this.awardPointTo(winner, 'overtime');
      }
    }
  }


  // 9. ビジュアル描画 (HTML5 Canvas)
  // ==========================================================================

  /**
   * 音の波紋エフェクトを追加します。
   */
  addRipple(x, y, type) {
    let color = '#fff';
    let maxRadius = 80;

    switch (type) {
      case 'hit':
        color = 'rgba(0, 240, 255, 0.6)';
        maxRadius = 100;
        break;
      case 'hit_p1':
        color = 'rgba(0, 240, 255, 0.8)';
        maxRadius = 180;
        break;
      case 'smash':
        color = 'rgba(255, 0, 127, 0.8)';
        maxRadius = 150;
        break;
      case 'wall':
        color = 'rgba(255, 170, 0, 0.5)';
        maxRadius = 70;
        break;
      case 'net':
        color = 'rgba(255, 49, 49, 0.6)';
        maxRadius = 90;
        break;
      case 'serve':
        color = 'rgba(57, 255, 20, 0.7)';
        maxRadius = 110;
        break;
      case 'swing':
        color = 'rgba(255, 255, 255, 0.45)';
        maxRadius = 65;
        break;
    }

    this.ripples.push({
      x: x,
      y: y,
      radius: 5,
      maxRadius: maxRadius,
      color: color,
      alpha: 1.0,
      speed: 3
    });
  }

  /**
   * Canvas上にゲーム画面を描画します。
   */
  draw() {
    const ctx = this.ctx;

    // 矢印の頭を描画するヘルパー関数
    const drawArrowhead = (x, y, angle) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-3, -6);
      ctx.lineTo(3, -6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    // 1. 背景のクリア (濃いグレー・漆黒)
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // 2. テーブル（コート）の描画
    // 外枠フレーム
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, CANVAS_WIDTH - 10, CANVAS_HEIGHT - 10);

    // 内枠コート (黒色)
    ctx.fillStyle = '#0a0d14';
    ctx.fillRect(10, 10, CANVAS_WIDTH - 20, CANVAS_HEIGHT - 20);

    // 3. コート内ラインの描画
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';

    // 守備ライン (自分側・相手側)
    ctx.beginPath();
    ctx.moveTo(10, Y_DEFENSE_P1);
    ctx.lineTo(CANVAS_WIDTH - 10, Y_DEFENSE_P1);
    ctx.moveTo(10, Y_DEFENSE_P2);
    ctx.lineTo(CANVAS_WIDTH - 10, Y_DEFENSE_P2);
    ctx.stroke();

    // センターライン (守備エリアのみ)
    ctx.beginPath();
    ctx.moveTo(CANVAS_WIDTH / 2, 10);
    ctx.lineTo(CANVAS_WIDTH / 2, Y_DEFENSE_P2);
    ctx.moveTo(CANVAS_WIDTH / 2, Y_DEFENSE_P1);
    ctx.lineTo(CANVAS_WIDTH / 2, CANVAS_HEIGHT - 10);
    ctx.stroke();

    // ネットの描画 (中央の一本の白いラインと影)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(5, Y_NET);
    ctx.lineTo(CANVAS_WIDTH - 5, Y_NET);
    ctx.stroke();

    // ネットの影 (立体感の演出)
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(10, Y_NET + 2, CANVAS_WIDTH - 20, 4);

    // ==========================================================================
    // 見える人向けの寸法ガイド描画 (ネオン半透明)
    // ==========================================================================
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.2)';
    ctx.fillStyle = 'rgba(0, 240, 255, 0.5)';
    ctx.font = '10px "Outfit", "Noto Sans JP", sans-serif';
    ctx.lineWidth = 1;

    // 1. 全長 274cm (左端の寸法線)
    ctx.beginPath();
    ctx.moveTo(15, 10);
    ctx.lineTo(32, 10);
    ctx.moveTo(15, CANVAS_HEIGHT - 10);
    ctx.lineTo(32, CANVAS_HEIGHT - 10);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(24, 15);
    ctx.lineTo(24, CANVAS_HEIGHT - 15);
    ctx.stroke();
    drawArrowhead(24, 15, -Math.PI / 2);
    drawArrowhead(24, CANVAS_HEIGHT - 15, Math.PI / 2);

    ctx.save();
    ctx.translate(19, CANVAS_HEIGHT / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('全長 274 cm', 0, 0);
    ctx.restore();

    // 2. 幅 152.5cm (下端の寸法線)
    ctx.beginPath();
    ctx.moveTo(10, CANVAS_HEIGHT - 15);
    ctx.lineTo(10, CANVAS_HEIGHT - 32);
    ctx.moveTo(CANVAS_WIDTH - 10, CANVAS_HEIGHT - 15);
    ctx.lineTo(CANVAS_WIDTH - 10, CANVAS_HEIGHT - 32);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(15, CANVAS_HEIGHT - 24);
    ctx.lineTo(CANVAS_WIDTH - 15, CANVAS_HEIGHT - 24);
    ctx.stroke();
    drawArrowhead(15, CANVAS_HEIGHT - 24, Math.PI);
    drawArrowhead(CANVAS_WIDTH - 15, CANVAS_HEIGHT - 24, 0);

    ctx.textAlign = 'center';
    ctx.fillText('幅 152.5 cm', CANVAS_WIDTH / 2, CANVAS_HEIGHT - 28);

    // 3. サイドフレーム 60cm (右端・手前側の寸法線)
    ctx.strokeStyle = 'rgba(255, 0, 127, 0.2)';
    ctx.fillStyle = 'rgba(255, 0, 127, 0.5)';
    ctx.beginPath();
    ctx.moveTo(CANVAS_WIDTH - 15, Y_DEFENSE_P1);
    ctx.lineTo(CANVAS_WIDTH - 32, Y_DEFENSE_P1);
    ctx.moveTo(CANVAS_WIDTH - 15, CANVAS_HEIGHT - 10);
    ctx.lineTo(CANVAS_WIDTH - 32, CANVAS_HEIGHT - 10);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(CANVAS_WIDTH - 24, Y_DEFENSE_P1 + 5);
    ctx.lineTo(CANVAS_WIDTH - 24, CANVAS_HEIGHT - 15);
    ctx.stroke();
    drawArrowhead(CANVAS_WIDTH - 24, Y_DEFENSE_P1 + 5, -Math.PI / 2);
    drawArrowhead(CANVAS_WIDTH - 24, CANVAS_HEIGHT - 15, Math.PI / 2);

    ctx.save();
    ctx.translate(CANVAS_WIDTH - 19, Y_DEFENSE_P1 + 45);
    ctx.rotate(Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('フレーム 60 cm', 0, 0);
    ctx.restore();

    // 4. ネット断面規格図 (右側空きスペース Y=140〜225, X=635〜760)
    // プレイに支障がない隅っこに配置
    const viewX = CANVAS_WIDTH - 155;
    const viewY = 140;
    const viewW = 125;
    const viewH = 85;

    // 背景・外枠
    ctx.fillStyle = 'rgba(10, 13, 20, 0.85)';
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.25)';
    ctx.lineWidth = 1;
    ctx.fillRect(viewX, viewY, viewW, viewH);
    ctx.strokeRect(viewX, viewY, viewW, viewH);

    // 図解タイトル
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = 'bold 8.5px "Outfit", "Noto Sans JP", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('ネット断面 (側観)', viewX + viewW / 2, viewY + 12);

    // テーブル面 (横線)
    const tblY = viewY + 65;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.beginPath();
    ctx.moveTo(viewX + 8, tblY);
    ctx.lineTo(viewX + viewW - 8, tblY);
    ctx.stroke();

    // ネットの支柱と布ネット
    const netGap = 13;   // スケール換算の隙間
    const netH = 32;     // ネットの高さ
    const netTopY = tblY - netGap - netH;
    const netBottomY = tblY - netGap;
    const netX = viewX + viewW / 2;

    // ネット (半透明の青)
    ctx.fillStyle = 'rgba(0, 240, 255, 0.18)';
    ctx.fillRect(netX - 2.5, netTopY, 5, netH);
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.6)';
    ctx.strokeRect(netX - 2.5, netTopY, 5, netH);

    // ネット支柱
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fillRect(netX - 0.8, netTopY - 3, 1.6, netH + netGap + 3);

    // ボールが隙間を通過する点線軌跡
    ctx.strokeStyle = 'rgba(57, 255, 20, 0.4)';
    ctx.setLineDash([2, 1.5]);
    ctx.beginPath();
    ctx.moveTo(viewX + 15, tblY - 6);
    ctx.lineTo(viewX + viewW - 15, tblY - 6);
    ctx.stroke();
    ctx.setLineDash([]);

    // ボール (ネオングリーン) × 2個 (通過中と停止位置を示す)
    ctx.fillStyle = '#39ff14';
    ctx.beginPath();
    ctx.arc(netX - 20, tblY - 6, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(netX, tblY - 6, 4.5, 0, Math.PI * 2);
    ctx.fill();

    // 寸法引出線 (オレンジ/黄)
    ctx.strokeStyle = 'rgba(255, 170, 0, 0.6)';
    ctx.fillStyle = 'rgba(255, 170, 0, 0.85)';
    ctx.font = '7.5px "Outfit", "Noto Sans JP", sans-serif';

    // ネット下の隙間 4.2cm
    ctx.beginPath();
    ctx.moveTo(netX + 12, tblY);
    ctx.lineTo(netX + 12, netBottomY);
    ctx.stroke();
    drawArrowhead(netX + 12, tblY, Math.PI / 2);
    drawArrowhead(netX + 12, netBottomY, -Math.PI / 2);

    ctx.textAlign = 'left';
    ctx.fillText('隙間 4.2cm', netX + 18, tblY - 3);

    // ネットの高さ 15.25cm
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.5)';
    ctx.fillStyle = 'rgba(0, 240, 255, 0.85)';
    ctx.beginPath();
    ctx.moveTo(netX - 12, tblY);
    ctx.lineTo(netX - 12, netTopY);
    ctx.stroke();
    drawArrowhead(netX - 12, tblY, Math.PI / 2);
    drawArrowhead(netX - 12, netTopY, -Math.PI / 2);

    ctx.textAlign = 'right';
    ctx.fillText('高 15.25cm', netX - 18, netTopY + 12);

    ctx.restore(); // 寸法ガイド描画のスタイルの復元

    // 4. 音の波紋エフェクトの描画・更新
    ctx.lineWidth = 3;
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.radius += r.speed;
      r.alpha = 1.0 - (r.radius / r.maxRadius);

      if (r.alpha <= 0) {
        this.ripples.splice(i, 1);
        continue;
      }

      ctx.strokeStyle = r.color.replace(')', `, ${r.alpha})`).replace('rgb', 'rgba');
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 5. ラケット (パドル) の描画
    // 自分 (Player 1) - シアンネオン調
    ctx.fillStyle = '#00f0ff';
    ctx.shadowBlur = 15;
    ctx.shadowColor = '#00f0ff';
    ctx.fillRect(this.p1.x, Y_DEFENSE_P1 + 5, PADDLE_WIDTH, PADDLE_HEIGHT);

    // 相手 (Player 2) - マゼンタネオン調
    ctx.fillStyle = '#ff007f';
    ctx.shadowColor = '#ff007f';
    ctx.fillRect(this.p2.x, Y_DEFENSE_P2 - 20, PADDLE_WIDTH, PADDLE_HEIGHT);

    // シャドウリセット
    ctx.shadowBlur = 0;

    // 6. ボールの描画 (アクティブ時のみ)
    if (this.ball.active) {
      // 軌跡 (少し余韻を引くように発光)
      ctx.shadowBlur = 10;
      ctx.shadowColor = '#39ff14';
      ctx.fillStyle = '#39ff14'; // ネオングリーン

      ctx.beginPath();
      ctx.arc(this.ball.x, this.ball.y, BALL_RADIUS, 0, Math.PI * 2);
      ctx.fill();

      ctx.shadowBlur = 0; // シャドウリセット
    }
  }

  // ==========================================================================
  // 11. モバイル・アクセシビリティ（チルト操作等）の処理
  // ==========================================================================

  /**
   * DeviceMotion（加速度センサー）の使用許可を要求します。
   * - iOS 13+: DeviceMotionEvent.requestPermission() によるダイアログ表示が必要
   * - Android / その他: 自動的に有効化
   * - Windows PC / 非対応端末: センサー非対応として無効化
   */
  requestDeviceMotionPermission() {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      // iOS 13+ — ユーザー操作のコンテキストで呼ぶ必要がある
      DeviceMotionEvent.requestPermission()
        .then(permissionState => {
          if (permissionState === 'granted') {
            this.enableMotionControl();
          } else {
            console.log("DeviceMotion permission denied.");
            const chk = document.getElementById('chk-use-tilt');
            if (chk) chk.checked = false;
            this.useTilt = false;
            narrator.speak("センサーのアクセス許可が得られなかったため、体移動操作は無効化されました。Bluetoothキーボードをお使いください。");
          }
        })
        .catch(err => {
          console.error("DeviceMotion permission error:", err);
          const chk = document.getElementById('chk-use-tilt');
          if (chk) chk.checked = false;
          this.useTilt = false;
        });
    } else if (typeof DeviceMotionEvent !== 'undefined' && ('ondevicemotion' in window || window.DeviceMotionEvent)) {
      // Android / 非iOS — 許可ダイアログ不要、そのまま有効化
      this.enableMotionControl();
    } else {
      // Windows PC またはセンサー非搭載端末 — キーボード操作のみ
      console.log("DeviceMotion is not supported on this device (PC or no sensor).");
      const chk = document.getElementById('chk-use-tilt');
      if (chk) chk.checked = false;
      this.useTilt = false;
      narrator.speak("この端末は加速度センサーに対応していないため、キーボードで操作してください。");
    }
  }

  /**
   * DeviceMotion（加速度センサー）イベントリスナーを登録し、体移動操作を有効化します。
   */
  enableMotionControl() {
    this.useTilt = true;

    if (this.state !== STATE_MENU && !this.screens.play.classList.contains('hidden')) {
      const btnCalibrate = document.getElementById('btn-calibrate-tilt');
      if (btnCalibrate) btnCalibrate.classList.remove('hidden');
    }

    // 既存リスナーの重複登録を防ぐ
    if (this.handleMotionBound) {
      window.removeEventListener('devicemotion', this.handleMotionBound);
    }
    this.handleMotionBound = (e) => this.handleDeviceMotion(e);
    window.addEventListener('devicemotion', this.handleMotionBound);

    this.updateCanvasAriaLabel();
    console.log("DeviceMotion (body movement) control successfully initialized.");
  }

  /**
   * DeviceMotionEvent を受け取り、横方向加速度をラケット速度に変換します。
   *
   * 座標系（端末を縦向き/横向きに関わらず統一）:
   *  - 縦向き (portrait)   : accelerationIncludingGravity.x が左右軸
   *  - 横向き90° (右が上)  : accelerationIncludingGravity.y が左右軸（符号反転）
   *  - 横向き-90° (左が上) : accelerationIncludingGravity.y が左右軸（符号そのまま）
   *
   * デッドゾーン  : ±1.5 m/s²（微細な手ブレを無視）
   * フルスケール  : ±8.0 m/s² でラケット最大速度
   *
   * @param {DeviceMotionEvent} event
   */
  handleDeviceMotion(event) {
    if (!this.useTilt) return;

    const accel = event.accelerationIncludingGravity;
    if (!accel) return;

    // 画面の向きに応じて左右加速度軸を選択
    const orientation = window.orientation
      || (screen.orientation && screen.orientation.angle)
      || 0;

    let rawX = 0;
    if (orientation === 90) {
      // 右が上になる横向き: Y軸が左右、正方向が右
      rawX = -(accel.y || 0);
    } else if (orientation === -90 || orientation === 270) {
      // 左が上になる横向き: Y軸が左右、正方向が左
      rawX = (accel.y || 0);
    } else {
      // 縦向き (0° / 180°): X軸が左右
      rawX = (accel.x || 0);
    }

    this.motionAccelX = rawX;

    // デッドゾーンと最大スケールを適用して 0.0〜1.0 に正規化
    const deadzone = 1.5;  // m/s²: これ以下の加速度は無視
    const maxAccel = 8.0;  // m/s²: これ以上でラケット最大速度

    let ratio = 0;
    if (Math.abs(rawX) > deadzone) {
      const effective = Math.abs(rawX) - deadzone;
      const range = maxAccel - deadzone;
      ratio = Math.min(effective / range, 1.0);
    }

    this.motionSpeed = ratio; // 0.0〜1.0
    this.tiltSpeed = ratio;   // updatePhysics の既存コードと互換

    // キー状態に反映（updatePhysics で keys['ArrowLeft/Right'] を参照しているため）
    if (rawX < -deadzone) {
      // 右向き加速度（体が右に動く → ラケットを右へ）
      this.keys['ArrowLeft'] = false;
      this.keys['ArrowRight'] = true;
    } else if (rawX > deadzone) {
      // 左向き加速度（体が左に動く → ラケットを左へ）
      this.keys['ArrowLeft'] = true;
      this.keys['ArrowRight'] = false;
    } else {
      // デッドゾーン内 → 静止
      this.keys['ArrowLeft'] = false;
      this.keys['ArrowRight'] = false;
      this.motionSpeed = 0;
      this.tiltSpeed = 0;
    }
  }

  /**
   * ラケット位置を画面中央にリセットします。
   * 加速度ドリフト等でラケットが端に寄った場合のリカバリ用。
   */
  resetPaddlePosition() {
    const paddle = this.role === 1 ? this.p1 : this.p2;
    if (paddle) {
      paddle.x = (CANVAS_WIDTH - PADDLE_WIDTH) / 2;
      if (this.mode === 'online') {
        this.syncPaddlePosition(paddle.x);
      }
    }
    console.log("Paddle position reset to center.");
  }

  updateCanvasAriaLabel() {
    const canvasContainer = document.getElementById('canvas-container');
    if (!canvasContainer) return;

    if (this.isMobile) {
      if (this.useTilt) {
        canvasContainer.setAttribute('aria-label', "サウンドテーブルテニス コート。スマートフォンを水平に持ち、体ごと左右に動いてラケットを操作します。画面をダブルタップして、サーブの準備、返答、サーブ、またはラリーの打ち返しを行います。");
      } else {
        canvasContainer.setAttribute('aria-label', "サウンドテーブルテニス コート。接続されたキーボード、または画面をダブルタップしてアクションを行います。");
      }
    } else {
      canvasContainer.setAttribute('aria-label', "サウンドテーブルテニス コート。キーボードの左右矢印キーでラケットを操作し、スペースキーでアクションを行います。");
    }
  }

  // ==========================================================================
  // 10. ゲームループ
  // ==========================================================================

  startLoop() {
    this.stopLoop();

    const loop = () => {
      if (this.state !== STATE_MENU) {
        this.updatePhysics();
        this.draw();
        this.rafId = requestAnimationFrame(loop);
      }
    };

    this.rafId = requestAnimationFrame(loop);
  }

  stopLoop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}

// ページロード時にエンジンを初期化
