import { CANVAS_WIDTH, CANVAS_HEIGHT, Y_NET, Y_DEFENSE_P1 } from './constants.js';

export class SoundSystem {
  constructor() {
    this.ctx = null;
    this.ballRollFilter = null;
    this.panner = null; // PannerNode for mono sound assets
    this.isMuted = false;
    this.assetsOnly = true; // docs/sounds/ 配下の実音源だけを再生する

    // 本物の実録音源バッファ
    this.realRollBuffer = null; // rally.m4a
    this.racketBuffer = null;   // racket.m4a
    this.outBuffer = null;      // out.m4a (アウト)
    this.rally2Buffer = null;   // rally2.m4a (エンドフレーム成功)
    this.realRollSource = null;
    this.realRollGain = null;
    this.serveRollSource = null;
    this.serveRollPanner = null;
    this.serveRollStopTimer = null;
    this.serveBuffers = {}; // { easy: Buffer, normal: Buffer, hard: Buffer, list: [] }
    this.audioLoaded = false;
    this.noiseBuffer = null;
    this.lastBallY = null;

    // ラリー中BGM (rally.m4a)
    this.rallyBuffer = null;
    this.rallySource = null;
    this.rallyGain = null;
    this.rallyPlaying = false;
    // The game can enter a rally before the async audio fetch has finished.
    // Keep the intent so loading completion can start the music safely.
    this.rallyRequested = false;
    this.rallyStopTimer = null;
    this.rallyLoadingPromise = null;
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
    // ブラウザの自動再生制限で suspended になっている場合に備え、
    // ユーザー操作の直後に明示的に再開します。
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(err => console.warn('AudioContext resume failed:', err));
    }

    // Android Chromeではresume()だけでは、後続の非同期イベントからの
    // 音声再生が許可されない場合がある。ユーザー操作中に無音バッファを
    // 一度再生して、AudioContextを確実にアンロックする。
    try {
      const unlockBuffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const unlockSource = this.ctx.createBufferSource();
      unlockSource.buffer = unlockBuffer;
      unlockSource.connect(this.ctx.destination);
      unlockSource.start(0);
    } catch (err) {
      console.warn('Audio unlock skipped:', err);
    }

    // Decode sound assets to mono first, then apply simple left/right positioning.
    this.panner = this.create3DPanner(CANVAS_WIDTH / 2, Y_NET);

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

    // ボール転がり音用のローパスフィルターを作成 (空気吸収・距離感の音色変化用)
    this.ballRollFilter = this.ctx.createBiquadFilter();
    this.ballRollFilter.type = 'lowpass';
    this.ballRollFilter.frequency.setValueAtTime(4000, this.ctx.currentTime);

    // 音響ルートの接続: フィルター -> HRTF PannerNode -> 出力
    this.ballRollFilter.connect(this.panner);
    this.panner.connect(this.ctx.destination);

    // 足音などの短い摩擦音に使うノイズ素材を用意します。
    this.createNoiseBuffer();

