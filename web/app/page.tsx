import PasteLink from '@/components/PasteLink';

export default function Home() {
  return (
    <main className="narrow stack">
      <div>
        <h1>Telão</h1>
        <p className="muted">
          Assista à tela de um amigo em 720p ou 1080p a 30 FPS, direto no navegador. Sem conta, sem instalar nada.
        </p>
      </div>
      <PasteLink />
      <p className="muted small">
        Não tem link? Quem hospeda o servidor cria a sala no painel local dele e envia o link para você. As salas são
        protegidas por um código de acesso que vai no próprio link.
      </p>
    </main>
  );
}
