// Captura de tela para transmitir: pede a tela/janela/aba ao navegador (ou cria a fonte sintética dos testes)
// e explica, quando for o caso, por que o som não foi junto.
import type { BroadcastOptions, Capture } from './session-types';
import { createSyntheticStream } from './synthetic';

/** null = a pessoa cancelou o seletor. onEnded: a captura foi encerrada pelo navegador. */
export async function captureScreen(opts: BroadcastOptions, onEnded: (stream: MediaStream) => void): Promise<Capture | null> {
  const dims = opts.resolution === 720 ? { width: 1280, height: 720 } : { width: 1920, height: 1080 };

  let stream: MediaStream;
  let stopSynthetic: (() => void) | null = null;
  try {
    if (opts.synthetic) {
      const s = createSyntheticStream(dims.width, dims.height, 30, opts.audio !== 'off');
      stream = s.stream;
      stopSynthetic = s.stop;
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: dims.width, max: dims.width },
          height: { ideal: dims.height, max: dims.height },
          frameRate: { ideal: 30, max: 30 },
        },
        // Som sem processamento de voz (música e jogos ficam fiéis). restrictOwnAudio tira o som que o
        // próprio Telão toca (outras transmissões) da captura; navegadores que não o suportam ignoram.
        audio:
          opts.audio === 'off'
            ? false
            : ({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true } as MediaTrackConstraints),
        // "Som do sistema" é a mistura de TUDO que toca no Windows (Discord, chamadas...). Só é oferecido
        // quando a pessoa escolhe esse modo; no padrão, o navegador oferece apenas o som da aba.
        systemAudio: opts.audio === 'system' ? 'include' : 'exclude',
        // Som só da janela escolhida (ex.: o jogo), sem o resto do PC: o navegador captura o áudio daquele
        // programa. Edge/Chrome recentes no Windows; os demais ignoram e a janela vai sem som.
        windowAudio: opts.audio === 'off' ? 'exclude' : 'window',
        // Não oferecer a própria aba do Telão no seletor.
        selfBrowserSurface: 'exclude',
      } as DisplayMediaStreamOptions);
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotAllowedError') return null;
    throw e;
  }

  const track = stream.getVideoTracks()[0];
  // "detail" preserva nitidez (texto/código); "motion" preserva fluidez (jogos/vídeo).
  track.contentHint = opts.contentHint;
  track.addEventListener('ended', () => onEnded(stream));
  const st = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
  const surface = st.displaySurface ?? null; // browser = aba · window = janela · monitor = tela inteira
  // No modo "só a aba", nunca enviar o som do PC inteiro (garantia extra além do systemAudio). O som de uma
  // janela é só daquele programa (não leva Discord nem chamadas), então é mantido.
  if (!opts.synthetic && opts.audio === 'tab' && surface === 'monitor') {
    for (const a of stream.getAudioTracks()) {
      a.stop();
      stream.removeTrack(a);
    }
  }
  const hasAudio = stream.getAudioTracks().length > 0;
  let audioNotice: string | null = null;
  if (!opts.synthetic && opts.audio !== 'off') {
    if (hasAudio && surface === 'monitor') {
      audioNotice =
        'Enviando o som do PC inteiro: vai junto tudo que toca no seu computador, inclusive Discord e chamadas. ' +
        'Para mandar só o som de um site, compartilhe uma ABA. Para tirar o Discord, coloque a saída de voz dele em outro ' +
        'dispositivo (ex.: o fone) diferente do padrão do Windows.';
    } else if (!hasAudio && surface === 'window') {
      audioNotice =
        'Transmitindo sem áudio: no seletor, marque "Compartilhar áudio da janela" (ou "...do sistema") antes de clicar em ' +
        'Compartilhar. Se a opção não aparecer, atualize o Edge/Chrome; outra saída é compartilhar a tela inteira com o modo ' +
        '"Som do PC inteiro".';
    } else if (!hasAudio && opts.audio === 'system') {
      audioNotice =
        'Transmitindo sem áudio: no seletor, marque "Compartilhar áudio do sistema" (tela inteira), "...da janela" ou ' +
        '"...da guia" (aba).';
    } else if (!hasAudio && surface === 'monitor') {
      audioNotice =
        'Transmitindo sem áudio: a tela inteira só envia o som do PC inteiro (modo "Som do PC inteiro", na engrenagem). ' +
        'Para mandar só o som do jogo, compartilhe a JANELA dele com "Compartilhar áudio da janela" marcado.';
    } else if (!hasAudio) {
      audioNotice = 'Transmitindo sem áudio: no seletor, marque "Compartilhar áudio da guia" para o som ir junto.';
    }
  }
  return { stream, stopSynthetic, settings: st, audioNotice };
}
