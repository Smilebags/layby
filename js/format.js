export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (totalSeconds >= 60) return `${Math.max(1, Math.round(totalSeconds / 60))} min`;
  return `${totalSeconds} sec`;
}

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

export function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return "0 m";
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km.toFixed(km < 10 ? 1 : 0)} km`;
}

export function formatSpeed(kmh) {
  if (kmh == null || !Number.isFinite(kmh)) return "–";
  return String(Math.max(0, Math.round(kmh)));
}

export function formatCoords(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "Unknown location";
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(5)}° ${ns}, ${Math.abs(lon).toFixed(5)}° ${ew}`;
}

export function formatTripTime(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatTripDuration(ms) {
  const minutes = Math.max(0, Math.round(Number(ms) / 60000));
  const hours = Math.floor(minutes / 60);
  const remain = minutes % 60;
  if (hours === 0) return `${remain}m`;
  return `${hours}h${remain}m`;
}

export function formatDay(ms) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(ms));
}

export function formatPointTime(ms, referenceMs) {
  const point = new Date(ms);
  const reference = new Date(referenceMs);
  const options = {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  };
  if (point.toDateString() !== reference.toDateString()) {
    options.day = "numeric";
    options.month = "short";
  }
  return new Intl.DateTimeFormat(undefined, options).format(point);
}
