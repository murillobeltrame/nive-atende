import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { IconMapPin } from "./Icons";

type Tiles = { tiles: string[][]; pointX: number; pointY: number };

/** Mapinha com o pino no centro (OpenStreetMap). Clicar abre o Google Maps no navegador. */
export function MapPreview({ lat, lng, width = 260, height = 140, label }: { lat: number; lng: number; width?: number; height?: number; label?: string }) {
  const [data, setData] = useState<Tiles | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setData(null);
    setFailed(false);
    api
      .mapTiles(lat, lng)
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [lat, lng]);
  const href = `https://www.google.com/maps?q=${lat},${lng}`;
  return (
    <a
      className="map-preview"
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{ width, height }}
      title="Abrir no Google Maps"
      aria-label={`${label ?? "Localização"}: abrir no Google Maps`}
    >
      {data ? (
        <div className="map-grid" style={{ left: width / 2 - data.pointX, top: height / 2 - data.pointY }}>
          {data.tiles.flat().map((src, i) => (
            <img key={i} src={src} alt="" draggable={false} />
          ))}
        </div>
      ) : (
        <div className="map-loading">{failed ? "Mapa indisponível · abrir no Google Maps" : "Carregando mapa…"}</div>
      )}
      <span className="map-pin" aria-hidden="true">
        <IconMapPin size={26} />
      </span>
      {data && <span className="map-credit">© OpenStreetMap</span>}
    </a>
  );
}
