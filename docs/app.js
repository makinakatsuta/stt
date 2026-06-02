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
const TABLE_FRICTION = 0.992; // ボールの摩擦減衰率 (転がりのシミュレーション)

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

// ==========================================================================
// 2. 音響システム (Web Audio API)
// ==========================================================================
class SoundSystem {
  constructor() {
    this.ctx = null;
    this.noiseBuffer = null;
    this.ballRollSource = null;
    this.ballRollGain = null;
    this.ballRollFilter = null;
    this.panner = null;
    this.isMuted = false;
  }

  /**
   * ユーザー操作をトリガーに AudioContext を初期化します。
   * (ブラウザの自動再生ブロック解除用)
   */
  init() {
    if (this.ctx) return;
    
    // クロスブラウザ対応で AudioContext を作成
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContextClass();
    
    // 3D定位用のステレオパンナーを作成
    if (this.ctx.createStereoPanner) {
      this.panner = this.ctx.createStereoPanner();
    } else {
      // 古いブラウザ用のフォールバック (PannerNode)
      this.panner = this.ctx.createPanner();
      this.panner.panningModel = 'HRTF';
    }
    
    // ボールの転がり音用のローパスフィルターを作成 (奥行き表現用)
    this.ballRollFilter = this.ctx.createBiquadFilter();
    this.ballRollFilter.type = 'lowpass';
    this.ballRollFilter.frequency.setValueAtTime(4000, this.ctx.currentTime);
    
    // ボールの転がり音用のゲインノードを作成 (音量調整用)
    this.ballRollGain = this.ctx.createGain();
    this.ballRollGain.gain.setValueAtTime(0, this.ctx.currentTime);
    
    // 音響ルートの接続: 転がり音 -> フィルター -> ゲイン -> パンナー -> 出力
    this.ballRollFilter.connect(this.ballRollGain);
    this.ballRollGain.connect(this.panner);
    this.panner.connect(this.ctx.destination);
    
    // ホワイトノイズのバッファを作成
    this.createNoiseBuffer();
    
    // ボール転がり音のループ再生を開始
    this.startBallRollLoop();
  }

  /**
   * ホワイトノイズの2秒分のバッファを生成します。
   */
  createNoiseBuffer() {
    const bufferSize = this.ctx.sampleRate * 2;
    this.noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
  }

  /**
   * 金属球が入ったボールの「シャラシャラ」という転がり音を生成・ループ再生します。
   */
  startBallRollLoop() {
    // 1. ノイズソース
    this.ballRollSource = this.ctx.createBufferSource();
    this.ballRollSource.buffer = this.noiseBuffer;
    this.ballRollSource.loop = true;
    
    // 転がり音をシャラシャラした金属音に近づけるため、ハイパスフィルターを設定 (カットオフを上げてシャープに)
    const highpass = this.ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.setValueAtTime(2200, this.ctx.currentTime);
    
    // 2. コトコト音用オシレーター (金属球が転がる低いゴロゴロ音を追加)
    const lowOsc = this.ctx.createOscillator();
    lowOsc.type = 'triangle';
    lowOsc.frequency.setValueAtTime(160, this.ctx.currentTime);
    
    // コトコト感を出すためのLFO (音量を細かく揺らす)
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(14, this.ctx.currentTime); // 14Hzの振動
    
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.setValueAtTime(0.08, this.ctx.currentTime);
    
    const lowOscGain = this.ctx.createGain();
    lowOscGain.gain.setValueAtTime(0.14, this.ctx.currentTime); // 低音ブレンド量
    
    // 接続
    lfo.connect(lfoGain);
    lfoGain.connect(lowOscGain.gain);
    
    this.ballRollSource.connect(highpass);
    highpass.connect(this.ballRollFilter);
    
    lowOsc.connect(lowOscGain);
    lowOscGain.connect(this.ballRollFilter);
    
    this.ballRollSource.start(0);
    lowOsc.start(0);
    lfo.start(0);
  }

  /**
   * ボールのリアルタイムな位置と速度に応じて、音量・パン・フィルターを更新します。
   * @param {number} x ボールのX座標 (0〜800)
   * @param {number} y ボールのY座標 (0〜500)
   * @param {number} vx ボールのX方向速度
   * @param {number} vy ボールのY方向速度
   */
  updateBallSound(x, y, vx, vy) {
    if (!this.ctx || this.isMuted) return;
    
    const speed = Math.sqrt(vx * vx + vy * vy);
    
    // 1. 左右のパンニング設定 (-1.0: 左端, +1.0: 右端)
    const panValue = (x / CANVAS_WIDTH) * 2 - 1;
    if (this.panner.pan) {
      this.panner.pan.setValueAtTime(panValue, this.ctx.currentTime);
    } else {
      // PannerNode フォールバックの場合
      this.panner.setPosition(panValue, 0, 1 - Math.abs(panValue));
    }
    
    // 2. 奥行き（Y座標）に応じたローパスフィルターの設定
    // 自分側 (Y=500) に近づくほどクリア (高周波数)、相手側 (Y=0) に遠ざかるほどこもる (低周波数)
    const yRatio = 1 - (y / CANVAS_HEIGHT); // 0 (自分側) 〜 1 (相手側)
    // 近づいたときに高音を完全開放(12000Hz)し、遠ざかったときは徹底的にこもらせる(500Hz)
    const targetFreq = 500 + (11500 * (1 - yRatio)); 
    this.ballRollFilter.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.05);
    
    // 3. ボールの速度と距離に応じた音量設定
    // 速度が速いほど大きく、相手側に遠ざかるほど少し音量を減衰させる
    let targetVolume = (speed / 10) * 0.4; // ベース音量を以前の0.4に戻す
    if (targetVolume > 1.0) targetVolume = 1.0;
    
    // 近づいてくる音をよりはっきりさせるため、非線形カーブで手前での音量を強調
    const distanceVolumeRatio = 0.3 + (0.7 * Math.pow(1 - yRatio, 1.5)); 
    targetVolume *= distanceVolumeRatio;
    
