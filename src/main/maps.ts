// Localização da loja: lê link do Google Maps / coordenadas e monta o mapinha (tiles do OpenStreetMap)
// para mostrar dentro do app, sem abrir o navegador.
export interface GeoPoint {
  lat: number;
  lng: number;
}

const valid = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

/** Coordenadas escritas ou dentro de um link do Google Maps / OpenStreetMap / Waze. */
export function parseCoords(text: string): GeoPoint | null {
  const t = decodeURIComponent(text.trim());
  const patterns = [
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/, // ponto marcado no Google Maps (mais preciso que o centro do mapa)
    /[?&](?:q|query|ll|destination|daddr|center)=(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/,
    /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,
    /[?&]mlat=(-?\d{1,2}\.\d+)&mlon=(-?\d{1,3}\.\d+)/,
    /^\s*(-?\d{1,2}[.,]\d+)\s*[,;\s]\s*(-?\d{1,3}[.,]\d+)\s*$/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const lat = Number(m[1]!.replace(",", "."));
    const lng = Number(m[2]!.replace(",", "."));
    if (valid(lat, lng)) return { lat, lng };
  }
  return null;
}

/** Aceita coordenadas ou link (inclusive o curto maps.app.goo.gl, que é seguido até o endereço final). */
export async function resolveLocation(text: string, fetcher: typeof fetch = fetch): Promise<GeoPoint | null> {
  const direct = parseCoords(text);
  if (direct) return direct;
  let url = text.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  for (let i = 0; i < 6; i++) {
    const res = await fetcher(url, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 NiveAtende" } }).catch(() => null);
    if (!res) return null;
    const loc = res.headers.get("location");
    if (loc && res.status >= 300 && res.status < 400) {
      url = new URL(loc, url).toString();
      const found = parseCoords(url);
      if (found) return found;
      continue;
    }
    const body = await res.text().catch(() => "");
    return parseCoords(url) ?? parseCoords(body.match(/https:\/\/www\.google\.[^"'\s]+\/maps[^"'\s]*/)?.[0] ?? "");
  }
  return null;
}

export const MAP_ZOOM = 16;

/** Posição do ponto no mapa (em pixels, no zoom dado). */
export function project(p: GeoPoint, zoom = MAP_ZOOM): { x: number; y: number } {
  const n = 256 * 2 ** zoom;
  const x = ((p.lng + 180) / 360) * n;
  const s = Math.sin((p.lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return { x, y };
}

const cache = new Map<string, string>();

/**
 * Mapinha 3×3 tiles em volta do ponto: devolve as imagens (data URL) e onde o ponto cai dentro da grade
 * de 768×768 px. Baixado pelo processo principal (a tela não acessa a internet direto).
 */
export async function mapTiles(p: GeoPoint, version = "dev", fetcher: typeof fetch = fetch): Promise<{ tiles: string[][]; pointX: number; pointY: number }> {
  const { x, y } = project(p);
  const tx = Math.floor(x / 256);
  const ty = Math.floor(y / 256);
  const max = 2 ** MAP_ZOOM;
  const tiles: string[][] = [];
  for (let dy = -1; dy <= 1; dy++) {
    const row: string[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      const cx = (tx + dx + max) % max;
      const cy = Math.min(max - 1, Math.max(0, ty + dy));
      const key = `${MAP_ZOOM}/${cx}/${cy}`;
      let data = cache.get(key);
      if (!data) {
        const res = await fetcher(`https://tile.openstreetmap.org/${key}.png`, {
          headers: { "User-Agent": `NiveAtende/${version} (+https://nivesistemas.com.br)` },
        });
        if (!res.ok) throw new Error(`mapa indisponível (${res.status})`);
        data = `data:image/png;base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
        if (cache.size > 200) cache.clear();
        cache.set(key, data);
      }
      row.push(data);
    }
    tiles.push(row);
  }
  return { tiles, pointX: x - (tx - 1) * 256, pointY: y - (ty - 1) * 256 };
}
