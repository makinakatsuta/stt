export class SpeechSystem {
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

export const narrator = new SpeechSystem();
