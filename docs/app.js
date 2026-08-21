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
    this.rattleLfo = null;
    this.rumbleOsc = null;
    this.rumbleGain = null;
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
    
    // HRTF 3D空間オーディオ用のPannerNodeを作成 (3次元定位・奥行き表現用)
    this.panner = this.ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 1.0;
    this.panner.maxDistance = 10.0;
    this.panner.rolloffFactor = 1.2;
    this.panner.coneInnerAngle = 360;

    // リスナー（プレイヤーの耳の位置）の設定
    if (this.ctx.listener) {
      const listener = this.ctx.listener;
      if (listener.positionX) {
        listener.positionX.setValueAtTime(0, this.ctx.currentTime);
        listener.positionY.setValueAtTime(0, this.ctx.currentTime);
        listener.positionZ.setValueAtTime(0, this.ctx.currentTime);
        listener.forwardX.setValueAtTime(0, this.ctx.currentTime);
        listener.forwardY.setValueAtTime(0, this.ctx.currentTime);
        listener.forwardZ.setValueAtTime(-1, this.ctx.currentTime);
        listener.upX.setValueAtTime(0, this.ctx.currentTime);
        listener.upY.setValueAtTime(1, this.ctx.currentTime);
        listener.upZ.setValueAtTime(0, this.ctx.currentTime);
      } else {
        listener.setPosition(0, 0, 0);
        listener.setOrientation(0, 0, -1, 0, 1, 0);
      }
    }
    
    // ボールの転がり音用のローパスフィルターを作成 (空気吸収・距離感の音色変化用)
    this.ballRollFilter = this.ctx.createBiquadFilter();
    this.ballRollFilter.type = 'lowpass';
    this.ballRollFilter.frequency.setValueAtTime(4000, this.ctx.currentTime);
    
    // ボールの転がり音用のゲインノードを作成 (音量調整用)
    this.ballRollGain = this.ctx.createGain();
    this.ballRollGain.gain.setValueAtTime(0, this.ctx.currentTime);
    
    // 音響ルートの接続: 転がり音 -> フィルター -> ゲイン -> 3Dパンナー -> 出力
    this.ballRollFilter.connect(this.ballRollGain);
    this.ballRollGain.connect(this.panner);
    this.panner.connect(this.ctx.destination);
    
    // ホワイトノイズのバッファを作成
    this.createNoiseBuffer();
    
    // ボール転がり音のループ再生を開始
    this.startBallRollLoop();
  }

  /**
   * ゲーム画面座標 (x, y) を 3D音響空間座標 (x, y, z) に変換します。
   * リスナー(プレイヤーの耳)を (0, 0, 0) とした空間モデル:
   *  - X: -1.5m (左端) 〜 +1.5m (右端)
   *  - Y: -0.2m (テーブル面高さ: 耳よりやや下)
   *  - Z: -3.8m (相手コート奥) 〜 -2.0m (ネット中央) 〜 -0.6m (自分守備ライン) 〜 -0.2m (手前エンド)
   * @param {number} x キャンバスX座標 (0〜800)
   * @param {number} y キャンバスY座標 (0〜500)
   * @returns {{x: number, y: number, z: number}}
   */
  get3DCoords(x, y) {
    const x3D = ((x / CANVAS_WIDTH) * 2 - 1) * 1.5;
    const yRatio = y / CANVAS_HEIGHT; // 0.0 (相手奥) 〜 1.0 (手前)
    const z3D = -3.8 + (yRatio * 3.6); // -3.8m 〜 -0.2m
    const y3D = -0.2;
    return { x: x3D, y: y3D, z: z3D };
  }

  /**
   * PannerNodeの3D位置を滑らかに更新します。
   */
  setPannerPosition(panner, x3D, y3D, z3D) {
    if (panner.positionX) {
      panner.positionX.setTargetAtTime(x3D, this.ctx.currentTime, 0.03);
      panner.positionY.setTargetAtTime(y3D, this.ctx.currentTime, 0.03);
      panner.positionZ.setTargetAtTime(z3D, this.ctx.currentTime, 0.03);
    } else {
      panner.setPosition(x3D, y3D, z3D);
    }
  }

  /**
   * 単発効果音用の 3D PannerNode を作成します。
   * @param {number} x キャンバスX座標
   * @param {number} y キャンバスY座標 (デフォルト: ネット中央)
   */
  create3DPanner(x, y = Y_NET) {
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1.0;
    panner.maxDistance = 10.0;
    panner.rolloffFactor = 1.2;
    
    const coords = this.get3DCoords(x, y);
    if (panner.positionX) {
      panner.positionX.setValueAtTime(coords.x, this.ctx.currentTime);
      panner.positionY.setValueAtTime(coords.y, this.ctx.currentTime);
      panner.positionZ.setValueAtTime(coords.z, this.ctx.currentTime);
    } else {
      panner.setPosition(coords.x, coords.y, coords.z);
    }
    return panner;
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
    // 1. ノイズソース（シャラシャラ音のベース）
    this.ballRollSource = this.ctx.createBufferSource();
    this.ballRollSource.buffer = this.noiseBuffer;
    this.ballRollSource.loop = true;
    
    // ホワイトノイズを金属音らしくするためのマルチバンドパス（共鳴フィルター）
    // STT球の中の4つの金属球がぶつかり合う高い「チリン」「シャリ」という音を再現
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.6, this.ctx.currentTime);

    const freqs = [3200, 4800, 7200]; // 金属球の共鳴周波数帯
    const biquads = freqs.map(freq => {
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(freq, this.ctx.currentTime);
      bp.Q.setValueAtTime(4.0, this.ctx.currentTime); // 鋭く共鳴させる
      return bp;
    });

    // 各バンドパスにノイズを分配
    biquads.forEach(bp => {
      this.ballRollSource.connect(bp);
      bp.connect(noiseGain);
    });
    
    // シャラシャラ感を出すためのLFO（音量を断続的に揺らして粒立ちを作る）
    this.rattleLfo = this.ctx.createOscillator();
    this.rattleLfo.type = 'sawtooth'; // ノコギリ波でパーカッシブな「シャッ」という刻みを連続させる
    this.rattleLfo.frequency.setValueAtTime(15, this.ctx.currentTime);
    
    const rattleGain = this.ctx.createGain();
    rattleGain.gain.setValueAtTime(0.5, this.ctx.currentTime); // 揺れの深さ
    
    this.rattleLfo.connect(rattleGain);
    
    // noiseGainの音量をLFOで揺らすためのマスターゲイン
    const masterNoiseGain = this.ctx.createGain();
    masterNoiseGain.gain.setValueAtTime(0.5, this.ctx.currentTime); // LFOのベース
    rattleGain.connect(masterNoiseGain.gain);
    
    noiseGain.connect(masterNoiseGain);
    masterNoiseGain.connect(this.ballRollFilter);

    // 2. プラスチックの空洞音（ゴロゴロ・コトコト音）
    this.rumbleOsc = this.ctx.createOscillator();
    this.rumbleOsc.type = 'triangle';
    this.rumbleOsc.frequency.setValueAtTime(120, this.ctx.currentTime);
    
    this.rumbleGain = this.ctx.createGain();
    this.rumbleGain.gain.setValueAtTime(0.08, this.ctx.currentTime); 
    
    this.rumbleOsc.connect(this.rumbleGain);
    this.rumbleGain.connect(this.ballRollFilter);
    
    // 再生開始
    this.ballRollSource.start(0);
    this.rattleLfo.start(0);
    this.rumbleOsc.start(0);
  }

  /**
   * ボールのリアルタイムな位置と速度に応じて、3D空間定位・距離減衰・空気吸収フィルター・
   * およびボールが手元に迫る時間間隔（ラトル周期）を動的に更新します。
   * @param {number} x ボールのX座標 (0〜800)
   * @param {number} y ボールのY座標 (0〜500)
   * @param {number} vx ボールのX方向速度
   * @param {number} vy ボールのY方向速度
   */
  updateBallSound(x, y, vx, vy) {
    if (!this.ctx || this.isMuted) return;
    
    const speed = Math.sqrt(vx * vx + vy * vy);
    
    // 1. HRTF 3D空間座標 (X, Y, Z) のリアルタイム追従
    const coords = this.get3DCoords(x, y);
    this.setPannerPosition(this.panner, coords.x, coords.y, coords.z);
    
    // 2. 距離比率 (0.0: 自分守備ライン 〜 1.0: 相手コート奥)
    const distRatio = Math.max(0, Math.min(1, (Y_DEFENSE_P1 - y) / Y_DEFENSE_P1));
    const isApproaching = vy > 0; // 自分に向かって迫ってくる進行方向か
    
    // 3. 奥行き（空気吸収・距離感）に応じたローパスフィルター
    // 相手コート奥 (distRatio=1.0) では 650Hz (こもった遠方の音)
    // ネット付近 (distRatio=0.4) では約 3500Hz
    // 自分守備手前 (distRatio=0.0) では 14000Hz (金属球のきらめき・粒立ちが完全に開く)
    const targetFreq = 650 + (13350 * Math.pow(1 - distRatio, 1.8)); 
    this.ballRollFilter.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.04);
    
    // 4. 音量設定（対数スケール + 距離ダイナミクス）
    let baseVolume = Math.log1p(speed * 0.8) / Math.log1p(8) * 0.55;
    if (baseVolume > 1.0) baseVolume = 1.0;
    
    // 手前に近づくほど音圧が高まり、迫力と近接感が生まれる
    const proximityGain = 0.35 + (0.65 * Math.pow(1 - distRatio, 1.4));
    let targetVolume = baseVolume * proximityGain;
    
    if (speed < 0.1) targetVolume = 0; // 停止時は消音
    
    this.ballRollGain.gain.setTargetAtTime(targetVolume, this.ctx.currentTime, 0.04);

    // 5. 【ボールの来る間隔（テンポ・リズム感）の動的変調】
    // ボール内部の金属球が転がる刻み（ラトル周期 LFO）と空洞音
    if (this.rattleLfo && this.rumbleOsc && this.rumbleGain) {
      if (speed > 0.1) {
        // 基本の速度連動 (8Hz 〜 24Hz)
        let rattleFreq = 8 + Math.min(speed, 20) * 1.2;
        
        // 迫ってくる時（isApproaching）は、残距離が近くなるほど刻みのピッチとパルス密度が加速
        // これにより「タタタタ…」という間隔が耳で測れ、手元に来るタイミングが直感化される
        if (isApproaching) {
          const approachFactor = Math.pow(1 - distRatio, 2.0) * 12.0; // 0 〜 +12Hz
          rattleFreq += approachFactor;
        }
        
        this.rattleLfo.frequency.setTargetAtTime(rattleFreq, this.ctx.currentTime, 0.08);

        // ゴロゴロ空洞音も接近に伴い鮮明化
        const rumbleFreq = 90 + Math.min(speed, 15) * 3.5 + (isApproaching ? (1 - distRatio) * 40 : 0);
        this.rumbleOsc.frequency.setTargetAtTime(rumbleFreq, this.ctx.currentTime, 0.08);
        
        const rumbleVol = (0.04 + Math.min(speed / 10, 1.0) * 0.12) * proximityGain;
        this.rumbleGain.gain.setTargetAtTime(rumbleVol, this.ctx.currentTime, 0.08);
      }
    }
  }


  /**
   * プレイヤーが移動したときの足音（シューズの床摩擦音）を合成します。
   * 移動速度（deltaX）に応じて音量とトーンを変化させます。
   * @param {number} x プレイヤーのX座標 (パン用)
   * @param {number} deltaX 1フレームでの移動量
   */
  playFootstepSound(x, deltaX) {
    if (!this.ctx || this.isMuted) return;
    
    const panner = this.create3DPanner(x, Y_DEFENSE_P1);
    
    // ホワイトノイズソース
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    
    // バンドパスフィルターで周波数帯を絞る
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    
    const panVal = (x / CANVAS_WIDTH) * 2 - 1;
    const speedRatio = Math.min(deltaX / 7.0, 1.0);
    const positionShift = panVal * 400; // -400Hz(左) 〜 +400Hz(右)
    
    const targetFreq = 1500 + (1200 * speedRatio) + positionShift;
    filter.frequency.setValueAtTime(targetFreq, this.ctx.currentTime);
    
    const centerProximity = 1.0 - Math.abs(panVal);
    const targetQ = 2.0 + (2.0 * speedRatio) + (1.5 * centerProximity);
    filter.Q.setValueAtTime(targetQ, this.ctx.currentTime);
    
    const gain = this.ctx.createGain();
    const targetVolume = 0.03 + (0.15 * speedRatio);
    const duration = 0.04 + (0.06 * speedRatio);
    
    gain.gain.setValueAtTime(0.0, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(targetVolume, this.ctx.currentTime + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration - 0.005);
    
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(this.ctx.destination);
    
    noise.start();
    noise.stop(this.ctx.currentTime + duration);
  }

  /**
   * ラケットを振ったときの風切り音（スイング音「ブン」）を合成します。
   * @param {number} x ラケットのX座標 (パン用)
   */
  playSwingSound(x) {
    if (!this.ctx || this.isMuted) return;
    
    const panner = this.create3DPanner(x, Y_DEFENSE_P1);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(240, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(60, this.ctx.currentTime + 0.12);
    
    gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.14);
    
    osc.connect(gain);
    gain.connect(panner);
    panner.connect(this.ctx.destination);
    
    osc.start();
    osc.stop(this.ctx.currentTime + 0.15);
  }

  /**
   * 打球音 (木製ラケットの「コン」という乾いた音) を合成します。
   * @param {number} x 衝突したX座標 (パン用)
   * @param {number} y 衝突したY座標 (デフォルト: Y_DEFENSE_P1)
   */
  playHitSound(x, y = Y_DEFENSE_P1) {
    if (!this.ctx || this.isMuted) return;
    
    const panner = this.create3DPanner(x, y);
    
    // 1. オシレーター（打球音の本体 - 基本波）
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(550, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(180, this.ctx.currentTime + 0.09);
    
    gain.gain.setValueAtTime(1.0, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.16);
    
    // 2. 2次倍音オシレーター（打球の「カツッ」という硬い質感と明瞭さを加える）
    const osc2 = this.ctx.createOscillator();
    const gain2 = this.ctx.createGain();
    
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(1100, this.ctx.currentTime);
    osc2.frequency.exponentialRampToValueAtTime(360, this.ctx.currentTime + 0.07);
    
    gain2.gain.setValueAtTime(0.25, this.ctx.currentTime);
    gain2.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.08);
    
    // 3. アタックノイズ (打球時の瞬間的な木製アタック音)
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    
    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(1800, this.ctx.currentTime);
    
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.55, this.ctx.currentTime);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.03);
    
    osc.connect(gain);
    gain.connect(panner);
    
    osc2.connect(gain2);
    gain2.connect(panner);
    
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(panner);
    
    panner.connect(this.ctx.destination);
    
    osc.start();
    osc2.start();
    noise.start();
    
    osc.stop(this.ctx.currentTime + 0.20);
    osc2.stop(this.ctx.currentTime + 0.10);
    noise.stop(this.ctx.currentTime + 0.04);
  }

  /**
   * プレイヤーが打ち返した時の正解音（チャイム）
   * @param {number} x 衝突したX座標 (パン用)
   * @param {boolean} isEasy 初級編かどうか
   * @param {number} y 衝突したY座標
   */
  playSuccessChime(x, isEasy = false, y = Y_DEFENSE_P1) {
    if (!this.ctx || this.isMuted) return;

    const panner = this.create3DPanner(x, y);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    
    const baseFreq = isEasy ? 1200 : 900;
    osc.frequency.setValueAtTime(baseFreq, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.5, this.ctx.currentTime + 0.1);

    const peakGain = isEasy ? 0.6 : 0.3;
    const duration = isEasy ? 0.4 : 0.2;

    gain.gain.setValueAtTime(0, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(peakGain, this.ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);

    osc.connect(gain);
    gain.connect(panner);
    panner.connect(this.ctx.destination);

    osc.start();
    osc.stop(this.ctx.currentTime + duration + 0.1);
  }

  /**
   * フレーム衝突音 (サイド/エンドフレームに当たった時の「カツ」という高い音)
   * @param {number} x 衝突したX座標
   * @param {number} y 衝突したY座標
   */
  playFrameSound(x, y = Y_NET) {
    if (!this.ctx || this.isMuted) return;
    
    const panner = this.create3DPanner(x, y);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(750, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(200, this.ctx.currentTime + 0.05);
    
    gain.gain.setValueAtTime(0.5, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.06);
    
    osc.connect(gain);
    gain.connect(panner);
    panner.connect(this.ctx.destination);
    
    osc.start();
    osc.stop(this.ctx.currentTime + 0.07);
  }

  /**
   * ネット衝突音 (布に当たった時の「ポス」というこもった音)
   * @param {number} x 衝突したX座標
   * @param {number} y 衝突したY座標
   */
  playNetSound(x, y = Y_NET) {
    if (!this.ctx || this.isMuted) return;
    
    const panner = this.create3DPanner(x, y);
    const bufferSource = this.ctx.createBufferSource();
    bufferSource.buffer = this.noiseBuffer;
    
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(350, this.ctx.currentTime);
    
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.6, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.15);
    
    bufferSource.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(this.ctx.destination);
    
    bufferSource.start();
    bufferSource.stop(this.ctx.currentTime + 0.16);
  }

  /**
   * アウト / 失敗音 (低いブザー音のような合成音に、3Dパンニング処理を追加)
   * @param {number} x ボールのX座標
   * @param {number} y ボールのY座標
   */
  playMissSound(x = CANVAS_WIDTH / 2, y = Y_DEFENSE_P1) {
    if (!this.ctx || this.isMuted) return;
    
    const panner = this.create3DPanner(x, y);
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    osc1.type = 'sawtooth';
    osc2.type = 'sawtooth';
    
    osc1.frequency.setValueAtTime(130, this.ctx.currentTime);
    osc2.frequency.setValueAtTime(133, this.ctx.currentTime);
    
    gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.4);
    
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(panner);
    panner.connect(this.ctx.destination);
    
    osc1.start();
    osc2.start();
    
    osc1.stop(this.ctx.currentTime + 0.45);
    osc2.stop(this.ctx.currentTime + 0.45);
  }

  /**
   * ボール停止時の「コトン」という位置音を合成します。(Feature #6)
   * @param {number} x 停止したX座標
   * @param {number} y 停止したY座標
   */
  playBallStopSound(x, y = Y_DEFENSE_P1) {
    if (!this.ctx || this.isMuted) return;
    const panner = this.create3DPanner(x, y);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(280, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(120, this.ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.4, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.2);
    osc.connect(gain);
    gain.connect(panner);
    panner.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.22);
  }


  /**
   * 試合終了時の歓声・拍手効果音を合成します。
   * ピンクノイズ風のフィルターとLFOを使って、観客の盛り上がりを表現します。
   */
  playCheerSound() {
    if (!this.ctx || this.isMuted) return;

    const duration = 4.0;
    const now = this.ctx.currentTime;

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;

    const bandpass = this.ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.setValueAtTime(800, now);
    bandpass.Q.setValueAtTime(0.5, now);

    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(4.0, now);
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.setValueAtTime(100, now);

    lfo.connect(lfoGain);
    lfoGain.connect(bandpass.frequency);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.4, now + 0.5);
    gain.gain.exponentialRampToValueAtTime(0.01, now + duration);

    noise.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(this.ctx.destination);

    noise.start(now);
    lfo.start(now);
    noise.stop(now + duration);
    lfo.stop(now + duration);
  }

  /**
   * サーブチャージ中の上昇音を合成します。(Feature #2)
   * @param {number} chargeRatio チャージ率 0.0〜1.0
   * @param {number} x ラケットX座標
   * @param {number} y ラケットY座標
   */
  playChargeBeep(chargeRatio, x = CANVAS_WIDTH / 2, y = Y_DEFENSE_P1) {
    if (!this.ctx || this.isMuted) return;
    const panner = this.create3DPanner(x, y);
    const freq = 400 + (chargeRatio * 800);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
    gain.gain.setValueAtTime(0.08, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.06);
    osc.connect(gain);
    gain.connect(panner);
    panner.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.07);
  }

  /**
   * CPUラケットの移動音（少し高いシュッという音、奥から立体パンニング）
   */
  playCpuMoveSound(x, deltaX) {
    if (!this.ctx || this.isMuted) return;
    
    const panner = this.create3DPanner(x, Y_DEFENSE_P2);
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    const speedRatio = Math.min(deltaX / 7.0, 1.0);
    const targetFreq = 2800 + (1200 * speedRatio);
    filter.frequency.setValueAtTime(targetFreq, this.ctx.currentTime);
    filter.Q.setValueAtTime(3.0, this.ctx.currentTime);
    
    const gain = this.ctx.createGain();
    const targetVolume = 0.02 + (0.08 * speedRatio);
    const duration = 0.04 + (0.05 * speedRatio);
    
    gain.gain.setValueAtTime(0.0, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(targetVolume, this.ctx.currentTime + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration - 0.005);
    
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(this.ctx.destination);
    
    noise.start();
    noise.stop(this.ctx.currentTime + duration);
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
    // Feature #8: 音声速度設定の初期読み込み
    this.speechRate = parseFloat(localStorage.getItem('stt_speech_rate') || '1.2');
    
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
        // Feature #8: 設定された speechRate を適用
        utterance.rate = isReferee ? this.speechRate : Math.max(0.7, this.speechRate - 0.2); 
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

  /**
   * 音声読み上げ速度を変更して保存します。(Feature #8)
   */
  setSpeechRate(rate) {
    this.speechRate = rate;
    localStorage.setItem('stt_speech_rate', rate);
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
    // パドル同期のスロットル用（30ms 以内の重複送信を防止）
    this.paddleLastSent = 0;
    // 改善②: onerror → onclose の二重発火によるダブル quitGame を防ぐフラグ
    this.disconnectHandled = false;
  }

  /**
   * WebSocketサーバーへ接続します。
   * @param {string} roomId 部屋ID
   * @param {string} serverAddr ユーザーが手入力したサーバーアドレス (例: http://192.168.1.15:8080)
   */
  connect(roomId, serverAddr) {
    this.roomId = roomId || 'lobby';
    
    let proto = 'ws:';
    let host = 'localhost:8080'; // デフォルトのフォールバック

    if (serverAddr && serverAddr.trim() !== '') {
      // ユーザーが明示的にサーバーアドレスを指定した場合はそちらを優先する
      try {
        const url = new URL(serverAddr.trim());
        proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
        host = url.host;
        console.log(`Using user-specified server: ${proto}//${host}`);
      } catch (e) {
        console.error('Invalid server address:', serverAddr, e);
        // 不正な形式でもフォールバックで続行
      }
    } else if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      // サーバーアドレス未指定の場合は現在のページのホストに接続
      proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      host = window.location.host;
    } else {
      console.warn('File protocol detected. Falling back to localhost:8080');
    }
    
    const wsUrl = `${proto}//${host}/ws?room=${this.roomId}&id=${this.clientId}`;
    console.log('Connecting to:', wsUrl);
    
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
    this.gameScores = { p1: 0, p2: 0 }; // 各セット（ゲーム）の獲得数
    this.serverRole = 1; // 現在のサーバー (1 or 2)
    this.matchGames = 3; // 3ゲームス2セット先取マッチ
    this.maxScore = 11;  // 11点先取
    
    // タイムアウト管理 (公式5秒ルールなどのチェック用)
    this.stateStartTime = 0;
    this.timerInterval = null;

    // Feature #2, #4: チャージサーブおよびインターバルスキップ用の状態管理変数
    this.chargeStartTime = 0;
    this.isCharging = false;
    this.chargeInterval = null;
    this.intervalSkipCallback = null;

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

    // プレイ画面全体のタップハンドラ (アクションボタン類は除外)
    const handlePlayAreaAction = (e) => {
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
      if (this.isGameplayPaused) return;
      const activeStates = [STATE_PRE_SERVE_READY, STATE_PRE_SERVE_HEARD, STATE_SERVE_WAITING, STATE_RALLY, STATE_POINT_WON];
      if (!activeStates.includes(this.state)) return;

      const excluded = ['BUTTON', 'A', 'INPUT', 'LABEL', 'SELECT', 'TEXTAREA'];
      if (excluded.includes(e.target.tagName)) return;

      e.preventDefault(); // 300ms の click 遅延と二重発火を防ぐ
      this.handleActionInput();
    }, { passive: false });

    // スマホ用のtouchstartでチャージ開始 (Feature #2)
    document.addEventListener('touchstart', (e) => {
      if (this.isGameplayPaused) return;
      const activeStates = [STATE_SERVE_WAITING];
      if (!activeStates.includes(this.state)) return;

      const excluded = ['BUTTON', 'A', 'INPUT', 'LABEL', 'SELECT', 'TEXTAREA'];
      if (excluded.includes(e.target.tagName)) return;

      if (this.state === STATE_SERVE_WAITING && this.isMyTurnToServe()) {
        e.preventDefault();
        this.isCharging = true;
        this.chargeStartTime = Date.now();
        if (this.chargeInterval) clearInterval(this.chargeInterval);
        sounds.playChargeBeep(0);
        this.chargeInterval = setInterval(() => {
          const chargeRatio = Math.min((Date.now() - this.chargeStartTime) / 1500, 1.0);
          sounds.playChargeBeep(chargeRatio);
        }, 150);
      }
    }, { passive: false });

    // 1. オーディオ有効化ボタン
    document.getElementById('btn-enable-audio').addEventListener('click', () => {
      sounds.init();
      
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
            if (this.chargeInterval) clearInterval(this.chargeInterval);
            sounds.playChargeBeep(0);
            this.chargeInterval = setInterval(() => {
              const chargeRatio = Math.min((Date.now() - this.chargeStartTime) / 1500, 1.0);
              sounds.playChargeBeep(chargeRatio);
            }, 150);
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
        if (this.chargeInterval) {
          clearInterval(this.chargeInterval);
          this.chargeInterval = null;
        }
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
    if (this.chargeInterval) {
      clearInterval(this.chargeInterval);
      this.chargeInterval = null;
    }
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
   * 新しいマッチ(5ゲームマッチ)を開始します。
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
    // Feature #1: CPU戦のサーブ交代制 (easyならCPU固定(2)、normal/hardならプレイヤー先発(1))
    if (this.mode === 'cpu') {
      this.serverRole = 1; // 改善⑦: easy でも先攻サーブはプレイヤー（CPU固定を廃止）
    } else {
      this.serverRole = 1;
    } 
    
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
    this.state = STATE_PRE_SERVE_READY;
    this.stateStartTime = Date.now();
    this.ball.active = false;

    // プレイ集中モード: play-instructions テキストボックスを非表示にする
    // (スクリーンリーダーの sr-announcer 経由で音声で案内するため画面テキストは不要)
    const instrEl = document.getElementById('play-instructions');
    if (instrEl) instrEl.classList.add('hidden');

    
    // ボールをサーバーのラケットに吸着させる準備（位置は毎フレーム更新される）
    if (this.serverRole === 1) {
      this.ball.x = this.p1.x + PADDLE_WIDTH / 2;
      this.ball.y = Y_DEFENSE_P1 - BALL_RADIUS;
    } else {
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
            const cpuChargeStartTime = Date.now();
            
            // Feature #2: CPUチャージビープ音のシミュレーション
            const cpuChargeInterval = setInterval(() => {
              if (this.state !== STATE_SERVE_WAITING) {
                clearInterval(cpuChargeInterval);
                return;
              }
              const elapsed = Date.now() - cpuChargeStartTime;
              const ratio = Math.min(elapsed / cpuDelay, 0.8); // 最大0.8まで
              sounds.playChargeBeep(ratio);
            }, 150);

            setTimeout(() => {
              clearInterval(cpuChargeInterval);
              if (this.state === STATE_SERVE_WAITING) {
                this.state = STATE_RALLY;
                this.ball.active = true;

                // 難易度に応じてサーブの速度や角度を調整
                if (this.difficulty === 'easy') {
                  this.ball.vx = (Math.random() * 0.8 - 0.4); // ±0.4 の微小なランダム横成分
                  this.ball.vy = 3.5; // 通常より低速
                } else {
                  let speedMultiplier = 1.0;
                  if (this.difficulty === 'hard') speedMultiplier = 1.15;
                  
                  // Feature #2 / 改善③: CPUチャージシミュレーションによる初速設定 + サーブバリエーション（直球/左/右）
                  const chargeRatio = 0.3 + Math.random() * 0.5;
                  const baseVy = (4.5 + chargeRatio * 3.5) * speedMultiplier;

                  const serveType = Math.random();
                  let cpuServeVx;
                  if (serveType < 0.33) {
                    cpuServeVx = (Math.random() * 1.0 - 0.5) * speedMultiplier; // 直球（横ほぼなし）
                  } else if (serveType < 0.66) {
                    cpuServeVx = -(1.5 + Math.random() * 2.5) * speedMultiplier; // 左流し
                  } else {
                    cpuServeVx = (1.5 + Math.random() * 2.5) * speedMultiplier;  // 右流し
                  }
                  this.ball.vx = cpuServeVx;
                  this.ball.vy = baseVy;
                }
                
                sounds.playHitSound(this.ball.x);
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
        if (this.chargeInterval) { clearInterval(this.chargeInterval); this.chargeInterval = null; }
        const chargeRatio = chargeTime;
        const baseVy = 4.5 + (chargeRatio * 3.5); // 4.5〜8.0

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
      
      // Feature #3: 難易度別のヒットゾーン (easy: 50px, hard: 20px, normal: 30px)
      const hitZone = this.difficulty === 'easy' ? 50 : this.difficulty === 'hard' ? 20 : 30;
      const isNearPaddle = Math.abs(this.ball.y - defenseY) < hitZone;
      const hitPaddle = this.ball.x >= paddle.x - 15 && this.ball.x <= paddle.x + PADDLE_WIDTH + 15;
      
      // スイング音とスイング波紋エフェクトを即座に発生させる (ボールのヒットに関わらず連打可能)
      sounds.playSwingSound(paddle.x + PADDLE_WIDTH / 2);
      this.addRipple(paddle.x + PADDLE_WIDTH / 2, defenseY, 'swing');

      if (isIncoming && isNearPaddle && hitPaddle) {
        // 打ち返し成功！
        this.ball.y = defenseY; // 位置補正
        const relativeHitPos = (this.ball.x - (paddle.x + PADDLE_WIDTH / 2)) / (PADDLE_WIDTH / 2);
        this.ball.vx = relativeHitPos * 7.5; // フレームショットで横に大きく逸れるように拡張
        
        if (this.role === 1) {
          this.ball.vy = -Math.abs(this.ball.vy) * 1.05; // 上方向（-Y）へ打ち返す
        } else {
          this.ball.vy = Math.abs(this.ball.vy) * 1.05;  // 下方向（+Y）へ打ち返す
        }
        
        sounds.playHitSound(this.ball.x);
        sounds.playSuccessChime(this.ball.x, this.difficulty === 'easy');
        if (this.role === 1) {
          this.addRipple(this.ball.x, this.ball.y, 'hit_p1');
        } else {
          this.addRipple(this.ball.x, this.ball.y, 'hit');
        }
        
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
    
    // 得点が入ってプレイが止まったらボールの転がり音をミュートする
    sounds.updateBallSound(this.ball.x, this.ball.y, 0, 0);

    
    // 効果音の再生
    if (winner === this.role) {
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
        
        // マッチ勝利条件（2セット先取）のチェック
        const winThreshold = Math.ceil(this.matchGames / 2); // 3ゲームマッチなら2
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
        // 次のサーブ権の移行チェック
        // Feature #1 / 改善⑦: 全難易度・全モードで共通のサーブ交代制（2点ごと交代、デュース時1点ごと）
        {
          const total = p1 + p2;
          if (p1 >= 10 && p2 >= 10) {
            this.serverRole = this.serverRole === 1 ? 2 : 1;
          } else if (total > 0 && total % 2 === 0) {
            this.serverRole = this.serverRole === 1 ? 2 : 1;
          }
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
    
    // 試合終了の歓声音を再生
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

  /**
   * ゲームの物理アップデート (1フレームごとの処理)。
   */
  updatePhysics() {
    if (this.isGameplayPaused) return;
    try {
      // サービス前のボール吸着処理 (物理演算呼び出し前に行う)
      if (this.state === STATE_PRE_SERVE_READY || 
          this.state === STATE_PRE_SERVE_HEARD || 
          this.state === STATE_SERVE_WAITING) {
        if (this.serverRole === 1) {
          this.ball.x = this.p1.x + PADDLE_WIDTH / 2;
          this.ball.y = Y_DEFENSE_P1 - BALL_RADIUS;
        } else {
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

        // 自分（プレイヤー）とCPUのラケット移動音の処理
        const myPaddleX = this.role === 1 ? this.p1.x : this.p2.x;
        const oppPaddleX = this.role === 1 ? this.p2.x : this.p1.x;
        
        const myDeltaX = Math.abs(myPaddleX - (this.lastMyPaddleX || myPaddleX));
        const oppDeltaX = Math.abs(oppPaddleX - (this.lastOppPaddleX || oppPaddleX));
        
        const now = Date.now();
        if (myDeltaX > 0.02) {
          if (now - (this.lastFootstepTime || 0) > 60) { // 60ms 間隔
            sounds.playFootstepSound(myPaddleX, myDeltaX);
            this.lastFootstepTime = now;
          }
        }
        if (oppDeltaX > 0.02 && this.mode === 'cpu') {
          if (now - (this.lastOppFootstepTime || 0) > 60) {
            sounds.playCpuMoveSound(oppPaddleX, oppDeltaX);
            this.lastOppFootstepTime = now;
          }
        }
        
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
    // ボール速度の上昇に合わせ、Normal / Hard ではラケットの移動速度も上げる。
    // チルト操作時は、この最大速度に傾き比率 (0〜1) を掛けて比例移動する。
    const maxSpeed = this.difficulty === 'hard' ? 9 : this.difficulty === 'normal' ? 8 : 7;
    const paddle = this.role === 1 ? this.p1 : this.p2;
    
    if (this.keys['ArrowLeft']) {
      // チルト操作中は比例速度を使用、キーボードは最大速度
      const speed = (this.useTilt && this.tiltSpeed !== undefined)
        ? maxSpeed * this.tiltSpeed
        : maxSpeed;
      paddle.x -= speed;
      if (paddle.x < 0) paddle.x = 0;
      this.syncPaddlePosition(paddle.x);
    }
    if (this.keys['ArrowRight']) {
      const speed = (this.useTilt && this.tiltSpeed !== undefined)
        ? maxSpeed * this.tiltSpeed
        : maxSpeed;
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
          // 【簡単モード】ラリー練習重視 — CPUは必ずボールを打ち返す設計
          // 追従速度を上げてミスを減らし、ブレをほぼゼロにして長いラリーを維持できるようにする
          cpuSpeed = 4.5; // 確実に追いつける速度（ただしhardより遅い）
          targetOffset = Math.sin(Date.now() / 600) * 8; // 微小なブレのみ（自然な動きの演出用）
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

    }
    const shouldComputeBall = !(this.mode === 'online' && this.role === 2);
    if (shouldComputeBall && this.ball.active && this.state === STATE_RALLY) {
      // 摩擦による減速
      this.ball.vx *= TABLE_FRICTION;
      this.ball.vy *= TABLE_FRICTION;
      
      this.ball.x += this.ball.vx;
      this.ball.y += this.ball.vy;
      
      // 立体音響のアップデート
      sounds.updateBallSound(this.ball.x, this.ball.y, this.ball.vx, this.ball.vy);


      // --- 左右サイド境界 (X=0, X=800) からの落下（アウト）判定 ---
      if (this.ball.x - BALL_RADIUS <= 0 || this.ball.x + BALL_RADIUS >= CANVAS_WIDTH) {
        // テーブルの横から落ちる（アウト）
        const hitter = this.ball.vy < 0 ? 1 : 2;
        const winner = hitter === 1 ? 2 : 1;
        const edgeX = this.ball.x - BALL_RADIUS <= 0 ? 0 : CANVAS_WIDTH;
        
        this.addRipple(edgeX, this.ball.y, 'wall'); // 落ちたエフェクトとしてwallを利用
        this.awardPointTo(winner, 'out');
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
            // 改善①②④: 難易度別の返球横速度・縦加速
            const cpuVxFactor = this.difficulty === 'easy' ? 1.5 : this.difficulty === 'hard' ? 6.0 : 4.0;
            const cpuVyBoost = this.difficulty === 'hard' ? 1.12 : this.difficulty === 'easy' ? 1.02 : 1.05;
            this.ball.vx = relativeHitPos * cpuVxFactor;
            this.ball.vy = -Math.abs(this.ball.vy) * cpuVyBoost;
            
            sounds.playHitSound(this.ball.x);
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
          if (hitPaddle) {
            this.ball.y = Y_DEFENSE_P2;
            const relativeHitPos = (this.ball.x - (this.p2.x + PADDLE_WIDTH / 2)) / (PADDLE_WIDTH / 2);
            // 改善①②④: 難易度別の返球横速度・縦加速
            const cpuVxFactor = this.difficulty === 'easy' ? 1.5 : this.difficulty === 'hard' ? 6.0 : 4.0;
            const cpuVyBoost = this.difficulty === 'hard' ? 1.12 : this.difficulty === 'easy' ? 1.02 : 1.05;
            this.ball.vx = relativeHitPos * cpuVxFactor;
            this.ball.vy = Math.abs(this.ball.vy) * cpuVyBoost;
            
            sounds.playHitSound(this.ball.x);
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
        if (Math.abs(this.ball.vy) > 13) {
          // 強すぎてエンドフレームを越えて飛び出た -> P2のアウト、P1の得点
          this.awardPointTo(1, 'out');
        } else {
          // エンドフレームの内側面に当たりコート内（セーフ） -> P2の得点
          sounds.playHitSound(this.ball.x, CANVAS_HEIGHT);
          this.awardPointTo(2, 'safe');
        }
      }
      
      // 2. 相手側 (P2) のエンドフレーム到達
      else if (this.ball.y < 0) {
        if (Math.abs(this.ball.vy) > 13) {
          // 強すぎてエンドフレームを越えて飛び出た -> P1のアウト、P2の得点
          this.awardPointTo(2, 'out');
        } else {
          // エンドフレームの内側面に当たりコート内（セーフ） -> P1の得点
          sounds.playHitSound(this.ball.x, 0);
          this.awardPointTo(1, 'safe');
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
window.addEventListener('DOMContentLoaded', () => {
  window.gameEngine = new GameEngine();
});