    if (speed < 0.1) targetVolume = 0; // 停止時は消音
    
    this.ballRollGain.gain.setTargetAtTime(targetVolume, this.ctx.currentTime, 0.05);
  }


  /**
   * プレイヤーが移動したときの足音（シューズの床摩擦音「キュッ」）を合成します。
   * @param {number} x プレイヤーのX座標 (パン用)
   */
  playFootstepSound(x) {
    if (!this.ctx || this.isMuted) return;
    
    const panVal = (x / CANVAS_WIDTH) * 2 - 1;
    const panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (panner) panner.pan.setValueAtTime(panVal, this.ctx.currentTime);
    
    // ホワイトノイズソース
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    
    // バンドパスフィルターで周波数帯を絞る (シューズの摩擦音らしい帯域)
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(2500, this.ctx.currentTime);
    filter.Q.setValueAtTime(3.0, this.ctx.currentTime); // Q値を高くして摩擦音的な響きにする
    
    const gain = this.ctx.createGain();
    // 非常に短い「キュッ」という音のエンベロープ
    gain.gain.setValueAtTime(0.0, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.12, this.ctx.currentTime + 0.01); // 素早い立ち上がり
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.08); // 素早い減衰 (80ms)
    
    if (panner) {
      noise.connect(filter);
      filter.connect(gain);
      gain.connect(panner);
      panner.connect(this.ctx.destination);
    } else {
      noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.ctx.destination);
    }
    
    noise.start();
    noise.stop(this.ctx.currentTime + 0.1);
  }

  /**
   * 打球音 (木製ラケットの「コン」という乾いた音) を合成します。
   * @param {number} x 衝突したX座標 (パン用)
   */
  playHitSound(x) {
    if (!this.ctx || this.isMuted) return;
    
    // パンナーを作成して位置を固定
    const panVal = (x / CANVAS_WIDTH) * 2 - 1;
    const panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (panner) panner.pan.setValueAtTime(panVal, this.ctx.currentTime);
    
    // 1. オシレーター（打球音の本体 - 基本波）
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    osc.type = 'sine'; // 澄んだ「コン」という響きを作るサイン波
    // 周波数を550Hzから180Hzへスウィープさせて打球感を作る
    osc.frequency.setValueAtTime(550, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(180, this.ctx.currentTime + 0.09);
    
    gain.gain.setValueAtTime(1.0, this.ctx.currentTime); // 最大ゲインを1.0に増加 (以前は0.7)
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.16); // 減衰時間を0.16秒に伸ばし、余韻をはっきりさせる
    
    // 2. 2次倍音オシレーター（打球の「カツッ」という硬い質感と明瞭さを加える）
    const osc2 = this.ctx.createOscillator();
    const gain2 = this.ctx.createGain();
    
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(1100, this.ctx.currentTime); // メインの約2倍の周波数
    osc2.frequency.exponentialRampToValueAtTime(360, this.ctx.currentTime + 0.07);
    
    gain2.gain.setValueAtTime(0.25, this.ctx.currentTime); // メイン音にブレンド
    gain2.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.08); // 早めに減衰させて打球のアタック感のみを強調
    
    // 3. アタックノイズ (打球時の瞬間的な木製アタック音)
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    
    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(1800, this.ctx.currentTime);
    
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.55, this.ctx.currentTime); // ゲインを0.55に強化 (以前は0.4)
    noiseGain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.03); // 30msで消音
    
    // 接続
    if (panner) {
      osc.connect(gain);
      gain.connect(panner);
      
      osc2.connect(gain2);
      gain2.connect(panner);
      
      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(panner);
      
      panner.connect(this.ctx.destination);
    } else {
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      
      osc2.connect(gain2);
      gain2.connect(this.ctx.destination);
      
      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(this.ctx.destination);
    }
    
    osc.start();
    osc2.start();
    noise.start();
    
    osc.stop(this.ctx.currentTime + 0.20);
    osc2.stop(this.ctx.currentTime + 0.10);
    noise.stop(this.ctx.currentTime + 0.04);
  }

  /**
   * フレーム衝突音 (サイド/エンドフレームに当たった時の「カツ」という高い音)
   * @param {number} x 衝突したX座標 (パン用)
   */
  playFrameSound(x) {
    if (!this.ctx || this.isMuted) return;
    
    const panVal = (x / CANVAS_WIDTH) * 2 - 1;
    const panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (panner) panner.pan.setValueAtTime(panVal, this.ctx.currentTime);
    
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    osc.type = 'sine';
    // 高めの周波数で素早い減衰により、フレームの硬い木製音をシミュレート
    osc.frequency.setValueAtTime(750, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(200, this.ctx.currentTime + 0.05);
    
    gain.gain.setValueAtTime(0.5, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.06);
    
    if (panner) {
      osc.connect(gain);
      gain.connect(panner);
      panner.connect(this.ctx.destination);
    } else {
      osc.connect(gain);
      gain.connect(this.ctx.destination);
    }
    
    osc.start();
    osc.stop(this.ctx.currentTime + 0.07);
  }

  /**
   * ネット衝突音 (布に当たった時の「ポス」というこもった音)
   * @param {number} x 衝突したX座標
   */
  playNetSound(x) {
    if (!this.ctx || this.isMuted) return;
    
    const panVal = (x / CANVAS_WIDTH) * 2 - 1;
    const panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (panner) panner.pan.setValueAtTime(panVal, this.ctx.currentTime);
    
    // ネットの音はノイズ＋ローパスフィルターで表現
    const bufferSource = this.ctx.createBufferSource();
    bufferSource.buffer = this.noiseBuffer;
    
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(350, this.ctx.currentTime); // 低周波のみ通す
    
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.6, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.15);
    
    if (panner) {
      bufferSource.connect(filter);
      filter.connect(gain);
      gain.connect(panner);
      panner.connect(this.ctx.destination);
    } else {
      bufferSource.connect(filter);
      filter.connect(gain);
      gain.connect(this.ctx.destination);
    }
    
    bufferSource.start();
    bufferSource.stop(this.ctx.currentTime + 0.16);
  }

  /**
   * アウト / 失敗音 (低いブザー音のような合成音)
   */
  playMissSound() {
    if (!this.ctx || this.isMuted) return;
    
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    osc1.type = 'sawtooth';
    osc2.type = 'sawtooth';
    
    osc1.frequency.setValueAtTime(130, this.ctx.currentTime);
    osc2.frequency.setValueAtTime(133, this.ctx.currentTime); // デチューンで濁らせる
    
    gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.4);
    
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(this.ctx.destination);
    
    osc1.start();
    osc2.start();
    
    osc1.stop(this.ctx.currentTime + 0.45);
    osc2.stop(this.ctx.currentTime + 0.45);
  }
}

