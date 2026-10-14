// Fonte de vídeo sintética (padrão 1920×1080) a 30 FPS (canvas). Usada nos testes automáticos,
// pois o seletor de tela do navegador não pode ser automatizado. Ative com #...&fonte=sintetica.

export function createSyntheticStream(width = 1920, height = 1080, fps = 30, withAudio = false) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const start = performance.now();
  let frame = 0;

  const draw = () => {
    frame++;
    const t = (performance.now() - start) / 1000;
    ctx.fillStyle = `hsl(${(t * 20) % 360} 35% 14%)`;
    ctx.fillRect(0, 0, width, height);

    // Texto fino: revela perda de nitidez.
    ctx.fillStyle = '#d7dce5';
    ctx.font = '14px monospace';
    for (let y = 40; y < height; y += 22) {
      ctx.fillText(`linha ${String(y).padStart(4, '0')}  const nitidez = "texto pequeno 0123456789 abcdefghij";`, 40, y);
    }

    // Bloco em movimento: revela queda de FPS.
    const x = ((t * 600) % (width + 300)) - 300;
    ctx.fillStyle = '#5b8cff';
    ctx.fillRect(x, height / 2 - 150, 300, 300);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 96px system-ui, sans-serif';
    ctx.fillText(`TESTE ${width}×${height} @${fps}`, 900, 140);
    ctx.font = 'bold 64px monospace';
    ctx.fillText(`quadro ${frame}  t=${t.toFixed(2)}s`, 900, 230);
  };

  draw();
  const timer = setInterval(draw, 1000 / fps);
  const stream = canvas.captureStream(fps);

  // Áudio de teste: um tom baixo de 440 Hz (valida o envio de áudio nos testes automáticos).
  let audioCtx: AudioContext | null = null;
  if (withAudio) {
    audioCtx = new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.05;
    const dest = audioCtx.createMediaStreamDestination();
    osc.frequency.value = 440;
    osc.connect(gain).connect(dest);
    osc.start();
    void audioCtx.resume();
    for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
  }

  return {
    stream,
    stop: () => {
      clearInterval(timer);
      for (const tr of stream.getTracks()) tr.stop();
      void audioCtx?.close();
    },
  };
}