    // 実音源ファイル (rally.m4a, racket.m4a, out.m4a, rally2.m4a,
    // serve1~3.m4a) の非同期読み込み
    this.loadAudioFiles();
  }

  /**
   * 実録音源ファイルを非同期でフェッチ＆デコードします。
   */
  async loadAudioFiles() {
    const fetchAudio = async (url) => {
      try {
        // GitHub Pages などのサブパス配下でも docs/sounds を正しく解決する。
        const audioUrl = new URL(url, document.baseURI).href;
        const response = await fetch(audioUrl);
        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        const decoded = await this.ctx.decodeAudioData(arrayBuffer);
        return this.toMonoBuffer(decoded);
      } catch (err) {
        console.warn('Audio load skipped for ' + url + ':', err);
        return null;
      }
    };

    try {
      const [s1, s2, s3, rally, racket, out, rally2] = await Promise.all([
        fetchAudio('sounds/serve1.m4a'),
        fetchAudio('sounds/serve2.m4a'),
        fetchAudio('sounds/serve3.m4a'),
        fetchAudio('sounds/rally.m4a'),
        fetchAudio('sounds/racket.m4a'),
        fetchAudio('sounds/out.m4a'),
        fetchAudio('sounds/rally2.m4a')
      ]);

      // 難易度別の対応付け:
      // serve1.m4a: 初級用 (Easy)
      // serve2.m4a: 中級用 (Normal)
      // serve3.m4a: 応用・上級用 (Hard)
      this.serveBuffers = {
        easy: s1,
        normal: s2,
        hard: s3,
        list: [s1, s2, s3].filter(b => b !== null)
      };
      this.realRollBuffer = rally;
      this.rallyBuffer = rally;
      this.racketBuffer = racket;
      this.outBuffer = out;
      this.rally2Buffer = rally2;
      this.audioLoaded = true;
      // ラリー開始直後に非同期ロードが完了した場合も、継続中なら
      // rally.m4a のループを確実に開始します。終了要求後は再生しません。
      if (this.rallyRequested) this.startRallyMusic();
      console.log('Loaded serve sounds: ' + this.serveBuffers.list.length);
    } catch (e) {
      console.warn('Failed to load audio files:', e);
    }
  }

  /** ラリー継続が確定した時だけラリー音源を読み込みます。 */
  loadRallyAudio() {
    if (this.rallyBuffer || this.rallyLoadingPromise || !this.ctx) return this.rallyLoadingPromise;

    this.rallyLoadingPromise = (async () => {
      try {
        const audioUrl = new URL('sounds/rally.m4a', document.baseURI).href;
        const response = await fetch(audioUrl);
        if (!response.ok) return;
        const arrayBuffer = await response.arrayBuffer();
        const decoded = await this.ctx.decodeAudioData(arrayBuffer);
        this.rallyBuffer = this.toMonoBuffer(decoded);
        if (this.rallyRequested) this.startRallyMusic();
      } catch (err) {
        console.warn('Audio load skipped for sounds/rally.m4a:', err);
      } finally {
        this.rallyLoadingPromise = null;
      }
    })();

    return this.rallyLoadingPromise;
  }

  /**
   * 再生音源を1チャンネルへダウンミックスします。
   * モノラル化した音源でも、そのまま再生できる共通の入口にします。
   */
  toMonoBuffer(buffer) {
    if (!buffer || buffer.numberOfChannels === 1) return buffer;

    const mono = this.ctx.createBuffer(1, buffer.length, buffer.sampleRate);
    const output = mono.getChannelData(0);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const input = buffer.getChannelData(channel);
      for (let i = 0; i < buffer.length; i++) {
        output[i] += input[i] / buffer.numberOfChannels;
      }
    }
    return mono;
  }

  createNoiseBuffer() {
    const length = Math.max(1, Math.floor(this.ctx.sampleRate * 2));
    this.noiseBuffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }

  /** 移動時のシューズの床摩擦音を再生します。 */
  playFootstepSound(x, deltaX = 1) {
    if (!this.ctx || this.isMuted || !this.noiseBuffer) return;

    const now = this.ctx.currentTime;
    const panner = this.create3DPanner(x, Y_DEFENSE_P1);
    const source = this.ctx.createBufferSource();
    source.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    const speedRatio = Math.min(Math.abs(deltaX) / 8, 1);
    const pan = (x / CANVAS_WIDTH) * 2 - 1;
    filter.frequency.setValueAtTime(1700 + speedRatio * 1000 + pan * 350, now);
    filter.Q.setValueAtTime(2.5 + speedRatio * 1.5, now);

    const gain = this.ctx.createGain();
    const duration = 0.06 + speedRatio * 0.04;
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.045 + speedRatio * 0.08, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(this.ctx.destination);
    source.start(now);
    source.stop(now + duration + 0.01);
  }

  /** ラケット移動時の「かちかち」音を再生します。 */
  playPaddleMoveClick(x = CANVAS_WIDTH / 2) {
    if (!this.ctx || this.isMuted) return;

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(err => console.warn('AudioContext resume failed:', err));
    }

    const now = this.ctx.currentTime;
    const panner = this.create3DPanner(x, Y_DEFENSE_P1);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(1250, now);
    osc.frequency.exponentialRampToValueAtTime(760, now + 0.035);
    gain.gain.setValueAtTime(0.001, now);
    // スマートフォンの内蔵スピーカーでも聞き取りやすい音量にする。
    gain.gain.linearRampToValueAtTime(0.22, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);

    osc.connect(gain);
    gain.connect(panner);
    panner.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  /** 球がネットを越えて自陣へ入ったことを、球の位置から知らせます。 */
  playBallApproachCue(x, y) {
    if (!this.ctx || this.isMuted || !this.realRollBuffer) return;

    const now = this.ctx.currentTime;
    const panner = this.create3DPanner(x, y);
    const source = this.ctx.createBufferSource();
    source.buffer = this.realRollBuffer;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.32, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    source.connect(gain);
    gain.connect(panner);
    panner.connect(this.ctx.destination);
    source.start(now, 0, 0.2);
  }

  /**
   * rally.m4a の実録転がり音ループを開始します。
   */
  startRealRollLoop() {
    if (!this.realRollBuffer || !this.ctx) return;
    try {
      this.realRollSource = this.ctx.createBufferSource();
      this.realRollSource.buffer = this.realRollBuffer;
      this.realRollSource.loop = true;

      this.realRollGain = this.ctx.createGain();
      this.realRollGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

      this.realRollSource.connect(this.realRollGain);
      this.realRollGain.connect(this.ballRollFilter);

      this.realRollSource.start(0);
    } catch (e) {
      console.warn('Error starting real roll loop:', e);
    }
  }

  /**
   * ラリー中BGM (rally.m4a) のループ再生を開始します。
   * すでに再生中の場合は何もしません。
   */
  startRallyMusic() {
    this.rallyRequested = true;
    if (!this.ctx || this.isMuted) return;
    if (!this.rallyBuffer) {
      this.loadRallyAudio();
      return;
    }
    if (this.rallyPlaying) return;
    try {
      this.rallyPlaying = true;

      this.rallyGain = this.ctx.createGain();
      this.rallyGain.gain.setValueAtTime(0.0, this.ctx.currentTime);
      // フェードイン: 0.5秒かけてフルボリュームへ
      this.rallyGain.gain.linearRampToValueAtTime(1.0, this.ctx.currentTime + 0.5);
      // ballRollFilter -> HRTF panner に通して、ボール位置の3D感を共有する。
      this.rallyGain.connect(this.ballRollFilter);

      this.rallySource = this.ctx.createBufferSource();
      this.rallySource.buffer = this.rallyBuffer;
      this.rallySource.loop = true;
      this.rallySource.connect(this.rallyGain);
      this.rallySource.start(0);
    } catch (e) {
      console.warn('Error starting rally music:', e);
      this.rallyPlaying = false;
    }
  }

  /**
   * ラリー中BGM (rally.m4a) を停止します。
   * フェードアウト後に停止します。
   */
  stopRallyMusic() {
    this.rallyRequested = false;
    this.stopServeRollSound();
    if (!this.rallyPlaying) return;
    this.rallyPlaying = false;
    try {
      if (this.rallyGain && this.ctx) {
        const now = this.ctx.currentTime;
        // フェードアウト: 0.3秒かけて無音へ
        this.rallyGain.gain.cancelScheduledValues(now);
        this.rallyGain.gain.setValueAtTime(this.rallyGain.gain.value, now);
        this.rallyGain.gain.linearRampToValueAtTime(0.0, now + 0.3);
      }
      if (this.rallySource) {
        const src = this.rallySource;
        this.rallySource = null;
        // フェードアウト完了後に停止
        this.rallyStopTimer = setTimeout(() => {
          try { src.stop(); } catch (e) {}
          this.rallyStopTimer = null;
        }, 350);
      }
    } catch (e) {
      console.warn('Error stopping rally music:', e);
    }
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
   * 単発効果音用の3D PannerNodeを作成します。
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
    panner.coneInnerAngle = 360;

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
   * ボールのリアルタイムな位置と速度に応じて、3D空間定位・距離減衰・空気吸収フィルター・
   * および実録音源 (rally.m4a) の再生音量を動的に更新します。
   * @param {number} x ボールのX座標 (0〜800)
   * @param {number} y ボールのY座標 (0〜500)
   * @param {number} vx ボールのX方向速度
   * @param {number} vy ボールのY方向速度
   */
  updateBallSound(x, y, vx, vy) {
    if (!this.ctx || this.isMuted) return;

    const speed = Math.sqrt(vx * vx + vy * vy);

    // ネット通過時だけ、球の現在位置から短い3Dキューを出します。
    if (speed < 0.1) {
      this.lastBallY = null;
    } else if (this.lastBallY !== null &&
      ((this.lastBallY < Y_NET && y >= Y_NET && vy > 0) ||
       (this.lastBallY > Y_NET && y <= Y_NET && vy < 0))) {
      this.playBallApproachCue(x, y);
    }
    this.lastBallY = y;

    // 1. 画面上のX座標を左右パンへリアルタイム反映
    const coords = this.get3DCoords(x, y);
    this.setPannerPosition(this.panner, coords.x, coords.y, coords.z);

    // 2. 距離比率 (0.0: 自分守備ライン 〜 1.0: 相手コート奥)
    const distRatio = Math.max(0, Math.min(1, (Y_DEFENSE_P1 - y) / Y_DEFENSE_P1));

    // 3. 奥行き（空気吸収・距離感）に応じたローパスフィルター
    // 相手コート奥 (distRatio=1.0) では 650Hz (こもった遠方の音)
    // ネット付近 (distRatio=0.4) では約 3500Hz
    // 自分守備手前 (distRatio=0.0) では 14000Hz (本物のピン球のきらめき・粒立ちが完全に開く)
    const targetFreq = 650 + (13350 * Math.pow(1 - distRatio, 1.8));
    this.ballRollFilter.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.04);

    // 4. 音量設定（対数スケール + 距離ダイナミクス）
    let baseVolume = Math.log1p(speed * 0.8) / Math.log1p(8) * 0.75;
    if (baseVolume > 1.0) baseVolume = 1.0;

    // 手前に近づくほど音圧が高まり、迫力と近接感が生まれる
    const proximityGain = 0.35 + (0.65 * Math.pow(1 - distRatio, 1.4));
    let targetVolume = baseVolume * proximityGain;

    if (speed < 0.1) targetVolume = 0; // 停止時は消音

    // 本物の実録ピン球音源 (rally.m4a) のみを再生
    if (this.realRollGain) {
      this.realRollGain.gain.setTargetAtTime(targetVolume * 1.8, this.ctx.currentTime, 0.04);
    }
  }


  /**
   * ラケットが中央（X=350〜450）に合ったときに鳴る目印の確認音（ピピッ/カチッ）とバイブレーション
   * @param {number} x ラケットの中央X座標
   */
  playCenterBeep(x = CANVAS_WIDTH / 2) {
    if (!this.ctx || this.isMuted) return;

    // 1. スマホ端末向けバイブレーション（難聴・触覚アクセシビリティ対応）
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(25); // 25msの軽いパルス振動
      } catch (e) {}
    }

    // 2. 音響での中央確認音（高音でクリアかつ控えめな2連チャイム音）
    if (this.assetsOnly) return;
    const panner = this.create3DPanner(x, Y_DEFENSE_P1);
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(1046.5, now); // C6 (1046.5Hz)
    osc.frequency.setValueAtTime(1318.5, now + 0.03); // E6 (1318.5Hz)

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

    osc.connect(gain);
    gain.connect(panner);
    panner.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.08);
  }

  /**
   * サーブ音 (置き換え後の実録音源を難易度別に再生)
   *  - 初級(easy): serve1.m4a
   *  - 中級(normal): serve2.m4a
   *  - 応用/上級(hard): serve3.m4a
   * @param {number} x 打球X座標
   * @param {string|null} difficulty 難易度 ('easy' | 'normal' | 'hard') または null (完全ランダム)
   * @param {number} y 打球Y座標
   * @param {boolean} isCpuServe CPUサーブの場合は1〜3を低頻度でランダム選択する
   */
  playServeSound(x, difficulty = null, y = Y_DEFENSE_P1, isCpuServe = false) {
    if (!this.ctx || this.isMuted) return;
    if (this.serveBuffers) {
      try {
        let buffer = null;
        if (isCpuServe) {
          // CPUはserve1を基本に、serve2/3を時々混ぜます。
          const roll = Math.random();
          buffer = roll < 0.7
            ? this.serveBuffers.easy
            : roll < 0.9
              ? this.serveBuffers.normal
              : this.serveBuffers.hard;
        } else if (difficulty && this.serveBuffers[difficulty]) {
          // Use the replaced difficulty-specific serve recording every time:
          // Easy=serve1, Normal=serve2, Hard=serve3.
          buffer = this.serveBuffers[difficulty];
        } else if (this.serveBuffers.list && this.serveBuffers.list.length > 0) {
          const rIdx = Math.floor(Math.random() * this.serveBuffers.list.length);
          buffer = this.serveBuffers.list[rIdx];
        }

        if (buffer) {
          const panner = this.create3DPanner(x, y);
          const source = this.ctx.createBufferSource();
          source.buffer = buffer;
          const gain = this.ctx.createGain();
          gain.gain.setValueAtTime(1.25, this.ctx.currentTime); // 実録サーブ音をクリアかつ最大限に響かせる
          source.connect(gain);
          gain.connect(panner);
          panner.connect(this.ctx.destination);
          source.start(0);
          return;
        }
      } catch (e) {
        console.warn('Error playing real serve sound:', e);
      }
    }

    // サーブ音源がない場合は、別の音源へフォールバックしない
  }

  /**
   * ラケットを振ったときの風切り音（スイング音「ブン」）を合成します。
   * @param {number} x ラケットのX座標 (パン用)
   */
  playBuffer(buffer, x, y, volume = 1.0) {
    if (!this.ctx || this.isMuted || !buffer) return;
    const panner = this.create3DPanner(x, y);
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    source.buffer = buffer;
    gain.gain.setValueAtTime(volume, this.ctx.currentTime);
    source.connect(gain);
    gain.connect(panner);
    panner.connect(this.ctx.destination);
    source.start();
  }

  playServeRollSound(x, y = Y_NET) {
    if (!this.ctx || this.isMuted || !this.realRollBuffer) return;

    // Keep one rolling sound alive for the whole Easy serve/rally approach.
    // A short recording is looped for a natural 5-6 second roll instead of
    // being restarted on every collision.
    if (this.serveRollSource) {
      if (this.serveRollPanner) {
        const coords = this.get3DCoords(x, y);
        this.setPannerPosition(this.serveRollPanner, coords.x, coords.y, coords.z);
      }
      return;
    }

    try {
      const source = this.ctx.createBufferSource();
      source.buffer = this.realRollBuffer;
      source.loop = true;

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.8, this.ctx.currentTime);
      const panner = this.create3DPanner(x, y);
      source.connect(gain);
      gain.connect(panner);
      panner.connect(this.ctx.destination);

      this.serveRollSource = source;
      this.serveRollPanner = panner;
      const duration = 5 + Math.random();
      this.serveRollStopTimer = setTimeout(() => this.stopServeRollSound(), duration * 1000);
      source.onended = () => {
        if (this.serveRollSource === source) {
          this.serveRollSource = null;
          this.serveRollPanner = null;
          this.serveRollStopTimer = null;
        }
      };
      source.start();
    } catch (e) {
      console.warn('Error playing rolling sound:', e);
      this.serveRollSource = null;
      this.serveRollPanner = null;
    }
  }

  stopServeRollSound() {
    if (this.serveRollStopTimer) {
      clearTimeout(this.serveRollStopTimer);
      this.serveRollStopTimer = null;
    }
    if (this.serveRollSource) {
      try { this.serveRollSource.stop(); } catch (e) {}
      this.serveRollSource = null;
      this.serveRollPanner = null;
    }
  }

  playSwingSound(x, y = Y_DEFENSE_P1) {
    if (!this.ctx || this.isMuted) return;
    if (this.assetsOnly) return;

    const panner = this.create3DPanner(x, y);
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
    if (this.racketBuffer) {
      this.playBuffer(this.racketBuffer, x, y, 1.0);
      return;
    }
    if (this.assetsOnly) return;

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
    if (this.assetsOnly) return;

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
    if (this.assetsOnly) return;

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
    if (this.assetsOnly) return;

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
    if (this.assetsOnly) return;

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
    this.playBuffer(this.rallyBuffer, x, y, 1.0);
  }


  /**
   * 試合終了時の歓声・拍手効果音を合成します。
   * ピンクノイズ風のフィルターとLFOを使って、観客の盛り上がりを表現します。
   */
  playOutSound(x = CANVAS_WIDTH / 2, y = Y_DEFENSE_P1) {
    this.playBuffer(this.outBuffer, x, y, 1.0);
  }

  /** 成功したエンドフレーム判定時の rally2.m4a を再生します。 */
  playEndFrameSuccessSound(x = CANVAS_WIDTH / 2, y = Y_NET) {
    this.playBuffer(this.rally2Buffer, x, y, 1.0);
  }

  playCheerSound() {
    if (!this.ctx || this.isMuted) return;
    if (this.assetsOnly) return;

    const duration = 4.0;
    const now = this.ctx.currentTime;
    const panner = this.create3DPanner(CANVAS_WIDTH / 2, Y_NET);

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
    gain.connect(panner);
    panner.connect(this.ctx.destination);

    noise.start(now);
    lfo.start(now);
    noise.stop(now + duration);
    lfo.stop(now + duration);
  }

}

export const sounds = new SoundSystem();