const sounds = new SoundSystem();

// ==========================================================================
// 3. 音声合成・案内システム (Web Speech API / Screen Reader 補助)
// ==========================================================================
class SpeechSystem {
  constructor() {
    this.synth = window.speechSynthesis;
    this.voice = null;
    this.srAnnouncer = document.getElementById('sr-announcer');
    this.refereeMessage = document.getElementById('referee-message');
    
    // 日本語の音声を検索してセットする
    if (this.synth) {
      // 音声リストの変更イベントをリッスン (Chrome等の遅延ロード対策)
      this.synth.onvoiceschanged = () => this.loadVoice();
      this.loadVoice();
    }
  }

  loadVoice() {
    const voices = this.synth.getVoices();
    // Googleの日本語音声、または日本語のデフォルト音声を優先的に選択
    this.voice = voices.find(v => v.lang === 'ja-JP' && v.name.includes('Google')) || 
                 voices.find(v => v.lang === 'ja-JP') || 
                 null;
  }

  /**
   * 主審やプレイヤーの発声を再生し、同時にスクリーンリーダー用のaria-liveテキストと画面表示を更新します。
   * @param {string} text 発声するテキスト
   * @param {boolean} isReferee 主審としての発声かどうか (主審は少し高く、低テンポ)
   */
  speak(text, isReferee = true) {
    // 1. スクリーンリーダーのテキストを更新 (最優先で読み上げさせる)
    try {
      if (this.srAnnouncer) {
        this.srAnnouncer.textContent = ''; // 一度クリアして確実に変更を検知させる
        setTimeout(() => {
          this.srAnnouncer.textContent = text;
        }, 50);
      }
    } catch (e) {
      console.warn("Failed to announce to screen reader:", e);
    }

    // 2. ビジュアルの審判コールテキストを更新
    try {
      if (isReferee && this.refereeMessage) {
        this.refereeMessage.textContent = `「 ${text} 」`;
        this.refereeMessage.classList.remove('fade-in');
        void this.refereeMessage.offsetWidth; // リフローをトリガーしてアニメーションをリセット
        this.refereeMessage.classList.add('fade-in');
      }
    } catch (e) {
      console.warn("Failed to update visual call text:", e);
    }

    // 3. Web Speech APIによる発声 (シークレットモード等の制限に備えtry-catch保護)
    try {
      if (this.synth) {
        this.synth.cancel();
        
        const utterance = new SpeechSynthesisUtterance(text);
        if (this.voice) {
          utterance.voice = this.voice;
        }
        utterance.lang = 'ja-JP';
        utterance.rate = isReferee ? 1.3 : 1.1; 
        utterance.pitch = isReferee ? 1.0 : 1.1;
        
        this.synth.speak(utterance);
      }
    } catch (e) {
      console.warn("Web Speech API failed to speak:", e);
    }
  }

  /**
   * 音声の出力を強制停止します。
   */
  stop() {
    if (this.synth) {
      this.synth.cancel();
    }
  }
}

const narrator = new SpeechSystem();

// ==========================================================================
// 4. WebSocket オンライン通信システム
// ==========================================================================
class NetworkSystem {
  constructor(onMessageCallback) {
    this.ws = null;
    this.clientId = 'p-' + Math.random().toString(36).substr(2, 9);
    this.roomId = '';
    this.onMessage = onMessageCallback;
    this.onDisconnect = null;
    this.onError = null;
    this.pingInterval = null;
    this.latency = 0;
  }

  /**
   * WebSocketサーバーへ接続します。
   * @param {string} roomId 部屋ID
   */
  connect(roomId) {
    this.roomId = roomId || 'lobby';
    
    // プロトコルとホスト名を自動判定して接続先を決定
    let proto = 'ws:';
    let host = 'localhost:8080'; // デフォルトのフォールバック
    
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      host = window.location.host;
    } else {
      console.warn("File protocol detected. Falling back WebSocket connection host to localhost:8080");
    }
    
    const wsUrl = `${proto}//${host}/ws?room=${this.roomId}&id=${this.clientId}`;
    
    this.ws = new WebSocket(wsUrl);
    
    this.ws.onopen = () => {
      console.log('Connected to Game Server');
      // Pingによるレイテンシ測定を開始
      this.startPing();
    };
    
