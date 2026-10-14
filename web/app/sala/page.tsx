import RoomApp from '@/components/RoomApp';

const description = 'Clique para entrar na sala e assistir ao vivo.';

export const metadata = {
  title: 'Sala · Telão',
  description,
  openGraph: { title: 'Sala · Telão', description, type: 'website' },
};

export default function SalaPage() {
  return <RoomApp />;
}
