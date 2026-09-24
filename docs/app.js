// 変更後のモジュールを確実に読み込むため、リリースごとにバージョンを更新する。
import { GameEngine } from './js/game-engine.js?v=3.31.26';

const bootstrap = () => {
  const enableAudioButton = document.getElementById('btn-enable-audio');

  try {
    window.gameEngine = new GameEngine();
  } catch (error) {
    console.error('Game initialization failed:', error);
    if (enableAudioButton) {
      enableAudioButton.disabled = false;
      enableAudioButton.title = '初期化エラー: ブラウザのコンソールを確認してください';
    }
  }

  // Explicitly support Enter and Space on browsers that do not synthesize
  // the button click consistently for keyboard activation.
  if (enableAudioButton) {
    enableAudioButton.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
        event.preventDefault();
        enableAudioButton.click();
      }
    });
  }
};

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