    this.ws.onmessage = (event) => {
      // 複数メッセージが改行区切りで送られてくる可能性があるため分割して処理
      const lines = event.data.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          
          // サーバからの内部的なPingレスポンスを処理
          if (msg.type === 'pong') {
            const sendTime = parseInt(msg.payload.sendTime, 10);
            this.latency = Date.now() - sendTime;
            continue;
          }
          
          // その他のゲームメッセージはコールバックへ
          this.onMessage(msg);
        } catch (e) {
          console.error('Error parsing WS message:', e, line);
        }
      }
    };
    
    this.ws.onclose = () => {
      console.log('Disconnected from Game Server');
      this.stopPing();
      if (this.onDisconnect) this.onDisconnect();
    };
    
    this.ws.onerror = (err) => {
      console.error('WS Error:', err);
      if (this.onError) this.onError(err);
    };
  }

  /**
   * サーバーにメッセージを送信します。
   * @param {string} type メッセージタイプ
   * @param {object} payload 送信するオブジェクト
   */
  send(type, payload = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg = {
        type: type,
        sender: this.clientId,
        payload: payload
      };
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * 接続を遮断します。
   */
  disconnect() {
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  startPing() {
    this.pingInterval = setInterval(() => {
      this.send('ping', { sendTime: Date.now().toString() });
    }, 3000);
  }

  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

// ==========================================================================
// 5. ゲーム物理 ＆ ビジュアルエンジン
// ==========================================================================
class GameEngine {
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
    this.ball = { x: 400, y: 250, vx: 0, vy: 0, active: false };
    this.p1 = { x: 350, y: Y_DEFENSE_P1 + 50 }; // 手前 (自分)
    this.p2 = { x: 350, y: Y_DEFENSE_P2 - 50 }; // 奥 (相手 / CPU)
    
    // 得点とゲーム設定
    this.scores = { p1: 0, p2: 0 };
    this.serverRole = 1; // 現在のサーバー (1 or 2)
    this.matchGames = 5; // 5ゲームマッチ
    this.maxScore = 11;  // 11点先取
    
    // タイムアウト管理 (公式5秒ルールなどのチェック用)
    this.stateStartTime = 0;
    this.timerInterval = null;

    // キー入力状態
    this.keys = {
      ArrowLeft: false,
      ArrowRight: false
    };
    this.lastFootstepTime = 0;
    this.lastMyPaddleX = 350;
    
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
    this.tiltCalibrationAngle = 0;
    this.currentRawTilt = 0;
    this.handleOrientationBound = null;

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

    // チルト切り替えチェックボックスの変更監視
    const useTiltCheckbox = document.getElementById('chk-use-tilt');
    if (useTiltCheckbox) {
      useTiltCheckbox.addEventListener('change', (e) => {
        if (e.target.checked) {
          this.requestDeviceOrientationPermission();
        } else {
          this.useTilt = false;
          // キー状態のクリア
          this.keys['ArrowLeft'] = false;
          this.keys['ArrowRight'] = false;
          this.keys['KeyA'] = false;
          this.keys['KeyD'] = false;
          document.getElementById('btn-calibrate-tilt').classList.add('hidden');
          this.updateCanvasAriaLabel();
        }
      });
    }

    // チルト調整ボタンのクリック
    const btnCalibrate = document.getElementById('btn-calibrate-tilt');
    if (btnCalibrate) {
      btnCalibrate.addEventListener('click', () => {
        this.calibrateTilt();
        narrator.speak("チルトの中心位置を調整しました。");
      });
    }

    // ゲーム画面タップによるアクション (スマホ・アクセシビリティ対応)
    const canvasContainer = document.getElementById('canvas-container');
    if (canvasContainer) {
      canvasContainer.addEventListener('click', (e) => {
        // プレイ中のステートでのみタップでアクションを実行
        const activeStates = [STATE_PRE_SERVE_READY, STATE_PRE_SERVE_HEARD, STATE_SERVE_WAITING, STATE_RALLY];
        if (activeStates.includes(this.state)) {
          if (e.target.id === 'game-canvas' || e.target.id === 'canvas-container') {
            e.preventDefault();
            this.handleActionInput();
          }
        }
      });
    }

    // 1. オーディオ有効化ボタン
    document.getElementById('btn-enable-audio').addEventListener('click', () => {
      sounds.init();
      
      const useTiltCheckbox = document.getElementById('chk-use-tilt');
      const useTilt = useTiltCheckbox ? useTiltCheckbox.checked : false;
      if (this.isMobile && useTilt) {
        this.requestDeviceOrientationPermission();
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

    // 2.5 難易度選択ボタン
    document.getElementById('btn-diff-easy').addEventListener('click', () => {
      this.difficulty = 'easy';
      this.startNewMatch();
    });
    document.getElementById('btn-diff-normal').addEventListener('click', () => {
      this.difficulty = 'normal';
      this.startNewMatch();
    });
    document.getElementById('btn-diff-hard').addEventListener('click', () => {
      this.difficulty = 'hard';
      this.startNewMatch();
    });
    document.getElementById('btn-difficulty-back').addEventListener('click', () => {
      this.changeScreen('menu');
    });

    // 3. モード選択: オンライン戦
    document.getElementById('btn-mode-online').addEventListener('click', () => {
      this.mode = 'online';
      this.changeScreen('lobby');
      narrator.speak("オンラインロビーです。対戦相手と同じルームIDを入力して、ルームに入るボタンを押してください。空白のままだと、共通のロビールームに入ります。");
      document.getElementById('input-room-id').focus();
    });

    // 4. ロビー: 接続開始
    document.getElementById('btn-join-room').addEventListener('click', () => {
      const roomId = document.getElementById('input-room-id').value.trim();
      this.changeScreen('waiting');
      this.state = STATE_WAITING_OPPONENT; // 待機中ステートを設定
      document.getElementById('lbl-current-room').textContent = roomId || '自動マッチング';
      narrator.speak("サーバーに接続しています。対戦相手を待っています。");
      this.net.connect(roomId);
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

    // 8. ゲームプレイ中断
    document.getElementById('btn-quit-game').addEventListener('click', () => {
      this.quitGame();
    });

    // キーボード入力の監視
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      
      // スペースキーによるアクション制御 (スクロール防止)
      if (e.code === 'Space') {
        e.preventDefault();
        this.handleActionInput();
      }
      
      // Escキーによる中断
      if (e.code === 'Escape') {
        if (this.state !== STATE_MENU) {
          this.quitGame();
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
    });

    // Canvasへのフォーカス制御 (矢印キーでのブラウザスクロール防止)
    this.canvas.addEventListener('keydown', (e) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
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
    this.net.disconnect();
    this.state = STATE_MENU;
    sounds.updateBallSound(400, 250, 0, 0); // 音を止める
    narrator.stop();
    this.changeScreen('menu');
    
    // チルト調整ボタンを非表示化、キーのクリア
    const btnCalibrate = document.getElementById('btn-calibrate-tilt');
    if (btnCalibrate) btnCalibrate.classList.add('hidden');
    this.keys['ArrowLeft'] = false;
    this.keys['ArrowRight'] = false;
    this.keys['KeyA'] = false;
    this.keys['KeyD'] = false;
    this.updateCanvasAriaLabel();

    narrator.speak("ゲームを終了し、メニューに戻りました。");
  }

  handleNetworkDisconnect() {
    // プレイ中や待機中に予期せず切断された場合
    if (this.state === STATE_WAITING_OPPONENT || this.state === STATE_RALLY || this.state === STATE_PRE_SERVE_READY || this.state === STATE_PRE_SERVE_HEARD || this.state === STATE_SERVE_WAITING) {
      narrator.speak("サーバーから切断されました。メインメニューに戻ります。", true);
      this.quitGame();
    }
  }

  handleNetworkError() {
    narrator.speak("サーバーへの接続に失敗しました。実行ファイルが起動しているか確認してください。", true);
    // 2秒後にメニューに戻る
    setTimeout(() => {
      this.quitGame();
    }, 2000);
  }

  // ==========================================================================
  // 6. オンライン通信メッセージ処理
  // ==========================================================================
  handleNetworkMessage(msg) {
    switch (msg.type) {
      case 'init':
        // 役割の確定 (1: 手前 / 2: 奥)
        this.role = msg.payload.role;
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

      case 'error':
        alert(msg.payload.message);
        this.quitGame();
        break;
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
          document.getElementById('play-instructions').textContent = "スペースキーを押して「はい」と返答してください (5秒以内)。";
        }
      } 
      else if (payload.call === 'hai') {
        this.state = STATE_SERVE_WAITING;
        this.stateStartTime = Date.now();
        narrator.speak("はい", false);
        
        if (this.isMyTurnToServe()) {
          document.getElementById('play-instructions').textContent = "5秒以内にスペースキーを押してサーブを打ってください！";
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
      
      document.getElementById('play-instructions').textContent = "ラリー中！ボールが近づいたらスペースキーで打ち返してください！";

      // 音波エフェクト（サーブ位置）
      this.addRipple(this.ball.x, this.ball.y, 'serve');
      sounds.playHitSound(this.ball.x);
    } 
    else if (payload.actionType === 'ball_hit') {
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
      this.addRipple(this.ball.x, this.ball.y, 'hit');
    }
    else if (payload.actionType === 'point') {
      // 得点の決定
      this.scores.p1 = payload.score1;
      this.scores.p2 = payload.score2;
      this.updateScoreboard();
      
      this.awardPointTo(payload.winner, payload.reason);
    }
  }

  // ==========================================================================
  // 7. ゲームプレイ制御 (ロジック・ステート)
  // ==========================================================================
  
  /**
   * 新しいマッチ(5ゲームマッチ)を開始します。
   */
  startNewMatch() {
    this.scores.p1 = 0;
    this.scores.p2 = 0;
    // CPU対戦時はレシーブ練習のために常にCPU(Player2)がサーブ権を持ち、オンライン対戦時はPlayer1が持ちます
    this.serverRole = this.mode === 'cpu' ? 2 : 1; 
    
    // UIの切り替え
    this.changeScreen('play');

    // モバイルのチルト自動調整および調整ボタンの表示制御
    if (this.isMobile && this.useTilt) {
      setTimeout(() => {
        this.calibrateTilt();
      }, 500); // 手の傾きが安定するまで少し待って自動調整
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
   */
  prepareServeSequence() {
    this.state = STATE_PRE_SERVE_READY;
    this.stateStartTime = Date.now();
    this.ball.active = false;
    
    // ボールをサーバーの目の前に配置
    if (this.serverRole === 1) {
      // Player 1 (下側) がサーブ
      this.ball.x = 600; // サービスエリア(右半分)の中央付近
      this.ball.y = Y_DEFENSE_P1 + 20;
    } else {
      // Player 2 (上側) がサーブ
      this.ball.x = 200; // 相手側のサービスエリア(相手から見て右、自分から見て左)
      this.ball.y = Y_DEFENSE_P2 - 20;
    }
    this.ball.vx = 0;
    this.ball.vy = 0;
    
    // 主審の「プレー」宣告
    narrator.speak("プレー", true);
    
    if (this.isMyTurnToServe()) {
      document.getElementById('play-instructions').textContent = "スペースキーを押して「いきます」と発声してください (10秒以内)。";
    } else {
      document.getElementById('play-instructions').textContent = "相手の「いきます」の発声を待っています...";
      
      // CPU対戦かつCPUがサーバーの場合、一定時間後にCPUが自動で「いきます」と発声
      if (this.mode === 'cpu' && this.serverRole === 2) {
        setTimeout(() => {
          if (this.state === STATE_PRE_SERVE_READY) {
            this.state = STATE_PRE_SERVE_HEARD;
            this.stateStartTime = Date.now();
            narrator.speak("いきます", false);
            document.getElementById('play-instructions').textContent = "スペースキーを押して「はい」と返答してください (5秒以内)。";
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
            setTimeout(() => {
              if (this.state === STATE_SERVE_WAITING) {
                this.state = STATE_RALLY;
                this.ball.active = true;
                
                document.getElementById('play-instructions').textContent = "ラリー中！ボールが近づいたらスペースキーで打ち返してください！";

                // 相手から自分へ (Yをプラス方向へ)
                // 難易度に応じてサーブの速度や角度を調整
                let speedMultiplier = 1.0;
                if (this.difficulty === 'easy') speedMultiplier = 0.8;
                if (this.difficulty === 'hard') speedMultiplier = 1.25;
                
                this.ball.vx = (2.0 + Math.random() * 2.0) * speedMultiplier;
                this.ball.vy = 5.5 * speedMultiplier;
                
                sounds.playHitSound(this.ball.x);
                this.addRipple(this.ball.x, this.ball.y, 'serve');
              }
            }, 1200 + Math.random() * 800); // 1.2〜2.0秒後にサーブ
          }
        }
      }
    } 
    else if (this.state === STATE_SERVE_WAITING) {
      // 3. サーバーによるサーブ実行
      if (this.isMyTurnToServe()) {
        this.state = STATE_RALLY;
        this.ball.active = true;
        
        document.getElementById('play-instructions').textContent = "ラリー中！ボールが近づいたらスペースキーで打ち返してください！";

        // サーブの初速度設定 (相手方向へ)
        if (this.serverRole === 1) {
          // 自分から相手へ (Yをマイナス方向へ)
          // サービスエリア(右半分)からレシーブエリア(左半分)へ転がるように角度を設定
          this.ball.vx = -2.5 - Math.random() * 2.0; 
          this.ball.vy = -6.0;
        } else {
          // 相手から自分へ (Yをプラス方向へ)
          this.ball.vx = 2.5 + Math.random() * 2.0;
          this.ball.vy = 6.0;
        }
        
        sounds.playHitSound(this.ball.x);
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
      // 4. ラリー中のスペースキー入力による打ち返し
      const paddle = this.role === 1 ? this.p1 : this.p2;
      const defenseY = this.role === 1 ? Y_DEFENSE_P1 : Y_DEFENSE_P2;
      const isIncoming = (this.role === 1 && this.ball.vy > 0) || (this.role === 2 && this.ball.vy < 0);
      const isNearPaddle = Math.abs(this.ball.y - defenseY) < 30; // 守備ライン付近30px
      const hitPaddle = this.ball.x >= paddle.x && this.ball.x <= paddle.x + PADDLE_WIDTH;
                           
      if (isIncoming && isNearPaddle && hitPaddle) {
        // 打ち返し成功！
        this.ball.y = defenseY; // 位置補正
        const relativeHitPos = (this.ball.x - (paddle.x + PADDLE_WIDTH / 2)) / (PADDLE_WIDTH / 2);
        this.ball.vx = relativeHitPos * 4.0;
        
        if (this.role === 1) {
          this.ball.vy = -Math.abs(this.ball.vy) * 1.05; // 上方向（-Y）へ打ち返す
        } else {
          this.ball.vy = Math.abs(this.ball.vy) * 1.05;  // 下方向（+Y）へ打ち返す
        }
        
        sounds.playHitSound(this.ball.x);
        this.addRipple(this.ball.x, this.ball.y, 'hit');
        
        if (this.mode === 'online') {
          this.net.send('action', { 
            actionType: 'ball_hit', 
            x: this.ball.x, 
            y: this.ball.y, 
            vx: this.ball.vx, 
            vy: this.ball.vy 
          });
        }
      }
    }
  }

  /**
   * 得点獲得処理。得点理由と勝者をアナウンスし、次のラリーへ。
   * @param {number} winner 勝者プレイヤー番号 (1 or 2)
   * @param {string} reason 理由 ('miss', 'serve_fault', 'out', 'stop', 'overtime')
   */
  awardPointTo(winner, reason) {
    this.state = STATE_POINT_WON;
    this.ball.active = false;
    
    // 効果音の再生
    if (winner === this.role) {
      // 自分の得点
      sounds.playFrameSound(CANVAS_WIDTH / 2);
    } else {
      // 相手の得点
      sounds.playMissSound();
    }
    
    // 得点の理由案内テキスト
    let reasonText = "";
    switch (reason) {
      case 'miss':
        reasonText = "リターンミス";
        break;
      case 'serve_fault':
        reasonText = "サービスフォルト";
        break;
      case 'out':
        reasonText = "アウト";
        break;
      case 'stop':
        reasonText = "守備コート外での停止";
        break;
      case 'overtime':
        reasonText = "制限時間オーバー";
        break;
    }
    
    // コール発声: 「ポイント [P1/P2]」
    const winnerName = winner === 1 ? "プレイヤー 1" : "プレイヤー 2";
    
    // デュース判定などの公式スコア計算
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

    const scoreAnnounce = `${reasonText}。ポイント、${winnerName}。 ${this.scores.p1} 対 ${this.scores.p2}。`;
    narrator.speak(scoreAnnounce, true);
    
    // 試合終了判定 (11点先取、デュース時は2点差)
    const p1 = this.scores.p1;
    const p2 = this.scores.p2;
    const isGameFinished = (p1 >= this.maxScore || p2 >= this.maxScore) && Math.abs(p1 - p2) >= 2;
    
    setTimeout(() => {
      if (isGameFinished) {
        this.finishGame(p1 > p2 ? 1 : 2);
      } else {
        // 次のサーブ権の移行チェック
        if (this.mode === 'cpu') {
          // CPU戦ではプレイヤーのレシーブ（守備）練習を優先するため、常にCPUがサーブを打つように固定
          this.serverRole = 2;
        } else {
          // オンライン対戦時は、合算スコアが2の倍数のとき、またはデュース（10:10以降）は1ポイントごとにサーブ交代
          const total = p1 + p2;
          if (p1 >= 10 && p2 >= 10) {
            this.serverRole = this.serverRole === 1 ? 2 : 1;
          } else if (total > 0 && total % 2 === 0) {
            this.serverRole = this.serverRole === 1 ? 2 : 1;
          }
        }
        
        this.prepareServeSequence();
      }
    }, 4000);
  }

  /**
   * オンライン対戦において、Player1をスコア決定のマスターとします。
   */
  isServerAndDecider() {
    return this.role === 1;
  }

  /**
   * ゲームの決着がついた際の終了処理。
   */
  finishGame(gameWinner) {
    const winnerName = gameWinner === 1 ? "プレイヤー 1" : "プレイヤー 2";
    narrator.speak(`ゲームセット！ 勝者は ${winnerName} です！`, true);
    
    setTimeout(() => {
      this.quitGame();
    }, 5000);
  }

  // ==========================================================================
  // 8. 物理エンジン & CPU AI
  // ==========================================================================

  /**
   * ゲームの物理アップデート (1フレームごとの処理)。
   */
  updatePhysics() {
    try {
      // Go WebAssembly版の物理演算がロードされている場合はそれを使用
      if (typeof window.updatePhysicsWasm === 'function') {
      const result = window.updatePhysicsWasm(
        this.ball,
        this.p1,
        this.p2,
        this.keys,
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

        // 自分（プレイヤー）のラケットの移動音（足音）の処理
        const myPaddleX = this.role === 1 ? this.p1.x : this.p2.x;
        if (Math.abs(myPaddleX - this.lastMyPaddleX) > 0.01) {
          const now = Date.now();
          if (now - this.lastFootstepTime > 250) { // 250ms 間隔
            sounds.playFootstepSound(myPaddleX);
            this.lastFootstepTime = now;
          }
        }
        this.lastMyPaddleX = myPaddleX;

        // パドル位置の同期 (オンライン対戦用)
        const paddle = this.role === 1 ? this.p1 : this.p2;
        this.syncPaddlePosition(paddle.x);

        // ボール状態の更新
        this.ball.x = result.ball.x;
        this.ball.y = result.ball.y;
        this.ball.vx = result.ball.vx;
        this.ball.vy = result.ball.vy;
        this.ball.active = result.ball.active;

        // 立体音響のアップデート
        if (this.ball.active && this.state === STATE_RALLY) {
          sounds.updateBallSound(this.ball.x, this.ball.y, this.ball.vx, this.ball.vy);
        }

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
              this.addRipple(evt.x, evt.y, 'hit');
              
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
              if (this.mode === 'online') {
                if (this.role === 1) {
                  // ホスト(Player1)が得点を決定する
                  if (evt.winner === 2) {
                    // 自分がミスした場合は即座に判定
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
                  // クライアント(Player2)はホストからの得点同期メッセージを待つため、ローカルのscoreイベントは無視する
                  if (evt.reason === 'stop') {
                    sounds.updateBallSound(this.ball.x, this.ball.y, 0, 0);
                  }
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

    // 1. プレイヤーのラケット移動 (矢印キー / A,Dキー)
    const speed = 7;
    const paddle = this.role === 1 ? this.p1 : this.p2;
    
    if (this.keys['ArrowLeft'] || this.keys['KeyA']) {
      paddle.x -= speed;
      if (paddle.x < 0) paddle.x = 0;
      this.syncPaddlePosition(paddle.x);
    }
    if (this.keys['ArrowRight'] || this.keys['KeyD']) {
      paddle.x += speed;
      if (paddle.x > CANVAS_WIDTH - PADDLE_WIDTH) paddle.x = CANVAS_WIDTH - PADDLE_WIDTH;
      this.syncPaddlePosition(paddle.x);
    }

    // 2. CPUのAI (CPU戦かつ相手のターン時)
    if (this.mode === 'cpu' && this.state === STATE_RALLY && this.ball.vy < 0) {
      // 難易度に応じたCPUの追従速度とブレを設定
      let cpuSpeed = 5.0;
      let targetOffset = 0;
      
      switch (this.difficulty) {
        case 'easy':
          cpuSpeed = 3.0; // 移動速度が遅い
          // 意図的にブレ（ズレ）を生じさせて中央から外しやすくする
          targetOffset = Math.sin(Date.now() / 150) * 45;
          break;
        case 'normal':
          cpuSpeed = 5.2; // 標準の速度
          targetOffset = Math.sin(Date.now() / 300) * 15; // わずかなブレ
          break;
        case 'hard':
          cpuSpeed = 8.5; // 非常に速い
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
    if (this.ball.active && this.state === STATE_RALLY) {
      // 摩擦による減速
      this.ball.vx *= TABLE_FRICTION;
      this.ball.vy *= TABLE_FRICTION;
      
      this.ball.x += this.ball.vx;
      this.ball.y += this.ball.vy;
      
      // 立体音響のアップデート
      sounds.updateBallSound(this.ball.x, this.ball.y, this.ball.vx, this.ball.vy);

      // --- 左右サイドフレーム (X=0, X=800) の衝突判定 ---
      if (this.ball.x - BALL_RADIUS <= 0) {
        this.ball.x = BALL_RADIUS;
        this.ball.vx = -this.ball.vx * 0.85; // 反発係数
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
          if (hitPaddle) {
            this.ball.y = Y_DEFENSE_P1;
            const relativeHitPos = (this.ball.x - (this.p1.x + PADDLE_WIDTH / 2)) / (PADDLE_WIDTH / 2);
            this.ball.vx = relativeHitPos * 4.0;
            this.ball.vy = -Math.abs(this.ball.vy) * 1.05;
            
            sounds.playHitSound(this.ball.x);
            this.addRipple(this.ball.x, this.ball.y, 'hit');
          }
        }
      }

      // --- プレイヤー2 (奥相手 Y=100〜0) の衝突/打ち返し判定 ---
      if (this.ball.vy < 0 && this.ball.y <= Y_DEFENSE_P2 && this.ball.y >= Y_DEFENSE_P2 - 25) {
        // P2がCPUの場合のみ自動で打ち返す（人間プレイヤーの場合はSpaceキー入力でのみ打ち返せる）
        const isP2Cpu = (this.mode === 'cpu' && this.role === 1);
        if (isP2Cpu) {
          const hitPaddle = this.ball.x >= this.p2.x && this.ball.x <= this.p2.x + PADDLE_WIDTH;
          if (hitPaddle) {
            this.ball.y = Y_DEFENSE_P2;
            const relativeHitPos = (this.ball.x - (this.p2.x + PADDLE_WIDTH / 2)) / (PADDLE_WIDTH / 2);
            this.ball.vx = relativeHitPos * 4.0;
            this.ball.vy = Math.abs(this.ball.vy) * 1.05;
            
            sounds.playHitSound(this.ball.x);
            this.addRipple(this.ball.x, this.ball.y, 'hit');
          }
        }
      }

      // --- 得点・アウト・停止などの判定 (どちらか一方がミスした場合) ---
      
      // 1. 自分側 (P1) のエンドライン到達
      if (this.ball.y > CANVAS_HEIGHT) {
        // ラケットで打ち返せず奥に抜けた -> 相手(P2)の得点
        this.awardPointTo(2, 'miss');
      }
      
      // 2. 相手側 (P2) のエンドライン到達
      else if (this.ball.y < 0) {
        // 相手が打ち返せず奥に抜けた -> 自分(P1)の得点
        this.awardPointTo(1, 'miss');
      }

      // 3. ボールの摩擦停止判定 (守備ライン手前で停止した場合は失点)
      const ballSpeed = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
      if (ballSpeed < 0.12) {
        // ボールが止まった
        this.ball.vx = 0;
        this.ball.vy = 0;
        sounds.updateBallSound(this.ball.x, this.ball.y, 0, 0);
        
        // 停止したコートの位置によってポイントを決定
        if (this.ball.y > Y_NET) {
          // 自分(P1)のコート内で停止した -> 相手(P2)のポイント
          this.awardPointTo(2, 'stop');
        } else {
          // 相手(P2)のコート内で停止した -> 自分(P1)のポイント
          this.awardPointTo(1, 'stop');
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
    if (this.mode === 'online') {
      // 30ms以内に連続で送信しないようにスロットルをかけるなど調整できますが、
      // ここでは簡易的に直近位置を送信します
      this.net.send('action', { actionType: 'paddle', x: x });
    }
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

  // ==========================================================================
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
    
    // ボール (ネオングリーン)
    ctx.fillStyle = '#39ff14';
    ctx.beginPath();
    ctx.arc(netX - 20, tblY - 6, 4.5, 0, Math.PI * 2);
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

  requestDeviceOrientationPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission()
        .then(permissionState => {
          if (permissionState === 'granted') {
            this.enableTiltControl();
          } else {
            console.log("DeviceOrientation permission denied.");
            const chk = document.getElementById('chk-use-tilt');
            if (chk) chk.checked = false;
            this.useTilt = false;
            narrator.speak("センサーのアクセス許可が得られなかったため、チルト操作は無効化されました。Bluetoothキーボードをお使いください。");
          }
        })
        .catch(err => {
          console.error("DeviceOrientation permission error:", err);
          const chk = document.getElementById('chk-use-tilt');
          if (chk) chk.checked = false;
          this.useTilt = false;
        });
    } else {
      if ('ondeviceorientation' in window || 'DeviceOrientationEvent' in window) {
        this.enableTiltControl();
      } else {
        console.log("DeviceOrientation is not supported on this device.");
        const chk = document.getElementById('chk-use-tilt');
        if (chk) chk.checked = false;
        this.useTilt = false;
        narrator.speak("この端末はチルト操作用のセンサーに対応していません。");
      }
    }
  }

  enableTiltControl() {
    this.useTilt = true;
    
    if (this.state !== STATE_MENU && !this.screens.play.classList.contains('hidden')) {
      const btnCalibrate = document.getElementById('btn-calibrate-tilt');
      if (btnCalibrate) btnCalibrate.classList.remove('hidden');
    }
    
    if (this.handleOrientationBound) {
      window.removeEventListener('deviceorientation', this.handleOrientationBound);
    }
    this.handleOrientationBound = (e) => this.handleDeviceOrientation(e);
    window.addEventListener('deviceorientation', this.handleOrientationBound);
    
    this.updateCanvasAriaLabel();
    console.log("Tilt control successfully initialized.");
  }

  handleDeviceOrientation(event) {
    if (!this.useTilt) return;
    
    let tilt = 0;
    const orientation = window.orientation || (screen.orientation && screen.orientation.angle) || 0;
    
    if (orientation === 90) {
      tilt = event.beta;
    } else if (orientation === -90) {
      tilt = -event.beta;
    } else {
      tilt = event.gamma;
    }
    
    if (tilt === null || tilt === undefined) return;
    
    this.currentRawTilt = tilt;
    
    const calibratedTilt = tilt - this.tiltCalibrationAngle;
    const threshold = 4.0; // 4度のデッドゾーン
    
    if (calibratedTilt < -threshold) {
      this.keys['ArrowLeft'] = true;
      this.keys['ArrowRight'] = false;
    } else if (calibratedTilt > threshold) {
      this.keys['ArrowLeft'] = false;
      this.keys['ArrowRight'] = true;
    } else {
      this.keys['ArrowLeft'] = false;
      this.keys['ArrowRight'] = false;
    }
  }

  calibrateTilt() {
    this.tiltCalibrationAngle = this.currentRawTilt;
    console.log("Calibrated tilt center offset to: " + this.tiltCalibrationAngle);
  }

  updateCanvasAriaLabel() {
    const canvasContainer = document.getElementById('canvas-container');
    if (!canvasContainer) return;
    
    if (this.isMobile) {
      if (this.useTilt) {
        canvasContainer.setAttribute('aria-label', "サウンドテーブルテニス コート。スマートフォンを左右に傾けてラケットを操作します。画面をダブルタップして、サーブの準備、返答、サーブ、またはラリーの打ち返しを行います。");
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
        requestAnimationFrame(loop);
      }
    };
    
    requestAnimationFrame(loop);
  }

  stopLoop() {
    // requestAnimationFrame のクリーンアップは state 監視で行います
  }
}

// ページロード時にエンジンを初期化
window.addEventListener('DOMContentLoaded', () => {
  window.gameEngine = new GameEngine();
});
